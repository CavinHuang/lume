# Subagent Card Conversation Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each expanded Subagent card render the complete streaming conversation for its logical Run, including the dispatched task, assistant text, thinking, tools, results, and terminal state.

**Architecture:** Keep child events owned by the child thread, select only events whose physical runtime IDs belong to the logical coordinator Run, and feed them into the existing runtime message projector. Reuse `RuntimeEventContentBlock` so the card and opened child conversation share one message semantics implementation; retain only a lightweight collapsed summary in card-specific code.

**Tech Stack:** React 18, TypeScript, Jotai, Bun test, Lume RuntimeEvent projection, shadcn UI.

---

## File map and cleanup order

- Modify `apps/web/src/components/agent/subagent-run-projection.ts`: replace lossy text accumulation with logical-Run event selection and collapsed activity summary.
- Modify `apps/web/src/components/agent/subagent-run-projection.test.ts`: cover multi-message, thinking, tools, and multiple attempts.
- Modify `apps/web/src/components/agent/SubagentInlinePanel.tsx`: reuse the incremental projector and `RuntimeEventContentBlock`; remove duplicate Markdown-only renderers.
- Modify `apps/web/src/components/agent/SubagentInlinePanel.test.tsx`: assert the canonical embedded conversation surface.
- Modify `apps/web/src/components/agent/runtime-event-boundary.test.ts`: protect child ownership and embedded scrolling.

Cleanup occurs only after the replacement is green: delete `publicText`, `SubagentLiveOutput`, `SubagentResultCard`, and `SubagentMarkdown` after the full message renderer is wired. Do not change event storage, coordinator persistence, or main-thread projection.

### Task 1: Select every event belonging to one logical Run

**Files:**
- Modify: `apps/web/src/components/agent/subagent-run-projection.ts`
- Test: `apps/web/src/components/agent/subagent-run-projection.test.ts`

- [ ] **Step 1: Write failing lossless-selection tests**

Add tests equivalent to:

```ts
test('selects every physical attempt in original event order', () => {
  const events = [
    event('message.user.submitted', 'runtime-1', { text: 'bound task' }),
    event('assistant.thinking_delta', 'runtime-1', { delta: 'inspect' }),
    event('tool.started', 'runtime-1', { toolCallId: 'tool-1', toolName: 'Read' }),
    event('assistant.delta', 'runtime-2', { delta: 'final work' }),
    event('assistant.delta', 'other-runtime', { delta: 'exclude me' }),
  ] as LumeRuntimeEvent[]

  expect(selectSubagentRunEvents(events, {
    runId: 'logical-run',
    runtimeRunIds: ['runtime-1', 'runtime-2'],
  }).map((item) => item.id)).toEqual(['1', '2', '3', '4'])
})

test('falls back to logical runId for historical work', () => {
  expect(selectSubagentRunEvents(events, { runId: 'logical-run' }))
    .toEqual(events.filter((item) => item.runId === 'logical-run'))
})
```

Also test that a final text event followed by a tool event yields the tool as the collapsed latest activity without removing either event.

- [ ] **Step 2: Run the test and verify RED**

Run `bun test apps/web/src/components/agent/subagent-run-projection.test.ts`.

Expected: FAIL because the selector and activity summarizer do not exist and the old projector returns one `publicText` string.

- [ ] **Step 3: Implement the minimal selector**

```ts
export function selectSubagentRunEvents(
  events: LumeRuntimeEvent[],
  run: Pick<SubagentRun, 'runId' | 'runtimeRunIds'>,
): LumeRuntimeEvent[] {
  const ids = new Set(run.runtimeRunIds?.length ? run.runtimeRunIds : [run.runId])
  return events.filter((event) => ids.has(event.runId))
}

export interface SubagentRunActivitySummary {
  text?: string
  toolName?: string
  error?: string
}

export function summarizeSubagentRunActivity(
  events: LumeRuntimeEvent[],
): SubagentRunActivitySummary {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.type === 'run.failed') return { error: event.error.message }
    if (event.type === 'tool.failed') return { error: event.error.message, toolName: event.toolName }
    if (event.type === 'tool.started' || event.type === 'tool.completed') {
      return { toolName: event.toolName }
    }
    if (event.type === 'assistant.delta' || event.type === 'assistant.thinking_delta') {
      if (event.delta.trim()) return { text: event.delta.trim() }
    }
    if (event.type === 'assistant.final') {
      const text = event.blocks.map((block) => block.text).join('').trim()
      if (text) return { text }
    }
  }
  return {}
}
```

Do not create `RuntimeMessageView` here; the canonical projector remains the only message-semantics implementation.

- [ ] **Step 4: Run the Task 1 test and verify GREEN**

Expected: all selection tests pass and thinking/tool events remain present.

### Task 2: Render canonical messages inside the expanded card

**Files:**
- Modify: `apps/web/src/components/agent/SubagentInlinePanel.tsx`
- Test: `apps/web/src/components/agent/SubagentInlinePanel.test.tsx`

- [ ] **Step 1: Write failing reuse assertions**

Add source-boundary assertions:

```ts
expect(source).toContain('applyRuntimeEventsIncremental')
expect(source).toContain('RuntimeEventContentBlock')
expect(source).toContain('selectSubagentRunEvents')
expect(source).not.toContain('SubagentLiveOutput')
expect(source).not.toContain('publicText')
```

Remove the completed-result-card copy assertion once that component is deleted; retain avatar tests.

- [ ] **Step 2: Run the tests and verify RED**

Run `bun test apps/web/src/components/agent/SubagentInlinePanel.test.tsx apps/web/src/components/agent/runtime-event-boundary.test.ts`.

Expected: FAIL because the panel still uses a single Markdown string.

- [ ] **Step 3: Project the selected child events incrementally**

```ts
const projectionRef = useRef<ProjectionRef | null>(null)
const runEvents = useMemo(
  () => workRun ? selectSubagentRunEvents(childEvents, workRun) : [],
  [childEvents, workRun],
)
const runMessages = useMemo(() => {
  const projected = applyRuntimeEventsIncremental(runEvents, projectionRef.current)
  projectionRef.current = projected.ref
  return projected.messages
}, [runEvents])
```

- [ ] **Step 4: Render the complete ordered message list**

```tsx
{runMessages.map((message, index) => (
  <RuntimeEventContentBlock
    key={message.id}
    message={message}
    threadId={workRun.childThreadId}
    streaming={isRunning && index === runMessages.length - 1}
    onUserResizeStart={onUserResizeStart}
  />
))}
```

Keep task metadata above the conversation. Keep TaskReport and terminal error below it so neither replaces earlier content.

- [ ] **Step 5: Delete orphaned flat-rendering code**

Remove `publicText/finalOutput` plumbing, `SubagentLiveOutput`, `SubagentResultCard`, `SubagentMarkdown`, and their Markdown/copy/truncation imports. Feed the collapsed preview from `summarizeSubagentRunActivity(runEvents)`.

- [ ] **Step 6: Run the Task 2 tests and verify GREEN**

Expected: the panel tests pass and `RuntimeEventContentBlock` is the only expanded conversation renderer.

### Task 3: Keep streaming output visible without hijacking user scroll

**Files:**
- Modify: `apps/web/src/components/agent/SubagentInlinePanel.tsx`
- Test: `apps/web/src/components/agent/runtime-event-boundary.test.ts`

- [ ] **Step 1: Add a failing scrolling boundary test**

```ts
expect(subagentPanel).toContain('isNearScrollBottom')
expect(subagentPanel).toContain('shouldAutoScrollRef')
expect(subagentPanel).toContain('scrollHeight')
expect(subagentPanel).not.toContain('scrollTop = 0')
```

- [ ] **Step 2: Run the boundary test and verify RED**

Run `bun test apps/web/src/components/agent/runtime-event-boundary.test.ts`.

Expected: FAIL because expand currently scrolls to the top and does not track user position.

- [ ] **Step 3: Implement bounded stick-to-bottom behavior**

```ts
const shouldAutoScrollRef = useRef(true)

const handleConversationScroll = () => {
  const container = expandedContentRef.current
  if (container) shouldAutoScrollRef.current = isNearScrollBottom(container)
}

useLayoutEffect(() => {
  const container = expandedContentRef.current
  if (!expanded || !container || !shouldAutoScrollRef.current) return
  container.scrollTop = container.scrollHeight
}, [expanded, expandedContentMounted, runMessages])
```

Attach `onScroll={handleConversationScroll}`. Opening a running card initializes stick-to-bottom; upward user scrolling disables it until the user returns near the bottom.

- [ ] **Step 4: Run the Task 3 tests and verify GREEN**

Run `bun test apps/web/src/components/agent/runtime-event-boundary.test.ts apps/web/src/components/agent/SubagentInlinePanel.test.tsx`.

Expected: all tests pass.

### Task 4: Cross-layer regression and type verification

**Files:**
- Verify only.

- [ ] **Step 1: Run relevant Web regression tests**

```powershell
bun test apps/web/src/hooks/runtime-event-state.test.ts apps/web/src/components/agent/runtime-event-message-projection.test.ts apps/web/src/components/agent/subagent-run-projection.test.ts apps/web/src/components/agent/SubagentInlinePanel.test.tsx apps/web/src/components/agent/runtime-event-boundary.test.ts
```

Expected: all tests pass, including the boundary that child deltas never merge into the main assistant message.

- [ ] **Step 2: Run Web typecheck**

Run `bun run --filter @lume/web typecheck`.

Expected: exit code 0.

- [ ] **Step 3: Review scope and orphan removal**

Run `git diff --check` and inspect only the five files listed in this plan.

Expected: no whitespace errors; every changed line supports complete Subagent-card conversation rendering.

## Commit constraint

The current worktree already contains uncommitted in-scope changes in the same files. Do not create intermediate code commits that would accidentally absorb earlier user changes. Keep edits surgical and leave final staging/commit to the user unless the worktree becomes safely separable.
