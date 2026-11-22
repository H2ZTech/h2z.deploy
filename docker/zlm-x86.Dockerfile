# ZLMediaKit + libva 显卡驱动（x86 核显硬件转码：VAAPI 硬解 H.265 → 硬编 H.264，见 docs/VIDEO-PIPELINE-2026-10-28.md 方案一）。
# 以官方 zlmediakit 镜像为底，只补两样东西：
#   - libva 驱动：AMD（mesa-va-drivers，radeonsi）和 Intel（iHD / i965）。官方镜像的 ffmpeg 自带 VAAPI 编解码器和 hwaccel（2026-11-05 实测），
#     缺的只是驱动：没有驱动时 ffmpeg 报 “Failed to initialise VAAPI connection”（同一天在测试机上实测）。
#   - 自检样片 /usr/share/h2z/selftest-hevc.mp4（1 秒 640x360 H.265）和现场自检命令 h2z-vaapi-selftest（docker exec h2z-zlm-1 h2z-vaapi-selftest）。
# ffmpeg 不换：/usr/bin/ffmpeg 还是官方镜像自带的，软件转码模板（libx264）在这个镜像里照样能用，没有显卡 / 自检失败时后端就退回它。
# 容器运行要求（compose.zlm-vaapi.yaml 已写）：映射 /dev/dri/renderD128；容器里 ZLM 以 root 运行，不用额外加组。
# 只在 linux/amd64 构建（GitHub Actions: build-zlm-x86.yml）。构建最后一步自检：缺任何驱动 / 编码器 / 滤镜就失败，不让坏镜像发出去。
ARG ZLM_BASE=zlmediakit/zlmediakit:master
FROM ${ZLM_BASE}
USER root
ENV DEBIAN_FRONTEND=noninteractive
# Intel 的 iHD 驱动优先装 non-free 版（带完整编码），仓库里没有就退回自由版；i965 给老核显（Gen9 及以前）
RUN apt-get update \
 && apt-get install -y --no-install-recommends libva2 libva-drm2 mesa-va-drivers vainfo i965-va-driver \
 && { apt-get install -y --no-install-recommends intel-media-va-driver-non-free || apt-get install -y --no-install-recommends intel-media-va-driver; } \
 && rm -rf /var/lib/apt/lists/*
COPY zlm-x86/selftest-hevc.mp4.b64 /tmp/selftest-hevc.mp4.b64
COPY zlm-x86/h2z-vaapi-selftest /usr/local/bin/h2z-vaapi-selftest
RUN mkdir -p /usr/share/h2z \
 && tr -d '\r\n' < /tmp/selftest-hevc.mp4.b64 | base64 -d > /usr/share/h2z/selftest-hevc.mp4 \
 && rm -f /tmp/selftest-hevc.mp4.b64 \
 && sed -i 's/\r$//' /usr/local/bin/h2z-vaapi-selftest \
 && chmod 0755 /usr/local/bin/h2z-vaapi-selftest
# 构建时自检（没有显卡，只能查「东西都在」；真正的硬解硬编由后端启动时用样片在设备上自检，见 transcode.ts）
RUN set -e; d=/usr/lib/x86_64-linux-gnu/dri; \
    ls -l "$d"/*_drv_video.so; \
    [ -e "$d/radeonsi_drv_video.so" ] || { echo "缺 AMD 驱动 radeonsi_drv_video.so"; exit 1; }; \
    [ -e "$d/iHD_drv_video.so" ] || [ -e "$d/i965_drv_video.so" ] || { echo "缺 Intel 驱动 iHD / i965"; exit 1; }; \
    ! ldd /usr/bin/ffmpeg | grep "not found"; \
    ffmpeg -hide_banner -version | head -n 1; \
    ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_vaapi; \
    ffmpeg -hide_banner -encoders 2>/dev/null | grep -q libx264; \
    ffmpeg -hide_banner -hwaccels 2>/dev/null | grep -qw vaapi; \
    ffmpeg -hide_banner -filters 2>/dev/null | grep -q scale_vaapi; \
    ffmpeg -hide_banner -loglevel error -i /usr/share/h2z/selftest-hevc.mp4 -f null -; \
    ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc=size=64x64:rate=5 -t 1 -c:v libx264 -preset ultrafast -f null -; \
    echo "zlm-x86: libva 驱动 / h264_vaapi / scale_vaapi / libx264 / 样片 OK"
