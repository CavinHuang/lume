import { describe, expect, test } from "bun:test";
import { applyResolvedThinkingLevel } from "./thinking-level";

describe("thinking-level", () => {
  test("applies runtime thinking token budgets to agent", async () => {
    const calls: unknown[] = [];
    const agent = {
      async setMaxThinkingTokens(value: number | null) {
        calls.push(value);
      }
    };

    await applyResolvedThinkingLevel(agent, "high");
    await applyResolvedThinkingLevel(agent, "medium");
    await applyResolvedThinkingLevel(agent, "low");
    await applyResolvedThinkingLevel(agent, "xhigh");
    await applyResolvedThinkingLevel(agent, "off");

    expect(calls).toEqual([8192, 4096, 1024, 16384, null]);
  });

  test("does not call agent for auto thinking level", async () => {
    const calls: unknown[] = [];
    await applyResolvedThinkingLevel({
      async setMaxThinkingTokens(value: number | null) {
        calls.push(value);
      }
    }, "auto");

    expect(calls).toEqual([]);
  });
});
