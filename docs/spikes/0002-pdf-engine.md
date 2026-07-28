# PDF 阅读内核 Spike

- 日期：2026-07-24
- 结论：v0.1 使用 PDF.js 6.1.200 的 display layer，通过
  `@lexianchor/reader-pdf` 隔离
- 状态：核心能力与 100MB 级自制压力样本通过

## 目标

验证 PDF.js 是否能在 Web 和 Electron 共用的阅读界面中满足：

1. 保持 PDF 原始版式；
2. 文本层选择和原句提取；
3. 缩放后继续选择；
4. 焦点加粗只覆盖文本层，不修改原文件；
5. 无文本层页面按图片阅读；
6. 页码进度和重新打开恢复；
7. 中英文与法语重音字符正常显示。

## 测试资产

项目使用自制、可重复生成的合法夹具：

- `lexianchor-text.pdf`：3 页，包含英文、法语重音和中文，具有可选文本层；
- `lexianchor-scan.pdf`：1 页，文字已栅格化，不含可提取文本；
- `packages/test-fixtures/pdf/generate.py`：使用固定版本的 ReportLab、Pillow 和
  pypdf 生成夹具。

两份文件均不含 DRM、远程资源、嵌入脚本或第三方受版权保护段落。文本型夹具经 pypdf
提取到 992 个字符；扫描型夹具提取到 0 个字符。所有页面还通过 Poppler 渲染成 PNG
进行人工视觉检查。

大文件检查不把 100MB 二进制提交进 Git。生成或准备合法样本后，可重复运行：

```bash
LEXIANCHOR_LARGE_PDF=/absolute/path/to/large.pdf \
  pnpm exec playwright test tests/e2e/app.spec.ts -g "100 MB"
```

## 实现边界

- 使用 PDF.js display layer 的 `getDocument`、页面 canvas render 和 `TextLayer`；
- 使用独立 Web Worker，worker 与 PDF 阅读代码都按需加载；
- 当前只渲染正在阅读的页面，翻页或缩放时取消旧任务；
- 设备像素倍率上限为 2，避免高 DPI 屏幕产生无界 canvas 内存；
- 焦点加粗读取原始文本层坐标，在独立覆盖层绘制可撤销前缀，不改写文本层或 PDF；
- 文本型和扫描型 PDF 共用阅读页，能力根据当前页文本层自动降级；
- 阅读视图把页码和缩放比例保存到本机 `localStorage`。

参考：
[PDF.js Getting Started](https://mozilla.github.io/pdf.js/getting_started/?lang=en)、
[PDF.js Examples](https://mozilla.github.io/pdf.js/examples/)、
[PDF.js repository](https://github.com/mozilla/pdf.js)。

## 验收结果

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 本地 PDF 导入 | 通过 | Playwright 从文件选择器导入 `ArrayBuffer` |
| 原版式渲染 | 通过 | 3 页文本夹具和 1 页扫描夹具人工视觉检查 |
| 英文/法语/中文 | 通过 | 文本型夹具页面 1–3 |
| 文本选择与原句 | 通过 | 自动选择 `resilient` 并匹配完整原句 |
| 三级焦点加粗 | 通过 | 弱/中/强共用产品规则，独立覆盖层产生对齐前缀，原始文本层与 canvas 不变 |
| 75%–200% 缩放 | 通过 | 自动化在 150% 重新渲染并继续翻页 |
| 页码与进度 | 通过 | 1/3 显示 33%，3/3 显示 100% |
| PDF 链接 | 通过 | link annotation overlay 支持内部跳至第 3 页；HTTP/HTTPS 外链交给平台桥接 |
| 重新打开恢复 | 通过 | 恢复第 3 页和 150% 缩放 |
| 无文本层降级 | 通过 | canvas 可见，文本层为空，选词能力自动禁用 |
| Web 生产构建 | 通过 | PDF.js 阅读器与 worker 形成独立延迟加载 chunk |
| Electron 构建 | 通过 | macOS arm64 应用打包成功 |
| 100MB 级压力样本 | 通过 | 110,140,568 字节自制样本完成导入、首屏渲染和翻页 |

## 发现并修复的问题

1. PDF.js 6 的现代 browser build 依赖浏览器 DOM API，不能把 Node 直接 import
   当作运行验证；实际能力必须通过浏览器/Electron 测试。
2. worker 的 `?url` 类型声明需要随 adapter 入口引入，才能让上层 workspace 包通过
   TypeScript 检查。
3. 缩放 range 起初没有可访问名称；补充 `aria-label` 后可以由键盘、辅助技术和
   Playwright 稳定定位。
4. PDF.js 默认 viewer CSS 较大，因此 PDF 阅读页和 worker 必须延迟加载，不能进入
   Home 或 EPUB 的首屏 bundle。
5. 自定义 page 容器必须设置 PDF.js 的 `--total-scale-factor`。缺少它时，透明文本层
   的选区仍存在，但字体度量与 canvas 不一致，焦点前缀会明显错位；修正后已在 115%
   与 150% 缩放下通过截图检查。
6. 快速连续切换焦点开关和强度时，旧渲染任务会在等待文本内容期间读到被新任务清空的共享
   `renderTask`；改为保存本次任务引用并校验渲染代次，过期任务只取消自身且不能覆盖新页面。
7. PDF.js 完整 viewer 的 link service 会扩大产品层依赖面；当前 adapter 只读取 `Link`
   annotation，验证矩形与目标后绘制透明 overlay。内部目标解析为页码，外部目标只接受
   HTTP/HTTPS 并交给 Web/Electron 平台桥接。

## 当前限制

- 只显示单页，不提供连续滚动和缩略图导航；
- 不提供 OCR，扫描 PDF 只能查看；
- 当前进度精度为页码，不包含页内滚动位置；
- 尚未验证密码保护或加密 PDF；产品范围仍只接受无 DRM 文件；
- 尚未完成 Windows 实机启动验证；100MB 合成基线已通过，后续继续增加真实公版大文件矩阵。

## 决策

PDF.js 6.1.200 满足 v0.1 文本型 PDF 的核心路径，并能对扫描件做诚实降级。保留自定义
viewer，避免复制完整默认 viewer；所有 PDF.js API 继续限制在
`@lexianchor/reader-pdf`。110,140,568 字节自制压力样本已通过；在进入首个公开测试版前
继续补充真实公版大文件矩阵和 Windows 实机验证，OCR 不进入 MVP。
