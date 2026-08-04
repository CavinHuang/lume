import { describe, expect, test } from "bun:test";
import { createCorePersonaHookHandlers } from "./core-persona-hooks";
import { createPersonaWorkflowHookService } from "./hook-services";
import type { LumeWorkflowHookHandlerContext, LumeWorkflowPersonaService } from "./hook-services";
import type { LumeWorkflowRunAfterCompleteEvent } from "./hook-events";

function createContext(
  persona: Pick<LumeWorkflowPersonaService, "ensurePersona">
): LumeWorkflowHookHandlerContext {
  return {
    services: {
      // 其它服务对本 hook 不可达，给最小 noop 占位以满足类型
      memory: {
        recallContext: async () => ({ prefix: "", userMessageForModel: "", items: [] }),
        extractCandidates: async () => []
      },
      security: { evaluatePermissionDecision: async () => ({}) },
      suggestion: { evaluateSessionSuggestions: async () => {} },
      persona,
      runtimeEvents: { buildDiagnosticEvent: (input) => ({ type: "workflow_hook.diagnostic", ...input }) },
      trace: { buildHookTrace: (input) => ({ type: "workflow_hook", ...input }) },
      clock: { now: () => new Date("2026-08-04T00:00:00.000Z") }
    }
  };
}

function afterCompleteEvent(overrides: Partial<LumeWorkflowRunAfterCompleteEvent> = {}): LumeWorkflowRunAfterCompleteEvent {
  return {
    event: "run.afterComplete",
    runId: "run-1",
    threadId: "thread-1",
    cwd: "/tmp/project",
    workspaceSlug: "demo",
    userMessage: "please summarize the queue",
    runStateSummary: { status: "completed", generatedItemCount: 2, pendingInterruptionCount: 0 },
    memoryContextUsedItems: [],
    ...overrides
  };
}

/** flush microtasks so fire-and-forget .then/.catch settles before assertions */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("core.persona.completion hook", () => {
  test("invokes ensurePersona on run.afterComplete with workspaceSlug", async () => {
    const calls: Array<{ workspaceSlug?: string }> = [];
    const handlers = createCorePersonaHookHandlers();

    const result = await handlers["core.persona.completion"]!(
      afterCompleteEvent(),
      createContext({
        ensurePersona: async (input) => {
          calls.push(input);
        }
      })
    );
    await flushMicrotasks();

    // handler 立即返回空 effects（fire-and-forget）
    expect(result.effects).toEqual([]);
    // workspaceSlug 直传
    expect(calls).toEqual([{ workspaceSlug: "demo" }]);
  });

  test("does not await ensurePersona — resolves before the synth completes", async () => {
    let ensureResolved = false;
    let resolveEnsure!: () => void;
    const ensurePromise = new Promise<void>((resolve) => {
      resolveEnsure = resolve;
    });

    const handlers = createCorePersonaHookHandlers();
    const start = Date.now();
    await handlers["core.persona.completion"]!(
      afterCompleteEvent(),
      createContext({
        ensurePersona: async () => {
          await ensurePromise;
          ensureResolved = true;
        }
      })
    );
    const elapsed = Date.now() - start;

    // handler 在 ensurePersona 完成前就已返回（fire-and-forget：不阻塞 run 完成）
    expect(ensureResolved).toBe(false);
    expect(elapsed).toBeLessThan(50);

    resolveEnsure();
    await flushMicrotasks();
    expect(ensureResolved).toBe(true);
  });

  test("swallows errors from ensurePersona (never throws, returns empty effects)", async () => {
    const handlers = createCorePersonaHookHandlers();

    // 若 handler 未妥善 swallow，错误会从这里冒泡成 unhandled rejection 或抛出
    const result = await handlers["core.persona.completion"]!(
      afterCompleteEvent(),
      createContext({
        ensurePersona: async () => {
          throw new Error("persona synthesis blew up");
        }
      })
    );
    await flushMicrotasks();

    expect(result.effects).toEqual([]);
  });

  test("ignores non run.afterComplete events", async () => {
    const calls: unknown[] = [];
    const handlers = createCorePersonaHookHandlers();

    const result = await handlers["core.persona.completion"]!(
      // 强制构造一个非 run.afterComplete 事件以验证 guard
      { event: "context.beforeAssemble", runId: "r", threadId: "t", cwd: "/tmp", userMessage: "hi", availableTools: [], tokenBudget: 1 } as never,
      createContext({
        ensurePersona: async (input) => {
          calls.push(input);
        }
      })
    );
    await flushMicrotasks();

    expect(result.effects).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("forwards undefined workspaceSlug (ensurePersona decides global fallback)", async () => {
    const calls: Array<{ workspaceSlug?: string }> = [];
    const handlers = createCorePersonaHookHandlers();

    await handlers["core.persona.completion"]!(
      afterCompleteEvent({ workspaceSlug: undefined }),
      createContext({
        ensurePersona: async (input) => {
          calls.push(input);
        }
      })
    );
    await flushMicrotasks();

    expect(calls).toEqual([{ workspaceSlug: undefined }]);
  });

  test("createPersonaWorkflowHookService forwards to the injected ensure fn", async () => {
    const calls: unknown[] = [];
    const service = createPersonaWorkflowHookService({
      ensure: async (input) => {
        calls.push(input);
      }
    });

    await service.ensurePersona({ workspaceSlug: "w-1" });

    expect(calls).toEqual([{ workspaceSlug: "w-1" }]);
  });
});
