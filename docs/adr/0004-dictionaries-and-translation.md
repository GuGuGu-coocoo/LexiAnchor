# ADR-0004：开放词典与按需本地翻译

- 状态：Accepted with resource validation gates
- 日期：2026-07-24

## 决策

离线资源优先级：

1. 英英；
2. 英法；
3. 英汉。

初始候选：

- 英英：Princeton WordNet 3.1；
- 英法：FreeDict `eng-fra`；
- 英汉：FreeDict/WikDict `eng-zho` 2025.11.23；
- 词根/词源：Wiktionary/Kaikki 独立可选包。

翻译：

- 单词优先词典；
- EN→FR、EN→ZH 句子模型按需下载；
- Desktop 使用 ONNX Runtime Node；
- Web 使用 ONNX Runtime Web，WebGPU 优先、WASM 回退；
- 在线翻译必须由用户主动选择。

## 资源门禁

任何词典或模型进入正式清单前必须具备：

- 明确来源；
- 明确版本；
- 可再分发许可证；
- attribution；
- SHA-256；
- 大小；
- 删除方式；
- 至少一组质量测试。

## 代价

- 不同词典的数据结构和许可证不同；
- 模型可能达到数百 MB；
- Web 本地推理性能不保证与桌面一致。

## 缓解

- 统一资源 manifest；
- 按需下载；
- 词典只读 SQLite 转换；
- TranslationProvider 降级链；
- 不把模型和完整词典提交到 Git。

## WordNet 实现结果

英英基线已经实现：

- 固定 `wordnet-db` 3.1.14，随应用分发完整 WordNet 3.1；
- 通过 `DictionaryProvider` 隔离产品 UI 与具体数据格式；
- 浏览器直接查询原始 WordNet index/data，并按命中词性延迟加载 data；
- PWA 预缓存全部数据文件，断网查询通过；
- 资源 manifest 记录包 integrity、各文件大小和 SHA-256；
- 仓库保留完整 Princeton 声明，结果面板显示来源署名；
- 选择 EPUB/PDF 单词后本地查询，在线翻译与网页搜索只由用户主动触发。

完整证据见 [WordNet 离线英英词典 Spike](../spikes/0004-wordnet.md)。

内置 WordNet 暂不转换为 SQLite：其有序索引和字节偏移已经适合只读查询，直接分发可避免
维护一份派生数据库。v0.1 的 FreeDict 英法和 FreeDict/WikDict 英汉保留原始 TEI，并由
同一个 Provider 解析；更大的官方包和用户词典仍优先转换为只读 SQLite。格式差异不会进入
产品 UI。

## FreeDict 英法实现结果

英法基线已经实现：

- 选择 FreeDict `eng-fra` 0.1.6，共 8,799 个 headword；
- 不把完整 GPL 数据提交到应用仓库或打进默认安装包；
- 应用从固定 upstream commit 按需下载 TEI，manifest 记录版本、来源、许可证、
  文件大小和 SHA-256；
- 下载完成后先核对大小与 SHA-256，再解析验证，成功后写入 OPFS；
- 设置页提供安装、删除、启停、来源、许可证和键盘可操作的结果顺序；
- WordNet 与 FreeDict 通过同一个 `DictionaryProvider` 并发查询，按用户顺序显示；
- 已安装资源重载和断网后仍可查询；
- 8,799 个词条完整解析通过，当前开发机约 43 ms。

FreeDict 0.1.6 仅极少数词条携带词性，因此缺失值明确显示为“未知”，不推断或编造。
该版本直接保留 3.2 MB TEI，而不是预转换 SQLite；这是基于体积和实测解析成本做出的
v0.1 例外。后续大词典仍按架构基线转换为只读 SQLite。

完整证据见 [FreeDict English–French Spike](../spikes/0005-freedict-eng-fra.md)。

## FreeDict/WikDict 英汉实现结果

英汉基线已经实现：

- 选择 FreeDict/WikDict `eng-zho` 2025.11.23，共 26,660 个源 headword；
- 数据由 WikDict 从 Wiktionary 经 DBnary 自动生成，TEI header 明确为 CC-BY-SA-3.0；
- 从 WikDict 的浏览器可访问下载地址获取 TEI，并在写入前执行固定大小与 SHA-256 校验；
- 下载文件与 FreeDict 2025.11.23 官方源码归档中的 TEI 交叉审计；
- manifest 记录版本、来源、许可证、文件大小和 SHA-256；
- 设置页提供安装、删除、启停、来源、许可证、顺序与自动生成质量警告；
- 查询显示中文翻译和数据自带的英语释义；WordNet 仍保持默认第一顺序；
- 完整资源的覆盖度与解析耗时记录在资源 Spike 中；
- Web 真实跨域下载、完整安装、OPFS 持久化和断网查询通过。

ECDICT 不进入官方分发清单。尽管仓库标记 MIT，其 README 说明内容来自多类资料、抓取和
网友词库，缺少足够细粒度的数据权利链；这不满足本 ADR 的资源门禁。未来用户可自行通过
通用词典导入功能加载其合法持有的数据，但 LexiAnchor 不代为下载或再分发。

完整证据见
[FreeDict/WikDict English–Chinese Spike](../spikes/0006-freedict-eng-zho.md)。

## StarDict 用户导入实现结果

v0.1 支持用户选择一组同名、未压缩的 `.ifo + .idx + .dict`。导入在独立 Web Worker
中完成版本、元数据、词条数、索引大小、偏移边界、字段结构和 UTF-8 校验；通过后封装成单个
本地包并写入 OPFS。校验失败发生在写入前，不替换当前已安装的用户词典。

应用只提供通用格式能力，不代为获取或再分发用户数据；设置页明确说明内容与许可证由用户
负责。压缩变体、64 位索引、二进制媒体和多本用户词典不属于 v0.1 兼容范围。

完整证据见 [StarDict 用户词典导入 Spike](../spikes/0007-stardict-import.md)。
