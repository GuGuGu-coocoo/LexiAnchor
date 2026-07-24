# ADR-0004：开放词典与按需本地翻译

- 状态：Accepted with resource validation gates
- 日期：2026-07-24

## 决策

离线资源优先级：

1. 英英；
2. 英法；
3. 英汉。

初始候选：

- 英英：Princeton WordNet；
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
