# 版本、配置和运维

## 版本来源

EMQX 固定 5.8.8，PG 固定主版本 16，TDengine 可选 3.3.2.0，AI 镜像复用现有 0.1.0 本地构建号。backend 最新版由 h2z.backend Git Action 发布。`latest/master` 是可变标签；验收后把 `.env` 镜像改为 `repository@sha256:...` 或对应发布版本，保留上一个通过验收的 digest。

```powershell
docker image inspect ghcr.io/h2ztech/h2z-backend:latest --format '{{json .RepoDigests}}'
docker compose config --images
```

不要把完整 `docker compose config` 输出粘贴到工单，它包含展开的数据库及 MQTT 密码。检查结构使用 `docker compose config --quiet`。

首次初始化后 `.env` 与令牌文件必须备份。重复 `init` 不换口令；更改 `.env` 的 POSTGRES_PASSWORD 不会更改已初始化数据库角色的真实密码。EMQX 的 bootstrap 也不会自动覆盖现有用户密码；变更密码要按服务自身接口操作并更新消费者。

## 备份与恢复

业务数据位于 `h2z-security_*` 命名卷，与邻居项目隔离。备份至少包括 PG、IOC 项目卷、backend 模型/上传、录像索引与录像目录、Node-RED 流和加密存储、DSH home、AI shared/registry、YOLO outbox，以及 `.env` 和 `secrets/`。

PG 在 Linux 可流式备份：

```bash
mkdir -p backups
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > backups/security.dump
```

Windows PowerShell 不同版本的二进制重定向行为不同，建议先在容器 `/tmp` 生成文件再 `docker compose cp`，核对 `pg_restore -l` 可读。文件卷备份时停止写入者以获得一致性；不要在未恢复演练的情况下把 tar 成功当作业务恢复通过。

`CAMERA_SECRET_KEY` 与 Node-RED credential-secret 必须和其加密数据一起恢复，否则摄像头/流程凭据无法解密。模型 API Key 在 DSH home 中，不进入 Git。

## 升级

摄像头绑定成功后自动打开直播，IOC 的 live 接口在后端调用 ZLM `addStreamProxy` 注册视频代理。同一路重复调用复用 app/stream；默认子码流，没有子码流时回退主码流。模型点位绑定与 RTSP 接入配置分别保存：缺少地址或账号时到设备「配置 → 接入与录像」填写，保存后自动取流。建议使用 H.264 子码流以便浏览器播放；H.265 的支持取决于浏览器与设备。

视频注册失败不撤销已保存的点位绑定，界面提供重试和配置入口。共享 MAC 的多通道设备不自动猜通道，应在监控列表选择具体摄像头。直播不会自动开启录像，录像仍按既有配置运行。

```bash
sh scripts/update.sh      # 查空间 → git pull → 拉镜像 → 再查空间 → up --wait → 清我们自己的旧镜像（留上一版）
# Windows: node scripts/smoke.mjs --full
# Linux: sh scripts/smoke.sh --full
```

空间不够（少于 10 GB）`update.sh` 会停下并列出占用；`sh scripts/update.sh --check` 只查，`--prune-old` 先清我们自己的旧镜像。板子看门狗（`sudo sh host/install-watchdog.sh`）见 [ORANGE-PI.md §11.0](ORANGE-PI.md)。

新镜像第一次启动可能更新 schema。当前上游 security 使用 TypeORM synchronize；部署前备份，升级后核验摄像头、告警、录像索引等业务数据。不要与完整 h2z.backend 主库共用同一数据库后重复同步两套实体；这里使用独立的新 PG 数据卷。

失败时先核对缺失接口、schema、token、模型和镜像架构，再决定回滚已验收版本。`docker compose down` 保留卷；不要使用 `down -v` 清除业务数据。

日志限制为每容器 20MB ×3。`docker compose logs --tail 100 <服务>` 排查时注意上游日志可能含带凭据的摄像头 URL，分享前脱敏。AI 探索任务默认等待人工审批，超时失败；`H2Z_LOOP_DRY_RUN=0` 表示真实任务，不把样例探索当成实测。

## 摄像头库

品牌识别、RTSP 码流路径、探测候选顺序、ONVIF 默认端口的库在 `camera-library/`（来源规则、证据等级、更新办法见 [camera-library/README.md](../camera-library/README.md)）。

- 检查：`node scripts/camera-library/build.mjs --check`（数据过门禁、`library.json` 合规且和 `data/` 一致；`smoke.mjs` 里也会跑，并检查 compose 已把它只读挂进 backend）。
- 更新：改 `camera-library/data/` 或重新导入之后跑 `node scripts/camera-library/build.mjs`，把 `library.json` 一起提交。
- 生效：compose 把整个 `camera-library/` 只读挂进 backend 的 `/camera-library`，`IOC_CAMERA_LIBRARY_FILE=/camera-library/library.json`。IOC 第一次用到时读取并缓存，所以拉完代码后要 `docker compose restart backend` 才生效。
- 读不到或不合规时 IOC 退回内置最小集（Tapo / 海康 / 大华的固定路径 + 通用探测候选 + 端口，与库化之前一致），不会起不来；原因在日志里：`docker compose logs backend | grep CameraLibrary`。
- 前端和后端要配套：h2z.ioc 的界面不留厂家路径表，补码流地址问 IOC 后端的 `POST /projects/{p}/network/cameras/access-defaults`（按这个库给）。镜像里的前端和 IOC 后端版本差得太远（后端没有这个接口）时，界面会写「没能自动补码流地址…请手动填」，不会猜；碰到这句先检查 backend 镜像是不是带了摄像头库的版本（`docker compose logs backend | grep CameraLibrary` 能看到「摄像头库已加载」）。
- 不进库的东西：口令、默认口令、iSpyConnect / StrixCamDB 的数据（台账里登记为禁用来源，门禁会拒绝）。

## 本地控制台：模拟 128 路（测分屏预览和解码能力）

没有 128 台摄像头，也想看看这台设备的 HDMI 本地控制台放 128 路是什么样（16 分屏 8 组、翻组、轮巡、全屏、本机解码扛不扛得住），就用「模拟 128 路」：

1. HDMI 本地控制台 → 菜单（要设备管理口令）→ 通道管理 → 打开「模拟 128 路」开关。
2. 回到预览：顶栏有黄色的「模拟通道 128 路」，预览里在真实通道后面多出 SIM-001 … SIM-128，分屏（1 / 4 / 9 / 16）、上一组 / 下一组、轮巡、通道列表、双击全屏都能用；每一格都在放视频，各自起点不同（同一屏的格子画面不同步），像 128 路各自的直播。
3. 不用时关掉同一个开关。开关记在这台设备的浏览器里，重启后还在。

要点：

- **视频**：默认用前端镜像里内置的示例（`/ioc/sim/sample.mp4`，H.264、1280×720、25 帧、30 秒）。想换成自己的：在远端后台（`/ioc/admin`）→ 仓库配置 → 模拟数据 → 上传 MP4（H.264 编码、moov 在文件头开播快，最多 12 个；传了几个就相邻通道轮换着用）；本地控制台下次开启模拟或翻组时用新的。
- **它测什么**：设备上浏览器（Chrome 硬解 / 软解）同时解码和渲染多路视频、分屏和翻组的流畅度。**不测** ZLM 取流、网络、录像：模拟通道只在前端，不进摄像头列表、不写数据库、不录像，也不算进顶栏「录像 N / M」。
- **分屏上限**：开着模拟时 9 / 16 分屏按钮不再按 H.265 解码能力置灰（示例视频是 H.264），想限制可以在菜单里手动覆盖。
- **看解码是不是走硬解**：照 `os/x86/README.md` 第 5 节：`ssh -L 9222:127.0.0.1:9222 h2z@<IP>` 后在笔记本 Chrome 打开 `http://localhost:9222`，inspect 本地控制台页面，DevTools 的 Media 面板里 `VaapiVideoDecoder` = 硬解；`top` 看 CPU，`sudo intel_gpu_top` 看核显 Video 引擎。
- **版本**：只需要新的 `ioc-frontend` 镜像（h2z.ioc 的 `FM-812`）；后端不用改。

## TDengine / 低代码

telemetry profile 仅启动 TSDB 并持久化数据。真实写入流由 Node-RED 配置，不能用旧 云端生产环境 的 MQTT 业务主题和表结构直接替代安防事件。需要实现时可在 Node-RED 用 MQTT-in 订阅 `security/vision/yolo8-vehicle/events`，验证 JSON 后写入独立时序表，凭据配置到加密存储。PG 中的告警是本期权威记录。
