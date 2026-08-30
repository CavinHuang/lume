所有分析已完成。以下是技术报告。

---

# ZCode 桌面端 SidePane SUBAGENT 面板逆向报告

**目标**: `D:\software\zcode\resources\app\out\renderer\assets\styles-C2WGZ-SY.js`（4,584,754 字节，minified）
**方法**: node 脚本 `indexOf` 锚点 → 切片 → js-beautify；所有产物（`L$-full.b.js` 2031 行、`handlers-open/close.b.js`、`red-*.b.js`、`rewind-ui.b.js`、`kxe-layer.b.js` 等）存于 `D:\tmp\zc-analysis\out\sidepane-q1\`。下文偏移均为原文件字节偏移。

## 0. 渲染分发与 Tab 载荷（总览）

SidePane 按 `tab.type` 分发（偏移 3813475 起）：

```js
// raw 3813475
children: i.type === `subagent-session` ? (0, $.jsx)(Mkt, {
    tab: i,
    focused: r && i.id === Ce,
    onOpenBrowserUrl: te,
    onOpenCodeViewer: ne,
    onOpenFileLink: re,
    onOpenSubagentSession: ie
  }) : i.type === `subagent-directory` ? (0, $.jsx)(Vkt, {
    tab: i,
    onOpenSubagentSession: ie
  }) : i.type === `selection-side-chat` ? (0, $.jsx)(Ukt, {
    tab: i,
    focused: r && i.id === Ce,
    ...
    onUnavailable: k          // k = onCloseTab
  }) : ...
```

三类 tab 由工厂函数生成（id 为 URI-encode 拼接）：

```js
// function Yue( raw 197090 —— subagent-session tab
function Yue(e) {
  let t = e.rootSessionId ?? e.parentSessionId;
  return {
    id: [`subagent-session`, cd(e.workspaceKey), cd(t), cd(e.childSessionId)].join(`:`),
    type: `subagent-session`,
    openedAt: Date.now(),
    workspaceKey: e.workspaceKey,
    workspacePath: e.workspacePath,
    ...e.workspaceIdentity ? { workspaceIdentity: e.workspaceIdentity } : {},
    ...e.remoteSessionId ? { remoteSessionId: e.remoteSessionId } : {},
    rootSessionId: t,
    parentSessionId: e.parentSessionId,
    childSessionId: e.childSessionId,
    subagentType: e.subagentType,
    title: e.title.trim()
  }
}
```

`Xue`（raw 197594，`subagent-directory:${ws}:${root}:${parent}`）与 `Zue`（raw 198022，`selection-side-chat:${ws}:${parent}:${child}` + `ordinal`）同构。tab 的 upsert 由 `fd`（raw 199877）完成：已存在则原位替换并激活，不存在则追加并激活——同一 child 重复打开不会产生新 tab。

## 1. `L$` 会话视图（raw 2285206–2333731，2031 行）

`L$` 是通用 V4 会话面板（workspace-main、split、sidebar、subagent、selection 全部复用它）。签名 props 决定了三种入口的差异：

```js
// raw 2285206
function L$({
    paneId: e, sessionId: t, openTrigger: n, rootSessionId: r,
    readOnly: i = !1, allowWorkspaceFileRewind: o = !1,
    selectionSideChat: s = !1, activeSelectionSideChatSessionId: c = null,
    workspacePath: l, workspaceIdentity: u, remoteSessionId: d,
    compactForRemoteControl: f = !1, provider: p, onSessionCreated: m,
    onSelectionSideChatUnavailable: h, focused: g = !0, telemetryVisible: _ = !0,
    ...
    onOpenSubagentSession: z, onOpenSubagentDirectory: B,
    onSyncSubagentSessionTabs: V, onOpenSelectionSideChat: ee, ...
```

### 1.1 实时订阅

`Mkt`/`Ukt` 先用 `Uv`（raw 565095）按 `{workspacePath, workspaceIdentity?, remoteSessionId?}` 建 scope：`Uv → hp(...) → kxe(...)`（raw 494227）按 workspaceKey 租赁共享 transport 并 new 一个 `q_` SessionDataLayer（raw 488673），同一 workspace 的主面板与子面板共享同一条 V4 订阅通道。`L$` 内部按 sessionId acquire：

```js
// raw 2301395（L$ 内）
(0, Q.useEffect)(() => {
  if (!An) { xe(null); return }        // An = sessionId ?? prewarm 绑定
  let e = oe.acquire(An),              // oe = layer (Hv())
    t = e.store.onOnlineModelTransition(t => Nn.current(An, e.store, t));
  return xe(e), () => { t(), e.release() }   // 引用计数释放
}, [oe, An])
```

`q_.acquire` 返回 `{sessionId, store, openKind: cold|warm|keep_warm, startedAt, release}`；底层 transport 的订阅命令是 `subscribeSessionsIndexV4`（raw 832948，带 subscriptionId ack、runtime 重启检测、失败回滚 unsubscribe），帧经 `store.handleFrame` 投影为 snapshot（`rows.window` 分页窗口、`revision/logEpoch`、`config`、`control.{phase,canStop,lastError}`、`queue`、`pendingInteractions`、`subagents`、`backgroundWorks`）。组件用 `QQ`（raw 2248185，`useSyncExternalStore(store.subscribe)`）订阅快照；store 另有 `loadOlder/loadAllOlder/retry/refreshPlans/recoverFromStaleAuthority`，冷快照首 turn 不完整时自动补拉（raw 2321140 区）。最后一次 `release` 后 store 保留 ~30s keep-warm 才关闭。

### 1.2 readOnly 语义（`Mkt`: readOnly:!0 + allowWorkspaceFileRewind:!0）

readOnly 是"纯观看"模式，在 L$ 内部通过一组 gate 实现：

```js
// raw 2323929 / 2327705 / 2328782
let Sr = !i && !s && !!t,      // 行内 Retry
    Cr = !i && !s && !!t,      // 行内 Fork
    wr = !i && !s && !!t;      // 行内编辑用户消息
...
let tee = i ? null : (0, $.jsx)(nqe, { ... onSendText: Vn, ... }, `conversation-composer`),   // readOnly → 不渲染输入框
    ei = i ? null : (0, $.jsxs)($.Fragment, { ... 错误横幅/队列/交互卡/输入框 ... });          // readOnly → 整个 bottomDock 为 null
```

- **Composer 不存在** → 不能从侧栏子代理面板下发任何 steer 指令；`ei`（bottomDock）同时隐藏配额错误条、命令队列、pendingInteractions 卡片。
- 行级操作全部摘除：`onFork: Cr ? Gn : void 0`、`onRetry: Sr ? Yn : void 0`、`onEdit: wr ? Kn : void 0`、`onFeedbackChange: !i && !s && t ? Xn : void 0`（raw 2332890 附近）；选区动作 `selectionActions: !Tr && t && !i && !s && !Ge ? {...} : void 0`（raw 2333615）。
- Esc 停止快捷键被禁用（raw 2322869 `!g || i || !t || !Ce?.control.canStop`）；`onPauseGoal/onResumeGoal/onCancelBackgroundWork` 同样以 `!i && !s`/`i ? void 0` 摘除。
- 控制层错误降级为被动横幅：`i && Rr` 时渲染 `data-testid="v4-subagent-readonly-error"`（raw 2332200）。
- **唯一保留的写操作是文件回滚（rewind）**：

```js
// raw 2298268 / 2295146 附近
let Sn = !i || o,                       // readOnly 且未显式允许 → 关闭；subagent 面板两开关组合后 Sn = true
  ...
  ln = (0, Q.useCallback)(e => {        // previewFileRewind → fileRewindPreview RPC
      ... de({ sessionId: t, target: e, baseRevision: n.revision, baseLogEpoch: n.logEpoch }) ... }),
  un = (0, Q.useCallback)(e => {        // applyFileRewind → 会话命令（带 CAS）
      if (!t || !n) throw Error(`Cannot apply file rewind without an active session revision`);
      return sn(`applyFileRewind`, { target: e }, t, n.revision, n.logEpoch) }, [sn, t]),
```

消费端是 turn 摘要卡 `_6e`（raw 2078400 区）：`S = !!(t.applyFileRewind && t.previewFileRewind) && e.actions?.canRewindFiles === !0 && !x`（x = 已 reverted），弹窗先 preview（返回 `canApply/safeFiles/unsafeFiles/ignoredFiles`）再 apply（`accepted/duplicate`）。命令 schema（raw 104102）显示 `applyFileRewind` 属于需要前台 authority 的命令集合。**即：read-only 子代理面板可以回滚该 turn 对工作区文件的改动，但不能对话。**

### 1.3 subagent-session 与 selection-side-chat 的入参差异

```js
// raw 3785849  Mkt（subagent-session 包装器）
var Mkt = (0, Q.memo)(function({ tab: e, focused: t, ... }) {
  return (0, $.jsx)(Uv, { scope: (0, Q.useMemo)(() => ({ workspacePath: e.workspacePath,
      ...e.workspaceIdentity ? {...} : {}, ...e.remoteSessionId ? {...} : {} }), [...]),
    children: (0, $.jsx)(L$, {
      paneId: e.id, sessionId: e.childSessionId, openTrigger: `subagent`,     // raw 3786294
      rootSessionId: e.rootSessionId,
      readOnly: !0, allowWorkspaceFileRewind: !0,                              // raw 3786347
      focused: t, telemetryVisible: t, ...
      onOpenSubagentSession: a }) })     // 允许在子面板里再点开嵌套子代理
```

```js
// raw 3793696  Ukt（selection-side-chat 包装器）
var Ukt = (0, Q.memo)(function({ tab: e, focused: t, ..., onUnavailable: a }) {
  let s = (0, Q.useCallback)(() => a(e.id), [a, e.id]);
  return (0, $.jsx)(Uv, { scope: o, children: (0, $.jsx)(L$, {
    paneId: e.id, sessionId: e.childSessionId, openTrigger: `selection`,      // raw 3794183
    selectionSideChat: !0,                                                     // raw 3944207
    focused: t, telemetryVisible: t, ..., onSelectionSideChatUnavailable: s }) })
```

selection-side-chat：不传 readOnly（**有 composer，可驱动**）、不传 rootSessionId；`s=!0` 带来的差异——goal 隐藏（`goal: s ? null`）、`suppressGoalCommands: s`、选区动作禁用、父面板通过 `Vd(t, !!kr)`（raw 210951）感知其是否有阻塞交互以禁用"再次提问"。当订阅报 `sessionNotFound` 时 effect 调 `h()` → `onUnavailable(tab.id)` → 关闭 tab（raw 2321220 区 effect）。`Mkt` 不传 `onSyncSubagentSessionTabs`，因此 sync 剪枝 effect 只在主 pane 生效（见 §3.3）。

## 2. `Hkt` 子代理目录（raw 3791707）

`Vkt`（raw 3791329）只是 `Uv` scope 包装；`Hkt` 双通道发现子会话——**父会话实时快照（running）+ RPC 查询（ended 分页）**：

```js
// raw 3791707 起（beautified）
Hkt = (0, Q.memo)(function({ tab: e, onOpenSubagentSession: t }) {
  let { intl: n } = K(), { layer: r } = Hv(), [i, a] = (0, Q.useState)(null),
      o = QQ(i), s = o.snapshot?.subagents;          // 订阅“父会话”的 V4 快照
  (0, Q.useEffect)(() => { let t = r.acquire(e.parentSessionId);   // raw 3791881
      return a(t), () => t.release() }, [r, e.parentSessionId]);
  let c = Ikt({ enabled: o.snapshot !== null, workspacePath: e.workspacePath,
        workspaceIdentity: e.workspaceIdentity, remoteSessionId: e.remoteSessionId,
        sessionId: e.parentSessionId, refreshKey: s?.revision ?? 0 }),
    l = s?.running ?? Lkt, u = s?.endedTotal ?? 0,
    d = n => { t(Rkt(e, n)) };                        // 点击行 → 打开 subagent-session tab
```

- **running 列表**来自父会话实时快照 `snapshot.subagents.running`（默认 `Vnt = {revision:0, childSessionIds:[], running:[], endedTotal:0}`，raw 2284381；`Lkt=[]` raw 3789426）。快照 `revision` 变化作为 `refreshKey` 触发 ended 列表重查。
- **ended 列表**由分页 hook `Ikt`（raw 3786930）管理，查询 `zcodeAgentService.listSessionSubagents`（raw 3787171）：

```js
// raw 3786603 / 3786930
var R8 = 20, Nkt = 100;      // 每页 20，首帧请求上限 100
function Ikt(e) {
  let t = Jr().zcodeAgentService, [n, r] = (0, Q.useState)(z8),
      i = (0, Q.useRef)(0), a = (0, Q.useRef)('inflight' && !1), o = (0, Q.useRef)(R8), s = (0, Q.useRef)(n);
  ...
  let l = (0, Q.useCallback)((n, r) => e.sessionId
      ? typeof t?.listSessionSubagents == `function`
        ? t.listSessionSubagents({ workspacePath: ..., sessionId: e.sessionId,
            endedLimit: n, ...r ? { endedCursor: r } : {} })
        : Promise.resolve({ revision: 0, childSessionIds: [], running: [], ended: { total: 0, items: [] } })
      : Promise.reject(Error(`session_id_missing`)), [...]),
```

刷新流程：请求 `min(max(20, 已加载数), 100)` 条；`Fkt`（目标数 = `requestedCount + max(0, nextTotal - previousTotal)`）防止 total 增长时漏拉，`while (u.length < c && d)` 用 20/页的 cursor 循环补齐；`Pkt` 按 `childSessionId` 去重合并；`loadMore` 每次按 cursor 追加一页 20 条。in-flight 用 revision 计数器丢弃过期响应。hook 返回 `{revision, ended:{total,items,nextCursor?}, error, loading, loadMore, refresh}`。

- **渲染**：标题 `subagentDirectory.title`（raw 3792473）；running 区标题 `subagentDirectory.running · N`，空态 `subagentDirectory.runningEmpty`；ended 区标题 `subagentDirectory.ended · total`，有 `nextCursor` 时显示 `subagentDirectory.showMore` 按钮（raw 3793481，`variant=ghost size=sm`）；错误 `subagentDirectory.loadFailed`（alert，raw 3793649）。
- **行组件 `Bkt`**（raw 3789840 附近）：状态图标 `zkt`（raw 3789753，running=旋转、waiting/blocked、success、failed、cancelled、lost 六态）+ 标题 + i18n `subagentDirectory.status.${status}`（raw 3791053）+ summary 单行截断 + 相对时间（`endedAt ?? startedAt`）。
- **打开动作**：`Rkt(tab, item)`（raw 3789433）把目录项还原成 subagent-session tab 载荷 `{workspacePath/Identity?/remoteSessionId?, rootSessionId, parentSessionId, childSessionId, subagentType, title}`。

## 3. 子会话生命周期

### 3.1 创建（spawn）

- **subagent 子会话**：由 agent runtime 在父会话内 spawn（Task/Agent 工具），renderer 不参与创建。渲染层从父快照的 turn 行（toolCall 带 `childSessionId`）与 `snapshot.subagents.running` 感知；点击行经 `u6e`（raw 2068742）→ `onOpenSubagentSession({rootSessionId: context.rootSessionId ?? sessionId, parentSessionId, childSessionId, subagentType, title})` 打开面板。父面板 summary 区 `pQe`（`runningSubagents/endedSubagentCount/onOpenSubagentDirectory`，raw 2327xxx 区）提供目录入口。
- **selection-side-chat 子会话**：renderer 主动创建，走父会话命令 `createSelectionSideSession`（命令 schema raw 106059；调用点 `hn`/`gn`，raw 2296396 区）：复用链先 `me.readSession({sessionId: c, messageLimit: 1})` 验证首选 child，`sessionNotFound` 则 `Bd(r), Xd(r, lt)` 清登记后重建并带 `replacesChildSessionId`。

### 3.2 Tab 打开与 preferred-tab

`handleOpenSubagentSession`（handlers 区，dump `handlers-open.b.js`，raw 218500–224400）：

```js
ce = (0, Q.useCallback)(e => {
  let t = e.workspaceIdentity?.trim() || e.workspacePath,
      n = e.rootSessionId ?? e.parentSessionId;
  b(!1), P(r => {
    let i = vde(r, { workspaceKey: t, ..., rootSessionId: n,
        parentSessionId: e.parentSessionId, childSessionId: e.childSessionId,
        subagentType: e.subagentType, title: e.title });
    return D.current.set(n, i.activeTabId),   // preferred-tab: rootSessionId → activeTabId
      J.debug(`[App] 打开子智能体右侧 tab parent=${e.parentSessionId} child=${e.childSessionId} ...`), i
  })
}, [P]),
```

`vde`（raw 205124）按 tab id 幂等 upsert（已存在则仅更新 workspace/身份/subagentType/title，不重置打开时间）；`le`=handleOpenSubagentDirectory → `yde`（raw 205544）。activate/reorder/close 时同步维护 `D.current`。

### 3.3 剪枝（prune）：handleSyncSubagentSessionTabs → bde

主 pane 的 `L$` 把快照里的合法 child 上报（raw 2324133）：

```js
// raw 2324133（L$ 内）
(0, Q.useEffect)(() => {
  !t || Or.revision === 0 || !V ||      // V = onSyncSubagentSessionTabs（仅 workspace-main 传入）
    V({ rootSessionId: r ?? t, parentSessionId: t,
        validChildSessionIds: Or.childSessionIds })
}, [V, r, t, Or.childSessionIds, Or.revision]);
```

`ue = e => N(t => bde(t, e))`（raw 222285 附近）应用剪枝 reducer `bde`（raw 205666）：

```js
// raw 205666
function bde(e, t) {                       // e: {tabs, activeTabId}, t: sync 载荷
  if (!e) return null;
  let n = new Set(t.validChildSessionIds),
    r = e.tabs.filter(e => e.type === `subagent-session`
        && e.rootSessionId === t.rootSessionId
        && e.parentSessionId === t.parentSessionId
        && !n.has(e.childSessionId));      // 找出失效的 child tab
  if (r.length === 0) return e;
  let i = new Set(r.map(e => e.id)),
    a = e.tabs.filter(e => !i.has(e.id));
  if (a.length === 0) return null;         // 全空 → 侧栏收起
  if (!i.has(e.activeTabId)) return { ...e, tabs: a };
  let o = a.find(e => e.type === `subagent-directory` && e.rootSessionId === t.rootSessionId);
  if (o) return { tabs: a, activeTabId: o.id };       // 激活 tab 被剪 → 回落同 root 的目录 tab
  ...
}
```

### 3.4 关闭：只有 selection-side-chat 会真正关 runtime

`handleCloseSidePaneTab`（`xe`，raw 226113）：`n?.type === 'selection-side-chat' && fe(n)` —— 仅对框选副屏调用 `fe`；subagent-session tab 关闭**不调用 closeSession**（子会话生命周期归父 runtime，deferred 持久化，由 runtime 回收）。`fe`（raw 222980 区）：

```js
// raw 223242（日志锚点）附近
fe = (0, Q.useCallback)(e => {
  Bd(e.childSessionId), Xd(e.childSessionId, e.workspaceKey),   // 清 busy 登记与选区草稿
  f.closeSession({ workspacePath: e.workspacePath,
      ...e.workspaceIdentity ? { workspaceIdentity: e.workspaceIdentity } : {},
      sessionId: e.childSessionId })
    .catch(t => { String(t).includes(`sessionNotFound`) ||
      J.warn(`[App] 关闭框选副屏 runtime 失败`, {...}) })
}, [f]);   // f = zcodeSessionService
```

父会话结束时的清理事件（`aue` 订阅，raw 223733 日志锚点 `[App] 父任务结束，清理框选副屏会话`）同样**只遍历 `selection-side-chat` tabs** 逐个 `fe` + 移除；subagent-session tabs 不在清理范围。

### 3.5 子会话结束后面板的状态

- subagent-session tab **保留**，面板继续渲染最终 transcript（快照含 `control.phase`、最终行；无 composer 亦无"已结束"接管 UI，仅 `mQe` 断连错误时显示 reconnect）；不会自动关闭，只在 child id 被 prune 判定失效时移除。关闭 tab 后 store 进入 ~30s keep-warm 再销毁（`q_.releaseEntry`，raw 488673）。
- 目录面板中该项从 running 移入 ended（status：`success/failed/cancelled/lost`），`endedTotal` 增长驱动 `Ikt` 刷新补页。
- subagent-session/directory tab 关闭后进入"最近关闭"（`ye` 只排除 `selection-side-chat` 与 `browser-use`，raw handlers-close），可从 recently-closed 重开（重建走 `vde/yde` 幂等 upsert）。

## 4. subagentType：取值与渲染影响

`subagentType` 是**自由字符串**（agent 类型名），不是固定枚举。对话行的派生函数 `e0e`（raw 1938156）按优先级合成：

```js
// raw 1938156（节选）
function e0e(e, t, n) {
  let r = PY(e.output), i = kY(e.input) ? e.input : null,
      a = kY(e.raw) ? e.raw : null,
      o = MY(e.raw, [`_meta`, `zcode`, `agentType`]) ?? MY(e.raw, [`_meta`, `zcode`, `agent_type`])
          ?? MY(e.raw, [`_meta`, `zcode`, `subagent_type`]);
  return ((n?.trim() || void 0) ?? IY(r) ?? FY(e) ?? IY(i) ?? o)
         || (a?.inputPreviewComplete === !0 ? t || Z1e : ``)   // Z1e = `general-purpose`（raw 1936887）
}
function IY(e) { return e ? AY(e, [`agentType`, `agent_type`, `subagentType`, `subagent_type`, `name`, `nickname`]) : void 0 }  // raw 1937969
function Q1e(e) { let t = e.trim().toLowerCase().replace(/[\s-]+/g, `_`);
  return t === `agent` || t === `task` || t === `spawn_agent` }   // raw 1937851：泛化工具名不当标题
```

优先级：外部传入 n（目录项/快照）→ output 对象的 agentType/agent_type/subagentType/subagent_type/name/nickname → nickname（`_meta.zcode.nickname`）→ input 同名字段 → raw `_meta.zcode.*` → 兜底 `general-purpose`（仅在输入已完整时）。running 项若由 background work 合成则固定 `subagentType: 'subagent'`（raw 1774767）。

**渲染影响**：
- tab 标题：`subagent-session` 用 `e.title?.trim() || i18n('sidePane.subagent')`（`L8` raw 3778426；最近关闭列表的 `Akt` raw 3781022 则用 `e.subagentType.trim() || subagentTypeLabel`）；selection-side-chat 标题 = `sidePane.selectionChat + ' ' + ordinal`；directory 固定 `sidePane.subagentDirectory`。tab 图标 `P8`（raw 3775982）按 type 选图标。
- tab 搜索文本把 `title + subagentType + parentSessionId + childSessionId` 拼进索引（raw 3779599）。
- 会话摘要行 `I8e` 显示 `subagentType · status — summary`（raw 2133567）；目录行显示 `subagentDirectory.status.${status}`。
- 对 L$ 的会话渲染本身**无分支影响**：subagent 面板行为差异完全由 props（`readOnly/allowWorkspaceFileRewind/selectionSideChat`）驱动，而非 subagentType。

## 5. 关键结论

1. subagent-session 面板 = 父 workspace 共享 V4 实时通道上的只读子会话视图；readOnly 摘除 composer/行操作/停止/暂停，仅保留（显式允许的）文件级 rewind（preview + `applyFileRewind` CAS 命令）。
2. selection-side-chat 面板 = 可写的 L$（有 composer，可 steer），child 由 `createSelectionSideSession` 命令创建，tab 关闭/父会话结束都会 `zcodeSessionService.closeSession`；subagent-session 的关闭只删 tab，不杀会话。
3. 目录面板 = 父会话实时快照（running + endedTotal + revision）∪ `listSessionSubagents` 游标分页（页 20，首请求上限 100，去重、防 total 回退漏拉）。
4. 剪枝闭环：主 pane L$ 每次父快照 revision 变化上报 `validChildSessionIds` → `bde` 删除失效 subagent tab，激活态回落同 root 的 directory tab。

**遗留不确定点**：`_xe`（per-session store）内部的帧→快照归约细节未展开；`listSessionSubagents` 的服务端实现不在本 bundle（sidecar/main 进程）；`R8`/`Nkt` 常量在压缩体内联后的个别引用点可能遗漏。