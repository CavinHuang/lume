import { describe, expect, test } from "bun:test";
import { projectRuntimeCoreEventToLumeEvents } from "./subscribe";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";

describe("runtime-core subscribe", () => {
  test("应将自动压缩开始映射为 compacting", () => {
    const event = {
      type: "auto_compaction_start",
      reason: "threshold"
    } as AgentSessionEvent;

    expect(projectRuntimeCoreEventToLumeEvents(event)).toEqual([{ type: "compacting" }]);
  });

  test("应将自动压缩结束映射为 compact_complete", () => {
    const event = {
      type: "auto_compaction_end",
      result: undefined,
      aborted: false,
      willRetry: false
    } as AgentSessionEvent;

    expect(projectRuntimeCoreEventToLumeEvents(event)).toEqual([{ type: "compact_complete" }]);
  });

  test("应继续忽略 auto retry 事件", () => {
    const event = {
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1000,
      errorMessage: "retry"
    } as AgentSessionEvent;

    expect(projectRuntimeCoreEventToLumeEvents(event)).toEqual([]);
  });
});
