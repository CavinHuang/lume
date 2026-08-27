import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileBackedLumeInterruptionStore,
  resolveFileBackedInterruptionSync
} from "./interruption-store";
import { createFileBackedLumeRunStateStore } from "../runtime-core/run-state-store";
import type { LumeRunState } from "../runtime-core/run-state";

function makeRunState(runId: string): LumeRunState {
  const now = "2026-04-29T00:00:00.000Z";
  return {
    version: 1,
    runId,
    threadId: "thread-1",
    rootAgentId: "root",
    currentAgentId: "root",
    status: "running",
    input: {
      userMessage: "hello"
    },
    generatedItems: [],
    pendingInterruptions: [],
    approvals: {
      alwaysAllowedTools: []
    },
    traceId: "trace-1",
    model: {
      provider: "openai",
      modelId: "gpt-test"
    },
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    },
    createdAt: now,
    updatedAt: now
  };
}

describe("interruption-store", () => {
  test("persists pending interruptions and resolution state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-interruption-store-"));
    const store = createFileBackedLumeInterruptionStore(dir);

    await store.upsert({
      id: "tool_approval:req-1",
      threadId: "thread-1",
      type: "tool_approval",
      status: "pending",
      title: "Approve tool",
      message: "Bash needs approval",
      payload: { toolName: "Bash" },
      source: {
        toolName: "Bash",
        toolCallId: "req-1"
      },
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:00:00.000Z"
    });

    expect((await store.listPendingByThread("thread-1")).map((item) => item.id)).toEqual(["tool_approval:req-1"]);

    await store.resolve("tool_approval:req-1", {
      status: "approved",
      resolution: {
        decision: "approve",
        rememberDecision: true
      }
    });

    const resolved = await store.get("tool_approval:req-1");
    expect(resolved?.status).toBe("approved");
    expect(resolved?.resolution?.rememberDecision).toBeTrue();
    expect(await store.listPendingByThread("thread-1")).toEqual([]);
  });

  test("persists interruption ids with Windows-safe filenames", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-interruption-safe-filename-"));
    const store = createFileBackedLumeInterruptionStore(dir);
    const interruptionId = "tool_approval:chatcmpl-tool-aff3844795842db8";

    await store.upsert({
      id: interruptionId,
      threadId: "thread-1",
      type: "tool_approval",
      status: "pending",
      title: "Approve tool",
      message: "node_repl needs approval",
      payload: { requestId: "chatcmpl-tool-aff3844795842db8" },
      source: { toolCallId: "chatcmpl-tool-aff3844795842db8" },
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:00:00.000Z"
    });

    const files = readdirSync(join(dir, "interruptions"));
    expect(files.some((file) => file.includes(":"))).toBeFalse();
    expect(await store.get(interruptionId)).toMatchObject({ id: interruptionId });
  });

  test("mirrors pending and resolved interruptions into active run state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-interruption-run-state-"));
    const runStore = createFileBackedLumeRunStateStore(dir);
    const store = createFileBackedLumeInterruptionStore(dir);
    await runStore.create(makeRunState("run-1"));

    await store.upsert({
      id: "ask_user:ask-1",
      runId: "run-1",
      threadId: "thread-1",
      type: "ask_user",
      status: "pending",
      title: "Need answer",
      message: "Pick one",
      payload: { toolUseId: "ask-1" },
      source: { toolCallId: "ask-1" },
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:00:00.000Z"
    });

    expect((await runStore.get("run-1"))?.status).toBe("waiting_for_user");
    expect((await runStore.get("run-1"))?.pendingInterruptions.map((item) => item.id)).toEqual(["ask_user:ask-1"]);

    await store.resolve("ask_user:ask-1", {
      status: "approved",
      resolution: {
        decision: "answer",
        answer: { choice: "A" }
      }
    });

    const state = await runStore.get("run-1");
    expect(state?.status).toBe("running");
    expect(state?.pendingInterruptions).toEqual([]);
  });

  test("sync persisted resolution also mirrors into run state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-interruption-sync-resolution-"));
    const runStore = createFileBackedLumeRunStateStore(dir);
    const store = createFileBackedLumeInterruptionStore(dir);
    await runStore.create(makeRunState("run-1"));

    await store.upsert({
      id: "tool_approval:req-1",
      runId: "run-1",
      threadId: "thread-1",
      type: "tool_approval",
      status: "pending",
      title: "Approve tool",
      message: "Bash needs approval",
      payload: { requestId: "req-1" },
      source: { toolCallId: "tool-1" },
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:00:00.000Z"
    });

    expect((await runStore.get("run-1"))?.status).toBe("waiting_for_approval");

    expect(resolveFileBackedInterruptionSync(dir, "tool_approval:req-1", {
      status: "approved",
      resolution: { decision: "approve" }
    })).toBeTrue();

    const state = await runStore.get("run-1");
    expect(state?.status).toBe("running");
    expect(state?.pendingInterruptions).toEqual([]);
  });

  test("resolve 拒绝翻转已终态记录（防竞态守卫）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-interruption-guard-"));
    const store = createFileBackedLumeInterruptionStore(dir);

    await store.upsert({
      id: "tool_approval:req-guard",
      threadId: "thread-1",
      type: "tool_approval",
      status: "pending",
      title: "Approve tool",
      message: "Bash needs approval",
      payload: { requestId: "req-guard" },
      source: { toolCallId: "tool-guard" },
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:00:00.000Z"
    });

    // 先取消（rejected），随后迟到的 approve 不得翻转终态
    expect(resolveFileBackedInterruptionSync(dir, "tool_approval:req-guard", {
      status: "rejected",
      resolution: { decision: "reject" }
    })).toBeTrue();
    expect(resolveFileBackedInterruptionSync(dir, "tool_approval:req-guard", {
      status: "approved",
      resolution: { decision: "approve" }
    })).toBeFalse();

    const current = await store.get("tool_approval:req-guard");
    expect(current?.status).toBe("rejected");
  });
});
