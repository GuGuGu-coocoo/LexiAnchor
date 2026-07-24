# LexiAnchor 开发流程

> 版本：v1.0
>
> 状态：执行基线
>
> 日期：2026-07-24
>
> 适用方式：个人维护 + AI 协作

## 1. 流程目标

本流程用于确保：

- `main` 始终可构建、可测试；
- 每次修改范围小、可审查、可回退；
- 关键架构选择有 ADR；
- AI 生成的代码必须通过自动测试和人工验收；
- Windows、macOS 和 Web 的差异尽早暴露；
- 许可证、隐私和知识产权风险在提交与发布前可追踪。

## 2. 工作方式

第一版（`v0.1.0`）完成前采用直接 main development：

- `main` 是唯一开发分支和长期分支；
- 功能、修复和文档直接在本地 `main` 完成并推送；
- 每次提交保持单一目的、可测试、可回退；
- 推送前必须运行与改动风险相称的本地检查并审查 diff；
- 禁止 force push 或改写已推送的 `main` 历史；
- 大功能仍拆成垂直切片，不因省略 PR 而扩大单次改动。

`v0.1.0` 达到首个可用版本后，重新评估并恢复短分支 + Pull Request 流程。届时建议的分支命名为：

```text
feat/epub-import
feat/word-card-create
fix/pdf-selection-offset
spike/epub-engine
chore/upgrade-pdfjs
docs/storage-adr
```

### 2.1 Commit

使用 Conventional Commits：

```text
feat(reader): persist EPUB locator
fix(pdf): keep selection aligned after zoom
test(dictionary): cover priority fallback
docs(adr): choose Electron desktop shell
```

每个 commit 应能通过基础检查，不提交生成模型、真实书籍、密钥或大型词典文件。

## 3. Issue 模板

每项工作开始前至少写清：

```markdown
## Goal
用户或系统最终获得什么结果？

## Scope
包含哪些内容？

## Out of scope
明确不做什么？

## Acceptance criteria
- [ ] 可观察、可测试的结果

## Risks
数据迁移、隐私、许可证、跨平台或性能风险

## Test plan
单元、集成、E2E 和手动测试
```

如果 AI 无法根据 Issue 明确判断完成状态，Issue 还不具备开发条件。

## 4. AI 协作规则

由于维护者主要熟悉 Python，AI 协作遵循：

1. 开始前先让 AI 解释将修改的包、数据流和测试。
2. 一次只实现一个可演示的垂直切片。
3. 要求 AI 复用现有接口，不并行创造重复抽象。
4. 数据库修改必须同时提供 migration 和 migration test。
5. IPC 修改必须同时更新 TypeScript 类型和参数校验。
6. 第三方依赖必须说明用途、维护状态和许可证。
7. 大段自动生成代码必须拆分并运行测试。
8. 不以“能编译”代替真实行为验证。
9. 合并前查看 diff，不允许 AI 擅自删除不相关用户修改。
10. 复杂模块要求补充面向 Python 开发者的维护注释或文档。

## 5. 开发阶段

### Phase 0：仓库基础

产出：

- pnpm monorepo；
- React/TypeScript/Vite；
- Electron Forge；
- Web/PWA 入口；
- ESLint、Prettier、TypeScript strict；
- Vitest、Playwright；
- GitHub Actions；
- 基础 ADR 和文档索引。

完成门：

- Web 和 Electron 显示同一基础页面；
- Windows/macOS/Web CI 可构建；
- 无高危依赖告警；
- `main` 推送后自动运行 CI。

Phase 0 同时验证 Electron Forge Vite 插件。该插件当前为 experimental，因此需固定版本并保持 Vite 配置独立；若桌面打包不稳定，切换为独立 Vite 构建加 Forge 打包。

### Phase 1：技术 Spike

并行概念上独立，但个人开发时按顺序执行：

1. EPUB 内核对比；
2. PDF.js 文本层；
3. SQLite WASM + OPFS；
4. 词典包；
5. 本地翻译模型；
6. 无签名桌面包。

当前进度：

- [x] EPUB 内核对比：选择 EPUB.js 0.3.93，见
      `docs/spikes/0001-epub-engine.md` 与 ADR-0003；
- [x] PDF.js 文本层与 PDF 核心阅读切片：见
      `docs/spikes/0002-pdf-engine.md` 与 ADR-0003；100MB 压力验证仍待完成；
- [x] SQLite WASM + OPFS：`opfs-sahpool`、schema v1、书库与进度恢复通过，
      见 `docs/spikes/0003-sqlite-opfs.md` 与 ADR-0002；
- [x] WordNet 3.1 英英词典包：完整资源、离线查询、manifest 与许可门禁通过，
      见 `docs/spikes/0004-wordnet.md` 与 ADR-0004；
- [x] Bergamot EN→FR/EN→ZH 本地翻译：按需安装、完整性校验、Worker 推理与断网复用通过，
      见 `docs/spikes/0008-bergamot-local-translation.md` 与 ADR-0004；
- [ ] 无签名桌面包实机记录。

每个 Spike：

- 设置 timebox；
- 使用同一批测试样本；
- 记录性能和限制；
- 输出 `docs/spikes/<name>.md`；
- 更新对应 ADR；
- 删除无用实验代码。

Phase 1 结束前不大规模开发阅读 UI。

### Phase 2：EPUB 垂直切片

流程：

```text
导入 EPUB → 书库 → 打开 → 阅读 → 保存位置 → 重启恢复
```

随后加入：

- 目录；
- 主题与排版；
- 焦点加粗；
- 窗口/全屏；
- 中英法 UI 基础。

完成门：

- 三个平台使用同一测试书通过；
- 字号和窗口变化后位置稳定；
- 焦点加粗不改变复制文本；
- E2E 覆盖导入到恢复。

### Phase 3：PDF 垂直切片

核心路径已提前随 PDF Spike 完成；压力测试和 annotation layer 继续留在本阶段收尾。

流程：

```text
导入 PDF → 渲染 → 页码进度 → 选词 → 缩放后保持选择能力
```

完成门：

- 文本型 PDF 可选词；
- 扫描型 PDF 正确降级；
- 100MB 级压力样本不会使 UI 长时间无响应；
- 原文件不会被修改。

### Phase 4：词典与翻译

顺序：

1. WordNet 英英；
2. FreeDict 英法；
3. FreeDict/WikDict 英汉；
4. 词典顺序设置；
5. StarDict 用户导入；
6. EN→FR 本地句子翻译；
7. EN→ZH 本地句子翻译；
8. 在线翻译 adapter；
9. Search on Web。

当前进度：

- [x] WordNet 3.1 英英查询；
- [x] FreeDict 0.1.6 英法按需安装、校验、卸载与断网查询；
- [x] FreeDict/WikDict 2025.11.23 英汉按需安装、校验、卸载与断网查询；
- [x] 内置/已安装词典启停和结果顺序设置；
- [x] EPUB/PDF 选词结果面板；
- [x] 在线翻译首次使用提示与 Search on Web；
- [x] 用户 StarDict 词典导入（未压缩 `.ifo + .idx + .dict`）；
- [x] EN→FR、EN→ZH Bergamot 本地句子翻译。

完成门：

- 所有资源都有 manifest、许可证和 SHA-256；
- 断网可查三类已安装词典；
- 翻译运行不阻塞阅读；
- 在线请求必须由用户主动触发。

### Phase 5：词卡闭环

流程：

```text
选择文字 → 查词 → 编辑 → 添加词卡 → 搜索 → 删除/撤销
```

完成门：

- 保存 PRD 要求的全部字段；
- 重复收藏处理明确；
- 10 万词卡搜索仍可交互；
- 导出/导入往返无数据丢失。

当前进度：

- [x] 从 WordNet 结果保存词语、词性、英语释义、词根/词源空值、来源书籍、原句、词典来源和创建时间；
- [x] SQLite schema v2 本地持久化和精确上下文去重；
- [x] 按词语、释义、书名和原句搜索；
- [x] 软删除，并为未来同步保留版本和删除时间；
- [x] PWA 断网重载后查看、搜索和删除；
- [x] 删除后的当前会话撤销；
- [ ] 编辑和导出/导入；
- [ ] 10 万词卡压力测试和全文检索优化。

### Phase 6：Web/PWA 完整化

- 离线应用壳；
- 浏览器存储能力检测；
- 数据持久化请求；
- Web 模型降级；
- 存储配额提示；
- 数据导出与恢复；
- 浏览器兼容测试。

### Phase 7：稳定化与发布

- 跨平台回归；
- 无障碍审查；
- 性能预算；
- 安全检查；
- 依赖与数据许可证清单；
- Bionic Reading® 风险复核；
- Windows/macOS 便携 ZIP；
- Web/PWA 发布候选。

## 6. 每日开发循环

```text
选择 Issue
  → 明确验收标准
  → 先写或更新测试
  → 实现最小切片
  → 本地质量检查
  → 手动验证真实阅读流程
  → 更新文档/ADR
  → 审查 diff
  → 提交到 main
  → 推送并观察 CI
```

## 7. 本地质量命令

仓库初始化后统一提供：

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build:web
pnpm build:desktop
```

`pnpm check` 聚合推送前必须通过的快速检查：

```text
format:check + lint + typecheck + unit tests
```

## 8. 提交质量门

`v0.1.0` 前这些规则适用于直接推送 `main`；恢复 Pull Request 流程后，同一规则作为 PR 合并门。

### 8.1 必须通过

- 格式检查；
- lint；
- TypeScript strict typecheck；
- 单元测试；
- 受影响包集成测试；
- Web 构建；
- Electron 构建；
- 许可证和 secret 扫描；
- 无未说明的大型二进制。

### 8.2 按变更类型追加

| 变更 | 追加要求 |
| --- | --- |
| 数据库 | migration、回滚/恢复说明、迁移测试 |
| EPUB/PDF | 测试书矩阵、位置/选词手测 |
| UI | 键盘、屏幕阅读器、三主题、减少动态效果 |
| IPC | schema 校验、安全边界测试 |
| 词典/模型 | 来源、许可证、哈希、大小、删除路径 |
| 在线服务 | 隐私提示、超时、离线降级、密钥处理 |
| 发布 | 全新机器或干净 VM 验证 |

## 9. Definition of Ready

Issue 满足以下条件才进入开发：

- 用户价值明确；
- 范围和非范围明确；
- 验收标准可测试；
- 已识别平台差异；
- 已识别数据/许可证/隐私风险；
- 没有未解决的架构冲突；
- 大于一个垂直切片的工作已拆分。

## 10. Definition of Done

功能完成必须同时满足：

- 验收标准全部通过；
- 代码、测试和文档已提交；
- 无新增 TypeScript 错误；
- 无未处理高危安全问题；
- 跨平台降级已验证；
- 不记录敏感内容；
- 数据可迁移、可恢复；
- 许可证来源可追踪；
- diff 已审查，改动已提交到 `main`；
- 对应 Issue 已关闭。

## 11. CI 设计

### 11.1 Main Push

- `quality`：format、lint、typecheck；
- `unit`：Vitest；
- `integration`：SQLite、词典、adapter；
- `web-e2e`：Playwright Chromium，定期扩展 Firefox/WebKit；
- `build-web`；
- `build-desktop-windows`；
- `build-desktop-macos`；
- `security`：secret 和依赖扫描。

### 11.2 Nightly

- 完整浏览器矩阵；
- Electron E2E；
- 大型样本性能测试；
- 数据迁移链；
- 未签名便携包；
- 生成 SHA-256 和第三方清单。

### 11.3 Release Candidate

- 固定依赖；
- 从干净环境构建；
- Windows/macOS 实机验证；
- Web 离线验证；
- 许可证审计；
- 生成 SBOM；
- 备份/恢复演练。

## 12. 测试数据

仓库只保存：

- 公版或自制 EPUB；
- 自制文本型 PDF；
- 自制扫描型 PDF；
- 最小合法词典样本；
- 小型假模型或 mocked inference。

真实购买书籍、完整第三方词典和生产模型不进入 Git。

## 13. 数据库变更流程

1. 修改 schema 定义。
2. 新增不可变 migration 文件。
3. 添加从上一版本升级的测试。
4. 添加从空数据库初始化的测试。
5. 验证 Web 和 Electron 使用同一 migration。
6. 记录是否影响导出格式和未来同步。
7. 禁止修改已经发布的 migration。

## 14. 依赖升级

- 使用自动化工具提出升级 PR；
- 每次只升级相关依赖组；
- 阅读 renderer、PDF.js、EPUB、Electron 和 Bergamot WASM 属于高风险依赖；
- 高风险升级必须运行真实书籍和模型回归；
- 不因追求最新版本而绕过稳定性验证。

## 15. 发布流程

### 15.1 版本

MVP 前使用 `0.x.y`：

- `0.x.0`：里程碑功能；
- `0.x.y`：修复和小改进；
- `1.0.0`：满足 MVP 验收标准并完成公开发布门槛。

### 15.2 无签名桌面产物

- Windows：便携 ZIP；
- macOS：应用 ZIP；
- 每个产物提供 SHA-256；
- Release Notes 明确未签名；
- 文档准确描述系统可能显示的安全提示；
- 不承诺静默安装或自动更新。

### 15.3 Web

- 构建不可变静态资源；
- Service Worker 版本与应用版本一致；
- 数据库 migration 在应用启动时执行；
- 发布前测试旧版本升级和离线启动。

## 16. 文档维护

以下变更必须同步文档：

- 产品范围变化：`PRD.md`；
- 技术边界变化：`TECHNICAL_ARCHITECTURE.md`；
- 开发/发布流程变化：本文件；
- 单项架构决策：`docs/adr/`；
- 技术实验：`docs/spikes/`；
- 第三方资源：`docs/licenses/` 和 `THIRD_PARTY_NOTICES.md`。
