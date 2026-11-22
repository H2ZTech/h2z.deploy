# 摄像头画像库（camera-library）

H2Z 所有摄像头品牌 / 码流路径知识的**唯一来源**，放在 h2z.security。h2z.backend IOC 的探测、批量口令、手动添加、自检补流只从这里取，
不再各自写厂家路径（库化之前同一份知识散在 h2z.backend 的 5 处，ONVIF 端口表还有两份且不一致）。

库存的是「事实 + 证据」：某品牌的 RTSP 路径模板、默认端口、已知限制、**出厂账号 / 激活方式 / 登录锁定阈值（factory，2026-11-08 起）**，以及每条的出处。
**不存任何用户 / 现场设的口令；码流路径里永远不许有口令。** 出厂默认账号只能放在 `factory.accounts`，规则见下面「出厂账号」一节。
库只是先验：它决定候选顺序和能不能直接填；摄像头是否真有这个路径，最终由设备应答（401/404 探测、带账号的 DESCRIBE）裁决。

## 目录

```
camera-library/
  data/imported.json   导入层。scripts/camera-library/import-ch-bas.mjs 生成，不要手改
  data/curated.json    手写层。识别词、锁定的变体、现场实测证据、旧代码里的兜底写法、ONVIF 默认端口
  data/sources.json    来源台账。库里每条数据的来源都必须在这里登记，用法和许可必须在允许范围内
  data/THIRD_PARTY_NOTICES.md
  library.json         产物。build.mjs 把上面三份合并、校验、排好序生成的扁平文件，**后端读的是它**，要和 data/ 一起提交
scripts/camera-library/
  library.mjs          合并 / 门禁校验 / 生成产物（validateRaw 是许可、来源、口令、路径安全的门禁）
  build.mjs            生成产物；--check 只检查（smoke 里也会跑）
  import-ch-bas.mjs    导入器
scripts/camera-library.test.mjs  scripts/camera-library-import.test.mjs
```

## 谁怎么用它

compose 把整个 `camera-library/` 只读挂进 backend 容器的 `/camera-library`，并设 `IOC_CAMERA_LIBRARY_FILE=/camera-library/library.json`。
h2z.backend IOC 启动后第一次用到时读取并校验这个文件：

- 读得到、合规 → 用它（全库：品牌识别、每个品牌的 [主, 子] 码流路径、探测候选顺序、ONVIF 端口）。
- 没挂载 / 读不到 / 不合规 → 退回 IOC 内置的最小集（Tapo、海康、大华的固定路径 + 8 对探测候选 + 端口，和库化之前的写死行为一致），并在日志里说明原因，**不会起不来**。
- **更新库之后要 `docker compose restart backend` 才生效**（IOC 只在第一次用到时读，之后缓存）。

h2z.backend 里**不放**这份数据，也不放导入器；它只有读产物的薄模块（`apps/ioc/src/camera-library/`）。

**前端也不放**：h2z.ioc 的界面不留厂家路径表（2026-11-04 删了 `cameraDefaults.js` 里 Tapo / 海康 / 大华那三条）。绑定摄像头、打开「配置 → 接入与录像」时，
前端问 h2z.backend IOC 的 `POST /projects/{p}/network/cameras/access-defaults`，后端按这个库给要补的主 / 子码流地址和 ONVIF 端口；搜索摄像头列表里每一行的 `knownStreams`
（库认识不认识）也是后端按库给的。**所以新前端要配带这个接口的 IOC 后端**：旧后端上界面会如实写「没能自动补码流地址，请手动填」，表单照常能用，不会拿前端的表去猜。

## 证据等级（每一路码流一个）

| 等级 | 含义 | 能做什么 |
| --- | --- | --- |
| `verified` | 我们在真机上验证过（有 `device` 证据：型号、日期、出处、结果） | 可直接填 |
| `documented` | 厂家官方文档写明（有 `vendor-doc` 证据：链接）。官方主机按主机名人工审定，没有逐页打开 | autoFill 的品牌可直接填；其余先过 401/404 探测 |
| `candidate` | 转载站 / 用户论坛 / 没有链接 / 靠 OEM 推断 / 旧代码里的写法 | 只当探测候选，探测命中前不填 |

产物里一对 [主, 子] 的等级取两者里较差的。`autoFill`（允许不探测就直接填路径）目前只开给 Tapo、海康、大华——它们是现场验证过、并且与库化之前的行为逐字一致的。
其它品牌的路径只作为探测候选，由 401/404 探测确认后才会被用。

## 来源规则（红线）

- 只收台账里 `usage` 为 `import` / `own` / `cite`、许可在 `allowedLicenses` 里的来源。门禁在 `library.mjs` 的 `validateRaw`，数据不合规就生成不出产物。
- **禁止**：iSpyConnect（保留所有权利，条款禁止自动化访问）；StrixCamDB（非商用许可，且数据大部分来自 iSpyConnect）——不查、不批量导入、不下载整库。
  人工在网页上针对手上有真机的单个型号查一眼当线索是允许的，但只能把自己试通的结果按我们的格式写进 `curated.json`，证据写自己的测试。
- 口令不进路径：路径里不许有 `://`、`@`、`password`、`user=`，导入时整条丢弃。（2026-11-08 负责人决定：厂家公开的**出厂默认账号**可以记在 `factory.accounts`，见下一节；其它口令仍然永不进库。）
- 路径会被原样写进 RTSP 请求行，所以渲染结果必须通过 `SAFE_PATH`（不许空白、回车换行、引号）。
- 不提交上游原始文件，只提交过滤后的结果和复现信息（commit + 文件 SHA-256）。

## 更新导入层

```bash
git clone https://github.com/ch-bas/cctv-camera-database /tmp/ccdb && git -C /tmp/ccdb checkout <commit>
node scripts/camera-library/import-ch-bas.mjs /tmp/ccdb/data/rtsp-patterns.json --commit <commit> --retrieved <YYYY-MM-DD> [--sha256 <hex>]
node scripts/camera-library/build.mjs          # 重新生成 library.json
node --test scripts/camera-library.test.mjs scripts/camera-library-import.test.mjs
```

导入报告会列出丢弃的条目和原因，以及**未审定的来源主机**——它们已按 `candidate` 处理，需要人审后才能加进导入器的 `OFFICIAL_HOSTS`。
输出只取决于输入，重复运行结果逐字节一致，diff 里看到的就是上游真实的变化。新版本如果让锁定变体的路径变了，`与库化之前一致` 的测试会失败，需要人确认。
改了 `data/` 里任何文件都要重新跑 `build.mjs`，把 `library.json` 一起提交（`build.mjs --check` 和 smoke 会发现忘了）。

## 加手写条目 / 真机证据

- 新品牌或要覆盖的字段：写进 `curated.json` 的 `vendors`。
- 真机验证过：加一条 `promote`（`variant`、`streams`、`evidence`：`type=device` + `model` + `date` + `ref` + `result`），对应的流升为 `verified`。没有真机证据不允许升。
- 想让某品牌 `autoFill`：必须锁定变体（`pin`），变体要有主 + 子码流、不带需要人给值的占位符、至少 `documented`。
- 设备只报型号不报厂家（Tapo 的 ONVIF 常这样：C210 / C510W / TC70）：给品牌加 `modelPatterns`（正则源码，对「小写、非字母数字换成空格、首尾各一个空格」的文本匹配，词边界写成空格）。
  只在所有品牌的识别词都没认出来之后才用，别的厂家认出来就不走这条；现在只有 Tapo 有（真机上出过问题才加）。正则来自容器外的文件，门禁要求能安全执行：
  小写字母数字、空格和少量元字符，反斜杠只许 `\d \. \-`，分组后面不许再跟 `* + {`（嵌套量词会指数回溯），不许环视 / 反向引用，最多 20 条、每条 3–120 字符。
- 抽检后发现来源页面里查不到某条路径：加到导入器的 `REVIEW_OVERRIDES`（brand_id + 上游原始 path → 原因），降为 `candidate`。

## 产物格式（`library.json`，schema 1）

`upstream`（来源记录）、`counts`、`onvifPorts`（全局默认 ONVIF 端口）、`autoFill`（直接填的识别顺序，与库化之前一致：tapo → hikvision → dahua）、
`sweep`（无账号探测的通用候选 [主, 子]，已渲染）、`vendors[]`：`id`、`name`、`aliases`（小写）、`match`（`substring` / `word`）、`autoFill`、`pin`、`onvifPorts`、
`modelPatterns`（可选，只给型号时认品牌）、`requires`、`quirks`、`pairs[]`（已按「锁定 → 等级 → 库里顺序」排好：`id`、`target`、`status`、`label`、`main`、`sub`，路径是模板，`{ch}` 通道从 1 起，`{ch2}` 两位补零）。
需要人给值的占位符（`{codec}`、`{token}`）、没有主 + 子配对的写法不进产物，留在 `data/` 里。

## 出厂账号 / 激活 / 锁定阈值（factory）

2026-11-08 负责人决定：摄像头库里要有各品牌的默认账号记录，用于「摄像头通网就自动加入并录像」（后端 `h2z.backend/apps/ioc/src/network/camera-onboard.ts`）。
首批品牌：海康、宇视、TVT、华三。数据在 `data/curated.json` 各品牌的 `factory` 字段，产物里 `vendors[].factory`：

- `accounts[]`：`username` / `password` / `scope`（适用哪类固件）/ `status`。**只收厂家公开的出厂值**，每个品牌最多 3 条，不收常见弱口令字典；口令只许 1–32 位可见 ASCII。
- `activation`：`required`（`new-firmware` 新固件没有默认口令、要先激活 / `always` / `none` / `unknown`）、`methods`、`minPasswordLength`。
- `lock`：`maxAttempts` / `lockMinutes`，输错多少次锁多久；**`null` = 不知道**，后端按保守默认处理，不许编数字。
- `factoryIps[]`：出厂 IP（设备不在本网段时用备用地址去够）。

证据规则和码流一样：`verified` 必须有真机证据（`device`），`documented` 必须有厂家文档（`vendor-doc`），经销商 / 论坛 / 手册转载页（`mirror-doc`，台账里是 `third-party-cite`）只能是 `candidate`。
每条证据必须带链接和日期。查不到可靠资料的（目前：TVT 的激活和锁定、华三全部）如实写 `unknown` / `null`，不要为了完整去编。
产物里不带证据和备注（和路径一致，证据留在 `data/`）。**锁定阈值要在真机上实测**（拿一台备用摄像头故意输错）后升级为 `verified`；没测之前后端用比文献更保守的预算。
这些是公开的出厂值，不算密钥，但后端只对「疑似出厂」的设备、在每台设备的尝试预算内使用；成功后会改成站点统一口令。

## 已知局限

- 导入层的 `documented` 是按来源**主机名**审定的，没有逐页打开核对；重点品牌上线前应抽检来源链接（见下表）。
- 上游数据集的数量和「verified」是它自己的声明，意思是「对照过厂家文档」，不是「在设备上测过」。
- 同一品牌常有几种写法（Reolink 新旧两种、宇视摄像头和录像机两种、Hanwha 的 profile 号因设备配置而异），库存的是候选，最终由探测判定。
- 占位符里 `<N>` 统一当成「通道号」，少数品牌里它其实是码流序号或传感器号，这类只会出现在非 autoFill 的品牌里，渲染时当通道 1。
- 需要人给值的占位符不会被自动渲染。

## 来源抽检记录（2026-11-04，导入时对重点品牌打开原始链接核对）

| 品牌 | 来源 | 结果 |
| --- | --- | --- |
| 海康 | enpinfo.hikvision.com 开发文档 | 通过：`rtsp://<host>[:port]/ISAPI/Streaming/channels/<ID>`，ID = 通道号 × 100 + 码流类型（1 主 / 2 子 / 3 第三），例 101 = 通道 1 主码流 |
| 海康 | supportusa.hikvision.com 文章 17000129064 | 通过：`/Streaming/channels/<通道号><码流号>`，01 主 / 02 子。页面写小写 `channels`，库沿用现场在用的 `Channels`（行为不变；服务器是否区分大小写没有在真机上验证） |
| 海康 | supportusa.hikvision.com 文章 17000129022 | 访问返回 503，未核对 |
| 宇视 | global.uniview.com 官方 PDF（V1.1，Product: IPC） | 摄像头 `/media/video1..3` 通过。**录像机的 `/unicast/c<N>/s0|s1/live` 这份 PDF 里没有**，已按 `REVIEW_OVERRIDES` 降为 candidate |
| 大华 | dahuawiki.com `Remote_Access/RTSP_via_VLC` | 抓取工具返回 503、curl 连接被重置，**未能核对**。状态仍是 documented（来源是官方 wiki），佐证：现场子码流实测、Frigate 文档（MIT）同写法。能访问后补核对 |
| Tapo / Axis / Hanwha / Reolink | TP-Link FAQ 2680、developer.axis.com、support.hanwhavision.eu、support.reolink.com | 导入前在搜索结果摘要里看到与库一致的写法，没有逐页打开 |
