All analysis complete. Here is the technical report.

---

# ZCode 桌面端右侧 SidePane SHELL 架构逆向报告

目标文件：`D:\software\zcode\resources\app\out\renderer\assets\styles-C2WGZ-SY.js`（4,584,754 字节，单行压缩）
切片输出：`D:\tmp\zc-analysis\out\sidepane\`（文末清单）。提取脚本：`D:\tmp\zc-analysis\sp1-anchors.mjs` ~ `sp14-final.mjs`。

架构总览：SidePane 是一个三层结构 —— **纯 reducer 层**（bytes ~195.4K–213.8K，全部为可测试纯函数）→ **App 级控制器 Hook `Qde`**（~214K–228.7K，持有 React 状态 + 所有 `handle*`）→ **Shell 渲染组件 `yAt`**（~3800.4K–3827K，`workspace-side-pane` ErrorBoundary scope + 标签条 + 面板布局）。App（~3884.5K）调用 Hook，把 handles 全量透传给 WorkspaceShell（~3898.3K），再由 `xjt`/WorkspaceShellLayout（~3831K–3851K）实例化 `yAt`。

---

## 1. Tab 模型

### 1.1 sidePaneState 形状

```js
// @209610  Ed = 默认 workspace 存储; Dd = 按 workspaceKey 的模块级 Map
var Ed = {
    sidePaneState: null,          // { tabs: SidePaneTab[], activeTabId: string } | null
    isSidePaneCollapsed: !0,      // 默认收起
    activeGitSourceId: `unstaged`,
    browserUrls: {},              // tabId -> url（恢复用）
    browserUrl: null
  },
  Dd = new Map;                 // workspaceKey -> Ed 形状的持久快照

function Od(e, t) { return Dd.delete(e), Dd.set(e, t), t }   // 写入（刷新 LRU 顺序）
function Fde() {            // 容量上限 50：超出淘汰最早插入的 workspaceKey
  for (; Dd.size > 50;) {
    let e = Dd.keys().next().value;
    if (!e) return;
    Dd.delete(e)
  }
}
function kd({ workspacePath, workspaceIdentity, taskId }) {  // workspaceKey 规约
  let r = workspaceIdentity?.trim() || workspacePath;
  return r.trim() ? r : null                                 // null = __draft__ 不持久化
}
function Ad(key) { /* 读：有则 sd() 消毒后返回，无则 Ed */ }
function jd(key, patch) { /* 写：{...Ed, ...旧值, ...patch} + sd() 消毒 + Fde() */ }
```
（切片 `B-ctx-Ed.beau.js` L27–74）

**持久化是 renderer 内存级**（模块 Map，切换 workspace `useEffect` cleanup 时 `jd` 落盘、卸载时再落一次，见 `C-hook-state.beau.js` L51–59），**不进 localStorage、不发主进程**。localStorage 只存 sidebar 宽度（`zcode:workspace-sidebar-width-px` @3818655 附近）和 developer-tools 开关（`zcode:developer-tools:enabled`）。`Ujt`（@3878163，切片 `N-helpers.beau.js`）复用同一 `Dd` 存储 `activeGitSourceId` 与 `browserUrls`（browser 标签恢复 URL）。

### 1.2 SidePaneTab 联合类型（15 种，工厂函数 @195.6K–196.5K，切片 `A-state-early.beau.js`）

| type | id 格式 | 每类载荷 |
|---|---|---|
| `browser` | `browser:${io()}` | faviconUrl, initialUrl, openedAt, title, + `residency`/`residencyGeneration`（挂起语义）、ownerTaskId/workspaceKey/remoteSessionId |
| `browser-use` | `browser-use:${tabId}` | sessionId, tabId, browserId?, browserGeneration?, title, faviconUrl, residency×2, `browserUseOperationUntil`, `browserUseResizeBaselineVersion` |
| `git` | 固定 `git` | 单例（无载荷） |
| `model-trajectory` | `model-trajectory:${taskId}` | taskId, title |
| `repo-wiki` | 固定 `repo-wiki` | 单例 |
| `wiki-reference` | `wiki-reference:${encodeURIComponent(ownerTaskId)}` | ownerTaskId, workspaceKey（**每任务一枚**） |
| `developer-tools` | 固定 `developer-tools` | 单例 |
| `terminal` | `terminal:${io()}` | title（`Zde` 查重 `Terminal`/`Terminal 2`…@213830）, cwd?, remoteSessionId? |
| `subagent-session` | `subagent-session:${ws}:${root}:${child}`（encodeURIComponent 拼接） | workspaceKey/Path/Identity?, remoteSessionId?, rootSessionId, parentSessionId, childSessionId, subagentType, title |
| `subagent-directory` | `subagent-directory:${ws}:${root}:${parent}` | 同上去掉 child/subagentType |
| `selection-side-chat` | `selection-side-chat:${ws}:${parent}:${child}` | parentSessionId, childSessionId, **ordinal**（同父会话内 1 起编号，`Sde`/`sd` 回填） |
| `plan-detail` | `plan-detail:${ws}:${parent}:${toolCallId}` | toolCallId, markdown, planFilePath? |
| `whiteboard` | `whiteboard:${boardId}` | boardId, title |
| `code-viewer` | `code-viewer:${sourceKey ?? io()}` | source, sourceKey。source 8 种：file/code-review/image/pdf/pptx/text（按 path）、patch、multi-file-diff（按内容 31 位 hash `ud`，`ld`@196.2K 生成 sourceKey） |
| `treemapping` | — | **遗留**：`sd()` 消毒时一律剔除（返回 null 若全为此类），入口已隐藏（`handleOpenTreemapping` 只打日志“已隐藏 treemapping 侧边栏入口”） |

**任务说明中的 `ghost` 不是 tab kind**：全文 `type===\`ghost\`` 0 命中；`` `ghost` `` 30+ 处全部是 shadcn Button `variant: 'ghost'`。

单例集合：`tde = new Set(['git','repo-wiki','developer-tools','treemapping'])`（@196.0K，`nde`=isSingleton）。归属判定 `xd(tab, ownerTaskId)`（@207032）：`browser-use`→`sessionId===owner`；`selection-side-chat`/`plan-detail`→`parentSessionId===owner`；`subagent-*`→`rootSessionId===owner`；**其余类型全局可见**（git/terminal/code-viewer/browser 等不随任务隔离）。

消毒函数 `sd(state)`（@195577）：剔除 treemapping → 回填缺失 ordinal → `activeTabId` 失效时回落到最后一个 tab。

### 1.3 recentClosedSidePaneTabs 环

```js
// @213797  环大小
var Xde = 8;
// Hook 内（D-sync-handles.beau.js L83-94）：
ye = e => {                       // 记录已关闭 tabs
  let t = e.filter(e => e.type !== `selection-side-chat` && e.type !== `browser-use`);
  if (t.length === 0) return;
  let n = Date.now();
  E(r => { let s = new Set(t.map(e => e.id));
    return [...t.map(e => ({ tab: e, closedAt: n })), ...r.filter(e => !s.has(e.tab.id))].slice(0, Xde) })
}
// 对外暴露按 owner 过滤：recentClosedSidePaneTabs = useMemo(() => T.filter(e => xd(e.tab, i)), [i, T])
```
条目 `{tab, closedAt}`，新条目插头部，按 id 去重，容量 8。`browser-use`（主进程持有）与 `selection-side-chat`（临时副屏）不入环。重开时 browser 类剥掉 residency 并换新 id（见 2.4）。

---

## 2. Operation 语义（handle* 家族）

全部定义于 Hook `Qde`（@214K–228.7K；handles 绑定块 @228411–228700，切片 `D-sync-handles.beau.js`）。核心 reducer 语义先澄清（切片 `A2-reducers.beau.js`）：

```js
// @208195  wd = 【关闭】tab（不是激活！）：删 tab；删空→null；
//          若删的是活动 tab → 激活原索引处的邻居
function wd(e, t) {
  if (!e) return null;
  let n = dd(e.tabs, t);                    // findIndex by id
  if (n < 0) return e;
  let r = e.tabs.filter(e => e.id !== t);
  return r.length === 0 ? null : e.activeTabId === t
    ? { tabs: r, activeTabId: r[Math.min(n, r.length - 1)].id }
    : { tabs: r, activeTabId: e.activeTabId }
}
function Td(e, t) { /* @208426 激活：activeTabId = t */ }
function Cd(e, t, n, r) { return Tde(wd(e, t), n, r) }  // @208150 关闭后按 owner 重算活动 tab
// Tde(@207890)：scope 内无 tab → activeTabId=''；优先 preferredTabId(r)，
// 再现活动 tab，再最后一个"任务系"tab（subagent*/selection-side-chat/plan-detail），再 scope 内最后一个
// Ede(@207796) 关其他：保留目标+非 scope tab，激活目标
// Dde(@207996) 关全部( scope 内)：清空后无剩余→null，否则 activeTabId=''
// Ade(@209134) 重排：splice(fromIdx→toIdx)
```

### 2.1 打开类（全部先 `b(!1)` 展开，再 `P(updater)`，P 会用 `ide` 给无主 tab 盖 `ownerTaskId/workspaceKey/remoteSessionId` 戳）
- `handleOpenCodeViewer(L)`：`yd`（@205.1K）——sourceKey 相同且同 owner 则复用并刷新 source，否则插入并激活；日志 `[App] 切换右侧面板 mode=code-viewer`。
- `handleOpenCodeViewers(R)`：`dde` 批量去重打开，最后激活第 index 个（默认 0）；日志 `批量打开右侧预览`。
- `handleOpenBrowserUrl(z)`：**非桌面壳直接 `window.open(url,'_blank','noopener,noreferrer')`**；桌面则设 `browserNavigationRequest`（状态 C/w）+ `_d` 强制新建 browser tab。
- `handleToggleBrowser(B)`：`jde`（@209.4K）——当前活动 tab 是本 owner 的 browser → 关闭（wd），否则 `gd`（@205.7K，按 owner 找现有 browser 复用，无则新建）。
- `handleOpenBrowserTab(V)`：无条件新 browser tab。
- `handleToggleGit(te)`：`Mde`——活动 tab 是 git → wd 关闭；否则 `bd` 打开。**git 是 toggle 语义**。
- `handleOpenGit(ne)`：`bd` 纯打开。
- `handleOpenWhiteboard/repo-wiki/wiki-reference/developer-tools/terminal-tab/model-trajectory`：各自 `fde/mde/hde/gde/_de/pde`；wiki-reference 按 ownerTaskId 幂等且刷新 `openedAt`；terminal 先 `Zde` 生成查重标题（cwd.basename，撞名加序号）。
- `handleOpenSubagentSession/Directory(ce/le)`：`vde/yde` 幂等打开，并写 `D.current.set(rootSessionId, tabId)`（preferredTabId 表，供关闭后回落）。
- `handleSyncSubagentSessionTabs(ue)`：`bde`（@205.6K）——按 `validChildSessionIds` 剪除已失效的 subagent-session tab，若剪掉的是活动 tab 优先回落到 subagent-directory。
- `handleOpenSelectionSideChat(W)`：`xde`；若声明 `replacesChildSessionId` 先 wd 旧 tab；`fe` 负责调 `zcodeSessionService.closeSession` 关子会话运行时。
- `handleOpenPlanDetail(de)`：`wde` 幂等。
- `handleToggleTerminal(pe)`：**只切 `isTerminalOpen`（底部终端），与 SidePane 无关**。
- `handleToggleSidebar(me)`：只切 `isSidebarVisible`（左侧栏）。
- `handleToggleSidePaneCollapse(he)`：
```js
// D-sync-handles.beau.js L39-44
he = (0, Q.useCallback)(() => {
  b(e => { let n = !e;
    J.info(`[App] ${n?`收起`:`展开`}右侧面板 workspace=${t} tabs=${_?.tabs.length??0}`); return n })
}, [_, t]),
```

### 2.2 关闭类（三段式：会话清理 → 主进程权威 → renderer reducer）
- `be(tabIds)`（D L95-114）：对 `browser`/`browser-use` tab **必须经主进程权威** `platform.browserViewCloseTab({tabId, workspaceKey, remoteSessionId?, sessionId})`，失败（或桌面缺 authority）则返回 false 中止关闭。
- `handleCloseSidePaneTab(xe)`：selection-side-chat 先 `fe`（关运行时会话）→ `be` → 入环 `ye` → **terminal tab 调 `Hu.release(id)` 销毁终端会话** → `Cd(state, id, owner, D.current.get(owner))` → `I(result)` 自动收起判定。
- `handleCloseOtherSidePaneTabs(Se)`：scope 内（`xd`）除目标外全部走上述三段式，reducer 用 `Ede`（保留非 scope tab）。
- `handleCloseAllSidePaneTabs(Ce)`：scope 内全部，reducer `Dde`。
- `handleCloseCodeViewer(G)`：`Nde`——活动 tab 是 code-viewer 才 wd，否则 no-op。`handleCloseGit(X)`：`Pde = wd(e,'git')` 直接关单例。

### 2.3 激活/重排
- `handleActivateSidePaneTab(_e)`（D L57-79）：若目标是 suspended 的 browser/browser-use，先发 **IPC `browserViewEnsureResident`**（@224581）让主进程复活 webContents（失败仅 warn），然后 `Td` 激活；subagent 类同时写 preferredTabId 表。
- `handleReorderSidePaneTab(ve)`：`Ade` 纯数组重排，**不**改 activeTabId。

### 2.4 重开 / 杂项
```js
// D-sync-handles.beau.js L154-172
we = (0, Q.useCallback)(e => {            // handleReopenClosedSidePaneTab
  let n = T.find(t => t.tab.id === e);
  n && (b(!1),                            // 先展开
    N(e => { let t = n.tab;
      if (n.tab.type === `browser`) {     // browser：剥 residency，换新 id
        let { residency: e, residencyGeneration: r, ...i } = n.tab;
        t = { ...i, id: `browser:${io()}` }
      }
      let r = sde(e, t);                  // fd = upsert+激活
      return (subagent 类) && D.current.set(t.rootSessionId, t.id), r }),
    E(t => t.filter(t => t.tab.id !== e)),  // 出环
    J.info(`[App] 重新打开最近关闭右侧面板 tab=${e} workspace=${t}`))
}),
Te = /* handleBrowserNavigationRequestHandled：清空 browserNavigationRequest */
Ee = /* handleBrowserPageMetadataChange：Ode 给 browser/browser-use tab 打 title/favicon 补丁 */
```

`I(result)` 自动收起：scope 内（`Sd(tabs,{workspaceKey,ownerTaskId})`）有 tab → 展开，无 → 收起（C L60-70）。此外 App 级监听 `$8`（见 §5）和“新建任务自动收起”（§5）。

---

## 3. Layout

### 3.1 面板几何（eAt/tAt/nAt @3796670–3797010，切片 `E-shell.beau.js` L1054-1087）

```js
function tAt({ mobileOverlay: e }) {
  return e ? { collapsedSize:`0px`, defaultSize:`100%`, maxSize:`100%`,
               minSize:`0px`, useResizablePanel:!1 }      // 移动 overlay：非可缩 div
           : { collapsedSize:`0px`, defaultSize:`0px`, maxSize:`65%`,
               minSize:`240px`, useResizablePanel:!0 }    // 桌面：react-resizable-panels
}
function nAt({ isActiveTab, isMobileOverlay=false, isResizeSettling=false,
               isSidePaneVisible, minVisibleInlineSizePx=96, visibleInlineSizePx }) {
  return !r || !e ? !1 : t ? !0 : n ? !1 : a === null ? !0 : a >= i   // renderHeavyContent
}
```
- **isResizeSettling**（`vAt` @3796960）：监听 `window.resize`+`visualViewport.resize`，置 true 后 **220ms**（`dAt`）静默期才回 false；期间 code-viewer 不渲染重内容。
- **visibleInlineSizePx**（`gAt`/`_At` @3797570–3797810）：rAF 合流的 ResizeObserver 测面板可见宽度；`< 96px`（`minVisibleInlineSizePx` @3797020）同样跳过重渲染。
- 面板折叠时记忆宽度：隐藏前记 `parent.width * 0.45`（`Kkt=.45` @3797809），重展开时先以记忆宽度占位 200ms（`uAt`）再清空（E-shell L1392-1413）。

### 3.2 折叠/展开动画（PAt/NAt @3825836–3826900，切片 `E2-ghost-term.beau.js` L517-591）

```js
function NAt(e) {   // 给 panel element 临时加 class，flex-grow 过渡结束后移除
  e.classList.add(...[`transition-[flex-grow]`,`duration-200`,`ease-out`]);
  ...
  i = t => { t.target === e && t.propertyName === `flex-grow` && r() };
  e.addEventListener(`transitionend`, i), n = window.setTimeout(r, 240)  // MAt 兜底
}
function PAt({ open, alwaysMounted=false, expandedSize, rememberExpandedSize=false,
               resizeOnInitialVisibleMount=true }) {
  ... // open 变化 → rAF 后 resize(expandedSize) 或 collapse()；
      // rememberExpandedSize 时先把 getSize().asPercentage 存回 expandedSize
  return { panelRef, panelElementRef, isVisible: l }
}
```
WorkspaceShellLayout 中的两处使用（@3834866/@3834981，切片 `F-consumer1.beau.js` L40-58）：
- **底部终端** `AAt`（@3824273）：`PAt({open: isTerminalOpen, expandedSize:'30%', rememberExpandedSize:true})`；Panel id `terminal`，`minSize 140px / maxSize 50%`，包 `f0 scope="workspace-terminal"`。
- **右侧面板**：`PAt({open: view==='chat' && isSidePaneOpen, expandedSize:'45%', rememberExpandedSize:true, resizeOnInitialVisibleMount:false})`；Panel id `browser`（即 SidePane），`minSize 240px / maxSize 65%`，包 `f0 scope="workspace-side-pane"`（@3810332）。可见性淡入用 `opacity-100 / pointer-events-none opacity-0` + `transition-opacity duration-200`；不可见仍挂载（`collapsible: fe=!r`、`disabled: pe=!r`），标签内容用 `forceMount` + `data-[state=inactive]:hidden` 保活。

### 3.3 移动端
- 桌面窄屏（`mobileOverlay` prop）：`tAt` 切到非可缩 100%；外层 `mobileStacked` 时 `max-md:!h-[min(45dvh,24rem)] border-t`（上下堆叠），overlay 时 `max-md:!h-full` 全屏（E2 L27）。
- Web remote 手机壳（@2835855，切片 `K-mobile-overlay.beau.js`）：`data-mobile-side-pane-overlay` 容器 = 全屏半透明背景按钮（点击即 collapse，aria-label `sidePane.collapse`）+ 右侧滑入 sheet `w-[min(88vw,28rem)]`，`translate-x-full → 0` 200ms。
- conversation 列过窄自动收起（F L75-119，常量 `fjt=360`/`ljt=480` @3818700）：resize 防抖 300ms 后，`<480px` 先收 SidePane（`handleToggleSidePane`），`<360px` 再收左侧栏，日志 `[WorkspaceShellLayout] conversation 过窄…`。

### 3.4 标签条
- DOM 标记（@3773003）：`data-side-pane-tab-id`、`data-active`、`data-state=active|inactive`、`data-browser-tab-residency`；外层 `data-side-pane-tabs-viewport`（横向滚动 + 左右渐变 mask）+ `data-side-pane-tabs-content`。
- 拖拽重排：dnd-kit（`KG` DndContext，activation distance 4px，`sK` SortableContext + `PYe` horizontal 策略），`onDragEnd` 调 `onReorderTab(activeId, overId)`。
- 溢出逻辑 `Xkt`（E-shell L1014）：估宽 `tabs*60px + gap*8px`，超 viewport 则 `Pe=true`，"+" 按钮从标签行内移到右侧独立区；`Ie.left/right` 控制双向渐隐 mask。
- 加号菜单 `data-side-pane-add-item`（@3805581+）：`selection-side-conversation`（需活动任务+非移动）、`review`（无 git tab 时）、`terminal`、`browser`（支持内嵌时）、`wiki-reference`（需已完成 wiki）、`developer-tools`（localStorage 开关 `lAt` 轮询 1s）。空态页 `data-side-pane-open-tab-item` 大按钮列表同源（`Zkt`）。
- 标签总览弹层 `jkt`（cmdk 搜索 + 打开/最近关闭两组 + 相对时间，每分钟刷新）。

### 3.5 与底部终端 / 左侧栏关系
SidePane 终端 tab（`wTt`）与底部终端面板（`kAt`@3819889 / `AAt`）是**两套独立会话**，共享同一个会话注册表 `Hu`（`sidePaneTerminalSessionRegistry`，@129050–129700，切片 `J-termstash.beau.js` L63-112）：Map 保存 `{hostEl, dispose,...}`；`attachDom` 把 hostEl 移入当前容器，`detachDom` 移入 `document.body` 下隐藏 stash div（`data-side-pane-terminal-stash` @130251）——**关闭 SidePane 不杀终端，重开无损恢复**；`Hu.release` 仅在显式关 tab 时调用；workspace 全关时 `releaseByPredicate` 批量回收（F L35-38）。`isSidebarVisible` 只管左侧栏；`isTerminalOpen` 只管底部；`isSidePaneOpen = !isSidePaneCollapsed`（App 处 `Sn=!Se` @3896632 附近）。suspended 的 browser/browser-use tab 渲染占位 `hAt` 并向主进程 ack `browserViewSuspendReady`（@3798562）。

---

## 4. 渲染分发（yAt 内，@3810400–3827000，切片 `E-shell.beau.js` L1836-1967 + `E2` L1-37）

门闩：`Me = Bue(visible, tabs)`（`Bue` @195413：`visible || tabs.some(browser类)`，一旦为真不再回退）——首次出现 browser 类 tab 前整块内容区不渲染（显示“打开标签页”空态）。活动 tab 以 scope 修正后的 `Ce`（scope 内有效则用 activeTabId，否则 scope 内最后一个）驱动 `e_`（Tabs）。

| kind | 组件 | 备注 |
|---|---|---|
| subagent-session | `Mkt`→`L$`（会话视图，readOnly+允许 rewind） | 包 `Uv scope` |
| subagent-directory | `Vkt`→`Hkt`（运行中/已结束列表，`Ikt` 分页 hook，limit 20→100） | |
| selection-side-chat | `Ukt`→`L$`（`selectionSideChat:true`，失效自动 `onUnavailable=onCloseTab`） | |
| plan-detail | `Gkt`→`Wkt`（从父会话快照里找 toolCall 渲染 markdown） | |
| code-viewer | `owt`，传 `renderHeavyContent=nAt(...)` | |
| git | `YEt`（gitState/activeGitSourceId/fileChange find…） | |
| treemapping | `zDt`（遗留） | |
| whiteboard | `WDt` | |
| model-trajectory | `ekt` | |
| repo-wiki | `l2` | |
| **wiki-reference** | **`Q.Suspense` + `mAt`** | **唯一 lazy 边界**，见下 |
| developer-tools | `lkt`（`lAt` localStorage 轮询开关控制入口与渲染） | |
| terminal | `wTt`（`isVisible=r && id===Ce`） | |
| browser | `wEt`（webContentsView guest；`isVisible=r && o && id===Ce`） | |
| browser/use suspended | `hAt` 占位 + suspendReady ack | |

```js
// @3797940  唯一的 React.lazy 切片边界（E-shell.beau.js L1139）
mAt = (0, Q.lazy)(() => Y(() => import(`./WikiReferenceSidePane-D4JOTihA.js`)
      .then(e => ({ default: e.WikiReferenceSidePane })),
      __vite__mapDeps([2063, 2, 2064, 2021, ...]), import.meta.url));
// 使用处： <Q.Suspense fallback={<div>{fmt('wikiReference.loading')}</div>}>
//           <mAt workspacePath={c} workspaceIdentity={l} />
```
标签条标题 `L8`（每 kind 的 i18n key，patch/multi-file-diff 加 `diff.title` 徽标 `Skt`）；图标 `P8` 按 kind + 文件类型（`Wt(path).fileIconSrc`）分发。关闭标签的右键菜单：关闭 / 关闭其他（`canCloseOtherTabs = tabs.length>1`）/ 关闭全部（`bkt` L134-147）。

---

## 5. 会话同步（“同步对话右侧”）与主进程通信

### 5.1 App 级 owner/scope 同步（核心 effect @215573，切片 `C-hook-state.beau.js` L71-88）

```js
useEffect(() => { N(e => {
    let t = `${d}::${a ?? `__draft__`}`,                       // workspaceKey::ownerTaskId
        n = A.current.get(t) ?? (i ? D.current.get(i) : void 0),  // preferredTabId 两级表
        r = ode(e, { workspaceKey: d, ownerTaskId: a }, n);
    return b(r.isSidePaneCollapsed),
      J.debug(`[App] 同步对话右侧面板 scope`, {
        activeTabId: r.sidePaneState?.activeTabId ?? null, activeTaskId: i,
        isSidePaneCollapsed: r.isSidePaneCollapsed, ownerTaskId: a,
        preferredTabId: n ?? null, workspaceKey: d }),
      r.sidePaneState })
}, [i, d, N, a]);    // 依赖: activeTaskId, workspaceKey, sidePaneOwnerId
```
- `sidePaneOwnerId = activeTaskId ?? draftSessionId ?? null`（@3884463 前的 App 代码，切片 `L-app-Qde.beau.js` L16-19）——**对话切换（含切到草稿）都会触发 scope 重算**：`ade` 在 owner 可见 tab 集合里选活动 tab（preferred → 现活动 → scope 内最后一个），`ode` 返回 `{sidePaneState, isSidePaneCollapsed: scope内无tab}`。
- 每次 mutation 经 `P`→`ide`（@200359）给**无主 tab 补盖** `ownerTaskId/workspaceKey/remoteSessionId`；切 workspace 时旧 key `jd` 存 Map、新 key `Ad` 恢复（§1.1）。**这一切都在 renderer 内，不向主进程发送 sidePaneState**。
- 新建任务收起（@3885589，`L-app-Qde` L99-114）：`draftFocusVersion` 变化且面板展开时 `Ce(!0)` 收起，日志 `[App] 新建任务时收起右侧面板`。

### 5.2 与主进程（Electron platform 层）的通道
| 方向 | 通道 | 触发点 |
|---|---|---|
| renderer→main | `browserViewEnsureResident` @224581 | 激活 suspended browser tab |
| renderer→main | `browserViewCloseTab` @225510 | 关闭 browser 类 tab 的权威仲裁 |
| renderer→main | `browserViewSuspendReady` @3798562 | suspended 占位 ack |
| main→renderer | `onOpenBrowserUrl` @217510 附近 | webview 请求开新 tab（disposition）→ `handleOpenBrowserUrl` |
| main→renderer | `onBrowserViewReady/Operation/Visibility/CloseTab/Suspend/Restore` | browser-use 生命周期：挂载激活(`lde`)、操作窗 `Date.now()+5000`（`zue=5e3` @195405，`kde` 可 bump resize baseline）、可见性激活(`ude`)、跨 workspace 关 tab、residency 迁移(`vd`) |
| main→renderer | `onBrowserViewScreenshotSurfacePrepare/Release`（`AEt` @3685801，TTL `jEt=180000`） | browser-use 截图 surface 协调 |

窗口级：`$8 = 'zcode:close-active-context-request'`（@3881424）——主进程菜单"关闭活动上下文”派发该 window Event（@4572358），App 监听（`L-app-Qde` L221-233）：工作区可见且面板展开时 `preventDefault()` 并 `handleCloseSidePaneTab(活动tab)`，否则放行落到底层 `executeDesktopCommand(Qa.CloseWindow)`——**Cmd+W 先关右侧 tab、再关窗口**。

其他会话联动：父任务结束事件（`aue` @118582 任务事件总线）→ 关闭该父会话全部 `selection-side-chat` tab 并 `closeSession` 清运行时（D L6-26）；model-trajectory 用 `Nd` pendingRequest store + `Ide` 订阅实现跨组件“请求打开轨迹 tab"。

### 5.3 Props 透传链
App（@3898314，切片 `M-app-props.beau.js`）把 `isSidePaneOpen: Sn=!isSidePaneCollapsed`、`sidePaneState`、`recentClosedSidePaneTabs`、`browserNavigationRequest/browserRestoreUrls`、`activeGitSourceId`、`gitState` 及全部 24 个 handle 传给 WorkspaceShell → `xjt`（@3815772 附近的 memo 组件，props 解析见 `E2` L772-850）→ WorkspaceShellLayout（`F-consumer1`）→ `Lr = (t={}) => <yAt .../>`（@3846400 附近，`G-consumer2.beau.js` L78-132；`mobileOverlay:true` 时换用独立 `panelRef/panelElementRef` 并关截图 surface）。

---

## 6. 已存切片清单（`D:\tmp\zc-analysis\out\sidepane\`，每对含 .raw.js/.beau.js）

| 文件 | 原始字节区间 | 内容 |
|---|---|---|
| A-state-early | 195500–205500 | tab 工厂、sd/fd/pd/hd/ade/ode、browser-use 打开 |
| A2-reducers | 205500–209400 | wd/Td/Cd/Ede/Dde/Ade/Ode/kde、bde/xde/wde |
| B-ctx-Ed | 209300–211200 | Ed 默认值、Dd Map(≤50)、kd/Ad/jd、Nd 轨迹 store |
| C-hook-state | 214000–220200 | Qde 签名、scope 同步 effect、browser-use 事件订阅 |
| C2-hook-mid | 220200–223350 | whiteboard/repo-wiki/wiki-ref/devtools/terminal/subagent/selection/plan 打开器、fe 会话清理 |
| D-sync-handles | 223300–229600 | handle* 全家族 + Hook 返回对象、recentClosed 环 |
| E-shell | 3772000–3816000 | 标签条 DOM、dnd、加号菜单、P8/L8 图标标题、内容分发、eAt/tAt/nAt |
| E2-ghost-term | 3816000–3832000 | 面板尾部、底部终端 kAt/AAt、PAt/NAt 动画、xjt props、workspace 常量 |
| F-consumer1 | 3831000–3836500 | WorkspaceShellLayout：PAt 45%/30%、窄列自动收起 |
| G-consumer2 | 3845000–3851000 | `Lr=<yAt/>` 实例化（含 mobileOverlay 变体） |
| H-consumer3 | 3877000–3902000 | **格式化失败**（起始于字符串中部，js-beautify 退化 61 行）；关键部分由 L/M 覆盖 |
| J-termstash | 128800–133300 | Hu 终端注册表 + stash div |
| K-mobile-overlay | 2834500–2838000 | 移动壳 SidePane overlay/sheet |
| L-app-Qde | 3883200–3889000 | App 调用 Qde、owner 推导、新建任务收起、$8 监听 |
| M-app-props | 3896000–3899000 | App→WorkspaceShell 完整 props 表 |
| N-helpers.beau.js | （多点） | Bue/Vue/sd/AEt/kEt/Xd/aue/Yjt/Ujt 原始切片 |

脚本：`sp1-anchors.mjs`（锚点索引）、`sp3-extract.mjs`/`sp4-extract2.mjs`/`sp10-extract3.mjs`（切片）、`sp6-grep.mjs`（beau 内 grep）、`sp11-helpers.mjs`~`sp14-final.mjs`（偏移定位）。

**残余风险/未覆盖**：`wEt`/`TEt`/`wTt`/`YEt` 等 tab 内容组件内部（browser guest、xterm、git 面板）未展开——属于各 tab 的自有架构，非 SHELL 范畴；`H-consumer3.beau.js` 不可读，如需 3877K–3898K 区间其余逻辑（Yjt 附近、workspace shell 状态机 `wjt`）需按 L/M 方式以更精确边界重新切片。