# Turn-Limited Continuity Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the bug where a user sends "继续" after a long/turn-limited run and the next model call loses the prior conversation context.

**Architecture:** The durable source of runtime continuity is the Agent SDK session transcript under runtime-core sessions. The fix makes SDK session persistence run even when the host stops consuming the query stream early on `error_max_turns`, then adds a sidecar regression that proves the next runtime session resumes the previous user request instead of seeing only "继续".

**Tech Stack:** Bun test runner, TypeScript, `@lume/agent-sdk`, sidecar runtime-core session manager.

---

## Chunk 1: Reproduce the Lost Transcript

### Task 1: Add an SDK Regression for Early Stream Close Persistence

**Files:**
- Modify: `packages/sdk/src/agent.test.ts`
- Modify: `packages/sdk/src/agent.ts`

- [ ] **Step 1: Write the failing test**

Add a test in `packages/sdk/src/agent.test.ts` that starts an agent with a fixed `sessionId`, consumes SDK events only until a simulated max-turn result, breaks out of the loop, then creates a new agent with `resume: sessionId` and verifies the resumed session includes the original user message.

Use a minimal provider/tool setup. If the existing `QueryEngine` test seams are too narrow, add the smallest local fake provider/engine seam rather than broad refactoring.

Test intent:

```ts
test("persists session when query stream consumer stops after max turns", async () => {
  const sessionId = `early-close-${crypto.randomUUID()}`;
  const agent = createAgent({
    sessionId,
    persistSession: true,
    tools: [],
    cwd: tempDir,
  });
  await agent.getInitializationResult();
  (agent as any).provider = new MaxTurnsProvider();

  for await (const event of agent.query("original task")) {
    if (event.type === "result" && event.subtype === "error_max_turns") break;
  }

  const resumed = createAgent({
    resume: sessionId,
    persistSession: false,
    tools: [],
    cwd: tempDir,
  });
  await resumed.getInitializationResult();

  expect(resumed.getMessages().some((message) =>
    message.type === "user" && message.message.content === "original task"
  )).toBe(true);

  await agent.close();
  await resumed.close();
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
bun test packages/sdk/src/agent.test.ts --filter "persists session when query stream consumer stops after max turns"
```

Expected: FAIL because early close skips the current `saveSession(...)` path.

## Chunk 2: Fix SDK Persistence on Early Return

### Task 2: Persist in a `finally` Path

**Files:**
- Modify: `packages/sdk/src/agent.ts`
- Test: `packages/sdk/src/agent.test.ts`

- [ ] **Step 1: Refactor `runSinglePrompt` persistence into a helper**

Extract the existing session save block from `runSinglePrompt` into a private method, for example:

```ts
private async persistCurrentSession(cwd: string, opts: AgentOptions): Promise<SDKMessage | null> {
  if (opts.persistSession === false || this.history.length === 0) return null;
  await saveSession(this.sid, this.history, {
    cwd,
    model: opts.model || this.modelId,
    summary: extractSummary(this.messageLog),
    sessionMessages: this.sessionMessages,
    checkpoints: this.fileCheckpointState,
  });
  return {
    type: "system",
    subtype: "files_persisted",
    files: [{ filename: "transcript.json", file_id: this.sid }],
    failed: [],
    processed_at: new Date().toISOString(),
    session_id: this.sid,
  } as SDKMessage;
}
```

Keep behavior identical for normally completed streams: callers should still receive the `files_persisted` event.

- [ ] **Step 2: Wrap the query loop with `try/finally`**

Inside `runSinglePrompt`, ensure these always happen even when the async generator is closed early:

```ts
try {
  for await (const event of engine.submitMessage(normalizedPrompt)) {
    // existing messageLog/sessionMessages handling
    yield event;
    // existing queued event drain
  }
} finally {
  this.history = engine.getMessages();
  this.lastContextUsage = engine.getContextUsage();
  this.currentEngine = null;
  this.pendingPersistedEvent = await this.persistCurrentSession(cwd, opts);
}
```

Do not yield from inside `finally`; stash the persisted event and yield it after normal completion only. Early-close callers do not need to see the event, but the transcript must be written.

- [ ] **Step 3: Verify the SDK regression passes**

Run:

```bash
bun test packages/sdk/src/agent.test.ts --filter "persists session when query stream consumer stops after max turns"
```

Expected: PASS.

- [ ] **Step 4: Run nearby SDK tests**

Run:

```bash
bun test packages/sdk/src/agent.test.ts
```

Expected: PASS.

## Chunk 3: Protect Sidecar Turn-Limited Continuation

### Task 3: Add a Sidecar Regression Around Runtime Resume

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runner/lume-runner.test.ts`
- Modify if needed: `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts`
- Modify if needed: `apps/sidecar/src/services/agent-runtime/runner/run-loop.ts`

- [ ] **Step 1: Write the failing sidecar test**

Add a test that runs `LumeRunner.runPreparedRuntimeCoreAttempt` with a fake `createRuntimeSession`. The fake agent's first `query("original task")` yields an assistant/tool-like event and then a `result` with `subtype: "error_max_turns"`. Then create the next runtime session for the same `threadId` with `userMessage: "继续"` and assert the session context contains `"original task"`.

Test intent:

```ts
test("turn-limited run leaves runtime transcript resumable for continue", async () => {
  const threadId = "thread-turn-limit-continue";
  const agentDir = mkdtempSync(join(tmpdir(), "lume-runner-turn-limit-"));
  dirs.push(agentDir);

  const runner = await LumeRunner.create({
    params: createTestParams(threadId),
    prepared: createPrepared(agentDir),
    emit: createRuntimeEventEmitter([]),
  });

  const result = await runner.runPreparedRuntimeCoreAttempt({
    params: createTestParams(threadId),
    prepared: createPrepared(agentDir),
    options: noopRuntimeOptions,
    createCanUseTool: () => async () => ({ behavior: "allow" }),
    createRuntimeSession: createFakeRuntimeSessionThatPersistsEarlyClosedMaxTurns,
  });

  expect(result.status).toBe("turn_limited");

  const sessionManager = createOrResumeRuntimeCoreSessionManager(agentDir, threadId, agentDir);
  const context = sessionManager.buildSessionContext();
  expect(JSON.stringify(context.messages)).toContain("original task");
});
```

Prefer a compact fake over invoking real providers.

- [ ] **Step 2: Run the sidecar regression**

Run:

```bash
bun test apps/sidecar/src/services/agent-runtime/runner/lume-runner.test.ts --filter "turn-limited run leaves runtime transcript resumable for continue"
```

Expected: PASS if the SDK fix covers sidecar; FAIL only if sidecar has an additional persistence gap.

- [ ] **Step 3: Add sidecar fallback only if the regression still fails**

If SDK persistence is not enough, update `apps/sidecar/src/services/agent-runtime/runner/run-loop.ts` or `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts` to explicitly flush/persist the session before returning `turn_limited`.

Keep this fallback narrow:

```ts
if (message.type === "result" && message.subtype === "error_max_turns") {
  await flushRuntimeSession?.();
  return { status: "turn_limited", errorMessage };
}
```

Do not rebuild a parallel transcript writer unless the SDK cannot own this safely.

- [ ] **Step 4: Run nearby sidecar tests**

Run:

```bash
bun test apps/sidecar/src/services/agent-runtime/runner/lume-runner.test.ts
```

Expected: PASS.

## Chunk 4: Make "继续" Safer After Turn Limit

### Task 4: Preserve Intent for Generic Continuation

**Files:**
- Modify: `apps/sidecar/src/services/agent/agent-service.ts`
- Modify or create test: `apps/sidecar/src/services/agent/agent-service.test.ts`

- [ ] **Step 1: Add a test for continuation wording**

Add a test that simulates the previous run ending with `turn_limited`, then sends `userMessage: "继续"`. Assert the runtime input uses an internal continuation instruction while the visible user message remains exactly `"继续"`.

Expected internal message shape:

```text
请继续完成上一轮未完成的原始任务。不要把这看作新任务；基于当前线程历史、已有工具结果和最后一个 assistant 状态继续。

用户发送的继续指令：继续
```

- [ ] **Step 2: Store or infer last turn-limited state narrowly**

Use existing runtime state/run stores if possible. Only add new metadata if there is no reliable source. Do not make every `"继续"` special; apply this only when the latest run for the same thread has `status: completed` with a `run.turn_limited` item or equivalent max-turn marker.

- [ ] **Step 3: Keep UI-visible text unchanged**

The thread should still show the user's message as `"继续"`. Only the model-facing `userMessage` should become the expanded continuation instruction.

- [ ] **Step 4: Run targeted tests**

Run:

```bash
bun test apps/sidecar/src/services/agent/agent-service.test.ts --filter "continue"
```

Expected: PASS.

## Chunk 5: Verification

### Task 5: Targeted Verification Only

**Files:**
- No new files unless a test helper was added.

- [ ] **Step 1: Run SDK targeted tests**

Run:

```bash
bun test packages/sdk/src/agent.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run sidecar runtime tests**

Run:

```bash
bun test apps/sidecar/src/services/agent-runtime/runner/lume-runner.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run agent-service continuation tests**

Run:

```bash
bun test apps/sidecar/src/services/agent/agent-service.test.ts --filter "continue"
```

Expected: PASS.

- [ ] **Step 4: Manual smoke if local model config is available**

Run a long enough local agent task to trigger max turns, click/send "继续", and verify the next assistant response continues the previous task instead of asking what to continue.

Record in final report:
- Changed files
- Simplifications made
- Remaining risks
- Tested commands

