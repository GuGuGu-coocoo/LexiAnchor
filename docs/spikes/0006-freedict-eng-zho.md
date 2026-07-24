# FreeDict/WikDict English–Chinese 离线词典 Spike

- 日期：2026-07-24
- 结论：v0.1 使用 FreeDict/WikDict `eng-zho` 2025.11.23 作为按需安装的英汉词典
- 状态：来源与许可证门禁、真实下载、完整解析和跨平台接入通过

## 目标

验证第三个正式词典 Provider 能否满足：

1. 数据来源与许可证能够追溯到词典内容；
2. Web/PWA 与 Electron 共用下载、校验、存储和查询实现；
3. 安装后无需网络即可与 WordNet、英法 FreeDict 同时查询；
4. 显示中文翻译的同时保留数据自带的英语释义；
5. 自动生成数据的质量限制在 UI 中清楚可见；
6. 版本、来源、许可证、署名、大小、校验和及删除方式可审计。

## 候选审计

### ECDICT

ECDICT 仓库标记 MIT，格式和覆盖度也适合离线词典。但其 README 说明数据由早期文本词典、
考试词表、Linux `cdict`、网络抓取和网友贡献逐步汇总，还包含 Collins、Oxford 等标注。
仓库没有为这些内容提供足够细粒度的来源与授权映射。

结论：仓库级 MIT 声明不足以证明全部数据都可由 LexiAnchor 官方下载和再分发。ECDICT
不进入官方资源清单；未来只能由用户通过通用导入能力加载其合法持有的副本。

### FreeDict/WikDict

FreeDict/WikDict TEI header 明确记录：

- 自动生成工具：WikDict；
- 基础数据：Wiktionary，经 DBnary 转换；
- 许可证：Creative Commons Attribution-ShareAlike 3.0 Unported；
- 维护者：Karl Bartel；
- 版本：2025.11.23；
- 源 headword：26,660。

该来源链和许可证满足资源门禁，因此选择为 v0.1 英汉基线。

参考：

- [FreeDict English–Chinese 2025.11.23](https://download.freedict.org/dictionaries/eng-zho/2025.11.23/)
- [WikDict downloads and license](https://www.wikdict.com/page/download)
- [Creative Commons BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/)
- [ECDICT repository and provenance description](https://github.com/skywind3000/ecdict)

## 版本、分发与可重复性

浏览器从 WikDict 的 `no-infl` TEI 地址下载，桌面 CSP 只额外允许这一来源。下载地址本身
不是内容寻址 URL，因此应用不能只信任 URL：manifest 同时固定预期大小和 SHA-256，任一
不一致就拒绝保存。更新上游版本必须先更新 manifest 并重新走本 Spike 的审计。

资源清单位于 `packages/dictionary/resources/freedict-eng-zho.manifest.json`：

- 浏览器下载地址：
  `https://download.wikdict.com/dictionaries/tei/no-infl/eng-zho.tei`；
- TEI 大小：13,913,829 字节；
- TEI SHA-256：
  `76e15cbc8497b479ebd3834259d52366f051e16eca44c3b50fced7a78f191fb3`；
- FreeDict 官方源码归档大小：1,600,448 字节；
- 源码归档 SHA-256：
  `78f6909786861809886201827e5e3d55dbf8e12f753d7a7183e785dbc574de8b`；
- 源码归档 SHA-512：
  `25aed0f1d7de68919aa9da1ba92d67f566ae4ea81660f42071c81fc21e56d4b210d61df379315678648c45ca7e52c4a0ba2eec009fbaab7c72e7472489e1fc4c`；
- 许可证：CC-BY-SA-3.0；
- 数据日期：2025-11-23。

2026-07-24 的真实下载与官方源码归档内 `eng-zho.tei` 大小、SHA-256 和逐字节比较均一致。
应用不把完整词典提交到 Git 或打进默认安装包。用户主动安装时先下载到内存，核验大小和
SHA-256，再解析验证，成功后写入 OPFS；设置页提供来源、许可证和删除入口。

## 实现

英法 Provider 已重构为通用 `FreeDictTeiProvider`，英法与英汉只提供不同 manifest。
解析器保留：

- headword；
- 第一发音，并去除源数据已有的外围 `/…/` 或 `[…]`；
- 可映射词性；
- 去重后的目标语言翻译；
- 去重后的英语 `<def>`。

查询结果按用户配置顺序并发返回。英汉结果显示中文翻译和最多两条英语释义；词卡仍从
目标语言为英语的 WordNet 结果取必填英语释义。设置页始终显示自动生成质量警告。

## 完整资源与性能

| 项目 | 结果 |
| --- | --- |
| TEI 源 headword | 26,660 |
| Provider 可读记录 | 26,642 |
| 唯一检索词 | 24,739 |
| `attentive` | 中文 `細緻`，并保留英语释义 |
| 完整解析耗时 | 当前开发机约 195 ms |
| 浏览器可访问下载 | 通过 |
| 下载文件与官方源码 TEI | 逐字节一致 |

195 ms 是每次应用会话首次查询已安装英汉包的一次性成本。它达到当前可测试版本要求，
但高于英法包；继续增加大型资源前应将解析移入 Worker 或转换为只读 SQLite。

## 自动化验收

| 验收项 | 结果 |
| --- | --- |
| TEI 翻译、英语释义、发音和词性解析 | Vitest 通过 |
| 下载大小和 SHA-256 | 完整资源通过 |
| 三词典排序、启停与断网查询 | Playwright 覆盖 |
| OPFS 安装、重载与删除 | Playwright 覆盖 |
| 自动生成质量提示 | 英/中/法 UI 覆盖 |
| 默认安装包不包含完整英汉数据 | 通过 |

自动 E2E 使用最小合法 TEI fixture 建立本地安装状态，避免 CI 依赖网络或提交 CC BY-SA
数据；完整文件另行通过 manifest、本地解析和真实下载路径验证。

## 限制与下一步

- 自动生成的中文翻译会有缺失、繁简混用或语义错误，不能当作权威词典；
- 下载 URL 可变，资源升级必须更新固定大小与校验和；
- 首次解析约 195 ms，后续需要 Worker 或 SQLite 优化；
- 尚未支持用户 StarDict 导入；
- 尚未实现本地 EN→ZH 句子翻译。

接受该实现作为 v0.1 英汉词典基线。下一步实现 StarDict 用户导入，让用户能够补充自己
合法持有且更符合学习需求的词典。
