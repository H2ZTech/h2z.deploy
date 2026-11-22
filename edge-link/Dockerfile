# edge-link：录像机上的 iroh 边缘代理（HTTP over iroh）。
# 构建上下文 = edge-link/ 目录：docker build -t h2z-edge-link edge-link
FROM rust:1-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -u 10001 -m -d /data h2z && install -d -o 10001 -g 10001 -m 0700 /data
COPY --from=build /src/target/release/edge-link /usr/local/bin/edge-link
USER 10001
WORKDIR /data
ENTRYPOINT ["/usr/local/bin/edge-link"]
CMD ["edge", "--upstream", "http://web:80", "--key-file", "/data/edge.key"]
