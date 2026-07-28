# LexiAnchor 试用与验收指南

> 适用版本：`0.1.0` 开发测试版
>
> 数据策略：书籍、进度、词典、翻译模型和词卡默认只保存在当前设备

## 1. 最快启动方式

环境要求：

- Node.js 24 LTS；
- pnpm 11；
- macOS 或 Windows。

首次运行：

```bash
pnpm install
pnpm dev:web
```

浏览器打开终端显示的本地地址（默认 `http://localhost:5173`）。Web 版支持安装为 PWA，
并可在完成一次在线加载后离线启动。

桌面开发版：

```bash
pnpm dev:desktop
```

生成本机桌面测试包：

```bash
pnpm --filter @lexianchor/desktop make
```

当前 macOS Apple Silicon 产物为
`apps/desktop/out/make/zip/darwin/arm64/LexiAnchor-darwin-arm64-0.1.0.zip`，
本次本地构建的 SHA-256 为
`fa4c0e499298bb09c17d6fd45be72dc414ee3437fb3bf28af5bec34d682dfbec`。
测试包未签名；如果 macOS 阻止首次打开，请在 Finder 中右键应用并选择“打开”，
确认你信任自己的本地构建。

## 2. 建议的 15 分钟验收流程

### 导入和书库

1. 进入“书库”；
2. 批量选择或拖放一组无 DRM 的 `.epub` / `.pdf`；
3. 确认批量导入后仍停留在书库，单本导入会直接进入阅读；
4. 搜索书名或作者，切换四种排序；
5. 编辑书名、作者和语言，重载后确认仍然保留。

仓库内置三份合法测试材料：

- EPUB 3：`packages/test-fixtures/generated/lexianchor-spike.epub`；
- 文本型 PDF：`packages/test-fixtures/generated/lexianchor-text.pdf`；
- 图片型 PDF：`packages/test-fixtures/generated/lexianchor-scan.pdf`。

### EPUB 阅读

1. 打开 EPUB；
2. 用目录、上一页/下一页、方向键和 Page Up/Page Down 导航；
3. 切换分页/连续滚动；
4. 调整字号、字重、字体、行距、字距、词距、正文宽度和对齐；
5. 开关焦点加粗，并比较弱/中/强三级；
6. 关闭再打开书籍，确认章节位置和排版设置恢复。

### PDF 阅读

1. 打开文本型 PDF；
2. 测试 75%–200% 缩放、页码输入和上一页/下一页；
3. 点击第一页的外部链接和内部跳页链接；
4. 选择文字并测试查词、翻译和焦点加粗；
5. 打开图片型 PDF，确认页面可见，同时显示“没有可选择文本”的诚实降级提示。

### 查词、翻译和词卡

1. 在 EPUB 或文本型 PDF 中选择英文单词；
2. 确认 WordNet 英英释义离线可用；
3. 在设置中按需安装英法、英汉词典，或导入自己的 StarDict 三文件词典；
4. 可选安装 EN→FR / EN→ZH Bergamot 本地翻译模型；
5. 把查词结果保存为词卡，编辑后用词语、释义、词根、书名或原句搜索；
6. 删除一张词卡并测试撤销；
7. 导出词卡 JSON，再导入验证往返。

### 数据保护

1. 在“设置 → 本地存储”检查用量、配额和持久化状态；
2. 主动申请浏览器持久存储保护；
3. 导出完整应用备份，可选择是否包含原始书籍；
4. 在独立浏览器配置或清空测试数据后恢复备份；
5. 确认书库、进度、词卡和设置恢复，并能继续阅读。

## 3. 当前明确边界

- 只支持无 DRM 的 EPUB 2/3 和 PDF；
- 不破解 DRM；
- 不提供 OCR，扫描 PDF 只能按图片查看；
- PDF 当前为单页查看，不提供连续滚动和缩略图；
- 书库暂未提供列表视图和自定义封面；
- Windows 实机和未签名分发仍需要在 Windows 环境完成最终验证；
- 在线翻译和网页搜索只在用户主动操作后发送当前选中文字。

## 4. 回归命令

```bash
pnpm check
pnpm test:e2e
pnpm build:web
pnpm build:desktop
```

可选 100MB PDF 压力测试：

```bash
LEXIANCHOR_LARGE_PDF=/absolute/path/to/a-100mb-test.pdf \
  pnpm exec playwright test -g "opens an optional 100 MB PDF stress fixture"
```

压力材料必须是自制或公版文件，不要把购买书籍提交到 Git。

## 5. 反馈时建议附带

- Web 或 Desktop；
- 操作系统、浏览器/Electron 版本；
- EPUB/PDF 类型和大致大小（不要上传无权分享的书籍）；
- 复现步骤；
- 是否能在仓库测试夹具中复现；
- 控制台错误或截图；
- 是否处于离线状态，以及相关词典/模型是否已安装。
