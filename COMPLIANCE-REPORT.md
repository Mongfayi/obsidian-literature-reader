# pdf-reader 插件合规检查报告

对照对象：
- 官方示例插件 <https://github.com/obsidianmd/obsidian-sample-plugin>（含 `AGENTS.md` 规范清单与 `eslint-plugin-obsidianmd`）
- 官方文档 [Build a plugin](https://docs.obsidian.md/Plugins/Getting+started/Build+a+plugin)、[Plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)、[Submission requirements for plugins](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)、[Developer policies](https://docs.obsidian.md/community-directory/developer-policies)

检查方式（三项互相独立）：
1. 用官方 `eslint-plugin-obsidianmd`（与示例插件同款配置）全量扫描 `main.ts`、`types.ts`、`modules/**`；
2. `tsc -noEmit -skipLibCheck` 严格类型检查 + `node esbuild.config.mjs production` 生产构建；
3. 逐文件人工审计全部 27 个源文件（12500+ 行），核对生命周期、事件注册、样式、网络与安全。

结论：**未发现 BLOCKER 级不合规**。已修复 15 类问题；剩余 40 条 linter 提示中 37 条为误报或动态几何布局的合理内联样式（详见文末）。

---

## 一、已修复（15 类）

| # | 违反的规范 | 位置 | 修复前 → 修复后 |
|---|-----------|------|----------------|
| 1 | 描述须以句号结尾 | `manifest.json` | `…窗口/标签页` → `…窗口/标签页。` |
| 2 | `minAppVersion` 须准确 | `manifest.json` | `1.7.0` → **`1.12.7`**（按用户实际安装的 Obsidian 版本对齐）：原声明 1.7.0 低于代码实际所需（`Workspace.revealLeaf` 需 1.7.2），会让 1.7.0/1.7.1 用户装到必然报错的版本（linter `no-unsupported-api`）。现声明与目标平台一致，且已逐项核对全部所用 API 均被 1.12.7 满足 |
| 3 | 版本映射文件缺失 | 新增 `versions.json` | 无 → `{"2.5.1": "1.12.7"}`（示例插件要求的版本→最低 app 版本映射） |
| 4 | 标题禁用裸 `<h1>/<h2>` | `SettingsTab.ts` 6 处 `createEl('h2')` + 1 处 `h4`，另删 5 个 `createEl('hr')` 分隔线 | 全部改为 `new Setting(el).setName(…).setHeading()`；标题去掉冗余的「设置」二字 |
| 5 | 禁用 `workspace.activeLeaf`（官方已标 deprecated） | 7 处：`PdfReaderModule`(4)、`DeepSeekModule`、`MarkdownReadingModule`、`AnnotationModeModule`、`PdfJumpModule` | 改用 `getActiveViewOfType(FileView/MarkdownView)` / `getMostRecentLeaf()`。全仓 `workspace.activeLeaf` 归零 |
| 6 | 活动文件应优先用 Editor API | `PdfReaderModule.shortenPdfAnnotationLinks` 用 `vault.modify` 改写**当前笔记** | 命令改为 `editorCheckCallback` + `editor.setValue()`，保住光标、撤销栈与折叠状态；后台文件路径改用 `vault.process()` 原子写。全仓 `vault.modify` 归零 |
| 7 | 禁止硬编码样式 | `PdfReaderModule` 浮动按钮 18 项内联样式（且类名 `pdf-annotate-floating-btn` 在 CSS 里根本没有规则 = 空壳）；`DeepSeekModule` 拖拽/缩放/显隐；`MarkdownReadingModule` 隐藏态 | 全部下沉到 `styles.css`（`.pdfreader-pdf-annotate-floating-btn`、`.is-dragging`/`.is-resizing`/`.is-visible`/`.is-left-anchored`/`.is-hidden`），交互态改用类切换，颜色一律走 Obsidian CSS 变量 → 主题/片段可覆盖 |
| 8 | 避免无谓的 console 输出 | `PdfReaderModule` 3 处、`QuickTagModule` 2 处 `console.log` | 删除；保留的 `console.warn/error` 均为失败诊断 |
| 9 | 禁止 `innerHTML` | `DeepSeekModule.ts` `titleLeft.innerHTML = '<span>…</span>'` | `titleLeft.createSpan({ text: 'DeepSeek' })`。全仓 `innerHTML/outerHTML/insertAdjacentHTML` 归零 |
| 10 | 用 `vault.configDir` 而非写死 `.obsidian` | `PdfReaderModule` cMap 路径、`pdfjsLoader` 回退库路径 | 改为读 `vault.configDir`（用户在设置里改过配置目录名时不再失效；严格说这是一处真实 bug） |
| 11 | 生命周期钩子用错 | `SettingsTab` 覆写了 **不存在的** `onClose()`（那是 `Modal` 的钩子） | 改覆写 `hide()`（`PluginSettingTab` 的真实钩子）并 `super.hide()`；防抖定时器现在真的会被清理、最后一次保存真的会冲刷 |
| 12 | 跨窗口安全的事件目标判断 | `PdfJumpModule` 2 处、`MarkdownReadingModule` 3 处、`PdfReaderModule` 2 处 `instanceof Element/HTMLElement` | 改用官方 `Node.instanceOf()`（弹出窗口下 `instanceof` 会误判） |
| 13 | 弹出窗口兼容 | `MarkdownReadingModule`、`PdfJumpModule`、`PdfReaderModule` 的裸 `setTimeout` | 改为 `window.setTimeout` |
| 14 | 优先用 Obsidian DOM 助手 | 11 处 `document.createElement('div'/'span'/'canvas'/'script')` | 改为 `createDiv()` / `createSpan()` / `createEl('canvas')` / `document.head.createEl('script')` |
| 15 | 网络使用须在 README 明确披露 | `README.md` 安全说明 | 新增「网络访问（须知的联网行为）」小节：逐项说明 DeepSeek 网页（`chat.deepseek.com`，可改自建地址）与 LM Studio（默认本机 `127.0.0.1:1234`）两个联网点、触发时机、发送内容，并明确声明**无遥测**、核心功能完全离线、不读 vault 外文件、不执行远程代码 |

顺带修正两处文档/代码不一致与正则瑕疵：README 原称「PDF.js worker 内联」实为独立文件按需加载；`tagVocabulary.ts`、`PdfReaderModule.ts` 中 3 处正则的多余转义。

---

## 二、复核通过（未发现问题）

- **元数据**：`id` 与文件夹名一致且不含 `obsidian`；`version` 为严格 `x.y.z`；`isDesktopOnly: true` 与使用 Electron `webview`／Node `fs` 相符；`fundingUrl` 未滥用；`LICENSE`(MIT) 与 `README.md` 齐备。
- **命令**：10 条命令**均未设置默认热键**；命令 id 未重复插件 id；`callback`/`checkCallback`/`editorCheckCallback` 选用恰当。
- **资源清理**：37 处 `registerEvent`、14 处 `registerDomEvent`、10 处 `plugin.register(cleanup)` 覆盖了 `document`/`window` 级监听与所有定时器/观察者；19 个模块的 `unload()` 均被 `main.ts` 逆序调用；`SharedPoller` 在无任务时自动停表；无 `MutationObserver`/`ResizeObserver` 泄漏。剩余裸 `addEventListener` 全部挂在插件自己创建、随元素销毁的元素上（规范明确允许）。
- **自定义视图**：`registerView` 未把视图实例存到插件字段；`onunload` 中的 `detachLeavesOfType` 属自定义视图的正确清理（视图类型随 `registerView` 失效，不摘除会让下次启动无法还原该标签页）。
- **Vault/DOM**：无全局 `app`/`window.app`（子代理初审报的 9 处均为 `const app = this.ctx.plugin.app` 局部别名，已逐一核实）；无全库遍历找路径的用法；用户路径一律经 `normalizePath()`；`vault.process()` 用法正确。
- **性能**：启动轻量，重活（PDF.js、webview、OCR）全部懒加载；文件系统事件有防抖；工具条轮询带门控（无 PDF 视图/窗口隐藏时零开销）。
- **安全**：无 `eval`/`new Function`；`executeJavaScript` 注入内容经 `JSON.stringify` 转义；无动态广告、无自动更新机制、无遥测；除 DeepSeek/LM Studio 外无其他网络出口。

---

## 三、可选改进（未改动，供决策）

| 优先级 | 事项 | 说明 |
|--------|------|------|
| 低 | 采纳声明式设置 API `getSettingDefinitions()` | **本插件不适用**。该 API 需 Obsidian **1.13.0+**，而本插件的目标版本是 1.12.7（用户实际安装版本），1.12.3 的 API 面里根本不存在这两个符号（`grep getSettingDefinitions obsidian.d.ts` = 0 命中）。代价是在 1.13+ 上设置项不进设置页搜索；若将来把 `minAppVersion` 提到 1.13.0，可一并迁移 |
| 低 | `PdfJumpModule` 的 `indexCache` 未见淘汰 | 已关闭但文件仍存在的 PDF 会常驻缓存条目 |
| 低 | `PdfJumpModule` 8 秒轮询缺 `flashRunId` 式代次守卫 | 插件卸载后最长可能多跑 8 秒（无害，但可对齐 `MarkdownReadingModule` 的写法） |
| 低 | 设置页数字输入非法时静默丢弃 | 如「请求超时」小于 10 秒时不提示也不回填 |
| 低 | `TagSyncModule` 用 `editor.setValue()` 整篇替换 | 会丢失光标与撤销栈，可改为 `replaceRange` 局部替换 |
| 提示 | 部分内部 API（`editor.posAtMouse`、`addHighlights`、`workspace.rootSplit` 等）不在公开类型中 | 代码已用 `typeof`/try-catch 兜底，属可接受的兼容风险 |

---

## 四、剩余 linter 提示说明（40 条）

| 规则 | 条数 | 判定 |
|------|------|------|
| `ui/sentence-case` | 28 | **误报**。规则按英文标题式大小写处理中文串，要求把专有名词写成小写（`打开 deepseek`、`Ocr 模型`、`lm studio`）。官方样式指南要求专有名词保持正确大小写，故保留 `DeepSeek`/`OCR`/`LM Studio` |
| `no-static-styles-assignment` | 9 | **合理**。`DeepSeekModule` 浮窗的 `left/top/width/height` 是拖拽/缩放的运行时几何量，无法用静态类表达；纯静态的 `right/display/cursor/transition/pointer-events` 已全部改为类 |
| `hardcoded-config-path` | 2 | **误报**。两处 `.obsidian` 现仅为函数默认参数/兜底值，实际取值来自 `vault.configDir` |
| `settings-tab/prefer-setting-definitions` | 1 | 见上表「可选改进」 |

另注：`@typescript-eslint/no-unsafe-*`、`no-explicit-any` 等约 470 条属 `typescript-eslint` recommended 的严格类型建议（主要来自对未公开 Obsidian 内部 API 的 `as any` 访问），**不属于**官方插件提交的必查项。

---

## 五、最终验证证据

| 检查 | 命令 | 结果 |
|------|------|------|
| 类型检查 | `tsc -noEmit -skipLibCheck` | **exit 0**，0 错误 |
| 生产构建 | `node esbuild.config.mjs production` | **exit 0**，`main.js` 376.6KB；两次构建字节一致（可复现） |
| 产物同步 | `find *.ts -newer main.js` | 无输出 → 提交的 `main.js` 与源码一致 |
| 官方 linter | `eslint main.ts types.ts modules/` | Obsidian 专属规则从 **122 条降至 40 条** |
| API 版本适配 | `no-unsupported-api` 规则（按 `minAppVersion` 校验每个 API） | **0 条** —— 全部所用 API 均被 `minAppVersion: 1.12.7` 满足；编译所依的 `obsidian` 类型包为 1.12.3（1.12.7 的子集） |
| 产物结构 | 以 stub 版 Obsidian API 求值 `main.js` | 默认导出 `LiteratureReaderPlugin` 类，`onload`/`onunload` 齐备，可实例化 |
| 样品残留 | 搜索 `MyPlugin`/`SampleSettingTab`/`TODO` | 无 |
| 持久化 | 搜索 `loadData`/`saveData`/`localStorage` | 仅用 `loadData`/`saveData`，**未用 `localStorage`** |
| 越界读写 | 搜索 `fs`/`child_process`/`process.env` | 仅 1 处 `fs.readFileSync` 读取 vault 内 `cmaps/`，未越出 vault |

**已清零的 Obsidian 专属规则**（修复前 → 修复后）：
`no-manual-html-headings` 7→0、`no-unsupported-api` 2→0、`prefer-create-el` 19→0、`prefer-instanceof` 5→0、`prefer-window-timers` 3→0、`no-global-this` 1→0、`no-useless-escape` 3→0。

## 六、复现命令

```bash
cd .obsidian/plugins/pdf-reader
npx tsc -noEmit -skipLibCheck          # 类型检查（0 错误）
node esbuild.config.mjs production      # 生产构建（0 错误，main.js 约 377KB）
npx eslint main.ts types.ts modules/    # 官方 Obsidian 规则检查（配置文件见 eslint.config.mjs）
```

> 说明：复现 linter 需先安装 `eslint eslint-plugin-obsidianmd typescript-eslint @eslint/js globals jiti`（本次以 `--no-save` 安装，未改动 `package.json`）。
