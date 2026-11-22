// ZLMediaKit 配置里的转码命令（H.265 → H.264，给直播墙用，见 h2z.backend apps/security/src/ioc-ops/transcode.ts）。
// ZLM 没有内置转码，只能让它起 ffmpeg：addFFmpegSource 的命令模板写在 ini 的 [ffmpeg] 段，后端用键名 ffmpeg.cmd_h264 引用。
// 新装由 init.mjs 写进 runtime/zlm.ini；已经装好的板子由 compose 的 zlm-config 一次性服务补上（git pull + docker compose up 即可）。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MARK = '; h2z-transcode v7';
// v2：新增 cmd_h264_pb（回放）；v3：新增 cmd_h264_hw_*（RK3588 硬件）；v4：新增 cmd_copy_pb*（本地录像机回放，原样转发）；v5：倍速改成和录像机回放一样（-readrate，时间戳不动），老 ffmpeg 退回 -itsscale。三个 %s 依次是 ffmpeg 路径、输入地址、输出地址。-an：直播墙不要声音；-threads 1：一路最多占一个核，十几路同时转也不互相挤；；v6：新增 cmd_h264_thumb（本地控制台 64 / 128 分屏的缩略档，只解关键帧）；v7：新增 cmd_h264_vaapi_*（x86 核显 VAAPI 硬件转码，含启动自检用的 selftest 两条）
// ultrafast + zerolatency：延迟最小、CPU 最省（子码流分辨率很小，画质够用）。
export const SECTION = [
  MARK,
  '[ffmpeg]',
  'bin=/usr/bin/ffmpeg',
  'cmd_h264=%s -fflags nobuffer -flags low_delay -rtsp_transport tcp -i %s -an -c:v libx264 -preset ultrafast -tune zerolatency -profile:v main -pix_fmt yuv420p -bf 0 -g 30 -threads 1 -f flv %s',
  // 录像机回放专用：回放常是 5MP（3200x1800），整幅转码跟不上实时，先缩到 640 宽（高按比例取偶数）再编码
  'cmd_h264_pb=%s -fflags nobuffer -flags low_delay -rtsp_transport tcp -i %s -an -vf scale=640:-2 -c:v libx264 -preset ultrafast -tune zerolatency -profile:v main -pix_fmt yuv420p -bf 0 -g 30 -threads 2 -f flv %s',
  // RK3588 硬件转码（需要 zlm-rk3588 镜像里的 ffmpeg-rockchip，后端 IOC_TRANSCODE_HW=rkmpp 时才选这些）：
  // 硬解（drm_prime，帧不进 CPU）→ 硬编 H.264；每秒一个关键帧（-g 25）、无 B 帧、固定码率，与客户摄像头的关键帧间隔无关。
  //   hw_sub：子码流，原分辨率，低码率；hw_small：回放 / 没有子码流时缩到 640 宽（RGA 硬件缩放）；hw_main：主码流，分辨率不降，高码率。
  'cmd_h264_hw_sub=%s -fflags nobuffer -flags low_delay -rtsp_transport tcp -hwaccel rkmpp -hwaccel_output_format drm_prime -i %s -an -c:v h264_rkmpp -rc_mode CBR -b:v 800k -g 25 -bf 0 -f flv %s',
  'cmd_h264_hw_small=%s -fflags nobuffer -flags low_delay -rtsp_transport tcp -hwaccel rkmpp -hwaccel_output_format drm_prime -i %s -an -vf scale_rkrga=w=640:h=-2:format=nv12 -c:v h264_rkmpp -rc_mode CBR -b:v 800k -g 25 -bf 0 -f flv %s',
  'cmd_h264_hw_main=%s -fflags nobuffer -flags low_delay -rtsp_transport tcp -hwaccel rkmpp -hwaccel_output_format drm_prime -i %s -an -c:v h264_rkmpp -rc_mode CBR -b:v 8M -g 25 -bf 0 -f flv %s',
  // x86 核显 VAAPI 硬件转码（后端 IOC_TRANSCODE_HW=auto / vaapi 且启动自检通过才选这些；需要 zlm-x86 镜像里的 libva 驱动和 compose.zlm-vaapi.yaml 映射的 /dev/dri/renderD128）：
  // 显卡硬解 H.265（-hwaccel_output_format vaapi：帧留在显存里，硬解不了就直接报错，不会悄悄退回 CPU 解）→ scale_vaapi 转成 nv12（顺手把 10 位转 8 位）→ 显卡硬编 H.264。
  // 每秒一个关键帧、无 B 帧，和 RK3588 的模板一致；-qp 28 是恒定质量（2026-11-05 在 Haswell 上用同一组编码参数测过，AMD Raven 的硬解已在客户机上实测，硬编的路数上限还没测）。
  //   vaapi_sub：子码流原分辨率；vaapi_small：回放 / 没有子码流时缩到 640 宽（scale_vaapi 的 h=-2 未在真机验证，后端对这一档自检，不通过就用软件的 small 模板）。
  //   没有 vaapi_main：4MP 以上主码流的硬编还没实测，主码流不转码的规则不变。
  //   selftest 两条：后端启动时用样片 /usr/share/h2z/selftest-hevc.mp4（镜像里带）真转一次，-re -stream_loop -1 让它一直推到被后端删掉；参数和 sub / small 一致，只是输入是文件（没有 -rtsp_transport）。
  'cmd_h264_vaapi_sub=%s -fflags nobuffer -flags low_delay -rtsp_transport tcp -hwaccel vaapi -hwaccel_device /dev/dri/renderD128 -hwaccel_output_format vaapi -i %s -an -vf scale_vaapi=format=nv12 -c:v h264_vaapi -qp 28 -bf 0 -g 25 -f flv %s',
  'cmd_h264_vaapi_small=%s -fflags nobuffer -flags low_delay -rtsp_transport tcp -hwaccel vaapi -hwaccel_device /dev/dri/renderD128 -hwaccel_output_format vaapi -i %s -an -vf scale_vaapi=w=640:h=-2:format=nv12 -c:v h264_vaapi -qp 28 -bf 0 -g 25 -f flv %s',
  'cmd_h264_vaapi_selftest=%s -re -stream_loop -1 -hwaccel vaapi -hwaccel_device /dev/dri/renderD128 -hwaccel_output_format vaapi -i %s -an -vf scale_vaapi=format=nv12 -c:v h264_vaapi -qp 28 -bf 0 -g 25 -f flv %s',
  'cmd_h264_vaapi_selftest_small=%s -re -stream_loop -1 -hwaccel vaapi -hwaccel_device /dev/dri/renderD128 -hwaccel_output_format vaapi -i %s -an -vf scale_vaapi=w=640:h=-2:format=nv12 -c:v h264_vaapi -qp 28 -bf 0 -g 25 -f flv %s',
  // 缩略档（本地控制台 64 / 128 分屏的小格子；后端 transcode.ts 的 thumb 角色）：H.264 / H.265 源都转，只解关键帧（-skip_frame nokey，解码量降到 1/GOP），
  // 补成固定 5 帧/秒（-r 5 -fps_mode cfr）、缩到 320 宽再编 H.264。实测每路 CPU 约完整转码的十分之一。所有硬件上都用这个软件模板（关键帧模式下 CPU 成本可忽略）。
  // 画面每个关键帧才更新一次（摄像头关键帧间隔 1～4 秒），稳定后延迟约一个关键帧间隔；-threads 1 放 -i 前面：解码也只用一个线程（128 路同时转，别各开一堆线程）。
  // -fps_mode 要 ffmpeg 5.1+（实测官方 ZLM 镜像里的 ffmpeg 版本见 scripts/transcode-probe.sh 第 9 步）。
  'cmd_h264_thumb=%s -fflags nobuffer -flags low_delay -skip_frame nokey -threads 1 -rtsp_transport tcp -i %s -an -vf scale=320:-2 -r 5 -fps_mode cfr -c:v libx264 -preset ultrafast -tune zerolatency -profile:v main -pix_fmt yuv420p -bf 0 -g 10 -threads 1 -f flv %s',
  // 本地录像机（h2z.recorder）回放：和录像机回放走同一条路——ffmpeg 从后端读这一刻起的录像（MP4），原样转发（不转码、几乎不占 CPU）推进 ZLM，
  // 浏览器拿 ZLM 的流（能硬解 H.265 直接放，否则后端再起上面的转码）。-re 按 1 倍速读。RTSP 推流（FLV 装不了 H.265）。
  // 倍速和录像机回放一样：-readrate N 按 N 倍速送、时间戳不动，浏览器按 N 倍速播（4 倍速以上后端只给关键帧，同录像机快放只发 I 帧）；
  // -readrate 要 ffmpeg 5+，ZLM 镜像里的 ffmpeg 太老时后端退回下面的 -itsscale（时间戳压缩，浏览器按 1 倍速播）。
  'cmd_copy_pb=%s -re -probesize 2000000 -analyzeduration 2000000 -i %s -an -c:v copy -f rtsp -rtsp_transport tcp %s',
  'cmd_copy_pb_r2=%s -readrate 2 -probesize 2000000 -analyzeduration 2000000 -i %s -an -c:v copy -f rtsp -rtsp_transport tcp %s',
  'cmd_copy_pb_r4=%s -readrate 4 -probesize 2000000 -analyzeduration 2000000 -i %s -an -c:v copy -f rtsp -rtsp_transport tcp %s',
  'cmd_copy_pb_r8=%s -readrate 8 -probesize 2000000 -analyzeduration 2000000 -i %s -an -c:v copy -f rtsp -rtsp_transport tcp %s',
  'cmd_copy_pb_x2=%s -re -itsscale 0.5 -probesize 2000000 -analyzeduration 2000000 -i %s -an -c:v copy -f rtsp -rtsp_transport tcp %s',
  'cmd_copy_pb_x4=%s -re -itsscale 0.25 -probesize 2000000 -analyzeduration 2000000 -i %s -an -c:v copy -f rtsp -rtsp_transport tcp %s',
  'cmd_copy_pb_x8=%s -re -itsscale 0.125 -probesize 2000000 -analyzeduration 2000000 -i %s -an -c:v copy -f rtsp -rtsp_transport tcp %s',
  'log=/tmp/ffmpeg.log',
  '',
].join('\n');

/** 给 ini 文本补上转码段；已经有（带本版标记）就原样返回；有旧版 [ffmpeg] 段（没有标记）就换掉 */
export function withTranscode(ini) {
  const text = String(ini || '');
  if (text.includes(MARK)) return text;
  // 去掉没有标记的旧 [ffmpeg] 段（到下一个段头或文件尾）
  const stripped = text.replace(/^; h2z-transcode v\d+\r?\n/gm, '').replace(/^\[ffmpeg\][\s\S]*?(?=^\[|(?![\s\S]))/m, '');
  return stripped.replace(/\s*$/, '\n') + SECTION;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2] || '/runtime/zlm.ini';
  if (!existsSync(file)) { console.log('zlm.ini 还不存在（首次安装由 init 生成），跳过'); process.exit(0); }
  const cur = readFileSync(file, 'utf8');
  const next = withTranscode(cur);
  if (next !== cur) { writeFileSync(file, next); console.log('已补上 ZLM 转码命令'); } else console.log('ZLM 转码命令已就绪');
}
