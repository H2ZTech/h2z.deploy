#!/bin/sh
# H.265 -> H.264 转码探测（只读、不改设备配置）：量一量这台机器上各种转码方式各能同时转几路。
# 用法：sh scripts/transcode-probe.sh        结果同时写到 $PROBE_DIR/result.txt（缺省 /tmp/h2zprobe）
# v2（2026-11-05 第一轮实测后）：
#   - 测试片按摄像头子码流的码率重做（~700 kbps、2 秒一个关键帧），不再用高噪声片；
#   - 把「只解码」单独量出来（dec），看清楚时间花在解 H.265 还是编 H.264 上；
#   - 加「只解关键帧」（_key，ffmpeg -skip_frame nokey）：给 64 / 128 路缩略画面用，每路只解 1/GOP 的帧；
#   - 在 ZLM 镜像里直接跑一次 VAAPI，确认不用另做 ffmpeg 镜像；
#   - v3：第 9 步查 ZLM 镜像里 ffmpeg 的版本，并用缩略档模板的参数在它上面跑一遍。
# 注意：跑的时候会占满 CPU 约 5 分钟，直播和录像会受影响；最好没人在看直播时跑。
# 局限：测试片是合成画面，只能用来比较几种方式的相对差别，不是摄像头实际画面的绝对路数。
set -u
D=${PROBE_DIR:-/tmp/h2zprobe}
REF=${REF_IMG:-lscr.io/linuxserver/ffmpeg:latest}
RND=${RENDER_NODE:-/dev/dri/renderD128}
CLIP_SEC=20
mkdir -p "$D"
OUT="$D/result.txt"
: > "$OUT"
say() { echo "$*" | tee -a "$OUT"; }

DEV=""
[ -e "$RND" ] && DEV="--device /dev/dri"

say "== 1. 系统 =="
say "内核: $(uname -r)  CPU核数: $(nproc)"
say "CPU: $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | sed 's/^ //')"
say "/dev/dri: $(ls /dev/dri 2>/dev/null | tr '\n' ' ')"

say ""
say "== 2. ZLM 镜像里 ffmpeg 的硬件能力 =="
ZLM=$(docker ps --format '{{.Image}} {{.Names}}' | grep -i zlm | head -1 | cut -d' ' -f1)
if [ -n "$ZLM" ]; then
  say "ZLM 镜像: $ZLM"
  say "hwaccels: $(docker run --rm --entrypoint ffmpeg $DEV "$ZLM" -hide_banner -hwaccels 2>&1 | tr '\n' ' ')"
  docker run --rm --entrypoint ffmpeg $DEV "$ZLM" -hide_banner -encoders 2>&1 | grep -E 'h264_(vaapi|qsv|nvenc|rkmpp)|libx264 ' | tee -a "$OUT"
else
  say "没找到在跑的 ZLM 容器，跳过"
fi

say ""
say "== 3. 参考 ffmpeg 镜像和测试片 =="
if ! docker image inspect "$REF" >/dev/null 2>&1; then
  say "拉取 $REF ..."
  if ! docker pull -q "$REF" >/dev/null 2>&1; then
    say "拉取失败（设备出不了网或被限流）。可换一个带 VAAPI 的 ffmpeg 镜像：REF_IMG=<镜像> sh $0"
    exit 1
  fi
fi
say "参考镜像: $REF"

# lo.mp4：640x360 H.265 25fps，~700 kbps，2 秒一个关键帧（像摄像头的子码流）
if [ ! -s "$D/lo.mp4" ]; then
  docker run --rm -v "$D":/w "$REF" -hide_banner -loglevel error \
    -f lavfi -i "testsrc2=size=640x360:rate=25,noise=alls=4:allf=t" -t $CLIP_SEC \
    -c:v libx265 -preset ultrafast -b:v 700k -maxrate 900k -bufsize 1400k \
    -x265-params log-level=error:keyint=50:min-keyint=50:scenecut=0 -pix_fmt yuv420p -y /w/lo.mp4
fi
if [ ! -s "$D/lo.mp4" ]; then say "测试片生成失败"; exit 1; fi
say "测试片 lo.mp4: 640x360 H.265 25fps ${CLIP_SEC}s，实际码率 $(( $(wc -c < "$D/lo.mp4") * 8 / CLIP_SEC / 1000 )) kbps，2 秒一个关键帧"
if [ -s "$D/in.mp4" ]; then
  say "测试片 in.mp4（第一轮的高噪声片）: 实际码率 $(( $(wc -c < "$D/in.mp4") * 8 / CLIP_SEC / 1000 )) kbps"
fi

cat > "$D/job.sh" <<'JOB'
#!/bin/sh
# 同时起 $1 个 ffmpeg，各自把 /w/$CLIP 转一遍（不限速），退出码写到 rc.<i>，错误写到 err.<i>
i=0
while [ "$i" -lt "$1" ]; do
  ( ffmpeg -hide_banner -loglevel error $PRE -i "/w/$CLIP" -an $ARGS -f null - >"/w/err.$i" 2>&1; echo $? >"/w/rc.$i" ) &
  i=$((i + 1))
done
wait
JOB

cpu_sample() { awk '/^cpu /{b=$2+$3+$4+$7+$8; t=b+$5+$6; print b, t}' /proc/stat; }

DRV=i965
# run 模式 路数 [镜像] [测试片]：打印一行结果；返回 0 = 全部成功
run() {
  mode=$1; n=$2; img=${3:-$REF}; clip=${4:-lo.mp4}
  SW="-c:v libx264 -preset ultrafast -tune zerolatency -threads 1 -profile:v main -pix_fmt yuv420p -bf 0 -g 25"
  VA="-vf format=nv12,hwupload -c:v h264_vaapi -qp 28 -bf 0 -g 25"
  VPRE="-init_hw_device vaapi=va:$RND -filter_hw_device va"
  case "$mode" in
    dec)       PRE="-threads 1";                              ARGS="" ;;
    sw)        PRE="-threads 1";                              ARGS="$SW" ;;
    vaapi)     PRE="-threads 1 $VPRE";                        ARGS="$VA" ;;
    sw_key)    PRE="-threads 1 -skip_frame nokey";            ARGS="-fps_mode vfr $SW" ;;
    vaapi_key) PRE="-threads 1 -skip_frame nokey $VPRE";      ARGS="-fps_mode vfr $VA" ;;
    vaapi_hw)  PRE="-hwaccel vaapi -hwaccel_device $RND -hwaccel_output_format vaapi"; ARGS="-vf scale_vaapi=format=nv12 -c:v h264_vaapi -qp 28 -bf 0 -g 25" ;;
  esac
  rm -f "$D"/rc.* "$D"/err.*
  set -- $(cpu_sample); b1=$1; t1=$2
  s=$(date +%s.%N)
  docker run --rm $DEV -e LIBVA_DRIVER_NAME="$DRV" -e CLIP="$clip" -e PRE="$PRE" -e ARGS="$ARGS" -v "$D":/w --entrypoint sh "$img" /w/job.sh "$n" >/dev/null 2>&1
  e=$(date +%s.%N)
  set -- $(cpu_sample); b2=$1; t2=$2
  ok=0
  for f in "$D"/rc.*; do [ -f "$f" ] && [ "$(cat "$f")" = "0" ] && ok=$((ok + 1)); done
  line=$(awk -v m="$mode" -v n="$n" -v ok="$ok" -v s="$s" -v e="$e" -v b1="$b1" -v b2="$b2" -v t1="$t1" -v t2="$t2" -v c="$CLIP_SEC" -v cl="$clip" \
    'BEGIN{w=e-s; cp=(t2>t1)?100*(b2-b1)/(t2-t1):0; th=(ok>0&&w>0)?ok*c/w:0; printf "模式=%-9s 片=%-6s 路数=%-2d 成功=%d/%d 用时=%.1fs 相当于同时实时转 %.1f 路 CPU=%.0f%%", m, cl, n, ok, n, w, th, cp}')
  say "$line"
  if [ "$ok" -lt "$n" ]; then
    err=$(cat "$D"/err.* 2>/dev/null | grep -v '^$' | head -3 | tr '\n' ' ')
    say "    失败原因(前3行): ${err:-无输出}"
    return 1
  fi
  return 0
}

say ""
say "== 4. 只解码（H.265 -> 丢掉），看解码本身占多少 =="
run dec 16
run dec 32
[ -s "$D/in.mp4" ] && run dec 16 "$REF" in.mp4

say ""
say "== 5. 软件转码 libx264（现在 x86 的做法）=="
run sw 16
run sw 32

if [ -n "$DEV" ]; then
  say ""
  say "== 6. VAAPI（参考镜像）：CPU 解 H.265 + 核显编 H.264 =="
  found=""
  hwfull=""
  for d in radeonsi iHD i965; do
    DRV=$d
    say "尝试 LIBVA_DRIVER_NAME=$d（核显解 H.265 + 核显编 H.264，新模板的做法）"
    if run vaapi_hw 1; then found=$d; hwfull=1; break; fi
  done
  if [ -z "$found" ]; then
    for d in i965 iHD radeonsi; do
      DRV=$d
      say "尝试 LIBVA_DRIVER_NAME=$d（CPU 解码 + 核显编码）"
      if run vaapi 1; then found=$d; break; fi
    done
  fi
  if [ -n "$found" ]; then
    DRV=$found
    say "可用的 VAAPI 驱动: $found（核显解码 H.265: ${hwfull:-否}）"
    if [ -n "$hwfull" ]; then run vaapi_hw 16; run vaapi_hw 32; run vaapi_hw 64; fi
    run vaapi 16
    run vaapi 32
    if [ -n "$ZLM" ]; then
      say ""
      say "== 7. VAAPI 直接在 ZLM 镜像里跑（确认不用另做 ffmpeg 镜像）=="
      if [ -n "$hwfull" ]; then run vaapi_hw 8 "$ZLM"; else run vaapi 8 "$ZLM"; fi
    fi
    say ""
    say "== 8. 只解关键帧（64 / 128 路缩略画面用）：软件编码 vs VAAPI 编码 =="
    for n in 16 32 64; do run sw_key $n; done
    for n in 16 32 64; do run vaapi_key $n; done
  else
    say "VAAPI 在参考镜像里没跑通（两种驱动都失败）"
    say ""
    say "== 8. 只解关键帧（64 / 128 路缩略画面用）：软件编码 =="
    for n in 16 32 64; do run sw_key $n; done
  fi
else
  say ""
  say "没有 $RND，跳过 VAAPI；只做关键帧测试"
  for n in 16 32 64; do run sw_key $n; done
fi

# 第 9 步：ZLM 镜像里的 ffmpeg 版本，以及 ZLM 配置里「缩略档」模板（scripts/zlm-config.mjs 的 cmd_h264_thumb）能不能在它上面跑通
if [ -n "$ZLM" ]; then
  say ""
  say "== 9. ZLM 镜像里的 ffmpeg 版本，和缩略档模板能否跑通（-fps_mode 需要 ffmpeg 5.1+）=="
  say "ffmpeg 版本: $(docker run --rm --entrypoint ffmpeg "$ZLM" -version 2>&1 | head -1)"
  rm -f "$D/thumb_zlm.flv"
  if docker run --rm -v "$D":/w --entrypoint ffmpeg "$ZLM" -hide_banner -loglevel error \
      -fflags nobuffer -flags low_delay -skip_frame nokey -threads 1 -i /w/lo.mp4 -an -vf scale=320:-2 -r 5 -fps_mode cfr \
      -c:v libx264 -preset ultrafast -tune zerolatency -profile:v main -pix_fmt yuv420p -bf 0 -g 10 -threads 1 -f flv -y /w/thumb_zlm.flv >"$D/thumb_zlm.err" 2>&1 \
      && [ -s "$D/thumb_zlm.flv" ]; then
    say "缩略档模板在 ZLM 镜像里跑通：输出 $(wc -c < "$D/thumb_zlm.flv") 字节"
  else
    say "缩略档模板在 ZLM 镜像里失败: $(head -3 "$D/thumb_zlm.err" | tr '\n' ' ')"
  fi
fi

say ""
say "完成。结果文件: $OUT"
