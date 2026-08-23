import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerRealAgentThreadStore } from "../agent-thread-store-test-adapter";

registerRealAgentThreadStore();
import { getThreadEventBus } from "../events/thread-event-bus";
import { createFileBackedLumeRunStateStore } from "../runtime-core/run-state-store";
import type { LumeRunState } from "../runtime-core/run-state";
import { listThreadRuntimeEvents, projectRunStateToReplayEvents } from "./runtime-event-history";

describe("runtime event history", () => {
  test("reopens a failed run with the user message but without the failed answer", () => {
    const run = {
      runId: "run-1",
      threadId: "thread-1",
      traceId: "trace-1",
      status: "failed",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:01.000Z",
      completedAt: "2026-08-01T00:00:01.000Z",
      input: { userMessage: "请重试" },
      model: { provider: "openai", modelId: "gpt", modelRef: "openai/gpt", channelId: "connection-1" },
      generatedItems: [{
        id: "assistant-1",
        type: "assistant_message",
        createdAt: "2026-08-01T00:00:00.500Z",
        content: [{ type: "text", text: "失败的临时输出" }],
      }],
      pendingInterruptions: [],
      approvals: { alwaysAllowedTools: [] },
      error: { code: "runtime_error", message: "network failed" },
    } as unknown as LumeRunState;

    expect(projectRunStateToReplayEvents(run).map((event) => event.type)).toEqual([
      "run.started",
      "message.user.submitted",
    ]);
  });

  test("F4: events.jsonl 有事件时 hydrate 只投保留类(新线程历史单读总线快照)", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "lume-hydrate-new-"));
    try {
      await createFileBackedLumeRunStateStore(sessionDir).create(completedRun("thread-hydrate-new"));
      await getThreadEventBus(sessionDir).publish("thread-hydrate-new", "run-h1", {
        runId: "run-h1",
        turnId: null,
        ts: 1,
        kind: "run",
        phase: "start",
        detail: { type: "run.start" }
      });

      const result = await listThreadRuntimeEvents({ sessionDir, threadId: "thread-hydrate-new" });
      expect(result.events.map((event) => event.type)).toEqual([
        "message.user.submitted",
        "plan.preview",
        "usage.updated"
      ]);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  test("F4: events.jsonl 为空时 hydrate 保持全量旧投影(旧线程向后兼容)", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "lume-hydrate-old-"));
    try {
      await createFileBackedLumeRunStateStore(sessionDir).create(completedRun("thread-hydrate-old"));

      const result = await listThreadRuntimeEvents({ sessionDir, threadId: "thread-hydrate-old" });
      expect(result.events.map((event) => event.type)).toEqual([
        "run.started",
        "message.user.submitted",
        "assistant.delta",
        "tool.started",
        "tool.completed",
        "plan.preview",
        "todo.state_updated",
        "usage.updated",
        "run.completed"
      ]);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});

function completedRun(threadId: string): LumeRunState {
  const createdAt = "2026-08-01T00:00:00.000Z";
  return {
    runId: "run-h1",
    threadId,
    traceId: "trace-h1",
    status: "completed",
    createdAt,
    updatedAt: "2026-08-01T00:00:02.000Z",
    completedAt: "2026-08-01T00:00:02.000Z",
    input: { userMessage: "总结一下" },
    model: { provider: "openai", modelId: "gpt", modelRef: "openai/gpt", channelId: "connection-1" },
    generatedItems: [
      {
        id: "assistant-1",
        type: "assistant_message",
        createdAt,
        content: [{ type: "text", text: "完成" }],
      },
      { id: "tool-1", type: "tool_call", createdAt, toolName: "bash", input: "echo hi" },
      { id: "tool-1", type: "tool_result", createdAt, toolCallId: "tool-1", toolName: "bash", output: "hi" },
      {
        id: "plan-1",
        type: "plan_preview",
        createdAt,
        contractId: "contract-1",
        title: "计划",
        summary: "摘要",
        markdown: "# 计划",
        stepCount: 1,
      },
      { id: "todo-1", type: "todo_state", createdAt, todos: [], currentActiveForm: null },
      {
        id: "result-1",
        type: "system_event",
        name: "result",
        createdAt,
        payload: {
          contextUsage: { contextWindow: 128000, inputTokens: 10, outputTokens: 5 },
          billingUsage: { cumulative: { inputTokens: 10, outputTokens: 5 }, records: [] }
        },
      },
    ],
    pendingInterruptions: [],
    approvals: { alwaysAllowedTools: [] },
  } as unknown as LumeRunState;
}
