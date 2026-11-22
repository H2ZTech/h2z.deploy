# Orange Pi 5 Max 部署操作手册

适用于 Orange Pi 5 Max、Armbian Debian 13 Minimal、已通过 SSH 登录的情况。命令在 Orange Pi 的 SSH 终端执行，除特别说明外不需要 Windows PowerShell。

## 1. 先确认系统和 SSD

先运行只读检查：

```bash
uname -m
cat /etc/os-release
free -h
lsblk -o NAME,SIZE,MODEL,FSTYPE,MOUNTPOINTS
findmnt /
df -hT /
```

`uname -m` 应显示 `aarch64`。确认 `/` 的来源确实在 USB SSD/NVMe，而不是 TF 卡；同时确认容量和型号与刚才烧录的 SSD 相符。**若根分区不是 SSD，先停在这里**，不要运行 Compose；否则数据库、镜像和运行数据可能大量写入 TF 卡。把 `findmnt /` 和 `lsblk` 输出发回来，再确定如何迁移/挂载 Docker 数据目录。不要为了部署执行格式化或擦盘命令。

## 2. 安装基础工具并取回部署项目

```bash
sudo apt-get update
sudo apt-get install -y git ca-certificates curl jq python3 python3-venv python3-pip nodejs npm
node --version
npm --version
python3 --version
git --version
```

这里安装 Debian 仓库提供的 Node.js，供运行仓库维护脚本使用；IOC、AI Server、Node-RED 自身仍运行在容器中。Python 是板上诊断/维护工具，Python 推理容器另有自己的依赖环境。

无线网卡工具 `iw`（用于确认板载 WiFi 是否支持热点 / AP 模式，后续维护热点会用到）：

```bash
sudo apt-get install -y iw
sudo iw list | sed -n '/Supported interface modes/,/Band 1/p' | head -12
sudo iw dev
```

`iw`、`nft`、`hostapd` 等工具安装在 `/usr/sbin`，普通用户的 PATH 里通常没有这个目录，所以要用 `sudo` 执行；`command -v iw` 查不到不代表没装。Armbian 镜像可能已预装 `iw`，此时 apt 会提示 `already the newest version`，属正常。

### 推荐：GitHub 仓库只读 Deploy key

在 Orange Pi 上为这个仓库生成专用 SSH key：

```bash
cd ~
mkdir -p ~/.ssh
chmod 700 ~/.ssh
ssh-keygen -t ed25519 -C "orangepi-h2z-security" -f ~/.ssh/h2z_security_deploy
```

如果设备要无人值守启动，在 passphrase 提示处按 Enter 留空；私钥只留在 Orange Pi，**不要复制、发送或上传私钥文件**。显示公钥：

```bash
cat ~/.ssh/h2z_security_deploy.pub
```

复制完整的一行公钥，到 GitHub 仓库 `Settings → Deploy keys → Add deploy key`：

1. Title 填 `Orange Pi 5 Max`。
2. Key 粘贴 `.pub` 文件显示的一整行。
3. 不勾选 `Allow write access`，保持只读。
4. 添加后回到 Orange Pi 验证 SSH：

```bash
ssh -i ~/.ssh/h2z_security_deploy -o IdentitiesOnly=yes -T git@github.com
```

首次连接 GitHub 时，SSH 会询问是否信任主机指纹。继续前应将提示的指纹与 [GitHub 官方 SSH 主机密钥页面](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints)核对；确认后输入 `yes`。GitHub 的 `-T` 验证成功时会说明已认证，但不提供 shell。

用该 key 克隆私有仓库：

```bash
GIT_SSH_COMMAND='ssh -i ~/.ssh/h2z_security_deploy -o IdentitiesOnly=yes' \
  git clone --branch main --single-branch git@github.com:H2ZTech/h2z.security.git ~/h2z.security
cd ~/h2z.security
```

如果不使用 Deploy key，也可通过 HTTPS + GitHub Personal Access Token（PAT）认证。创建仅有该仓库读取权限的 token，然后运行：

```bash
git clone --branch main --single-branch https://github.com/H2ZTech/h2z.security.git ~/h2z.security
```

在 `Username` 提示输入 GitHub 用户名，在 `Password` 提示处粘贴 PAT（终端不会显示输入内容），按 Enter。

不要把 PAT 拼进克隆 URL、命令参数、脚本、聊天或文档，也不要误把 GitHub 账号密码当 PAT。若 Git 报认证失败，检查 token 是否有目标私有仓库的读取权限、是否过期，以及组织是否要求 SSO 授权。也可以预先配置 SSH key 后改用 SSH clone 地址。

## 3. 安装 Docker Engine 和 Compose 插件

仓库脚本使用 Docker 官方 Debian apt 仓库，并安装 Engine、Buildx、Compose 插件及 SSH 服务：

```bash
cd ~/h2z.security
sudo sh scripts/install-docker.sh
```

安装完成后退出当前 SSH，再重新登录，使 `docker` 用户组权限生效：

```bash
exit
```

重新 SSH 登录后检查：

```bash
docker version
docker compose version
docker info --format '{{.Architecture}} {{.DockerRootDir}}'
df -hT "$(docker info --format '{{.DockerRootDir}}')"
docker run --rm hello-world
```

架构应为 `aarch64`/`arm64`，Docker Root Dir 应落在 SSD 上。加入 `docker` 用户组等同于授予该账号较高的主机管理权限，只给可信运维账号使用。Compose 插件应为 2.24 或更新版本，以支持本项目 Compose 配置。

安装方式参考 [Docker Debian 官方安装说明](https://docs.docker.com/engine/install/debian/)及[官方 Compose 插件说明](https://docs.docker.com/compose/install/linux/)。

## 4. 镜像仓库

本项目镜像全部在 GHCR（`ghcr.io/h2ztech/`，公开），拉取不需要登录，也不需要任何令牌。

## 5. 初始化部署配置

```bash
cd ~/h2z.security
git switch main
git pull --ff-only origin main
sh scripts/init.sh
grep -E '^(AI_IMAGE|NODERED_IMAGE)=' .env
```

`init.sh` 用临时 Node 容器完成初始化及 root 权限修复；已有密码和令牌会保留，并会将 AI_IMAGE / NODERED_IMAGE 更新到本项目发布的 旧仓库 多架构标签。生成的密码、令牌只保存在板上，不要粘贴到聊天或提交 Git。每次拉取部署仓库新版本后可安全重跑该脚本，它不会重置已生成凭据。以已加入 docker 组的日常 SSH 用户运行，不要在外层加 sudo；Docker 容器内的权限步骤会将 `.env` 和私密配置 owner 设回该日常用户，同时将 secrets 文件设为容器组 GID 20001 可读。

若只运行 `node scripts/init.mjs`，它能更新 `.env`，但不能变更既有 secrets 文件的 root/group 权限；完成首次部署初始化时使用 `sh scripts/init.sh`。若已初始化，只需修复 secrets 目录权限，使用：

```bash
sudo sh scripts/fix-secret-permissions.sh
```

此脚本只变更 `secrets/` 和 AI Server/API 共用的 `runtime/ai-shared/` 的 owner/group/mode，不读取或改写文件内容。容器通过补充组 GID 20001 读取私密文件并写入共享任务目录。

编辑 `.env`：

```bash
nano .env
```

至少确认以下配置：

- `IOC_NETWORK_SCOPE`：保持留空。`host-network` 服务会读取 Orange Pi 当前网线和 DHCP 所在的网段，作为探索的默认范围，每次创建任务时现读，执行前仍需人工审批。只有想对所有任务强制指定网段时才填写。
- `HTTP_BIND=127.0.0.1`：IOC 前端（8096）的默认绑定。设为 `0.0.0.0` 后，客户局域网可直接访问 IOC。
- `AI_WEB_BIND=127.0.0.1`：DSH 管理页（3096）默认只绑定板本机。需要维护人员从客户 LAN 直接打开时，按第 8 节设为 `0.0.0.0` 并配置 `DSH_LAN_NETWORKS`；登录使用 `secrets/dsh-web/password`。
- `POSTGRES_IMAGE=postgres:16-alpine`
- `EMQX_IMAGE=emqx/emqx:5.8.8`
- `ZLM_IMAGE=zlmediakit/zlmediakit:master`

初始化脚本会自动将这三项更新为官方多架构镜像。2026-10-10 已核实三个标签均包含 `linux/arm64`。生产长期使用时应固定已验证的镜像 digest。

## 6. ARM64 镜像检查是启动全栈的前置条件

项目的 `compose.yaml` 是全套服务编排，包含 h2z.backend/IOC backend、前端、AI Server、定制 Node-RED、PostgreSQL、EMQX、ZLMediaKit 等。Compose 文件完整不代表这些镜像都能在 ARM64 上运行。

以下镜像必须确认 ARM64 后才能启动对应服务：

| `.env` 变量 | 启动前要求 |
|---|---|
| `BACKEND_IMAGE` | 当前 旧仓库 标签仅有 amd64 manifest；需要 h2z.backend 发布多架构 / linux/arm64 镜像 |
| `AI_IMAGE` | `ghcr.io/h2ztech/h2z-ai-server:latest`，多架构镜像，已核实含 linux/arm64 |
| `NODERED_IMAGE` | `ghcr.io/h2ztech/h2z-nodered:latest`，定制版 Node-RED，多架构镜像，已核实含 linux/arm64 |
| `POSTGRES_IMAGE` | `postgres:16-alpine`，官方多架构镜像，已核实含 linux/arm64 |
| `EMQX_IMAGE` | `emqx/emqx:5.8.8`，官方多架构镜像，已核实含 linux/arm64 |
| `ZLM_IMAGE` | `zlmediakit/zlmediakit:master`，官方多架构镜像，已核实含 linux/arm64 |

截至 2026-10-10，backend 的 旧仓库 标签仍只有 amd64 manifest；其它表列镜像均已找到 ARM64 发布版。不要通过 `platform: linux/amd64` 掩盖架构问题。需要完整启动 backend 时，应等 h2z.backend 提供 ARM64 镜像。

等三项镜像就绪后，在项目目录运行检查：

```bash
node scripts/check-images.mjs arm64
```

脚本对 `.env` 中每个远端镜像检查 registry manifest；每项都显示 `PASS` 才表示远端发布了 linux/arm64 manifest。AI Server 与定制 Node-RED 已由 h2z.ai.server Actions 发布到上表地址（OCI index digest 分别为 `sha256:22f687b6873c276957d65514efc40855ff7e2bed4138bc0fc310f0af26dcc2e5`、`sha256:a22935431266b67edd9ea86d2154f829421e8d1314336ed73e35583b209be65c`）。Postgres、EMQX、ZLMediaKit 官方镜像标签也已核实包含 ARM64。backend 仍由 h2z.backend 仓库发布；当前 旧仓库 标签无 ARM64 manifest。若镜像只通过 `docker load` 导入本机，则检查器无法验证远端 manifest；需由发布方给出可信的 ARM64 构建结果，并单独检查本地镜像：

```bash
docker image inspect <镜像标签> --format '{{.Os}}/{{.Architecture}}'
```

结果应为 `linux/arm64`。Windows 上保存的 amd64 镜像不会因拷贝到 Orange Pi 而变成 ARM64。

## 7. 校验 Compose 并启动

仅在上面所有必需镜像已发布/导入并验证为 ARM64 后继续：

```bash
cd ~/h2z.security
docker compose config --quiet
h2z@orangepi5-max:~/h2z.security$ docker compose up -d --wait --wait-timeout 180
[+] up 24/24
 ✔ Volume h2z-security_nodered-data          Created                                                                                                                                                                          0.0s
 ✔ Volume h2z-security_ioc-data              Created                                                                                                                                                                          0.0s
 ✔ Volume h2z-security_registry              Created                                                                                                                                                                          0.0s
 ✔ Volume h2z-security_pg-data               Created                                                                                                                                                                          0.0s
 ✔ Volume h2z-security_recordings            Created                                                                                                                                                                          0.0s
 ✔ Volume h2z-security_emqx-data             Created                                                                                                                                                                          0.0s
 ✔ Volume h2z-security_dsh-home              Created                                                                                                                                                                          0.0s
 ✔ Volume h2z-security_backend-data          Created                                                                                                                                                                          0.0s
 ✔ Network h2z-security_security             Created                                                                                                                                                                          0.2s
 ✔ Volume h2z-security_backend-uploads       Created                                                                                                                                                                          0.0s
 ✔ Container h2z-security-ioc-storage-init-1 Started                                                                                                                                                                          2.2s
 ✔ Container h2z-security-emqx-1             Started                                                                                                                                                                          1.4s
 ✔ Container h2z-security-postgres-1         Started                                                                                                                                                                          1.7s
 ✔ Container h2z-security-nodered-1          Healthy                                                                                                                                                                         11.5s
 ✔ Container h2z-security-zlm-1              Started                                                                                                                                                                          2.6s
 ! zlm                                       The requested image's platform (linux/amd64) does not match the detected host platform (linux/arm64/v8) and no specific platform was requested                                   0.0s
 ! emqx                                      The requested image's platform (linux/amd64) does not match the detected host platform (linux/arm64/v8) and no specific platform was requested                                   0.0s
 ! postgres                                  The requested image's platform (linux/amd64) does not match the detected host platform (linux/arm64/v8) and no specific platform was requested                                   0.0s
 ✘ Container h2z-security-nodered-bridge-1   Error dependency nodered-bridge failed to start                                                                                                                                 12.3s
 ✔ Container h2z-security-ai-server-1        Created                                                                                                                                                                          0.1s
 ✔ Container h2z-security-h2z-api-1          Created                                                                                                                                                                          0.1s
 ✔ Container h2z-security-backend-1          Created                                                                                                                                                                          0.1s
 ! backend                                   The requested image's platform (linux/amd64) does not match the detected host platform (linux/arm64/v8) and no specific platform was requested                                   0.0s
 ✔ Container h2z-security-web-1              Created                                                                                                                                                                          0.1s
dependency failed to start: container h2z-security-nodered-bridge-1 is unhealthy

docker compose ps
node scripts/smoke.mjs
```

如果某个镜像需要私有仓库认证，先用 `docker login <registry>` 登录，再执行 pull；不要把访问令牌写入 shell 命令参数或 `.env`。AI 和 Node-RED 标签确认后，可以先单独验证这两项：

```bash
docker pull "$AI_IMAGE"
docker image inspect "$AI_IMAGE" --format '{{.Os}}/{{.Architecture}}'
docker pull "$NODERED_IMAGE"
docker image inspect "$NODERED_IMAGE" --format '{{.Os}}/{{.Architecture}}'
```

Orange Pi 应显示 `linux/arm64`。待 `.env` 中所有服务镜像均已验证 ARM64 后，再运行 `docker compose pull` 和 `docker compose up -d --wait`。基础栈启动后，如要检查完整 h2z.backend 算法接口，再运行 `node scripts/smoke.mjs --full`；上游镜像缺少该接口时检查会失败，不能用容器“running”代替功能验收。

Orange Pi 首次 `up` 的已知现场结果：nodered 容器 healthy；Postgres、EMQX、ZLMediaKit 和 backend 被解析成 `linux/amd64`，不应在 ARM64 板上继续使用；`nodered-bridge` unhealthy，AI Server 因依赖 bridge 没起来。bridge 是自定义 AI Server 容器里启动的 Node-RED 适配 HTTP 服务，供 AI Server 的 `H2Z_NODERED_BRIDGE_URL` 调用，不是无用容器。定位 bridge 故障时收集 `docker compose logs --tail=100 nodered-bridge` 和 `docker compose ps -a`；先修复所有非 ARM64 镜像，再验收完整服务栈。

首次真实探索前，在 DSH/Models 页面配置模型服务商凭据，并执行一个人工批准的 IOC 网络探索任务验收模型调用。API 探活本身不能证明模型调用完成。探索问题排查见 [探索失败排查](EXPLORATION-TROUBLESHOOTING.md)。

首次创建空白仓库项目（如果部署需要）：

```bash
node scripts/seed-project.mjs
```

运行期间检查日志/健康状态：

```bash
docker compose ps
docker compose logs --tail=100
```

`scripts/up.sh` 会拉取前端并执行 `docker compose up --build`。已全部确认 ARM64 并希望使用该快捷脚本时才运行：

```bash
sh scripts/up.sh
```

## 8. 网络探索和页面访问

探索的默认网段由 `host-network` 服务自动取自 Orange Pi 当前所在的网络（看插的网线和 DHCP 分到的地址），现场不需要配置。审批页会显示这个网段，由现场人员确认后才会主动探测；其他 VLAN 只能通过 ACTION_REQUIRED 提出，由人工授权后再探测。给 Orange Pi 分配 DHCP 保留地址会便于本地维护；通过 Tailscale 远程管理不依赖知道客户 DHCP 地址。跨 VLAN 探测还要求交换机/路由 ACL 允许从 Orange Pi 所在 VLAN 到目标 VLAN 的相应流量，并具备合适的二层发现条件。

Orange Pi 可以使用 DHCP，不需要为 DSH 固定客户网 IP。启用 mDNS 后，可在同一局域网通过主机名找到设备；当前主机名为 `orangepi5-max`：

```bash
sudo apt update
sudo apt install -y avahi-daemon
sudo systemctl enable --now avahi-daemon
hostnamectl --static
```

让 IOC（8096）和 DSH（3096）可供客户 LAN 直接访问时，在 `.env` 打开绑定。DSH 网关默认接受任何私网 IP 地址（10/8、172.16/12、192.168/16），无论客户是哪个网段、DHCP 怎么变都不用配置；`DSH_TRUSTED_NAMES` 可选，用来填 mDNS 名称：

```bash
sed -i '/^HTTP_BIND=/d;/^AI_WEB_BIND=/d;/^H2Z_DSH_TRUSTED_HOST=/d;/^DSH_LAN_NETWORKS=/d;/^DSH_TRUSTED_NAMES=/d' .env
printf 'HTTP_BIND=0.0.0.0\nAI_WEB_BIND=0.0.0.0\nDSH_TRUSTED_NAMES=orangepi5-max.local\n' >> .env
sh scripts/init.sh                    # 补默认口令和沙箱设置，已有令牌和口令不变
docker compose config --quiet
docker compose pull
docker compose up -d
docker compose logs --tail=40 ai-server | grep -E "dsh-lan-gateway|sandbox mode"
docker compose logs --tail=5 host-network
```

`ai-server` 日志应显示 `LAN networks [10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16]`、`password sign-in enabled at /__h2z/login` 和 `DSH sandbox mode ...`。`host-network` 日志显示当前网段，例如 `host-network: 10.0.0.0/24 (end0=10.0.0.236)`。日志不会打印口令。

### 网络探索：网段与沙箱（自动处理）

1. 网段：backend 运行在 Docker bridge 网络里，自己只能看到 `172.x` 的容器网卡。`host-network` 服务用宿主机网络读取 Orange Pi 的真实网卡，每 10 秒把当前网段写到 `host-network.json`；backend 每次创建探索任务时读取它（`IOC_HOST_NETWORK_FILE`）。换网线、换客户、DHCP 变化都会自动跟上。如果文件超过 5 分钟没更新、损坏或者网段为空，任务就不带网段，只做被动观测，绝不会拿容器网段代替。显式设置的 `IOC_NETWORK_SCOPE` 仍然优先，所以现场应保持留空。
2. DSH 在 Linux 上靠 Landlock 把命令的写入限制在任务工作区。Orange Pi 的 Rockchip vendor 内核（`6.1.x-vendor-rk35xx`）没有编译 Landlock，可以这样检查：`zcat /proc/config.gz | grep LANDLOCK` 输出 `is not set`，`/sys/kernel/security/lsm` 里也没有 `landlock`。这种情况下 DSH 会拒绝执行所有命令，报 `no sandbox backend is usable`。`sh scripts/init.sh` 会检测宿主机的 LSM 列表：没有 Landlock 且 `.env` 里没有手动设置时，自动写入 `DSH_SANDBOX_MODE=danger-full-access`，相当于显式关闭 DSH 文件沙箱。关闭后，命令仍受容器本身的隔离（非 root、无特权、默认 seccomp/AppArmor），但能写共享任务目录和 dsh-home，DSH 也不再在执行命令前询问。网络探测范围不靠这个沙箱约束，仍由审批关口和授权网段控制。内核有 Landlock 的环境保持留空。

### DSH 登录与 DHCP 地址变化

1. 默认运维口令是 `h2z2026`，由 `init.sh` 写入 `secrets/dsh-web/password`，新板子可以直接登录。DSH 能执行命令，交付客户现场后建议改掉：`printf '%s\n' '<新口令>' > secrets/dsh-web/password`（至少 6 个字符），下次登录生效，不需要重启。重跑 `init.sh` 不会覆盖已有口令。
2. 浏览器打开 `http://<Orange Pi 当前 IP>:3096/` 或 `http://orangepi5-max.local:3096/`。未登录时会跳到 `/__h2z/login`。输入口令后，网关在容器内用 DSH 本次启动的一次性 token 完成握手，并把 DSH 签发的 Cookie 交给浏览器。这个 Cookie 是 HttpOnly、SameSite=Strict，有效期 30 天；签名密钥保存在 `dsh-home` 卷里，容器重启后仍然有效。
3. DHCP 换了 IP 后，浏览器不会把旧地址的 Cookie 发给新地址，所以要在新地址再输一次口令。不需要改 `.env`，不需要重启容器，也不需要看日志。如果用 mDNS 名称访问，Cookie 绑定在名称上，不受 IP 变化影响。
4. 同一地址连续输错 5 次，会锁定 15 分钟。网关只接受私网 IP 地址（`DSH_LAN_NETWORKS`，默认 10/8、172.16/12、192.168/16）、回环地址和 `DSH_TRUSTED_NAMES`；其他 Host（包括 DNS rebinding 用的域名）、跨站请求、Origin 不匹配的请求都直接返回 403，不会转给 DSH。
5. 日志里的 token 地址仍可作为备用：把 `127.0.0.1` 换成当前访问地址即可。旧容器打出的 token 失效后，会跳回登录页。
6. 通过网关登录的浏览器可以读取和保存模型等设置（网关给页面加了 `ownsHost` 标记，和 DSH 桌面端用的机制相同）。设置写入的权限仍由 DSH 的 Cookie 认证控制。

3096 端口能被谁访问，取决于 `AI_WEB_BIND` 和板子、现场的防火墙；网关不限制客户端来源。DSH 能执行 Agent 命令，口令要按管理员口令对待。只想让部分网段访问时，在 Docker 的 `DOCKER-USER` 链里限制 3096 的来源（ufw 规则对 Docker 发布的端口不生效）。

不开放 LAN 时，保持 `AI_WEB_BIND=127.0.0.1`，仍可用 SSH 隧道访问：

```bash
ssh -N -L 3096:127.0.0.1:3096 h2z@orangepi5-max.local
```

然后在笔记本打开 `http://127.0.0.1:3096/`，用同一口令登录。

若页面无法连接，检查 Orange Pi SSH 端口 22 是否允许笔记本所在网段访问。IOC 的 LAN 端口只开放给所需客户网段；不要开放 MQTT、Node-RED、数据库或其他管理端口。

### 8.x 二层邻居扫描：补 MAC、看不回 ping 的设备

探索跑在 Docker NAT 容器里，看不到现场二层，也没有发 ARP 的权限：只能 TCP 试连，不回 ping 或端口被过滤的设备会漏，MAC 一个也读不到（摄像头登记、认领点位都要 MAC）。所以由板子的 host-agent（host 网络）来扫：

- 对网段里每个地址发一个 UDP 包，让内核做 ARP，再读邻居表得到 **IP↔MAC**。不需要额外特权，限速约 20 个/秒，只读；`/23` 约 30 秒。
- **只扫探索任务已批准的网段**：在审批页批准 `network-probe` 后后台自动触发；host-agent 自己再拦一道：只扫板子直连的网段、不扫维护热点、最大 `/22`，不满足的写进 `skipped` 并说明原因（例如板子没有直连 VLAN 1000，ARP 到不了）。
- 结果存在后端数据目录 `l2-neighbors/<项目>.json`。**导入探索结果时按 IP 给没有 MAC 的节点补 MAC**（节点 `attributes.macFrom=host-arp` 留痕；设备自己报的 MAC 不改），并在探索提示里写一句：二层看到多少台、其中多少台不在探索清单里。
- 拓扑页「补全 MAC（二层扫描）」按钮：对已批准过主动探测的任务现在再扫一次，把 MAC 补进现有清单和设备库，**不用重新探索**。

局限：邻居表里可能带刚下线的设备（内核还保留着条目）；挂在录像机私有 PoE 口后面的摄像头在 VLAN 60 上看不到；VLAN 1000 要板子直连才能扫（否则 `not-on-link`）。AI 本身拿不到这份表：它只在导入时由后端合并。

更新后 `docker compose up -d` 会重建 host-agent（`H2Z_AGENT_FEATURES` 变了），脚本才会生效。

## 9. 设备网络：网口 IP、维护热点、远程接入（Tailscale）

交付到客户现场时，网口要改成客户指定的 IP，之后还要能远程 SSH 更新、远程打开 8096（IOC）和 3096（DSH）。这些都在 **IOC 后台 → 左下角点 admin → 「设备网络」** 里图形化完成，进入时输入**设备管理口令**（默认 `h2z2026`，文件 `secrets/ioc/device-password`，交付后修改）。

### 9.1 一次性初始化（每块板子只做一次）

```bash
cd ~/h2z.security
git pull
sudo sh host/setup-host.sh               # 补齐宿主层：docker、cloudflared、网口 / 热点 / 防火墙、看门狗（可重复跑，做过的跳过）
docker compose pull
docker compose up -d --wait
```

`host/setup-host.sh` 把 docker 之外的东西一次补齐，和 H2Z OS 安装盘做的事对齐（`sh host/setup-host.sh --check` 只看缺什么，不改系统）。其中网口那一步带保护检查：只有 systemd-networkd + netplan、DHCP 取地址、没有静态地址时才接管，否则跳过并在 `/etc/h2z/setup-host.manual` 记下原因，不会把远程机器搞断网；确认安全后用 `--network=force` 补做。`scripts/update.sh` 在 `git pull` 后发现有待补项（比如看门狗脚本有更新）也会补。H2Z OS 镜像里这些都已装好，不用跑。

之后的日常更新只需要 `git pull` + `docker compose pull` + `docker compose up -d`：

- 新版本新增的密钥文件由 compose 里的 `secrets-init` 在启动前自动补齐（已有的不变），不需要再跑 `scripts/init.sh`（它只用于全新安装时生成 `.env`）。
- `host/` 下的热点 / 防火墙 / 服务文件有变化时，host-agent 会发现（启动时和每 10 分钟比对 `host/` 与 `/etc/h2z/setup.sha`），自动执行 `setup-host-network.sh --auto`，只重启有变化的部分：开着的热点保持开着，关着的保持关着。

`setup-host-network.sh` 会：

- 安装 `hostapd`、`nftables`、`iw`、`rfkill`（`host/setup-host.sh` 在网口保护检查通过后调用这个脚本；板子沿用 Armbian 的 systemd-networkd + netplan，不换网络栈）；
- 写 `/etc/h2z/host.env`：网口（如 `enP3p49s0`）、WiFi（`wlan0`）、热点名称 `H2Z-<WiFi MAC 后 4 位>`、热点口令（默认 `h2z@2026`，WPA2 要求至少 8 位）、热点地址 `192.168.234.1/24`、开机开放时长 `AP_WINDOW_MIN`（默认 120 分钟）。已有的值不会被覆盖，要改口令就改这个文件后重跑脚本；
- 把网口交给 `/etc/netplan/20-h2z-lan.yaml`（初始仍是 DHCP，与原来一样），Armbian 原来的 netplan 文件移到 `/etc/h2z/netplan-orig/`；
- 以 `systemctl link` 方式启用仓库 `host/systemd/` 下的服务：热点、开机 2 小时后关热点的定时器、热点防火墙。热点和防火墙是宿主机服务，不依赖 Docker。

### 9.2 维护热点

- **每次开机自动开启 2 小时**，到时自动关闭。后台可以「延长为 2 小时」「缩短为 10 分钟」或「立即关闭」；网络配置完成后建议缩短或关闭。关闭只到下次开机：网口改坏了、远程也连不上时，**给板子断电重启**，热点会重新出现（现场的恢复通道）。
- 笔记本连上 `H2Z-xxxx` 后自动获得 `192.168.234.x` 地址，访问 `http://192.168.234.1:8096/ioc/admin` 或 `ssh h2z@192.168.234.1`。
- 隔离（`host/templates/h2z-maint.nft.in`）：热点上只放行 SSH、8096、3096；热点和客户网口之间不转发；容器不能主动连进热点网段。
- 网络探索永远不会扫描热点：`host-network` 发布网段时排除 `192.168.234.0/24`（`MAINT_AP_NETWORK`），后端对请求里带的网段也会剔除，再加上上面的防火墙。

### 9.3 修改网口 IP

后台「设备网络 → 有线网口」选「静态地址」，填 IP、子网掩码、网关、DNS，点「应用」。

- 应用后有 **3 分钟确认期**：在后台点「确认保留」才算生效；3 分钟内没确认（例如新地址填错、页面打不开），host-agent 自动恢复原设置。确认前也可以点「恢复原设置」。
- 推荐在**维护热点**上操作：改网口不会断开热点连接，确认最方便。通过网口操作时，地址一变当前页面就会断开，按页面提示用新地址打开后台确认。
- 网口设置保存在 `/etc/netplan/20-h2z-lan.yaml`，由 host-agent 写入，不要手工编辑。

### 9.4 远程接入（Tailscale）

Tailscale 已并入 `compose.yaml`，随整套服务启动（不再需要 `compose.tailscale.yaml`）。默认配置随仓库带上：节点名用板子主机名、不改板子 DNS（`--accept-dns=false`）、不广播客户网段路由、tailnet 地址上的 8096 / 3096 自动可用：端口绑在 `0.0.0.0` 时 tailnet 直接访问；只绑 `127.0.0.1` 时才用 Tailscale Serve 转到本机（`config/tailscale-entry.sh` 按 `HTTP_BIND` / `AI_WEB_BIND` 自动决定；两者同时用会抢端口，web 起不来）。只需要出方向联网，客户不用开任何入口端口。

登录（二选一，在后台「设备网络 → 远程接入」）：

1. **授权密钥（推荐）**：在 Tailscale 管理后台 *Settings → Keys* 生成一次性 auth key，填入后点「用密钥登录」。
2. **登录链接**：点「获取登录链接」，在浏览器里用你的 Tailscale 账号批准。

登录后在同一 tailnet 的电脑上：

```bash
ssh h2z@<Tailscale 地址>                     # 远程更新：git pull、docker compose pull/up
http://<Tailscale 地址>:8096/ioc/admin
http://<Tailscale 地址>:3096/                 # DSH 网关已信任 100.64.0.0/10
```

**确认远程接入已生效：**

1. 后台「远程接入」显示 **已连接**，并有 `100.x.x.x` 地址；
2. Tailscale 管理后台 *Machines* 里这台设备（板子主机名）显示 **Connected**；
3. 在一台**不在客户现场网络**的电脑上（例如连手机热点的笔记本，已登录同一 Tailscale 账号）执行 `tailscale ping <板子主机名>`，再 `ssh h2z@100.x.x.x`、打开 `http://100.x.x.x:8096/ioc/admin`。都通才说明是走 Tailscale 通的，而不是走现场局域网；
4. 板上自查：`docker compose exec tailscale tailscale status`、`docker compose exec tailscale tailscale serve status`。

也可以把一次性 key 写进 `.env` 的 `TS_AUTHKEY`（文件保持 0600）后 `docker compose up -d tailscale`。在 Tailscale ACL 里只允许你自己的运维账号 / 设备访问这台节点。国内网络下 Tailscale 官方中继可能较慢；需要时再考虑自建 Headscale / DERP。

### 9.5 排查

```bash
systemctl status h2z-maint-ap h2z-firewall h2z-maint-ap-off.timer --no-pager
sudo nft list table inet h2z_maint
cat /etc/netplan/20-h2z-lan.yaml; networkctl status enP3p49s0 --no-pager
docker compose logs --tail=50 host-agent tailscale
```

## 10. 可选的视频识别

先完成基本服务和网络探索验收，再按 [YOLO 指南](YOLO.md)准备 RK3588 驱动、匹配的推理镜像和模型文件。检查硬件设备节点后再启用：

```bash
docker compose -f compose.yaml -f compose.rk3588.yaml --profile vision config --quiet
docker compose -f compose.yaml -f compose.rk3588.yaml --profile vision up -d --wait yolo
```

先测单路再测四路，记录实际 FPS、P95 延迟、CPU/NPU 占用、内存和温度。板级驱动、真实摄像头和四路热稳定性尚未验收。

## 11. 后续更新

```bash
cd ~/h2z.security
git switch main
sh scripts/update.sh          # 查空间 → 拉代码 → 拉镜像 → 再查空间 → 启动 → 清我们自己的旧镜像（留上一版）
```

`scripts/update.sh`（2026-11-02 起）代替手敲的 `git pull` + `docker compose pull` + `up`：空闲少于 10 GB（`MIN_FREE_GB`）就停下、列出空间被谁占了，拉完镜像再查一次，不够就不启动新版本（旧版本照跑）；`--check` 只查空间，`--prune-old` 先清我们自己的旧镜像（只清我们镜像仓库下、没有容器在用的；公共镜像和别人的容器不碰）。更新期间自动暂停看门狗。

### 11.0 板子看门狗（2026-11-02 起，每块板子装一次）

```bash
sudo sh host/install-watchdog.sh     # 可以重复跑；新板子首次启动时自动装
systemctl status h2z-watchdog.timer
cat /var/lib/h2z/watchdog/status.json
journalctl -t h2z-watchdog --since today
```

主机上 systemd 每分钟跑一次，不依赖 Docker。自动动作只有三种、都限频：外网通但 Tailscale 连续 5 分钟不在线 → 重启我们的 tailscale 容器（15 分钟最多一次）；网口通但连续 5 分钟没地址 / 网关不通 → 重启主机网络服务（30 分钟最多一次）；我们的长期运行容器退出 / 不健康 → `docker compose up -d`（只动本项目，10 分钟最多一次）。**不重启 Docker**（会连带邻居的容器），**不因为断网重启整机**（现场断网录像照常写本地）。系统本身死机由硬件看门狗处理（systemd `RuntimeWatchdogSec=60`；虚拟机没有硬件看门狗自动跳过，NAS 系统自己管、不改）。状态进告警中心：网口没信号 / 拿不到网络 / 连不上外网 / Tailscale 不在线 / Docker 没响应 / 服务没在运行 / 磁盘快满 / 自动恢复没做成 / 看门狗没在跑。维护时暂停：`echo $(( $(date +%s) + 3600 )) | sudo tee /var/lib/h2z/watchdog/pause`（1 小时后自动恢复）。

更新前先按 [OPERATIONS.md](OPERATIONS.md) 备份数据库、IOC 数据、令牌及 DSH 配置。更新镜像后再按本手册重新检查 ARM64 兼容和 Compose 配置；不要使用 `docker compose down -v`，它会删除数据卷。

### 11.1 DSH 升级到 0.2.0-rc.2（ai-server 镜像，2026-10-11）

新镜像里的 DSH 会把会话升级成新格式（旧版读不了新会话），升级前先备份 DSH home 卷，回退时连同备份一起回退：

```bash
cd ~/h2z.security
mkdir -p backup
. ./.env   # 取 AI_IMAGE
docker run --rm --user 0 --entrypoint tar -v h2z-security_dsh-home:/v:ro -v "$PWD/backup:/b" "$AI_IMAGE" \
  czf "/b/dsh-home-$(date +%Y%m%d-%H%M).tgz" -C /v .
ls -lh backup/

git switch main
git pull --ff-only origin main
docker compose pull ai-server
docker compose up -d
docker compose logs --tail=40 ai-server
```

日志里应能看到：`ai-server: …/profiles/web/cordis.patch.yml: removed 1 mcp-nodered item(s)`（老板子第一次启动时出现一次，之后不再出现），以及 `dsh web: http://127.0.0.1:3096/?token=…`。

验收：

```bash
docker compose exec ai-server dsh --version                     # 0.2.0-rc.2
docker compose exec ai-server sh -lc 'dsh --profile headless --patch "$DSH_HOME/ai-server.patch.yml" --dump-config 2>&1 >/dev/null | head'   # 无输出 = 无告警
docker compose exec ai-server sh -lc 'dsh --profile headless --patch "$DSH_HOME/ai-server.patch.yml" --dump-config | grep -c "id: mcp-nodered"'  # 1
```

然后浏览器用口令登录 DSH Web，确认 API Key 仍在（Models 页可见 DeepSeek 模型），再在 IOC 仓库项目里跑一次探索，看「DSH 过程」面板有命令和输出。

回退（仅在新版本不可用时）：把 `.env` 的 `AI_IMAGE` 改成上一版的 `sha-…` 标签，`docker compose stop ai-server`，用备份恢复卷后再启动：

```bash
docker run --rm --user 0 --entrypoint sh -v h2z-security_dsh-home:/v -v "$PWD/backup:/b:ro" "$AI_IMAGE" \
  -c 'find /v -mindepth 1 -delete && tar xzf /b/<备份文件名>.tgz -C /v'
docker compose up -d ai-server
```

## 12. 母版镜像与批量克隆（新板子 10 分钟出厂）

把一块调好的板子（系统、软件包、host 服务、代码、**已拉好的全部镜像**）做成母版镜像，新板子插卡开机自动写入 NVMe。脚本在 `host/image/`，首次开机在 `host/firstboot.sh`。

**原则**：采集不改动母版。镜像是母版的完整备份，**含本现场数据和密钥，只能内部保存**。写入新板时（`generalize-root.sh`）和新板首次开机时（`h2z-firstboot*.service`）才去掉板子身份和现场数据：

| 内容 | 新板子上 |
|---|---|
| machine-id、SSH 主机密钥 | 首次开机重新生成 |
| 主机名 | `h2z-<WiFi MAC 后 4 位>`，与热点 SSID `H2Z-XXXX` 后缀一致 |
| 热点 SSID | 按本板 MAC 重新生成（口令仍是 h2z@2026） |
| 网口 | 回到 DHCP |
| `.env` 里的随机口令、`secrets/`、`runtime/` | `scripts/init.sh` 重新生成；产品默认口令（管理员 admin / h2z2026，设备口令、DSH 口令同为 h2z2026；B 与 C 一致）不变，交付前仍要改 |
| Docker 卷：项目、网络规划资料、数据库、录像、Tailscale 登录、DSH 模型 API Key | 清空后由 `docker compose down -v` + `up` 重建：**Tailscale 到现场在后台重新登录，模型 Key 到现场填写** |
| 日志、命令历史、临时文件 | 清空 |
| 系统、软件包、代码、Docker 镜像、GitHub 只读 Deploy key、旧仓库 镜像仓库登录 | 保留（所有板子共用一套只读凭据，负责人 2026-10-16） |

### 12.1 准备维护 SD 卡（一次）

1. 64 GB 以上 microSD，写入与母版**同版本**的 Armbian（Orange Pi 5 Max），用 balenaEtcher / Rufus。
2. 插卡开机（SD 卡优先于 NVMe 启动），按 Armbian 首次登录提示设 root 口令、建用户（接显示器键盘，或网线 SSH `root` / `1234`）。
3. 安装工具：`sudo apt-get update && sudo apt-get install -y partclone zstd`

### 12.2 制作母版

```bash
# ① 母版板子从 NVMe 正常启动，先更新到要发布的版本
cd ~/h2z.security && git pull && docker compose pull && docker compose up -d   # 确认一切正常
sudo sh host/image/prepare.sh        # 检查镜像都在本地、停止服务（不删任何东西），然后关机

# ② 插维护 SD 卡开机（NVMe 不挂载），从母版盘上取脚本，采集
sudo mount -o ro /dev/nvme0n1p1 /mnt && cp -r /mnt/home/h2z/h2z.security/host/image ~/h2z-image && sudo umount /mnt
sudo sh ~/h2z-image/capture.sh       # → /h2z-image（只拷已用的块，zstd 压缩，含 SPI 启动程序），约 10–30 分钟

# ③ 把这张卡变成刷机卡
sudo sh ~/h2z-image/install-flasher.sh
sudo poweroff
```

**SD 卡写入出错时，改采集到 U 盘**（2026-10-16 实测：质量差的卡持续写入报 ext4 `failed to convert unwritten extents … error -30`，`capture.sh` 卡在 I/O 里 Ctrl+C 也停不下来，只能断电；NVMe 全程只读，不受影响）。②之后换成：

```bash
lsblk                                  # 确认 U 盘设备名（下面以 /dev/sda 为例，别选错，会清空）
sudo mkfs.ext4 -L h2zimg /dev/sda      # 整盘格式化，U 盘原有数据全部丢失
sudo mkdir -p /tmp/h2zimg && sudo mount /dev/sda /tmp/h2zimg
sudo sh ~/h2z-image/capture.sh --out /tmp/h2zimg/h2z-image
sudo sha256sum -c /tmp/h2zimg/h2z-image/SHA256SUMS   # 采集完成后再核对一遍
sudo umount /tmp/h2zimg
```

采集期间**不要**从 NVMe 启动母版（否则服务恢复，需重新 `prepare.sh`）。U 盘容量 ≥ 32 GB，最好用 USB SSD。

母版拔卡开机后会**自动恢复服务**（`prepare.sh` 留下的标记，`h2z-firstboot-stack` 执行 `docker compose up -d`），不用手动操作，现场数据和 Tailscale 都还在。

`prepare.sh` 之后如果又从 NVMe 启动过，服务会恢复运行，`capture.sh` 会拒绝采集：重新执行 `prepare.sh` 再采集。

### 12.3 克隆新板子

1. 新板子装好 NVMe，插刷机卡，上电。不用接显示器键盘。
2. 指示灯**心跳闪烁** = 等待 30 秒后开始写入（这 30 秒内断电即取消），全程约 10–15 分钟；**常亮并自动关机** = 完成；**快闪** = 出错，日志在卡上 `/h2z-image/flash.log`。
3. 拔卡，上电。首次开机自动完成：新身份 → 热点 `H2Z-XXXX` → 生成本机密钥 → 启动全部服务（约 2–5 分钟，日志 `/var/log/h2z-firstboot.log`）。之后和 §9 一样：连热点设网口、后台登录 Tailscale、DSH 填模型 Key。

刷机卡的保护：母版自己的盘（同一序列号）不会被写；已经写过这个镜像的板子忘了拔卡也不会再写一遍。目标盘比母版的已用空间还小会拒绝；比母版大则最后一个分区自动扩满。SPI 启动程序与母版不同时会写入母版的那一份（新板子必须有它才能从 NVMe 启动）。

也可以手动写入：`sudo sh /usr/local/lib/h2z-image/flash.sh`（输入 YES 确认）。

### 12.3.1 镜像放在哪里：SD 卡与 U 盘的分工

刷机**必须有一张 SD 卡**：全新板子的 SPI 里不一定有启动程序，上电只会从 SD 卡启动，不会从 U 盘启动。所以长期方案仍是**一张可靠的 SD 卡**（维护系统 + `/h2z-image` + 刷机服务），插卡上电自动刷机，不需要 U 盘。

| 阶段 | SD 卡 | U 盘 |
|---|---|---|
| 制作母版（现在，寄出母版前） | 当前这张卡只负责启动维护系统，不写入 | 存放采集出的镜像（母版完整备份） |
| 批量克隆（长期） | 刷机卡：维护系统 + 镜像 + 刷机服务，插卡即刷 | 不需要，留作备份 |
| 过渡（还没有可靠的卡） | 只负责启动 | 存放镜像，刷机时读它 |

做长期刷机卡：

1. 买一张可靠的 64 GB 卡（SanDisk Extreme、三星 PRO Plus 等），先用 H2testw 或 `f3` 测实际容量，避免假卡。
2. 用板子按 §12.1 写入 Armbian。
3. 把 U 盘里的 `h2z-image` 整个目录拷到这张卡的 `/h2z-image`，再执行 `install-flasher.sh`。

**过渡方案（未实现）**：SD 卡 + U 盘同时插，需让 `install-flasher.sh` / `flash.sh` 按标签 `h2zimg` 自动挂载 U 盘（如 `/mnt/h2zimg`），并把 `h2z-autoflash.service` 的 `ConditionPathExists` 和 `--image` 指向它。目前刷机卡只认卡上的 `/h2z-image`。

### 12.4 干净母版与更新

- 当前镜像来自现场板子，含现场数据，**只在内部使用**。要发给工厂或别人的干净母版：用它克隆一台、首次开机完成后不做任何现场操作，对这台执行 12.2 再采集一次，得到的镜像就不含任何客户数据。
- 发布新版本：母版 `git pull` / `docker compose pull` 后重做 12.2。重新采集前先关掉刷机：`sudo sh /usr/local/lib/h2z-image/install-flasher.sh --off`；旧镜像保留为 `/h2z-image.previous`，新镜像验证后删掉。
