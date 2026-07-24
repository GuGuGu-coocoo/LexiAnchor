# WordNet 离线英英词典 Spike

- 日期：2026-07-24
- 结论：v0.1 内置 Princeton WordNet 3.1，通过 `wordnet-db` 3.1.14
  固定版本分发
- 状态：单词查询、选择面板与 PWA 离线缓存通过

## 目标

验证第一个正式词典包能否满足：

1. Web/PWA 与 Electron 共用同一个查询实现；
2. 断网后仍可查询完整英英词典；
3. 查询不依赖服务端、账号或运行时 CDN；
4. 选择 EPUB/PDF 单词后自动显示词性、英语释义、同义词和例句；
5. 资源来源、版本、许可证、署名、大小和 SHA-256 可审计；
6. 本地没有句子翻译能力时，诚实降级并保留在线翻译和网页搜索。

## 资源与许可证

内置数据来自 Princeton WordNet 3.1，由 npm 包 `wordnet-db` 3.1.14 提供。该包没有运行时
依赖，数据文件包含 Princeton WordNet 许可声明。许可允许在保留版权、许可和免责声明的
前提下免费使用、复制、修改和分发；不得使用 Princeton 名称为产品宣传背书。

仓库保留：

- 完整声明：`docs/licenses/WORDNET-3.1.txt`；
- 资源清单：`packages/dictionary/resources/wordnet-3.1.manifest.json`；
- npm 包精确版本和 lockfile integrity；
- 8 个实际分发文件各自的大小和 SHA-256；
- 查询结果中的可见来源署名。

参考：
[Princeton WordNet license](https://wordnet.princeton.edu/license-and-commercial-use)、
[Princeton WordNet](https://wordnet.princeton.edu/)、
[wordnet-db 3.1.14](https://www.npmjs.com/package/wordnet-db)。

## 实现

`@lexianchor/dictionary` 定义 `DictionaryProvider`，产品界面只依赖统一结果结构。当前
`WordNetProvider`：

- 加载 noun、verb、adjective、adverb 四类索引；
- 使用有序索引的精确行查找；
- 按索引记录的字节偏移读取对应 data 记录；
- 只在命中某词性后加载该词性的 data 文件；
- 缓存已经加载的索引与数据；
- 提供保守的复数、过去式、进行时等形态回退；
- 不编造 WordNet 没有提供的词根或词源。

生产构建把数据文件作为本地静态资源输出。PWA Service Worker 将全部 WordNet 文件加入
预缓存，因此安装/首次完整加载后可以断网查询。当前预缓存约 31 MB，其中 WordNet 是主要
体积来源。

## 选择与隐私

EPUB 和 PDF 的选区都进入同一个 `SelectionTools`：

- 单个英文词自动走本地 WordNet；
- 短语/句子提示本地句子翻译尚未安装；
- “在线翻译”第一次使用前明确提示将发送的选中文字；
- “Search on Web”只使用用户主动选择的文字；
- Electron 只允许通过白名单 IPC 打开 `http:` 或 `https:` 地址；
- 本地查词不会发送网络请求。

## 验收结果

| 验收项 | 结果 |
| --- | --- |
| WordNet 索引与 data 解析 | 通过，Vitest 覆盖规范化、形态、索引和字节偏移 |
| 完整数据查询 `resilient` | 通过 |
| EPUB 选词查询 | 通过 |
| PDF 选词与精确原句 | 通过 |
| 来源署名可见 | 通过 |
| PWA 断网后查询 | 通过 |
| 在线翻译首次使用提示 | 通过 |
| Search on Web | 通过 |
| Web 生产构建 | 通过，资源进入 PWA 预缓存 |
| Electron 构建 | 通过 |

## 限制

- 当前只有英英 WordNet；英法和英汉尚未接入；
- WordNet 主要提供词义关系，不是完整词源词典，`rootOrEtymology` 保持为空；
- 形态回退是保守规则，尚未加入 WordNet exception lists；
- 当前内置 WordNet 直接使用原始索引/data 格式，尚未转换为统一只读 SQLite 包；
- PWA 首次完整缓存约增加 31 MB 下载与存储；
- 没有本地句子翻译模型；
- 尚未提供词典启停、顺序调整、下载/删除和用户 StarDict 导入。

## 决策

接受该实现作为 v0.1 英英词典基线。完整 WordNet 随应用分发，以保证第一次安装后的离线
体验；用户下载词典仍使用可校验的包格式和 `ContentStore`。下一步优先完成词卡闭环，再接入
FreeDict 英法、英汉候选与本地句子翻译。
