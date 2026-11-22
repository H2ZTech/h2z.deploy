#!/bin/sh
# 板上硬件转码探测：拿一路真实的 H.265 RTSP，看 RK3588 能不能「硬解 H.265 → 缩放 → 硬编 H.264」，跑多快、占多少 CPU。
# 注意：Docker 默认遮住 /sys/firmware，MPP 读不到设备树就认不出 RK3588（日志：can not found match soc name），H.265 编解码被拒；
#       所以要 --security-opt systempaths=unconfined（正式 compose 里同样要加 security_opt）。
# 设备权限排查：PRIV=1 sh scripts/hwtranscode-probe.sh …（用 --privileged 跑，排除设备挂载 / 权限问题）
# 用法：sh scripts/hwtranscode-probe.sh <rtsp 地址> [并行路数，默认 1] [镜像，默认 h2z-ffmpeg-rk-probe]
# 先构建镜像：docker build -f docker/ffmpeg-rk-probe.Dockerfile -t h2z-ffmpeg-rk-probe docker
# 地址写 auto：自动从板子上的 ZLM 里挑一路正在拉的 H.265 流（ZLM 本机转出的 rtsp://127.0.0.1:<RTSP_PORT>/…，不需要账号口令）。
#   用 auto 前先让板子有流：打开 IOC 直播墙（或点一次录像查询），保持页面开着，再运行。
# 也可以直接给摄像头地址：rtsp://用户:口令@摄像头IP:554/Streaming/Channels/102（口令只在你的终端里）
set -u
URL="${1:?用法: $0 <rtsp 地址> [并行路数] [镜像]}"
N="${2:-1}"
IMG="${3:-h2z-ffmpeg-rk-probe}"
SECS=20
NET=""
if [ "$URL" = auto ]; then
  [ -f .env ] || { echo "请在 ~/h2z.security 目录里运行（要读 .env）"; exit 1; }
  SECRET=$(grep '^ZLM_SECRET=' .env | cut -d= -f2)
  PORT=$(grep '^RTSP_PORT=' .env | cut -d= -f2); PORT="${PORT:-8596}"
  PICK=$(docker compose exec -T zlm curl -s "http://127.0.0.1/index/api/getMediaList?secret=$SECRET&schema=rtsp" | python3 -c '
import json, sys
d = json.load(sys.stdin).get("data") or []
c = []
for s in d:
    if s["stream"].endswith("_h264") or s["stream"].startswith("probe_") or s["app"] == "probe":
        continue
    t = [x for x in (s.get("tracks") or []) if x.get("codec_type") == 0]
    if t and "265" in str(t[0].get("codec_id_name")):
        c.append((s["app"] == "nvr", s["app"] + "/" + s["stream"], t[0].get("width"), t[0].get("height")))
c.sort()  # 先摄像头直播流，再录像机回放流
if c:
    print(c[0][1]); sys.stderr.write("选中 %s  %sx%s H265\n" % (c[0][1], c[0][2], c[0][3]))
') || true
  [ -n "$PICK" ] || { echo "ZLM 里现在没有 H.265 流：先打开 IOC 直播墙（保持页面开着）再运行"; exit 1; }
  URL="rtsp://127.0.0.1:$PORT/$PICK"
  NET="--network host"
fi
if [ "${PRIV:-0}" = 1 ]; then DEV="$NET --privileged"; else DEV="$NET --security-opt systempaths=unconfined -e mpp_syslog_perror=1 --device /dev/mpp_service --device /dev/rga --device /dev/dri --device /dev/dma_heap"; fi
RUN="docker run --rm $DEV $IMG"

echo "== 0. 设备"; ls -l /dev/mpp_service /dev/rga /dev/dri/renderD128 /dev/dma_heap 2>&1 | head -8
echo; echo "== 1. 镜像里的硬件编解码器"
$RUN sh -c 'ffmpeg -hide_banner -decoders 2>/dev/null | grep rkmpp; ffmpeg -hide_banner -encoders 2>/dev/null | grep rkmpp; ffmpeg -hide_banner -filters 2>/dev/null | grep rkrga'

echo; echo "== 2. 源流的编码与分辨率"
docker run --rm $NET $IMG sh -c "ffmpeg -hide_banner -rtsp_transport tcp -i '$URL' -t 1 -f null - 2>&1 | grep -E 'Stream #|Duration|Input' | sed -E 's#://[^@]*@#://***@#'" || true

# 分项诊断：只硬解 / 只硬编，定位是哪一段起不来（输出完整末尾 12 行，口令打码）
diag() {
  echo; echo "== 2a. 只硬解（hevc_rkmpp 解码，丢弃）"
  docker run --rm $DEV $IMG ffmpeg -hide_banner -loglevel info -rtsp_transport tcp -c:v hevc_rkmpp -i "$URL" -t 5 -an -f null - 2>&1 | tr '\r' '\n' | sed -E 's#://[^@]*@#://***@#' | tail -12
  echo; echo "== 2b. 只硬编（合成画面 → h264_rkmpp，丢弃）"
  docker run --rm $DEV $IMG ffmpeg -hide_banner -loglevel info -f lavfi -i testsrc2=size=640x360:rate=25 -pix_fmt nv12 -c:v h264_rkmpp -b:v 800k -t 5 -f null - 2>&1 | tr '\r' '\n' | tail -12
  echo; echo "== 2c. 只硬编，不加码率参数"
  docker run --rm $DEV $IMG ffmpeg -hide_banner -loglevel info -f lavfi -i testsrc2=size=640x360:rate=25 -pix_fmt nv12 -c:v h264_rkmpp -t 5 -f null - 2>&1 | tr '\r' '\n' | tail -12
}
diag

# 硬件：硬解（drm_prime，帧不进 CPU）→ RGA 缩到 640 宽 → 硬编 H.264，1 秒一个关键帧、无 B 帧、固定码率
HW_SUB="-hwaccel rkmpp -hwaccel_output_format drm_prime -i \"$URL\" -an -vf scale_rkrga=w=640:h=-2:format=nv12 -c:v h264_rkmpp -rc_mode CBR -b:v 800k -g 25 -bf 0"
# 硬件：不缩放（单路全屏用，高码率）
HW_MAIN="-hwaccel rkmpp -hwaccel_output_format drm_prime -i \"$URL\" -an -c:v h264_rkmpp -rc_mode CBR -b:v 6M -g 25 -bf 0"
# 对照：现在在用的软件转码（只用来对比，板上不会再用）
SW_SUB="-i \"$URL\" -an -vf scale=640:-2 -c:v libx264 -preset ultrafast -tune zerolatency -profile:v main -pix_fmt yuv420p -bf 0 -g 25 -threads 2"

# run_case_fg 名字 参数 并行数：并行起 N 个 ffmpeg 各转 SECS 秒丢到 null，打印每路 speed 和整体 CPU
run_case_fg() {
  name="$1"; args="$2"; n="$3"
  echo; echo "== $name （并行 $n 路，各 ${SECS} 秒）"
  tmp=$(mktemp -d)
  i=1
  while [ "$i" -le "$n" ]; do
    ( eval "docker run --rm $DEV $IMG ffmpeg -hide_banner -loglevel warning -stats -rtsp_transport tcp $args -t $SECS -f null -" >"$tmp/$i.log" 2>&1 ) &
    i=$((i+1))
  done
  sleep 10; echo "-- 第 10 秒的 CPU 和 ffmpeg 进程："
  top -bn1 | head -3 | tail -1
  ps -eo pcpu,args | grep '[f]fmpeg' | sed -E 's#://[^@]*@#://***@#' | cut -c1-110 | head -6
  wait
  echo "-- 每路最后一行（speed=1x 以上才跟得上实时）："
  for f in "$tmp"/*.log; do
    if tr '\r' '\n' <"$f" | grep -q 'speed='; then tr '\r' '\n' <"$f" | grep 'speed=' | tail -1
    else tr '\r' '\n' <"$f" | sed -E 's#://[^@]*@#://***@#' | tail -15; fi
  done
  rm -rf "$tmp"
}

run_case_fg "3. 硬件 子码流方案：硬解 → RGA 缩放 → 硬编" "$HW_SUB" 1
run_case_fg "4. 硬件 主码流方案：硬解 → 硬编（不缩放）" "$HW_MAIN" 1
run_case_fg "5. 对照：软件转码（现状）" "$SW_SUB" 1
if [ "$N" -gt 1 ]; then run_case_fg "6. 硬件 子码流方案 并行压力" "$HW_SUB" "$N"; fi
# 7. 正式链路的最后一环：硬件转码的输出推进 ZLM（FLV 封装 + RTMP），ZLM 能认出 H.264 轨道才算通
if [ -f .env ]; then
  echo; echo "== 7. 硬件转码 → 推进 ZLM（rtmp://127.0.0.1:RTMP_PORT/probe/hw1，15 秒）"
  RPORT=$(grep '^RTMP_PORT=' .env | cut -d= -f2); RPORT="${RPORT:-1996}"
  SECRET=$(grep '^ZLM_SECRET=' .env | cut -d= -f2)
  ( eval "docker run --rm --network host $DEV $IMG ffmpeg -hide_banner -loglevel warning -rtsp_transport tcp $HW_SUB -t 15 -f flv rtmp://127.0.0.1:$RPORT/probe/hw1" > /tmp/hwprobe7.log 2>&1 ) &
  sleep 8
  docker compose exec -T zlm curl -s "http://127.0.0.1/index/api/getMediaList?secret=$SECRET&app=probe" | python3 -c '
import json, sys
d = json.load(sys.stdin).get("data") or []
if not d: print("ZLM 里没有 probe/hw1：推流没成功，见下面 ffmpeg 日志")
for s in d:
    for t in s.get("tracks") or []:
        if t.get("codec_type") == 0: print("ZLM 收到 %s/%s  %s %sx%s %s fps" % (s["app"], s["stream"], t.get("codec_id_name"), t.get("width"), t.get("height"), t.get("fps")))
' || true
  wait; sed -E 's#://[^@]*@#://***@#' /tmp/hwprobe7.log | tail -8
fi
echo; echo "== 完成。把上面整段输出（口令已打码）发回来。"
