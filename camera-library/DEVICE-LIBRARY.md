# 设备库：摄像头 + 录像机 + 网络设备

`camera-library/` 现在放三个库。目录名没改，因为 compose 已经把它只读挂进 backend（`/camera-library`），放在一起不用动部署。

| 库 | 人写的数据 | 产物（backend 读它） | 生成 / 检查 |
|---|---|---|---|
| 摄像头 | `data/imported.json`、`data/curated.json` | `library.json` | `scripts/camera-library/build.mjs`（见 README.md） |
| 录像机 | `data/recorders.json` | `recorders.json` | `scripts/device-library/build.mjs` |
| 网络设备 | `data/netdevs.json` | `netdevs.json` | 同上 |
| 给 AI 的摘要 | （由三个库生成） | `device-library.ai.md` | 同上 |

改了任何数据：先 `node scripts/camera-library/build.mjs`，再 `node scripts/device-library/build.mjs`，把产物一起提交。`--check` 只检查；smoke 和测试也会查。

三个库共用一套红线：存「事实 + 证据」；不存任何口令、团体名；来源必须登记并对应来源台账 `data/sources.json`；每块内容带证据等级。

| 等级 | 含义 | 门禁 |
|---|---|---|
| `verified` | 我们在真机上验证过 | 必须有 first-party 来源 |
| `documented` | 厂家自己的文档或标准写明 | 必须有 vendor-doc / standards 来源，且带链接和取用日期 |
| `candidate` | 第三方资料、OEM 推断、或凭记忆写的 | 产品依赖它之前必须在真机确认 |

凭记忆写、没打开官方页面核对的来源要标 `fromMemory: true` 并写说明，它只能撑 `candidate`。

## 录像机库（recorders）

按**协议族**组织，不按品牌：录像机要的是一组接口（识别、列通道、查录像、回放、硬盘），同一套接口被多个品牌共用（大华 / Amcrest / Lorex；海康 / HiLook / ANNKE）。

- `families[]`：一套接口怎么用。产品每支持一个族要有一个驱动（h2z.backend）。
  `productSupport`（supported / none）、`identify`（端口、探哪个地址、应答里该有什么）、`auth`、`time.zone`（接口里的时间是录像机本地时间还是 UTC）、
  `channelBase`（通道号从 0 还是 1 起）、`interfaces`（设备信息 / 时钟 / 通道 / 检索 / 硬盘 / 下载）、
  `rtsp.live`（实时主 / 子码流模板）、`rtsp.playback`（回放地址模板 + 时间格式，占位符 `{ch}` `{stream}` `{start}` `{end}` `{date}` `{time}` `{seconds}`）。
- `models[]`：某型号属于哪个族、几路、几个盘位。加型号只是加数据。

门禁额外查：模板渲染后必须满足安全字符集、不许带账号口令形态；标成 `productSupport: supported` 的族，检索接口必须是 `verified`。

## 网络设备库（netdevs）

按**平台**组织（H3C Comware、Cisco IOS、Huawei VRP、Aruba、Ruijie、Junos、RouterOS、FortiOS、UniFi、Omada、APC UPS，以及只认得出厂家的 generic-snmp）。

- `snmp.tables[]`：标准 MIB 表（OID + 能得到什么），任何平台都先问这些。
- `linkRules[]`：连线结论能下到什么程度（LLDP 读到的才算 confirmed，FDB + ARP 推出来的是 inferred……）。
- `families[]`：`identify`（IANA 企业号、sysDescr 字样、SSH 标识、OUI）、`snmp`（怎么请现场开只读）、
  `cli`（登录方式、关分页、每个用途对应的只读命令）、`controller`（控制器 HTTP 接口）、`portNaming`、`limits`。
- `models[]`：型号 → 平台、角色、端口布局、PoE 预算。

门禁额外查：企业号不许两个平台重复；OID 写法合法；`cli.commands` 里只许只读命令（出现 reboot / reset / write / save / undo / no / set / config… 直接拒绝）。

## 给 AI 的摘要（device-library.ai.md）

把三个库里「怎么认设备、用什么只读办法问它、结论能下到什么程度」压成一份 Markdown（约 30 KB），给 AI 探索当任务背景。
不含任何账号口令（摄像头库里的出厂账号不进摘要，测试守着）。同样的库永远生成同样的字节。

## 导出 / 导入（升级）

```
node scripts/device-library/bundle.mjs export [文件]           导出整库为一个文件，默认 h2z-device-library-<版本>.json
node scripts/device-library/bundle.mjs info [文件]             看一个包（或当前库）的版本和内容
node scripts/device-library/bundle.mjs import <文件> --dry-run 只校验，列出会变的文件
node scripts/device-library/bundle.mjs import <文件>           校验后替换本机的库；然后重启 backend
```

- 包里是 `camera-library/` 下全部数据和产物的原样字节，每个文件带 sha256。版本号是内容的哈希：同样的库导出的包完全一样。
- 导入不信任包：文件名只许白名单形态；先解到临时目录，跑和 `build --check` 同一套门禁，全部通过才替换；有一处不过就什么都不改。
- 导入前会把现有的库备份到 `runtime/device-library-backup/`，要退回就导入那个备份。
- 用途：现场机器不 `git pull` 也能单独升级库；把库交给别的系统（模拟环境、AI 服务）。

## 谁在用

- h2z.backend：摄像头库（已用）。录像机库 / 网络设备库 / AI 摘要的读取在 h2z.backend 里另行接入。
- H2ZTech/h2z.demo 的模拟现场：录像机和网络设备按这两个库生成，所以库里加一个协议族 / 平台，模拟环境就能多一种设备。
  注意：模拟器是照库写的，`candidate` 的接口对着模拟器调通不等于真机能通。
