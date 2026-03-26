import { describe, expect, test } from "bun:test";
import type { ToolActivity } from "@/atoms/agent-atoms";
import { resolveAgentWatchdogIdleTimeoutMs } from "./agent-runtime-guard";

describe("agent-runtime-guard", () => {
  test("无活跃工具时 watchdog 超时应为 45 秒", () => {
    expect(resolveAgentWatchdogIdleTimeoutMs([])).toBe(45_000);
  });

  test("有普通活跃工具时 watchdog 超时应为 120 秒", () => {
    const activeTools: ToolActivity[] = [
      {
        toolUseId: "tool-1",
        toolName: "Read",
        input: {},
        done: false
      }
    ];

    expect(resolveAgentWatchdogIdleTimeoutMs(activeTools)).toBe(120_000);
  });

  test("有 web_search 活跃工具时 watchdog 超时应为 180 秒", () => {
    const activeTools: ToolActivity[] = [
      {
        toolUseId: "tool-1",
        toolName: "Read",
        input: {},
        done: false
      },
      {
        toolUseId: "tool-2",
        toolName: "web_search",
        input: {},
        done: false
      }
    ];

    expect(resolveAgentWatchdogIdleTimeoutMs(activeTools)).toBe(180_000);
  });
});
