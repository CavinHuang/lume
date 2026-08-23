import { describe, expect, test } from "bun:test";
import {
  acquireRuntimeActivityPlaceholder,
  isAgentRuntimeSessionActive,
  releaseRuntimeActivityPlaceholder,
  stopAgentRuntime,
} from "../attempt";

describe("runtime activity placeholder (#396)", () => {
  test("占位标记即刻可见，stop 后保留在位并记录中止信号，release 才回收", async () => {
    const threadId = `activity-test-${Date.now()}`;
    expect(isAgentRuntimeSessionActive(threadId)).toBe(false);

    acquireRuntimeActivityPlaceholder(threadId);
    expect(isAgentRuntimeSessionActive(threadId)).toBe(true);

    // 准备阶段 stop：占位 abort 记录信号但不删除条目（护栏窗口不得重开）
    expect(await stopAgentRuntime(threadId)).toBe(true);
    expect(isAgentRuntimeSessionActive(threadId)).toBe(true);

    // 仅占位形态可被 release 回收
    releaseRuntimeActivityPlaceholder(threadId);
    expect(isAgentRuntimeSessionActive(threadId)).toBe(false);
  });
});
