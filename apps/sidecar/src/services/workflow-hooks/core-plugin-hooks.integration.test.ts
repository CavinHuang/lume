import { beforeAll, describe, expect, test } from "bun:test";
import { createLumeWorkflowHookRuntime } from "./hook-runtime";
import type { LumeWorkflowContextBeforeAssembleEvent } from "./hook-events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

describe("plugin skill activation integration", () => {
  const testPluginRoot = join(homedir(), ".lume", "plugins", "test-plugin");

  beforeAll(() => {
    mkdirSync(join(testPluginRoot, "skills", "hello"), { recursive: true });
    writeFileSync(
      join(testPluginRoot, "skills", "hello", "SKILL.md"),
      "---\nname: hello\ndescription: test skill\n---\n\nHello skill instructions.",
    );
  });

  test("injects plugin skill context while preserving the cleaned user request", async () => {
    const runtime = createLumeWorkflowHookRuntime({
      config: { enabled: true },
      services: {
        memory: {
          recallContext: async () => ({ prefix: "", items: [], userMessageForModel: "" }),
          extractCandidates: async () => [],
        },
        security: { evaluatePermissionDecision: async () => ({}) },
        runtimeEvents: {
          buildDiagnosticEvent: (input) => ({ type: "workflow_hook.diagnostic", ...input }),
        },
        trace: { buildHookTrace: (input) => ({ type: "workflow_hook", ...input }) },
        clock: { now: () => new Date("2026-06-10T00:00:00.000Z") },
      },
    });

    const event: LumeWorkflowContextBeforeAssembleEvent = {
      event: "context.beforeAssemble",
      runId: "test-run",
      threadId: "test-thread",
      workspaceSlug: "test-workspace",
      cwd: "/test",
      userMessage: "$test-plugin:hello 帮我写个测试",
      availableTools: [],
      tokenBudget: 4000,
    };

    const result = await runtime.execute(event);
    const appendEffects = result.effects.filter(
      (e) => e.effect.type === "appendContext",
    );
    expect(appendEffects.length).toBeGreaterThanOrEqual(1);

    const skillEffect = appendEffects.find(
      (e) => (e.effect as unknown as Record<string, unknown>).source === "hook:plugin-skill-activation",
    );
    expect(skillEffect).toBeDefined();
    const effect = skillEffect!.effect as unknown as Record<string, unknown>;
    expect(effect.content).toContain("Hello skill instructions.");
    expect(effect.userMessageForModel).toContain("<activated_plugin_skills>");
    expect(effect.userMessageForModel).toContain("immediately execute the task in <user_request>");
    expect(effect.userMessageForModel).toContain("<user_request>\n帮我写个测试\n</user_request>");
  });
});
