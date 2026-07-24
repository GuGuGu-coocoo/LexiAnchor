# EPUB 阅读内核 Spike

- 日期：2026-07-24
- 结论：v0.1 选择 EPUB.js，通过 `ReaderEngine` adapter 隔离
- 对比对象：EPUB.js 0.3.93、Readium Web TypeScript toolkit

## 目标

用相同的产品约束比较两个内核，而不是只比较演示页面：

- Web 与 Electron 共享同一套阅读逻辑；
- 本地直接导入无 DRM 的 `.epub`；
- 支持分页、连续滚动和稳定位置；
- 能改变字号、行距、词间距和颜色；
- 能注入 LexiAnchor 自己的焦点加粗；
- 能获得选中内容、原句和可序列化位置；
- 不破坏标题、正文等无障碍语义；
- 默认不执行书内脚本或弹窗。

## 测试材料

仓库包含两本完全由 LexiAnchor 项目自写的测试书：

- `lexianchor-spike.epub`：EPUB 3，两章，用于重排、选词、原句、CFI、样式和焦点加粗；
- `lexianchor-epub2.epub`：EPUB 2，NCX 目录，用于旧格式兼容。

源文件保存在 `packages/test-fixtures/epub` 与 `packages/test-fixtures/epub2`，生成文件保存在
`packages/test-fixtures/generated`。两本书都不含 DRM、远程资源或第三方版权内容。

## 官方资料核验

### EPUB.js

- 当前 npm 版本为 0.3.93，许可证为 BSD-2-Clause；
- npm 最后更新时间是 2023-09-26；
- 内置 TypeScript 声明，但 `Rendition.getContents()` 的声明与运行时返回值不一致；
- 可直接读取 URL 或本地 `ArrayBuffer`，很适合当前“本地优先 + Web/Electron 共用”的边界。

参考：[EPUB.js 仓库](https://github.com/futurepress/epub.js/)、[npm 包](https://www.npmjs.com/package/epubjs)。

### Readium Web

- Readium 官方把 Web 方案拆成 Go toolkit 和 TypeScript toolkit；
- Go toolkit 负责把 EPUB 等打包出版物转换为 HTTPS 上的 RWPM、positions 和资源 API；
- TypeScript toolkit 消费 RWPM/API 并提供 navigator、preferences 和 decorators；
- 官方说明项目仍是 work in progress，并建议部署时优先评估 Thorium Web + Readium CLI；
- 2026-07-23 仍有新包发布，维护活跃，许可证为 BSD-3-Clause。

参考：[Readium Web 架构说明](https://readium.org/web/)、[TypeScript toolkit](https://github.com/readium/ts-toolkit)、[Go toolkit](https://github.com/readium/go-toolkit)。

仓库保留了 `packages/reader-readium-probe`。它使用已经稳定发布的
`@readium/navigator 2.6.1`、`@readium/navigator-html-injectables 2.6.1` 和
`@readium/shared 2.3.0` 编译验证最小 API 接缝。探针必须接收 RWPM URL，并在加载 navigator
前取得 positions list；它不能替代从本地 `.epub` 生成并安全提供这些资源的额外层。

## 实测结果

| 验收项 | EPUB.js 0.3.93 | Readium Web | 结论 |
| --- | --- | --- | --- |
| 本地 `.epub` 直接导入 | 通过，URL 与 `ArrayBuffer` 均可 | 不直接支持；需 RWPM/positions/HTTP 资源 | EPUB.js 明显更符合 v0.1 |
| EPUB 2/3 | 两份项目夹具均通过 | 官方当前支持 EPUB，未在本地 zip 路径复测 | EPUB.js 通过当前基线 |
| 分页/滚动 | 通过 | Preferences API 支持 | 两者都可 |
| 位置保存 | CFI 保存并重新打开到同一章节 | Locator + positions 设计更完整 | v0.1 EPUB.js 足够 |
| 字号/行距/词间距/颜色 | 通过 themes override | Preferences API 原生支持且更系统 | Readium 更强，但不是当前决定项 |
| 焦点加粗 | DOM hook 注入并可逆移除 | 支持 injectables/decorators，但接入面更大 | EPUB.js 通过 |
| 选词与原句 | 通过；使用 live Selection，保留 CFI range | 提供 textSelected listener | 两者都可 |
| 无障碍语义 | `main`、标题等语义保留；加粗只增加中性 `span` | 设计更完整 | EPUB.js 通过当前基线 |
| 安全默认值 | 明确禁用书内脚本与弹窗，iframe sandbox | 有内容保护能力 | 两者仍需持续安全测试 |
| Web/Electron 共享 | 同一个 adapter 和 React 阅读页已构建 | 可共享，但需额外出版物服务层 | EPUB.js 更简单 |
| 维护状态 | 发布停滞，需自行维护补丁 | 活跃 | Readium 胜出 |

## Spike 中发现并修复的问题

1. EPUB.js 0.3.93 的 `getContents()` 类型声明写成单值，实际返回数组；adapter 内做了局部、
   带注释的类型收窄，避免污染业务层。
2. 用 CFI 立即反解选区时，嵌套强调元素可能返回错误字符；改为优先读取 iframe 内的 live
   Selection，同时保存 EPUB.js 给出的 CFI range。
3. 焦点加粗的防重复选择器最初会匹配到带状态标记的 `body`，导致整书跳过；浏览器测试发现后，
   改为只跳过已经处理的 word wrapper。
4. 焦点加粗使用无语义 `span`，不使用 `strong`，避免把视觉辅助错误地暴露为作者强调。
5. 安全审计发现 EPUB.js 的 `@xmldom/xmldom` 0.7 间接依赖有 5 个高危公告；workspace
   覆盖到保持相同解析 API 的 0.8.13，并在 EPUB 2/3 回归和 Electron 打包中验证。

## 决策

v0.1 使用 EPUB.js 0.3.93，原因是它唯一满足“浏览器直接选择本地 `.epub` 后离线打开”且无需新增
本地服务器/云端出版物服务的候选方案。Readium Web 的维护、定位和偏好模型更优秀，但其架构边界
与当前本地优先 MVP 不匹配。

这不是永久绑定：

- 所有具体调用封装在 `@lexianchor/reader-epub`；
- 产品层只依赖 `@lexianchor/reader-core` 的接口；
- Readium 编译探针保留，后续若增加本地出版物服务、远程书库或更复杂格式，可重新评估；
- EPUB.js 作为低活跃依赖，需要锁版本、保留自有夹具，并把未信任 EPUB 的沙箱测试列入发布门槛。
- `@xmldom/xmldom` 保持 0.8.13 或更高安全版本；每次覆盖升级都重跑 EPUB 2/3 与桌面打包。

## 后续工作

- 用更大的公开、无 DRM EPUB 2/3 样本扩展兼容矩阵；
- 测试固定版式、RTL、竖排、脚注、图片、内部链接与异常 EPUB；
- 将焦点加粗转换器独立为可测试模块，并验证 CFI 在开关前后不漂移；
- 对 Electron 的导航、外链和文件协议增加安全测试；
- 阅读偏好和书籍数据进入正式本地存储后，用书籍内容哈希代替文件名作为位置 key。
