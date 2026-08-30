# ZCode SidePane 三个未探索面板逆向报告

**目标**：`D:\software\zcode\resources\app\out\renderer\assets\styles-C2WGZ-SY.js`(4,584,754 bytes,minified)
**辅助 chunk**:`skillStore-C5tahaKT.js`(43,819 bytes,共享 store/工具)
**产物**：20 个 beautified 切片已存 `D:\tmp\zc-analysis\out\sidepane-q2\`(01~20)

**符号对照**(已验证的声明位置)：

| 符号 | 实体 | 字节偏移 |
|---|---|---|
| `$ue` / `Wue` / `que` | 白板 / 轨迹 / 开发者工具的 **tab 工厂**(注意：tab 工厂不是 `WDt`) | 198932 / 196428 / 196800 |
| `WDt` / `ekt` / `lkt` | 三个面板的**渲染组件** | 3718472 / 3756064 / 3763135 |
| `Qde` / `Ide` / `Nd` | SidePane 控制器 hook / 轨迹 bus 订阅 hook / zustand 请求 bus | 214029 / 210546 / 210197 |
| `zo`(=skillStore `On`) | **白板 store**(zustand,内存态) | skillStore ~33350 |
| `nm` | zcodeTaskService 工厂(`getModelTrajectory` 的载体) | 298898 |
| SidePane 分发 switch | `i.type===\`whiteboard\`?(0,$.jsx)(WDt,...)` | 3814682 |

---

## 1. Whiteboard(`WDt` @ 3718472)— 手绘白板画布

**本质：pointer 事件驱动的 `<canvas>` 涂鸦板**，不是 markdown 板也不是任务可视化(tab 搜索关键词佐证：`'${e.title} whiteboard canvas draw sketch'` @ 3780010)。

**boardId 语义**:board 由白板 store 创建，`id = 'whiteboard:'+nanoid`,tab id 同形；按 workspace key(`workspaceIdentity.trim() || workspacePath`)隔离在 `workspaces[key].boardIds / boardsById` 里。Board 形状(skillStore `gn` @ ~31740,切片 16 第 35-47 行)：

```js
// skillStore-C5tahaKT.js @~31740
function gn(e) {
  let t = Date.now();
  return {
    id: `whiteboard:${l()}`,
    name: _n(e.existingNames, e.defaultNamePrefix),
    width: 1280, height: 800,      // dn=1280, fn=800 固定逻辑尺寸
    strokes: [], undoneStrokes: [],
    createdAt: t, updatedAt: t
  }
}
```
默认名 = `${i18n 'whiteboard.defaultName'} N` 自动去重递增(Qde 传入 `defaultWhiteboardNamePrefix` @ 3884896)。Stroke = `{id:'stroke:<nanoid>', tool:'pen'|'eraser', color, width, points:[{x,y}]}`(`vn` @ skillStore ~31990)。

**数据源/持久化:`On` 是纯内存 zustand store,无 persist 中间件、无 IPC、无磁盘副本**(全资产目录 grep `boardsById` 仅 skillStore/styles 两处)。窗口重开即丢失；E2E 钩子 `window.__whiteboardStoreE2E` 仅测试用。Action:`createBoard/renameBoard/addStroke/undoStroke/redoStroke/clearBoard/getBoard`(undo=strokes 弹栈进 undoneStrokes)。

**交互**(WDt 主体，切片 02 第 141-422 行)：

```js
// styles @3718472
function WDt({workspacePath:e, workspaceIdentity:t, boardId:n}) {
  ...
  a = zo(e => e.workspaces[i]?.boardsById[n]),
  o = zo(e => e.renameBoard), s = zo(e => e.addStroke),
  c = zo(e => e.undoStroke),  l = zo(e => e.redoStroke),
  u = zo(e => e.clearBoard),
  [m, h] = useState(`pen`),           // 工具
  [g, _] = useState(Yoe),             // 颜色, 默认 #111827
  [v, y] = useState(5),               // 笔宽 (range 2..18)
```
- 6 色盘 `UDt=['#111827','#2563eb','#16a34a','#dc2626','#ca8a04','#7c3aed']`(@3718460);橡皮粗细 `max(14, width*3)`;setPointerCapture 实时拖绘，`onPointerUp` 才 `addStroke` 提交(draft stroke 仅本地预渲)。
- 画布固定 **16:10 比例**、白底，devicePixelRatio 缩放；**橡皮擦是“画白色线”而非真擦除**(`bn` @ skillStore ~32100:`globalCompositeOperation='source-over'; strokeStyle = tool==='eraser' ? backgroundColor : color`)。
- 顶部工具条：行内重命名输入框、“加入聊天”、pen/eraser、色盘(sm+ 显示)、宽度滑条(md+)、撤销/重做/清空。
- **加入聊天 = 导出 PNG 附件**:`wn` @ skillStore ~33360 派发可取消 CustomEvent `zcode:add-whiteboard-to-chat`,composer 监听(styles @912376,切片 04 第 35-43 行)`tse(e)&&Ro(e.detail)===Ro({workspacePath...})` 后 `getBoard→ase(board)`(即 `Sn`:离屏 canvas → `toDataURL('image/png')` → 清洗文件名的 `File`)→ `B([file])` 挂到输入框。同一 `se` 回调兼作导出(i18n `whiteboard.exportMissing/exportFailed`)。聊天 `@` 提及下拉也列出 boards(`$je` @ 854348:`markdown:'@'+name, description: strokes.length`,切片 03 第 32-46 行)。

**打开流程**(Qde 内 `ie` @ 220123,切片 20):`zo.getState().createBoard({defaultNamePrefix:c,...})` → tab 工厂 `$ue`:

```js
// styles @198932
function $ue(e) {
  return { id: `whiteboard:${e.boardId}`, type: `whiteboard`,
           boardId: e.boardId, openedAt: Date.now(), title: e.title }
}
```

---

## 2. Model Trajectory(`ekt` @ 3756064)— 单任务模型调用轨迹(请求级 timeline)

**内容**：不是“模型思考流”，而是**该 task 的每一次 LLM 请求/响应记录**(records)的时间线。每条 record 展示：序号、**调用来源** pill(`callSource.kind|querySource` → main / subagent / compact / sidecar / prompt_enhance / session_title / target_completion_verification / unknown,`HOt` @ ~3737030)、**finishReason** pill(stop/tool-calls/length/content-filter,`JOt`)、元数据 `IN n · OUT n · 时长 · 开始时间`(`qOt`);body 分 **INPUT 段**(system/user/assistant/tool 消息，parts: text / reasoning / tool-call(input) / tool-result(output) / image 占位 / raw)与 **OUTPUT 段**(reasoning、正文、toolCalls),错误带 name/message/stack(`IOt`)。头部摘要:`summaryCalls`(N 次调用)、`summaryTokens`(∑ totalTokens)、去重后的 modelId 列表(`TOt`)。

**数据源**：workspace 级 `zcodeTaskService.getModelTrajectory({taskId})` RPC(`qDt` hook @ 3724600,切片 02 第 429-479 行；service 工厂 `nm` @ 298898),返回 `{records, sourceFiles, truncated}`;`sourceFiles` 首个非空项供“打开轨迹源目录”(调 `openInFileManager`)。日志：``J.warn(`[useModelTrajectory] 读取模型调用轨迹失败`,...)``。

**刷新模型：纯手动**。`qDt` 仅在 `(service, taskId, identity, refreshCount)` 变化时 fetch——**无轮询、无订阅**；唯一刷新入口是 header 的 refresh 按钮(loading 时 `animate-spin`)。

**智能去重**：main/subagent 类调用会回放完整历史，`XOt/ZOt/$Ot`(@~3740310)按 `previousConversationMessageCount` 切片，第 0 次显示全量 input,其后只显示**新增的尾部消息**；非会话来源(compact、会话标题、prompt 增强等)显示全量。

**交互**：虚拟滚动(`@tanstack/virtual` estimateSize 240)、行折叠/展开(按 6 种 role `x8=['system','user','reasoning','assistant','tool-call','tool-result']` 的全局命令 + 每行 override,版本号传播 `JDt/ZDt`)、全展开/全收起、**页内搜索**(大小写/空白归一化子串，搜 content/tool-name/tool-id 三类字段；用 **CSS Custom Highlight API** `::highlight(zcode-model-trajectory-find)` 高亮 Range,匹配计数 `i/n`、prev/next、自动滚动到匹配行)、单条消息复制、打开源目录、刷新、关闭；底部 `truncatedNotice` 截断提示。

**打开链路**(与已知锚点吻合)：

```js
// styles @210197 (bus Nd)
var Md = 0,
  Nd = A(e => ({
    pendingRequest: null,
    requestOpen: t => { Md += 1, e({ pendingRequest: {...t, requestId: `model-trajectory-open:${Md}`}})},
    consumeRequest: t => { e(e => e.pendingRequest?.requestId === t ? {pendingRequest: null} : e)}
  }));
typeof window < `u` && (window.__zcodeModelTrajectoryStoreE2E = Nd);

// styles @210546 (consumer hook)
function Ide(e, t) {   // (workspaceKey, openTab)
  (0, Q.useEffect)(() => {
    let n = n => { !n || n.workspaceKey !== e || (
      t({taskId: n.taskId, title: n.title}),
      Nd.getState().consumeRequest(n.requestId)) };
    return n(Nd.getState().pendingRequest), Nd.subscribe(e => n(e.pendingRequest))
  }, [t, e])
}
```
`Ide(n?.trim()||t, se)` 实际调用在 workspace shell @ **223831**(紧邻 Qde),`se` @ 221114 = `pde(state,{taskId,title})` 开 tab(tab 工厂 `Wue` @ 196428:`id:'model-trajectory:'+taskId`,同任务复用单 tab)。生产者即两个 header 菜单的 `onViewModelTrajectory`(@2873697、@3089279):`Nd.getState().requestOpen({taskId, workspaceKey, title})`。

---

## 3. Developer Tools(`lkt` @ 3763135)— Token/缓存调试 + 模型网络日志(大半是空壳)

**开关门控**(@3797106,切片 09 第 2-13 行):

```js
// styles @3797106
var rAt = [`zcode:developer-tools:enabled`, `zcode:token-debug:enabled`],
    iAt = new Set([`0`, `false`, `off`, `no`]);
function aAt(e) { if (e === null) return !1;
  let t = e.trim().toLowerCase(); return !iAt.has(t) }
function oAt(e = sAt()) { return e ? rAt.some(t => {
  try { return aAt(e.getItem(t)) } catch { return !1 } }) : !1 }
var cAt = 1e3;
function lAt() { let [e,t] = useState(oAt);
  return useEffect(() => {  // storage 事件 + focus + 1s setInterval 轮询
    ... window.setInterval(e, cAt) ... }, []), e }
```
即 localStorage 两个键**任一**设为非 `0/false/off/no` 值即启用；hook 监听 `storage`/`focus` + **1s 轮询**。`W=lAt()`(@3801450)控制两处：SidePane "+" 快捷菜单项(`Zkt` @ 3796125:`e&&a.push(\`developer-tools\`)` 及 `W?jsx(nt,{onSelect:()=>{I()}})`)。tab 为**单例**(`que()` @ 196800 → `{id:'developer-tools', type:'developer-tools'}`,`fd` 按 id 去重)。组件接收 `taskId=activeTaskId`。

**暴露的功能**(两个 section,切片 08 第 2-287 行):

1. **Token Section**(`developerTools.tokenSection`):摘要 4 项 — 请求次数、平均命中率(百分比)、输入 token 总量、缓存读 token 总量;数据来自**真实数据**:`zoe(getWorkspaceState(workspacePath,identity), taskId).usage?.cache`,即 session store 的 `taskRuntimeByTaskId[taskId].usage.cache`,字段集 `{hitRate, hitRateRequestCount, totalInputTokens, totalCacheReadTokens, totalCacheWriteTokens, latestHitRate,...}`(比较器 `Le` @ skillStore ~8300)。
2. **逐轮 token 表**(8 列:round / input / output / total / reasoning / cacheRead / cacheWrite / hitRate)。
3. **Network Section**(`developerTools.networkSection`):模型 HTTP 请求事件流(倒序)，每条含状态(`model_request_started/completed/failed/retry_scheduled/stream_stalled` → started/completed/failed/retry/stalled,`skt` @ ~3762900)、requestId、时间戳、model、provider(providerId??providerKind)、attempt/max、HTTP 状态码、耗时(durationMs??idleMs)、重试延迟 delayMs、baseURL、错误消息，以及可折叠的**请求头/响应头**(带数量)。tab 搜索关键词 `developer tools token debug network status request response headers`(@3780010)。

**关键发现:2 和 3 是未接线的空壳。** 数据源 `rounds`/`networkEntries` 绑定到模块级数组:

```js
// styles @3761393 (ekt 之后)
var nkt = [], rkt = [];
// lkt 内 @3763232
a = Io(Pl(r => n ? { cache: zoe(r.getWorkspaceState(e, t), n).usage?.cache,
                    rounds: nkt, networkEntries: rkt } : {...}))
```
全文件 grep 确认 **`nkt`/`rkt` 无任何写入点**(仅声明+两分支各引用一次)。因此该面板实际可显示的只有 token 摘要 4 项；逐轮表格恒为 `tokenDebug.empty`,网络列表恒为 `developerTools.network.empty`。字段/事件名(`eventKey/requestIndex/attempt/baseURL/requestHeaders...`)已全部就绪，属“UI 先行、数据管道未接”的半成品。

---

### 方法备注
切片脚本 `D:\tmp\zc-analysis\q2-scan1~16.mjs`、`q2-extract*.mjs`(indexOf 锚点 → slice → js-beautify);01/03/04/05/06 号切片显示白板周边另有 treemapping 面板(`VDt/HDt`)与聊天 mention 系统，未在本任务范围内展开。