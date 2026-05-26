import { describe, expect, test } from "bun:test";
import { LumeWorkflowHookBus } from "./hook-bus";
import type {
  LumeWorkflowHookContribution,
  LumeWorkflowHookHandlerRegistry
} from "./hook-events";

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
