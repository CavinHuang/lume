import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileBackedRunContinuationStore } from "../runner/run-continuation-store";
import { createFileBackedLumeRunStateStore } from "../runner/run-state-store";
import type { LumeRunState } from "../runner/run-state";
import { LumeResumeService } from "./resume-service";

function makeRunState(input?: Partial<LumeRunState>): LumeRunState {
  const now = "2026-04-29T00:00:00.000Z";
  return {
    version: 1,
    runId: "run-1",
    threadId: "thread-1",
    rootAgentId: "root",
    currentAgentId: "root",
    status: "running",
    input: { userMessage: "hello" },
    generatedItems: [],
    pendingInterruptions: [],
    approvals: { alwaysAllowedTools: [] },
    traceId: "trace-1",
    model: { provider: "openai", modelId: "gpt-test" },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    createdAt: now,
    updatedAt: now,
    ...input
  };
}

describe("LumeResumeService", () => {
  test("returns waiting status while persisted interruptions are still pending", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-resume-waiting-"));
    const runStateStore = createFileBackedLumeRunStateStore(dir);
    const continuationStore = createFileBackedRunContinuationStore(dir);
    await runStateStore.create(makeRunState({
      status: "waiting_for_user",
      pendingInterruptions: [{
        id: "ask_user:1",
        threadId: "thread-1",
        type: "ask_user",
        status: "pending",
        title: "Need answer",
        message: "Q",
        payload: {},
        source: {},
        createdAt: "2026-04-29T00:00:00.000Z",
        updatedAt: "2026-04-29T00:00:00.000Z"
      }]
    }));

    const result = await new LumeResumeService({ runStateStore, continuationStore }).resumeRun({ runId: "run-1" });

    expect(result).toEqual({ status: "waiting_for_user" });
  });

  test("resumes from a ready checkpoint through the registered continuation runner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-resume-ready-"));
    const runStateStore = createFileBackedLumeRunStateStore(dir);
    const continuationStore = createFileBackedRunContinuationStore(dir);
    await runStateStore.create(makeRunState());
    await continuationStore.upsert({
      version: 1,
      runId: "run-1",
      threadId: "thread-1",
      status: "ready_to_resume",
      checkpoint: {
        step: "after_tool_result",
        toolCallId: "tool-1",
        toolName: "Read",
        toolKind: "read",
        syntheticToolResult: "content"
      },
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:00:00.000Z"
    });

    const result = await new LumeResumeService(
      { runStateStore, continuationStore },
      async (checkpoint) => ({ finalOutput: `resumed:${checkpoint.checkpoint.toolName}` })
    ).resumeRun({ runId: "run-1" });

    expect(result).toEqual({
      status: "resumed",
      finalOutput: "resumed:Read"
    });
    expect((await continuationStore.get("run-1"))?.status).toBe("resumed");
  });

  test("does not cold-start resume interrupted execute tools", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-resume-execute-"));
    const runStateStore = createFileBackedLumeRunStateStore(dir);
    const continuationStore = createFileBackedRunContinuationStore(dir);
    await runStateStore.create(makeRunState());
    await continuationStore.upsert({
      version: 1,
      runId: "run-1",
      threadId: "thread-1",
      status: "ready_to_resume",
      checkpoint: {
        step: "waiting_for_tool_result",
        toolCallId: "tool-1",
        toolName: "Bash",
        toolKind: "execute"
      },
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:00:00.000Z"
    });

    const result = await new LumeResumeService({ runStateStore, continuationStore }).resumeRun({ runId: "run-1" });

    expect(result.status).toBe("not_resumable");
    expect(result.error).toContain("执行型工具不可冷启动恢复");
  });

  test("does not cold-start resume approved tool-approval checkpoints as replan messages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-resume-approved-execute-"));
    const runStateStore = createFileBackedLumeRunStateStore(dir);
    const continuationStore = createFileBackedRunContinuationStore(dir);
    await runStateStore.create(makeRunState());
    await continuationStore.upsert({
      version: 1,
      runId: "run-1",
      threadId: "thread-1",
      status: "ready_to_resume",
      checkpoint: {
        step: "before_model_call",
        toolCallId: "tool-1",
        toolName: "Bash",
        toolKind: "execute",
        syntheticToolResult: {
          status: "approved",
          decision: "allow_once"
        }
      },
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:00:00.000Z"
    });

    const result = await new LumeResumeService(
      { runStateStore, continuationStore },
      async () => ({ finalOutput: "should-not-run" })
    ).resumeRun({ runId: "run-1" });

    expect(result.status).toBe("not_resumable");
    expect(result.error).toContain("工具审批 checkpoint 不支持冷启动恢复");
    expect((await continuationStore.get("run-1"))?.status).toBe("not_resumable");
  });

  test("does not cold-start resume approval checkpoints without injectable tool result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-resume-missing-result-"));
    const runStateStore = createFileBackedLumeRunStateStore(dir);
    const continuationStore = createFileBackedRunContinuationStore(dir);
    await runStateStore.create(makeRunState());
    await continuationStore.upsert({
      version: 1,
      runId: "run-1",
      threadId: "thread-1",
      status: "ready_to_resume",
      checkpoint: {
        step: "waiting_for_tool_result",
        toolCallId: "tool-1",
        toolName: "Read",
        toolKind: "read"
      },
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:00:00.000Z"
    });

    const result = await new LumeResumeService(
      { runStateStore, continuationStore },
      async () => ({ finalOutput: "should-not-run" })
    ).resumeRun({ runId: "run-1" });

    expect(result.status).toBe("not_resumable");
    expect(result.error).toContain("缺少可注入的工具结果");
    expect((await continuationStore.get("run-1"))?.status).toBe("not_resumable");
  });
});
