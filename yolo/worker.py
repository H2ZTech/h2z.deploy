"""4-stream vehicle presence engine. HTTP is authoritative; MQTT delivers detection metadata.
No plate OCR or dock arrive/depart is inferred from one frame. No CPU fallback in RKNN mode.
"""
import os, json, time, uuid, threading, subprocess, sqlite3
from pathlib import Path
from urllib.request import Request, urlopen
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import numpy as np
import paho.mqtt.client as mqtt
from detector import Detector

BASE = os.environ.get('BACKEND_URL', 'http://backend:3001') + '/security/ioc/ai/engine/'
ENGINE = os.environ.get('ENGINE_ID', 'yolo8-vehicle')
TOKEN = Path(os.environ.get('ENGINE_TOKEN_FILE','/run/security/engine-token')).read_text().strip()
MODE = os.environ.get('YOLO_MODE', 'disabled')
MODEL = os.environ.get('YOLO_MODEL', '/models/yolov8n.pt')
FPS = max(.2, min(15, float(os.environ.get('INFERENCE_FPS','3'))))
STATE = {'mode': MODE, 'registered': False, 'mqtt': False, 'cameras': {}, 'pending': 0}
STOP = threading.Event()
ALGORITHM = {'id':'vehicle-presence', 'name':'YOLOv8 车辆检测', 'deviceKinds':['camera'],
 'description':'检测汽车、摩托车、公交车、卡车；不包含车牌 OCR。', 'version':'0.1.0', 'emits':['alarm'],
 'params':[{'key':'confidence','label':'置信度','type':'number','min':.1,'max':.95,'default':.45},
           {'key':'cooldown','label':'告警间隔','type':'number','min':5,'max':3600,'default':60}]}

def api(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = Request(BASE + ENGINE + path, data=data, method=method,
        headers={'Authorization':'Bearer '+TOKEN, 'Content-Type':'application/json'})
    with urlopen(req, timeout=15) as r:
        value = json.load(r)
    return value.get('data', value)

db = sqlite3.connect('/data/outbox.db', check_same_thread=False)
db.execute('CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, body TEXT NOT NULL, mqtt INTEGER DEFAULT 0)')
lock = threading.Lock()
client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id='security-yolo-'+uuid.uuid4().hex[:10])
client.username_pw_set(os.environ['MQTT_USER'], os.environ['MQTT_PASSWORD'])
client.on_connect = lambda c,u,f,reason,p: STATE.update(mqtt=not reason.is_failure)
client.on_disconnect = lambda c,u,f,reason,p: STATE.update(mqtt=False)
client.connect_async(os.environ.get('MQTT_HOST','emqx'),1883,60)
client.loop_start()

def enqueue(event):
    with lock:
        count = db.execute('SELECT COUNT(*) FROM events').fetchone()[0]
        if count >= 10000:
            raise RuntimeError('Outbox full; refusing to lose pending events')
        db.execute('INSERT OR IGNORE INTO events(id,body) VALUES(?,?)', (event['engineEventId'],json.dumps(event)))
        db.commit()

def deliver():
    while not STOP.wait(1):
        with lock:
            rows = db.execute('SELECT id,body,mqtt FROM events LIMIT 100').fetchall()
            STATE['pending'] = db.execute('SELECT COUNT(*) FROM events').fetchone()[0]
        for ident, raw, sent in rows:
            try:
                if not sent:
                    info = client.publish('security/vision/'+ENGINE+'/events', raw, qos=1)
                    info.wait_for_publish(timeout=5)
                    if not info.is_published():
                        continue
                    with lock:
                        db.execute('UPDATE events SET mqtt=1 WHERE id=?',(ident,)); db.commit()
                # HTTP alarm endpoint may merge repeated alarms; it is not event-id idempotent.
                api('POST','/events',json.loads(raw))
                with lock:
                    db.execute('DELETE FROM events WHERE id=?',(ident,)); db.commit()
            except Exception as e:
                print('delivery retry:',type(e).__name__, flush=True)
                break

class Stream:
    def __init__(self, config, core):
        self.config = config; self.stop = threading.Event(); self.process = None
        self.frame = None; self.frame_lock = threading.Lock()
        self.core = core; self.last = 0
        self.thread = threading.Thread(target=self.run, daemon=True); self.thread.start()

    def decode(self, url):
        decoder = os.environ.get('VIDEO_DECODER','h264')
        if MODE == 'rknn' and decoder not in ('h264_rkmpp','hevc_rkmpp'):
            raise RuntimeError('RKNN mode requires explicit rkmpp hardware decoder')
        if decoder.endswith('_rkmpp'):
            filters = 'scale_rkrga=w=640:h=360:format=nv12,hwdownload,format=nv12,format=bgr24'
        else:
            filters = 'scale=640:360,format=bgr24'
        hw = ['-hwaccel','rkmpp','-hwaccel_output_format','drm_prime'] if decoder.endswith('_rkmpp') else []
        cmd = ['ffmpeg','-nostdin','-loglevel','error',*hw,'-rtsp_transport','tcp',
               '-timeout','10000000','-c:v',decoder,'-i',url,'-an','-vf',filters,'-f','rawvideo','pipe:1']
        # Suppress ffmpeg diagnostics: RTSP URLs can contain camera passwords.
        self.process = subprocess.Popen(cmd,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
        n = 640*360*3
        while not self.stop.is_set():
            chunks = bytearray()
            while len(chunks) < n:
                part = self.process.stdout.read(n-len(chunks))
                if not part: break
                chunks.extend(part)
            if len(chunks) != n: break
            with self.frame_lock:
                self.frame = (time.monotonic(), np.frombuffer(chunks,dtype=np.uint8).reshape(360,640,3))

    def run(self):
        camera = self.config['camera']; ident = str(camera['id'])
        detector = None
        try:
            detector = Detector(MODE, MODEL, self.core)
            while not self.stop.is_set():
                STATE['cameras'][ident] = {'status':'connecting','frames':0}
                t = threading.Thread(target=self.decode,args=(camera.get('rtspSub') or camera['rtspMain'],),daemon=True)
                t.start(); seen = 0
                while t.is_alive() and not self.stop.wait(1/FPS):
                    with self.frame_lock:
                        frame = self.frame
                    if frame is None or frame[0] <= seen: continue
                    seen = frame[0]
                    params = self.config.get('params',{})
                    detections = detector.detect(frame[1],float(params.get('confidence',.45)))
                    STATE['cameras'][ident]['status'] = 'running'
                    STATE['cameras'][ident]['frames'] += 1
                    if detections and time.monotonic()-self.last >= float(params.get('cooldown',60)):
                        enqueue({'engineEventId':uuid.uuid4().hex,'kind':'alarm','cameraId':int(ident),
                          'algorithmId':'vehicle-presence','at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),
                          'title':'车辆检测','detail':json.dumps(detections,ensure_ascii=False),
                          'detections':detections,'frame':{'width':640,'height':360},'simulation':False})
                        self.last = time.monotonic()
                if self.process: self.process.kill(); self.process.wait(timeout=5)
                self.stop.wait(5)
        except Exception as e:
            STATE['cameras'][ident] = {'status':'failed','error':type(e).__name__}
            print('camera',ident,'failed:',type(e).__name__,flush=True)
        finally:
            if detector: detector.close()

    def close(self):
        self.stop.set()
        if self.process and self.process.poll() is None: self.process.kill()
        self.thread.join(timeout=20)

class Health(BaseHTTPRequestHandler):
    def do_GET(self):
        good = STATE['registered'] and STATE['mqtt'] and all(v['status']=='running' for v in STATE['cameras'].values())
        self.send_response(200 if good else 503); self.end_headers()
        self.wfile.write(json.dumps(STATE).encode())
    def log_message(self,*args): pass

def main():
    if MODE not in ('disabled','cpu','rknn'): raise ValueError('invalid YOLO_MODE')
    if MODE != 'disabled' and not Path(MODEL).is_file(): raise FileNotFoundError('model file missing')
    threading.Thread(target=ThreadingHTTPServer(('0.0.0.0',8090),Health).serve_forever,daemon=True).start()
    threading.Thread(target=deliver,daemon=True).start()
    streams = {}; signatures = {}
    while not STOP.is_set():
        try:
            api('PUT','/algorithms',{'algorithms':[ALGORITHM]}); STATE['registered'] = True
            # Fetch a full snapshot so disabled cameras and runtime edits are removed reliably.
            cfg = api('GET','/configs?sinceVersion=0')
            enabled = {str(c['deviceRef']):c for c in cfg['items'] if c['enabled'] and c.get('camera')}
            if len(enabled) > 4: raise ValueError('maximum four enabled camera streams')
            if MODE == 'disabled': enabled = {}
            for key in list(streams):
                if key not in enabled or signatures[key] != json.dumps(enabled[key],sort_keys=True) or not streams[key].thread.is_alive():
                    streams.pop(key).close(); signatures.pop(key); STATE['cameras'].pop(key,None)
            for key,c in enabled.items():
                if key not in streams:
                    signatures[key] = json.dumps(c,sort_keys=True)
                    streams[key] = Stream(c,len(streams)%3)
        except Exception as e:
            print('configuration retry:',type(e).__name__,flush=True)
            STATE['registered'] = False
        STOP.wait(10)

if __name__ == '__main__':
    main()
