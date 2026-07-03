import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createCorePluginHookHandlers } from "./core-plugin-hooks";
import type { LumeWorkflowHookHandlerContext } from "./hook-services";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  const versionedPluginRoot = join(homedir(), ".lume", "plugins", "test-versioned-plugin");
  const versionedBarePluginRoot = join(homedir(), ".lume", "plugins", "test-versioned-bare-plugin");

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

  test("activates plugin skill without making the skill doc look like the user request", async () => {
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
    expect(effect.content).toContain("[Skill: test-plugin:hello]");
    expect(effect.content).toContain("Hello skill instructions.");
    expect(effect.userMessageForModel).toContain("<activated_plugin_skills>");
    expect(effect.userMessageForModel).toContain("immediately execute the task in <user_request>");
    expect(effect.userMessageForModel).toContain("<user_request>\n帮我测试\n</user_request>");
    expect(effect.userMessageForModel).not.toStartWith("[Skill:");
  });

  afterAll(() => {
    rmSync(versionedPluginRoot, { recursive: true, force: true });
    rmSync(versionedBarePluginRoot, { recursive: true, force: true });
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

  test("supports hyphenated skill slugs in $plugin:skill syntax", async () => {
    mkdirSync(join(testPluginRoot, "skills", "control-browser"), { recursive: true });
    writeFileSync(
      join(testPluginRoot, "skills", "control-browser", "SKILL.md"),
      "---\nname: control-browser\ndescription: browser control\n---\n\nBrowser skill instructions.",
    );

    const result = await handler(
      {
        event: "context.beforeAssemble",
        runId: "test-run",
        threadId: "test-thread",
        userMessage: "$test-plugin:control-browser 打开百度",
        availableTools: [] as string[],
        tokenBudget: 4000,
      } as unknown as Parameters<typeof handler>[0],
      createContext(),
    );

    expect(result.effects).toHaveLength(1);
    const effect = result.effects[0]! as unknown as Record<string, unknown>;
    expect(effect.content).toContain("[Skill: test-plugin:control-browser]");
    expect(effect.userMessageForModel).toContain("<user_request>\n打开百度\n</user_request>");
  });

  test("loads plugin skills from versioned marketplace install directories", async () => {
    const installedRoot = join(versionedPluginRoot, "1.2.3");
    mkdirSync(join(installedRoot, "skills", "hello"), { recursive: true });
    writeFileSync(
      join(installedRoot, "skills", "hello", "SKILL.md"),
      "---\nname: versioned hello\ndescription: versioned skill\n---\n\nVersioned skill instructions.",
    );

    const result = await handler(
      {
        event: "context.beforeAssemble",
        runId: "test-run",
        threadId: "test-thread",
        userMessage: "$test-versioned-plugin:hello 打开百度",
        availableTools: [] as string[],
        tokenBudget: 4000,
      } as unknown as Parameters<typeof handler>[0],
      createContext(),
    );

    expect(result.effects).toHaveLength(1);
    const effect = result.effects[0]! as unknown as Record<string, unknown>;
    expect(effect.content).toContain("Versioned skill instructions.");
    expect(effect.userMessageForModel).toContain("<user_request>\n打开百度\n</user_request>");
  });

  test("loads all skills for bare $plugin from versioned marketplace install directories", async () => {
    const installedRoot = join(versionedBarePluginRoot, "1.2.3");
    mkdirSync(join(installedRoot, "skills", "hello"), { recursive: true });
    writeFileSync(
      join(installedRoot, "skills", "hello", "SKILL.md"),
      "---\nname: versioned bare hello\ndescription: versioned bare skill\n---\n\nVersioned bare skill instructions.",
    );

    const result = await handler(
      {
        event: "context.beforeAssemble",
        runId: "test-run",
        threadId: "test-thread",
        userMessage: "$test-versioned-bare-plugin 打开百度",
        availableTools: [] as string[],
        tokenBudget: 4000,
      } as unknown as Parameters<typeof handler>[0],
      createContext(),
    );

    expect(result.effects).toHaveLength(1);
    const effect = result.effects[0]! as unknown as Record<string, unknown>;
    expect(effect.content).toContain("Versioned bare skill instructions.");
    expect(effect.userMessageForModel).toContain("<user_request>\n打开百度\n</user_request>");
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
    expect(effect.content).toContain("Hello skill instructions.");
    expect(effect.userMessageForModel).toContain("<user_request>\n试试这个插件\n</user_request>");
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
