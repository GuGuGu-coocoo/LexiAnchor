# StarDict 用户词典导入 Spike

## 目标

验证 LexiAnchor 能否在 Web 与 Electron 共用的本地优先架构中安全导入用户自行持有的
StarDict 词典，并让它参与已有的离线查词、启停和结果排序。

## 格式依据

实现以 StarDict 项目随源码提供的
[StarDictFileFormat](https://github.com/huzheng001/stardict-3/blob/master/dict/doc/StarDictFileFormat)
为准：

- `.ifo` 保存 `bookname`、`wordcount`、`idxfilesize` 和可选的
  `sametypesequence`；
- `.idx` 中每个词头是 UTF-8、以空字节结束，随后是网络字节序的偏移与长度；
- `.dict` 保存词条内容，位置由 `.idx` 指向；
- `.idx.gz` 和 `.dict.dz` 是规范允许的压缩变体。

## v0.1 兼容范围

已支持：

- 一组同名的未压缩 `.ifo + .idx + .dict`；
- StarDict 2.4.2 和 3.0.0；
- 32 位索引偏移；
- `sametypesequence` 与逐字段类型标记；
- 纯文本、HTML/Pango/XDXF 文本和音标字段的安全纯文本显示；
- OPFS 持久保存、启停、排序、替换和移除；
- 通过独立 Web Worker 完成完整索引扫描、文章边界验证和写入；
- 导入失败时保留已安装的用户词典。

暂不支持：

- `.idx.gz`、`.dict.dz` 或压缩归档直接导入；
- `idxoffsetbits=64`；
- `.syn` 同义词索引；
- 图片、音频等二进制词条展示；
- 同时安装多本用户词典。

界面会明确说明当前需要选择三个未压缩文件，不会把不支持的变体当成成功导入。

## 存储与失败安全

导入 Worker 在写入前完成：

1. `.ifo` 必填字段与版本检查；
2. `.idx` 实际大小与 `idxfilesize` 对比；
3. 索引词条数与 `wordcount` 对比；
4. 每个偏移与长度都不得超出 `.dict`；
5. 所有文本字段必须可按 UTF-8 解码；
6. 所有文章字段都必须完整。

通过后，三份输入被封装成一个 LexiAnchor 内部包，并通过 OPFS
`FileSystemWritableFileStream` 一次提交。校验失败发生在写入之前，因此不会覆盖当前词典。

## 许可边界

LexiAnchor 只提供通用格式导入能力，不下载、捆绑或再分发用户词典。设置页明确提示：词典
内容、来源与许可证由用户负责。应用仓库的 MIT 许可证不改变用户数据本身的权利状态。

## 验收

- 5 个 StarDict 单元测试覆盖元数据、导入查询、删除、失败替换、空词典与 64 位拒绝；
- 浏览器端到端测试覆盖“选择三文件 → 后台导入 → 页面重载 → 阅读选词查询 → 删除”；
- 与原有 WordNet、英法、英汉词典共同参与同一查询顺序。

## 决策

接受未压缩 StarDict 三件套作为 v0.1 的首个用户词典格式。下一阶段优先进入本地句子翻译；
压缩格式、多用户词典和 `.syn` 支持保留为兼容性增强。
