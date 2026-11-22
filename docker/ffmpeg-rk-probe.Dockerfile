# 板上硬件转码探测镜像（不进 compose，只用来回答「这块板子能不能用 RK3588 硬件解 H.265、编 H.264」）。
# 在 Orange Pi 上构建：  docker build -f docker/ffmpeg-rk-probe.Dockerfile -t h2z-ffmpeg-rk-probe docker
# 构建约 20～30 分钟（编译 MPP、RGA、ffmpeg-rockchip）。构建最后一步会自检解码器 / 编码器 / 滤镜在不在，缺一个就失败。
# 通过后，同样的编译步骤会成为正式的 zlm-rk3588.Dockerfile 的 builder 阶段。
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git build-essential cmake meson ninja-build pkg-config nasm yasm \
      libdrm-dev libx264-dev procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
# Rockchip MPP（硬件编解码）：nyanmisaka 的 jellyfin-mpp 分支，和 ffmpeg-rockchip 配套
RUN git clone --depth=1 -b jellyfin-mpp https://github.com/nyanmisaka/mpp.git rkmpp \
 && cmake -S rkmpp -B rkmpp/build -DCMAKE_INSTALL_PREFIX=/usr -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON -DBUILD_TEST=OFF \
 && cmake --build rkmpp/build -j"$(nproc)" && cmake --install rkmpp/build
# Rockchip RGA（硬件缩放 / 格式转换）
RUN git clone --depth=1 -b jellyfin-rga https://github.com/nyanmisaka/rk-mirrors.git rkrga \
 && meson setup rkrga/build rkrga --prefix=/usr --libdir=lib --buildtype=release --default-library=shared \
      -Dcpp_args=-fpermissive -Dlibdrm=false -Dlibrga_demo=false \
 && ninja -C rkrga/build install
# ffmpeg-rockchip（带 hevc_rkmpp / h264_rkmpp / scale_rkrga）；libx264 只留给对照测试，正式转码不用
RUN git clone --depth=1 https://github.com/nyanmisaka/ffmpeg-rockchip.git ffmpeg \
 && cd ffmpeg \
 && ./configure --prefix=/usr --enable-gpl --enable-version3 --enable-libdrm --enable-rkmpp --enable-rkrga --enable-libx264 \
      --disable-doc --disable-debug --disable-ffplay \
 && make -j"$(nproc)" && make install && ldconfig

# 自检：缺任何一个就让构建失败
RUN ffmpeg -hide_banner -decoders 2>/dev/null | grep -q hevc_rkmpp \
 && ffmpeg -hide_banner -decoders 2>/dev/null | grep -q h264_rkmpp \
 && ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_rkmpp \
 && ffmpeg -hide_banner -filters 2>/dev/null | grep -q scale_rkrga \
 && echo "rkmpp / rkrga OK"
ENTRYPOINT []
CMD ["ffmpeg", "-version"]
