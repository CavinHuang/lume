import { describe, expect, test } from "bun:test";
import type { LumeRunState } from "../runner/run-state";
import { projectRunStateToReplayEvents } from "./runtime-event-history";

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
});
