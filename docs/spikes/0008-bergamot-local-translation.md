# Mozilla Bergamot 本地句子翻译 Spike

> 日期：2026-07-24
>
> 状态：Accepted for v0.1

## 目标

验证 Web/PWA 与 Electron 能否共享一套完全本地运行的英语→法语、英语→简体中文句子翻译
能力，并满足以下门槛：

- 模型许可证、来源、版本、大小和 SHA-256 可追踪；
- 模型按需安装，不提交到 Git 或默认安装包；
- 下载完成后校验、解压并保存在本机；
- 翻译在 Worker 中执行，不把选中文字发送到网络；
- 重载与断网后仍可使用；
- 用户可暂停后续下载、继续和删除模型；
- 本地能力缺失或失败时仍保留在线翻译和 Search on Web。

## 候选路线

### Transformers.js + OPUS-MT

优点是模型生态广、以后容易扩展更多语言。缺点是两个方向通常各需数百 MB，并会额外引入
tokenizer、ONNX Runtime 和 WebGPU/WASM 两套执行差异。对 LexiAnchor 当前以个人使用、
英语阅读为核心的 v0.1 来说，下载和维护成本过高。

### Mozilla Bergamot

Bergamot 是 Firefox Translations 使用的浏览器本地机器翻译路线。`@browsermt/bergamot-
translator` 0.4.9 提供 Web Worker 与 WASM 执行层；Mozilla 模型注册表提供量化后的
Marian 模型、词表、shortlist、大小、哈希和发布状态。它的两个首选语言包合计下载约
62.5 MB，明显小于候选 ONNX 方案。

## 选择

v0.1 采用：

- 执行引擎：`@browsermt/bergamot-translator` 0.4.9；
- 运行方式：Web 与 Electron renderer 共用 Web Worker + WASM；
- 模型：Mozilla Firefox Translations registry 中状态为 `Release` 的 `base-memory`；
- 存储：OPFS `lexianchor/translation-models/<resource-id>`；
- 量化配置：`int8shiftAlphaAll`，与模型文件的 `intgemm.alphas` 格式一致；
- 语言方向：英语→法语、英语→简体中文；
- 单次选文上限：2,000 字符。

ONNX Runtime/Transformers.js 不再是 v0.1 基线，但保留为未来增加语言方向或替换模型时的
Provider 实现候选。

## 固定资源

模型注册表：
`https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/db/models.json`

审计时注册表生成时间为 2026-07-24T00:44:29Z。应用不在运行时读取“最新”注册表，而是将
审核过的文件地址、大小和 SHA-256 固定在仓库 manifest 中。

注册表给出的 `storage.googleapis.com/<bucket>/<object>` 直链可由命令行和 Firefox 特权
客户端下载，但普通 Web 页面会被 CORS 拒绝。manifest 因此使用 Google Cloud Storage
官方 JSON 下载 API 的 `download/storage/v1/...?...alt=media` 形式访问同一个公开对象。
浏览器已完整下载 2,297,334 字节的 EN→FR shortlist，并与原 manifest 大小一致；7 个对象
仍使用注册表审计得到的固定压缩哈希，不使用第三方 CORS 代理或镜像。

| 方向 | 资源 ID | 下载 | 解压后 | 文件 |
| --- | --- | ---: | ---: | ---: |
| EN→FR | `bergamot-en-fr-2025-11-21` | 25,752,472 B | 36,749,127 B | 3 |
| EN→ZH | `bergamot-en-zh-2025-11-21` | 36,745,593 B | 49,913,927 B | 4 |

完整 URL、压缩文件 SHA-256、解压文件 SHA-256 与逐文件大小见：

- `packages/translation/resources/bergamot-en-fr.manifest.json`
- `packages/translation/resources/bergamot-en-zh.manifest.json`

## 许可证

- Bergamot JavaScript/WASM 包：MPL-2.0；
- 本次选择的 Mozilla 翻译模型：MPL-2.0；
- UI 同时展示模型来源、许可证、下载体积和本地占用；
- 翻译结果显示 `Mozilla Firefox Translations contributors · Bergamot/Marian NMT`。

源代码与许可证：

- https://github.com/browsermt/bergamot-translator
- https://github.com/mozilla/firefox-translations-models
- https://www.mozilla.org/MPL/2.0/

模型由应用从 Mozilla 固定地址按需下载，不进入 LexiAnchor Git 仓库。

## 安装和完整性流程

1. 读取固定 manifest；
2. 按文件流式下载 gzip，并显示总进度；
3. 核对压缩体积和 SHA-256；
4. 使用浏览器 `DecompressionStream` 解压；
5. 核对解压后体积和 SHA-256；
6. 单个完整文件写入 OPFS；
7. 所有文件成功后才写入 `installed` 标记；
8. 中断时保留已经完成的文件，继续安装时跳过它们；
9. 删除操作移除该资源的整个 OPFS 目录。

模型管理器和推理 Provider 位于 `packages/translation`。Vite 插件把 Bergamot 需要的固定
worker 与 WASM 文件名同时提供给开发服务器、Web 构建和 Electron renderer 构建。

## 产品行为

- 设置页分别显示 EN→FR 与 EN→ZH 模型；
- 未安装时显示“安装模型”，部分完成时显示“继续下载”；
- 下载时可暂停，安装后可删除；
- 阅读器选文面板允许独立选择简体中文或法语目标语言；
- 已安装对应模型时显示“本地翻译”，否则明确引导到设置；
- 本地翻译与 UI 语言、词典顺序相互独立；
- 在线翻译仍需用户主动操作和首次授权提示；
- Search on Web 始终保留。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| 下载大小、压缩 SHA、解压大小、解压 SHA | 通过 |
| 完成文件复用、删除和损坏资源拒绝 | Vitest 通过 |
| Bergamot worker 与 WASM 进入 Web 生产构建 | 通过 |
| Web 从 Google JSON API 跨域下载真实模型对象 | 通过 |
| EN→FR 真实模型安装和翻译 | 通过 |
| EN→FR 重载后断网翻译 | 通过 |
| EN→ZH 真实模型安装和翻译 | 通过 |
| EN→ZH 重载后断网翻译 | 通过 |
| 官方网络源下载两套完整模型后双语推理 | 通过，浏览器场景 34.0 s |
| 日常 UI 回归不下载大模型 | Playwright 覆盖设置与未安装降级 |

真实模型 E2E 先用审计下载文件隔离推理问题，最终再从 manifest 的官方网络源下载两套完整
模型，验证安装、双语切换、刷新和断网复用。它只作为一次性资源验证，不进入日常测试套件，
避免 CI 每次搬运约 62.5 MB。日常单元测试使用自生成 gzip 小夹具验证生命周期。

## 已知限制

- 当前只支持源语言为英语的两个方向，不含 FR→EN 或 ZH→EN；
- “简体中文”模型偶尔可能输出繁体字、标点或专名不一致，不能视作权威翻译；
- 尚未完成独立人工质量语料评分、低内存设备和长句压力测试；
- 首次推理需要初始化约 5.2 MB WASM 和模型，速度取决于设备 CPU；
- 浏览器清除站点数据会同时删除模型；
- 暂停以“保留已完成文件”为粒度，不保留某个 gzip 文件内部的字节断点；
- Electron v0.1 共享 renderer Worker；若后续出现内存隔离问题，再迁移到 Utility Process，
  但不改变 `BergamotTranslationProvider` 的产品接口。

## 结论

Mozilla Bergamot 达到 LexiAnchor v0.1 的体积、许可证、跨端复用、离线和隐私门槛，接受为
首版本地句子翻译基线。下一步转入词卡编辑/导出和阅读器稳定化，不继续并行维护 ONNX 原型。
