# ZLMediaKit + ffmpeg-rockchip（RK3588 硬件转码：hevc_rkmpp 解码 → scale_rkrga 缩放 → h264_rkmpp 编码）。
# 以官方 zlmediakit 镜像为底，编译 MPP / RGA / ffmpeg-rockchip 装到 /opt/ffmpeg-rk，再把 /usr/bin/ffmpeg 指向它：
#   - ZLM 的 ini 不用改 bin 路径，原来的软件转码模板（libx264）在这个镜像里照样能用（开发机 / 没硬件时的退路）；
#   - 硬件模板见 scripts/zlm-config.mjs（cmd_h264_hw_*）。
# 容器运行要求（compose.zlm-rk3588.yaml 已写）：挂 /dev/mpp_service /dev/rga /dev/dri /dev/dma_heap，root 运行，
# 并且 security_opt: systempaths=unconfined —— Docker 默认遮住 /sys/firmware，MPP 读不到设备树就认不出 RK3588，
# 只放行 H.264，H.265 编解码会报 “unable to create dec h265 for soc unknown”（2026-10-28 板上实测）。
# 只在 linux/arm64 构建（GitHub Actions: build-zlm-rk3588.yml）。构建最后一步自检：缺任何一个硬件编解码器 / 滤镜就失败。
ARG ZLM_BASE=zlmediakit/zlmediakit:master

FROM ${ZLM_BASE} AS builder
USER root
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git build-essential cmake meson ninja-build pkg-config nasm yasm libdrm-dev libx264-dev \
    && rm -rf /var/lib/apt/lists/*
ARG PREFIX=/opt/ffmpeg-rk
WORKDIR /src
# MPP（硬件编解码）：nyanmisaka 的 jellyfin-mpp 分支，与 ffmpeg-rockchip 配套
RUN git clone --depth=1 -b jellyfin-mpp https://github.com/nyanmisaka/mpp.git rkmpp \
 && git -C rkmpp rev-parse HEAD \
 && cmake -S rkmpp -B rkmpp/build -DCMAKE_INSTALL_PREFIX=${PREFIX} -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON -DBUILD_TEST=OFF \
 && cmake --build rkmpp/build -j"$(nproc)" && cmake --install rkmpp/build
# RGA（硬件缩放 / 格式转换）
RUN git clone --depth=1 -b jellyfin-rga https://github.com/nyanmisaka/rk-mirrors.git rkrga \
 && git -C rkrga rev-parse HEAD \
 && meson setup rkrga/build rkrga --prefix=${PREFIX} --libdir=lib --buildtype=release --default-library=shared \
      -Dcpp_args=-fpermissive -Dlibdrm=false -Dlibrga_demo=false \
 && ninja -C rkrga/build install
# ffmpeg-rockchip；libx264 留给软件退路模板
RUN git clone --depth=1 https://github.com/nyanmisaka/ffmpeg-rockchip.git ffmpeg \
 && git -C ffmpeg rev-parse HEAD \
 && cd ffmpeg \
 && PKG_CONFIG_PATH=${PREFIX}/lib/pkgconfig ./configure --prefix=${PREFIX} \
      --enable-gpl --enable-version3 --enable-libdrm --enable-rkmpp --enable-rkrga --enable-libx264 \
      --disable-doc --disable-debug --disable-ffplay \
      --extra-cflags=-I${PREFIX}/include --extra-ldflags="-L${PREFIX}/lib -Wl,-rpath,${PREFIX}/lib" \
 && make -j"$(nproc)" && make install \
 && cp -a /usr/lib/*/libx264.so.* ${PREFIX}/lib/

FROM ${ZLM_BASE}
USER root
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends libdrm2 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /opt/ffmpeg-rk /opt/ffmpeg-rk
RUN ln -sf /opt/ffmpeg-rk/bin/ffmpeg /usr/bin/ffmpeg \
 && ! ldd /opt/ffmpeg-rk/bin/ffmpeg | grep "not found" \
 && ffmpeg -hide_banner -decoders 2>/dev/null | grep -q hevc_rkmpp \
 && ffmpeg -hide_banner -decoders 2>/dev/null | grep -q h264_rkmpp \
 && ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_rkmpp \
 && ffmpeg -hide_banner -encoders 2>/dev/null | grep -q libx264 \
 && ffmpeg -hide_banner -filters 2>/dev/null | grep -q scale_rkrga \
 && echo "zlm-rk3588: rkmpp / rkrga / libx264 OK"
