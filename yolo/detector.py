"""Rockchip model-zoo YOLOv8 (three DFL branches) postprocess, not arbitrary ONNX output."""
import numpy as np
import cv2

VEHICLES = {2: 'car', 3: 'motorcycle', 5: 'bus', 7: 'truck'}

def letterbox(frame, size=640):
    h, w = frame.shape[:2]
    scale = min(size / w, size / h)
    nw, nh = round(w * scale), round(h * scale)
    x, y = (size - nw) // 2, (size - nh) // 2
    image = np.full((size, size, 3), 114, dtype=np.uint8)
    image[y:y+nh, x:x+nw] = cv2.resize(frame, (nw, nh))
    return cv2.cvtColor(image, cv2.COLOR_BGR2RGB), scale, x, y

def postprocess(outputs, threshold=.45):
    if len(outputs) not in (6, 9):
        raise ValueError('Expected 6/9 Rockchip model-zoo DFL outputs; incompatible RKNN model')
    boxes, scores, labels = [], [], []
    stride = len(outputs) // 3
    for branch in range(3):
        reg, cls = np.asarray(outputs[branch*stride]), np.asarray(outputs[branch*stride+1])
        if reg.ndim != 4 or cls.ndim != 4 or cls.shape[1] != 80:
            raise ValueError('Expected NCHW COCO-80 model-zoo output')
        _, channels, h, w = reg.shape
        bins = channels // 4
        dfl = reg.reshape(1, 4, bins, h, w)
        prob = np.exp(dfl - dfl.max(axis=2, keepdims=True))
        prob /= prob.sum(axis=2, keepdims=True)
        dist = (prob * np.arange(bins).reshape(1,1,bins,1,1)).sum(axis=2)[0]
        yy, xx = np.mgrid[:h, :w]
        cell = 640 / w
        coords = np.stack([(xx+.5-dist[0])*cell, (yy+.5-dist[1])*cell,
                           (xx+.5+dist[2])*cell, (yy+.5+dist[3])*cell], axis=-1).reshape(-1,4)
        conf = cls[0].transpose(1,2,0).reshape(-1,80)
        ids = conf.argmax(axis=1)
        best = conf.max(axis=1)
        mask = (best >= threshold) & np.isin(ids, list(VEHICLES))
        boxes.extend(coords[mask]); scores.extend(best[mask]); labels.extend(ids[mask])
    if not boxes:
        return []
    b, s, c = np.array(boxes), np.array(scores), np.array(labels)
    keep = []
    for label in np.unique(c):
        order = np.where(c == label)[0]
        order = order[np.argsort(s[order])[::-1]]
        while order.size:
            i = order[0]; keep.append(int(i)); rest = order[1:]
            lt = np.maximum(b[i,:2], b[rest,:2]); rb = np.minimum(b[i,2:], b[rest,2:])
            inter = np.maximum(0, rb-lt).prod(axis=1)
            area = np.maximum(0, b[:,2:]-b[:,:2]).prod(axis=1)
            iou = inter / np.maximum(area[i]+area[rest]-inter, 1e-6)
            order = rest[iou < .45]
    return [{'class': VEHICLES[int(c[i])], 'confidence': float(s[i]), 'box': b[i].tolist()} for i in keep]

class Detector:
    def __init__(self, mode, model, core=0):
        if mode == 'rknn':
            from rknnlite.api import RKNNLite
            self.model = RKNNLite()
            if self.model.load_rknn(model) != 0:
                raise RuntimeError('RKNN model load failed')
            masks = [RKNNLite.NPU_CORE_0, RKNNLite.NPU_CORE_1, RKNNLite.NPU_CORE_2]
            if self.model.init_runtime(core_mask=masks[core % 3]) != 0:
                raise RuntimeError('RKNN init failed; verify kernel/runtime/model versions')
        elif mode == 'cpu':
            from ultralytics import YOLO
            self.model = YOLO(model)
        else:
            raise ValueError('YOLO_MODE must be cpu or rknn for real inference')
        self.mode = mode

    def detect(self, frame, threshold):
        if self.mode == 'cpu':
            r = self.model.predict(frame, classes=list(VEHICLES), conf=threshold, device='cpu', verbose=False)[0]
            return [{'class': VEHICLES[int(b.cls.item())], 'confidence': float(b.conf.item()), 'box': b.xyxy[0].tolist()} for b in r.boxes]
        img, scale, x, y = letterbox(frame)
        out = postprocess(self.model.inference(inputs=[img]), threshold)
        h, w = frame.shape[:2]
        for d in out:
            a,b,c,e = d['box']
            d['box'] = [max(0,(a-x)/scale), max(0,(b-y)/scale), min(w,(c-x)/scale), min(h,(e-y)/scale)]
        return out

    def close(self):
        if self.mode == 'rknn':
            self.model.release()
