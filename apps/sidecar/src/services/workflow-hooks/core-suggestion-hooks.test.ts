import { describe, expect, test } from "bun:test";
import { createCoreSuggestionHookHandlers } from "./core-suggestion-hooks";
import { createSuggestionWorkflowHookService } from "./hook-services";
import type { LumeWorkflowHookHandlerContext, LumeWorkflowSuggestionService } from "./hook-services";
import type { LumeWorkflowRunAfterCompleteEvent } from "./hook-events";

function createContext(
  suggestion: Pick<LumeWorkflowSuggestionService, "evaluateSessionSuggestions">
): LumeWorkflowHookHandlerContext {
  return {
    services: {
      // 其它服务对本 hook 不可达，给最小 noop 占位以满足类型
      memory: {
        recallContext: async () => ({ prefix: "", userMessageForModel: "", items: [] }),
        extractCandidates: async () => []
      },
      security: { evaluatePermissionDecision: async () => ({}) },
      suggestion,
      persona: { ensurePersona: async () => {} },
      runtimeEvents: { buildDiagnosticEvent: (input) => ({ type: "workflow_hook.diagnostic", ...input }) },
      trace: { buildHookTrace: (input) => ({ type: "workflow_hook", ...input }) },
      clock: { now: () => new Date("2026-08-03T00:00:00.000Z") }
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

describe("core.suggestion.completion hook", () => {
  test("invokes evaluateSessionSuggestions on run.afterComplete with threadId/workspaceSlug/sessionId=threadId", async () => {
    const calls: Array<{ threadId: string; workspaceSlug?: string; sessionId?: string }> = [];
    const handlers = createCoreSuggestionHookHandlers();

    const result = await handlers["core.suggestion.completion"]!(
      afterCompleteEvent(),
      createContext({
        evaluateSessionSuggestions: async (input) => {
          calls.push(input);
        }
      })
    );
    await flushMicrotasks();

    // handler 立即返回空 effects（fire-and-forget）
    expect(result.effects).toEqual([]);
    // payload 无 sessionId，按 brief 回退 threadId
    expect(calls).toEqual([
      { threadId: "thread-1", workspaceSlug: "demo", sessionId: "thread-1" }
    ]);
  });

  test("does not await evaluateSessionSuggestions — resolves before the eval completes", async () => {
    let evalResolved = false;
    let resolveEval!: () => void;
    const evalPromise = new Promise<void>((resolve) => {
      resolveEval = resolve;
    });

    const handlers = createCoreSuggestionHookHandlers();
    const start = Date.now();
    await handlers["core.suggestion.completion"]!(
      afterCompleteEvent(),
      createContext({
        evaluateSessionSuggestions: async () => {
          await evalPromise;
          evalResolved = true;
        }
      })
    );
    const elapsed = Date.now() - start;

    // handler 在 eval 完成前就已返回（fire-and-forget：不阻塞 run 完成）
    expect(evalResolved).toBe(false);
    expect(elapsed).toBeLessThan(50);

    resolveEval();
    await flushMicrotasks();
    expect(evalResolved).toBe(true);
  });

  test("swallows errors from evaluateSessionSuggestions (never throws, returns empty effects)", async () => {
    const handlers = createCoreSuggestionHookHandlers();

    // 若 handler 未妥善 swallow，错误会从这里冒泡成 unhandled rejection 或抛出
    const result = await handlers["core.suggestion.completion"]!(
      afterCompleteEvent(),
      createContext({
        evaluateSessionSuggestions: async () => {
          throw new Error("suggest engine blew up");
        }
      })
    );
    await flushMicrotasks();

    expect(result.effects).toEqual([]);
  });

  test("ignores non run.afterComplete events", async () => {
    const calls: unknown[] = [];
    const handlers = createCoreSuggestionHookHandlers();

    const result = await handlers["core.suggestion.completion"]!(
      // 强制构造一个非 run.afterComplete 事件以验证 guard
      { event: "context.beforeAssemble", runId: "r", threadId: "t", cwd: "/tmp", userMessage: "hi", availableTools: [], tokenBudget: 1 } as never,
      createContext({
        evaluateSessionSuggestions: async (input) => {
          calls.push(input);
        }
      })
    );
    await flushMicrotasks();

    expect(result.effects).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("createSuggestionWorkflowHookService forwards to the injected evaluate fn", async () => {
    const calls: unknown[] = [];
    const service = createSuggestionWorkflowHookService({
      evaluate: async (input) => {
        calls.push(input);
      }
    });

    await service.evaluateSessionSuggestions({ threadId: "t-1", workspaceSlug: "w" });

    expect(calls).toEqual([{ threadId: "t-1", workspaceSlug: "w" }]);
  });
});
