# Agent Message Queue Design

Date: 2026-06-02
Status: Draft, awaiting user review
Scope: `web`, `sidecar`, `shared`

## Summary

Add a first-class message queue for agent conversations. When an agent is still running, the user can submit follow-up messages without interrupting the current run. Those messages appear above the composer as a reorderable queue. The user can drag queued messages to change the order before they execute.

Clicking `引导` on a queued message promotes that message into the current run. The promoted guidance is consumed before the next tool call executes, then removed from the normal queue. The current model run is not stopped.

The file-change and commit UI shown in the reference image is not part of this design.

## Goals

- Allow sending messages while the current agent run is active.
- Show pending messages in the composer area instead of hiding them behind a count.
- Let users drag pending normal queue items to reorder them.
- Let users remove a pending queue item before it executes.
- Let users click `引导` to deliver a queued item before the next tool call in the current run.
- Preserve current per-thread serialization: one active run per thread.
- Reuse the existing `AgentRuntimeKernel`, runtime status, IPC, and composer patterns.

## Non-Goals

- Do not add file-change, commit, or diff summary UI.
- Do not interrupt or restart the current model run when `引导` is clicked.
- Do not add a new drag-and-drop dependency.
- Do not make queued messages durable across app restarts in V1; this matches the current in-memory kernel queue behavior.
- Do not implement rich queued-message editing in V1. A queued item can be removed and resubmitted.
- Do not make guidance reorderable after promotion. Guidance is an immediate current-run action, not a normal queue item.

## Chosen Approach

Extend the existing per-thread runtime queue instead of adding a parallel scheduler.

The current `AgentRuntimeKernel` already serializes dispatches for a thread and tracks `queuedCount`. This design makes that queue inspectable and controllable:

- queued dispatches receive stable queue item IDs;
- the sidecar exposes list, reorder, remove, and promote-to-guidance IPC handlers;
- the web composer renders the queue details and drag handles;
- `SEND_THREAD_MESSAGE` returns queue metadata when a message is queued.

This keeps the queue near the code that already owns run serialization and avoids a second source of truth.

Alternatives rejected:

- Frontend-only queue: easier for UI, but unsafe because messages from IM, automation, and other RPC callers would bypass it.
- New persistent queue store: stronger after restart, but larger than the requested interaction and inconsistent with the current kernel queue.
- Interrupt-and-restart guidance: gives stronger injection semantics, but violates the requirement that guidance should not interrupt the current run.

## User Experience

### Idle Thread

The composer behaves as it does today. Sending starts the run immediately.

### Running Thread

The composer remains editable. The main action becomes `提交到队列` when text or attachments are present. The stop button remains available as a separate control.

Queued messages render above the editor:

```text
队列 3 · 可拖动排序；当前运行不会被打断

⠿ 可以对照 Alice 的实现              ↳ 引导  删除
⠿ 先不要重构，最小改动就好          ↳ 引导  删除
⠿ 最后把交互状态补到测试里          ↳ 引导  删除
```

Drag handles reorder normal queued items. Delete removes a queued item. Reordering only affects items that have not started.

### Guidance

Clicking `引导` on a queued item:

- removes the item from the normal queue display;
- adds it to the current run's pending guidance lane;
- shows a compact pending guidance notice in the composer;
- consumes the guidance before the next tool call executes.

If multiple items are promoted before the next tool call, they are delivered together in click order.

If the current run completes without another tool call, pending guidance is returned to the front of the normal queue and runs as the next normal queued message. This prevents message loss and keeps the user's "send now" intent as close as possible.

## Shared Types And IPC

Add shared queue types:

```ts
export interface AgentQueuedMessage {
  id: string
  threadId: string
  text: string
  attachments?: AgentMessageAttachmentInput[]
  createdAt: number
  updatedAt: number
}

export interface AgentPendingGuidance {
  id: string
  threadId: string
  queuedMessageId: string
  text: string
  createdAt: number
}

export interface AgentMessageQueueSnapshot {
  threadId: string
  queuedMessages: AgentQueuedMessage[]
  pendingGuidance: AgentPendingGuidance[]
}
```

Extend `AgentThreadMessageDispatchResult`:

```ts
export interface AgentThreadMessageDispatchResult {
  ok: true
  mode: "sent" | "queued"
  queuedCount: number
  queuedMessage?: AgentQueuedMessage
}
```

Promotion returns an explicit status so the UI can distinguish a real guidance promotion from a fallback queue move:

```ts
export interface AgentPromoteQueuedMessageToGuidanceResult {
  ok: boolean
  status: "promoted" | "queued_to_front" | "not_found" | "already_started"
  snapshot: AgentMessageQueueSnapshot
  error?: string
}
```

Add IPC channels:

```ts
LIST_MESSAGE_QUEUE
REORDER_MESSAGE_QUEUE
REMOVE_QUEUED_MESSAGE
PROMOTE_QUEUED_MESSAGE_TO_GUIDANCE
MESSAGE_QUEUE_CHANGED
```

`MESSAGE_QUEUE_CHANGED` sends an `AgentMessageQueueSnapshot` for one thread so the web atom can hydrate queued messages and pending guidance from one source.

## Sidecar Design

### Kernel Queue

`AgentRuntimeKernel` keeps the existing active-thread guard and FIFO execution. It gains queue item metadata and queue operations:

- `listQueued(threadId)`
- `reorderQueued(threadId, orderedIds)`
- `removeQueued(threadId, queuedMessageId)`
- `promoteQueuedToGuidance(threadId, queuedMessageId)`

The kernel still starts the next queued dispatch when the current dispatch finishes.

### Dispatch Behavior

When `SEND_THREAD_MESSAGE` arrives while the thread is idle:

- dispatch starts immediately;
- existing optimistic/runtime-event behavior remains.

When it arrives while the thread is active:

- the dispatch is stored as a queued item;
- no visible user message is appended yet;
- `MESSAGE_QUEUE_CHANGED` notifies the web UI;
- the returned dispatch result includes `queuedMessage`.

When a queued dispatch begins:

- the existing `sendAgentMessage` flow appends the user message;
- `message.user.submitted` is emitted through existing message append projection;
- the queue change notification removes it from the queue display.

### Guidance Store

Add a small in-memory `AgentRunGuidanceStore` keyed by thread/run:

```ts
interface PendingRunGuidance {
  id: string
  threadId: string
  queuedMessageId: string
  input: AgentSendInput
  text: string
  createdAt: number
}
```

Promoting a queued message:

- removes that item from the normal kernel queue;
- adds it to `AgentRunGuidanceStore`;
- emits `MESSAGE_QUEUE_CHANGED`;
- the queue snapshot includes `pendingGuidance` so the UI can show "待引导".

If there is no active run when promotion is requested, there is no tool boundary to target. In that case the sidecar moves the item to the front of `queuedMessages`, returns `status: "queued_to_front"`, and does not create pending guidance.

### Tool Boundary Consumption

`createCanUseToolHandler` checks pending guidance before authorizing any tool.

If guidance exists, it is consumed before the tool executes. Because the SDK cannot inject a new ordinary user turn mid-response, the runtime sends guidance by denying the pending tool once with a synthetic tool result:

```text
用户在工具执行前追加了引导：
1. 可以对照 Alice 的实现

原工具调用尚未执行。请根据这条引导重新决定下一步；如果仍需要工具，请重新发起工具调用。
```

This gives the model a chance to reconsider before the stale tool call runs. The original tool call does not execute.

The sidecar also emits a `guidance.delivered` runtime event so the transcript can show what happened.

### Completion Fallback

When a run completes and pending guidance was not consumed:

- the guidance items are returned to the front of the normal queue in promotion order;
- the kernel starts the next queued dispatch as usual.

## Web Design

### State

Add `agentMessageQueueAtom` keyed by thread ID. Each value is an `AgentMessageQueueSnapshot`. It is hydrated from:

- `SEND_THREAD_MESSAGE` queued results;
- `MESSAGE_QUEUE_CHANGED` notifications;
- `LIST_MESSAGE_QUEUE` on thread mount.

Keep `agentRuntimeStatusAtom[threadId].queuedCount` for header summaries.

### Composer

`AgentInput` changes from "streaming means cannot send" to:

- if idle and has text: `发送`;
- if running and no text: show `停止`;
- if running and has text: show `提交到队列` plus a separate stop icon button;
- if a send result is `queued`, do not add an optimistic `message.user.submitted` runtime event.

The queue list lives in the composer support area above the editor. It reuses existing compact visual language and avoids nested cards.

### Drag Sorting

Use native drag/drop or pointer handlers inside a small local queue component. No new dependency.

The UI performs an optimistic reorder, calls `REORDER_MESSAGE_QUEUE`, and rolls back to the latest sidecar queue if the call fails.

### Guidance Action

Each queued item has an `引导` action. Clicking it calls `PROMOTE_QUEUED_MESSAGE_TO_GUIDANCE`.

- `status: "promoted"` means the item leaves `queuedMessages` and appears in `pendingGuidance`.
- `status: "queued_to_front"` means there was no active tool boundary target, so the item stays in the normal queue at the front.
- `status: "not_found"` or `status: "already_started"` refreshes the queue and shows a toast.

## Error Handling

- If queue reorder fails, restore the last server queue and show a toast.
- If delete fails, keep the item and show a toast.
- If promotion fails because the item already started, refresh the queue and show a toast.
- If there is no active run when promotion is attempted, the item is moved to the front of the normal queue and will run next.
- If the current run is stopped, pending guidance returns to the front of the normal queue.

## Testing

Relevant tests only:

- `AgentRuntimeKernel` queues, lists, reorders, removes, and starts remaining items in the expected order.
- `sendAgentMessage` / agent service returns queued metadata and does not append visible user messages before queued execution starts.
- Guidance promotion removes a queued item from the normal queue and stores pending guidance.
- Tool-boundary guidance consumption prevents the stale tool call from executing and emits a delivered event.
- Completion fallback returns unconsumed guidance to the front of the queue.
- Web queue state helpers reorder, remove, and apply queue notifications.
- `AgentInput` renders `提交到队列` while streaming with text and does not emit optimistic user runtime events for queued sends.

## Remaining Risks

- Guidance delivery depends on a future tool boundary. If the model completes with text only, guidance falls back to the normal queue instead of affecting the current answer.
- The synthetic tool-result mechanism is the least invasive way to send guidance mid-run, but the model may still need one extra turn to choose the correct next action.
- Native drag/drop behavior may need polish on touch devices; the desktop app path is the primary V1 target.
- In-memory queue items can be lost on process restart, matching current kernel behavior but not ideal for long-lived queued work.
