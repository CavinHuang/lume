分析完成。以下为完整技术报告（所有美化解剖产物已存至 `D:\tmp\zc-analysis\out\sidepane\`）。

---

# ZCode 桌面端右侧 SidePane：Wiki-Reference 面板与终端架构逆向报告

## 0. 总览与产物清单

| 产物文件（D:\tmp\zc-analysis\out\sidepane\） | 内容 |
|---|---|
| `WikiReferenceSidePane.raw.js` / `.b.js` | WikiReferenceSidePane-D4JOTihA.js 全文（raw 11,048 B / 美化 563 行） |
| `R1-repowiki-service.js` | styles@2557000–2602000：RepoWikiPane（wiki 生成管理面板，注意≠SidePane 引用面板） |
| `R3-catalogtree-wikiref.js` / `R13-wiki-event.js` | catalogTree@648000+：wiki-reference 共享纯函数层（targetKey/拼 markdown/插入 composer 事件） |
| `R5-sidepane-shell.js` | styles@3776000–3818000：SidePane 壳（tab 条、"+" 菜单、分类型渲染 switch） |
| `R6-sidepane-state.js` | styles@195000–236000：tab 工厂 + `Qde` 工作区面板 Hook + RPC 协议头 |
| `R7-terminal-panel.js` | styles@3818000–3833000：底部终端面板 `kAt`/`AAt` |
| `R8-terminal-xterm.js` | styles@3619000–3636000：xterm 组件 `CTt`、侧栏包装 `wTt` |
| `R9-entry.js` | index-CKD0zXuV.js 全文：renderer 服务 RPC 代理装配 |
| `R11-host-pty.js` / `R12-host-channel.js` | host 进程 node-pty 终端服务实现 / ChannelServer 装配 |
| 其余 `sp*.mjs` | 定位/扫描脚本（字节偏移锚点） |

**使用的 chunk**：`styles-C2WGZ-SY.js`（4.60MB 主包：壳/状态/xterm/终端面板）、`WikiReferenceSidePane-D4JOTihA.js`（懒加载分块）、`catalogTree-D7q4FnnV.js`（655KB 共享层）、`index-CKD0zXuV.js`（20.9KB 入口）、`src-C3so_Fno.js`（258KB 预加载桥/通道常量）、`out/host/index.js`（2.27MB 宿主进程）、`out/main/index.js`（已排除：无 pty/终端代码，`terminal:` 命中为流批次 `terminal` 标志位，@1100701/@1101549）。

---

## 1. WikiReferenceSidePane：仓库 Wiki 引用面板

### 1.1 它是什么
不是搜索器，而是 **“Repo Wiki → 聊天引用”装配器**：把已生成的仓库 wiki（整库 / 分组 / 单页）拼成 markdown 并插入聊天输入框。与 `l2`（RepoWikiPane，styles@~2558000，负责 AI 生成 wiki 的管理 UI：模型/语言/图表选项、generate/stop/regenerate/delete）是姊妹功能——SidePane 只**消费**已发布 wiki，不负责生成。

### 1.2 组件与状态（chunk 全文，导出 `j as WikiReferenceSidePane`，props `{workspacePath, workspaceIdentity}`）
- `useServices`（catalogTree 导出 `tr`）取 `{repoWikiService}`（wiki chunk raw@884）。
- 状态：`summary`(wiki)、`error`、`selectedTarget`：`{kind:'wiki'} | {kind:'page',pageId,title} | {kind:'group',node,title,pageIds}`、`collapsedNodeIds:Set`、`previewCache:{targetKey,pages}`、`previewLoading`。
- 副作用 1（raw@1195）：`repoWikiService.readSummary({workspacePath, workspaceIdentity})` → `{wiki}`；并订阅 `repoWikiService.onDidChangeRepoWiki(e => { e.workspaceKey === (workspaceIdentity?.trim()||workspacePath) && setWiki(e.wiki) })`，dispose 释放。
- 副作用 2（raw@1975）：`selectedTarget` 变化 → `repoWikiService.readPages({..., pageIds})` → 预览页；用 targetKey 做缓存竞态防护（`CR`：`previewPageCount>0 && previewTargetKey===targetKey`）。
- 纯函数全部来自 catalogTree 导出（`sp24-exp.mjs` 确认别名映射）：`t=LR`（summary→目录树，按 parentId/`catalogTree` 分组并裁剪到已生成页）、`c=SR`（targetKey：`wiki`/`group:${nodeId}`/`page:${pageId}`）、`u=TR`（节点下 pageIds 收集）、`d=ER`（引用标题 `Repo Wiki: X`/`Wiki 分组：X`/`Wiki 页面: X`）、`s=OR`（markdown 装配：整库=`# Repo Wiki：名` + 目录摘要缩进列表；分组/多页=`# Wiki 分组：X` + 各页以 `\n\n---\n\n` 连接）。
- 子组件：`M`（目录列表：整库项 + 递归节点 `N`，带折叠箭头、右键 ContextMenu「引用页面/引用分组」）、`P`（右侧预览：markdown 以 `\n\n---\n\n` join 后经 prose 渲染器渲染）。

### 1.3 数据流与落点（关键交互）
点「引用 Wiki/分组/页面」按钮 → `Z()`（raw@2145 附近）：
```js
let m = c===`wiki`||l.length===0 ? [] : p ? z.pages : (await n.readPages({workspacePath, workspaceIdentity, pageIds:l})).pages.filter(e=>e!==null),
    g = d({kind:c, language:o.language, wiki:o, title:..., pageIds:l, pages:m});   // 拼 markdown
...
a({workspacePath:e, workspaceIdentity:t, title:s({kind:c, wiki:o, title:...}), markdown:g}) || h(i.formatMessage({id:`wikiReference.composerMissing`}))
```
`a` = catalogTree 导出 `a` = 内部 `NR`（R13，catalogTree raw@650187）：
```js
var jR = `zcode:add-wiki-to-chat`;
function NR(e){ ... let t=new CustomEvent(jR,{cancelable:!0, detail:e}); return !window.dispatchEvent(t) }
```
即向 `window` 派发**可取消** CustomEvent `zcode:add-wiki-to-chat`（detail `{workspacePath, workspaceIdentity, title, markdown}`）；聊天 composer 监听并 `preventDefault` → 函数返回 true（成功）；无人监听（如 Web 壳无 composer）→ 返回 false → 显示 `wikiReference.composerMissing`。配套导出 `FR`（`new File([markdown], '<slug>.md', {type:'text/markdown'})`，文件名由 `DR` slug 化，兜底名 `wiki-reference.md`）供 composer 端作为附件插入。

### 1.4 侧栏入口可见性（styles 内）
- 壳组件（R5@1122–1153）自己调 `repoWikiService.readSummary` + `onDidChangeRepoWiki`，用谓词（catalogTree `f=wR`：`wiki && !(task pending|running)`）得 `hasCompletedWiki`；
- `qe = $kt({activeTaskId, hasCompletedWiki, ...})`（R5@867）：**必须有活跃任务且有已生成 wiki** 才在"+"菜单显示 wiki-reference 项（R5@1374 `"data-side-pane-add-item": "wiki-reference"`）。

---

## 2. 终端架构：真 PTY、真 xterm，两处呈现、一个服务

### 2.1 结论
侧栏 `terminal` tab **不是启动器**，它内嵌完整 xterm.js 终端；应用另有 `isTerminalOpen` 控制的**底部终端面板**。两者是同一个 `CTt` xterm 组件 + 同一个 `terminalService`（RPC → host 进程 node-pty）的两种宿主。

### 2.2 协议栈（自底向上）
1. **host 进程**（`out/host/index.js`）：
   - 懒加载 `import('node-pty')`（raw@112907 起；失败文案 `node-pty is unavailable in this runtime`）。
   - `createTerminalService`（`wA`，R11，raw@116729–117943）：
     - shell 解析：win32 依次 `pwsh.exe → powershell.exe → %ComSpec% → cmd.exe`；unix `$SHELL → /bin/zsh → /bin/bash → /bin/sh`（PATH 可执行性探测）；cwd 校验目录、退化 `HOME → /`。
     - env 整形：`TERM=xterm-256color`、`COLORTERM=truecolor`、C/POSIX locale 修为 UTF-8、darwin 补 Homebrew PATH。
     - spawn：win32 `pty.spawn(shell, [], {useConpty:true, useConptyDll:true, ...})`，conpty.dll 加载失败降级 `useConptyDll:false`；unix `pty.spawn(shell, [], {name:'xterm-256color', encoding:'utf8'})`。返回 `{id:String(n++), shell, fontFamily, fontSize, theme, fontFamilySource, windowsPty:{backend:'conpty', buildNumber}}`。
     - 字体探测 `detectSystemTerminalProfile`：读 Windows Terminal settings.json、VS Code `terminal.integrated.fontFamily`、kitty.conf、alacritty toml/yml；设置项 `terminalFontFamily` 优先（`source:'custom'|'system'|'fallback'`）。
     - 会话表 `Map<id, {pty, dataEmitter, exitEmitter}>`；API：`create/write/resize/dispose/disposeAll` + `onDynamicData(id)`、`onDynamicExit(id)`（per-id 动态事件）；`onExit` 自动清理并删表。
   - DI 注册：`.register(Lc, wA({settingService:r}))`（raw@2170670）。
2. **传输**：`exposeServicesOnMessagePort`（`G7e`，R12，raw@2259233）——MessagePortLike 之上建 VS Code 式 RPC（`ChannelServer`，帧类型 Promise=100/EventListen=102/EventFire=204，VSBuffer 序列化，见 R6@~229600 起）。main 进程经 `zcode:service-port`（src-C3so_Fno.js@230815）把 port 递给 renderer；通道名常量表在 src-C3so_Fno.js@229812：`fw={..., Terminal:'terminal', ..., RepoWiki:'repo-wiki', ...}`。
3. **renderer 代理**（index-CKD0zXuV.js，raw@2708）：
   ```js
   this.terminalService = l.toService(e.getChannel(he.channelName)),
   ...
   this.repoWikiService = l.toService(e.getChannel(ke.channelName))
   ```
   `toService` Proxy（styles@~238900）：`onXxx` → `channel.listen`；`onDynamicXxx` → 带 id 参数的 EventListen（动态 per-id 事件多路复用）；其余方法 → `channel.call`。

### 2.3 renderer 组件 `CTt`（styles raw@3622250，R8）
- **持久模式**（有 `persistentKey`，即侧栏 tab）：走 `Hu` 会话注册表（styles raw@130505–130677，源内名 `[sidePaneTerminalSessionRegistry]`）：
  - `Hu.get(key)` 命中 → 复用 `{term, fitAddon, terminalId, hostEl, profileTheme}`，`attachDom` 把 hostEl 重新挂进当前容器；未命中 → 新建 xterm `Terminal`（styles 内打包的 xterm.js，@3329662 起；FitAddon + 另一 addon）+ host div，`terminalService.create({cols, rows, cwd})`，回填 `windowsPty`/fontFamily/fontSize/theme。
  - 卸载时：已有 PTY → `Hu.detachDom(key)`——把 hostEl 挪进全局隐藏 stash `div[data-side-pane-terminal-stash]`（@130246），**PTY 与回写继续、仅 DOM 离场**；无 PTY → `Hu.release(key)` 全量销毁。
  - 数据：`onDynamicData(id)` → `term.write($wt(e, shell))`（`$wt`@~3619700：PowerShell 专有回显怪癖修正，其余原样）；`onDynamicExit(id)` → 有 `onExit` 回调则自动关 tab，否则写 `terminal.exited`；`term.onData` → `terminalService.write({id, data})`（含 IME 组合输入去重：`Hwt/Wwt/Gwt/Uwt/Bwt/Kwt/qwt` + textarea composed-input 兜底 flush）。
  - 尺寸：FitAddon.fit()（ResizeObserver/可见性/拖拽结束三触发）→ 去抖 + 单飞（in-flight 标志 + pending 覆盖）`terminalService.resize({id, cols, rows})`。
  - 其他：主题跟随 CSS 变量 `--color-terminal-*`（`mTt`，MutationObserver 监听 `<html>` class）；Ctrl/Cmd+C 复制选区、+V 粘贴（`navigator.clipboard`）；OSC8 + 纯 http 链接 provider → `onOpenBrowserUrl`（交内嵌浏览器）。
- **非持久模式**（底部面板用）：同上但每次 React 卸载即 `dispose({id})` + `term.dispose()`。
- **侧栏包装 `wTt`**（raw@3635065）：`<section class="h-full...p-3"><CTt sessionId={tab.id} persistentKey={tab.id} workspaceKey cwd={tab.cwd??workspacePath} isVisible .../></section>`。

### 2.4 底部终端面板 vs 侧栏 tab 的关系
- 状态：`Qde` Hook（styles raw@214020，R6）按 workspaceKey 缓存（Map≤50，`Ad/jd`）返回 `{isTerminalOpen, setIsTerminalOpen, sidePaneState, recentClosedSidePaneTabs, ...}`。
  - `handleToggleTerminal`（`pe`）：仅翻转布尔，日志 `[App] 切换底部终端面板` ——**底部面板**。
  - `handleOpenTerminalTab`（`U`，raw@~222300）：`Zde` 去重命名（cwd basename + 序号）→ `fd(state, Jue({title, cwd, remoteSessionId}))`，日志 `[App] 新建右侧终端 tab` ——**侧栏 tab**。tab 载荷 `Jue`（raw@196866）：`{id:'terminal:'+io(), type:'terminal', openedAt, title, cwd?, remoteSessionId?}`。
- 底部面板：`kAt`（raw@3819889，R7）本地 reducer 管 `sessions:{[id]:{id, workspaceKey, services, cwd, index, shellLabel}}` + `workspaces:{[wsKey]:{sessionIds, activeSessionId}}`；首次可见确保每工作区至少一个会话（`DAt`）；关闭最后 tab=`close-panel`（回调收起面板）、否则 `close-session`；进程退出自动关（`EAt`）；`openWorkspaceKeys` 变化时剪掉已关工作区的会话。所有会话 Radix Tabs `forceMount` 隐藏保活。外壳 `AAt`（raw@3824273）：可折叠 ResizablePanel（`id:'terminal'`，min 140px/max 50%，border-t），挂载于工作区壳、右 SidePane 之后（raw@3862357），`onClose: () => Vt(!1)`。
- **会话复用**：底部面板（非持久）会话随组件树存活保活；侧栏 tab（持久，`persistentKey=tab.id`）在 tab 关闭时由壳显式 `Hu.release(e)`（R6 `handleCloseSidePaneTab`/`CloseOthers`/`CloseAll` 三处：`n?.type==='terminal' && Hu.release(e)`）——两条链路会话各自独立，不互通。

---

## 3. 与 SidePane 壳 tab 模型的集成

- **tab 载荷工厂**（styles raw@196194–197300，R6）：每类型一个工厂，`fd(state, tab)`=upsert+激活（同 id 复用并 bump `openedAt`）：
  - `Kue`（@196618）：`{id:'wiki-reference:'+encodeURIComponent(ownerTaskId), type:'wiki-reference', ownerTaskId, workspaceKey, openedAt}` ——**按 ownerTaskId 单例**。
  - `Jue`（@196866）：terminal，**每次新 id（`io()`）**，可多开。
  - 其余：browser/browser-use（常驻+residency 挂起恢复）、git（`id:'git'` 单例）、repo-wiki（`id:'repo-wiki'` 单例）、developer-tools、model-trajectory、subagent-session/directory、selection-side-chat（带 ordinal）、plan-detail、whiteboard、code-viewer（sourceKey 去重）。单例集 `tde={git, repo-wiki, developer-tools, treemapping}`。
- **作用域与折叠**：tabs 按 `{workspaceKey, ownerTaskId}` 过滤（`Sd/hd`）；`ode` 计算 activeTabId + `isSidePaneCollapsed`（无可见 tab 即折叠）；工作区切换经缓存 Map 迁移。
- **激活/关闭/重排**：`handleActivateSidePaneTab`（suspended browser 先 `browserViewEnsureResident`）、DnD 重排（dnd-kit，distance:4）、关闭三连（单个/其他/全部，browser 需 main authority 确认、terminal 需 `Hu.release`、selection-side-chat 需关子会话），最近关闭栈 8 条支持 reopen。
- **渲染**（R5@1658–1795）：所有 tab `forceMount` + `data-[state=inactive]:hidden` 保活；分类型 switch——`wiki-reference` → `<Suspense fallback="wikiReference.loading"><mAt workspacePath workspaceIdentity/></Suspense>`，`mAt = Q.lazy(() => import('./WikiReferenceSidePane-D4JOTihA.js'))`（raw@3797952，独立 chunk 首次展开才下载）；`terminal` → `wTt`（raw@~3815470）；`repo-wiki` → 内联 `l2`。
- **tab 条**：图标/标题/aria/搜索关键词按 type 分派（raw@3776722–3781527，如 `wiki-reference → Tc 图标 + wikiReference.panelTitle`、`terminal → ${title} terminal shell command`）；"+" 下拉菜单与空态 `side-pane-open-tab-shell` 按钮列表共用 `Zkt` 可用项计算（raw@3796125：`selection-side-conversation? → review(无 git 时) → terminal(恒有) → browser? → wiki-reference? → developer-tools?`）。
- **埋点通道**：`repo_wiki.lifecycle:[generate,stop,regenerate,delete,open_node,change_model]`、`workbench.terminal:[open,close]`、`settings.terminal:[toggle_system_profile,save_font_family,change_shell]`（styles raw@885500 区域，R2）。

---

## 4. 关键字节偏移速查

**styles-C2WGZ-SY.js**：`Hu` 注册表 @130246–130677；RPC 通道客户端 @~238900–239900（`Tf(xo.Terminal)`@239651、`Tf(xo.RepoWiki)`@267802）；tab 工厂 @196618–196980；`hde`（打开 wiki-reference）@204918；`Zde`（终端 tab 命名）@213803；`Qde` Hook @214020；xterm.js 打包体 @3329662+；`CTt` @3622250；`wTt` @3635065；`kAt` @3819889；`AAt` @3824273（挂载点 @3862357）；tab 图标/标题分派 @3776722+；`Zkt` @3796125；`mAt` lazy @3797952；分类型渲染 switch @3815003+。**catalogTree**：wiki 助手群 @648000–651600（`zcode:add-wiki-to-chat`@650089、`NR`@650187）。**src-C3so_Fno.js**：通道名表 @229812、service-port @230815。**index-CKD0zXuV.js**：服务装配 @2708。**host/index.js**：node-pty 加载 @112907、`createTerminalService` @116729–117943、DI 注册 @2170670、ChannelServer @2259233。

**遗留不确定点**：composer 侧对 `zcode:add-wiki-to-chat` 的监听器在主包内以别名引用（字面量仅存在于 catalogTree），插入形态（追加文本 vs `FR` 附件 File）未能从字面量定位；`$wt` 的 PowerShell 具体修正规则（`Qwt`）未逐行展开。