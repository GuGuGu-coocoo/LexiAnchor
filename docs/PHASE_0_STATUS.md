# Phase 0：仓库基础状态

> 日期：2026-07-24
>
> 分支：`main`
>
> 状态：实现已进入 `main`，等待 GitHub CI 与跨平台验证

## 已交付

- pnpm 11 monorepo；
- Node.js 24 LTS 版本约束；
- React 19 + TypeScript 6 + Vite 8 共享应用；
- Electron 43 + Electron Forge 7 桌面入口；
- Web/PWA 入口和离线应用壳；
- `domain`、`i18n`、`platform`、`ui`、`app` 包边界；
- 英语、简体中文、法语界面；
- 系统、浅色、深色、护眼主题；
- Home、书库、词卡基础导航；
- 最近阅读示例和百分比进度；
- Web 与 Electron 全屏适配；
- Electron sandbox、context isolation、白名单 IPC 和 fuses；
- ESLint、Prettier、TypeScript strict、Vitest、Playwright；
- Windows/macOS/Web GitHub Actions 工作流；
- Dependabot 周度依赖更新。

## 本机验证

| 检查 | 结果 |
| --- | --- |
| `pnpm peers check` | 通过 |
| `pnpm lint` | 通过 |
| `pnpm typecheck` | 通过 |
| `pnpm test` | 7 个测试通过 |
| `pnpm build:web` | 通过，PWA service worker 已生成 |
| `pnpm build:desktop` | 通过，生成 macOS arm64 `.app` |
| `pnpm test:e2e` | Chromium 2 个场景通过 |
| `pnpm audit --audit-level high` | 无已知漏洞 |

视觉检查覆盖 1440×900 桌面视口和 390×844 移动视口。

## 设计约束

本轮 UI 使用项目内的 `emil-design-eng` skill：

- 高频导航不使用进入/退出动画；
- 按压反馈只使用短时 `transform`；
- hover 只在精确指针设备生效；
- 支持 `prefers-reduced-motion`；
- 桌面使用侧栏，窄屏使用固定底部导航；
- 阅读内容区域保持安静，不使用装饰性动效。

## 已知工程约束

- Electron Forge Vite 插件仍为 experimental，版本必须固定；
- Forge 7 间接依赖的 `@electron/rebuild` 已覆盖到 4.0.4，以移除 Git 来源的
  `@electron/node-gyp`；
- Forge CLI 间接依赖的旧 `tmp` 已覆盖到 0.2.7，以修复安全公告；
- TypeScript 7 当前超出 `typescript-eslint` 8 的 peer 范围，因此锁定 TypeScript
  6.0.3；
- 依赖覆盖必须持续由 macOS/Windows 桌面打包任务验证；
- 当前桌面包未签名，macOS/Windows 可能显示系统安全提醒；
- Phase 0 只提供产品骨架，尚未接入真实 EPUB/PDF、SQLite、词典或翻译模型。

## Phase 0 仍需确认

- GitHub Actions 在 Windows、macOS 和 Linux 上全部通过；
- Windows 生成的桌面包可以启动；
- `main` 提交不包含书籍、词典、模型、数据库或秘密信息。

## 下一阶段

进入 Phase 1 技术 Spike，首先对 Readium Web 与 EPUB.js 做 3–5 天对比，重点验证：

1. 真实 EPUB 样本兼容性；
2. 阅读位置序列化稳定性；
3. 焦点加粗样式注入；
4. 选词与词典弹层锚点；
5. Web/Electron 共用成本。
