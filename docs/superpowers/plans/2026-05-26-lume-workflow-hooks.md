# Lume Workflow Hooks Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the MVP workflow hook foundation for Lume: internal typed hook contributions, config-gated runtime execution, context append effects, permission decisions, and completion-time observe effects.

**Architecture:** Add a sidecar-native `workflow-hooks` service with typed events, effects, contribution registration, and service facades. Wire the MVP only into `run/context/permission` lifecycle points; keep SDK `HookRegistry`, prompt/tool/memory adapters, plugin-loaded hooks, notifications, and existing memory summary/archive writes out of MVP.

**Tech Stack:** TypeScript, Bun test runner, existing Lume sidecar runtime, memory-v2, trace recorder, runtime event emitter, `lume.yaml` config normalization.

---

## Current Worktree

Execute this plan in the isolated worktree:

```bash
cd /Users/cavinhuang/.config/superpowers/worktrees/Lume/codex-lume-workflow-hooks
```

The original worktree at `/Users/cavinhuang/workspace/projects/ai-projects/Lume` has unrelated uncommitted changes. Do not edit, reset, or stage files there.

## Spec Reference

- `docs/superpowers/specs/2026-05-25-lume-workflow-hooks-design.md`

## File Structure

- `packages/shared/src/types/lume-config.ts`: add `hooks.internal` config types.
- `apps/sidecar/src/services/system/lume-config-service.ts`: default, normalize, and merge `hooks.internal`.
- `apps/sidecar/src/services/system/lume-config-service.test.ts`: config default and workspace override tests.
- `apps/sidecar/src/services/workflow-hooks/hook-events.ts`: MVP event, selector, capability, contribution, and handler types.
- `apps/sidecar/src/services/workflow-hooks/hook-effects.ts`: effect types, effect envelopes, validation, permission merge, and context effect helpers.
- `apps/sidecar/src/services/workflow-hooks/hook-bus.ts`: contribution matching, ordered execution, short-circuiting, and error isolation.
- `apps/sidecar/src/services/workflow-hooks/hook-runtime.ts`: shared runtime interface, bus wrapper, and production runtime factory.
- `apps/sidecar/src/services/workflow-hooks/contributions.ts`: fixed Lume core contribution registry filtered by `hooks.internal`.
- `apps/sidecar/src/services/workflow-hooks/hook-services.ts`: facades over memory-v2, trace, runtime event diagnostics, and security evaluation.
- `apps/sidecar/src/services/workflow-hooks/core-memory-hooks.ts`: context recall and completion candidate handlers.
- `apps/sidecar/src/services/workflow-hooks/core-security-hooks.ts`: permission decision handler.
- `apps/sidecar/src/services/workflow-hooks/core-observability-hooks.ts`: diagnostic trace/runtime-event handlers.
- `apps/sidecar/src/services/workflow-hooks/hook-bus.test.ts`: core hook bus behavior.
- `apps/sidecar/src/services/workflow-hooks/hook-effects.test.ts`: effect validation and permission merge behavior.
- `apps/sidecar/src/services/workflow-hooks/core-hooks.test.ts`: core memory/security handler behavior with fake services.
- `apps/sidecar/src/services/agent-runtime/context/context-assembler.ts`: accept prepared workflow context blocks and assemble the final model message.
- `apps/sidecar/src/services/agent-runtime/context/context-assembler.test.ts`: prepared append context and disabled fallback behavior.
- `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts`: execute context hooks, pass prepared context into assembly, and apply observe effects.
- `apps/sidecar/src/services/agent-runtime/runtime-core/attempt.ts`: pass hook runtime into permission handling.
- `apps/sidecar/src/services/agent-runtime/runtime-core/attempt-hooks.test.ts`: permission decision integration around the existing gateway boundary.
- `apps/sidecar/src/services/agent-runtime/runner/run-observer.ts`: record hook trace effects as trace spans.
- `apps/sidecar/src/services/agent-runtime/runner/lume-runner.ts`: create runtime hook object, fire run start/complete/failure events, apply observe effects.
- `apps/sidecar/src/services/agent-runtime/runner/lume-runner.test.ts`: runner lifecycle hook tests.

## Cleanup Plan

- Keep SDK `HookRegistry` untouched.
- Keep existing `appendDaily`, `appendRunArchive`, and conversation summary behavior in `LumeRunner.complete`.
- Do not add web UI for hooks.
- Do not add plugin hook loading or shell command execution.
- Delete any unused helper introduced by this work before committing each chunk.

## Chunk 1: Config And Hook Bus Foundation

### Task 1: Add `hooks.internal` Config Support

**Files:**
- Modify: `packages/shared/src/types/lume-config.ts`
- Modify: `apps/sidecar/src/services/system/lume-config-service.ts`
- Modify: `apps/sidecar/src/services/system/lume-config-service.test.ts`

- [ ] **Step 1: Write failing config tests**

Add tests to `apps/sidecar/src/services/system/lume-config-service.test.ts`:

```ts
test("应默认启用内部 workflow hooks", () => {
  const effective = getEffectiveLumeConfig("default");

  expect(effective.hooks?.internal).toEqual({
    enabled: true,
    memory: true,
    security: true,
    observability: true
  });
});

test("应支持 hooks.internal 的 workspace 覆盖", () => {
  updateLumeConfigSection({
    source: "system",
    path: "hooks.internal",
    value: {
      enabled: true,
      memory: true,
      security: true,
      observability: false
    }
  });

  updateLumeConfigSection({
    source: "agent",
    workspaceSlug: "default",
    path: "hooks.internal",
    value: {
      memory: false,
      security: false
    }
  });

  const defaultEffective = getEffectiveLumeConfig("default");
  const anotherEffective = getEffectiveLumeConfig("another");

  expect(defaultEffective.hooks?.internal).toEqual({
    enabled: true,
    memory: false,
    security: false,
    observability: false
  });
  expect(anotherEffective.hooks?.internal).toEqual({
    enabled: true,
    memory: true,
    security: true,
    observability: false
  });
});
```

- [ ] **Step 2: Run config tests to verify RED**

Run:

```bash
rtk bun test apps/sidecar/src/services/system/lume-config-service.test.ts
```

Expected: FAIL because `effective.hooks` is undefined.

- [ ] **Step 3: Add shared config types**

In `packages/shared/src/types/lume-config.ts`, add:

```ts
export interface LumeConfigHooksInternalSection {
  enabled?: boolean
  memory?: boolean
  security?: boolean
  observability?: boolean
}

export interface LumeConfigHooksSection {
  internal?: LumeConfigHooksInternalSection
}
```

Add `hooks?: LumeConfigHooksSection` to `LumeConfigSectionSet`.

- [ ] **Step 4: Normalize and merge hook config**

In `apps/sidecar/src/services/system/lume-config-service.ts`, add:

```ts
const DEFAULT_INTERNAL_HOOKS = {
  enabled: true,
  memory: true,
  security: true,
  observability: true
} as const;

function normalizeHooksSection(value: unknown): NonNullable<LumeConfigSectionSet["hooks"]> {
  if (!isPlainObject(value)) return {};
  const internal = isPlainObject(value.internal) ? value.internal : {};
  return {
    internal: {
      ...(typeof internal.enabled === "boolean" ? { enabled: internal.enabled } : {}),
      ...(typeof internal.memory === "boolean" ? { memory: internal.memory } : {}),
      ...(typeof internal.security === "boolean" ? { security: internal.security } : {}),
      ...(typeof internal.observability === "boolean" ? { observability: internal.observability } : {})
    }
  };
}
```

Update default config, `normalizeSectionSet`, `normalizeLumeConfigFile`, and `getEffectiveLumeConfig` so effective config always resolves:

```ts
hooks: {
  internal: {
    ...DEFAULT_INTERNAL_HOOKS,
    ...(file.hooks?.internal ?? {}),
    ...(overlay?.hooks?.internal ?? {})
  }
}
```

- [ ] **Step 5: Run config tests to verify GREEN**

Run:

```bash
rtk bun test apps/sidecar/src/services/system/lume-config-service.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Chunk 1 Task 1**

```bash
rtk git add packages/shared/src/types/lume-config.ts apps/sidecar/src/services/system/lume-config-service.ts apps/sidecar/src/services/system/lume-config-service.test.ts
rtk git commit -m "🔧 chore(shared,sidecar): 添加内部 Hook 配置" \
  -m "为 lume.yaml 增加 hooks.internal 默认值、normalize 与 workspace 覆盖，后续 workflow hook runtime 只通过这些开关启停内部 handler。" \
  -m "Constraint: 不支持用户自定义 hook 顺序或外部 handler" \
  -m "Tested: bun test apps/sidecar/src/services/system/lume-config-service.test.ts"
```

### Task 2: Build Hook Event, Effect, And Bus Core

**Files:**
- Create: `apps/sidecar/src/services/workflow-hooks/hook-events.ts`
- Create: `apps/sidecar/src/services/workflow-hooks/hook-effects.ts`
- Create: `apps/sidecar/src/services/workflow-hooks/hook-bus.ts`
- Create: `apps/sidecar/src/services/workflow-hooks/hook-runtime.ts`
- Create: `apps/sidecar/src/services/workflow-hooks/hook-services.ts`
- Create: `apps/sidecar/src/services/workflow-hooks/hook-bus.test.ts`
- Create: `apps/sidecar/src/services/workflow-hooks/hook-effects.test.ts`

- [ ] **Step 1: Write failing effect tests**

Create `apps/sidecar/src/services/workflow-hooks/hook-effects.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  collectAppendContextEffects,
  resolvePermissionDecision
} from "./hook-effects";

describe("workflow hook effects", () => {
  test("collects append context effects with source envelopes", () => {
    const effects = collectAppendContextEffects([{
      effect: {
        type: "appendContext",
        source: "hook:test",
        content: "<context>hello</context>"
      },
      sourceContributionId: "test.context",
      createdAt: "2026-05-26T00:00:00.000Z"
    }]);

    expect(effects).toEqual([{
      sourceContributionId: "test.context",
      source: "hook:test",
      content: "<context>hello</context>",
      hidden: false,
      usedMemoryItems: []
    }]);
  });

  test("permission decision prefers deny over ask and allow", () => {
    const decision = resolvePermissionDecision([
      {
        effect: { type: "setPermissionDecision", decision: "allow", reason: "known safe" },
        sourceContributionId: "allow",
        createdAt: "2026-05-26T00:00:00.000Z"
      },
      {
        effect: { type: "setPermissionDecision", decision: "deny", reason: "private root" },
        sourceContributionId: "deny",
        createdAt: "2026-05-26T00:00:00.000Z"
      }
    ]);

    expect(decision).toEqual({
      decision: "deny",
      reason: "private root",
      sourceContributionId: "deny"
    });
  });
});
```

- [ ] **Step 2: Write failing bus tests**

Create `apps/sidecar/src/services/workflow-hooks/hook-bus.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { LumeWorkflowHookBus } from "./hook-bus";
import type { LumeWorkflowHookContribution, LumeWorkflowHookHandlerRegistry } from "./hook-events";

const baseEvent = {
  runId: "run-1",
  threadId: "thread-1",
  cwd: "/tmp/project",
  event: "permission.beforeDecision" as const,
  toolName: "Bash",
  toolInputSummary: "rm -rf private",
  gatewayDecision: "ask" as const
};

describe("LumeWorkflowHookBus", () => {
  test("runs matching contributions in declared order", async () => {
    const seen: string[] = [];
    const contributions: LumeWorkflowHookContribution[] = [
      { id: "first", pluginId: "lume-core", event: "permission.beforeDecision", phase: "decision", priority: "core", capabilities: ["permission.decide"], handlerRef: "first" },
      { id: "second", pluginId: "lume-core", event: "permission.beforeDecision", phase: "decision", priority: "core", capabilities: ["permission.decide"], handlerRef: "second" }
    ];
    const handlers: LumeWorkflowHookHandlerRegistry = {
      first: async () => {
        seen.push("first");
        return { effects: [] };
      },
      second: async () => {
        seen.push("second");
        return { effects: [] };
      }
    };

    await new LumeWorkflowHookBus({ contributions, handlers }).execute(baseEvent);

    expect(seen).toEqual(["first", "second"]);
  });

  test("short-circuits decision hooks on deny", async () => {
    const seen: string[] = [];
    const bus = new LumeWorkflowHookBus({
      contributions: [
        { id: "deny", pluginId: "lume-core", event: "permission.beforeDecision", phase: "decision", priority: "core", capabilities: ["permission.decide"], handlerRef: "deny" },
        { id: "late", pluginId: "lume-core", event: "permission.beforeDecision", phase: "decision", priority: "core", capabilities: ["permission.decide"], handlerRef: "late" }
      ],
      handlers: {
        deny: async () => {
          seen.push("deny");
          return { effects: [{ type: "setPermissionDecision", decision: "deny", reason: "blocked" }] };
        },
        late: async () => {
          seen.push("late");
          return { effects: [] };
        }
      }
    });

    const result = await bus.execute(baseEvent);

    expect(seen).toEqual(["deny"]);
    expect(result.errors).toEqual([]);
    expect(result.effects.map((item) => item.effect.type)).toEqual(["setPermissionDecision"]);
  });

  test("matches selector by tool name", async () => {
    const bus = new LumeWorkflowHookBus({
      contributions: [
        { id: "bash", pluginId: "lume-core", event: "permission.beforeDecision", selector: { toolName: "Bash" }, phase: "decision", priority: "core", capabilities: ["permission.decide"], handlerRef: "hit" },
        { id: "write", pluginId: "lume-core", event: "permission.beforeDecision", selector: { toolName: "Write" }, phase: "decision", priority: "core", capabilities: ["permission.decide"], handlerRef: "miss" }
      ],
      handlers: {
        hit: async () => ({ effects: [{ type: "setPermissionDecision", decision: "ask", reason: "review" }] }),
        miss: async () => ({ effects: [{ type: "setPermissionDecision", decision: "deny", reason: "wrong tool" }] })
      }
    });

    const result = await bus.execute(baseEvent);

    expect(result.effects).toHaveLength(1);
    expect(result.effects[0]?.sourceContributionId).toBe("bash");
  });

  test("isolates handler errors and continues observe handlers", async () => {
    const seen: string[] = [];
    const bus = new LumeWorkflowHookBus({
      contributions: [
        { id: "bad", pluginId: "lume-core", event: "context.afterAssemble", phase: "observe", priority: "core", capabilities: ["trace.write"], handlerRef: "bad" },
        { id: "good", pluginId: "lume-core", event: "context.afterAssemble", phase: "observe", priority: "core", capabilities: ["trace.write"], handlerRef: "good" }
      ],
      handlers: {
        bad: async () => {
          seen.push("bad");
          throw new Error("boom");
        },
        good: async () => {
          seen.push("good");
          return {
            effects: [{
              type: "recordTrace",
              record: {
                type: "workflow_hook",
                contributionId: "good",
                event: "context.afterAssemble",
                status: "success"
              }
            }]
          };
        }
      }
    });

    const result = await bus.execute({
      event: "context.afterAssemble",
      runId: "run-1",
      threadId: "thread-1",
      cwd: "/tmp/project",
      tokenBudget: 1000,
      availableTools: ["Read"],
      memoryContextUsedItems: [],
      userMessageForModelLength: 42
    });

    expect(seen).toEqual(["bad", "good"]);
    expect(result.errors).toEqual([{ contributionId: "bad", message: "boom" }]);
    expect(result.effects[0]?.sourceContributionId).toBe("good");
  });
});
```

- [ ] **Step 3: Run hook core tests to verify RED**

Run:

```bash
rtk bun test apps/sidecar/src/services/workflow-hooks/hook-effects.test.ts apps/sidecar/src/services/workflow-hooks/hook-bus.test.ts
```

Expected: FAIL because files and exports do not exist.

- [ ] **Step 4: Implement hook event and handler types**

Create `hook-events.ts` with the MVP event union, contribution types, and handler registry. Keep this file type-only except for simple helper constants. Do not put effect implementations or service facade DTOs here.

Implementation detail: the base event is an interface extended by event-specific payloads, but it is not a member of `LumeWorkflowHookEvent`. This keeps handlers from receiving a generic `event: LumeWorkflowHookEventName` payload that weakens event-specific type enforcement.

```ts
import type { MemoryV2RecallItem } from "../memory-v2/types";
import type { LumeWorkflowHookEffect } from "./hook-effects";
import type { LumeWorkflowHookHandlerContext } from "./hook-services";

export type LumeWorkflowHookEventName =
  | "run.beforeStart"
  | "run.afterComplete"
  | "run.afterFailure"
  | "context.beforeAssemble"
  | "context.afterAssemble"
  | "permission.beforeDecision";

export type LumeWorkflowHookCapability =
  | "context.append"
  | "permission.decide"
  | "memory.enqueue"
  | "runtime.emit"
  | "trace.write";

export interface LumeWorkflowHookSelector {
  toolName?: string | string[];
  permissionMode?: string | string[];
  threadType?: string | string[];
  chatType?: string | string[];
}

export interface LumeWorkflowHookContribution {
  id: string;
  pluginId?: string;
  event: LumeWorkflowHookEventName;
  selector?: LumeWorkflowHookSelector;
  phase: "decision" | "observe";
  priority: "core" | "normal" | "late";
  capabilities: LumeWorkflowHookCapability[];
  handlerRef: string;
}

export interface LumeWorkflowHookBaseEvent {
  event: LumeWorkflowHookEventName;
  runId: string;
  threadId: string;
  workspaceId?: string;
  workspaceSlug?: string;
  cwd: string;
  permissionMode?: string;
  threadType?: string;
  chatType?: string;
  messageMetadata?: Record<string, unknown>;
}

export interface LumeWorkflowContextBeforeAssembleEvent extends LumeWorkflowHookBaseEvent {
  event: "context.beforeAssemble";
  userMessage: string;
  availableTools: string[];
  tokenBudget: number;
}

export interface LumeWorkflowContextAfterAssembleEvent extends LumeWorkflowHookBaseEvent {
  event: "context.afterAssemble";
  availableTools: string[];
  tokenBudget: number;
  memoryContextUsedItems: MemoryV2RecallItem[];
  userMessageForModelLength: number;
}

export interface LumeWorkflowRunBeforeStartEvent extends LumeWorkflowHookBaseEvent {
  event: "run.beforeStart";
  userMessage: string;
}

export interface LumeWorkflowRunAfterCompleteEvent extends LumeWorkflowHookBaseEvent {
  event: "run.afterComplete";
  userMessage: string;
  runStateSummary: {
    status: string;
    generatedItemCount: number;
    pendingInterruptionCount: number;
  };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUSD?: number;
  };
  memoryContextUsedItems: MemoryV2RecallItem[];
}

export interface LumeWorkflowRunAfterFailureEvent extends LumeWorkflowHookBaseEvent {
  event: "run.afterFailure";
  userMessage: string;
  errorMessage: string;
}

export interface LumeWorkflowPermissionBeforeDecisionEvent extends LumeWorkflowHookBaseEvent {
  event: "permission.beforeDecision";
  toolName: string;
  toolInputSummary: string;
  gatewayDecision: "allow" | "ask";
  risk?: string;
  reasonCode?: string;
}

export type LumeWorkflowHookEvent =
  | LumeWorkflowRunBeforeStartEvent
  | LumeWorkflowRunAfterCompleteEvent
  | LumeWorkflowRunAfterFailureEvent
  | LumeWorkflowContextBeforeAssembleEvent
  | LumeWorkflowContextAfterAssembleEvent
  | LumeWorkflowPermissionBeforeDecisionEvent;
```

Create handler result types in the same file, importing the effect union from `hook-effects.ts`:

```ts
export interface LumeWorkflowHookHandlerResult {
  effects: LumeWorkflowHookEffect[];
}

export type LumeWorkflowHookHandler = (
  event: LumeWorkflowHookEvent,
  context: LumeWorkflowHookHandlerContext
) => Promise<LumeWorkflowHookHandlerResult>;

export type LumeWorkflowHookHandlerRegistry = Record<string, LumeWorkflowHookHandler>;
```

Create the minimal `hook-services.ts` context shape used by the bus. Task 3 fills in the real facade factories.

```ts
import type { MemoryV2Candidate, MemoryV2RecallItem } from "../memory-v2/types";
import type { LumeWorkflowHookEventName } from "./hook-events";
import type { LumeWorkflowRuntimeEventDraft, LumeWorkflowTraceRecord } from "./hook-effects";

export interface LumeWorkflowMemoryRecallResult {
  prefix: string;
  items: MemoryV2RecallItem[];
  userMessageForModel: string;
}

export interface LumeWorkflowMemoryService {
  recallContext(input: {
    threadId: string;
    workspaceSlug?: string;
    userMessage: string;
    tokenBudget: number;
  }): Promise<LumeWorkflowMemoryRecallResult>;
  extractCandidates(input: {
    runId: string;
    threadId: string;
    workspaceSlug?: string;
    userMessage: string;
  }): Promise<MemoryV2Candidate[]>;
}

export interface LumeWorkflowSecurityService {
  evaluatePermissionDecision(input: {
    toolName: string;
    toolInputSummary: string;
    permissionMode?: string;
    gatewayDecision: "allow" | "ask";
    risk?: string;
    reasonCode?: string;
  }): Promise<{ decision?: "allow" | "ask" | "deny"; reason?: string }>;
}

export interface LumeWorkflowRuntimeEventService {
  buildDiagnosticEvent(input: {
    runId: string;
    threadId: string;
    contributionId: string;
    message: string;
    level: "debug" | "info" | "warning" | "error";
  }): LumeWorkflowRuntimeEventDraft;
}

export interface LumeWorkflowTraceService {
  buildHookTrace(input: {
    contributionId: string;
    event: LumeWorkflowHookEventName;
    status: "success" | "error" | "skipped";
    elapsedMs?: number;
    effectTypes?: string[];
    errorMessage?: string;
  }): LumeWorkflowTraceRecord;
}

export interface LumeWorkflowHookHandlerContext {
  services: LumeWorkflowHookServices;
}

export interface LumeWorkflowHookServices {
  memory: LumeWorkflowMemoryService;
  security: LumeWorkflowSecurityService;
  runtimeEvents: LumeWorkflowRuntimeEventService;
  trace: LumeWorkflowTraceService;
  clock: { now(): Date };
}
```

- [ ] **Step 5: Implement effect types and helpers**

Create `hook-effects.ts` with the spec-required effect types, result envelopes, validation, context collection, and permission merge helpers.

Implementation detail: `AppendContextEffect` keeps the spec-required fields and adds optional `usedMemoryItems` / `userMessageForModel` so existing memory citations survive when memory recall moves behind `appendContext`.

```ts
import type { MemoryV2Candidate, MemoryV2RecallItem } from "../memory-v2/types";

export interface AppendContextEffect {
  type: "appendContext";
  content: string;
  source: string;
  priority?: "early" | "normal" | "late";
  hidden?: boolean;
  usedMemoryItems?: MemoryV2RecallItem[];
  userMessageForModel?: string;
}

export interface SetPermissionDecisionEffect {
  type: "setPermissionDecision";
  decision: "allow" | "ask" | "deny";
  reason: string;
}

export interface LumeWorkflowRuntimeEventDraft {
  type: "workflow_hook.diagnostic";
  runId: string;
  threadId: string;
  contributionId: string;
  message: string;
  level: "debug" | "info" | "warning" | "error";
}

export interface EmitRuntimeEventEffect {
  type: "emitRuntimeEvent";
  event: LumeWorkflowRuntimeEventDraft;
}

export interface LumeWorkflowTraceRecord {
  type: "workflow_hook";
  contributionId: string;
  event: LumeWorkflowHookEventName;
  status: "success" | "error" | "skipped";
  elapsedMs?: number;
  effectTypes?: string[];
  errorMessage?: string;
}

export interface RecordTraceEffect {
  type: "recordTrace";
  record: LumeWorkflowTraceRecord;
}

export interface EnqueueMemoryCandidateEffect {
  type: "enqueueMemoryCandidate";
  candidates: MemoryV2Candidate[];
}

export type LumeWorkflowHookEffect =
  | AppendContextEffect
  | SetPermissionDecisionEffect
  | EmitRuntimeEventEffect
  | RecordTraceEffect
  | EnqueueMemoryCandidateEffect;

export interface LumeWorkflowHookEffectEnvelope {
  effect: LumeWorkflowHookEffect;
  sourceContributionId: string;
  pluginId?: string;
  createdAt: string;
}

export interface LumeWorkflowHookExecutionError {
  contributionId: string;
  message: string;
}

export interface LumeWorkflowHookExecutionResult {
  effects: LumeWorkflowHookEffectEnvelope[];
  errors: LumeWorkflowHookExecutionError[];
}
```

Then add the helper implementations:

```ts
export function collectAppendContextEffects(envelopes: LumeWorkflowHookEffectEnvelope[]) {
  return envelopes
    .filter((envelope) => envelope.effect.type === "appendContext")
    .map((envelope) => ({
      sourceContributionId: envelope.sourceContributionId,
      source: envelope.effect.source,
      content: envelope.effect.content,
      hidden: envelope.effect.hidden === true,
      usedMemoryItems: envelope.effect.usedMemoryItems ?? [],
      userMessageForModel: envelope.effect.userMessageForModel
    }));
}

export function resolvePermissionDecision(envelopes: LumeWorkflowHookEffectEnvelope[]) {
  const decisions = envelopes.filter((envelope) => envelope.effect.type === "setPermissionDecision");
  return decisions.find((item) => item.effect.decision === "deny")
    ?? decisions.find((item) => item.effect.decision === "ask")
    ?? decisions.find((item) => item.effect.decision === "allow")
    ?? null;
}
```

Return a normalized shape from `resolvePermissionDecision` as expected by the test.

- [ ] **Step 6: Implement hook bus**

Create `hook-bus.ts`:

```ts
export class LumeWorkflowHookBus {
  constructor(private readonly input: {
    contributions: LumeWorkflowHookContribution[];
    handlers: LumeWorkflowHookHandlerRegistry;
    context?: LumeWorkflowHookHandlerContext;
    now?: () => Date;
  }) {}

  async execute(event: LumeWorkflowHookEvent): Promise<LumeWorkflowHookExecutionResult> {
    const effects: LumeWorkflowHookEffectEnvelope[] = [];
    const errors: LumeWorkflowHookExecutionError[] = [];
    for (const contribution of this.input.contributions) {
      if (!matchesContribution(contribution, event)) continue;
      const handler = this.input.handlers[contribution.handlerRef];
      if (!handler) {
        errors.push({ contributionId: contribution.id, message: "Handler not found." });
        continue;
      }
      try {
        const result = await handler(event, this.input.context ?? createNoopHookContext());
        for (const effect of result.effects) {
          effects.push({
            effect,
            sourceContributionId: contribution.id,
            pluginId: contribution.pluginId,
            createdAt: (this.input.now?.() ?? new Date()).toISOString()
          });
        }
        if (contribution.phase === "decision" && result.effects.some((effect) =>
          effect.type === "setPermissionDecision" && effect.decision === "deny"
        )) {
          break;
        }
      } catch (error) {
        errors.push({
          contributionId: contribution.id,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return { effects, errors };
  }
}
```

Selectors must match `toolName`, `permissionMode`, `threadType`, and `chatType` when present.

- [ ] **Step 7: Implement the shared hook runtime wrapper**

Create `hook-runtime.ts` with the shared runtime interface and bus wrapper used by runtime-core integration tasks. Do not add the production factory here; Task 3 adds it after core contributions and handlers exist.

```ts
import type { LumeWorkflowHookEvent } from "./hook-events";
import type { LumeWorkflowHookExecutionResult } from "./hook-effects";
import type { LumeWorkflowHookBus } from "./hook-bus";

export interface LumeWorkflowHookRuntimeLike {
  execute(event: LumeWorkflowHookEvent): Promise<LumeWorkflowHookExecutionResult>;
}

export class LumeWorkflowHookRuntime implements LumeWorkflowHookRuntimeLike {
  constructor(private readonly bus: LumeWorkflowHookBus) {}

  execute(event: LumeWorkflowHookEvent): Promise<LumeWorkflowHookExecutionResult> {
    return this.bus.execute(event);
  }
}
```

- [ ] **Step 8: Run hook core tests to verify GREEN**

Run:

```bash
rtk bun test apps/sidecar/src/services/workflow-hooks/hook-effects.test.ts apps/sidecar/src/services/workflow-hooks/hook-bus.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit Chunk 1 Task 2**

```bash
rtk git add apps/sidecar/src/services/workflow-hooks/hook-events.ts apps/sidecar/src/services/workflow-hooks/hook-effects.ts apps/sidecar/src/services/workflow-hooks/hook-bus.ts apps/sidecar/src/services/workflow-hooks/hook-runtime.ts apps/sidecar/src/services/workflow-hooks/hook-services.ts apps/sidecar/src/services/workflow-hooks/hook-bus.test.ts apps/sidecar/src/services/workflow-hooks/hook-effects.test.ts
rtk git commit -m "✨ feat(sidecar): 添加工作流 Hook 总线" \
  -m "新增 LumeWorkflowHookBus、MVP 事件/effect 类型、runtime wrapper 与 decision 合并规则，为 runtime/context/permission 接入提供内部 typed hook 基础。" \
  -m "Constraint: handler 只返回受控 effect，不执行外部脚本" \
  -m "Tested: bun test apps/sidecar/src/services/workflow-hooks/hook-effects.test.ts apps/sidecar/src/services/workflow-hooks/hook-bus.test.ts"
```

## Chunk 2: Core Contributions And Service Facades

### Task 3: Add Core Contributions And Service Facades

**Files:**
- Create: `apps/sidecar/src/services/workflow-hooks/contributions.ts`
- Modify: `apps/sidecar/src/services/workflow-hooks/hook-services.ts`
- Modify: `apps/sidecar/src/services/workflow-hooks/hook-runtime.ts`
- Create: `apps/sidecar/src/services/workflow-hooks/core-memory-hooks.ts`
- Create: `apps/sidecar/src/services/workflow-hooks/core-security-hooks.ts`
- Create: `apps/sidecar/src/services/workflow-hooks/core-observability-hooks.ts`
- Create: `apps/sidecar/src/services/workflow-hooks/core-hooks.test.ts`

- [ ] **Step 1: Write failing core handler tests**

Create `core-hooks.test.ts` with fake services:

```ts
import { describe, expect, test } from "bun:test";
import { createCoreMemoryHookHandlers } from "./core-memory-hooks";
import { createCoreObservabilityHookHandlers } from "./core-observability-hooks";
import { createCoreSecurityHookHandlers } from "./core-security-hooks";
import { createCoreWorkflowHookContributions } from "./contributions";
import { createMemoryWorkflowHookService } from "./hook-services";

describe("core workflow hooks", () => {
  test("filters contributions by internal module config", () => {
    const contributions = createCoreWorkflowHookContributions({
      enabled: true,
      memory: false,
      security: true,
      observability: false
    });

    expect(contributions.map((item) => item.id)).toEqual(["core.security.permission"]);
  });

  test("memory context handler returns appendContext with recall items", async () => {
    const handlers = createCoreMemoryHookHandlers();
    const result = await handlers["core.memory.context"]!({
      event: "context.beforeAssemble",
      runId: "run-1",
      threadId: "thread-1",
      cwd: "/tmp/project",
      workspaceSlug: "demo",
      userMessage: "hello",
      availableTools: ["Read"],
      tokenBudget: 1000
    }, {
      services: {
        memory: {
          recallContext: async () => ({
            prefix: "<lume_memory_context>hello</lume_memory_context>",
            userMessageForModel: "<lume_memory_context>hello</lume_memory_context>\n<user_message>\nhello\n</user_message>",
            items: [{ id: "mem-1", kind: "preference", scope: "global", status: "active", statement: "hello", path: "memory.md", citation: "memory.md", reason: "test", score: 1 }]
          }),
          extractCandidates: async () => []
        },
        security: { evaluatePermissionDecision: async () => ({}) },
        runtimeEvents: { buildDiagnosticEvent: (input) => ({ type: "workflow_hook.diagnostic", ...input }) },
        trace: { buildHookTrace: (input) => ({ type: "workflow_hook", ...input }) },
        clock: { now: () => new Date("2026-05-26T00:00:00.000Z") }
      }
    } as any);

    expect(result.effects[0]).toMatchObject({
      type: "appendContext",
      source: "hook:core-memory-recall",
      content: "<lume_memory_context>hello</lume_memory_context>"
    });
  });

  test("memory completion handler returns enqueueMemoryCandidate", async () => {
    const handlers = createCoreMemoryHookHandlers();
    const result = await handlers["core.memory.completion"]!({
      event: "run.afterComplete",
      runId: "run-1",
      threadId: "thread-1",
      cwd: "/tmp/project",
      workspaceSlug: "demo",
      userMessage: "I prefer concise summaries.",
      runStateSummary: { status: "completed", generatedItemCount: 2, pendingInterruptionCount: 0 },
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      memoryContextUsedItems: []
    }, {
      services: {
        memory: {
          recallContext: async () => ({ prefix: "", userMessageForModel: "", items: [] }),
          extractCandidates: async () => [{
            kind: "preference",
            targetScope: "global",
            statement: "User prefers concise summaries.",
            confidence: "medium",
            evidence: { runId: "run-1", sourceMessages: ["I prefer concise summaries."] }
          }]
        },
        security: { evaluatePermissionDecision: async () => ({}) },
        runtimeEvents: { buildDiagnosticEvent: (input) => ({ type: "workflow_hook.diagnostic", ...input }) },
        trace: { buildHookTrace: (input) => ({ type: "workflow_hook", ...input }) },
        clock: { now: () => new Date("2026-05-26T00:00:00.000Z") }
      }
    } as any);

    expect(result.effects).toEqual([{
      type: "enqueueMemoryCandidate",
      candidates: [{
        kind: "preference",
        targetScope: "global",
        statement: "User prefers concise summaries.",
        confidence: "medium",
        evidence: { runId: "run-1", sourceMessages: ["I prefer concise summaries."] }
      }]
    }]);
  });

  test("security handler returns permission decision effect", async () => {
    const handlers = createCoreSecurityHookHandlers();
    const calls: unknown[] = [];
    const result = await handlers["core.security.permission"]!({
      event: "permission.beforeDecision",
      runId: "run-1",
      threadId: "thread-1",
      cwd: "/tmp/project",
      permissionMode: "plan",
      toolName: "Bash",
      toolInputSummary: "rm -rf .lume",
      gatewayDecision: "ask",
      risk: "private-root",
      reasonCode: "private_root"
    }, {
      services: {
        memory: { recallContext: async () => ({ prefix: "", userMessageForModel: "", items: [] }), extractCandidates: async () => [] },
        security: {
          evaluatePermissionDecision: async (input) => {
            calls.push(input);
            return { decision: "deny", reason: "Private root." };
          }
        },
        runtimeEvents: { buildDiagnosticEvent: (input) => ({ type: "workflow_hook.diagnostic", ...input }) },
        trace: { buildHookTrace: (input) => ({ type: "workflow_hook", ...input }) },
        clock: { now: () => new Date("2026-05-26T00:00:00.000Z") }
      }
    } as any);

    expect(calls).toEqual([{
      toolName: "Bash",
      toolInputSummary: "rm -rf .lume",
      permissionMode: "plan",
      gatewayDecision: "ask",
      risk: "private-root",
      reasonCode: "private_root"
    }]);
    expect(result.effects).toEqual([{ type: "setPermissionDecision", decision: "deny", reason: "Private root." }]);
  });

  test("observability handler returns recordTrace effect", async () => {
    const handlers = createCoreObservabilityHookHandlers();
    const result = await handlers["core.observability.trace"]!({
      event: "context.afterAssemble",
      runId: "run-1",
      threadId: "thread-1",
      cwd: "/tmp/project",
      availableTools: ["Read"],
      tokenBudget: 1000,
      memoryContextUsedItems: [{ id: "mem-1", kind: "preference", scope: "global", status: "active", statement: "hello", path: "memory.md", citation: "memory.md", reason: "test", score: 1 }],
      userMessageForModelLength: 42
    }, {
      services: {
        memory: { recallContext: async () => ({ prefix: "", userMessageForModel: "", items: [] }), extractCandidates: async () => [] },
        security: { evaluatePermissionDecision: async () => ({}) },
        runtimeEvents: { buildDiagnosticEvent: (input) => ({ type: "workflow_hook.diagnostic", ...input }) },
        trace: { buildHookTrace: (input) => ({ type: "workflow_hook", ...input }) },
        clock: { now: () => new Date("2026-05-26T00:00:00.000Z") }
      }
    } as any);

    expect(result.effects).toEqual([{
      type: "recordTrace",
      record: {
        type: "workflow_hook",
        contributionId: "core.observability.trace",
        event: "context.afterAssemble",
        status: "success",
        effectTypes: ["recordTrace"]
      }
    }]);
  });

  test("memory facade preserves main session type and maxItems", async () => {
    const calls: unknown[] = [];
    const service = createMemoryWorkflowHookService({
      buildUserMessageContext: async (input) => {
        calls.push(input);
        return { prefix: "", userMessageForModel: input.userMessage, items: [] };
      },
      extractCandidates: async () => []
    });

    await service.recallContext({
      threadId: "thread-1",
      workspaceSlug: "demo",
      userMessage: "hello",
      tokenBudget: 1000
    });

    expect(calls).toEqual([{
      workspaceSlug: "demo",
      userMessage: "hello",
      sessionType: "main",
      maxItems: 8
    }]);
  });
});
```

- [ ] **Step 2: Run core handler tests to verify RED**

Run:

```bash
rtk bun test apps/sidecar/src/services/workflow-hooks/core-hooks.test.ts
```

Expected: FAIL because core files do not exist.

- [ ] **Step 3: Implement fixed contribution registry**

Create `contributions.ts`. Filter by `hooks.internal`:

```ts
export function createCoreWorkflowHookContributions(config: {
  enabled?: boolean;
  memory?: boolean;
  security?: boolean;
  observability?: boolean;
}): LumeWorkflowHookContribution[] {
  if (config.enabled === false) return [];
  return [
    ...(config.memory === false ? [] : [
      { id: "core.memory.context", pluginId: "lume-core", event: "context.beforeAssemble", phase: "decision", priority: "core", capabilities: ["context.append"], handlerRef: "core.memory.context" },
      { id: "core.memory.completion", pluginId: "lume-core", event: "run.afterComplete", phase: "observe", priority: "core", capabilities: ["memory.enqueue"], handlerRef: "core.memory.completion" }
    ] satisfies LumeWorkflowHookContribution[]),
    ...(config.security === false ? [] : [
      { id: "core.security.permission", pluginId: "lume-core", event: "permission.beforeDecision", phase: "decision", priority: "core", capabilities: ["permission.decide"], handlerRef: "core.security.permission" }
    ] satisfies LumeWorkflowHookContribution[]),
    ...(config.observability === false ? [] : [
      { id: "core.observability.trace", pluginId: "lume-core", event: "context.afterAssemble", phase: "observe", priority: "core", capabilities: ["trace.write"], handlerRef: "core.observability.trace" }
    ] satisfies LumeWorkflowHookContribution[])
  ];
}
```

- [ ] **Step 4: Implement service facades**

Create `hook-services.ts`:

- `createMemoryWorkflowHookService()` wraps `buildMemoryV2UserMessageContext`, `extractMemoryCandidatesWithLlm`, and returns DTOs with `prefix`, `items`, `userMessageForModel`.
- The memory facade must call `buildMemoryV2UserMessageContext({ workspaceSlug, userMessage, sessionType: "main", maxItems: 8 })` to preserve the current recall behavior.
- Accept optional injected `buildUserMessageContext` and `extractCandidates` functions for unit tests; default to the real memory-v2 functions in production.
- `createSecurityWorkflowHookService()` returns no decision for MVP unless future rules are added; it should still allow tests to inject a fake service.
- `createRuntimeEventWorkflowHookService()` builds `workflow_hook.diagnostic` drafts.
- `createTraceWorkflowHookService()` builds `workflow_hook` trace records.

Keep facade methods side-effect free. Actual writes happen through effect application.

- [ ] **Step 5: Implement core handlers**

Create memory/security/observability handler factories:

```ts
export function createCoreMemoryHookHandlers(): LumeWorkflowHookHandlerRegistry {
  return {
    "core.memory.context": async (event, context) => {
      if (event.event !== "context.beforeAssemble" || !event.workspaceSlug || !event.userMessage.trim()) {
        return { effects: [] };
      }
      const recalled = await context.services.memory.recallContext({
        threadId: event.threadId,
        workspaceSlug: event.workspaceSlug,
        userMessage: event.userMessage,
        tokenBudget: event.tokenBudget
      });
      if (!recalled.prefix) return { effects: [] };
      return {
        effects: [{
          type: "appendContext",
          source: "hook:core-memory-recall",
          content: recalled.prefix,
          hidden: true,
          usedMemoryItems: recalled.items,
          userMessageForModel: recalled.userMessageForModel
        }]
      };
    },
    "core.memory.completion": async (event, context) => {
      if (event.event !== "run.afterComplete" || !("userMessage" in event) || typeof event.userMessage !== "string") {
        return { effects: [] };
      }
      const candidates = await context.services.memory.extractCandidates({
        runId: event.runId,
        threadId: event.threadId,
        workspaceSlug: event.workspaceSlug,
        userMessage: event.userMessage
      });
      return candidates.length > 0 ? { effects: [{ type: "enqueueMemoryCandidate", candidates }] } : { effects: [] };
    }
  };
}
```

Security handler returns a `setPermissionDecision` effect only when facade returns a decision. It must pass through the event fields used by the spec:

```ts
const decision = await context.services.security.evaluatePermissionDecision({
  toolName: event.toolName,
  toolInputSummary: event.toolInputSummary,
  permissionMode: event.permissionMode,
  gatewayDecision: event.gatewayDecision,
  risk: event.risk,
  reasonCode: event.reasonCode
});
```

Observability handler `core.observability.trace` must handle `context.afterAssemble` by returning:

```ts
{
  effects: [{
    type: "recordTrace",
    record: context.services.trace.buildHookTrace({
      contributionId: "core.observability.trace",
      event: event.event,
      status: "success",
      effectTypes: ["recordTrace"]
    })
  }]
}
```

- [ ] **Step 6: Add the production runtime factory**

Update `hook-runtime.ts` to add the production factory after core contributions and handlers exist:

```ts
export function createLumeWorkflowHookRuntime(input: {
  config: NonNullable<LumeEffectiveConfig["hooks"]>["internal"];
  services: LumeWorkflowHookHandlerContext["services"];
}): LumeWorkflowHookRuntime {
  const contributions = createCoreWorkflowHookContributions(input.config ?? {});
  return new LumeWorkflowHookRuntime(new LumeWorkflowHookBus({
    contributions,
    handlers: {
      ...createCoreMemoryHookHandlers(),
      ...createCoreSecurityHookHandlers(),
      ...createCoreObservabilityHookHandlers()
    },
    context: { services: input.services }
  }));
}
```

- [ ] **Step 7: Run core handler tests to verify GREEN**

Run:

```bash
rtk bun test apps/sidecar/src/services/workflow-hooks/core-hooks.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Chunk 2 Task 3**

```bash
rtk git add apps/sidecar/src/services/workflow-hooks/contributions.ts apps/sidecar/src/services/workflow-hooks/hook-services.ts apps/sidecar/src/services/workflow-hooks/hook-runtime.ts apps/sidecar/src/services/workflow-hooks/core-memory-hooks.ts apps/sidecar/src/services/workflow-hooks/core-security-hooks.ts apps/sidecar/src/services/workflow-hooks/core-observability-hooks.ts apps/sidecar/src/services/workflow-hooks/core-hooks.test.ts
rtk git commit -m "✨ feat(sidecar): 注册内部 Hook 贡献" \
  -m "添加 Lume core memory/security/observability contributions、service facade 与 runtime factory，保持 handler 只返回受控 effect。" \
  -m "Constraint: contribution 顺序由代码固定，不读取第三方 hook 配置" \
  -m "Tested: bun test apps/sidecar/src/services/workflow-hooks/core-hooks.test.ts"
```

## Chunk 3: Runtime Context And Permission Integration

### Task 4: Let ContextAssembler Consume Prepared Hook Context

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/context/context-assembler.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/context/context-assembler.test.ts`

- [ ] **Step 1: Write failing context tests**

Add to `context-assembler.test.ts`:

```ts
test("uses prepared workflow context as model-facing memory context", async () => {
  const result = await new ContextAssembler().assemble({
    threadId: "thread-hooks",
    runId: "run-hooks",
    userMessage: "remember me",
    workspaceSlug: "demo",
    resolvedModelId: "gpt-5.4-mini",
    availableTools: ["Read"],
    tokenBudget: 1000,
    workflowContext: {
      appendContext: [{
        sourceContributionId: "core.memory.context",
        source: "hook:core-memory-recall",
        content: "<lume_memory_context>\nremembered\n</lume_memory_context>",
        hidden: true,
        usedMemoryItems: [{
          id: "mem-1",
          kind: "preference",
          scope: "global",
          status: "active",
          statement: "remembered",
          path: "memory.md",
          citation: "memory.md",
          reason: "test",
          score: 1
        }],
        userMessageForModel: "<lume_memory_context>\nremembered\n</lume_memory_context>\n<user_message>\nremember me\n</user_message>"
      }]
    }
  });

  expect(result.memoryContext).toContain("remembered");
  expect(result.userMessageForModel).toContain("<user_message>");
  expect(result.memoryContextUsedItems.map((item) => item.id)).toEqual(["mem-1"]);
});
```

- [ ] **Step 2: Run context test to verify RED**

Run:

```bash
rtk bun test apps/sidecar/src/services/agent-runtime/context/context-assembler.test.ts
```

Expected: FAIL because `workflowContext` is not accepted.

- [ ] **Step 3: Add prepared workflow context input**

In `context-assembler.ts`, add:

```ts
import type { MemoryV2RecallItem } from "../../memory-v2/types";

interface WorkflowAppendContextBlock {
  sourceContributionId: string;
  source: string;
  content: string;
  hidden: boolean;
  usedMemoryItems: MemoryV2RecallItem[];
  userMessageForModel?: string;
}

interface WorkflowContextInput {
  appendContext: WorkflowAppendContextBlock[];
}
```

Add `workflowContext?: WorkflowContextInput` to `ContextAssemblyInput`.

- [ ] **Step 4: Apply prepared append context blocks**

Inside `assembleWithoutContextSpan`, before existing inline memory retrieval, use prepared blocks only. `ContextAssembler` must not call `workflowHooks.execute` directly.

```ts
const workflowAppendContext = input.workflowContext?.appendContext ?? [];
if (workflowAppendContext.length > 0) {
  const prefix = workflowAppendContext.map((block) => block.content).join("\n\n");
  memoryContext = {
    prefix,
    items: workflowAppendContext.flatMap((block) => block.usedMemoryItems),
    userMessageForModel: workflowAppendContext.find((block) => block.userMessageForModel)?.userMessageForModel
      ?? `${prefix}\n<user_message>\n${input.userMessage}\n</user_message>`
  };
}
```

Then wrap the current inline `buildMemoryV2UserMessageContext` block in:

```ts
} else if (input.workspaceSlug && input.userMessage.trim()) {
  // existing buildMemoryV2UserMessageContext path stays here unchanged
}
```

If `workflowContext.appendContext` has blocks, skip the old inline `buildMemoryV2UserMessageContext` path. If `workflowContext` is absent or has no blocks, keep the current inline behavior exactly.

- [ ] **Step 5: Run context tests to verify GREEN**

Run:

```bash
rtk bun test apps/sidecar/src/services/agent-runtime/context/context-assembler.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

```bash
rtk git add apps/sidecar/src/services/agent-runtime/context/context-assembler.ts apps/sidecar/src/services/agent-runtime/context/context-assembler.test.ts
rtk git commit -m "✨ feat(sidecar): 支持预处理 Hook 上下文" \
  -m "ContextAssembler 接收 runtime-core 准备好的 appendContext block，并保留 used memory items 与模型消息格式。" \
  -m "Constraint: ContextAssembler 不直接执行 hook；未提供 prepared context 时保持原有 memory recall 路径" \
  -m "Tested: bun test apps/sidecar/src/services/agent-runtime/context/context-assembler.test.ts"
```

### Task 5: Wire Runtime Session Creation To Hook Runtime

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts`
- Test: `apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts`

- [ ] **Step 1: Write failing runtime session test**

Add tests to `run.test.ts` using the existing `createRuntimeCoreSession` test setup:

```ts
function createHookRuntimeSessionInput(overrides: Partial<CreateRuntimeCoreSessionInput> = {}): CreateRuntimeCoreSessionInput {
  const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-core-hooks-"));
  const agentDir = join(cwd, ".runtime-core-test");
  mkdirSync(agentDir, { recursive: true });
  return {
    lumeSessionId: "test-session-hooks",
    cwd,
    agentDir,
    userMessage: "hello",
    provider: "anthropic",
    resolvedModelId: "claude-sonnet-4-5",
    apiKey: "test-key",
    permissionMode: "plan",
    ...overrides
  };
}

test("executes context hooks around context assembly", async () => {
  const seen: string[] = [];
  const applied: string[] = [];
  const result = await createRuntimeCoreSession({
    ...createHookRuntimeSessionInput(),
    runId: "run-hooks",
    workflowHooks: {
      execute: async (event) => {
        seen.push(event.event);
        if (event.event === "context.beforeAssemble") {
          return {
            effects: [{
              effect: {
                type: "appendContext",
                source: "hook:core-memory-recall",
                content: "<lume_memory_context>\nremembered\n</lume_memory_context>",
                hidden: true,
                usedMemoryItems: [],
                userMessageForModel: "<lume_memory_context>\nremembered\n</lume_memory_context>\n<user_message>\nhello\n</user_message>"
              },
              sourceContributionId: "core.memory.context",
              createdAt: "2026-05-26T00:00:00.000Z"
            }],
            errors: []
          };
        }
        expect(event).toMatchObject({
          event: "context.afterAssemble",
          availableTools: expect.any(Array),
          tokenBudget: expect.any(Number),
          userMessageForModelLength: expect.any(Number)
        });
        return {
          effects: [{
            effect: {
              type: "recordTrace",
              record: {
                type: "workflow_hook",
                contributionId: "core.observability.trace",
                event: "context.afterAssemble",
                status: "success"
              }
            },
            sourceContributionId: "core.observability.trace",
            createdAt: "2026-05-26T00:00:00.000Z"
          }],
          errors: []
        };
      }
    },
    applyWorkflowHookEffects: async (result) => {
      applied.push(...result.effects.map((item) => item.effect.type));
    }
  });

  expect(seen).toEqual(["context.beforeAssemble", "context.afterAssemble"]);
  expect(applied).toEqual(["recordTrace"]);
  expect(String(result.userMessageForModel)).toContain("remembered");
});

test("continues context assembly when context hook throws", async () => {
  const result = await createRuntimeCoreSession({
    ...createHookRuntimeSessionInput(),
    workflowHooks: {
      execute: async () => {
        throw new Error("hook failed");
      }
    }
  });

  expect(result.userMessageForModel).toBeTruthy();
});

test("continues context assembly when after hook reports errors and effect application throws", async () => {
  const result = await createRuntimeCoreSession({
    ...createHookRuntimeSessionInput(),
    workflowHooks: {
      execute: async (event) => event.event === "context.afterAssemble"
        ? {
            effects: [{
              effect: {
                type: "recordTrace",
                record: {
                  type: "workflow_hook",
                  contributionId: "core.observability.trace",
                  event: "context.afterAssemble",
                  status: "error",
                  errorMessage: "diagnostic failure"
                }
              },
              sourceContributionId: "core.observability.trace",
              createdAt: "2026-05-26T00:00:00.000Z"
            }],
            errors: [{ contributionId: "core.observability.trace", message: "diagnostic failure" }]
          }
        : { effects: [], errors: [] }
    },
    applyWorkflowHookEffects: async () => {
      throw new Error("effect failed");
    }
  });

  expect(result.userMessageForModel).toBeTruthy();
});
```

Use the real local helper names from `run.test.ts`; do not introduce a second test harness.

- [ ] **Step 2: Run runtime-core hook tests to verify RED**

Run:

```bash
rtk bun test apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts
```

Expected: FAIL because `workflowHooks`, `workflowContext`, and `applyWorkflowHookEffects` are not supported yet.

- [ ] **Step 3: Add optional hook runtime to `CreateRuntimeCoreSessionInput`**

In `runtime-core/run.ts`:

```ts
import { collectAppendContextEffects } from "../../workflow-hooks/hook-effects";
import type { LumeWorkflowHookExecutionResult } from "../../workflow-hooks/hook-effects";
import type { LumeWorkflowHookRuntimeLike } from "../../workflow-hooks/hook-runtime";

export interface CreateRuntimeCoreSessionInput {
  // existing fields
  workflowHooks?: LumeWorkflowHookRuntimeLike;
  applyWorkflowHookEffects?: (result: LumeWorkflowHookExecutionResult) => Promise<void> | void;
}
```

- [ ] **Step 4: Execute `context.beforeAssemble` before assembly**

In `createRuntimeCoreSession`, execute the hook after `toolset` is known and before `ContextAssembler.assemble`:

```ts
const beforeContextResult = await executeWorkflowHookSafely(input.workflowHooks, {
  event: "context.beforeAssemble",
  runId: input.runId ?? input.lumeSessionId,
  threadId: input.lumeSessionId,
  workspaceId: input.workspaceId,
  workspaceSlug: input.workspaceSlug,
  cwd: input.cwd,
  permissionMode: input.permissionMode,
  threadType: input.threadType,
  chatType: input.chatType,
  messageMetadata: input.messageMetadata,
  userMessage: input.userMessage ?? "",
  availableTools: toolset.availableToolNames,
  tokenBudget: input.resolvedModel?.contextWindow ?? 32_000
});
const workflowContext = beforeContextResult
  ? { appendContext: collectAppendContextEffects(beforeContextResult.effects) }
  : undefined;
```

`executeWorkflowHookSafely` must catch thrown hook runtime errors and return `null`; `ContextAssembler` then falls back to the existing inline memory behavior.

- [ ] **Step 5: Pass prepared context into ContextAssembler**

Pass `workflowContext` into `ContextAssembler.assemble`. Do not pass the runtime object into the assembler.

- [ ] **Step 6: Execute and apply `context.afterAssemble` after assembly**

After `contextAssembly` is available, execute:

```ts
const afterContextResult = await executeWorkflowHookSafely(input.workflowHooks, {
  event: "context.afterAssemble",
  runId: input.runId ?? input.lumeSessionId,
  threadId: input.lumeSessionId,
  workspaceId: input.workspaceId,
  workspaceSlug: input.workspaceSlug,
  cwd: input.cwd,
  permissionMode: input.permissionMode,
  threadType: input.threadType,
  chatType: input.chatType,
  messageMetadata: input.messageMetadata,
  availableTools: toolset.availableToolNames,
  tokenBudget: input.resolvedModel?.contextWindow ?? 32_000,
  memoryContextUsedItems: contextAssembly.memoryContextUsedItems,
  userMessageForModelLength: contextAssembly.userMessageForModel.length
});
if (afterContextResult) {
  try {
    await input.applyWorkflowHookEffects?.(afterContextResult);
  } catch {
    // Hook observe effects must not block session creation.
  }
}
```

Hook execution errors, returned hook errors, and effect application errors must not fail session creation.

- [ ] **Step 7: Run runtime-core context test**

Run:

```bash
rtk bun test apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts
```

Expected: PASS after implementation.

- [ ] **Step 8: Commit Task 5**

```bash
rtk git add apps/sidecar/src/services/agent-runtime/runtime-core/run.ts apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts
rtk git commit -m "✨ feat(sidecar): 触发上下文 Hook" \
  -m "createRuntimeCoreSession 在 ContextAssembler 前后执行 context hooks，并把 appendContext effect 转为 prepared context blocks。" \
  -m "Constraint: hook 错误和 effect 应用错误不阻断 session 创建" \
  -m "Tested: bun test apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts"
```

### Task 6: Wire Permission Decision Hook

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/attempt.ts`
- Create: `apps/sidecar/src/services/agent-runtime/runtime-core/attempt-hooks.test.ts`

- [ ] **Step 1: Extract permission hook decision helper test**

Create `attempt-hooks.test.ts` for a small exported helper, not the entire interactive approval flow:

```ts
import { describe, expect, test } from "bun:test";
import { resolveWorkflowPermissionHookResult } from "./attempt";

const event = {
  event: "permission.beforeDecision" as const,
  runId: "run-1",
  threadId: "thread-1",
  cwd: "/tmp/project",
  toolName: "Bash",
  toolInputSummary: "rm -rf .lume",
  gatewayDecision: "ask" as const
};

describe("workflow permission hook decision", () => {
  test("denies before interactive approval", async () => {
    const result = await resolveWorkflowPermissionHookResult({
      workflowHooks: {
        execute: async () => ({
          effects: [{
            effect: { type: "setPermissionDecision", decision: "deny", reason: "private root" },
            sourceContributionId: "core.security.permission",
            createdAt: "2026-05-26T00:00:00.000Z"
          }],
          errors: []
        })
      } as any,
      event
    });

    expect(result).toEqual({ behavior: "deny", message: "private root" });
  });

  test("allows before ordinary ask approval", async () => {
    const result = await resolveWorkflowPermissionHookResult({
      workflowHooks: {
        execute: async () => ({
          effects: [{
            effect: { type: "setPermissionDecision", decision: "allow", reason: "trusted command" },
            sourceContributionId: "core.security.permission",
            createdAt: "2026-05-26T00:00:00.000Z"
          }],
          errors: []
        })
      } as any,
      event
    });

    expect(result).toEqual({ behavior: "allow" });
  });

  test("falls back to ask for explicit ask, disabled, missing runtime, no decision, returned errors, and thrown errors", async () => {
    const explicitAsk = await resolveWorkflowPermissionHookResult({
      workflowHooks: {
        execute: async () => ({
          effects: [{
            effect: { type: "setPermissionDecision", decision: "ask", reason: "review" },
            sourceContributionId: "core.security.permission",
            createdAt: "2026-05-26T00:00:00.000Z"
          }],
          errors: []
        })
      } as any,
      event
    });
    const disabled = await resolveWorkflowPermissionHookResult({ disabled: true, workflowHooks: {} as any, event });
    const missingRuntime = await resolveWorkflowPermissionHookResult({ event });
    const noDecision = await resolveWorkflowPermissionHookResult({
      workflowHooks: { execute: async () => ({ effects: [], errors: [] }) } as any,
      event
    });
    const returnedErrors = await resolveWorkflowPermissionHookResult({
      workflowHooks: {
        execute: async () => ({ effects: [], errors: [{ contributionId: "x", message: "boom" }] })
      } as any,
      event
    });
    const thrown = await resolveWorkflowPermissionHookResult({
      workflowHooks: {
        execute: async () => {
          throw new Error("boom");
        }
      } as any,
      event
    });

    expect([explicitAsk, disabled, missingRuntime, noDecision, returnedErrors, thrown]).toEqual([
      null,
      null,
      null,
      null,
      null,
      null
    ]);
  });
});
```

- [ ] **Step 2: Run permission helper test to verify RED**

Run:

```bash
rtk bun test apps/sidecar/src/services/agent-runtime/runtime-core/attempt-hooks.test.ts
```

Expected: FAIL because helper does not exist.

- [ ] **Step 3: Implement helper and integrate**

Export from `attempt.ts`:

```ts
export async function resolveWorkflowPermissionHookResult(input: {
  workflowHooks?: { execute(event: unknown): Promise<LumeWorkflowHookExecutionResult> };
  event: LumeWorkflowPermissionBeforeDecisionEvent;
  disabled?: boolean;
}): Promise<{ behavior: "allow" | "deny"; message?: string } | null> {
  if (input.disabled || !input.workflowHooks) return null;
  let result: LumeWorkflowHookExecutionResult;
  try {
    result = await input.workflowHooks.execute(input.event);
  } catch {
    return null;
  }
  if (result.errors.length > 0) return null;
  const decision = resolvePermissionDecision(result.effects);
  if (!decision) return null;
  if (decision.decision === "deny") return { behavior: "deny", message: decision.reason };
  if (decision.decision === "allow") return { behavior: "allow" };
  return null;
}
```

Integrate in `createCanUseToolHandler` after descriptor/gateway deny and after AskUserQuestion hard validation, before returning gateway allow or opening interactive approval.

- [ ] **Step 4: Add optional hook runtime to permission handler input**

Keep this task scoped to `attempt.ts`: add an optional `workflowHooks` argument to `createCanUseToolHandler` and pass it into `resolveWorkflowPermissionHookResult`. Production runner wiring happens in Task 8 after the runner owns the real runtime factory.

- [ ] **Step 5: Run permission helper tests**

Run:

```bash
rtk bun test apps/sidecar/src/services/agent-runtime/runtime-core/attempt-hooks.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run existing permission-sensitive tests**

Run:

```bash
rtk bun test apps/sidecar/src/services/agent-runtime/interruption/tool-permission-session.test.ts apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 6**

```bash
rtk git add apps/sidecar/src/services/agent-runtime/runtime-core/attempt.ts apps/sidecar/src/services/agent-runtime/runtime-core/attempt-hooks.test.ts
rtk git commit -m "✨ feat(sidecar): 接入权限决策 Hook" \
  -m "在 toolExecutionGateway 之后、交互审批之前执行 permission.beforeDecision，deny 可短路，allow 可跳过普通审批，hook 错误回退现有 ask 流程。" \
  -m "Constraint: gateway deny 与 descriptor 缺失仍在 hook 前硬拒绝" \
  -m "Tested: bun test apps/sidecar/src/services/agent-runtime/runtime-core/attempt-hooks.test.ts" \
  -m "Tested: bun test apps/sidecar/src/services/agent-runtime/interruption/tool-permission-session.test.ts apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts"
```

## Chunk 4: Runner Lifecycle, Effect Application, And Final Verification

### Task 7: Add Runner Lifecycle Hooks And Effect Application

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runner/run-observer.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/runner/lume-runner.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/runner/lume-runner.test.ts`

- [ ] **Step 1: Write failing runner tests**

Add tests to `lume-runner.test.ts`:

```ts
test("fires run lifecycle hooks in order and applies observe effects", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "lume-runner-hooks-"));
  dirs.push(agentDir);
  const events: string[] = [];
  const seen: string[] = [];
  const addedCandidates: string[] = [];
  const runner = await LumeRunner.create({
    params: createTestParams("thread-1"),
    prepared: createPrepared(agentDir),
    emit: createRuntimeEventEmitter(events),
    workflowHooks: {
      execute: async (event) => {
        seen.push(event.event);
        if (event.event !== "run.afterComplete") return { effects: [], errors: [] };
        return {
          effects: [{
            effect: {
              type: "emitRuntimeEvent",
              event: {
                type: "workflow_hook.diagnostic",
                runId: event.runId,
                threadId: event.threadId,
                contributionId: "test",
                message: "complete",
                level: "info"
              }
            },
            sourceContributionId: "test",
            createdAt: "2026-05-26T00:00:00.000Z"
          }, {
            effect: {
              type: "recordTrace",
              record: {
                type: "workflow_hook",
                contributionId: "trace",
                event: "run.afterComplete",
                status: "success",
                effectTypes: ["emitRuntimeEvent", "recordTrace", "enqueueMemoryCandidate"]
              }
            },
            sourceContributionId: "trace",
            createdAt: "2026-05-26T00:00:00.000Z"
          }, {
            effect: {
              type: "enqueueMemoryCandidate",
              candidates: [{
                kind: "preference",
                targetScope: "global",
                statement: "User prefers concise summaries.",
                confidence: "medium",
                evidence: { sourceMessages: ["I prefer concise summaries."] }
              }]
            },
            sourceContributionId: "memory",
            createdAt: "2026-05-26T00:00:00.000Z"
          }],
          errors: []
        };
      }
    } as any,
    addMemoryCandidate: async ({ candidate }) => {
      addedCandidates.push(candidate.statement);
      return { action: "new" };
    }
  });

  await runner.complete();

  expect(seen).toEqual(["run.beforeStart", "run.afterComplete"]);
  expect(events).toContain("runtime:workflow_hook.diagnostic");
  expect(addedCandidates).toEqual(["User prefers concise summaries."]);
  const trace = readTrace(agentDir);
  expect(trace.spans).toContainEqual(expect.objectContaining({
    type: "guardrail",
    name: "workflow hook: run.afterComplete",
    metadata: expect.objectContaining({
      sourceContributionId: "trace",
      contributionId: "trace",
      event: "run.afterComplete",
      status: "success"
    })
  }));
});

test("fires failure hook and preserves original failure", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "lume-runner-hooks-fail-"));
  dirs.push(agentDir);
  const seen: string[] = [];
  const runner = await LumeRunner.create({
    params: createTestParams("thread-1"),
    prepared: createPrepared(agentDir),
    emit: createRuntimeEventEmitter([]),
    workflowHooks: {
      execute: async (event) => {
        seen.push(event.event);
        if (event.event === "run.afterFailure") {
          expect(event.errorMessage).toBe("model failed");
          return { effects: [], errors: [] };
        }
        return { effects: [], errors: [] };
      }
    } as any
  });

  const result = await runner.fail("model failed");

  expect(seen).toEqual(["run.beforeStart", "run.afterFailure"]);
  expect(result).toEqual({ status: "errored", errorMessage: "model failed" });
});

test("preserves original failure when failure hook throws or returns errors", async () => {
  for (const mode of ["throw", "errors"] as const) {
    const agentDir = mkdtempSync(join(tmpdir(), `lume-runner-hooks-fail-${mode}-`));
    dirs.push(agentDir);
    const runner = await LumeRunner.create({
      params: createTestParams("thread-1"),
      prepared: createPrepared(agentDir),
      emit: createRuntimeEventEmitter([]),
      workflowHooks: {
        execute: async (event) => {
          if (event.event !== "run.afterFailure") return { effects: [], errors: [] };
          if (mode === "throw") throw new Error("hook failed");
          return { effects: [], errors: [{ contributionId: "failure", message: "hook failed" }] };
        }
      } as any
    });

    const result = await runner.fail("model failed");

    expect(result).toEqual({ status: "errored", errorMessage: "model failed" });
  }
});

test("finalizeError also fires failure hook without replacing the thrown error", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "lume-runner-hooks-finalize-error-"));
  dirs.push(agentDir);
  const seen: string[] = [];
  const runner = await LumeRunner.create({
    params: createTestParams("thread-1"),
    prepared: createPrepared(agentDir),
    emit: createRuntimeEventEmitter([]),
    workflowHooks: {
      execute: async (event) => {
        seen.push(event.event);
        if (event.event === "run.afterFailure") {
          expect(event.errorMessage).toBe("model failed");
          throw new Error("hook failed");
        }
        return { effects: [], errors: [] };
      }
    } as any
  });

  await expect(runner.finalizeError(new Error("model failed"))).resolves.toBeUndefined();
  expect(seen).toEqual(["run.beforeStart", "run.afterFailure"]);
});
```

If the existing `readTrace` helper type omits `metadata`, widen it to include span metadata for the new assertion.

- [ ] **Step 2: Run runner test to verify RED**

Run:

```bash
rtk bun test apps/sidecar/src/services/agent-runtime/runner/lume-runner.test.ts
```

Expected: FAIL because `workflowHooks`, hook effect application, and failure hook behavior are not supported.

- [ ] **Step 3: Add observer trace writer**

In `run-observer.ts`, add a helper that writes `recordTrace` effects as real trace spans. Use existing span type `"guardrail"` to avoid expanding the trace schema in this MVP.

```ts
async recordWorkflowHookTrace(input: {
  sourceContributionId: string;
  createdAt: string;
  record: LumeWorkflowTraceRecord;
}): Promise<void> {
  await this.traceRecorder.withSpan({
    traceId: this.state.traceId,
    parentId: this.runSpan?.id,
    type: "guardrail",
    name: `workflow hook: ${input.record.event}`,
    input: input.record,
    metadata: {
      contributionId: input.record.contributionId,
      event: input.record.event,
      status: input.record.status,
      elapsedMs: input.record.elapsedMs,
      effectTypes: input.record.effectTypes,
      errorMessage: input.record.errorMessage,
      sourceContributionId: input.sourceContributionId,
      hookCreatedAt: input.createdAt
    }
  }, async () => ({ status: input.record.status }));
}
```

- [ ] **Step 4: Add fake hook injection and effect reducer to runner**

In `lume-runner.ts`, accept optional test seams:

- `workflowHooks?: LumeWorkflowHookRuntimeLike | null`
- `addMemoryCandidate?: typeof smartAddMemoryV2Candidate`

Add a private effect reducer:

```ts
private async applyWorkflowHookEffects(result: LumeWorkflowHookExecutionResult): Promise<void> {
  for (const envelope of result.effects) {
    if (envelope.effect.type === "emitRuntimeEvent") {
      this.emit.onRuntimeEvent?.({
        id: `${this.observer.getRunId()}:${envelope.sourceContributionId}:${envelope.effect.event.type}`,
        createdAt: envelope.createdAt,
        ...envelope.effect.event,
        runId: this.observer.getRunId(),
        threadId: this.observer.getThreadId()
      } as any);
    }
    if (envelope.effect.type === "recordTrace") {
      await this.observer.recordWorkflowHookTrace({
        sourceContributionId: envelope.sourceContributionId,
        createdAt: envelope.createdAt,
        record: envelope.effect.record
      });
    }
    if (envelope.effect.type === "enqueueMemoryCandidate") {
      const workspaceSlug = this.observer.getWorkspaceSlug();
      if (!workspaceSlug) continue;
      for (const candidate of envelope.effect.candidates) {
        await this.addMemoryCandidate({
          workspaceSlug,
          candidate: {
            ...candidate,
            evidence: {
              ...candidate.evidence,
              runId: candidate.evidence?.runId ?? this.observer.getRunId()
            }
          }
        });
      }
    }
  }
}
```

Wrap calls to `applyWorkflowHookEffects` in `try/catch`; hook observe effects must remain best-effort.

- [ ] **Step 5: Fire lifecycle hooks**

In `LumeRunner.create`, after constructing the runner, call `run.beforeStart`.

In `runPreparedRuntimeCoreAttempt`, remember the latest `runtimeSession.memoryContextUsedItems` on the runner so `run.afterComplete` can report the memory context actually used for the run.

In `complete`, call `run.afterComplete` before `emit.onComplete()` with this payload:

```ts
{
  event: "run.afterComplete",
  runId: this.observer.getRunId(),
  threadId: this.observer.getThreadId(),
  workspaceSlug,
  cwd: this.prepared.agentCwd,
  userMessage: this.observer.getUserMessage(),
  runStateSummary: {
    status: runState?.status ?? "completed",
    generatedItemCount: runState?.generatedItems.length ?? 0,
    pendingInterruptionCount: runState?.pendingInterruptions.length ?? 0
  },
  usage: runState?.usage,
  memoryContextUsedItems: this.latestMemoryContextUsedItems
}
```

When `this.workflowHooks` exists, skip the old inline `extractMemoryCandidatesWithLlm` loop in `complete`; the core memory completion handler returns `enqueueMemoryCandidate` and the reducer calls `smartAddMemoryV2Candidate`. Keep `appendDaily`, `appendRunArchive`, and conversation summary behavior unchanged.

In `fail` and `finalizeError`, call `run.afterFailure` before final runtime failure handling. Preserve the original error/result even if the hook runtime throws or returns errors.

- [ ] **Step 6: Run runner tests**

Run:

```bash
rtk bun test apps/sidecar/src/services/agent-runtime/runner/lume-runner.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 7**

```bash
rtk git add apps/sidecar/src/services/agent-runtime/runner/run-observer.ts apps/sidecar/src/services/agent-runtime/runner/lume-runner.ts apps/sidecar/src/services/agent-runtime/runner/lume-runner.test.ts
rtk git commit -m "✨ feat(sidecar): 触发运行生命周期 Hook" \
  -m "LumeRunner 支持注入 workflow hook runtime，并在 run start、complete、failure 阶段执行 observe effects。" \
  -m "Constraint: Hook 错误不覆盖原始运行结果" \
  -m "Tested: bun test apps/sidecar/src/services/agent-runtime/runner/lume-runner.test.ts"
```

### Task 8: Wire Real Runtime Factory Through Attempt Path

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/attempt.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/runner/lume-runner.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/runner/lume-runner.test.ts`

- [ ] **Step 1: Write production wiring tests**

Add tests to `lume-runner.test.ts`:

```ts
test("does not fire production lifecycle hooks when hooks are disabled", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "lume-runner-hooks-disabled-"));
  dirs.push(agentDir);
  const seen: string[] = [];
  const runner = await LumeRunner.create({
    params: createTestParams("thread-disabled"),
    prepared: createPrepared(agentDir),
    emit: createRuntimeEventEmitter([]),
    createWorkflowHooks: () => ({
      execute: async (event) => {
        seen.push(event.event);
        return { effects: [], errors: [] };
      }
    } as any),
    hooksConfig: { enabled: false, memory: true, security: true, observability: true }
  });

  await runner.complete();

  expect(seen).toEqual([]);
});

test("passes the same production hook runtime to context and permission", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "lume-runner-hooks-production-"));
  dirs.push(agentDir);
  const seen: string[] = [];
  const workflowHooks = {
    execute: async (event) => {
      seen.push(event.event);
      return { effects: [], errors: [] };
    }
  } as any;
  const runner = await LumeRunner.create({
    params: createTestParams("thread-production"),
    prepared: createPrepared(agentDir),
    emit: createRuntimeEventEmitter([]),
    createWorkflowHooks: () => workflowHooks,
    hooksConfig: { enabled: true, memory: true, security: true, observability: true }
  });

  await runner.runPreparedRuntimeCoreAttempt({
    params: createTestParams("thread-production"),
    prepared: createPrepared(agentDir),
    options: {
      registerAbort: () => {},
      unregisterAbort: () => {}
    },
    createRuntimeSession: async (input) => {
      expect(input.workflowHooks).toBe(workflowHooks);
      expect(input.applyWorkflowHookEffects).toEqual(expect.any(Function));
      return {
        agent: {
          setModel: async () => {},
          setMaxThinkingTokens: async () => {},
          interrupt: async () => {},
          query: () => stream([])
        },
        session: {
          sessionId: "sdk-session-1",
          threadId: "sdk-thread-1",
          dispose: async () => {}
        },
        tools: [],
        userMessageForModel: "hello",
        memoryContextUsedItems: []
      } as any;
    },
    createCanUseTool: (askUserSignal, workflowHooksInput) => {
      expect(workflowHooksInput).toBe(workflowHooks);
      return async () => ({ behavior: "allow" });
    }
  });
});
```

Use the real helper names from the existing runner tests. The second test is intentionally about object identity: context and permission must receive the same runtime instance.

- [ ] **Step 2: Build real runtime in `LumeRunner.create`**

Let tests pass fake `workflowHooks`, while production path builds real hooks from `getEffectiveLumeConfig(prepared.workspaceSlug).hooks?.internal`.

Use `createLumeWorkflowHookRuntime` with:

```ts
{
  memory: createMemoryWorkflowHookService(),
  security: createSecurityWorkflowHookService(),
  runtimeEvents: createRuntimeEventWorkflowHookService(),
  trace: createTraceWorkflowHookService(),
  clock: { now: () => new Date() }
}
```

If `hooks.internal.enabled === false`, store no runtime and do not fire `run.beforeStart`.

- [ ] **Step 3: Pass same runtime to context and permission**

Ensure `runner.runPreparedRuntimeCoreAttempt` passes `this.workflowHooks` into `createRuntimeSession` and `createCanUseTool`.

Adjust the `createCanUseTool` callback shape to:

```ts
createCanUseTool: (
  askUserSignal: AbortSignal,
  workflowHooks?: LumeWorkflowHookRuntimeLike
) => CanUseToolFn;
```

Then update `runRuntimeCoreAttempt` so `createCanUseToolHandler(..., workflowHooks)` receives the runtime. This is the production wiring for the optional hook argument added in Task 6.

- [ ] **Step 4: Run integrated runtime tests**

Run:

```bash
rtk bun test apps/sidecar/src/services/agent-runtime/runner/lume-runner.test.ts apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts apps/sidecar/src/services/agent-runtime/runtime-core/attempt-hooks.test.ts apps/sidecar/src/services/agent-runtime/interruption/tool-permission-session.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 8**

```bash
rtk git add apps/sidecar/src/services/agent-runtime/runtime-core/attempt.ts apps/sidecar/src/services/agent-runtime/runner/lume-runner.ts apps/sidecar/src/services/agent-runtime/runner/lume-runner.test.ts
rtk git commit -m "✨ feat(sidecar): 串联 Hook Runtime 执行路径" \
  -m "生产路径根据 hooks.internal 创建 workflow hook runtime，并复用到 context assembly、permission decision 与 runner lifecycle。" \
  -m "Constraint: hooks disabled 时 runtime 行为保持旧路径" \
  -m "Tested: bun test apps/sidecar/src/services/agent-runtime/runner/lume-runner.test.ts apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts apps/sidecar/src/services/agent-runtime/runtime-core/attempt-hooks.test.ts apps/sidecar/src/services/agent-runtime/interruption/tool-permission-session.test.ts"
```

### Task 9: Final Targeted Verification

**Files:**
- No planned edits.

- [ ] **Step 1: Run workflow hook focused tests**

Run:

```bash
rtk bun test apps/sidecar/src/services/workflow-hooks/hook-effects.test.ts apps/sidecar/src/services/workflow-hooks/hook-bus.test.ts apps/sidecar/src/services/workflow-hooks/core-hooks.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run config/context/runtime focused tests**

Run:

```bash
rtk bun test apps/sidecar/src/services/system/lume-config-service.test.ts apps/sidecar/src/services/agent-runtime/context/context-assembler.test.ts apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts apps/sidecar/src/services/agent-runtime/runtime-core/attempt-hooks.test.ts apps/sidecar/src/services/agent-runtime/interruption/tool-permission-session.test.ts apps/sidecar/src/services/agent-runtime/runner/lume-runner.test.ts
```

Expected: PASS.

- [ ] **Step 3: Check committed diff scope**

Run:

```bash
rtk git status --short
rtk git log --oneline --decorate -8
```

Expected: clean worktree except intentional untracked local artifacts; recent commits touch only the files listed in this plan.

- [ ] **Step 4: Prepare final report**

Report:

- Changed files.
- Simplifications made.
- Tests run.
- Remaining risks, especially `NotifyEffect`, plugin hook loading, and SDK tool lifecycle adapter staying post-MVP.
