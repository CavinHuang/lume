# ZCode 桌面端 SidePane GIT + CODE VIEWER 逆向报告

目标文件：`D:\software\zcode\resources\app\out\renderer\assets\styles-C2WGZ-SY.js`（主 renderer bundle，JS 字符串长度 4,584,754 / 磁盘 4,602,074 字节，下文偏移均为字符串偏移）。本次新增切片与脚本见文末清单。

---

## 0. 渲染分派（Shell 层，承接前次 E-shell 结果）

`E-shell.beau.js:1878-1905` 中，SidePane 每个 tab 按类型分派：

```js
i.type === `code-viewer` ? (0,$.jsx)(owt, {
  source: i.source, onClose: T, workspacePath: c,
  onOpenBrowserUrl: te, onOpenCodeViewer: ne,
  renderHeavyContent: nAt({ isActiveTab: i.id === Ce, isMobileOverlay: ce,
    isResizeSettling: Ve, isSidePaneVisible: r, visibleInlineSizePx: Be })
}) : i.type === `git` ? (0,$.jsx)(YEt, {
  workspacePath: c, workspaceIdentity: l, workspaceRemoteSessionId: u,
  gitState: p, isDesktop: t, selectedSourceId: m,
  fileChangeFindActiveIndex: x, fileChangeFindNavigationRequestId: S,
  fileChangeFindQuery: C, onFileChangeFindMatchCountChange: w,
  onSelectSource: se, onClose: E, onRefresh: H, onRevealFileInTree: ee })
```

定义位置（`function X(` 唯一命中）：`owt`@3305173、`YEt`@3692720、`nAt`@3796929、`TEt`(browser-use)@3683945。

**renderHeavyContent 门控（nAt，offset 3796929）**：

```js
function nAt({ isActiveTab, isMobileOverlay=!1, isResizeSettling=!1,
               isSidePaneVisible, minVisibleInlineSizePx=96, visibleInlineSizePx }) {
  return !isSidePaneVisible || !isActiveTab ? !1
       : isMobileOverlay ? !0
       : isResizeSettling ? !1
       : visibleInlineSizePx === null ? !0
       : visibleInlineSizePx >= 96
}
```

即：非激活 tab / 侧栏不可见 → 不渲染重型内容（骨架屏）；移动端覆盖层强制渲染；resize 收尾期跳过；面板可见宽度 ≥96px 才渲染。

---

## 1. Git 面板（YEt）

### 1.1 数据源：services 抽象，非直接 IPC

- `YEt` 通过 `Jr()` 上下文取 `gitService`，懒加载单个文件 diff：`m.getDiff({ workspacePath, path, sourceId })`（S1-git-YEt.beau.js:748）。
- gitState 由 shell 层 `yme`（useGitRepository，def@293970）提供：

```js
s.refresh({ workspacePath, includeIdentity: n, includeBranchComparison: n })
  .then(({ summary, identity, unstagedChanges, stagedChanges, branchComparison }) => { ... })
```
（S7-git-state-hook.beau.js:294-304）

- **服务解析与传输**：`gp/hp`（offset 277563/277037）按工作区解析服务：`Spe`（276067）= 有 remoteSessionId → `sessionsById[id].services`；远程目标 → 共享占位代理 `dp()`；本地 → `baseServices`。`baseServices` 由 zustand store（`$f`，272200，含 `registerBaseServices/registerSession`）持有，在 Root 组件以 props 注入并经 `ep(e)` 注册（offset 4568254）。跨进程走通用 RPC 协议 `xf`（238756）：`toService` 返回 Proxy，`foo()` → `channel.call('foo')`、`onXxx` → `listen`、`onDynamicXxx` → 动态事件流（`fileWatcherService.onDynamicChange` 即此机制）。**真正的 git 执行体不在本 bundle**（全 assets 目录仅此文件含 `getCommitGraph/unstagedChanges`，且只有调用点），在主进程/sidecar 侧经 `fromService` 包装。

### 1.2 gitSourceId 多源概念：4 个 diff 作用域（非 worktree）

`Up`（S7:123-146）固定产出 4 个 source：

| sourceId | readonly | 内容（分组 `lme`，S7:57-61） |
|---|---|---|
| `unstaged` | false | unstaged + untracked + conflicted |
| `staged` | false | staged |
| `branch` | true | 与基准分支比较（`branchComparison`，含 `comparisonLabel`） |
| `last-turn` | true | 最近一轮 turn 的文件快照 diff |

- `includeExtendedData`（branch 比较 + identity）**仅在 git tab 已打开时**才请求：`pn = be?.tabs.some(t => t.type === 'git')`（offset ~3887400）。
- `activeGitSourceId` 持久化校验：`_n = gn.sourceOptions.find(e => e.id === At)?.id ?? gn.sourceOptions[0]?.id ?? 'unstaged'`（offset ~3887750），由 `setGitSelectedSourceId` 写回。
- **worktree 是另一套概念**：`gitWorktreeReviewSourceId`/`gitWorktreeChangeSummary`（后者 = unstaged+staged 增删行合计，offset ~3887800）用于主窗口头部的 worktree review 与 GitActionMenu（commit/push 对话框，~1716000-1766000，含 AI 提交信息生成 `commitMessageConversationContext`），与 SidePane 面板的 sourceId 无关。
- **last-turn 注意点**：`yme` 末尾的 useMemo 用占位输入 `_me({ ..., fileChange: null, summary: ome(null) ?? void 0 ?? null })` 且依赖数组为 `[null, null, u, l, t]`（S7:344-361）——快照机器（`ome/gme`，S7:9-244，基于 `fileChange.snapshots` 的 before/afterContent + `yo` 行级 diff）存在，但本构建中该 hook 产出的 last-turn 数据集恒为空，面板此 tab 显示空态文案。

### 1.3 UI 结构（YEt，S1-git-YEt.beau.js:657-975）

没有 branch bar、没有文件树。结构为「来源下拉 + 刷新按钮 + 虚拟化变更列表 + 展开式 diff」：

- 头部：`lr` Select（来源切换，i18n 映射 `NEt`：`git.source.unstaged/staged/branch/lastTurn`，S1:365-378）+ 刷新按钮（`git.action.refresh`，loading 时 `animate-spin`，点击调 `u=onRefresh`）。
- 列表：`j = A.sections.flatMap(s => s.changes)` 拍平（不渲染 section 头），每项 `HEt`（S1:466-603）：sticky 展开头（文件图标+路径组件 `zt`、`+added/-removed`、chevron）+ 右键菜单（在文件管理器中显示[仅桌面]、复制绝对/相对路径、在文件树中显示——通过 `onRevealFileInTree` 移交给 workspace 树）。
- 空态分支：非 git 仓库 / git 不可用 / 空仓库 / 加载中 / last-turn 专属文案（S1:686-730）。
- **查找**：`KEt`（S1:633-653）在“已加载 diff 的纯文本”里计数匹配；有查询时自动批量预加载全部 diff（S1:822-824）；命中后展开 + `scrollToIndex(center)`。

### 1.4 刷新模型

1. **手动**：刷新按钮 → shell `mn = () => Nt(e => e + 1)` 递增 refreshToken → `yme` effect 重跑 `gitService.refresh`。
2. **文件 watch 自动刷新**：`Epe`（GitAutoRefresh，offset 277633；S8-git-autorefresh.beau.js:54-120）：

```js
for (let i of f) s.watch({ path: i.path, recursive: i.recursive }).then(({ id }) => {
  let i = s.onDynamicChange(id)(e => { r(e.dirPath) }); ...
})
```
  watch 路径由 git summary 派生（`efe(summary)`→`tfe`→`nfe`，依赖 `isGitAvailable/isRepository/repoRoot/autoRefreshWatchPaths`）；事件回调 **60s 防抖**（`Tpe = 6e4`，S8:52）后调 `onRefreshGit`。`gitState.revision` 递增使已展开 diff 缓存失效（S1:731-733）。
3. **diff 懒加载**：展开时 `getDiff`，用 `Set` 去重在途请求、revision 计数丢弃过期响应（S1:736-792）。

### 1.5 交互：只读

面板内**无 stage/unstage/commit/discard 任何写操作**；菜单只有 reveal/copy。dataset 的 `readonly` 标志（unstaged/staged=false，branch/last-turn=true）用于其他消费方（change summary 等），不改变面板只读事实。

---

## 2. Code Viewer（owt）

### 2.1 打开路径与 tab 工厂

- tab 工厂 `ede`（offset 199767）：`od` 规范化 source（path/title，195168）→ `id = 'code-viewer:' + sourceKey（哈希）或随机`，**按 sourceKey 去重复用 tab**（`yd` reducer，204210）。打开入口统一汇聚到该 reducer：chat 工具调用的 openInSidePane、文件 mention/链接（`onOpenFileLink`）、git 面板“在文件树中显示”、repo-wiki/subagent 面板的 `onOpenCodeViewer` 等。
- git tab 则是**单例**：`Uue()` → `{ id: 'git', type: 'git', openedAt }`（offset 196373）。

### 2.2 source 类型与 jCt 分派（def@3294714，S12-jCt-viewer.beau.js:30-274）

`od/owt` 层把 source 归一为：`file` / `text` / `image` / `pdf` / `pptx` / `patch` / `multi-file-diff` / `code-review`，jCt 分派：

- `patch` → `xCt`（3291400 附近：`Dp(patch)` 判定纯文本降级，否则走 DiffViewer）；
- `multi-file-diff` → `A6`（DiffViewer，oldFile/newFile，cacheKey 格式 `old:path:len:head100:tail100`）；
- `text` → markdown 用 `oCt` 渲染（Un markdown 组件，preview/code 双模式 `markdownViewMode`）、`.svg` 用 `dCt`（preview/code 双模式 `svgViewMode`）、其余 → **`sCt` 代码视图**；
- `file` → `fileService.readTextFile({path, offset:0, length: br})`（`KCt`：`truncated → fileTooLarge`；`isBinary`；ENOENT → `codeViewer.fileMissing`），office 文档（`OCt`）、图片（`readMediaPreview` → base64 data URL，含 Retina `@2x` 缩放 `lCt`）；
- `pdf` → 懒加载 `pdf-viewer-C4h1_mcN.js`；`stat.size <= YCt(2MB)` 整读，否则传 `requestRange`（`readFileRange` 分段 256KB `JCt`）渐进加载；`>XCt(64MB)` 直接拒绝（`ZCt`）；
- `pptx` → 懒加载 `pptx-preview-viewer-BjT1Sd6J.js`，256KB 分块读取 + `PptxPreviewIncompleteFileError` 完整性校验，文件 watch 触发预览自动重载（`aCt`，~3285900）。

### 2.3 语法高亮引擎：内嵌 Shiki + Oniguruma WASM

shiki 核心（themes/langs/engine）整体内嵌于主 bundle（~1810000-1908000，`ShikiError`、`getSingletonHighlighter`、`--shiki-` CSS 变量等）。应用层包装（S6-shiki-wrapper.beau.js:113-253）：

```js
var BJ = $$e({ langs: Wq, themes: JQe,
    engine: () => createOnigurumaEngine(Y(() => import(`./wasm-DkTciACZ.js`), [], import.meta.url)) })
```

- **单例 highlighter** + per-(lang,theme) 实例缓存 `GJ`；**token 结果缓存** key = `${theme}:${lang}:${len}:${前100字符}:${后100字符}`（`f1e`，S6:149-153），pending 请求合并（`qJ` resolver 集合，`h1e` S6:173-198）；错误日志 `[ShikiHighlighter] 代码高亮失败`。
- **主题**：`d1e = e => e || (document.documentElement.classList.contains('dark') ? 'github-dark' : 'github-light')`（S6:148）；用户可在设置里换（`codePreviewSettings.darkTheme/lightTheme/showLineNumbers/wrapLongLines/fontSizePx 12-20`，offset ~4384900 设置页）。内置主题含 github/one/nord/vitesse/plastic 等（1858000-1866000）。
- **语言解析**：别名表 `HJ`，纯文本集合 `['', 'text', 'txt', 'plain', 'plaintext', 'log', 'output']` 不高亮，回退 `log`；**超 12 万字符不高亮**（`g1e = 12e4`，S6:199，`y1e` 直接短路）。
- 异步高亮 hook `y1e`（S6:214-244，日志名 `[HighlightedLightweightDiffPreview]`）供轻量预览 `JJ` 使用；行号版完整代码视图 `Xt`（`sCt`@3286542 调用）经 import 表来自**专用 chunk `catalogTree-D7q4FnnV.js`**（655KB，内含 13 处 shiki、15 处 codeToTokens——文件树与代码视图共用 chunk）。
- mermaid 图走 `Kt(t) ? It : Xt` 分支（sCt 内）。

### 2.4 只读 vs 可编辑 + 代码评论

**完全只读**（无编辑器）。但支持**行级评论**：`enableCodeLineSelection/enableGutterUtility`（仅非 code-review 时开启，jCt:266-270），提交走 `$e → tPe({...})` 发送到会话 + `Ie(addComment)` 本地 store（S2-codeviewer-owt.beau.js:353-403）；`code-review` source 支持聚焦范围 `focusedRange/focusRequestId`。另有 `appHeader.openInEditor`（调用已装编辑器 `getInstalledEditors`）与复制路径动作。

### 2.5 renderHeavyContent 门控落点

owt 渲染尾部（S5-owt-tail.beau.js:424-476）：

```js
children: i ? (0,$.jsx)(jCt, { ... 全量预览数据 ... })
           : (0,$.jsx)(QCt, { style: st })
```

`QCt`（3302706）是骨架占位：`data-preview-pane-heavy-content-deferred="true"` + `data-preview-pane-heavy-content-placeholder`，渲染 12 条随机宽度假行（`RCt = [44,72,58,86,...]`）。

---

## 3. Diff 渲染

### 3.1 库：内嵌 `diffs` 渲染库（Pierre 系）+ Worker Pool

- `A6 = memo(_Ct); A6.displayName = 'DiffViewer'`（offset 3291094；S10-diffviewer.beau.js:61-124）：

```js
p = { diffStyle: 'unified', diffIndicators: 'bars', disableFileHeader: !0,
      hunkSeparators: isPatch ? 'simple' : 'line-info',
      lineDiffType: 'word-alt', overflow: 'scroll',
      theme: { light: lightTheme, dark: darkTheme }, themeType, ...options }
```
  CSS 变量桥接主题：`--diffs-bg/--diffs-font-family/--diffs-font-size`。两条输入路径：`Ywe`（patch 字符串，569666）与 `Jwe`（oldFile/newFile，568867），核心 `nd = parseDiffFrom`、diff 实例类 `rd`（`__id='file-diff:N'`，字段 `codeUnified/codeDeletions/codeAdditions/spriteSVG/themeCSSStyle`，~158400）。
- **Worker 池**（S11-diffs-worker.beau.js:137-196）：

```js
function jKt() { return new Worker(new URL(`diffs.worker-CAavpt0L.js`, import.meta.url),
                                { type: 'module', name: 'zcode-diffs-worker' }) }
// 池大小：min(4, max(1, hardwareConcurrency/2))，无该 API 时 2
// 渲染参数同步：setRenderOptions({ theme, lineDiffType:'word-alt',
//   maxLineDiffLength: 1000, tokenizeMaxLineLength: 1000, useTokenTransformer: false })
```
  Worker 内做 diff 计算与 shiki tokenize（`disableWorkerPool` prop 可旁路，同步回退）。

### 3.2 大文件/特殊文件处理（git diff 管线，~278800-283400）

- **截断哨兵**：`Ape = '\\ __ZCODE_DIFF_TRUNCATED__:'`，`Lpe`（280797）把行数组超 800 行时掐成首 400 + 尾 399 + 哨兵行（带省略行数，`yp` 可解析回数字）。
- **降级阈值**：`Dpe=1200` 行、`Ope=180000` 字符、hunk 数 `kpe>1200`、多文件 patch、`/dev/null` 新删文件、**锁文件/构建文件清单**（`Mpe = {bun.lock, package-lock.json, pnpm-lock.yaml, yarn.lock, ...}`、`.gradle*`、`zsh`）→ 全部降级为纯文本行（`Dp`，282300）；git 面板侧再叠加：before+after 合计 >180000 字符或行数 >1200（`jEt=18e4, MEt=1200`，S1:362-363、`REt` S1:423）→ `UEt` 纯文本预览（`data-git-plain-text-diff-preview`），否则富 diff `A6`。
- patch 解析兜底 `vp`（手写 `diff --git`/`@@` 计数器）与结构化解析器 `ed`（R13-patch-parser 区域 268000-285000）。

### 3.3 虚拟化

- **Git 面板文件列表**：tanstack-virtual（`Ol({...})`，S1:807-817）：`estimateSize: 32`（`qEt`）、`overscan: 14`（`JEt`）、`measureElement` 动态测量（展开 diff 后高度可变）、`getItemKey = '${sourceId}:${path}'`、命中行 `scrollToIndex(center)`。diff 展开体本身不虚拟化（整块渲染，横向 overflow-auto）。
- **代码视图**：普通 `overflow-auto`；无逐行虚拟化证据（`Xt` 在 catalogTree chunk，未深挖）。
- 细节：横向滚动边缘渐隐 mask（`LCt`，S12:315-320）、滚动位置保持（`ge.current = {scrollHeight, scrollTop}`，S2:404-407）。

---

## 4. 专用 chunk 清单（引用出处）

| chunk | 用途 | 引用位置 |
|---|---|---|
| `wasm-DkTciACZ.js` | shiki oniguruma WASM 引擎 | S6:116（1903300 附近） |
| `diffs.worker-CAavpt0L.js` | diff 计算/渲染 worker（`zcode-diffs-worker`） | S11:138（4532480） |
| `pdf-viewer-C4h1_mcN.js` | PDF 查看器（lazy） | S10:5-7 |
| `pptx-preview-viewer-BjT1Sd6J.js` | PPTX 预览（lazy） | S10:25-27 |
| `catalogTree-D7q4FnnV.js` | 文件树 + 行号代码视图 `Xt`（shiki） | import 表 58672（`Xt` 裸导入） |
| `WikiReferenceSidePane-D4JOTihA.js` | wiki 侧栏（lazy，对照项） | S3:123 |

## 5. 本次产出文件

- 新切片（`D:\tmp\zc-analysis\out\sidepane\`，均含 .raw.js + .beau.js）：`S1-git-YEt`、`S2-codeviewer-owt`、`S3-renderHeavy-nAt`、`S4-shiki-engine`、`S5-owt-tail`、`S6-shiki-wrapper`、`S7-git-state-hook`、`S8-git-autorefresh`、`S10-diffviewer`、`S11-diffs-worker`、`S12-jCt-viewer`、`S13-codeview-body`、`S14-codeview-xt`。
- 脚本：`D:\tmp\zc-analysis\sp28-defs.mjs` ~ `sp83.mjs`（定义定位、字符串扫描、切片+beautify 的 `sp29-beau.mjs <start> <end> <name>` 可复用）。

## 6. 剩余风险 / 未验证点

1. **`Xt`（行号版代码视图）内部实现未展开**：在 `catalogTree-D7q4FnnV.js`（655KB）内，本次只确认其 shiki 依赖与 props 接口。
2. **gitService 最终执行体不在 renderer bundle**：经 `xf` RPC（call/listen/onDynamic*）由 Root 注入的 baseServices 承载，实际 git 进程调用在主进程/sidecar 侧，需另行分析 `out/main` 才能闭环。
3. **last-turn 数据集在本构建疑似被桩掉**：`yme` 恒以 `fileChange:null` 构建该数据集（依赖数组 `[null,null,...]`），面板该 tab 只会显示空态；快照机器完整存在但未接线到该 hook。
4. 偏移为 JS 字符串（UTF-16 单元）偏移，与磁盘字节偏移在多字节字符后有漂移；不同版本 bundle（srcLen≠4584754）不可直接复用。