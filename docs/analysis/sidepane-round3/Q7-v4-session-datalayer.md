所有分析已完成。现在我来提交最终报告。

# ZCode 桌面端 V4 会话数据层深度分析报告（SidePane q7）

**目标文件**：`D:\software\zcode\resources\app\out\renderer\assets\styles-C2WGZ-SY.js`（4,584,754 字符，下称【主】）+ 协议 chunk `D:\software\zcode\resources\app\out\renderer\assets\src-C3so_Fno.js`（258,861 字符，下称【proto】）。
**方法**：node indexOf 锚点 → slice → js-beautify → 逐行 raw-offset 映射（`D:\tmp\zc-analysis\out\sidepane-q7\` 下 R1-q-class / R2b-frame-schema / R3-subscribe-v4 / R4-store-proj / P*-proto 系列 .beau.js/.offmap.txt）。
**命名映射说明**：V4 协议 schema 全部由【主】从【proto】导入（`import{...}from"./src-C3so_Fno.js"` @【主】61065-65539）。关键映射（样式 chunk 局部名 ← proto 导出名 ← proto 局部定义）：`$ie`←`nc`←`Ll`(快照)、`Si`←`Cc`←`Yc`(行联合)、`Va`←`hc`←`ol`(phase 枚举)、`aie`←`fc`←`fl`(control)、`Vie`←`lc`←`bl`(queue)、`Nae`←`sc`←`El`(pendingInteractions)、`Qre`←`ec`←`Ol`(backgroundWorks)、`bre`←`_c`←`Al`(subagents)、`Die`←`jc`←`Vs`(delta path)、`Ya`←limits 表 `Hs`。任务给的锚点全部命中：`q_`=@488677、`subscribeSessionsIndexV4`=@832948、`function QQ(`=@2248185、`SessionDataLayer` 注释名 @488960。

---

## 1. 帧→快照归约（Frame→Snapshot Reduction）

### 1.1 传输包络：分片协议（wireVersion 3）

【proto】@80200-80600（R2b 区域），包络为 discriminated union，`kind: complete | fragment`：

```js
// 【proto】~80350  fragment 分支（beautified 摘录）
ba({ wireVersion: uo(3), kind: uo(`fragment`), deliveryKind: Rl,
     logicalFrameId: xa().min(1), logicalFrameOrdinal: Bi()…,
     topic: xa().min(1), subscriptionId: xa().min(1),
     fragmentIndex: Bi().int().nonnegative(),
     fragmentCount: Bi().int().positive().max(Ya.logicalFrameAssemblyMaxFragments),
     logicalBytes: Bi().int().positive(),
     checksum: lle, dataBase64: cre }).strict()
```
`lle` = `{algorithm:'crc32', value:/^[0-9a-f]{8}$/}`（@【proto】80290 附近）。superRefine 校验 `fragmentIndex < fragmentCount`、`fragmentCount ≤ logicalBytes`、complete 帧内层 topic/subscriptionId 必须与包络一致。分片上限来自 limits 表 `Hs`（【proto】@87272）：`maxFrameBytes: 1MB`、`logicalFrameAssemblyMaxBytes: 16MB`、`logicalFrameAssemblyMaxFragments: 1024`、`logicalFrameAssemblyTimeoutMs: 30000`。`deliveryKind ∈ {initial, online, recovery}`（@【proto】80320）。

会话握手：`hello` 帧 `{kind:'hello', protocolVersion:3, connectionId, clientMode:'desktop-continuous'|'web-remote-replayable', deliveryProfile:'continuous'|'replayable', capabilities:{nativeDialogs,localTerminal,binaryFrames,compression:'none'|'permessage-deflate',workspaceHookReview?}}`（@【proto】~80700）。

### 1.2 逻辑帧：snapshot | deltas + 订阅 ack

主题帧构造器 `Ul(snapshotSchema, opSchema)`（@【proto】~83230）：

```js
// 【proto】~83240
function Ul(e, t) {
  return ba({ topic: xa(), subscriptionId: xa(),
    fromSeq: Bi(), toSeq: Bi(), sentAt: Wi,
    payload: Vi(`kind`, [
      ba({ kind: uo(`snapshot`), snapshot: e }),
      ba({ kind: uo(`deltas`), deltas: _a(t) })]) })
}
var Wl = Ul($ie, Yce).superRefine(/* topic 必须以 `conversation/` 开头 */)
```

订阅请求 `{topic, base:{logEpoch,seq}?, visibility:'foreground'|'background'}`；ack `Vl = {subscriptionId, mode:'snapshot'|'resume', logEpoch}`，扩展 `hle` 增加打开计时 `openTiming:{version:1, hostPrepareMs, providerRegistrySyncMs, taskMetaReadMs, cliRequestMs, cliBootstrapMs, cliSessionRestoreMs, initialFrameEncodeMs, cliProcessState:'spawned'|'reused', sessionRuntimeState:'cold'|'warm', snapshotRowCount}`（@【proto】83080-83350）。恢复（resync）请求 `{subscriptionId, base:{logEpoch,seq}|null, forceSnapshot?}`。

### 1.3 delta op 集与 reducer

会话 op 联合 `Yce`（@【主】76900 附近，prettier 错误转储全文佐证）：

```js
// 【主】~76940（原文压缩，此处展开）
Yce = Vi(`op`, [
  ba({ op: uo(`row.appended`), row: Si }),
  ba({ op: uo(`row.upserted`), row: Si }),
  ba({ op: uo(`row.removed`), fromRowId: Bi() }),
  ba({ op: uo(`row.delta`), rowId: Bi(), path: Die, append: xa() }),
  ba({ op: uo(`state.updated`), patch: Jce })])
```

纯 reducer `Zce`（@【主】77600-78300；beautified 全文见 `out/sidepane-q7/R2b-frame-schema.raw.js`）：

- `row.appended`：`window:[...window, row]`, `totalCount+1`, `firstRowId ??= row.rowId`
- `row.upserted`：按 `rowId` 查 window，命中则替换（未命中**丢弃**——window 外旧行不回灌）
- `row.removed`：`window.filter(r => r.rowId < fromRowId)`；若 `fromRowId <= firstRowId` 则 `totalCount=0, firstRowId=null`（前缀清空即视为"无更早历史"）
- `state.updated`：`{...state, ...patch}`，patch schema `Jce` 字段 = `revision?, control, availability, inputRouting, meta, config, modelTransition, usage, queue, pendingInteractions, pendingCommands, backgroundWorks, subagents, goal, plan, workspaceHookAdmission`

快照根 `Ll`（=styles `$ie`，【proto】@113526）：`{protocolVersion:1, sessionId, logEpoch, seq, revision, control, availability, inputRouting, meta, config, modelTransition, usage, queue, pendingInteractions, pendingCommands, backgroundWorks, subagents?, goal, plan, workspaceHookAdmission, rows:{window:[], totalCount, firstRowId}}`。

### 1.4 行 schema（8 种 kind，discriminated on `kind`）

行联合 `Yc`（【proto】@105132）= `[Rc, zc, Bc, Vc, Uc, Wc, Kc, timelineMarker]`，公共基座 `Fc`（@100209）：`{rowId, turnId, entityId?, productTurnId?, visibility?, createdAt, createdAtSeq, actions?{canFork,canEdit,canRetry,canRewindFiles,editDisposition}}`。

| kind | 偏移【proto】 | 关键字段 |
|---|---|---|
| `turnHeader` | 100794 | origin(userInput/backgroundResult/goalContinuation/editRerun)、state(running/completedSuccess/completedInterrupted/failed)、workSegments、fileChanges{additions,deletions,files} |
| `userInput` | 101331 | text、origin(realUser/backgroundResult/goalContinuation/mailbox/synthetic)、sourceCommandId、attachments |
| `assistantText` | 101826 | text、state(streaming/complete/interrupted/failed)、feedback(like/dislike) |
| `reasoning` | 102035 | text、state(streaming/complete/interrupted)、durationMs |
| `toolCall` | 102315 | 见 1.5 |
| `subagent` | ~102900 | parentToolCallId、subagentType、status(running/success/failed/cancelled)、summaryText、childSessionId |
| `hookInvocation` | 103811 | hookEventName、executions[] |
| `timelineMarker` | 105175 | marker: compact/forkNotice/modelChange/goalSet/goalVerify/retryNotice/checkpointRestored |

### 1.5 toolCall 行流式（partial inputText）

toolCall 行（【proto】@102315）：

```js
// 【proto】~102315（展开）
Uc = D({ ...Fc, kind: M(`toolCall`),
  toolCallId: x(), toolName: x(),
  status: j([`inputStreaming`,`pendingApproval`,`running`,`success`,`error`,`cancelled`]),
  inputText: x(),                      // 流式追加的原始输入
  input: T().optional(),               // 解析后的完整输入（终态才有）
  output: Mc.optional(),               // {text, display?, truncated?{totalBytes,ref}}
  display: Pc.optional(),              // node_repl_images / task_output / mcp_tool …
  progress: Nc.optional(),             // {bytes, previewLine?, updatedAt}
  approvalInteractionId: x().optional(),
  backgrounded: M(!0).optional(), workId: x().optional(), … })
```

流式增量走 `row.delta` + 路径枚举 `Vs`（【proto】@87153）`j(['text','inputText','output.text','summaryText'])`，追加器 `Xce`（@【主】77100 附近）按 kind 分派：`text`→assistantText/reasoning、`inputText`→toolCall（即**输入流式阶段** `status:'inputStreaming'`）、`output.text`→toolCall.output、`summaryText`→subagent。output 终态被服务端截断为 head/tail 各 32KB（`toolOutputFinalHeadBytes/TailBytes`，@【proto】87272 区域 limits 表），超限部分以 `truncated:{totalBytes, ref}` 引用按需读取。

### 1.6 rows.window 语义 + loadOlder / loadAllOlder

window 是**尾部滑动窗口**：初始快照只带 `snapshotTailWindowRows: 60` 行（limits 表 @【proto】87272）。向上翻页用 `rowsRange` RPC（limit ≤ `rowsRangeMaxLimit: 200`），按 `beforeRowId` 向前取。

`_xe.loadOlder`（@【主】481957，beautified R1:1284-1327）——单页补拉，三重防护：

```js
// 【主】483214 起（R1:1302-1318）
let i = this.state.snapshot;
if (!i || t.atLogEpoch !== i.logEpoch) {   // ① 纪元不匹配 → 整批丢弃
    J.warn(`[v4-store] ${this.topic} rows/range 纪元不匹配（${t.atLogEpoch}），整体丢弃`); return }
if (i.rows.window[0]?.rowId !== r) return; // ② 窗口头游标已变 → 丢弃
let a = K_(i.rows.window, t.rows);         // ③ 只取 rowId < 当前窗头的行并前插
```
`G_`（@471326）= 有更早历史的判据：`firstRowId !== null && window[0].rowId > firstRowId`。

`loadAllOlder`（@482753，R1:1328-1450）是**回合导航器全量目录水合**：循环 `rowsRange(limit=200)` 翻页直到 `hasMore=false`；每页校验 `atLogEpoch`、快照 `logEpoch`、窗头游标三不变，否则整批丢弃返回 `{status:'stale'}`；游标未推进→`{status:'retryable-failure'}`；全部拼好后统计 `realUser` userInput 数，**<2 条**则判定"不是多回合会话"，仅在首 turn 不完整时保留补拉结果，终态 `{status:'not-enough-queries'}` 记入 `turnNavigatorHydrationTerminal`（按 logEpoch+directoryRevision 记忆，不重复探测）；成功→`{status:'hydrated'}`。

**冷快照首回合自动回填**（pane 层，@【主】2323402，R4:4048-4058）：

```js
// 【主】2323402（R4:4048-4057）
(0, Q.useEffect)(() => {
    if (!t || !be?.store || !gxe(Ce, Se.loadingOlder)) return;
    let e = Ce?.rows.window[0]?.rowId;
    if (e === void 0) return;
    let n = `${t}:${Se.subscriptionId??`connecting`}:${e}`;
    Ze.current !== n && (Ze.current = n, J.debug(`[v4-pane] 冷快照首 turn 不完整，自动补拉更早行`,
        { firstRowId: e, sessionId: t, turnId: Ce?.rows.window[0]?.turnId }), be.store.loadOlder())
}, [be, t, Ce, Se.loadingOlder, Se.subscriptionId]);
```
`gxe`（@471490 附近）= 窗口首行所属 turnId 在窗口内找不到对应 `turnHeader` → 说明快照从 turn 中段开始，自动 `loadOlder()` 一次（按 `sessionId:subscriptionId:rowId` 去重）。

### 1.7 revision / logEpoch CAS

- 快照携带单调 `revision` 与纪元 `logEpoch`；`state.updated.patch.revision` 随帧递增。
- **命令侧 CAS**：信封构造 `F_`（@【主】458521）强制校验：

```js
// 【主】458521（R1:328-345）
function F_(e) {
    if (Ble.has(e.type) && e.baseRevision === void 0)
        throw Error(`command ${e.type} 是 CAS 命令，必须携带 baseRevision（10-protocol-spec §6.4）`);
    if (Vle.has(e.type) && !e.baseLogEpoch)
        throw Error(`command ${e.type} 是 row target 命令，必须携带 baseLogEpoch`);
    return { commandId: Wbe(), clientId: Kbe(), sessionId: e.sessionId, …, issuedAt: Date.now() } }
```
`Ble`（@【主】105471）CAS 命令集 = applyFileRewind/forkAssistant/editUserQuery/retryTurn/setAssistantFeedback/sendQueuedNow/editQueueItem/reorderQueueItem/deleteQueueItem/setAutoDrain/switchModelConfig/switchCollaborationMode/setFollowupMode/pauseGoal/resumeGoal；`Vle` 行目标子集 = 前 5 个。渲染端实际传参示例：pauseGoal/resumeGoal 用 `sn(..., e.revision)`（@2322209/2322699）。CAS 失败错误码集合 `m9e = {proto.staleLogEpoch, proto.staleRevision, proto.staleTarget}`（@【主】2204700 附近）。
- **帧侧纪元防护**：deltas 应用要求 `fromSeq === snapshot.seq` 且 `toSeq > seq`（@【主】476561 applyFrame），断档即进入恢复流程（见 §4.4）。

---

## 2. Control 投影

### 2.1 phase 状态机

`control` schema `fl`（【proto】@109240）：

```js
// 【proto】109240（展开）
fl = D({ phase: ol, sessionEnded: w(), canStop: w(),
  stopState: j([`idle`,`stoppable`,`stopping`]),
  stopTargetKind: sl, activeWorks: E(cl),
  lastError: ul.nullable(), apiRetry: dl.nullable() })
var ol = j([`draft`,`prewarming`,`running`,`completedSuccess`,`completedInterrupted`,`error`])  // @107986
```
`phase` 是**服务端权威状态机**（经 `state.updated` 下发），渲染端不自行迁移，只做归并映射：任务列表侧 `Aje`（@【主】826307 附近）把 `running|prewarming→running`、`completedSuccess|completedInterrupted→completed`、`error→error`；面板侧 `Mnt(e) = e==='prewarming'||e==='running'`（@【主】2281806，R4:2231）用于"运行态"判定与配额刷新触发（phase 跨越 running 边界时强制刷新，R4:2304-2311）。`stopTargetKind ∈ {assistant,tool,subagent,compact,goalVerifier,goalContinuation,turnSteer,mixed,unknown}`；`activeWorks[]` 元素 `{kind: primaryTurn|foregroundSubagent|compact|goalVerifier|goalContinuation|turnSteer, foregroundExecutionId?, startedAt}`（@【proto】108100 附近）。

### 2.2 canStop 推导与 stop

`canStop`/`stopState` 由服务端计算；渲染端直接消费。stop 动作（@【主】2321933，R4:4004-4013）：

```js
// 【主】2321933（R4:4004-4012）
fr = (0, Q.useCallback)(() => {
    let e = Ke.current;                                   // 最新快照 ref
    if (!t || !e?.control.canStop) return;
    let n = e.control.activeWorks.find(e => e.foregroundExecutionId)?.foregroundExecutionId;
    sn(`stop`, n ? { expectedForegroundExecutionId: n } : {}, t)…
}, [sn, t])
```
即 `canStop===true` 时可停；若存在前台执行体则带 `expectedForegroundExecutionId` 做乐观并发控制。Escape 键在 `canStop` 时映射为 stop（@2322907，R4:4033-4039）。

### 2.3 lastError

`lastError` schema `ul`（【proto】@109240 区域）：`{code, message, recoverable, at, source: provider|runtime|tool|network, traceId?, detail?, attribution?}`。渲染端投影：错误横幅去重键 `Bnt = [session, code, at, message, traceId, detail].join(':')`（@2284640 附近），配额/供应商类业务错误（1005/1006/3006/3002/3001/3007/429 等，@488905 附近的 `Mxe` 表）由 `Nnt` 钩子转成配额横幅并可"接管"错误展示（R4:2235-2334）；订阅错误单独上报 `surface:'session_subscription_error'`，错误码用 `/^fault\.[A-Za-z0-9._-]+$/` 提取（@2242657-2242874，R4:671-698）。

### 2.4 queue 语义

queue schema `bl`（【proto】@110265）：`{items: 排队项[]（sendText|sendGoalCommand|compact，delivery.admitted ∈ startNow|queue|guide，dispatch.state ∈ queued|reserved|promoting）, autoDrain: bool, pauseReason: 'stopped'|'manual'|'error'?}`。渲染投影 `ZYe`（@【主】1691430）：

```js
// 【主】1691430（R5d:21-32）
function ZYe(e) {
    let t = [], n = [];
    for (let r of e.items) r.delivery.admitted === `guide` ? t.push(r) : n.push(r);
    return { pendingGuides: t,
             visibleQueue: n.length === e.items.length ? e : { ...e, items: n } } }
```
即 `guide` 模式的条目不进可见队列（转为引导卡片），其余进 `visibleQueue`。队列操作 sendQueuedNow/editQueueItem/reorderQueueItem/deleteQueueItem/setAutoDrain 均为 CAS 命令；`autoDrain=false` 且有积压时显示暂停横幅/恢复对话框（telemetry id `v4-queue-paused-banner` @【proto】227883 区域）。撤回编辑流程带 ACK 竞态保护（@2309000 区域 R4:3503-3571：queue item 不存在/不可编辑则跳过，冲突提示 `chat.queue.editDraftConflict`）。

### 2.5 pendingInteractions 生命周期

交互 schema `El`（【proto】@111352）：`{interactionId, kind: 'permission'|'userInput'|'workspaceHookReview', anchorRowId, createdAt, autoResolution?, payload}`，superRefine 强制 `kind === payload.kind`；`workspaceHookReview` 禁用自动倒计时且 interactionId 必须与不可变 payload 一致。

- **permission 卡**：payload `{toolCallId, toolName, summary, detail, origin?, options:[{optionId,label,kind:allowOnce|allowAlways|deny|custom,response?}]}`（@【proto】110600 区域）。
- **userInput（AskUserQuestion 引导卡）**：payload `{prompt, freeText, options?, sensitive?, questions?[{question,header,options,multiSelect}], currentQuestionIndex?, answerDrafts?}`；plan_approval 判定 `fet`（@【主】2232461 区域 R4:119-121）：`toolName==='ExitPlanMode' || schema.interaction==='plan_approval'` → 通知文案走 `notification.planApprovalRequired`；渲染时 Permission/引导卡由 `N9e` 渲染、简单输入由全屏 `Oet` 对话框渲染（R4:428-670）。首交互即暂停自动倒计时（`markInteracted`，R4:645-648），`xet` 发 `snoozeInteractionAutoResolution` 命令（@2235560 附近）。
- **workspaceHookReview**：payload 含 hooks 审查清单（event/matcher/command/trustState `pending_trust|…|stale_digest`、deadlineAt、sourceFiles），独立 store 上报横幅 `v4-workspace-hook-pending-banner`（R4:546-557）。
- **生命周期闭环**：解析命令 `resolveInteraction {interactionId, answer}`，走 `CK` 乐观账本 `record→applyAck`，`accepted|duplicate|noop` 视为成功（R4:560-587）；每个快照到达后 `reconcileOptimistic`（@【主】486745 附近）按 `pendingCommands`/queue/rows 中的 sourceCommandId 收敛乐观命令。**移动端 Plan ACK 500ms 看门狗**（@【主】2287354，R4:2534-2546）：ACK 上报后 500ms 内 pending 未消失 → `recoverFromStaleAuthority()` 强制权威恢复。OS 通知由 `bet`/`met` 按 `seenRequestIds` 去重（@2233280-2234700）。徽标统计（侧栏）用 `pendingInteractionSummary {permissionCount, userInputCount}`（sessions-index 条目，@【主】116850 的 `vu`）。

---

## 3. subagents / backgroundWorks 投影

**backgroundWorks** `Ol`（【proto】@112150）：`{workId, kind:'bash'|'subagent', title, status: running|resultPending|failed|cancelled, startedAt, endedAt?, cancellable?, blocked?, anchorRowId?, childSessionId?}`。
**subagents** `Al`（【proto】@112597）：`{revision, childSessionIds: string[], running: [{childSessionId, agentId?, toolCallId?, subagentType, title, summary?, status: running|waiting|blocked, startedAt?}], endedTotal}`。默认值 `Vnt`（@【主】2284440，R4:2375）= `{revision:0, childSessionIds:[], running:[], endedTotal:0}`。

两列表的 **join 投影** `cq`（@【主】1774156）：

```js
// 【主】1774250 附近（R5c:31-56，展开）
for (let t of e.backgroundWorks ?? [])
    if (t.status === `running`) {
        if (t.kind === `bash`) a.push(t), o.push(t);              // runningBashWorks
        else if (t.kind === `subagent` && t.childSessionId) {
            let e = s.get(t.childSessionId); s.set(t.childSessionId, e === void 0 ? t : null) } }
let c = (e.runningSubagents ?? []).map(e => {                     // subagents.running join work
        let t = s.get(e.childSessionId);
        return t ? { ...e, controlWorkId: t.workId, cancellable: t.cancellable !== !1 } : e }),
    l = new Set(c.map(e => e.childSessionId));
for (let [e, t] of s)                                             // 有 work 无 running 条目 → 合成
    !t || l.has(e) || c.push({ agentId: t.workId, childSessionId: e, controlWorkId: t.workId,
        subagentType: `subagent`, title: t.title,
        status: t.blocked ? `blocked` : `running`, … })
```
语义：`backgroundWorks` 是控制面账本（可取消、计 endedTotal），`subagents.running` 是运行时实况；按 `childSessionId` 左连接补 `controlWorkId/cancellable`；work 存在但 running 缺席 → 合成一条（`blocked` 或 `running`）。running 列表变化有专门的结构化日志 `hxe`（@【主】471490 附近）对比前后 `childSessionIds` 序列。摘要面板 counts：`runningBashWorks.length`/`runningSubagentWorks.length`（R4:4100-4102），`endedTotal` 直传"已结束子代理数"（R4:4376）。取消走 `cancelBackgroundWork {workId}`（@2322699）。store 层在每帧后对比投影（hxe）并打 `nextBackgroundWorkIds` 调试日志。

---

## 4. SessionDataLayer 生命周期

### 4.1 `q_` acquire/release 引用计数 + openKind

`q_`（@【主】488732；类头 `SessionDataLayer` 名字串在 @488960 的构造里）：

```js
// 【主】488732（R1:1567-1624，节选）
var q_ = class {
    transport; keepWarmMs;
    entries = new Map;                    // topic → {store, refCount, keepWarmTimer}
    constructor(e) {
        this.keepWarmMs = e.keepWarmMs ?? bxe()      // bxe(): 调试 1s，默认 30s（vxe=3e4 @488605）
        this.offFrame = this.transport.onFrame((e, t) =>
            this.entries.get(e.topic)?.store.handleFrame(e, t)) }
    acquire(e) {
        let t = kle(e), n = xxe(), r = this.entries.get(t), i;   // kle: `conversation/${id}` @92521
        if (r) i = r.keepWarmTimer === null ? `warm` : `keep_warm`,
            r.refCount++,
            r.keepWarmTimer !== null && (clearTimeout(r.keepWarmTimer), r.keepWarmTimer = null);
        else {
            let e = new _xe(t, this.transport);
            r = { store: e, refCount: 1, keepWarmTimer: null },
            this.entries.set(t, r), i = `cold`,
            e.connect({ rendererPrepareStartedAt: n }) }
        return { sessionId: e, store: r.store, openKind: i, startedAt: n,
                 release: () => { … this.releaseEntry(t) } } }
    releaseEntry(e) { let t = this.entries.get(e);
        t && (t.refCount--, !(t.refCount > 0 || this.disposed) &&
            (t.keepWarmTimer = setTimeout(() => { this.entries.delete(e), t.store.close() },
             this.keepWarmMs))) } }
```

`openKind` 三值：`cold`（新建 store 并 connect）、`warm`（条目存活、计时器未挂）、`keep_warm`（在 30s 宽限期内的重开）。openKind 进入打开耗时遥测 `open_kind` 维度（@2243849，R4:737），并决定是否上报 host/renderer 打开分段（`ZQ` @2245735：仅 cold 上报 openTiming/rendererTiming）。

### 4.2 双层 30s keep-warm 与注册表

- **store 层**：`vxe = 3e4`（@488605）——`q_.entries` 的关闭宽限。
- **conversation-transport 注册表层**：`J_ = new Map`（@493861），键 `Exe() = "${remoteSessionId??'__base__'} ${workspaceIdentity||workspacePath}"`（@493905 附近），`Txe = 3e4`（R1:1744）——`kxe`（@494286）acquire 时 refCount++/清计时器；release（`Oxe` @493999 附近）减到 0 且非 stale 则 30s 后 `layer.dispose()`；agentService 换代且是本地条目 → 旧条目标 `stale=true` 立即 `Dxe`（清计时器+dispose）。
- **可换代 transport 包装 `Cxe`**（@489772 之后，R1:1633-1741）：`replace(newTransport)` 时把旧 transport 上按 subscriptionId 登记的订阅逐一 `unsubscribe`，并向监听者广播 `runtimeRestart('transportReplaced')`；`subscribe` 期间发生换代 → 取消订阅并抛 `fault.subscription.transportReplaced`。

### 4.3 store `_xe` connect 与订阅 ack

`_xe`（@【主】471692）初始状态 `dxe`（@470111）：`{status:'connecting', snapshot:null, subscriptionId:null, lastError:null, rendererTiming, optimisticCommands:[], loadingOlder:false, sessionPlans:[], planDirectoryRevision:0, plansLoading:false, turnNavigatorDirectoryRevision:0}`。`connect()`（@473053）：

```js
// 【主】473150 附近（R1:996-1025，节选）
let t = ++this.generation;                       // 代际号，一切竞态以 generation 判定
let n = e.forceSnapshot ? null : this.state.snapshot;
let e = await this.transport.subscribe({ topic: this.topic,
        base: n ? { logEpoch: n.logEpoch, seq: n.seq } : void 0 });   // 带 base → 请求 resume
if (t !== this.generation || this.closed) { this.transport.unsubscribe(e.ack.subscriptionId); return }
this.setState({ status: `live`, subscriptionId: e.ack.subscriptionId, lastError: null,
                openTiming: e.ack.openTiming }),
this.subscriptionHasAppliedBase = !!(n && e.ack.mode === `resume` && e.ack.logEpoch === n.logEpoch),
this.awaitingInitial = { subscriptionId: e.ack.subscriptionId, mode: e.ack.mode },
this.transport.activate(e.ack.subscriptionId)    // 激活后冲刷初始帧暂存
```
ack 的 `mode:'resume'` 且 logEpoch 一致 → 服务端从 base 增量续传；否则回落 `snapshot`。订阅失败特判：`fault.subscription.initialFrameStagingOverflow` → 立即 `connect({forceSnapshot:true})` 重试一次（@474102）；runtime 换代打断 → 退避表 `oxe=[250,1000,3000]`（@469471）重连，耗尽 → `status:'error'`（文案 `ZCode agent runtime 已被回收，重连未成功` @469530 附近）。

### 4.4 恢复状态机与 stale authority

`handleFrame`（@475780）只认当前 subscriptionId；`deliveryKind ∈ initial/online/recovery`。核心规则：**recovery 进行中收到 online snapshot → 直接采纳为最新权威**；recovery 中 online deltas 仅推进 `postRecoveryGapPending`；**未应用基线就收到 deltas → requestRecovery**。

`requestRecovery(forced)`（@479042）→ 状态机对象 `{requestInFlight, ackReceived, validFrameSeen, upgradePending, ackMode, forceSnapshot, postRecoveryGapPending, frameDeadline}`；`issueRecovery`（@479670）调 `transport.resync({subscriptionId, base:{logEpoch,seq}|null, forceSnapshot?})`：

```js
// 【主】480100 附近（R1:1226-1243，节选）
.then(t => { if (t.ack.subscriptionId !== e.subscriptionId)
                 throw Error(`fault.subscription.resyncGenerationMismatch`);
             e.requestInFlight = !1, e.ackReceived = !0, e.ackMode = t.ack.mode, this.settleRecovery(e) })
.catch(t => { … if (n.includes(`fault.subscription.notOwned`)) { this.connect(); return }
             this.setState({ status: `error`, lastError: n }) })
```
`settleRecovery`（@480718）：ack 到且见有效帧 → 结束（若 `postRecoveryGapPending` 再补一轮）；未见帧 → 30s（`logicalFrameAssemblyTimeoutMs`）_deadline_，超时后 resume 恢复升级为 `forceSnapshot`，forceSnapshot 恢复超时 → **fail-closed** `fault.subscription.recoveryFrameTimedOut`。`recoverFromStaleAuthority()`（@475672）= `requestRecovery()`，被手机 ACK 看门狗、`expectAcceptedInputProjection`（sendText 命令 2s 内未投影进 rows/queue → 同订阅恢复，@486281）等调用。**帧断档**（`fromSeq !== snapshot.seq`）→ 已有 base 则同订阅 recovery，否则 `connect({forceSnapshot:true})`（@476760 附近，日志 `帧断档 fromSeq=… 重订阅`）。

### 4.5 runtime 重启检测

- transport 层 `V_`（@464832）内部维护代际 `m/h`：`onAgentRuntimeRestarted(workspaceKey 匹配)` → 代际+1、清初始帧暂存/装配器/订阅表、广播 `runtimeRestart`；`onRuntimeLifecycle`（available/unavailable）转发。store 层 `handleRuntimeRestart`（@481685）：generation++、弃恢复、`transportReplaced` → `connect()`，否则（runtimeRestart/runtimeAvailable）→ `connect({forceSnapshot:true})`；`handleRuntimeUnavailable`（@475147）→ 清一切、退避重连，失败置 error。

### 4.6 `subscribeSessionsIndexV4`（sessions-index 侧车）

- 传输包装 `Mje`（@832948）：与 conversation 同构，但 RPC 换为 `subscribeSessionsIndexV4 / resyncSessionsIndexV4 / unsubscribeSessionsIndexV4`，且全部带 **`runtimePolicy:'existing-only'`**（不随订阅拉起 runtime）；绑定失败**回滚**：`unsubscribeSessionsIndexV4` 撤销已建订阅（日志 `failed to undo rejected subscription`，@833936 附近）；换代竞态 → `fault.subscription.runtimeRestarted`。op 集为 `session.upserted / session.removed`，快照 `{protocolVersion:1, workspaceId, logEpoch, sessions[]}`（@79380）。
- store `zje`（@838560 附近，R3:550-843）：`applyFrame/Rje` 归约（snapshot 整替 / deltas 按 seq CAS，断档返回 gap→recovery 或 forceSnapshot 重订阅）；**瞬时错误重试** `Lje`（EBUSY/EMFILE/ENFILE/config.json.lock）按 `Ije=[250,1000,3000]`；**fail-closed** `failAndScheduleRecovery`（@840400 附近）：清空 state、退订旧订阅、按 `ek=[5000,15000,60000]` 封顶重试且 `forceSnapshot:true`；**runtime 重启 burst 退避** `handleRuntimeRestart`（R3:797-808）：30s 窗口内连续重启按 `100ms*2^n` 指数退避（上限 5s），重启/不可用→`dormant`。注册表 `rk`（键 `endpointKey\0workspaceKey`，可含 service-generation）refcount 管理，远端服务换代走 `replaceTransport(forceSnapshot)`（R3:857-897）。

---

## 5. 内存与缓存

**每会话保留（`_xe` store，活着的条目）**：
- `state.snapshot`（含**整个 rows.window**——初始 ≤60 行，`loadOlder/loadAllOlder` 前插**无上限**，仅受 `loadAllOlder` 的"≥2 realUser query 才水合"护栏约束）；`sessionPlans`（plans RPC 结果，`row.removed` 时同步过滤 @477000 附近）；`optimisticCommands` + `acceptedInputProjectionTimers`（sendText 2s 投影看门狗）；`recovery` 状态机与 `runtimeRecycleRetryTimer`；打开计时对象。
- `QQ`（@2248249）绑定：`useSyncExternalStore(subscribe, getState, () => ttt)`——无 store 时返回**共享单例终态** `ttt`（@2248046：`{status:'closed', snapshot:null, …}`），避免每渲染新对象。

**服务端配额（limits 表 `Hs`，@【proto】87272）**——决定了 renderer 收到什么规模的数据：`eventRetentionPerSession: 2000`（事件留存）、`snapshotTailWindowRows: 60`、`rowsRangeMaxLimit: 200`、`subscriberBufferMaxOps: 500` / `MaxBytes: 1MB`（慢消费者缓冲，溢出即断档走恢复）、初始帧暂存 `1024 帧 / 32MB`（`Zbe` @459493，溢出抛 `initialFrameStagingOverflow` 强制 forceSnapshot）、`toolOutputFinalHead/TailBytes: 32KB`、`goalVerificationsRetained: 20`、`pendingCommandsDisplayMax: 32`、`commandPendingTtlMs: 24h`、`idempotencyTablePerSession: 512`。

**Eviction**：
- `q_.entries`：refCount→0 后 30s（`vxe`）删除条目并 `store.close()`（退订 + 清全部定时器/监听）。
- conversation-transport 注册表 `J_`：refCount→0 后 30s（`Txe`）dispose；本地服务换代立即 stale-dispose。
- sessions-index store 注册表 `rk`：refCount→0 **立即** close（无宽限，@846000 附近 R3:893-897）。
- 缓存性记忆：`turnNavigatorHydrationTerminal`（loadAllOlder 终态，按 logEpoch+directoryRevision 失效）、`zje.cachedList`（排序后的会话列表，任何帧变更置 null 重建）、staging/assembly 缓冲（activate 时冲刷/丢弃）。

**风险/注意点**：window 无上限前插意味着超长会话反复"加载全部"会推高每 store 内存（无客户端裁剪）；`q_` 条目键仅含 sessionId（topic），同 workspace 不同 transport 的同 id 会话依赖上层注册表保证一致；30s keep-warm 期间 store 仍接收并处理帧（`handleFrame` 只按 subscriptionId 过滤），是 keep_warm 重开"秒开"的来源，也是后台流量成本的来源。

**分析产物**（beautified + 偏移映射）：`D:\tmp\zc-analysis\out\sidepane-q7\`（R1-q-class、R3-subscribe-v4、R4-store-proj、R2b-frame-schema、P2-P6/R5a-R5e 等 `.beau.js`/`.offmap.txt`/`.raw.js`）。