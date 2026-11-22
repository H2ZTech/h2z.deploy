# B 线部署指南（全 GHCR，2026-11-21）

B 线 = 仓库根目录的 `compose.yaml` + `scripts/init.mjs` / `init.sh` + `scripts/update.sh`，以及 x86 的 H2Z OS 安装盘（`os/x86`）。
LA31 / LA18 / LA9 这类老站点按本指南**全新重装**，不做原地迁移，旧数据不保留。

## 0. 隔离原则（先读）

- h2z 开头的项目属于美国公司：代码在 GitHub，镜像只在 GHCR（`ghcr.io/h2ztech/`，公开，**拉取不需要登录，也不需要令牌**）。
- 部署过程中**不要**登录任何别的镜像仓库、不要用旧站点留下的 `.env` / `~/.docker/config.json`，也不要从旧机器拷镜像。
- 新装的机器如果在 `.env` 或 `docker images` 里看到 GHCR 以外的自家镜像地址，说明用了旧配置：删掉 `.env` 重跑初始化。

## 1. 两种部署方式

| 方式 | 适用 | 入口 |
|---|---|---|
| A. H2Z OS 安装盘（推荐，x86） | 新机器整盘重装，HDMI 直出本地控制台 | 第 2 节 |
| B. 已有 Linux 主机 + 仓库（x86 / Orange Pi arm64） | 不想整盘重装，或 arm64 板子 | 第 3 节 |

## 2. 方式 A：H2Z OS 安装盘（x86）

### 2.1 在 Windows 上做安装盘（一次性）

前提：Docker Desktop（Linux 容器）已运行，Docker 磁盘空闲 ≥ 40 GB。构建用的是当前分支**已提交**的代码，所以先确认要装的改动都已推到 main。

```powershell
cd C:\project\h2z.security
git switch main
git pull --ff-only origin main
powershell -ExecutionPolicy Bypass -File os\x86\build.ps1
```

产物在 `os\x86\out\`，用 `h2zos-installer-<版本>.img`。只改了系统脚本、镜像没变时可加 `-ReuseImages` 复用上次拉的镜像。

### 2.2 写 U 盘和安装

1. 用 Rufus（选 **DD 镜像模式**）或 balenaEtcher 把 `h2zos-installer-<版本>.img` 写入 U 盘。
2. 目标机 BIOS：UEFI 启动，关闭 Secure Boot。
3. 插 U 盘开机；只有一块内置盘时 10 秒倒计时后自动写入（按任意键取消），有多块盘时按提示选编号并输入 `YES`。
4. 提示后拔出 U 盘，自动重启。

### 2.3 首次开机（不需要操作）

自动完成：建数据分区挂 `/data`、导入预置镜像（几分钟，屏幕显示启动页和进度）、生成 `.env` 和密钥、`docker compose up -d`。
完成后 HDMI 自动进入本地控制台 `http://127.0.0.1:8096/ioc/local`。
首次导入镜像的进度条会先显示"解包中"的循环动画，这是正常的，不要断电。

常用入口：

| 项 | 值 |
|---|---|
| SSH | `ssh h2z@<IP>`（测试版默认密码 `h2z2026`，交付前必须改） |
| 仓库 | `/opt/h2z.security` |
| 日志 | `/var/log/h2z-os-firstboot.log`、`/var/log/h2z-os-stack.log` |
| compose profile | `/etc/h2z/os.env`（默认 `COMPOSE_PROFILES=recorder`） |

## 3.0 一键脚本（推荐用于方式 B，不需要任何账号或 token）

在一台全新的 Debian / Ubuntu（x86_64 或 arm64）上执行这一条：

```bash
curl -fsSL https://raw.githubusercontent.com/H2ZTech/h2z.deploy/main/install.sh | sudo sh
```

先只看会做什么：`curl -fsSL <同上地址> | sudo sh -s -- --dry-run`。

脚本自动判断系统（只认 Debian / Ubuntu）和 CPU，检查内存和磁盘，然后依次：装基础工具 → 取代码 → `host/setup-host.sh`（Docker、看门狗等）→ `init.sh` → arm64 镜像检查 → `compose pull/up` → 建默认项目 → 冒烟。可重复跑，做过的步骤会跳过。

代码和镜像都是公开的：代码来自公开仓库 `H2ZTech/h2z.deploy`，镜像来自 GHCR，所以外部人员不需要 GitHub 账号、token 或密钥。以后更新照常 `sh scripts/update.sh`，也走这个公开仓库。

常用选项：`--dir`、`--branch`、`--network`（默认 skip，远程装机不碰网口）、`--no-start`（只准备不启动）、`--force`（arm64 镜像检查有 FAIL 也继续）、`--dry-run`。

### 维护者说明

本仓库 `H2ZTech/h2z.deploy` 是 B 线部署的唯一来源，直接在这里改、直接推 main，不再从任何私有仓库同步。仓库和镜像都必须保持公开：确认 GHCR 上各镜像包都是 Public，装机的人才不需要账号或 token。

下面第 3 节是脚本背后的手动步骤，出问题时可以对照。

## 3. 方式 B：已有 Linux 主机 + 仓库

以 Debian / Ubuntu 为例（Orange Pi 5 Max 的完整步骤见 `docs/ORANGE-PI.md`）。

```bash
# 1) 基础工具
sudo apt-get update
sudo apt-get install -y git ca-certificates curl jq python3 nodejs npm

# 2) 取代码（仓库公开与否按你们的设置；私有时用只读 Deploy key，见 ORANGE-PI.md §2）
git clone git@github.com:H2ZTech/h2z.security.git /opt/h2z.security
cd /opt/h2z.security && git switch main

# 3) 装 Docker（Debian/Ubuntu 官方源）；装完退出 SSH 重新登录使 docker 组生效
sudo sh scripts/install-docker.sh

# 4) 生成 .env 和密钥（已有的密码会保留）
sh scripts/init.sh
grep -E '_IMAGE=' .env          # 自家镜像必须都是 ghcr.io/h2ztech/…

# 5) arm64 板子先查镜像都有 arm64（x86 可跳过）
node scripts/check-images.mjs arm64

# 6) 启动
docker compose config --quiet
docker compose pull
docker compose up -d --wait --wait-timeout 180
```

启动后：

```bash
sudo node scripts/seed-project.mjs   # 建默认项目
sudo node scripts/smoke.mjs        # 冒烟；--full 为完整验收
```

## 4. 验收清单（每个站点都做）

1. `docker ps` 里 backend / web(前端) / postgres / emqx / zlm / nodered / ai-server 都是 healthy。
2. `docker images` 里自家镜像都来自 `ghcr.io/h2ztech/`，没有其它自家仓库地址。
3. 打开 `http://<IP>:8096/ioc`（`HTTP_BIND` 默认只绑本机，要让局域网访问需改成 `0.0.0.0`）能看到安防大屏。
4. 后台 `http://<IP>:8096/ioc/admin`：默认账号 `admin`、口令 `h2z2026`，**交付前改掉**（同时改 DSH 的 `secrets/dsh-web/password`、设备管理口令 `secrets/ioc/device-password`）。
5. 本地控制台"摄像头"页自动搜索能发现摄像头；密码不对的可以在页面里输入后点修复（单条或批量）。
6. "硬盘"页状态卡显示是自动建库还是需要人点击；有需要点击的才会出现 repair 按钮。
7. 装看门狗：`sudo sh host/install-watchdog.sh`（安装盘设备首次启动自动装）。
8. 备份：按 `docs/OPERATIONS.md` 做一次基线备份。

## 5. 以后更新

```bash
cd /opt/h2z.security
sh scripts/update.sh   # 查空间 → 拉代码 → 拉镜像 → 启动 → 清旧镜像（留上一版）
sh scripts/update.sh --check        # 只查空间
sh scripts/update.sh --prune-old    # 空间不够时先清旧镜像
```

空闲少于 10 GB（`MIN_FREE_GB`）会停下并列出空间占用。更新前按 `docs/OPERATIONS.md` 备份。
安装盘设备也可以用整包升级（`.h2zup`）和扩展包（`.h2zpack`），见 `os/x86/README.md`。

## 6. 常见问题

| 现象 | 处理 |
|---|---|
| `docker pull` 报 unauthorized | GHCR 包没设为 Public：到 GitHub 组织 → Packages → 对应包 → Package settings 改 Public。不要去登录别的仓库 |
| `.env` 里出现 GHCR 以外的自家镜像 | 用了旧配置。删 `.env`，重跑 `sh scripts/init.sh` |
| arm64 `check-images` 有 FAIL | 说明该镜像还没发 arm64 manifest，到对应仓库 Actions 手动触发 arm64 构建（`push-all.ps1 -Arm64`） |
| 首次开机进度条长时间不动 | 先看是不是"解包中"循环动画；用 `tail -f /var/log/h2z-os-stack.log` 确认还在导入 |
| 摄像头密码不对 | 本地控制台"摄像头"页输入密码后修复；单条、多选、批量都可以 |

## 7. 没有验证的部分

- 本指南根据仓库里的脚本和现有文档整理，没有在真机上从头跑一遍。
- 最近的本地屏幕修复（进度条、摄像头修复按钮、硬盘页提示、升级页文案）和各仓库新的 GHCR CI 构建结果，都还没在真机 / Actions 上确认；装第一台时请重点看这几处。
