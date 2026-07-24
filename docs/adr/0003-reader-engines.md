# ADR-0003：PDF.js 已确定，EPUB 内核通过 Spike 决策

- 状态：Accepted with pending spike
- 日期：2026-07-24

## 决策

- PDF 使用 PDF.js display layer 构建自定义 viewer；
- EPUB 在 Readium Web 和 EPUB.js 之间进行 3–5 天 Spike；
- Spike 前不大规模编写依赖具体 EPUB 内核的 UI；
- Reader Core 使用 adapter 隔离具体实现。

## EPUB 通过条件

- EPUB 2/3 真实样本兼容；
- CFI/locator 或等价位置在重排后稳定；
- 支持分页和滚动；
- 能够安全注入主题与焦点加粗 decoration；
- 能够获得选词和原句上下文；
- 保留无障碍语义；
- 可在 Electron 和 Web 共享。

## PDF 边界

- 保持原始版式；
- 焦点加粗只作用于可用文本层；
- 扫描 PDF 在 MVP 中降级为页面查看；
- 不修改原始 PDF。

## 后续

Spike 结束后更新本 ADR，记录选择、版本、补丁策略和被放弃方案。
