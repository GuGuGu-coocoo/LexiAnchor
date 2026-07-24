# Phase 1：阅读内核状态

> 日期：2026-07-24
>
> 分支：`main`
>
> 状态：EPUB 与 PDF 核心阅读路径已进入 `main`

## 当前可实际操作的能力

- 从本机导入无 DRM 的 EPUB 2、EPUB 3 和 PDF；
- EPUB 分页/连续滚动、字号、行距、词间距和主题颜色；
- EPUB 与文本型 PDF 的选词、原句提取和焦点加粗；
- PDF 75%–200% 缩放、上一页/下一页、页码跳转和百分比进度；
- 扫描型 PDF 按图片阅读，并明确禁用没有文本层的能力；
- EPUB CFI 位置恢复；
- PDF 页码与缩放比例恢复；
- Web/PWA 与 Electron 使用同一 React 阅读界面和 adapter。

## 验证基线

| 检查 | 结果 |
| --- | --- |
| `pnpm check` | 通过 |
| Vitest | 2 个文件、7 个测试通过 |
| Playwright | 6 个 Chromium 场景通过 |
| `pnpm build:web` | 通过，PDF reader 和 worker 按需加载 |
| `pnpm build:desktop` | 通过，生成 macOS arm64 `.app` |
| `pnpm audit --audit-level high` | 无已知漏洞 |
| PDF 视觉检查 | 文本型 3 页、扫描型 1 页、720px 窄窗口通过 |

Playwright 当前覆盖：

1. Home 与导航；
2. EPUB 3 加载、选词、焦点加粗、翻页和恢复；
3. 本地 EPUB 2 导入；
4. 本地文本型 PDF 导入、选词、焦点加粗、缩放、翻页和恢复；
5. 本地扫描型 PDF 导入和能力降级。

## 仍未达到首个可用版本的部分

- 书库、最近阅读和进度仍是演示数据，没有持久化数据库；
- 查词弹层、离线词典、在线翻译和 Search on Web 尚未实现；
- 词卡创建、搜索、删除和来源上下文尚未实现；
- EPUB 目录和 PDF annotation layer 尚未实现；
- 100MB PDF 压力测试、Windows 实机启动和无签名分发验证尚未完成；
- 当前本机文件在一次阅读结束后不会留在真实书库中。

## 下一步

进入本地持久化垂直切片：

```text
导入书籍 → 保存书籍元数据与内容 → 书库显示 → 打开阅读 → 保存进度 → 重启恢复
```

实现时保留 `SyncProvider` 接口，但本阶段不接入账号或跨设备同步。
