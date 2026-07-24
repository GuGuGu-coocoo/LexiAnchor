# ADR-0003：PDF 使用 PDF.js，EPUB v0.1 使用 EPUB.js

- 状态：Accepted
- 日期：2026-07-24

## 决策

- PDF 使用 PDF.js display layer 构建自定义 viewer；
- EPUB v0.1 使用 EPUB.js 0.3.93；
- Reader Core 使用 adapter 隔离具体实现，产品 UI 不直接调用 EPUB.js；
- 默认禁用 EPUB 内脚本与弹窗；
- Readium Web 保留为后续候选，不进入 v0.1 产品 bundle。

## Spike 结果

- 项目自制 EPUB 2 与 EPUB 3 夹具均可加载；
- CFI 能序列化，并在重新打开测试书后恢复到相同章节；
- 分页、连续滚动、字号、行距、词间距和颜色可调；
- 焦点加粗可以注入和移除，正文语义不变；
- 能获得选中文字、原句和 CFI range；
- 相同 adapter 与阅读页通过 Web 构建和 Electron 构建；
- 浏览器端到端测试覆盖 EPUB 2 导入、EPUB 3 加载、选词、焦点加粗和位置恢复。

完整证据见 [EPUB 阅读内核 Spike](../spikes/0001-epub-engine.md)。

## 为什么暂不选 Readium Web

Readium Web 的 TypeScript toolkit 不直接打开本地 EPUB 压缩包。官方架构要求先提供 Readium Web
Publication Manifest、positions list 和通过 HTTP/HTTPS 访问的出版物资源，通常由 Go toolkit 或
Readium CLI 完成。LexiAnchor v0.1 的核心路径是浏览器选择本地文件后离线阅读，为 Readium 新增
出版物服务/预处理层会显著扩大范围。

Readium 仍有明显优点：维护活跃、偏好与 locator 模型完整、无障碍和多出版物类型路线更系统。
仓库保留编译探针；当项目需要远程书库、本地出版物服务或更多格式时重新决策。

## EPUB.js 风险与控制

- 风险：0.3.93 自 2023 年后没有新发布；
- 控制：锁定确切版本，不自动跨版本升级；
- 控制：所有内核调用封装在 `@lexianchor/reader-epub`；
- 控制：保留 EPUB 2/3 自有夹具和浏览器回归测试；
- 控制：默认 `allowScriptedContent: false`、`allowPopups: false`；
- 控制：将存在高危公告的 `@xmldom/xmldom` 0.7 间接依赖覆盖到已修复的 0.8.13；
- 控制：发布前继续增加恶意 EPUB、外链、固定版式和异常文件测试。

## PDF 边界

- 保持原始版式；
- 焦点加粗只作用于可用文本层；
- 扫描 PDF 在 MVP 中降级为页面查看；
- 不修改原始 PDF。

## 重新评估触发条件

- EPUB.js 无法通过重要真实书籍兼容测试；
- CFI 因焦点加粗或重排出现不可接受漂移；
- 项目引入可复用的本地/远程出版物服务；
- v0.1 之后要统一 EPUB、音频书或漫画的 navigator。
