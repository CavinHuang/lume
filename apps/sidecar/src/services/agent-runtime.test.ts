import { describe, expect, test } from "bun:test";
import { resolveAgentRuntime } from "./agent-runtime";

describe("agent-runtime", () => {
  test("默认应返回 pi_agent", () => {
    expect(resolveAgentRuntime(undefined)).toBe("pi_agent");
  });

  test("显式配置 pi_agent 时应返回 pi_agent", () => {
    expect(resolveAgentRuntime("pi_agent")).toBe("pi_agent");
    expect(resolveAgentRuntime("PI_AGENT")).toBe("pi_agent");
  });

  test("未知值应回退 pi_agent", () => {
    expect(resolveAgentRuntime("unknown")).toBe("pi_agent");
  });

  test("claude_sdk 也应回退到 pi_agent", () => {
    expect(resolveAgentRuntime("claude_sdk")).toBe("pi_agent");
  });
});
