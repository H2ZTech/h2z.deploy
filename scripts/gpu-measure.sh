#!/bin/sh
# 显卡解码路数实测（在 zlm-x86 容器里跑，只读、不改设备）：把样片（H.265）用显卡硬解循环解 N 路，读 /proc/<pid>/fdinfo 的解码引擎占用，
# 算出「一路占引擎百分之几」→ 这块显卡能同时硬解几路。输出 key=value，给 scripts/gpu-calibrate.mjs 解析。
# 用法（容器里）：RND=/dev/dri/renderD128 CLIP=/usr/share/h2z/selftest-hevc.mp4 sh gpu-measure.sh
# 为什么读 fdinfo：Chrome / ffmpeg 的 VAAPI 硬解不会自己告诉你「解码引擎还剩多少」；每个进程的 fdinfo 里有它占用的引擎时间（纳秒），
#   两次读数之差 ÷ 间隔 = 这个进程占引擎的比例，和别的进程在不在跑无关（H2Z-66DC 实测：14 路 640x360 解码引擎 78%、编码引擎 99%）。
# 样片是合成画面：只用来比较和估算，别的画面内容每路占用会有差别，所以结果留余量（见 gpu-calibrate.mjs）。
set -u
RND=${RND:-/dev/dri/renderD128}
CLIP=${CLIP:-/usr/share/h2z/selftest-hevc.mp4}
SECS=${SECS:-6}
out() { echo "$1=$2"; }

out node "$RND"
[ -e "$RND" ] || { out ok 0; out reason "没有 $RND"; exit 0; }
base=$(basename "$RND")
vend=$(cat "/sys/class/drm/$base/device/vendor" 2>/dev/null || echo "")
dev=$(cat "/sys/class/drm/$base/device/device" 2>/dev/null || echo "")
drv=$(basename "$(readlink "/sys/class/drm/$base/device/driver" 2>/dev/null)" 2>/dev/null || echo "")
out vendor_id "$vend"; out device_id "$dev"; out driver "$drv"
case "$drv" in
  amdgpu) ENG=drm-engine-dec; ENC_ENG=drm-engine-enc ;;
  i915) ENG=drm-engine-video; ENC_ENG=drm-engine-video ;;   # Intel 解码和编码共用 video 引擎
  *) out ok 0; out reason "驱动 ${drv:-未知} 不在支持范围（支持 amdgpu / i915；NVIDIA 暂不支持）"; exit 0 ;;
esac
out engine "$ENG"
out enc_engine "$ENC_ENG"
for t in ffmpeg ffprobe awk; do command -v $t >/dev/null 2>&1 || { out ok 0; out reason "容器里没有 $t"; exit 0; }; done
[ -f "$CLIP" ] || { out ok 0; out reason "没有样片 $CLIP"; exit 0; }
wh=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$CLIP" 2>/dev/null | head -1)
W=${wh%,*}; H=${wh#*,}
out clip_wh "${W}x${H}"
# 样片帧率：真实子码流按 25 帧算，样片帧率低就会把每路占用算轻（H2Z-66DC 实测：样片折算出每路 3.34%，25 帧 640x360 实测约 5.6%）
fr=$(ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 "$CLIP" 2>/dev/null | head -1)
out clip_fps "$(awk -v f="${fr:-25/1}" 'BEGIN{split(f,a,"/"); d=(a[2]>0)?a[2]:1; printf "%.2f", a[1]/d}')"

# 一次硬解：能不能解（H.265 硬解不通 = 这块显卡 / 驱动不能硬解 H.265，后面都不用测）
if ! ffmpeg -hide_banner -loglevel error -hwaccel vaapi -hwaccel_device "$RND" -hwaccel_output_format vaapi -i "$CLIP" -an -frames:v 20 -f null - >/tmp/gm-one.log 2>&1; then
  out ok 0; out reason "显卡不能硬解 H.265（VAAPI）：$(tail -c 200 /tmp/gm-one.log | tr '\n' ' ')"; exit 0
fi

# 读某进程占用的引擎时间（纳秒；同一个 DRM 客户端的多个 fd 只算一次）
eng_ns() { awk -v e="${2:-$ENG}" 'FNR==1{cid=""} /^drm-client-id:/{cid=$2} $1==e":"{v[cid]=$2} END{s=0; for(c in v) s+=v[c]; print s+0}' /proc/$1/fdinfo/* 2>/dev/null; }

run_k() { # $1 = 路数；输出 pct（k 路合计占引擎 %）、speed_min（最慢一路的实时倍数）
  k=$1; pids=""; i=0
  while [ $i -lt $k ]; do
    ffmpeg -hide_banner -loglevel error -nostats -hwaccel vaapi -hwaccel_device "$RND" -hwaccel_output_format vaapi -re -stream_loop -1 -i "$CLIP" -an \
      -progress /tmp/gm-p$i -f null - >/dev/null 2>&1 &
    pids="$pids $!"; i=$((i+1))
  done
  sleep 3   # 起来 + 稳定
  a=0; for p in $pids; do a=$((a + $(eng_ns $p))); done
  t0=$(date +%s%N)
  sleep "$SECS"
  b=0; for p in $pids; do b=$((b + $(eng_ns $p))); done
  t1=$(date +%s%N)
  alive=0; for p in $pids; do kill -0 $p 2>/dev/null && alive=$((alive+1)); done
  sp=99; i=0
  while [ $i -lt $k ]; do
    s=$(grep '^speed=' /tmp/gm-p$i 2>/dev/null | tail -1 | sed 's/speed=//; s/x//; s/ //g')
    case "$s" in ''|N/A) s=0 ;; esac
    sp=$(awk -v a="$sp" -v b="$s" 'BEGIN{print (b<a)?b:a}')
    i=$((i+1))
  done
  for p in $pids; do kill $p 2>/dev/null; done
  wait 2>/dev/null
  pct=$(awk -v a="$a" -v b="$b" -v t0="$t0" -v t1="$t1" 'BEGIN{d=t1-t0; if(d<=0){print 0}else printf "%.2f", (b-a)*100/d}')
  echo "$pct $sp $alive"
}

set -- $(run_k 4); P4=$1; S4=$2; A4=$3
out k4_pct "$P4"; out k4_speed "$S4"; out k4_alive "$A4"
P8=""; S8=""
if [ "$A4" = 4 ] && awk -v s="$S4" 'BEGIN{exit !(s>=0.95)}'; then
  set -- $(run_k 8); P8=$1; S8=$2; A8=$3
  out k8_pct "$P8"; out k8_speed "$S8"; out k8_alive "$A8"
fi

# 显卡转码（硬解 H.265 + 硬编 H.264）每路各占解码、编码引擎多少：后端「显卡转码最多几路」按它定，不写死。
# 只跑 4 路（每个 ffmpeg 约 90 MB，容器限 512 MB）；编不了（没有 h264_vaapi）就不输出 t4_*，上限交给后端保底值。
run_t() { # $1 = 路数；输出 dec% enc% 最慢倍速 存活数
  k=$1; pids=""; i=0
  while [ $i -lt $k ]; do
    ffmpeg -hide_banner -loglevel error -nostats -hwaccel vaapi -hwaccel_device "$RND" -hwaccel_output_format vaapi -re -stream_loop -1 -i "$CLIP" -an \
      -c:v h264_vaapi -b:v 600k -g 50 -progress /tmp/gm-t$i -f null - >/dev/null 2>&1 &
    pids="$pids $!"; i=$((i+1))
  done
  sleep 3
  a=0; ae=0; for p in $pids; do a=$((a + $(eng_ns $p))); ae=$((ae + $(eng_ns $p "$ENC_ENG"))); done
  t0=$(date +%s%N)
  sleep "$SECS"
  b=0; be=0; for p in $pids; do b=$((b + $(eng_ns $p))); be=$((be + $(eng_ns $p "$ENC_ENG"))); done
  t1=$(date +%s%N)
  alive=0; for p in $pids; do kill -0 $p 2>/dev/null && alive=$((alive+1)); done
  sp=99; i=0
  while [ $i -lt $k ]; do
    s=$(grep '^speed=' /tmp/gm-t$i 2>/dev/null | tail -1 | sed 's/speed=//; s/x//; s/ //g')
    case "$s" in ''|N/A) s=0 ;; esac
    sp=$(awk -v a="$sp" -v b="$s" 'BEGIN{print (b<a)?b:a}')
    i=$((i+1))
  done
  for p in $pids; do kill $p 2>/dev/null; done
  wait 2>/dev/null
  awk -v a="$a" -v b="$b" -v ae="$ae" -v be="$be" -v t0="$t0" -v t1="$t1" -v sp="$sp" -v al="$alive" 'BEGIN{d=t1-t0; if(d<=0)d=1; printf "%.2f %.2f %s %s\n", (b-a)*100/d, (be-ae)*100/d, sp, al}'
}
set -- $(run_t 4)
if [ "${4:-0}" = 4 ]; then out t4_dec_pct "$1"; out t4_enc_pct "$2"; out t4_speed "$3"; out t4_alive "$4"; else out t4_alive "${4:-0}"; fi
out ok 1
