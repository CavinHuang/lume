# Agent 历史划线引用 — 设计（Proma 对齐）

> 日期：2026-08-05
> 起点：Proma `quoted-selection` 机制（同源项目移植，`D:\workspace\projects\ai-projects\Proma`）
> 目标：在 Lume Agent 历史消息 / 文本预览中划选文本 → 作为上下文引用，随消息发送给 Agent
> 关联：memory `project_lume-aligns-proma-ui`；本设计不涉及代码行级引用（已有 comment attachment 覆盖，见 §1.3）

## 0. TL;DR

把 Proma 的 `quoted_selection` 机制完整移植到 Lume（`apps/web`）。一条主链路：

- 中枢 atom：`quotedSelectionMapAtom`（`Record` + `createThreadSliceFamily`，**不持久化**，一次性快照语义）
- 序列化：`lib/quoted-selection.ts`（复刻 Proma，`<quoted_file>` / `<quoted_context>` XML）
- 采集：**通用 `useQuotedSelection` hook**（把 Proma 三处重复的采集逻辑 DRY 化）+ `AgentHistorySelectionLayer`
- chip / popover / 发送拼接 / user 消息渲染接入各一处落点

**核心分层（最重要的结论）**：Lume 已有「代码行级引用」`RightPanelSourcePreview.addSelectionToComposer → AgentDiffCommentAttachment`（带行号 + diff hunk + 独立通道，比 Proma 更强）。本次 **不重复覆盖代码场景**；`quoted_selection` 主补 **Agent 历史自由文本划选**——这是 comment attachment 做不到的主力场景。两套机制互补不重叠（§1.3）。

---

## 1. 现状

### 1.1 Proma（移植源）机制概览

采集 → 中枢 → 序列化 → 消费 → 渲染，五段：

| 段 | Proma 实现 |
|---|---|
| 采集（3 源，各自重复一份逻辑） | `AgentHistorySelectionLayer.tsx` / `DiffTabContent.tsx` / `ScratchPadView.tsx`：`selectionchange` + `pointerup/keyup` + 80ms 去抖 |
| 中枢 | `quotedSelectionMapAtom: Map<sessionId, QuotedSelection>`（`preview-atoms.ts:99`） |
| 序列化 | `lib/quoted-selection.ts`：`buildQuotedSelectionBlock()` → XML；`parseQuotedSelectionRefs()` 反解 |
| 消费 | `ChatView.tsx:297` / `AgentView.tsx:2326` prepend 到消息体；`consumeQuotedSelection()` 一次性消费 + `capturedAt` 乐观锁 |
| 渲染 | `ChatMessageItem.tsx:53` / `SDKMessageRenderer.tsx:751` 解析回卡片 |

`QuotedSelection` 字段：`text / filePath / sourceType('file'|'agent-history'|'scratch-pad') / sourceLabel / messageId / messageRole / startLine / endLine / capturedAt`。

### 1.2 Lume（目标）逐模块对比

| 模块 | Proma | Lume 对应 | 差异 |
|---|---|---|---|
| 输入框 | `ChatInput.tsx` + `rich-text-input.tsx` | `apps/web/src/components/agent/AgentInput.tsx`（tiptap） | Lume 无 `ChatView` 层，全在 `handleSend` |
| 发送 | `ChatView.sendMessage` / `AgentView` | `AgentInput.tsx::handleSend`（:1167-1450），`text` 在 :1237，`agentSend` 在 :1334 | 拼接点必须在 `clientSubmissionId`（:1259）之前 |
| 状态库 | jotai，`Map` | jotai，**`Record` + `createThreadSliceFamily`** + `atomWithStorage`（`agent-atoms.ts:15-21`） | 写入必须 root atom 不可变展开 `{...prev,[id]:next}` |
| 输入框 chip 挂载 | ChatInput 顶部 chip 行 | `LumeComposer` 的 `topContent` slot（`AgentInput.tsx:1866`） | 已有 comment/browser attachment chip 同列 |
| 消息渲染 | `SDKMessageRenderer` / `ChatMessageItem` | `RuntimeEventContentBlock.tsx`：assistant→`SmoothText`（:1897，XMarkdown），user→`CapabilityMessageText`（:741） | user 文本已有「parts 渲染 chip」范式 |
| 消息 DOM 锚点 | `data-message-id` + `data-message-role` | `AgentMessages.tsx:376` 有 `data-message-id`，**缺 `data-message-role`** | 前置改动 +1 行 |
| 消息类型 | — | `AgentThreadMessage`（`packages/shared/src/types/agent.ts:214`），`content` + `metadata?` | XML 进 `content`，**无需改 schema** |
| 既有选区经验 | — | `apps/desktop/src/browser-overlay/useAnnotationInteraction.ts`（`getSelection`+`range`+capture，desktop-only 独立 webview） | 借思路，不搬代码 |

### 1.3 两套引用机制对比（决定本次范围的关键）

|  | comment attachment（**Lume 已有，保留**） | quoted_selection（**本次新增**） |
|---|---|---|
| 触发 | `PierreDiffView` 行级选区（`enableLineSelection`） | 任意文本自由划选 |
| 数据 | `path` + `startLine/endLine` + `selectedContent` + `localDiffHunk` | `text` + `sourceType` + `sourceLabel`（可选 messageId/role） |
| 传输通道 | `agentSend.commentAttachments`（**独立字段**） | XML prepend 到 `userMessage` text（**文本通道**） |
| 输入框展示 | comment chip（`path:Lline · body`） | 引用卡片（text 摘要 + 来源） |
| 消息渲染 | comment attachment 卡片 | `parseQuotedSelectionRefs` → 引用卡片 |
| 持久化草稿 | `agentDiffCommentDraftsAtom/Family` | 拟 `quotedSelectionMapAtom`（不持久化） |
| 适用场景 | 代码文件**精确行定位**（可还原 diff hunk） | 消息正文 / 文档**自由文本** |
| 实现位置 | `RightPanelSourcePreview.tsx:218 addSelectionToComposer` | 本次新建 |

**结论**：互补不重叠。代码引用继续走 comment attachment（更强），`quoted_selection` 专攻自由文本——主力是 **Agent 历史消息**。

---

## 2. 数据流总览

```
┌─ 采集 (useQuotedSelection hook，各面板参数化挂载) ──────────┐
│  AgentHistorySelectionLayer  ← Agent 历史（主力，一期）     │
│  [Diff/代码文件]             ← 已由 comment attachment 覆盖 │
│  [Wiki/Reading/markdown]     ← defer（见 §3.8）             │
│  selectionchange + pointerup/keyup → 80ms 去抖 → 捕获       │
│  → 弹 SelectionActionPopover（为 Agent 引用 / 打开右侧问答）│
└──────────────────────────┬──────────────────────────────────┘
                           │ 写入（覆盖式，一次性快照）
                           ▼
┌─ 中枢 ─────────────────────────────────────────────────────┐
│  quotedSelectionMapAtom: Record<threadId, QuotedSelection>  │
│  quotedSelectionFamily = createThreadSliceFamily(...)       │
└──────────────────────────┬──────────────────────────────────┘
        ┌───────────────────┴────────────────────┐
        ▼ 输入框读                                ▼ handleSend 消费
   QuotedSelectionChip                        buildQuotedSelectionBlock()
   (topContent slot)                          → prepend 到 text（clientSubmissionId 之前）
   onRemove → root atom 不可变删除            → consumeQuotedSelection()（capturedAt 乐观锁删除）
                                          ↓ agentSend(userMessage: XML+text)
                                   ┌─────────────────────────┐
                                   │ user 消息 content 持久化 │
                                   └─────────────────────────┘
                                          ↓ 渲染
                                   user 文本分流函数（:697-714）
                                   parseQuotedSelectionRefs(text)
                                   → 引用卡片 + cleanText → CapabilityMessageText
```

---

## 3. 设计

### 3.1 中枢 atom

新建 `apps/web/src/atoms/quoted-selection.ts`（或并入 `agent-atoms.ts`，二选一，建议独立文件）：

```ts
// 类型复刻 Proma；sourceType 暂只 'agent-history'，预留 'file'/'wiki' 等
export interface QuotedSelection {
  text: string
  filePath: string              // 兼容展示字段
  sourceType: 'agent-history' | 'file' | 'wiki' | 'reading'
  sourceLabel?: string
  messageId?: string
  messageRole?: 'user' | 'assistant' | 'system'
  startLine?: number
  endLine?: number
  capturedAt: number            // 乐观锁 key
}

// Record（非 Map）+ createThreadSliceFamily，对齐 Lume 规约
export const quotedSelectionMapAtom = atom<Record<string, QuotedSelection>>({})
export const quotedSelectionFamily = createThreadSliceFamily(quotedSelectionMapAtom)
```

- **不持久化**（不用 `atomWithStorage`）：引用是「一次性快照」，发送即消费；刷新后不应残留旧引用（与 Proma 一致）。
- 写入侧必须 root atom 不可变展开：`set(quotedSelectionMapAtom, prev => ({ ...prev, [threadId]: next }))`，删除用 `{ [threadId]: _, ...rest } = prev; return rest`。
- 在 `atoms/index.ts` re-export。

### 3.2 序列化 lib（复刻）

新建 `apps/web/src/lib/quoted-selection.ts`：直接复刻 Proma 同名文件，含：
- `buildQuotedSelectionBlock(q)` → `<quoted_file path="…">` 或 `<quoted_context source label message_id role>` XML
- `parseQuotedSelectionRefs(content)` → `{ quotes, text }`（剥离 XML，返回纯文本 + 引用列表）
- `sanitizeQuotedText` / `escapeXmlAttribute` / `decodeXmlAttribute`（防注入）

> 放在 `lib/` 与既有 `agent-input-draft-state.ts` 等纯函数同风格。**纯函数、无副作用，可直接照搬**。

### 3.3 采集层：通用 `useQuotedSelection` hook（DRY，优于 Proma 原版）

Proma 在三个源各复制了一份 `selectionchange + pointerup + 80ms 去抖`。Lume 一开始就全量，**反向抽成 hook**：

新建 `apps/web/src/hooks/use-quoted-selection.ts`：

```ts
interface UseQuotedSelectionOptions {
  rootRef: React.RefObject<HTMLElement | null>   // 监听容器
  threadId: string | null                         // 写入哪个会话
  sourceType: QuotedSelection['sourceType']
  sourceLabel: string | ((range: Range) => string)  // 固定名 或 从 DOM 提取
  enabled?: () => boolean                         // 启用条件（如 previewOnly）
  getSelection?: (root: HTMLElement) => { text: string; rect: DOMRect } | null
                                                  // 默认 window.getSelection；diff/shadow 场景注入 getDeepSelection
  extractContext?: (range: Range) => { messageId?: string; messageRole?: string; startLine?: number; endLine?: number }
                                                  // agent-history 用 closest('[data-message-id]')
  maxChars?: number                               // 默认 2000
  actions: { onAddToAgent: () => void; onOpenChat?: () => void }
}
// 返回 { selection: {text,x,y,sourceLabel} | null, SelectionActionPopover 节点 }
```

**参数化维度**（来自 Proma 三源差异分析）：

| 维度 | agent-history | Diff（若接） | scratch-pad（无） |
|---|---|---|---|
| `getSelection` | `window.getSelection` | `getDeepSelection`（穿透 ShadowRoot，Shiki） | `window.getSelection` |
| `extractContext` | `closest('[data-message-id]')`+role | filePath | 无 |
| `enabled` | 始终 | `previewOnly && !markdownEditing` | editor 存在 |

**`AgentHistorySelectionLayer.tsx`**（新建，挂在 `AgentMessages.tsx` 滚动容器同级）：基于此 hook，`sourceType:'agent-history'`，`extractContext` 读 `data-message-id`/`data-message-role`，`getRoleLabel` 映射角色展示名。

**前置改动（必做，1 行）**——`AgentMessages.tsx:376`：

```tsx
<div key={`runtime-event-${msg.id}`}
     data-message-id={msg.id}
     data-message-role={msg.type}>   {/* ← 新增 */}
```

### 3.4 `SelectionActionPopover`（两动作，对齐 Proma）

新建 `apps/web/src/components/selection/SelectionActionPopover.tsx`（Lume 无 `components/selection/` 目录，一并建）。复刻 Proma：浮动 `fixed z-[90]`，两按钮：

- **「为 Agent 引用」**（`handleAddToAgent`）：写 `quotedSelectionMapAtom[threadId]`，清选区，toast。
- **「打开右侧问答」**（`handleOpenChat`，对齐 Proma `handleOpenChatTab`）：创建新 conversation → 写引用到新会话 → 打开 right-panel → 切到 chat tab。
  - **适配点**：Lume 右侧栏用 `right-panel-atoms.ts`（与 Proma `agentSidePanelOpenAtom`/`agentDiffPanelTabAtom` 不同），需调研 Lume 的 side-chat 打开路径后落地（见 §7 风险）。

### 3.5 输入框 chip

新建 `apps/web/src/components/agent/QuotedSelectionChip.tsx`（Lume 无 `components/diff/`，放 `agent/`）：纯展示，复刻 Proma（`Quote` 图标 + text 截断 + sourceLabel + hover 显 X）。

挂载：`AgentInput.tsx:1866` 的 `topContent` slot 内，与 commentAttachments / browserAttachments chip 同一容器：

```tsx
{quotedSelection && (
  <QuotedSelectionChip
    text={quotedSelection.text}
    sourceLabel={quotedSelection.sourceLabel}
    onRemove={handleRemoveQuotedSelection}
  />
)}
```

- 从 `quotedSelectionFamily(threadId)` 读；`onRemove` 走 root atom 不可变删除。
- 视觉可参考 `DesktopContextSelectionChip.tsx`（rounded + Badge + 图标 + X）。

### 3.6 发送拼接（`handleSend` 落点）

`AgentInput.tsx::handleSend` 内，**`text` 变量定义（:1237）后、`clientSubmissionId` 计算（:1259）前**：

```ts
const quotedSelection = consumeQuotedSelection(threadId)   // 读 + 乐观锁删除
const quotedBlock = quotedSelection ? buildQuotedSelectionBlock(quotedSelection) : ''
// ...
const text = quotedBlock + rawText      // ← XML prepend（仅非 directAttachment 分支）
```

- **必须在 `clientSubmissionId`（:1259）之前**：防重快照基于 `text` 计算 hash，不含引用块则防重失效。
- **`consumeQuotedSelection`**：复刻 Proma 的「一次性消费 + `capturedAt` 乐观锁」——读取后仅当 Map 中仍是本条（`capturedAt` 相等）才删除，避免「发送途中用户又选新内容」误删新选区。
- 发送失败回填（可选，对齐 Proma）：`handleSend` catch 分支把引用写回 atom。

### 3.7 渲染接入（**user 消息侧**，纠正 assistant 侧误判）

引用 XML prepend 到 `text`，随 **user** 消息持久化 → 渲染在 **user** 消息侧，**不是** assistant 的 `SmoothText`。

接入点：`RuntimeEventContentBlock.tsx` 中调用 `CapabilityMessageText` 之前的 user 文本分流函数（:697-714）：

```ts
const { quotes, text: cleanText } = parseQuotedSelectionRefs(text)
return (
  <>
    {quotes.map(q => <QuotedSelectionCard key={...} quote={q} />)}
    {/* cleanText 继续走既有 capability/纯文本分流 */}
    <UserTextBody text={cleanText} messageParts={...} capabilityReferences={...} />
  </>
)
```

`QuotedSelectionCard`（引用卡片，展示 text 摘要 + sourceLabel）可由 `QuotedSelectionChip` 复用或单独建。`CapabilityMessageText` 内部「按 parts 渲染文本/chip」范式与此同构，是天然参考。

> 一期只处理 user 消息（引用块只在 user 消息出现）。assistant 回显不含引用 XML，无需改 `SmoothText`。

### 3.8 采集源清单（一期 / defer）

**一期接入：**
| 源 | 组件 | sourceType | 说明 |
|---|---|---|---|
| Agent 历史 | `AgentMessages.tsx`（+ `AgentHistorySelectionLayer`） | `agent-history` | **主力**，自由文本划选 |

**不接（已被更强机制覆盖）：**
| 源 | 已有机制 |
|---|---|
| 代码文件 / Diff | `RightPanelSourcePreview.addSelectionToComposer` → comment attachment（带行号 + diff hunk） |
| 代码评审 | `CodingReviewPanel` 内嵌 `PierreDiffView`，随上自动覆盖 |

**defer（独立基建，本期不做）：**
| 源 | 原因 |
|---|---|
| Wiki（`WikiView`）/ Reading（`ReadingView`） | XMarkdown 无段落锚点，需先做统一 markdown `data-md-block-id` 注入基建 |
| 各文件预览的 markdown 分支（`RightPanelFilePreview`/`FilePreviewTabView`/`SidePanel`/`CodingRichDiffPreview`） | 同上，统一入口 `DIFF_AWARE_MARKDOWN_COMPONENTS`（改一处覆盖全站） |
| MCP 资源（`RightPanelMcpResourcePreview`） | text 分支随代码源；markdown 同上 defer |
| scratch-pad | **Lume 无对应物**（grep 确认无独立便签面板），需先产品决策 |
| HTML 预览（iframe sandbox）/ PDB（canvas） | 跨 document / 非文本，不可行 |

---

## 4. 范围

| 文件 | 改动 |
|---|---|
| `apps/web/src/atoms/quoted-selection.ts` | **新建** `QuotedSelection` 类型 + `quotedSelectionMapAtom` + `quotedSelectionFamily` |
| `apps/web/src/atoms/index.ts` | re-export |
| `apps/web/src/lib/quoted-selection.ts` | **新建**（复刻 Proma 纯函数） |
| `apps/web/src/hooks/use-quoted-selection.ts` | **新建** 通用采集 hook（DRY） |
| `apps/web/src/components/agent/AgentHistorySelectionLayer.tsx` | **新建**（基于 hook） |
| `apps/web/src/components/agent/AgentMessages.tsx:376` | +`data-message-role={msg.type}`；挂 `AgentHistorySelectionLayer` |
| `apps/web/src/components/selection/SelectionActionPopover.tsx` | **新建**（两动作） |
| `apps/web/src/components/agent/QuotedSelectionChip.tsx` | **新建**（chip + 可复用 card） |
| `apps/web/src/components/agent/AgentInput.tsx` | `topContent`（:1866）加 chip；`handleSend`（:1237-1259）加拼接 + `consumeQuotedSelection` |
| `apps/web/src/components/agent/RuntimeEventContentBlock.tsx:697-714` | user 文本分流处 `parseQuotedSelectionRefs` + 引用卡片 |
| `packages/shared/src/types/agent.ts` | **不改**（XML 进 `content`，`metadata` 备用） |
| sidecar schema / `AgentSendInput` | **不改**（走 `userMessage` text 通道） |
| 测试 | `quoted-selection.test.ts`（序列化往返）；`use-quoted-selection` hook 单测；`AgentInput` 发送拼接契约测试 |

---

## 5. 取舍

- **传输走 XML prepend（对齐 Proma），不走独立 IPC 字段**：后者更结构化（类似 `commentAttachments`），但要改 `AgentSendInput` + sidecar schema + SDK 消费，成本远高。XML prepend 零 schema 改动，渲染时 `parseQuotedSelectionRefs` 无损还原元数据。选前者。
- **atom 不持久化**：一次性快照语义；刷新后无残留（对齐 Proma）。若未来要「发送失败回填」，在 `handleSend` catch 分支手动写回即可。
- **采集层做通用 hook（DRY）**：优于 Proma 三源各复制一份。Lume 一开始全量，正好有动机抽 hook。
- **代码引用保留 comment attachment，不让 `quoted_selection` 重复覆盖**：comment attachment 更强（行号 + diff hunk + 独立通道），重复造是负价值。
- **一期只 agent-history 源**：主力场景，链路最短可验证；其余源有明确 defer 理由（markdown 需独立锚点基建）。

---

## 6. 验收

- Agent 历史消息中鼠标划选任意文本 → 选区上方浮 `SelectionActionPopover`
- 「为 Agent 引用」→ 输入框 `topContent` 出现 `QuotedSelectionChip`（text 摘要 + 来源）
- chip 可点 X 移除；移除后 atom 清空
- 发送 → `<quoted_context>` XML 进入 user 消息 `content`；user 气泡渲染为「引用卡片 + 干净文本」（不裸露 XML）
- 发送后 chip 消失（一次性消费）；`quotedSelectionMapAtom` 该 thread 条目已删
- 「打开右侧问答」→ 创建新会话 + 右侧栏打开 chat tab + 新会话带引用
- 跨消息/多角色选区：`sourceLabel` 正确显示「Agent 历史 · 用户/Agent/系统消息」
- 超长选区（>2000 字符）截断 + toast；`quoted-selection.test.ts` 序列化往返测试过
- 防重：连续两次相同内容（含引用块）→ 第二次命中 `clientSubmissionId` 防重

---

## 7. 开放问题 / 风险

1. **「打开右侧问答」需接 Lume right-panel 架构**（§3.4）：Proma 用 `agentSidePanelOpenAtom`/`agentDiffPanelTabAtom`；Lume 用 `right-panel-atoms.ts`，side-chat 的打开/创建路径需实现时调研确认。**这是两动作里唯一有适配成本的部分**。
2. **Shiki shadow DOM**：Agent 历史里的代码块若经 Shiki 渲染在 shadow DOM，`window.getSelection` 可能取不到——hook 的 `getSelection` 参数需支持注入 `getDeepSelection`（复用 Proma `discoverShadowRoots`）。实现时先验证 agent 消息代码块的 DOM 结构再定。
3. **与 comment attachment 的 popover 共存**：代码文件上已有 `addSelectionToComposer` 的「让模型修改」/选区动作。本期 `quoted_selection` 只挂 Agent 历史，不碰代码文件，**无共存冲突**；未来若扩到代码文件需明确二者边界（建议代码文件继续只走 comment attachment）。
4. **`createThreadSliceFamily` 写入规约**：hook 和 chip 的所有写入必须走 root atom 不可变展开，否则 per-thread 订阅的重渲染优化失效——code review 重点。
