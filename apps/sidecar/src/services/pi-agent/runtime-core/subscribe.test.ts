import { describe, expect, test } from "bun:test";
import {
  projectLifecycleRuntimeCoreEventToLumeEvents,
  projectMessageRuntimeCoreEventToLumeEvents,
  projectRuntimeCoreEventToLumeEvents,
  projectToolRuntimeCoreEventToLumeEvents
} from "./subscribe";
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

  test("lifecycle 层应只处理 auto_compaction 和 auto_retry", () => {
    const compactionStart = {
      type: "auto_compaction_start",
      reason: "threshold"
    } as AgentSessionEvent;
    const toolStart = {
      type: "tool_execution_start",
      toolName: "Read",
      toolCallId: "call_1",
      args: { path: "README.md" }
    } as unknown as AgentSessionEvent;

    expect(projectLifecycleRuntimeCoreEventToLumeEvents(compactionStart)).toEqual([{ type: "compacting" }]);
    expect(projectLifecycleRuntimeCoreEventToLumeEvents(toolStart)).toEqual(null);
  });

  test("message 层应处理 assistant message 事件", () => {
    const event = {
      type: "message_update",
      message: {} as never,
      assistantMessageEvent: { type: "text_delta", delta: "你好" }
    } as unknown as AgentSessionEvent;

    expect(projectMessageRuntimeCoreEventToLumeEvents(event)).toEqual([{ type: "text_delta", text: "你好" }]);
  });

  test("tool 层应处理 tool_execution 事件", () => {
    const event = {
      type: "tool_execution_start",
      toolName: "Read",
      toolCallId: "call_1",
      args: { path: "README.md" }
    } as unknown as AgentSessionEvent;

    const mapped = projectToolRuntimeCoreEventToLumeEvents(event);
    expect(mapped?.[0]?.type).toBe("tool_start");
  });
});
