# Agent Message Attachments Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users attach files to the next Lume agent message so attachments are saved to the thread, bound to the user turn, visible in chat, and available to the agent as message context.

**Architecture:** Reuse the existing thread file store as the durable attachment location. Add a small `messageAttachments` protocol to `AgentSendInput`, validate/resolve it in sidecar runtime-facing code, persist it in user message metadata and runtime events, then let the context assembler prepend a compact attachment brief to the model-facing user message. Keep RPC handlers as validation/delegation only.

**Tech Stack:** TypeScript, React, Jotai, Tauri invoke bridge, Bun tests, Lume sidecar runtime, `@lume/shared`.

---

## File Structure

- `packages/shared/src/types/agent.ts`: add shared attachment reference types and `AgentSendInput.messageAttachments`.
- `packages/shared/src/types/runtime-event.ts`: add attachments to `message.user.submitted` runtime events.
- `apps/sidecar/src/rpc/schemas.ts`: validate message attachment payloads.
- `apps/sidecar/src/services/agent/agent-files-service.ts`: add safe relative-path helpers for saved thread files and attachment resolution.
- `apps/sidecar/src/services/agent/agent-service.ts`: persist attachments in user message metadata, emit user SDK messages with image blocks when appropriate, and pass attachments into runtime input.
- `apps/sidecar/src/services/agent-runtime/context/message-attachments.ts`: new focused helper for formatting attachment briefs and resolving image content blocks.
- `apps/sidecar/src/services/agent-runtime/context/context-assembler.ts`: include the attachment brief in `userMessageForModel`.
- `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts`: thread attachments into context assembly and model query input.
- `apps/sidecar/src/services/agent-runtime/runner/run-item-events.ts`: project attachment metadata onto runtime events for UI replay.
- `apps/web/src/components/agent/AgentInput.tsx`: manage pending attachments, save them before send, and include saved references.
- `apps/web/src/components/agent/AgentView.tsx`: route main-view drag/drop into composer pending attachments instead of immediate save.
- `apps/web/src/components/agent/runtime-message-view.ts`: include user message attachment views.
- `apps/web/src/components/agent/runtime-event-message-projection.ts`: project user attachments into message views.
- `apps/web/src/components/agent/RuntimeEventContentBlock.tsx`: render user attachment chips and support opening thread files.
- Tests live beside the touched modules and should be focused only on changed logic.

---

## Chunk 1: Shared Protocol And Sidecar Validation

### Task 1: Add Shared Message Attachment Types

**Files:**
- Modify: `packages/shared/src/types/agent.ts`
- Modify: `packages/shared/src/types/runtime-event.ts`

- [ ] **Step 1: Add the shared payload type**

Add near the existing Agent attachment types:

```ts
export interface AgentMessageAttachmentInput {
  id: string
  filename: string
  mediaType: string
  size: number
  threadPath: string
}
```

- [ ] **Step 2: Extend `AgentSendInput`**

Add:

```ts
/** Files saved in the thread file area and bound to this user message */
messageAttachments?: AgentMessageAttachmentInput[]
```

- [ ] **Step 3: Extend `UserMessageSubmittedRuntimeEvent`**

Import or define through the shared type and add:

```ts
attachments?: AgentMessageAttachmentInput[]
```

- [ ] **Step 4: Run focused type consumers only if TypeScript reports local errors while editing**

No full typecheck is required for this purely structural step unless imports or exports break immediately.

### Task 2: Validate Attachment Payloads At RPC Boundary

**Files:**
- Modify: `apps/sidecar/src/rpc/schemas.ts`
- Test: `apps/sidecar/src/rpc/schemas.agent-attachments.test.ts`

- [ ] **Step 1: Write the schema test**

Create tests that assert:

```ts
expect(agentSendInputSchema.parse({
  threadId: "thread-1",
  userMessage: "read this",
  messageAttachments: [{
    id: "att-1",
    filename: "brief.md",
    mediaType: "text/markdown",
    size: 1200,
    threadPath: "files/brief.md"
  }]
}).messageAttachments).toHaveLength(1);
```

Also reject missing `threadPath`, negative `size`, empty `filename`, and absolute or parent-traversal paths such as `/tmp/a.txt` and `../a.txt`.

- [ ] **Step 2: Run the failing schema test**

Run:

```bash
rtk bun test apps/sidecar/src/rpc/schemas.agent-attachments.test.ts
```

Expected: FAIL because `messageAttachments` is not in the schema.

- [ ] **Step 3: Add the schema**

Add a local `agentMessageAttachmentInputSchema`:

```ts
const relativeThreadPathSchema = z.string()
  .min(1)
  .refine((value) => !value.startsWith("/") && !value.includes(".."), {
    message: "附件路径必须是线程内相对路径"
  });

const agentMessageAttachmentInputSchema = z.object({
  id: z.string().min(1),
  filename: z.string().min(1),
  mediaType: z.string().min(1),
  size: z.number().int().min(0),
  threadPath: relativeThreadPathSchema
});
```

Then add `messageAttachments: z.array(agentMessageAttachmentInputSchema).optional()` to `agentSendInputSchema`.

- [ ] **Step 4: Run the schema test**

Run:

```bash
rtk bun test apps/sidecar/src/rpc/schemas.agent-attachments.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/shared/src/types/agent.ts packages/shared/src/types/runtime-event.ts apps/sidecar/src/rpc/schemas.ts apps/sidecar/src/rpc/schemas.agent-attachments.test.ts
rtk git commit -m "✨ feat(shared,sidecar): 增加消息附件输入协议" \
  -m "Constraint: 附件引用只允许线程内相对路径" \
  -m "Tested: rtk bun test apps/sidecar/src/rpc/schemas.agent-attachments.test.ts"
```

---

## Chunk 2: Runtime Attachment Context

### Task 3: Resolve Thread Attachment References Safely

**Files:**
- Modify: `apps/sidecar/src/services/agent/agent-files-service.ts`
- Test: `apps/sidecar/src/services/agent/agent-files-service.test.ts`

- [ ] **Step 1: Add failing tests**

Add coverage for:

- `toThreadRelativePath(workspaceSlug, threadId, targetPath)` converts a saved absolute thread file path to a safe relative path.
- `resolveThreadAttachmentPath(workspaceSlug, threadId, "brief.md")` returns an absolute path inside the thread directory.
- `resolveThreadAttachmentPath` rejects `../brief.md` and missing files.

- [ ] **Step 2: Run the focused file-service test**

Run:

```bash
rtk bun test apps/sidecar/src/services/agent/agent-files-service.test.ts
```

Expected: FAIL for missing helper exports.

- [ ] **Step 3: Implement helpers**

Add exported helpers without changing existing save semantics:

```ts
export function toThreadRelativePath(workspaceSlug: string, sessionId: string, targetPath: string): string {
  const sessionDir = resolveSessionDir(workspaceSlug, sessionId);
  const resolved = resolve(targetPath);
  if (!isWithin(sessionDir, resolved)) {
    throw new Error("附件路径不在当前线程目录内");
  }
  return relative(sessionDir, resolved).split(sep).join("/");
}

export function resolveThreadAttachmentPath(workspaceSlug: string, sessionId: string, threadPath: string): string {
  const resolved = resolveSafeTarget(workspaceSlug, sessionId, threadPath);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error("附件文件不存在");
  }
  return resolved;
}
```

- [ ] **Step 4: Run the focused file-service test**

Run:

```bash
rtk bun test apps/sidecar/src/services/agent/agent-files-service.test.ts
```

Expected: PASS.

### Task 4: Format Attachment Briefs For Context Assembly

**Files:**
- Create: `apps/sidecar/src/services/agent-runtime/context/message-attachments.ts`
- Create: `apps/sidecar/src/services/agent-runtime/context/message-attachments.test.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/context/context-assembler.ts`
- Test: `apps/sidecar/src/services/agent-runtime/context/context-assembler.test.ts`

- [ ] **Step 1: Write helper tests**

Test that `buildMessageAttachmentBrief`:

- Returns an empty string for no attachments.
- Includes filename, media type, human size, and thread path.
- Uses the instruction to read deeper details through file tools.
- Does not include base64 or absolute paths.

- [ ] **Step 2: Run helper tests and confirm red**

Run:

```bash
rtk bun test apps/sidecar/src/services/agent-runtime/context/message-attachments.test.ts
```

Expected: FAIL because the helper file does not exist.

- [ ] **Step 3: Implement the helper**

Keep it small:

```ts
import type { AgentMessageAttachmentInput } from "@lume/shared";

export function buildMessageAttachmentBrief(attachments?: AgentMessageAttachmentInput[]): string {
  if (!attachments?.length) return "";
  const lines = attachments.map((item) =>
    `- ${item.filename} (${item.mediaType}, ${formatBytes(item.size)}): ${item.threadPath}`
  );
  return [
    "本轮用户附加了以下文件：",
    ...lines,
    "",
    "请优先根据用户问题解读这些附件。需要更多细节时，使用文件读取工具访问对应路径。"
  ].join("\n");
}
```

- [ ] **Step 4: Extend `ContextAssemblyInput` and output composition**

Add `messageAttachments?: AgentMessageAttachmentInput[]`.

Build:

```ts
const attachmentBrief = buildMessageAttachmentBrief(input.messageAttachments);
const userMessageForModel = [memoryContext.userMessageForModel, attachmentBrief]
  .filter((part) => part.trim())
  .join("\n\n");
```

Return `userMessageForModel` from that composed value.

- [ ] **Step 5: Add context assembler test**

Assert `assemble({ userMessage: "summarize", messageAttachments: [...] })` returns `userMessageForModel` containing the user text and the attachment brief.

- [ ] **Step 6: Run focused context tests**

Run:

```bash
rtk bun test apps/sidecar/src/services/agent-runtime/context/message-attachments.test.ts apps/sidecar/src/services/agent-runtime/context/context-assembler.test.ts
```

Expected: PASS.

### Task 5: Persist And Project Attachments Through Runtime State

**Files:**
- Modify: `apps/sidecar/src/services/agent/agent-service.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/runner/run-item-events.ts`
- Test: `apps/sidecar/src/services/agent/agent-service.test.ts`
- Test: `apps/sidecar/src/services/agent-runtime/runner/run-item-events.test.ts`

- [ ] **Step 1: Add runtime projection test**

In `run-item-events.test.ts`, create a run whose `input.messageAttachments` contains one attachment and assert projected `message.user.submitted` includes `attachments`.

- [ ] **Step 2: Run projection test**

Run:

```bash
rtk bun test apps/sidecar/src/services/agent-runtime/runner/run-item-events.test.ts
```

Expected: FAIL because attachments are not projected.

- [ ] **Step 3: Thread attachments through runtime input**

In `createRuntimeCoreSession`, pass `input.messageAttachments` into `ContextAssembler().assemble`.

In `runPreparedRuntimeCoreAttempt`, no extra storage is needed if `input` already carries `messageAttachments`.

- [ ] **Step 4: Persist attachments in visible user metadata**

In `sendAgentMessage`, include:

```ts
...(input.messageAttachments?.length ? { messageAttachments: input.messageAttachments } : {})
```

inside `effectiveMessageMetadata`.

- [ ] **Step 5: Project attachments into runtime events**

In `projectRunStateToRuntimeEvents`, read:

```ts
const attachments = Array.isArray(run.input.messageAttachments)
  ? run.input.messageAttachments
  : Array.isArray(metadata?.messageAttachments)
    ? metadata.messageAttachments
    : undefined;
```

Add `attachments` only when non-empty.

- [ ] **Step 6: Add agent-service metadata test**

In `agent-service.test.ts`, send a message with one attachment and assert the visible user message metadata includes `messageAttachments`.

- [ ] **Step 7: Run focused sidecar runtime tests**

Run:

```bash
rtk bun test apps/sidecar/src/services/agent-runtime/runner/run-item-events.test.ts apps/sidecar/src/services/agent-runtime/context/message-attachments.test.ts apps/sidecar/src/services/agent-runtime/context/context-assembler.test.ts apps/sidecar/src/services/agent/agent-service.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
rtk git add apps/sidecar/src/services/agent/agent-files-service.ts apps/sidecar/src/services/agent/agent-files-service.test.ts apps/sidecar/src/services/agent/agent-service.ts apps/sidecar/src/services/agent/agent-service.test.ts apps/sidecar/src/services/agent-runtime/context apps/sidecar/src/services/agent-runtime/runtime-core/run.ts apps/sidecar/src/services/agent-runtime/runner/run-item-events.ts apps/sidecar/src/services/agent-runtime/runner/run-item-events.test.ts
rtk git commit -m "✨ feat(sidecar): 将消息附件注入 agent 上下文" \
  -m "Constraint: 非图片附件第一版只注入清单和线程内路径" \
  -m "Rejected: 自动内联附件全文 | 容易污染上下文预算" \
  -m "Tested: rtk bun test apps/sidecar/src/services/agent-runtime/runner/run-item-events.test.ts apps/sidecar/src/services/agent-runtime/context/message-attachments.test.ts apps/sidecar/src/services/agent-runtime/context/context-assembler.test.ts apps/sidecar/src/services/agent/agent-service.test.ts"
```

---

## Chunk 3: Web Pending Attachments And Chat Rendering

### Task 6: Add Pending Attachment State To Composer

**Files:**
- Modify: `apps/web/src/components/agent/AgentInput.tsx`
- Modify: `apps/web/src/components/agent/AgentView.tsx`
- Test: `apps/web/src/components/agent/AgentView.test.tsx`

- [ ] **Step 1: Add a small local UI type**

In `AgentInput.tsx`:

```ts
interface PendingMessageAttachment {
  id: string
  filename: string
  mediaType: string
  size: number
  sourcePath?: string
  data?: string
}
```

- [ ] **Step 2: Change `handleAttach` to stage files**

Use `openFileDialog()` and append pending items instead of immediately calling `SAVE_FILES_TO_THREAD`.

- [ ] **Step 3: Render pending attachment chips**

Render a compact row above composer tools:

- filename
- size
- remove icon button

Use existing button/icon style patterns and no new dependency.

- [ ] **Step 4: Allow attachment-only sends**

Compute `canSend` from `editorText.trim().length > 0 || pendingAttachments.length > 0`.

When text is empty, send `请解读这些附件。`.

- [ ] **Step 5: Save pending files before `agentSend`**

In `handleSend`:

1. Call `SAVE_FILES_TO_THREAD`.
2. Convert results to `messageAttachments`.
3. Call `agentSend({ ..., messageAttachments })`.
4. Clear pending only after send succeeds.

The first implementation can derive `threadPath` from `filename` if files are saved at root. If using `targetPath`, add a sidecar return field or helper only if needed by tests.

- [ ] **Step 6: Route main-view drops into composer**

Move the current immediate-save drop behavior in `AgentView.tsx` behind a callback prop into `AgentInput`, or keep `AgentView` responsible for reading dropped files and pass them down as pending attachments. Pick the smaller diff after inspecting component state.

- [ ] **Step 7: Add/update focused web test**

Cover that dropping or attaching a file does not call `agentSend` immediately, and sending calls `SAVE_FILES_TO_THREAD` before `SEND_THREAD_MESSAGE` with `messageAttachments`.

- [ ] **Step 8: Run focused web tests**

Run:

```bash
rtk bun test apps/web/src/components/agent/AgentView.test.tsx
```

Expected: PASS.

### Task 7: Render Attachments In User Messages

**Files:**
- Modify: `apps/web/src/components/agent/runtime-message-view.ts`
- Modify: `apps/web/src/components/agent/runtime-event-message-projection.ts`
- Modify: `apps/web/src/components/agent/RuntimeEventContentBlock.tsx`
- Test: `apps/web/src/components/agent/runtime-event-message-projection.test.ts`
- Test: `apps/web/src/components/agent/RuntimeEventContentBlock.test.ts`

- [ ] **Step 1: Extend user message view type**

Add:

```ts
attachments?: AgentMessageAttachmentInput[]
```

to `RuntimeUserMessageView`.

- [ ] **Step 2: Project attachments**

In `projectRuntimeEventMessages`, copy `event.attachments` onto the user message view when non-empty.

- [ ] **Step 3: Render attachment chips**

In the user-message rendering path in `RuntimeEventContentBlock.tsx`, add compact chips below the text. Each chip should call `onOpenThreadFile?.(attachment.threadPath)` when clicked.

- [ ] **Step 4: Add projection and render tests**

Projection test: `message.user.submitted` with attachments yields a user view with attachments.

Render test: attachment filename appears and clicking it calls `onOpenThreadFile` with the thread path.

- [ ] **Step 5: Run focused web tests**

Run:

```bash
rtk bun test apps/web/src/components/agent/runtime-event-message-projection.test.ts apps/web/src/components/agent/RuntimeEventContentBlock.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add apps/web/src/components/agent/AgentInput.tsx apps/web/src/components/agent/AgentView.tsx apps/web/src/components/agent/AgentView.test.tsx apps/web/src/components/agent/runtime-message-view.ts apps/web/src/components/agent/runtime-event-message-projection.ts apps/web/src/components/agent/runtime-event-message-projection.test.ts apps/web/src/components/agent/RuntimeEventContentBlock.tsx apps/web/src/components/agent/RuntimeEventContentBlock.test.ts
rtk git commit -m "✨ feat(web): 支持下一条消息绑定附件" \
  -m "Constraint: 主视图拖拽与 paperclip 统一为 pending 附件语义" \
  -m "Tested: rtk bun test apps/web/src/components/agent/AgentView.test.tsx apps/web/src/components/agent/runtime-event-message-projection.test.ts apps/web/src/components/agent/RuntimeEventContentBlock.test.ts"
```

---

## Chunk 4: Provider Image Path Verification

### Task 8: Verify Image Attachment Model Input Path

**Files:**
- Modify as needed: `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts`
- Modify as needed: `packages/sdk/src/agent.ts`
- Modify as needed: provider conversion tests near the changed path.

- [ ] **Step 1: Inspect current SDK content block support**

Confirm whether `agent.query()` can receive `ContentBlockParam[]` with an image block in this path. The SDK type already allows `string | ContentBlockParam[]`, but `LumeRunner` currently passes a string.

- [ ] **Step 2: If content blocks are already supported, add a sidecar test**

Add a test that an image attachment produces model input with:

```ts
[
  { type: "image", source: { type: "base64", media_type: "image/png", data: "..." } },
  { type: "text", text: "..." }
]
```

Use a tiny fixture buffer from a temp file.

- [ ] **Step 3: If content blocks are not wired, add the smallest bridge**

Prefer a helper in `message-attachments.ts` that returns:

```ts
type ModelUserMessageInput = string | ContentBlockParam[]
```

Then make `CreateRuntimeCoreSessionResult.userMessageForModel` accept that union.

- [ ] **Step 4: Run focused SDK/sidecar tests**

Run only the tests that cover the changed query path. Candidate commands:

```bash
rtk bun test packages/sdk/src/agent.test.ts apps/sidecar/src/services/agent-runtime/runner/lume-runner.test.ts
```

Adjust to narrower tests if a new focused test file is added.

- [ ] **Step 5: Commit if changes were needed**

```bash
rtk git add apps/sidecar/src/services/agent-runtime/runtime-core/run.ts apps/sidecar/src/services/agent-runtime/context/message-attachments.ts packages/sdk/src/agent.ts
rtk git commit -m "✨ feat(sidecar,sdk): 接通图片附件模型输入" \
  -m "Constraint: 仅复用 SDK 已支持的 content block 输入" \
  -m "Tested: <focused command actually run>"
```

Skip this commit if inspection proves the runtime text-brief implementation is the only required first version path and no code changed.

---

## Final Verification

- [ ] Run the accumulated focused tests from commits above.
- [ ] Start the web app only if UI behavior changed enough to require visual/manual verification.
- [ ] Manually smoke test:
  - Attach a markdown/text file, send “总结这个文件”.
  - Attach only a file with no text and send.
  - Drop a file into the agent view and confirm it waits in the composer.
  - Confirm message shows attachment chip and opens the right thread file.
- [ ] Check `rtk git status --short` and keep unrelated memory-v2/settings worktree changes out of attachment commits unless the user explicitly expands scope.

## Known Risks

- The current worktree already has unrelated memory-v2/settings changes; do not stage them accidentally.
- `SAVE_FILES_TO_THREAD` currently returns absolute `targetPath`; implementation must avoid exposing arbitrary absolute paths in `messageAttachments`.
- Plan-mode continuation may transform send inputs; attachments should apply to normal user sends only unless tests prove continuation needs them.
- Image multimodal support may require a small SDK bridge even though the SDK type accepts content blocks.
