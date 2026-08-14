import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileBackedRunContinuationStore } from "../runner/run-continuation-store";
import { createFileBackedLumeRunStateStore } from "../runner/run-state-store";
import type { LumeRunState } from "../runner/run-state";
import type { RunContinuationState } from "../runner/run-continuation";
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

  test("resumes a V2 approved tool from the persisted original input", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-resume-v2-approved-"));
    const runStateStore = createFileBackedLumeRunStateStore(dir);
    const continuationStore = createFileBackedRunContinuationStore(dir);
    await runStateStore.create(makeRunState());
    await continuationStore.upsert({
      version: 2,
      runId: "run-1",
      threadId: "thread-1",
      status: "ready_to_execute",
      checkpoint: {
        step: "before_tool_execution",
        toolCallId: "tool-1",
        toolName: "Read",
        toolKind: "read",
        toolCall: {
          id: "tool-1",
          name: "Read",
          input: { file_path: "README.md" },
          inputHash: "hash-1",
          kind: "read"
        }
      },
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:00:00.000Z"
    });

    let receivedInput: unknown;
    const result = await new LumeResumeService(
      { runStateStore, continuationStore },
      async (checkpoint) => {
        receivedInput = checkpoint.checkpoint.toolCall?.input;
        return { finalOutput: "resumed" };
      }
    ).resumeRun({ runId: "run-1" });

    expect(result.status).toBe("resumed");
    expect(receivedInput).toEqual({ file_path: "README.md" });
  });

  test("resumes an interrupted checkpoint via a plain continuation message without tool replay or injection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-resume-interrupted-read-"));
    const runStateStore = createFileBackedLumeRunStateStore(dir);
    const continuationStore = createFileBackedRunContinuationStore(dir);
    await runStateStore.create(makeRunState());
    await continuationStore.upsert({
      version: 2,
      runId: "run-1",
      threadId: "thread-1",
      status: "interrupted",
      checkpoint: {
        step: "waiting_for_tool_result",
        toolCallId: "tool-1",
        toolName: "Read",
        toolKind: "read",
        toolCall: {
          id: "tool-1",
          name: "Read",
          input: { file_path: "README.md" },
          inputHash: "hash-1",
          kind: "read"
        }
      },
      reason: "run 已被用户中止；恢复时从首个 pending 工具断点继续。",
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:00:00.000Z"
    });

    let received: RunContinuationState | undefined;
    const result = await new LumeResumeService(
      { runStateStore, continuationStore },
      async (checkpoint) => {
        received = checkpoint;
        return { finalOutput: "resumed" };
      }
    ).resumeRun({ runId: "run-1" });

    expect(result.status).toBe("resumed");
    // 直接续跑：checkpoint 原样传递，不经 ready_to_execute/ready_to_resume
    // 的工具重放/注入路径（历史中的 engine 占位已把配对补齐）。
    expect(received?.status).toBe("interrupted");
    expect(received?.checkpoint.step).toBe("waiting_for_tool_result");
    expect(received?.checkpoint.syntheticToolResult).toBeUndefined();
    expect((await continuationStore.get("run-1"))?.status).toBe("resumed");
  });

  test("resumes an interrupted execute checkpoint without injecting a duplicate tool result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-resume-interrupted-execute-"));
    const runStateStore = createFileBackedLumeRunStateStore(dir);
    const continuationStore = createFileBackedRunContinuationStore(dir);
    await runStateStore.create(makeRunState());
    await continuationStore.upsert({
      version: 2,
      runId: "run-1",
      threadId: "thread-1",
      status: "interrupted",
      checkpoint: {
        step: "waiting_for_tool_result",
        toolCallId: "tool-1",
        toolName: "Bash",
        toolKind: "execute",
        toolCall: {
          id: "tool-1",
          name: "Bash",
          input: { command: "rm -rf build" },
          inputHash: "hash-2",
          kind: "execute"
        }
      },
      reason: "run 已被用户中止；恢复时从首个 pending 工具断点继续。",
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:00:00.000Z"
    });

    let received: RunContinuationState | undefined;
    const result = await new LumeResumeService(
      { runStateStore, continuationStore },
      async (checkpoint) => {
        received = checkpoint;
        return { finalOutput: "resumed" };
      }
    ).resumeRun({ runId: "run-1" });

    expect(result.status).toBe("resumed");
    // 副作用工具同样不做 syntheticToolResult 注入：历史里的 engine 中断
    // 占位已配对同 id，注入会产生重复 tool_result。
    expect(received?.status).toBe("interrupted");
    expect(received?.checkpoint.syntheticToolResult).toBeUndefined();
    expect((await continuationStore.get("run-1"))?.status).toBe("resumed");
  });

  test("does not replay a V2 side-effect tool with an unknown result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-resume-v2-unknown-"));
    const runStateStore = createFileBackedLumeRunStateStore(dir);
    const continuationStore = createFileBackedRunContinuationStore(dir);
    await runStateStore.create(makeRunState());
    await continuationStore.upsert({
      version: 2,
      runId: "run-1",
      threadId: "thread-1",
      status: "tool_running",
      checkpoint: {
        step: "waiting_for_tool_result",
        toolCallId: "tool-1",
        toolName: "Write",
        toolKind: "write",
        toolCall: {
          id: "tool-1",
          name: "Write",
          input: { file_path: "out.txt", content: "value" },
          inputHash: "hash-2",
          kind: "write"
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
    expect(result.error).toContain("interrupted_unknown");
    expect((await continuationStore.get("run-1"))?.status).toBe("interrupted");
  });
});
