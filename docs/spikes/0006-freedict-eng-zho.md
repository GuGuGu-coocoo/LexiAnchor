# FreeDict/WikDict English–Chinese 离线词典 Spike

- 日期：2026-07-24
- 结论：v0.1 使用 FreeDict/WikDict `eng-zho` 2024.10.10 作为按需安装的英汉词典
- 状态：来源与许可证门禁、真实下载、完整安装、查询和断网使用通过

## 目标

验证第三个正式词典 Provider 能否满足：

1. 数据来源与许可证能够追溯到词典内容，而不只依赖仓库级声明；
2. Web/PWA 与 Electron 共用下载、校验、存储和查询实现；
3. 安装后无需网络即可与 WordNet、英法 FreeDict 同时查询；
4. 显示中文翻译的同时保留数据自带的英语释义；
5. 自动生成数据的质量限制在 UI 中清楚可见；
6. 资源版本、来源、许可证、署名、大小、校验和及删除方式可审计。

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
- 版本：2024.10.10；
- 词条数：24,242。

该来源链和许可证满足资源门禁，因此选择为 v0.1 英汉基线。

参考：

- [FreeDict English–Chinese releases](https://download.freedict.org/dictionaries/eng-zho/)
- [FreeDict generated source](https://download.freedict.org/generated/eng-zho/)
- [WikDict downloads and license](https://www.wikdict.com/page/download)
- [Pinned Debian FreeDict source mirror](https://salsa.debian.org/freedict-team/dictionaries-wikdict/-/tree/99f62f8fedf81a392ca91fa6eaa67cbfdfe2db00/eng-zho)
- [Creative Commons BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/)
- [ECDICT repository and provenance description](https://github.com/skywind3000/ecdict)

## 版本与分发选择

FreeDict 已发布 2025.11.23，但其官方生成文件服务器没有给大文件响应提供浏览器 CORS
header。为保持 Web 与 Electron 同一安装路径，v0.1 固定 Debian FreeDict 团队 Salsa
仓库中的 2024.10.10 数据。Salsa API 支持浏览器 CORS；固定 commit 中的 TEI 与 FreeDict
官方 2024.10.10 源码归档逐字节一致。

资源清单位于 `packages/dictionary/resources/freedict-eng-zho.manifest.json`：

- 下载大小：12,535,861 字节；
- TEI SHA-256：
  `bad90ef326405c453966fb7ce589d4567b681138da09c6437d07ba86914e349b`；
- 官方源码归档大小：1,448,576 字节；
- 官方源码归档 SHA-256：
  `b0ca031da5350f9e365dc24b49e94750021f8f17ed64a6024e1800981db1170b`；
- 许可证：CC-BY-SA-3.0；
- 数据日期：2024-10-10。

应用不把完整词典提交到 Git 或打进默认安装包。用户主动安装时从固定 commit 下载，核验
大小与 SHA-256，验证 TEI 后写入 OPFS；设置页提供来源、许可证和删除入口。

## 实现

原英法 Provider 重构为通用 `FreeDictTeiProvider`，英法与英汉只提供不同资源 manifest。
解析器现在保留：

- headword；
- 第一发音，并去除源数据已有的外围 `/…/` 或 `[…]`，避免重复标点；
- 可映射词性；
- 去重后的目标语言翻译；
- 去重后的英语 `<def>`。

查询结果按用户配置顺序并发返回。英汉结果显示中文翻译和最多两条英语释义；词卡仍从
目标语言为英语的 WordNet 结果取必填英语释义。设置页始终显示自动生成质量警告。

## 完整资源与性能

| 项目 | 结果 |
| --- | --- |
| TEI 源 headword | 24,242 |
| 有可显示翻译的 headword | 24,225 |
| `attentive` | 中文 `細緻`，并保留英语释义 |
| `resilient` | 能查询，但自动翻译质量不理想，证明质量提示必要 |
| 完整解析耗时 | 当前开发机约 177 ms |
| 浏览器真实跨域下载 | 通过 |
| 完整文件安装、校验与 OPFS 写入 | 通过 |

177 ms 是每次应用会话首次查询已安装英汉包的一次性成本。它已经达到可测试版本要求，
但高于英法包；如果继续增加资源，将解析移入 Worker 或转换为只读 SQLite，避免 UI 抖动。

## 验收结果

| 验收项 | 结果 |
| --- | --- |
| 许可证与来源链 | TEI header、FreeDict、WikDict 和 Debian mirror 交叉核验通过 |
| TEI 翻译、英语释义、发音和词性解析 | Vitest 通过 |
| 下载大小和 SHA-256 | 完整官方资源通过 |
| Web CORS 真实下载 | Chromium 通过 |
| 完整安装、查询和 OPFS 持久化 | Chromium 通过 |
| 三词典排序、启停与断网查询 | Playwright 通过 |
| 自动生成质量提示 | 英/中/法 UI 与视觉检查通过 |
| 默认安装包不包含完整英汉数据 | 通过 |

自动 E2E 使用最小合法 TEI fixture 建立本地安装状态，避免 CI 依赖网络或提交 CC BY-SA
数据；真实完整文件另行通过固定 manifest 和网络路径验证。

## 限制与下一步

- 自动生成的中文翻译会有缺失、繁简混用或语义错误，不能当作权威词典；
- 2024.10.10 不是当前最新数据，选择它是为了可重复的跨平台 CORS 分发；
- 首次解析约 177 ms，后续需要 Worker 或 SQLite 优化；
- 尚未支持用户 StarDict 导入；
- 尚未实现本地 EN→ZH 句子翻译。

接受该实现作为 v0.1 英汉词典基线。下一步实现 StarDict 用户导入，让用户能够补充自己
合法持有且更符合学习需求的词典。
