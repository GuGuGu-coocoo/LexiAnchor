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
- 英汉：ECDICT，发布前进行来源和许可证抽查；
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
维护一份派生数据库。后续 FreeDict、英汉和用户词典仍统一转换为只读 SQLite 包；上层继续
使用同一个 Provider，因此该差异不会进入产品 UI。
