import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@lume/agent-sdk";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendAgentThreadSDKMessages, createAgentThread } from "../agent/agent-thread-manager";
import { createAgentWorkspace } from "../agent/agent-workspace-manager";
import { buildDreamEvidenceWindow, loadDreamEvidenceForJob } from "./dream-evidence";
import { memoryJobService } from "./job-service";
import { createMemoryV2Store } from "./markdown-store";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lume-dream-evidence-"));
  process.env.LUME_CONFIG_DIR = root;
});

afterEach(async () => {
  await memoryJobService.waitForSettled();
  delete process.env.LUME_CONFIG_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe("DreamEvidenceService", () => {
  test("captures only private main threads and enforces the 20 thread/100 run bound", () => {
    const workspace = createAgentWorkspace("Demo", { slug: "demo" });
    const store = createMemoryV2Store();
    const now = Date.now();
    const eligible = Array.from({ length: 21 }, (_, index) => createAgentThread(`Main ${index}`, undefined, workspace.id));
    const parent = eligible[0]!;
    const subagent = createAgentThread("Subagent", undefined, workspace.id, parent.id);
    const group = createAgentThread("Group", undefined, workspace.id);
    for (const [index, thread] of eligible.entries()) {
      appendCompletedRun(store, thread.id, `run-${index}`, now + index, "private");
    }
    appendCompletedRun(store, subagent.id, "run-subagent", now + 30, "private", "subagent");
    appendCompletedRun(store, group.id, "run-group", now + 31, "group");

    const window = buildDreamEvidenceWindow({ workspaceSlug: "demo", cursor: now - 1, upperBound: now + 100 });

    expect(window.sessionsAvailable).toBe(21);
    expect(window.threadIds).toHaveLength(20);
    expect(window.runIds).toHaveLength(20);
    expect(window.runIds).not.toContain("run-subagent");
    expect(window.runIds).not.toContain("run-group");
    expect(window.hasMore).toBe(true);
  });

  test("loads only the captured run transcript through an opaque job window", async () => {
    const workspace = createAgentWorkspace("Demo", { slug: "demo" });
    const thread = createAgentThread("Main", undefined, workspace.id);
    const excluded = createAgentThread("Later", undefined, workspace.id);
    const store = createMemoryV2Store();
    const now = Date.now();
    appendCompletedRun(store, thread.id, "captured", now, "private", "main", "请记住我默认使用中文，password=hunter2");
    appendCompletedRun(store, excluded.id, "later", now + 10, "private", "main", "不要进入本轮");
    appendAgentThreadSDKMessages(thread.id, [{
      type: "assistant",
      uuid: "assistant-1",
      session_id: thread.id,
      run_id: "captured",
      parent_tool_use_id: null,
      message: { role: "assistant", content: [{ type: "text", text: "已确认用户偏好" }] }
    } as SDKMessage]);
    const window = buildDreamEvidenceWindow({ workspaceSlug: "demo", cursor: now - 1, upperBound: now + 1 });
    const job = memoryJobService.start({
      kind: "consolidation",
      workspaceSlug: "demo",
      payload: { evidenceWindow: window },
      run: async () => ({ ok: true })
    });

    const evidence = loadDreamEvidenceForJob("demo", job.jobId);

    expect(evidence.some((item) => item.sourceType === "user_message" && item.text.includes("默认使用中文"))).toBe(true);
    expect(evidence.some((item) => item.sourceType === "assistant_message" && item.text.includes("已确认"))).toBe(true);
    expect(evidence.some((item) => item.text.includes("不要进入本轮"))).toBe(false);
    expect(evidence.some((item) => item.text.includes("hunter2"))).toBe(false);
    expect(evidence.every((item) => item.id.startsWith("dream-evidence:"))).toBe(true);
  });

  test("does not lose a trailing run that shares the cursor timestamp", () => {
    const workspace = createAgentWorkspace("Demo", { slug: "demo" });
    const store = createMemoryV2Store();
    const timestamp = Date.now();
    for (let index = 0; index < 21; index += 1) {
      const thread = createAgentThread(`Thread ${index}`, undefined, workspace.id);
      appendCompletedRun(store, thread.id, `same-time-${String(index).padStart(2, "0")}`, timestamp, "private");
    }

    const first = buildDreamEvidenceWindow({ workspaceSlug: "demo", cursor: timestamp - 1, upperBound: timestamp });
    const trailing = buildDreamEvidenceWindow({
      workspaceSlug: "demo",
      cursor: { createdAt: first.to, runId: first.toRunId! },
      upperBound: timestamp
    });

    expect(first.runIds).toHaveLength(20);
    expect(trailing.runIds).toEqual(["same-time-20"]);
  });
});

function appendCompletedRun(
  store: ReturnType<typeof createMemoryV2Store>,
  threadId: string,
  runId: string,
  createdAt: number,
  chatType: "private" | "group",
  threadType: "main" | "subagent" = "main",
  userMessage = `message-${runId}`
): void {
  store.appendRunArchive({
    workspaceSlug: "demo",
    runId,
    record: {
      type: "run.completed",
      threadId,
      threadType,
      chatType,
      userMessage,
      summary: `summary-${runId}`,
      createdAt: new Date(createdAt).toISOString()
    }
  });
}
