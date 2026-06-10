import { beforeAll, describe, expect, test } from "bun:test";
import { createCorePluginHookHandlers } from "./core-plugin-hooks";
import type { LumeWorkflowHookHandlerContext } from "./hook-services";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const handler = createCorePluginHookHandlers()["core.plugin.skill-activation"]!;

function createContext(
  overrides: Partial<LumeWorkflowHookHandlerContext["services"]> = {},
): LumeWorkflowHookHandlerContext {
  return {
    services: {
      memory: {
        recallContext: async () => ({ prefix: "", userMessageForModel: "", items: [] }),
        extractCandidates: async () => [],
      },
      security: { evaluatePermissionDecision: async () => ({}) },
      runtimeEvents: {
        buildDiagnosticEvent: (input) => ({ type: "workflow_hook.diagnostic", ...input }),
      },
      trace: { buildHookTrace: (input) => ({ type: "workflow_hook", ...input }) },
      clock: { now: () => new Date("2026-06-10T00:00:00.000Z") },
      ...overrides,
    },
  };
}

describe("core.plugin.skill-activation", () => {
  const testPluginRoot = join(homedir(), ".lume", "plugins", "test-plugin");

  beforeAll(() => {
    mkdirSync(join(testPluginRoot, "skills", "hello"), { recursive: true });
    writeFileSync(
      join(testPluginRoot, "skills", "hello", "SKILL.md"),
      "---\nname: hello\ndescription: test skill\n---\n\nHello skill instructions.",
    );
  });

  test("returns no effects when no $plugin:skill syntax", async () => {
    const result = await handler(
      {
        event: "context.beforeAssemble",
        runId: "test-run",
        threadId: "test-thread",
        userMessage: "hello world",
        availableTools: [] as string[],
        tokenBudget: 4000,
      } as unknown as Parameters<typeof handler>[0],
      createContext(),
    );
    expect(result.effects).toHaveLength(0);
  });

  test("activates plugin skill when $plugin:skill syntax present", async () => {
    const result = await handler(
      {
        event: "context.beforeAssemble",
        runId: "test-run",
        threadId: "test-thread",
        userMessage: "$test-plugin:hello 帮我测试",
        availableTools: [] as string[],
        tokenBudget: 4000,
      } as unknown as Parameters<typeof handler>[0],
      createContext(),
    );
    expect(result.effects).toHaveLength(1);
    const effect = result.effects[0]! as unknown as Record<string, unknown>;
    expect(effect.type).toBe("appendContext");
    expect(effect.userMessageForModel).toContain("[Skill: test-plugin:hello]");
    expect(effect.userMessageForModel).toContain("Hello skill instructions.");
    expect(effect.userMessageForModel).toContain("用户请求: 帮我测试");
  });

  test("removes $plugin:skill syntax from user message", async () => {
    const result = await handler(
      {
        event: "context.beforeAssemble",
        runId: "test-run",
        threadId: "test-thread",
        userMessage: "$test-plugin:hello 帮我测试",
        availableTools: [] as string[],
        tokenBudget: 4000,
      } as unknown as Parameters<typeof handler>[0],
      createContext(),
    );
    const effect = result.effects[0]! as unknown as Record<string, unknown>;
    expect(effect.userMessageForModel).not.toContain("$test-plugin:hello");
  });

  test("returns no effects for non-existent plugin skill", async () => {
    const result = await handler(
      {
        event: "context.beforeAssemble",
        runId: "test-run",
        threadId: "test-thread",
        userMessage: "$test-plugin:nonexistent 帮我测试",
        availableTools: [] as string[],
        tokenBudget: 4000,
      } as unknown as Parameters<typeof handler>[0],
      createContext(),
    );
    expect(result.effects).toHaveLength(0);
  });

  test("ignores non-context.beforeAssemble events", async () => {
    const result = await handler(
      {
        event: "run.afterComplete",
        runId: "test-run",
        threadId: "test-thread",
        userMessage: "$test-plugin:hello",
        availableTools: [] as string[],
        tokenBudget: 4000,
      } as unknown as Parameters<typeof handler>[0],
      createContext(),
    );
    expect(result.effects).toHaveLength(0);
  });

  test("returns no effects for empty user message", async () => {
    const result = await handler(
      {
        event: "context.beforeAssemble",
        runId: "test-run",
        threadId: "test-thread",
        userMessage: "",
        availableTools: [] as string[],
        tokenBudget: 4000,
      } as unknown as Parameters<typeof handler>[0],
      createContext(),
    );
    expect(result.effects).toHaveLength(0);
  });

  test("activates all plugin skills for bare $plugin syntax", async () => {
    const result = await handler(
      {
        event: "context.beforeAssemble",
        runId: "test-run",
        threadId: "test-thread",
        userMessage: "$test-plugin 试试这个插件",
        availableTools: [] as string[],
        tokenBudget: 4000,
      } as unknown as Parameters<typeof handler>[0],
      createContext(),
    );
    expect(result.effects.length).toBeGreaterThan(0);
    const effect = result.effects[0]! as unknown as Record<string, unknown>;
    expect(effect.type).toBe("appendContext");
    expect(effect.userMessageForModel).toContain("Hello skill instructions.");
    expect(effect.userMessageForModel).toContain("用户请求: 试试这个插件");
  });

  test("removes bare $plugin syntax from user message", async () => {
    const result = await handler(
      {
        event: "context.beforeAssemble",
        runId: "test-run",
        threadId: "test-thread",
        userMessage: "$test-plugin 试试这个插件",
        availableTools: [] as string[],
        tokenBudget: 4000,
      } as unknown as Parameters<typeof handler>[0],
      createContext(),
    );
    const effect = result.effects[0]! as unknown as Record<string, unknown>;
    expect(effect.userMessageForModel).not.toContain("$test-plugin");
  });
});
