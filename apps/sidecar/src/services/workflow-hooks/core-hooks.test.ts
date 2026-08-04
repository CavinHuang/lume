import { describe, expect, test } from "bun:test";
import { createCoreMemoryHookHandlers } from "./core-memory-hooks";
import { createCoreObservabilityHookHandlers } from "./core-observability-hooks";
import { createCoreSecurityHookHandlers } from "./core-security-hooks";
import { createCoreWorkflowHookContributions } from "./contributions";
import { createMemoryWorkflowHookService } from "./hook-services";
import type { LumeWorkflowHookHandlerContext } from "./hook-services";

function createContext(
  services: Partial<LumeWorkflowHookHandlerContext["services"]> = {}
): LumeWorkflowHookHandlerContext {
  return {
    services: {
      memory: {
        recallContext: async () => ({ prefix: "", userMessageForModel: "", items: [] }),
        extractCandidates: async () => []
      },
      security: { evaluatePermissionDecision: async () => ({}) },
      suggestion: { evaluateSessionSuggestions: async () => {} },
      persona: { ensurePersona: async () => {} },
      runtimeEvents: { buildDiagnosticEvent: (input) => ({ type: "workflow_hook.diagnostic", ...input }) },
      trace: { buildHookTrace: (input) => ({ type: "workflow_hook", ...input }) },
      clock: { now: () => new Date("2026-05-26T00:00:00.000Z") },
      ...services
    }
  };
}

describe("core workflow hooks", () => {
  test("filters contributions by internal module config", () => {
    const contributions = createCoreWorkflowHookContributions({
      enabled: true,
      memory: false,
      security: true,
      observability: false
    });

    expect(contributions.map((item) => item.id)).toEqual([
      "core.plugin.skill-activation",
      "core.suggestion.completion",
      "core.persona.completion",
      "core.security.permission",
    ]);
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
    }, createContext({
      memory: {
        recallContext: async () => ({
          prefix: "<lume_memory_context>hello</lume_memory_context>",
          userMessageForModel: "<lume_memory_context>hello</lume_memory_context>\n<user_message>\nhello\n</user_message>",
          items: [{
            id: "mem-1",
            kind: "preference",
            scope: "global",
            status: "active",
            statement: "hello",
            path: "memory.md",
            citation: "memory.md",
            reason: "test",
            score: 1
          }]
        }),
        extractCandidates: async () => []
      }
    }));

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
    }, createContext({
      memory: {
        recallContext: async () => ({ prefix: "", userMessageForModel: "", items: [] }),
        extractCandidates: async () => [{
          kind: "preference",
          targetScope: "global",
          statement: "User prefers concise summaries.",
          confidence: "medium",
          evidence: { runId: "run-1", sourceMessages: ["I prefer concise summaries."] }
        }]
      }
    }));

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
    }, createContext({
      security: {
        evaluatePermissionDecision: async (input) => {
          calls.push(input);
          return { decision: "deny", reason: "Private root." };
        }
      }
    }));

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
      memoryContextUsedItems: [{
        id: "mem-1",
        kind: "preference",
        scope: "global",
        status: "active",
        statement: "hello",
        path: "memory.md",
        citation: "memory.md",
        reason: "test",
        score: 1
      }],
      userMessageForModelLength: 42
    }, createContext());

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
