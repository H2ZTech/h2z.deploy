# h2z.deploy

H2Z 安防部署文件（公开镜像，由 h2z.security 自动同步，请勿在这里直接改）。

在一台全新的 Debian / Ubuntu（x86_64 或 arm64）上，一条命令装完：

```bash
curl -fsSL https://raw.githubusercontent.com/H2ZTech/h2z.deploy/main/install.sh | sudo sh
```

先只看会做什么：`... | sudo sh -s -- --dry-run`。详细说明见 docs/DEPLOY-B-LINE.md。
镜像全部来自 GHCR（ghcr.io/h2ztech/，公开，免登录）。
