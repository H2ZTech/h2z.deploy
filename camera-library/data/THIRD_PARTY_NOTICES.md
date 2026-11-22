# 第三方数据声明

## ch-bas/cctv-camera-database（`imported.json` 的来源）

- 项目：https://github.com/ch-bas/cctv-camera-database
- 文件：`data/rtsp-patterns.json`
- 许可：CC0 1.0 Universal（公有领域）。上游文件的 `_meta.license` 为 `CC0-1.0`，仓库 LICENSE 是标准 CC0 1.0 文本。CC0 不要求署名，这里记录只是为了可追溯。
- 取用版本：commit `7616a0a0944522159c3daad4a50988b740cb4d65`，文件 SHA-256 `ba0ad89d351abee33a182c15abc0ecab4a1a50feeb24d27a0ffeb5f14a69ce87`，取用日期 2026-11-04（上游文件自称生成于 2026-10-28）。
- 上游自述的方法：StrixCamDB 只当线索，每条路径对照厂家自己的文档重新核实；核实不了的放进 `unverified_leads`，不当事实发布。我们无法逐条验证这一点，所以只取它声明已核实、并且来源在厂家官方主机上的条目当 `documented`，其余一律 `candidate`。

### 我们拿了什么

每个品牌的 `brand_id`、`brand`、`default_port`，以及 `verified: true` 的模板的 `stream`、`path`、`codec`、`port`、`series`、`scope`、`device_type`，
和 `source` 里的链接与标题（截断到 160 字）。路径里的占位符归一成 `{ch}` / `{ch2}`。

### 我们没拿什么

- `strix_lead`（线索来源指针）、`unverified_leads`、品牌级 `notes`、`verified_on`、`series_variants`、`candidate_unconfirmed`。
- `verified` 不是 `true` 的模板（2 条）。
- 路径里带账号口令占位符的模板（`{user}` / `{pass}`、`user=` / `password=`，6 条）。
- 来源或备注里提到聚合站 / 线索库（iSpy、Agent DVR、camlytics、ipcamlive、SmartRTSP、Strix、security.world、rtsp.me、VisioForge、ZoneMinder）的模板（13 条）。
- 该仓库里的 `strix/` 目录和规格数据（`specs`）。
- 上游原始文件本身不进我们的仓库。

另有 2 条（宇视录像机的 `/unicast/c<N>/s0|s1/live`）按我们打开来源页面的抽检结论降为 `candidate`：它引用的宇视官方 PDF 里没有这个写法。
抽检记录见 `../README.md` 的「来源抽检记录」。

### 复现

见 `../README.md` 的「更新导入层」。导入器是确定性的：同样的上游文件和参数，输出逐字节一致。

## 明确不使用的来源

- iSpyConnect 摄像头数据库（https://www.ispyconnect.com/cameras）：页面声明保留所有权利，服务条款禁止自动化访问。
- StrixCamDB（https://github.com/eduard256/StrixCamDB）：CC BY-NC 4.0（非商用），README 自述数据大部分来自 iSpyConnect。

以上两项写进了 `sources.json` 的台账（`usage: forbidden*`），任何数据把它们当来源登记都会被门禁拒绝。
