# SQLite WASM + OPFS 存储 Spike

- 日期：2026-07-24
- 结论：使用官方 `@sqlite.org/sqlite-wasm` 3.53.0-build1，在专用 Worker
  中通过 `opfs-sahpool` 持久化
- 状态：核心书库与阅读进度路径通过

## 目标

验证同一套 schema、migration 和 Repository 能否同时服务 Web/PWA 与 Electron，并满足：

1. 书籍二进制不进入业务数据库；
2. 导入后刷新或重启仍出现在书库与 Home；
3. EPUB CFI 和 PDF 页码进度可恢复；
4. SQLite 不阻塞 UI 主线程；
5. Web 断网后仍可打开已经导入的书；
6. 保留未来同步需要的稳定 ID、时间、版本和设备 ID。

## 选型

使用 SQLite 官方 WebAssembly 包的 OO API，在自有 Worker 中执行 Repository
命令。持久化 VFS 选择 `opfs-sahpool`，原因是：

- 官方文档建议无法或不希望依赖 COOP/COEP 响应头的单实例应用使用 SAH pool；
- LexiAnchor 采用单 Worker、单写连接，不需要多标签页并发写；
- SAH pool 可用于 Chromium、Firefox 和 Safari 的现代 OPFS 实现；
- SQLite 仍然运行在 Worker，UI 只接触类型化 Repository。

书籍文件由 `OpfsContentStore` 单独保存，文件名使用内容的 SHA-256；数据库只保存
`contentRef`、哈希、元数据和进度。Electron 的 OPFS 位于该应用自己的 Chromium
用户数据目录，Web 的 OPFS 位于站点私有存储。

参考：
[SQLite persistent storage options](https://sqlite.org/wasm/doc/tip/persistence.md)、
[SQLite WASM repository](https://github.com/sqlite/sqlite-wasm)、
[MDN OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)。

## Schema v1

- `schema_migrations`
- `books`
- `reading_progress`

`books` 包含稳定 ID、格式、内容引用/哈希、导入与最近打开时间、软删除时间和记录版本。
`reading_progress` 包含序列化 locator、百分比、设备 ID、更新时间和记录版本。

保存阅读进度与更新书籍最近打开时间位于同一事务。`SyncProvider` 和变更记录类型已经
定义，但没有网络实现，不会上传任何数据。

## Schema v2 增量

词卡闭环增加 `word_cards`，保存 PRD 要求的词语、词性、英语释义、可空词根/词源、来源
书籍、原句和创建时间，同时保存词典来源、更新时间、软删除时间和版本。相同规范化词语、
来源书名和原句只能存在一张活动词卡；删除后允许再次收藏。搜索当前覆盖词语、释义、书名和
原句，并完全在 SQLite Worker 中执行。

## 验收结果

| 验收项 | 结果 |
| --- | --- |
| migration 首次执行 | 通过 |
| migration 重复执行 | 通过 |
| 外键与百分比约束 | 通过 |
| Worker + SQLite WASM Web 生产构建 | 通过 |
| `opfs-sahpool` 实际启用 | Chromium 与 Electron 生产 bundle 通过 |
| 书籍 SHA-256 去重引用 | 通过 |
| 导入后刷新仍在书库/Home | 通过 |
| 清空 `localStorage` 后恢复 PDF 第 3 页 | 通过 |
| 清空 `localStorage` 后恢复 EPUB 第 2 章 CFI | 通过 |
| Web 离线重载并打开已导入 PDF | 通过 |
| Web 离线重载后查看、搜索和删除词卡 | 通过 |
| macOS Electron 打包 | 通过 |
| Windows 实机运行 | 待验证 |
| Safari/Firefox 实机运行 | 待验证 |

## 降级与限制

- OPFS/SAH 不可用时 SQLite 会退回本次会话内存数据库，并在界面显示持久化不可用；
- `ContentStore` 目前要求 OPFS，旧浏览器不能导入；
- 当前只支持单文件导入，尚未实现批量、拖放、删除和元数据编辑；
- 内容写入与数据库记录是两个步骤，异常中断可能留下没有引用的内容文件；后续需要孤儿清理；
- 尚未实现导出/恢复包、配额显示和 `navigator.storage.persist()` 请求；
- 词卡尚未实现编辑、导出/恢复和 10 万条压力验证；删除支持当前会话撤销；
- 跨标签页同时写、Windows、Safari 和 Firefox 仍需实机验证。

## 决策

接受该方案作为 v0.1 存储基线。继续锁定确切包版本，所有 schema 变化必须增加迁移和测试；
UI 不得直接执行 SQL。下一个存储增量优先实现删除/清理、配额提示和导出，而不是云同步。
