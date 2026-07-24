# Phase 1：阅读内核状态

> 日期：2026-07-24
>
> 分支：`main`
>
> 状态：EPUB/PDF、持久化和离线英英查词核心路径已进入 `main`

## 当前可实际操作的能力

- 从本机导入无 DRM 的 EPUB 2、EPUB 3 和 PDF；
- EPUB 分页/连续滚动、字号、行距、词间距和主题颜色；
- EPUB 与文本型 PDF 的选词、原句提取和焦点加粗；
- PDF 75%–200% 缩放、上一页/下一页、页码跳转和百分比进度；
- 扫描型 PDF 按图片阅读，并明确禁用没有文本层的能力；
- EPUB CFI 位置恢复；
- PDF 页码与缩放比例恢复；
- 导入书籍保存到私有 OPFS，并以 SHA-256 内容引用去重；
- SQLite WASM Worker 保存书籍元数据、最近阅读与进度；
- Home 和书库显示真实导入书籍；
- Web 断网重载后可继续打开已导入 PDF；
- Web/PWA 与 Electron 使用同一 React 阅读界面和 adapter。
- EPUB/PDF 选择英文单词后自动查询完整 WordNet 3.1；
- 显示词性、英语释义、相关词、例句和可见来源署名；
- PWA 预缓存词典，断网后仍可查词；
- 在线翻译首次使用前提示发送的最小选中文本；
- 始终提供由用户主动触发的 Search on Web；
- 词典资源具有固定版本、许可证、大小和 SHA-256 清单。

## 验证基线

| 检查 | 结果 |
| --- | --- |
| `pnpm check` | 通过 |
| Vitest | 4 个文件、14 个测试通过 |
| Playwright | 11 个 Chromium 场景通过 |
| `pnpm build:web` | 通过，PDF、SQLite worker 和 WASM 均形成生产资源 |
| `pnpm build:desktop` | 通过，生成 macOS arm64 `.app` |
| `pnpm audit --audit-level high` | 无已知漏洞 |
| Electron 运行探针 | 生产 bundle 窗口启动，`opfs-sahpool` 生效 |
| 视觉检查 | PDF 文本/扫描/390px 窄窗口与持久化书库通过 |

Playwright 当前覆盖：

1. Home 与导航；
2. EPUB 3 加载、选词、焦点加粗、翻页和恢复；
3. 本地 EPUB 2 导入；
4. 本地文本型 PDF 导入、选词、焦点加粗、缩放、翻页和恢复；
5. 本地扫描型 PDF 导入和能力降级；
6. SQLite/OPFS 中的 PDF、EPUB 与进度在清空 `localStorage` 后恢复；
7. Web 离线重载并打开已导入 PDF；
8. 390px 窄窗口 PDF 阅读。

## 仍未达到首个可用版本的部分

- 英法、英汉词典和用户词典导入尚未实现；
- 本地 EN→FR、EN→ZH 句子翻译模型尚未实现；
- 词典启停和查询顺序设置尚未实现；
- 词卡创建、搜索、删除和来源上下文尚未实现；
- EPUB 目录和 PDF annotation layer 尚未实现；
- 100MB PDF 压力测试、Windows 实机启动和无签名分发验证尚未完成；
- 书库尚未支持批量导入、拖放、搜索、删除和元数据编辑；
- 尚未提供本地数据导出、配额提示和孤儿内容清理。

## 下一步

进入词卡垂直切片：

```text
选择单词 → 本地英英查询 → 添加词卡 → 搜索 → 删除/撤销
```

随后让 FreeDict 英法、英汉和用户词典导入接入现有 provider 边界。
