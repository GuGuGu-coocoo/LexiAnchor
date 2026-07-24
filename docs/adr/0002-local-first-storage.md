# ADR-0002：统一 SQLite schema 与平台内容存储

- 状态：Accepted
- 日期：2026-07-24

## 背景

用户要求 Web 与桌面本地保存体验一致，同时未来需要预留跨设备同步。

## 决策

- Web 和 Electron 使用相同 SQLite schema、migration 和 Repository；
- SQLite WASM 在 Worker 中运行并持久化到 OPFS；
- EPUB/PDF、词典和模型不存入业务数据库；
- 桌面大型内容使用应用数据目录，Web 使用 OPFS；
- 通过 ContentStore 屏蔽物理存储差异；
- 导出领域记录，不同步原始数据库文件。

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

## 缓解

- 能力检测；
- 单写连接；
- 定期可见的导出提醒；
- 内容哈希和引用计数；
- Web/桌面共享迁移测试。
