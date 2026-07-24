# ADR-0001：使用 Electron、React 与 TypeScript

- 状态：Accepted
- 日期：2026-07-24

## 背景

LexiAnchor 需要同时支持 Windows、macOS 和 Web，并保证 EPUB/PDF 渲染、文本选择和本地模型行为尽量一致。项目由只熟悉 Python 的个人开发者维护，主要借助 AI 协作。

## 决策

- 共享应用使用 React + TypeScript + Vite；
- 桌面壳使用 Electron；
- Web 构建为 PWA；
- 不同时维护 Tauri 壳；
- Electron renderer 禁止直接使用 Node API。

## 原因

- Electron 自带 Chromium，减少 Windows/macOS 系统 WebView 差异；
- Node 和 Utility Process 适合文件管理及本地模型；
- Web 和桌面可以共享大部分 TypeScript；
- 相比 Rust 主线，更符合维护者当前能力和 AI 协作需求。

## 代价

- 安装包和内存占用高于 Tauri；
- 必须持续跟进 Electron 安全更新；
- main/preload/renderer 边界增加工程复杂度。
- Electron Forge 的 Vite 插件当前仍为 experimental，升级时可能出现破坏性变化。

## 缓解

- 单窗口优先；
- 重任务放入 Utility Process/Worker；
- 使用 sandbox、context isolation 和白名单 IPC；
- 依赖版本固定并定期升级。
- 保持独立 Vite 配置；必要时绕过 Forge Vite 插件，以独立 Vite 构建结果交由 Forge 打包。
