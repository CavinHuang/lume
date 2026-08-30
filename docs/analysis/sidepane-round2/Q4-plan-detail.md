# ZCode 桌面端 SidePane `plan-detail` 面板逆向报告

产物目录:`D:\tmp\zc-analysis\out\sidepane-q4\`(A~J 共 10 组切片，每组含 `.raw.js` 原始切片与 `.b.js` js-beautify 格式化版；偏移量均指 `D:\software\zcode\resources\app\out\renderer\assets\styles-C2WGZ-SY.js`(4,584,754 字节)内的字节偏移，特殊注明除外)。

---

## 1. 面板显示什么：ExitPlanMode 工具调用的 plan markdown

**数据源是 ExitPlanMode 工具调用**。渲染器按 toolName/family 分类(`catalogTree-D7q4FnnV.js` @374419 的 `mg`:把 `exit_plan_mode`/`exitplanmode`/`exited_plan_mode`/`switch_mode` 归入 family `switch-mode`;styles 主 chunk 的渲染分发 `case `switch-mode``:`return S4e` @2037705),聊天流中该工具调用渲染为“计划卡片” `S4e`。而 `EnterPlanMode` 的 toolCall 行被 `V5e` 过滤出时间线(@2165492)。

### 1.1 tab payload(`Que` @198460,见 `A-tabpayload.b.js:27-47`)

```js
function Que(e) {
  return {
    id: [`plan-detail`, cd(e.workspaceKey), cd(e.parentSessionId), cd(e.toolCallId)].join(`:`),
    type: `plan-detail`,
    openedAt: Date.now(),
    workspaceKey: e.workspaceKey,
    workspacePath: e.workspacePath,
    ...e.workspaceIdentity ? { workspaceIdentity: e.workspaceIdentity } : {},
    ...e.remoteSessionId ? { remoteSessionId: e.remoteSessionId } : {},
    parentSessionId: e.parentSessionId,
    toolCallId: e.toolCallId,
    markdown: e.markdown,
    ...e.planFilePath ? { planFilePath: e.planFilePath } : {}
  }
}
```

payload 里同时带 `markdown`(打开时刻的快照)与 `toolCallId`(用于回父会话快照实时解析)——这是双通道设计的关键。

### 1.2 markdown 提取链(`oq`/`sq` @1772180/1772393,见 `D-sq.b.js`)

```js
function oq(e, t) {           // 归一化 {plan|text|content, planFilePath}
  if (typeof e == `string` && e.trim().length > 0) return { markdown: e.trim() };
  if (!iq(e)) return {};
  let n = aq(e, [`plan`, `text`, `content`]),
      r = jZe(aq(e, [`planFilePath`]), t);
  return n ? { markdown: n, planFilePath: r } : {}
}
function sq(e, t) {           // toolCall → {markdown, planFilePath}
  let n = oq(e.input, t); if (n.markdown) return n;      // ① 结构化 input
  if (e.inputText?.trim()) try {                          // ② inputText JSON.parse
    let n = oq(JSON.parse(e.inputText), t); if (n.markdown) return n
  } catch {}
  let r = oq(e.output, t); if (r.markdown) return r;      // ③ output
  if (!iq(e.raw)) return {};
  for (let n of [e.raw.rawInput, e.raw.rawOutput]) { ... } // ④ rawInput/rawOutput
  let i = Array.isArray(e.raw.content) ? e.raw.content : [];
  for (let e of i) { ... }                                 // ⑤ content 块数组
  return {}
}
```

即优先取 `input.plan`,逐级回退到 inputText、output、rawInput/rawOutput、raw.content。

### 1.3 Wkt 如何从父会话快照解析(`Wkt` @3794453,见 `B-wkt.b.js:750-787`)

```js
Wkt = (0, Q.memo)(function({ tab: e, onOpenBrowserUrl: t, onOpenCodeViewer: n, onOpenFileLink: r }) {
  let { layer: i } = Hv(),                       // useV4Conversation 上下文 @564975
    [a, o] = (0, Q.useState)(null),
    [s, c] = (0, Q.useState)(e.markdown),        // 本地态:以 payload 快照为种子
    l = Ee(e => e.theme, `system`), u = Ee(e => e.codePreviewSettings, Qt);
  (0, Q.useEffect)(() => {
    let t = i.acquire(e.parentSessionId);        // ★ 挂到“父会话”数据层
    return o(t), () => t.release()
  }, [i, e.parentSessionId]);
  let d = QQ(a),                                 // useSyncExternalStore 订阅层 store @2248185
    f = (0, Q.useMemo)(() => {
      let t = d.snapshot?.rows.window
        .find(t => t.kind === `toolCall` && t.toolCallId === e.toolCallId);
      if (!(!t || t.kind !== `toolCall`))
        return sq(iQ(t).toolCall, e.workspacePath).markdown
    }, [d.snapshot, e.toolCallId, e.workspacePath]);
  (0, Q.useEffect)(() => { f && c(f) }, [f]),
  (0, Q.useEffect)(() => { e.markdown && c(e.markdown) }, [e.markdown]);
  let p = f ?? s;                                // 实时快照优先,失败回退 payload 快照
  return (0, $.jsx)(`div`, { "data-plan-detail-tool-call-id": e.toolCallId, ... 
    children: (0, $.jsx)(Un, { ...markdown 渲染组件, children: p }) })
})
```

- 查找方式：在**父会话**快照的 `snapshot.rows.window` 中按 `kind === 'toolCall' && toolCallId === tab.toolCallId` 找行，经 `iQ`(@2061448)规范化为 toolCall 后交给 `sq` 提取 markdown。
- **实时更新：是**。`QQ` 用 `useSyncExternalStore` 订阅父会话 layer 的 store;快照每次变化 `f` 重算。流式期间 `W3e`(@2060887)对未完成的 `inputText` 做容错解析：

```js
// H3e @2060660: inputStreaming/pendingApproval/running→pending|in_progress, success→completed...
function W3e(e) {
  if (e.input !== void 0) return { input: e.input, inputPreviewComplete: !0, ... };
  if (!e.inputText) return { input: void 0 };
  let t = dae(e.inputText);   // = src chunk 的 mE,容错部分 JSON
  return { input: U3e(t.input) ? void 0 : t.input, inputPreviewComplete: t.complete, ... }
}
```

`dae` 即 `src-C3so_Fno.js` 导出 `p` = 内部 `mE`(@~246321):JSON.parse 失败时走 `gE` 正则抽取关键字段，其白名单 `pE` **显式包含 `plan`**(`[...,'replacement','plan']`),因此 ExitPlanMode 的 `plan` 字段在输入流式传输过程中即可被渐进还原，面板能跟着流式刷新。快照中找不到行(会话已关、窗口裁剪)时回退 `s`(打开时刻 payload 快照)。

## 2. `planFilePath` 语义

- **来源**:`sq` 从 ExitPlanMode 工具调用的 `input.planFilePath`(或 output/raw 变体)动态读取键 `planFilePath`(`oq` 中 `aq(e,['planFilePath'])`),相对路径经 `jZe`→`vt(workspacePath, path)` 解析为绝对路径。**renderer 侧没有任何类型化 schema 定义它**——`planFilePath` 只出现在 styles 主 chunk(全 assets 目录 grep 确认)，说明该字段是 sidecar 端在工具调用输入/输出中携带的元数据：计划除随工具调用传输外，还由 agent 后端落盘为文件。
- **用途(仅展示/透传，不读文件)**：
  - 计划卡片 `S4e` 头部以 `<code>` 显示 basename(`FZe`=`je` 取基名，title 悬浮显示完整路径)；
  - status 面板“计划”列表与 tab payload 原样透传；
  - **Wkt 面板本身完全不使用 `planFilePath`,也不读取该文件**——内容始终来自工具调用数据，不是文件 watch。
- **与 plan 审批流的关系**：SDK schema(src chunk @~116542)中提问类交互带 `renderContext: {kind:'plan_approval', plan:<markdown>}`——完整计划文本随审批请求传输，审批动作不依赖文件；文件路径只是“这份计划已存到哪”的展示信息。

## 3. 生命周期

**打开 = 纯手动**，两个入口，无自动打开(全量搜索只有 pptx 有 `handleAutoOpenAssistantPptx`,plan 无对应物)：

1. **聊天计划卡片** `S4e`(@2023545,见 `H-planCard.b.js`):卡片整体 `role=button`(aria-label `planTool.panel.open` = “在侧边栏查看计划”)，底部悬浮按钮 `planTool.panel.viewFull` = “查看完整计划”，二者均触发:

```js
d = () => { !i || !e.onOpenPlanDetail ||
  e.onOpenPlanDetail({ toolCallId: n.toolId, markdown: i, ...a ? { planFilePath: a } : {} }) },
f = e => { fZ(e.target, e.currentTarget) || d() },   // 忽略卡片内按钮/链接点击
```

2. **status 面板“计划”列表** `tQe`(@1787688):由 `RZe`(@1773716)收集本会话**已完成**(success/error/cancelled)的 ExitPlanMode 调用、按 rowId 倒序；每项 button(`data-plan-directory-tool-call-id`,aria `chat.statusPanel.openPlan` = “打开计划：{title}”)点击经 `nQe`(@1788784)组装 `{parentSessionId, toolCallId, markdown, planFilePath?}`。

回调链:`onOpenPlanDetail` 附加 workspace 上下文(`pn` @2295684)→ 会话流入口补充 `parentSessionId`(@2133443)→ App 的 `handleOpenPlanDetail: de`(@222735):

```js
de = (0, Q.useCallback)(e => {
  let t = e.workspaceIdentity?.trim() || e.workspacePath;
  b(!1),                                       // 展开侧栏
  P(n => wde(n, { ...e, workspaceKey: t })),   // upsert reducer
  J.debug(`[App] 打开计划详情右侧 tab`, {...})
}, [P])
```

**幂等**:`wde`(@206917,见 `A-tabpayload.b.js:443-450`)按完整 id(`plan-detail:ws:parent:toolCallId`)查找，存在则 `{...r, ...n}` 合并更新(markdown/planFilePath/openedAt),否则追加;`fd`(@199877)两种情况都把该 tab 设为 active。

**关闭**：普通 tab 关闭(`handleCloseSidePaneTab`)/关闭其他/关闭全部(`xd`、`Dde` 把 plan-detail 与 selection-side-chat、subagent 等同样按会话归属归组)；切换活动任务时 tab 列表按 `hd` 过滤(`plan-detail` 匹配 `parentSessionId === ownerTaskId`,@~198375),不属于当前任务时仅隐藏。

**父会话结束**(@223403,见 `C-wde.b.js` 后段；事件总线 `aue/Tu` @118591,事件类型仅 `archived`/`deleted`,@129661/@130004):

```js
return aue(t => {
  if (t.workspaceKey !== e) return;
  Xd(t.taskId, t.workspaceKey);
  let n = M.current.sidePaneState?.tabs.filter(e =>
    e.type === `selection-side-chat` && e.parentSessionId === t.taskId) ?? [];
  if (n.length === 0) return;
  for (let e of n) fe(e);                       // 关闭框选副屏 runtime 会话
  let r = new Set(n.map(e => e.id));
  N(e => { ...for (let e of r) t = Cd(t, e, i); return I(t), t }),
  J.info(`[App] 父任务结束，清理框选副屏会话`, { event: t.type, ... })
})
```

过滤器**只匹配 `selection-side-chat`——plan-detail 不被关闭**。父任务归档/删除后，plan-detail tab 仍留在 store 中(切回该任务仍可见；任务不存在时因 `hd` 过滤不再显示)，内容回退到 payload 快照 markdown,优雅降级。

## 4. 交互

- **面板只读**。Gkt(@3795505)→ Wkt 的 props 仅有 `onOpenBrowserUrl/onOpenCodeViewer/onOpenFileLink`(markdown 内链接/代码跳转)，无任何 approve/reject 回调。tab 标题 `L8`(@3778426)= i18n `planTool.panel.planTab`(“计划”)，图标 `Ec`(`P8` @3775982)。挂载点：tab 内容 switch 中 `i.type === 'plan-detail' ? jsx(Gkt, {tab: i, ...})`(@3813867,见 `I-tabmount.b.js:58-62`),外层 `Uv` 按 workspacePath/workspaceIdentity/remoteSessionId 建作用域。
- **markdown 管线**:`Un` = `catalogTree` 导出 `h` = 内部 `xR`(@644483)——memo 化的统一 markdown 渲染组件(remark/rehype 插件数组 + 可选文件引用插件)，支持流式、主题、codePreviewSettings,点击代码块/文件链接经回调打开 code-viewer/文件链接，外链走 `onOpenExternalUrl`。
- **审批/拒绝不在面板**：审批是 ExitPlanMode 进入 `pendingApproval` 状态后产生的独立 elicitation 交互(`E9e` @2208002:`schema.interaction === 'plan_approval' && schema.toolName === 'ExitPlanMode'`;`fet` @2232382 用于识别并触发 OS 通知 `notification.planApprovalRequired`,`pet` @2232511 起)，计划全文随 `renderContext.plan` 传输，用户在**会话内**的计划审批 UI(问题选项，`C9e` 的 `isPlanApproval` 键盘处理)上批准/拒绝。辅助 i18n(`IntlProvider-CyTmJHD8.js`):`planTool.panel.copy`=“复制计划”、`viewFull`=“查看完整计划”、`open`=“在侧边栏查看计划”等(`syncing/expand/collapse/currentMode/modeActions` 等键在本 build 中仅存在于语言包，无代码引用，属遗留)。

**关键文件**:`D:\tmp\zc-analysis\out\sidepane-q4\A-tabpayload.b.js`(store reducer)、`B-wkt.b.js`(Wkt/Gkt)、`C-wde.b.js`(handleOpenPlanDetail+父会话结束)、`D-sq.b.js`(sq/oq/RZe)、`E-iQ.b.js`(iQ/W3e)、`H-planCard.b.js`(S4e 卡片)、`I-tabmount.b.js`(挂载)、`J-approval.b.js`(审批通知)；跨 chunk 证据:`...\assets\catalogTree-D7q4FnnV.js`(@374419 family 分类、@644483 markdown 组件)、`...\assets\src-C3so_Fno.js`(@246321 部分解析器 `pE` 含 `plan`、@~116542 `renderContext.kind='plan_approval'`)、`...\assets\IntlProvider-CyTmJHD8.js`(`planTool.panel.*` 文案)。

**残余不确定**:`dae`/`mE` 对流式中**跨块转义**的 `plan` 长字符串的边界行为(截断的 `\uXXXX` 已处理，见 `yE`)未逐字节验证；status 面板列表 `RZe` 只收已完成调用，故面板从“计划卡片”打开可覆盖流式中状态，从“计划列表”打开必然是终态调用。