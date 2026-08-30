# ZCode 桌面端两大子系统深度分析报告

分析对象（均为 minified 产物，offset 为原始文件字节偏移）：
- **styles** = `D:\software\zcode\resources\app\out\renderer\assets\styles-C2WGZ-SY.js`（4,584,754 B，renderer）
- **host** = `D:\software\zcode\resources\app\out\host\index.js`（2,271,864 B，host 服务进程）
- **main** = `D:\software\zcode\resources\app\out\main\index.js`（1,487,145 B，Electron 主进程）

 Beautified 切片已存至 `D:\tmp\zc-analysis\out\sidepane-q9\`（q9-host-traj-build.js / q9-host-traj-rpc.js / q9-host-limitfn.js / q9-host-sessionsvc.js / q9-styles-snapshot.js / q9-styles-traj-ui.js 等）。

---

## 1. getModelTrajectory 服务端实现

### 1.1 进程归属与调用链

- **main/index.js 不参与**：无 `getModelTrajectory`、无 `model_io`、无 `model-io-` 字符串。仅在 offset 63300–63800 段残留该模块的**死导入**（`open as FFe`、`var GFe=32*1024*1024`、`var sWe=Q("model-trajectory")`），函数体已被 tree-shake 掉。
- **host/index.js 是唯一实现**，位于 `createZCodeTaskServiceAdapter`（`s(Ux,"createZCodeTaskServiceAdapter")`，offset ~450060）内：

```js
// host @457553（beautified: q9-host-traj-rpc.js L310-313）
async getModelTrajectory(y) {
  let E = await uY(y.taskId, y.limit);
  return lt.info(`[ZCodeTaskService] getModelTrajectory taskId=${y.taskId} records=${E.records.length} files=${E.sourceFiles.length} truncated=${E.truncated}`), E
}
```

- **renderer**（styles @3724776，beautified: q9-styles-traj-ui.js L253-255）经 `useModelTrajectory` hook 调用，且**只传 taskId，不传 limit**：

```js
r.getModelTrajectory({ taskId: t }).then(e => { ... })
```

因此 limit 恒为默认值 **200**（`cY=200`，host @384876）。

### 1.2 数据物理来源：模型 IO JSONL 日志（非 session store）

host @384175–386800（beautified: q9-host-traj-build.js L243-341）实现了 `readModelTrajectory`（`uY`）。记录来自**磁盘 JSONL 文件**：

```js
// host @384175 附近（beautified: q9-host-traj-build.js L243-246, L281-299）
var hIe = 32 * 1024 * 1024;                        // 单文件最多读尾部 32MB
function iY() {                                    // resolveModelIODirs
  return [...new Set([_k(gIe(), ".zcode", "cli"), _k(jr(), ".zcode", "cli")])]
    .flatMap(t => [_k(t, "debug"), _k(t, "rollout")])
}
// jr() = getDataBaseDir: env ZCODE_DATA_BASE_DIR || HOME（host @13081-13133）
var cY = 200;                                      // 默认 record 上限
async function uY(e, t = cY) {                     // readModelTrajectory(taskId, limit)
  ...
  let h = `model-io-${o || "no-session"}.jsonl`,   // o = sanitizeSessionSegment(taskId)
    w = f.includes(h) ? [h] : [];                  // 目录枚举精确匹配文件名
```

- **目录**：`[homedir()/.zcode/cli, <dataBaseDir>/.zcode/cli]` 去重后 × `{debug, rollout}`，最多 4 个目录。文件名 `model-io-<taskId净化>.jsonl`（`sanitizeSessionSegment`：非 `[a-zA-Z0-9_-]`→`-`，去首尾 `-`，截断 80 字符）。
- **文件格式**：JSON Lines，每行一个 JSON 对象，读取时仅保留 `type === "model_io" && sessionId === taskId` 的行（host @385576）。行内字段含 `startedAt/requestId/attempt/durationMs/turnId/traceId/model{...}/request{...}/response{...}/error{...}`。**写入方不在这 3 个文件里**——是 zcode CLI 运行时（agent runtime）在模型调用时落盘；host 只是消费者。
- **rotation：不存在**。每任务一个文件；读取时用 `readTrajectoryFileTail`（`aY`，`s(aY,"readTrajectoryFileTail")` @384845）只读**文件尾部 32MB**，超出则从下一个换行符起读并标记 `truncated=true`：

```js
// beautified: q9-host-traj-build.js L255-275
let { size: n } = await t.stat(), o = Math.max(0, n - hIe), ...   // o = 跳过的前段字节数
if (o > 0) { let d = c.indexOf(`\n`); c = d === -1 ? "" : c.slice(d + 1) }
return { text: c, bytesRead: a, truncated: o > 0 }
```

- **record 构造**（`mapRecord`=`kIe`，`s(kIe,"mapRecord")` @386901；`classifyCallSource`=`PIe` @387377）：逐字段 `asString/asNumber` 类型清洗后输出 `{requestId, attempt, startedAt, completedAt, durationMs, turnId, traceId, callSource, model{modelId,providerId,role,source,variant}, request{messages,toolNames}, response{finishReason,text,reasoningText,toolCalls,usage,responseId,modelId}, error{name,message,stack}}`。`classifyCallSource` 依据 `querySource`（`main_turn/subagent/compact/...`）或首条 system 消息是否为 "Generate a concise title..."（推断 `session_title`）分类为 `main/subagent/compact/sidecar` 四种 kind。
- **delta 展开**：`expandModelIODeltaRecords`（`SIe`）把 `messagesKind:"delta"` 的请求用上一条 record 的 messages 前缀（按 `messageOffset` 拼接）还原成完整请求，覆盖 `messages/sdkMessages/body.messages` 三组集合。
- **排序与截断**（beautified L326-339）：按 `Date.parse(startedAt)` 再按 `requestId` 字典序排序，`truncated = 文件超32MB || 记录数 > limit`，超限时 `slice(-limit)` **保留最新的 200 条**。返回 `{taskId, available:true, records, sourceFiles, truncated}`。
- **sourceFiles 的含义**：**是原始 JSONL 日志的绝对路径列表**（每个贡献过记录的文件 `join(dir, filename)`，beautified L323 `i.push(k)`）。renderer 侧 `tkt(sourceFiles)`（styles @3761317）取第一个非空路径派生其所在目录，通过桌面 API `openInFileManager` 提供"打开调用轨迹目录"按钮（styles traj-ui L1745-1767）。
- **脱敏**：读取/映射路径上**没有任何脱敏逻辑**——messages、toolCalls 的 input/output 原样透传。host 中存在的 redact 工具（`redactHeaderValue` @1599634、`redactHelperDownloadUrl` @905080、agent stderr tail 的 `<redacted>` 正则 @275197）均属遥测/日志路径，与轨迹无关。即密钥是否脱敏取决于 CLI 运行时写 JSONL 时是否已处理，**这 3 个文件不做二次防护**。

### 1.3 Renderer UI 映射（styles 3720000-3770000）

- 每条 record 渲染为 `<article data-trajectory-call>`：序号 + callSource 标签（`HOt` 按 `querySource` → `modelTrajectory.source.main/sessionTitle/compact/promptEnhance/targetCompletionVerification/subagent` i18n）+ finishReason 药丸（`modelTrajectory.finish.stop/toolCalls/length/contentFilter`，L1545-1558）+ usage token 统计；input messages 与 response（text/reasoning/tool-call/tool-result）分区可折叠、可全文搜索（`oOt` + `useDeferredValue`）。
- `callSource.kind` 为 `main/subagent/undefined` 的记录通过 `QOt`（L1684-1687）过滤展示（sidecar/compact 类调用默认不在主时间线）。

---

## 2. 任务快照缓存（`zcode-task-snapshot-cache:v1`）

全部在 **styles（renderer）**，offset 296423–298900（beautified: q9-styles-snapshot.js L425-577）。缓存的是 **`getTaskSnapshot` 返回的历史会话快照**（供恢复/侧栏展示），按 **ETag 协商** 三层缓存：

```js
// styles @296423-296890（beautified: q9-styles-snapshot.js L425-437）
var Kp = new WeakMap,    // service对象 -> Proxy包装后的service（防重复包装）
  qp = new WeakMap,      // service对象 -> Map<cacheKey, Promise>（在途请求合并）
  Jp = new WeakMap,      // service对象 -> Map<cacheKey, {etag,snapshot}>（内存ETag层）
  Yp = `zcode-task-snapshot-cache:v1`,  // localStorage key
  xme = 256 * 1024,      // 单条目上限 256KB
  Sme = 2 * 1024 * 1024, // 持久化总量上限 2MB
  Cme = 20,              // 最大条目数 20
  Xp = !1,               // localStorage 已加载标记（懒加载一次）
  Zp = new Map;          // 持久层：key -> {key, etag, snapshot, updatedAt, sizeBytes}

function wme(e) {        // cache key（styles @296555）
  return [e.workspacePath, e.workspaceIdentity ?? ``, e.taskId,
    typeof e.messageLimit == `number` ? String(e.messageLimit) : ``,
    typeof e.byteBudget == `number` ? String(e.byteBudget) : ``,
    typeof e.toolLimit == `number` ? String(e.toolLimit) : ``,
    e.clientMode ?? `desktop-continuous`, e.resumeModelPolicy ?? `task-index`,
    e.model ?? ``, e.thoughtLevel ?? ``].join(`::`)
}
```

### 2.1 WeakMap-by-object 模式

`qp`/`Jp` 以**服务对象本身**为 WeakMap key（`Tme`/`Eme`，L439-453），把“在途 Promise 表”和“内存 ETag 表”挂在 service 实例上：service 被桥接层重建时旧表自动 GC，不同 workspace 的 service 实例互不串扰；`Kp` 则保证 `nm()`（L570-577，从 `gp(workspacePath, remoteSessionId, workspaceIdentity).services` 取 `zcodeTaskService`）对同一 service 只包一层 Proxy。

### 2.2 限额执行与淘汰

```js
// beautified: q9-styles-snapshot.js L484-517（styles @297632 / @297919）
function Dme() {                       // 淘汰：按 updatedAt 降序保留
  let e = [...Zp.values()].sort((e, t) => t.updatedAt - e.updatedAt), t = [], n = 0;
  for (let r of e) t.length >= Cme || n + r.sizeBytes > Sme || (t.push(r), n += r.sizeBytes);
  Zp.clear(); for (let e of t) Zp.set(e.key, e)
}
function tm(e, t, n) {                 // 写入
  $p(); let r = JSON.stringify(n), i = new TextEncoder().encode(r).byteLength;
  if (i > xme) { Zp.delete(e), em(); return }   // >256KB 直接拒绝（负缓存：删旧条目）
  Zp.set(e, { key: e, etag: t, snapshot: n, updatedAt: Date.now(), sizeBytes: i }), Dme(), em()
}
```

即：**≤20 条且总量 ≤2MB** 两条约束同时生效（不是 256KB×N）；单条 >256KB（UTF-8 字节数，`JSON.stringify`+TextEncoder 实测）不缓存。`em()` 每次变更把整表单 key 写回 localStorage（try/catch 吞掉配额异常）。

### 2.3 Proxy 拦截与 ETag 协商（`Ame`，styles @298162）

```js
// beautified: q9-styles-snapshot.js L526-563（styles @298381）
let s = (async () => {
  let t = await e.getTaskSnapshotWithEtag({ ...r, ...o?.etag ? { ifNoneMatch: o.etag } : {} });
  if (t.notModified) {
    if (o?.snapshot) return o.snapshot;               // 命中：直接用缓存快照
    let t = await e.getTaskSnapshotWithEtag(r);       // 无缓存的 notModified：全量重取
    ...
  }
  if (t.snapshot && t.etag) { n.set(i, e), tm(i, t.etag, t.snapshot) }  // 回填内存+持久层
  else t.snapshot || (n.delete(i), kme(i));          // 空快照：三层全清
  return t.snapshot
})().finally(() => { t.get(i) === s && t.delete(i) }); // 在途表清理
```

并发去重：同 key 的并发 `getTaskSnapshot` 共享同一个 Promise（`t.get(i)` 命中即返回）。

### 2.4 与 host 的配合

host 侧 `getTaskSnapshotWithEtag`（host @451960 起，beautified: q9-host-traj-rpc.js L90-131）用 **`sha256(JSON.stringify(snapshot))` 作 ETag**，`ifNoneMatch` 命中时返回 `{snapshot:null, etag, notModified:true}` 并打日志 `[zcode-task-service] 历史快照 ETag 命中缓存`。host 本身无缓存——缓存在 renderer。

---

## 3. readSession 的 messageLimit 语义

### 3.1 host 转发层（不截断，透传给 agent runtime）

```js
// host @350472（agentService.readSession）
async readSession(m) {
  let x = await F(m); await qn({ client: x, reason: "session_read", workspace: m });
  let B = await x.request(Ge.sessionRead,
    { sessionId: m.sessionId, deliveryKind: m.deliveryKind, messageLimit: m.messageLimit, afterSeq: m.afterSeq }, ji);
  return nr(m, B), B
}
```

`messageLimit` 原样进入对 agent runtime 连接的 `sessionRead` RPC——**真正的部分读取（按需裁剪消息）发生在 runtime 进程（CLI），不在这 3 个文件内**。host 外层 `createZCodeSessionService`（`Bx` @500560，`s(Bx,"createZCodeSessionService")` @508553）只做包装：

```js
// beautified: q9-host-sessionsvc.js L111-122（host @506100）
async readSession(w) {
  let v = Date.now(), k = await f(r(await e.readSession(w)), w);
  // r = withApiRetryRuntime（API 重试包装）；f = repairEmptyImportedClaudeSession（修复导入的空 Claude 会话）
  return Si.info(void 0, "[zcode-session-service] readSession 历史快照读取完成",
    { deliveryKind: w.deliveryKind, durationMs: ..., messageLimit: w.messageLimit ?? null, ... }), k
}
```

### 3.2 messageLimit 在快照路径上的实际裁剪：`limitTaskSnapshotMessages`（host @462893）

`getTaskSnapshot`（host @450471）对 legacy（task-index 存储）与 session（v4 session store）两种快照都套 `GY(snapshot, y.messageLimit)`：

```js
// beautified: q9-host-limitfn.js L38-92（host @462789 / @462893）
function KCe(e) {  // normalizeSnapshotMessageLimit：仅接受有限正数，向下取整；否则视为不限
  if (!(!e || !Number.isFinite(e) || e <= 0)) return Math.floor(e)
}
function GCe(e, t) { return { truncatedBefore: e > t, totalMessages: e } }  // buildSnapshotHistory
function GY(e, t) {  // limitTaskSnapshotMessages
  let n = KCe(t); if (!n) return e;
  let o = GCe(e.messages.length, n);
  return { ...e, messages: o.truncatedBefore ? e.messages.slice(-n) : e.messages, history: o }
}
```

语义：**只按消息条数**裁剪，保留**最新的 N 条**（`slice(-n)`），并附 `history: {truncatedBefore, totalMessages}` 让 UI 显示“更早消息已截断”。诊断统计 `Tk`（`getTaskSnapshotMessageDiagnostics`，统计 assistant/user 条数、toolCalls、contentChars 等）用于 host 日志。

### 3.3 byteBudget / toolLimit：仅存在于 renderer 缓存 key

host 与 main 中 `byteBudget`/`toolLimit` **零出现**（仅 styles @296694/@296748 出现在 `wme` key 拼接处）。即在这 3 个文件的实现里**没有跨消息/字节/工具数的预算记账**——所谓 budget 实际只有“消息条数”一维生效；byteBudget/toolLimit 是缓存 key 的保留维度（改变任一会得到不同缓存条目），但请求链路并不下传。

### 3.4 典型用法（renderer）

- **meta-only 读取**：styles @305549（`Xme`，`readSession({..., messageLimit: 1})`）与 styles @2295997（选择侧会话探测，同样 `messageLimit: 1`）——只取 1 条消息以拿到 `settings.model.current`/标题等元数据，探测失败含 `sessionNotFound` 时走重建分支。
- 快照读取（`getTaskSnapshot`）在本文件内的调用都经缓存 Proxy；`messageLimit` 参与缓存 key，故不同 limit 的快照互不命中。

---

## 附：产出物清单

`D:\tmp\zc-analysis\out\sidepane-q9\`：q9-host-traj-build.js（reader+mapRecord）、q9-host-traj-rpc.js（getTaskSnapshot/ETag/getModelTrajectory）、q9-host-limitfn.js（GY/Tk）、q9-host-sessionsvc.js（readSession 包装）、q9-styles-snapshot.js（缓存全套）、q9-styles-traj-ui.js（轨迹 UI）、q9-host-taskservice-a/b.js、q9-host-srcfiles3.js、q9-host-readsession.js。

**关键结论速览**：① `getModelTrajectory` 在 host 进程实现，数据来自 `~/.zcode/cli/{debug,rollout}/model-io-<taskId>.jsonl`（每任务一文件、无 rotation、尾部 32MB + 最新 200 条截断、无脱敏），sourceFiles 即这些 JSONL 的绝对路径；② 快照缓存是 renderer 三层（在途 Promise / 内存 ETag / localStorage 持久化），单条 256KB、总量 2MB、20 条，按 updatedAt 的 LRU 淘汰，ETag 为 host 计算的快照 sha256；③ messageLimit 只按条数裁剪保留最新 N 条（host `GY`），readSession 的部分读取真正执行方是 runtime 进程，byteBudget/toolLimit 仅是缓存 key 维度、链路未下传。