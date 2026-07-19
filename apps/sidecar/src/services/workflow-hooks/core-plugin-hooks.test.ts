import { describe, expect, test } from "bun:test";
import { createCorePluginHookHandlers } from "./core-plugin-hooks";

describe("core.plugin.skill-activation", () => {
  test("does not grant plugin authority from legacy dollar syntax", async () => {
    const handler = createCorePluginHookHandlers()["core.plugin.skill-activation"]!;
    const result = await handler({
      event: "context.beforeAssemble",
      runId: "test-run",
      threadId: "test-thread",
      userMessage: "$test-plugin:hello do work",
      availableTools: [],
      tokenBudget: 4_000,
    } as any, {} as any);

    expect(result.effects).toEqual([]);
  });
});
