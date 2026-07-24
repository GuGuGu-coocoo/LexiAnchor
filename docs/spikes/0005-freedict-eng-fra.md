# FreeDict English–French 离线词典 Spike

- 日期：2026-07-24
- 结论：v0.1 使用 FreeDict `eng-fra` 0.1.6 作为按需安装的英法词典
- 状态：资源核验、安装/删除、查询顺序和断网使用通过

## 目标

验证第二个正式词典 Provider 能否满足：

1. 不增大默认安装包，用户需要时再安装；
2. Web/PWA 与 Electron 共用下载、校验、存储和查询实现；
3. 安装后无需网络即可与 WordNet 同时查询；
4. 用户能够启停词典并调整结果顺序；
5. 来源、版本、许可证、署名、大小、校验和及删除方式可审计；
6. 数据缺少词性时诚实显示未知，不编造信息。

## 资源与许可证

选择 FreeDict 的 English–French 0.1.6：

- 8,799 个 headword；
- TEI 文件大小 3,329,108 字节；
- TEI SHA-256：
  `5b7e1f657c5902f10ace0a31a6ffa3702ac0b5a49dfcc66883040c2a5e05a9a6`；
- 上游源码归档 SHA-256：
  `22dd26b7ff92007042ced20c2379bd3b182019758c3d58318c24e99206765d0b`；
- 许可证：GPL-2.0-or-later；
- 署名：English-French FreeDict Dictionary 0.1.6，© 1999–2017
  FreeDict contributors。

每个 FreeDict 词典的许可位于各自 TEI header，不能用项目级概述替代逐包核对。本项目不把
完整词典提交到 Git 或打进默认安装包；应用从固定上游 commit 直接下载，并在设置页提供
来源、许可证与删除入口。可审计清单位于
`packages/dictionary/resources/freedict-eng-fra.manifest.json`。

参考：

- [FreeDict documentation](https://freedict.org/documentation/)
- [FreeDict eng-fra 0.1.6 distribution](https://download.freedict.org/dictionaries/eng-fra/0.1.6/)
- [Pinned eng-fra source](https://github.com/freedict/fd-dictionaries/tree/5bdceeac8d0dba3298c1bebe734f60d54dad30f7/eng-fra)
- [GNU GPL v2](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html)

## 实现

`FreeDictEnglishFrenchProvider` 复用现有 `DictionaryProvider`：

1. 从 manifest 中固定的 HTTPS 地址下载；
2. 核对响应文件大小；
3. 使用 Web Crypto 核对 SHA-256；
4. 以严格 UTF-8 解码并解析 TEI，确认至少存在可读词条；
5. 写入 OPFS `lexianchor/dictionaries`；
6. 查询时加载本地文件，解析并缓存规范化 headword 索引；
7. 删除时移除 OPFS 文件并清空内存缓存。

WordNet 和 FreeDict 由 UI 按用户配置并发查询，因此慢或失败的单个 Provider 不会阻止另一个
Provider 返回。显示顺序、启用状态保存在本地设置中。保存词卡时仍优先使用英英结果作为
必填英语释义，避免把法语翻译误存为英语释义。

## 格式与性能结论

源数据几乎没有结构化词性：8,799 个 headword 中只有极少数 `<pos>`。实现只映射明确提供的
词性，其余标记为 `unknown`。发音和多个法语 `<quote>` 在存在时保留。

完整固定资源验证结果：

| 项目 | 结果 |
| --- | --- |
| TEI 可解析 headword | 8,799 |
| `attentive` 查询 | 命中 `attentif` |
| 完整解析耗时 | 当前开发机约 43 ms |
| 下载大小和 SHA-256 | 与 manifest 一致 |

3.2 MB TEI 的一次性解析成本目前足够小，因此 v0.1 保留原始 TEI，避免维护派生数据包。
如果后续词典数量或体积明显增加，再转换为只读 SQLite 或移入 Worker。

## 验收结果

| 验收项 | 结果 |
| --- | --- |
| TEI 解析、发音、词性和多个翻译 | Vitest 通过 |
| 下载大小和 SHA-256 拒绝错误资源 | Vitest 通过 |
| 安装、存储、查询和删除生命周期 | Vitest 通过 |
| 完整 8,799 词条解析 | 本地完整资源验证通过 |
| 设置页安装状态、启停和顺序持久化 | Playwright 通过 |
| WordNet + FreeDict 按顺序同时显示 | Playwright 通过 |
| 断网后查询已安装 FreeDict | Playwright 通过 |
| Web 生产构建 | 通过 |

自动 E2E 使用最小合法 TEI fixture 直接建立已安装状态，避免 CI 依赖网络或提交 GPL 数据；
真实完整文件另外按 manifest 做本地解析与校验验证。

## 限制与下一步

- FreeDict 0.1.6 数据较旧，覆盖度和释义质量不等同于现代商业词典；
- 大部分词条没有词性，当前明确显示未知；
- 尚未支持用户 StarDict 导入；
- 尚未实现本地 EN→FR 或 EN→ZH 句子翻译；
- 资源解析仍在 UI 进程发生，完整包实测约 43 ms；若资源增长则迁移到 Worker。

接受该实现作为 v0.1 英法词典基线。英汉候选审计与实现见
[FreeDict/WikDict English–Chinese Spike](./0006-freedict-eng-zho.md)，下一步实现用户
StarDict 导入。
