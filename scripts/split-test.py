#!/usr/bin/env python3
# HDMI 大屏分屏压测（现场用）：通过 Chrome 调试口（127.0.0.1:9222）点分屏按钮，盯 N 秒，打印每一格的播放 / 掉线 / 解码器，以及显卡引擎占用。
# 用法：sudo python3 scripts/split-test.py <分屏数，如 32> [秒，缺省 90] [reload]
#   reload：切到这个分屏后刷新页面再盯（页面从干净状态起流：没有上一屏留下的名额 / 单格禁用记录），目标分屏已经是当前分屏也可以用。
#   除了画面，还记下页面向后端要流的每一次请求（要原始流还是转码流、后端给回什么）和页面 / 播放器的报错：用来分清「页面没要原生」「后端没给」「给了解不了」。
#   要 sudo：读别的进程的 /proc/<pid>/fdinfo 才能看到显卡解码 / 编码引擎占用。没有 sudo 也能跑，只是没有引擎数据。
#   目标分屏已经是当前分屏时点按钮没有任何效果，脚本会提示：先切到别的分屏再来（16 → 32 就行）。
# 只读：不改任何配置，只在页面里点一下分屏按钮（和客户用手点一样）。
import base64, glob, json, os, re, socket, struct, sys, time, urllib.request

PORT = int(os.environ.get("H2Z_KIOSK_CDP_PORT") or 9222)


class Cdp:
    def __init__(self):
        tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json", timeout=3))
        page = next(x for x in tabs if x.get("type") == "page" and x.get("url", "").startswith("http"))
        path = page["webSocketDebuggerUrl"].split(str(PORT), 1)[1]
        self.s = socket.create_connection(("127.0.0.1", PORT), timeout=5)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall((f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                        f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        self.buf = b""
        while b"\r\n\r\n" not in self.buf:
            c = self.s.recv(4096)
            if not c:
                raise OSError("closed")
            self.buf += c
        self.buf = self.buf.split(b"\r\n\r\n", 1)[1]
        self.seq = 0
        self.events = []   # 调用 call 时顺带收到的事件，pump 时一并取走

    def _send(self, o):
        d = json.dumps(o).encode()
        m = os.urandom(4)
        n = len(d)
        head = b"\x81" + (bytes([0x80 | n]) if n < 126 else b"\xfe" + struct.pack(">H", n) if n < 65536 else b"\xff" + struct.pack(">Q", n))
        self.s.sendall(head + m + bytes(b ^ m[i % 4] for i, b in enumerate(d)))

    def _frame(self, timeout):
        """取一整帧；到时间还没有 → None。文本帧返回 JSON，其余返回 {}"""
        end = time.time() + timeout
        while True:
            b = self.buf
            if len(b) >= 2:
                n, off = b[1] & 127, 2
                if n == 126:
                    n, off = (struct.unpack(">H", b[2:4])[0], 4) if len(b) >= 4 else (None, 4)
                elif n == 127:
                    n, off = (struct.unpack(">Q", b[2:10])[0], 10) if len(b) >= 10 else (None, 10)
                if n is not None and len(b) >= off + n:
                    op, data = b[0] & 15, b[off:off + n]
                    self.buf = b[off + n:]
                    if op != 1:
                        return {}
                    try:
                        return json.loads(data)
                    except Exception:
                        return {}
            left = end - time.time()
            if left <= 0:
                return None
            self.s.settimeout(left)
            try:
                c = self.s.recv(1 << 20)
            except socket.timeout:
                return None
            finally:
                self.s.settimeout(5)
            if not c:
                raise OSError("closed")
            self.buf += c

    def call(self, method, **params):
        self.seq += 1
        self._send({"id": self.seq, "method": method, "params": params})
        while True:
            r = self._frame(10)
            if r is None:
                raise TimeoutError(method)
            if r.get("id") == self.seq:
                if "error" in r:
                    raise RuntimeError(r["error"])
                return r["result"]
            if "method" in r:
                self.events.append(r)

    def pump(self, secs):
        """收 secs 秒的事件，返回（含 call 期间攒下的）"""
        end = time.time() + secs
        while True:
            left = end - time.time()
            if left <= 0:
                break
            r = self._frame(left)
            if r and "method" in r:
                self.events.append(r)
        ev, self.events = self.events, []
        return ev

    def js(self, expr, wait=False):
        try:
            r = self.call("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=wait)["result"]
        except (RuntimeError, TimeoutError):
            return None   # 页面正在刷新（上下文没了）等
        return r.get("value")


# 页面里的采样器：给每个 <video> 编号，记 currentTime；返回 [[编号, currentTime, readyState], ...]
SAMPLER = ("window.__st=window.__st||{n:0};(()=>{const o=[];for(const v of document.querySelectorAll('video')){"
           "if(!v.__tid)v.__tid=++window.__st.n;o.push([v.__tid,v.currentTime,v.readyState])}return JSON.stringify(o)})()")


# 页面状态栏里「硬解 n · MSE n · 软解 n」和 liveHub 的「本屏 x/y 路在播（…排队…建连中…失败 / 重连）」文字（取不到就是 None）
STATUS = ("(()=>{const t=document.body.innerText+' '+Array.from(document.querySelectorAll('[title]')).map(e=>e.title).join(' ');"
          "const a=t.match(/硬解 \\d+ · MSE \\d+ · 软解 \\d+/);const b=t.match(/本屏 \\d+\\/\\d+ 路在播[^。]*/);"
          "return (a?a[0]:'-')+' | '+(b?b[0]:'-')})()")


# 页面自检：浏览器认不认 H.265、是不是硬解、页面里记的失败 / 实测结论
SELFCHECK = ("(async()=>{const o={host:location.hostname};"
             "try{o.mse=MediaSource.isTypeSupported('video/mp4; codecs=\"hvc1.1.6.L150.90\"')}catch(e){o.mse='err'}"
             "try{const r=await navigator.mediaCapabilities.decodingInfo({type:'media-source',video:{contentType:'video/mp4; codecs=\"hvc1.1.6.L120.90\"',width:1920,height:1080,bitrate:4e6,framerate:25}});"
             "o.supported=r.supported;o.powerEfficient=r.powerEfficient}catch(e){o.mc='err'}"
             "o.bad=localStorage.getItem('ioc:hevc-bad');o.hw=localStorage.getItem('ioc:chrome-hw');o.console=localStorage.getItem('ioc:local-console');"
             "return JSON.stringify(o)})()")


def engines():
    """显卡引擎累计占用（纳秒）：{进程名: {'dec': ns, 'enc': ns}}；同一个 drm client 只算一次。读不到返回 None"""
    out, seen, any_ok = {}, set(), False
    for fd in glob.glob("/proc/[0-9]*/fdinfo/*"):
        try:
            t = open(fd).read()
        except OSError:
            continue
        if "drm-engine-" not in t:
            continue
        any_ok = True
        cid = re.search(r"drm-client-id:\s*(\d+)", t)
        pdev = re.search(r"drm-pdev:\s*(\S+)", t)
        pid = fd.split("/")[2]
        key = (pid, cid.group(1) if cid else fd, pdev.group(1) if pdev else "")
        if key in seen:
            continue
        seen.add(key)
        try:
            comm = open(f"/proc/{pid}/comm").read().strip()
        except OSError:
            comm = pid
        d = out.setdefault(comm, {"dec": 0, "enc": 0})
        for name, v in re.findall(r"drm-engine-(\w+):\s*(\d+) ns", t):
            if name.startswith("dec"):
                d["dec"] += int(v)
            elif name.startswith("enc"):
                d["enc"] += int(v)
    return out if any_ok else None


def pct(a, b, secs):
    """b 相对 a 的占用百分比（占 secs 秒的比例）"""
    r = {}
    for comm, v in b.items():
        p = a.get(comm, {"dec": 0, "enc": 0})
        r[comm] = {k: max(0, v[k] - p[k]) / (secs * 1e9) * 100 for k in ("dec", "enc")}
    return r


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    n = int(sys.argv[1])
    rest = sys.argv[2:]
    reload_ = "reload" in rest
    nums = [x for x in rest if x != "reload"]
    secs = float(nums[0]) if nums else 90.0
    c = Cdp()
    sel = f'[data-action="lc-split-{n}"]'
    st = c.js("(()=>{const b=document.querySelector(%s);return b?(b.classList.contains('on')?'on':'off'):'none'})()" % json.dumps(sel))
    if st == "none":
        print(f"页面上找不到 {n} 分屏按钮（这个页面不是大屏本地控制台，或没有这个分屏数）")
        return 1
    if st == "on" and not reload_:
        print(f"已经是 {n} 分屏，点按钮没有效果。先切到别的分屏（比如 16）等画面稳定，再跑这条；或在命令最后加 reload。")
        return 1
    c.call("Media.enable")
    c.call("Network.enable")
    c.call("Runtime.enable")
    c.js(SAMPLER)
    if reload_ and st != "on":
        c.js("document.querySelector(%s).click()" % json.dumps(sel))
        time.sleep(3)   # 等页面把分屏数存进 localStorage、上一屏清场
        c.pump(0.1)
    base = engines()
    t0 = time.time()
    if reload_:
        c.call("Page.reload")
        print(f"{n} 分屏，已刷新页面，盯 {int(secs)} 秒（每 10 秒一行：在播 / 累计出现过的格子 / 掉线格 / 引擎）")
    else:
        c.js("document.querySelector(%s).click()" % json.dumps(sel))
        print(f"已点 {n} 分屏，盯 {int(secs)} 秒（每 10 秒一行：在播 / 累计出现过的格子 / 掉线格 / 引擎）")
    reqs, order, cons, mmsg, gpu = {}, [], {}, {}, [None]

    def body_of(rid):
        try:
            r = c.call("Network.getResponseBody", requestId=rid)
            b = base64.b64decode(r["body"]).decode("utf-8", "replace") if r.get("base64Encoded") else r.get("body", "")
            j = json.loads(b)
            return j.get("data", j) if isinstance(j, dict) and isinstance(j.get("data", j), dict) else {}
        except Exception:
            return None
    players, errs, ever_play, last_t, dropped, tids = {}, {}, set(), {}, set(), set()
    started = {}
    prev_eng, prev_at = base, time.time()
    step = 0
    playing = 0
    while time.time() - t0 < secs:
        for e in c.pump(2.0):
            p = e.get("params") or {}
            pid = p.get("playerId")
            m = e["method"]
            if m == "Media.playerPropertiesChanged":
                o = players.setdefault(pid, {})
                for x in p.get("properties") or []:
                    o[x.get("name")] = str(x.get("value"))
            elif m == "Media.playerErrorsRaised":
                for x in p.get("errors") or []:
                    errs.setdefault(pid, []).append(json.dumps(x, ensure_ascii=False)[:300])
            elif m == "Media.playerMessagesLogged":
                for x in p.get("messages") or []:
                    if x.get("level") in ("error", "warning"):
                        k = str(x.get("message"))[:160]
                        mmsg[k] = mmsg.get(k, 0) + 1
            elif m == "Network.requestWillBeSent":
                u = (p.get("request") or {}).get("url", "")
                mm = re.search(r"/devices/([^/]+)/live\?(.*)$", u)
                if mm:
                    reqs[p["requestId"]] = {"t": time.time() - t0, "cam": mm.group(1), "q": mm.group(2), "status": None, "res": None}
                    order.append(p["requestId"])
                elif "/network/live/capacity" in u:
                    reqs[p["requestId"]] = {"cap": True}
            elif m == "Network.responseReceived" and p.get("requestId") in reqs:
                reqs[p["requestId"]]["status"] = (p.get("response") or {}).get("status")
            elif m == "Network.loadingFinished" and p.get("requestId") in reqs:
                r0 = reqs[p["requestId"]]
                d = body_of(p["requestId"])
                if r0.get("cap"):
                    if d and d.get("gpu") is not None:
                        gpu[0] = d.get("gpu")
                    del reqs[p["requestId"]]
                else:
                    r0["res"] = d if d is not None else {}
                    r0["dt"] = time.time() - t0 - r0["t"]
            elif m == "Runtime.consoleAPICalled" and p.get("type") in ("error", "warning"):
                k = " ".join(str(a.get("value", a.get("description", ""))) for a in p.get("args") or [])[:160]
                cons[k] = cons.get(k, 0) + 1
            elif m == "Runtime.exceptionThrown":
                d = p.get("exceptionDetails") or {}
                k = ("异常 " + str((d.get("exception") or {}).get("description") or d.get("text")))[:160]
                cons[k] = cons.get(k, 0) + 1
        rows = json.loads(c.js(SAMPLER) or "[]")
        playing = 0
        for tid, ct, rs in rows:
            tids.add(tid)
            started.setdefault(tid, time.time() - t0)
            ok = rs >= 2 and ct > last_t.get(tid, -1) + 0.2
            if tid in last_t and ct > last_t[tid]:
                last_t[tid] = ct
            last_t.setdefault(tid, ct)
            if ok:
                playing += 1
                ever_play.add(tid)
            elif tid in ever_play:
                dropped.add(tid)
        step += 1
        if step % 5 == 0:
            now = time.time()
            cur = engines()
            line = ""
            if cur is not None and prev_eng is not None:
                pc = pct(prev_eng, cur, now - prev_at)
                line = "  引擎 解码 %.0f%% 编码 %.0f%%（Chrome 解码 %.0f%%，ffmpeg 解码 %.0f%% 编码 %.0f%%）" % (
                    sum(v["dec"] for v in pc.values()), sum(v["enc"] for v in pc.values()),
                    pc.get("chrome", {}).get("dec", 0), pc.get("ffmpeg", {}).get("dec", 0), pc.get("ffmpeg", {}).get("enc", 0))
            prev_eng, prev_at = cur, now
            print("%3ds  在播 %d / 出现过 %d 格 / 掉线 %d 格%s" % (now - t0, playing, len(tids), len(dropped), line), flush=True)
            print("      页面状态栏：" + str(c.js(STATUS)), flush=True)
    # 汇总
    rows = json.loads(c.js(SAMPLER) or "[]")
    tally = {}
    for pid, o in players.items():
        if not o.get("kVideoDecoderName"):
            continue
        tr = o.get("kVideoTracks", "")
        codec = "hevc" if re.search(r"hevc|hvc1|h265", tr, re.I) else "h264" if re.search(r"h264|avc", tr, re.I) else "?"
        k = "%s %s%s" % (codec, o["kVideoDecoderName"], "(显卡)" if o.get("kIsPlatformVideoDecoder") == "true" else "")
        tally[k] = tally.get(k, 0) + 1
    notsup = sum(1 for v in errs.values() for x in v if "NOT_SUPPORTED" in x)
    now_playing = playing   # 最后一轮采样里在走的格子数
    print("---- 汇总（%s 分屏，%d 秒）" % (n, secs))
    print("格子：页面上现在有 %d 个视频；累计出现过 %d 个（多出来的是重连换掉的）" % (len(rows), len(tids)))
    print("结束时在播 %d 格；掉过线 %d 格；重连新增 %d 个视频" % (now_playing, len(dropped), max(0, len(tids) - n)))
    print("播放器出错：%d 个（其中 NOT_SUPPORTED %d）" % (len(errs), notsup))
    print("解码器分布：" + ("，".join("%s ×%d" % kv for kv in sorted(tally.items())) or "没取到（Media 域没补发）"))
    # 要流记录
    live = [reqs[i] for i in order]
    is_tr = lambda d: bool(d) and (bool(d.get("transcoded")) or bool(re.search(r"_(h264|thumb)\.live\.mp4", str(d.get("path") or d.get("url") or ""))))
    want_raw = [r for r in live if "raw=1" in r["q"] or "hevc=1" in r["q"]]
    got = [r for r in live if r["res"]]
    print("向后端要流 %d 次：要原始流 %d 次，要转码流 %d 次。后端给回：原始流 %d，转码流 %d，没有结果 / 失败 %d" % (
        len(live), len(want_raw), len(live) - len(want_raw),
        sum(1 for r in got if not is_tr(r["res"])), sum(1 for r in got if is_tr(r["res"])), len(live) - len(got)))
    for r in live[:40]:
        d = r["res"] or {}
        what = ("转码 " if is_tr(d) else "原始 ") + str(d.get("sourceCodec") or d.get("codec") or "") if d else "无结果（HTTP %s）" % r["status"]
        print("  +%5.1fs 通道 %-4s %s → %s（%.1f 秒）" % (r["t"], r["cam"], "要原始" if r in want_raw else "要转码", what, r.get("dt", 0)))
    if len(live) > 40:
        print("  ……共 %d 次，只列前 40" % len(live))
    print("后端给页面的显卡校准：" + json.dumps(gpu[0], ensure_ascii=False))
    print("页面自检：" + str(c.js(SELFCHECK, wait=True)))
    for title, d in (("播放器报错 / 警告", mmsg), ("页面控制台报错 / 警告", cons)):
        if d:
            print(title + "（出现次数最多的 6 条）：")
            for k, v in sorted(d.items(), key=lambda kv: -kv[1])[:6]:
                print("  ×%d %s" % (v, k))
    for pid, v in list(errs.items())[:3]:
        print("  播放器错误样例：" + v[0])
    try:
        mem = dict(re.findall(r"(\w+):\s+(\d+) kB", open("/proc/meminfo").read()))
        print("整机：load %.1f，可用内存 %d MB" % (os.getloadavg()[0], int(mem.get("MemAvailable", 0)) // 1024))
    except OSError:
        pass
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, StopIteration) as e:
        print("连不上 Chrome 调试口 127.0.0.1:%d（显示器没接 / Chrome 没起来？）：%s" % (PORT, e))
        sys.exit(1)
