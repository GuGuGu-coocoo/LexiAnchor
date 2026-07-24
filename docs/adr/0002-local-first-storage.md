# ADR-0002：统一 SQLite schema 与平台内容存储

- 状态：Accepted
- 日期：2026-07-24

## 背景

用户要求 Web 与桌面本地保存体验一致，同时未来需要预留跨设备同步。

## 决策

- Web 和 Electron 使用相同 SQLite schema、migration 和 Repository；
- SQLite WASM 3.53.0 在自有 Worker 中运行，通过 `opfs-sahpool` 持久化到
  OPFS；
- EPUB/PDF、词典和模型不存入业务数据库；
- 桌面大型内容使用应用数据目录，Web 使用 OPFS；
- 通过 ContentStore 屏蔽物理存储差异；
- 导出领域记录，不同步原始数据库文件。

## 实现结果

- Schema v1 已包含 `schema_migrations`、`books` 和 `reading_progress`；
- Schema v2 增加 `word_cards`、上下文去重索引、搜索索引与软删除字段；
- 书籍内容以 SHA-256 为 key 保存在 `OpfsContentStore`，SQLite 只保存引用；
- 保存进度和更新最近打开时间使用同一事务；
- EPUB CFI 与 PDF 页码/百分比均可在清空 `localStorage` 后恢复；
- Web 已验证离线重载和打开导入书籍；
- Electron 生产 bundle 已验证 `opfs-sahpool`，macOS arm64 打包通过；
- `SyncProvider` 接口已保留，没有网络实现；
- 词卡在 Web/Electron 共用 Worker 中保存，可断网搜索和软删除；
- 详细证据见 [SQLite WASM + OPFS 存储 Spike](../spikes/0003-sqlite-opfs.md)。

## 一致性定义

一致的是数据字段、迁移、业务规则、导入导出和用户行为；平台文件 API 可以不同。

## 原因

- SQLite schema 容易测试、迁移和用 Python 工具检查；
- Worker 避免数据库阻塞 UI；
- 分离大文件降低数据库膨胀和备份成本；
- 记录级同步比数据库文件同步更适合未来冲突解决。

## 风险

- OPFS 受浏览器配额和站点数据清理影响；
- 不同浏览器的锁和 Worker 行为可能存在差异；
- Electron 中同时存在 OPFS 和系统文件目录。
- SAH pool 适合单实例访问，不承诺多标签页并发写。

## 缓解

- 能力检测；
- 单写连接；
- 定期可见的导出提醒；
- 内容哈希和引用计数；
- Web/桌面共享迁移测试。
- OPFS 不可用时明确显示临时内存降级，不静默声称已持久化。
