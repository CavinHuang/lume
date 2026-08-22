import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { LumeRunItem } from "../agent-runtime/runner/run-items";
import { MemoryCommandService } from "./command-service";
import { getMemoryConfigPath } from "../infra/config-paths";
import { getMemoryV2ScopePaths } from "./paths";

/**
 * carriedBatches 暂存簿记回归（#450）：
 * - 连败不得丢先前暂存批（catch 必须基于开头取出的局部 carried）
 * - skip / 幂等短路路径必须把已取出的暂存批退回，而非随 cursor 消费丢弃
 */

let extractImpl: (input: unknown) => Promise<unknown>;

mock.module("./extraction", () => ({
  buildBatchExtractionUserPrompt: () => "",
  extractMemoryBatchCandidatesWithLlm: (input: unknown) => extractImpl(input),
  parseLlmBatchExtractionResponse: () => [],
  resolveMemoryExtractionModelRefs: () => []
}));

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lume-bg-extractor-"));
  process.env.LUME_CONFIG_DIR = root;
  process.env.LUME_LOG_FILE = "false";
  // 关闭 autoDream，避免成功路径的 dream 任务干扰断言
  writeFileSync(getMemoryConfigPath(), JSON.stringify({ version: 3, backgroundExtraction: true, autoDream: false }), "utf-8");
});

afterEach(() => {
  delete process.env.LUME_CONFIG_DIR;
  delete process.env.LUME_LOG_FILE;
  rmSync(root, { recursive: true, force: true });
});

function userItem(id: string): LumeRunItem {
  return { type: "user_message", id, content: `hello ${id}`, createdAt: new Date().toISOString() };
}

function cursorInfo(workspaceSlug: string, threadId: string): { status?: string; lastRunId?: string; cursor?: number } {
  const paths = getMemoryV2ScopePaths({ scope: "workspace", workspaceSlug });
  const path = join(paths.jobsDir, `extract-${threadId.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as { status?: string; lastRunId?: string; cursor?: number };
  } catch {
    return {};
  }
}

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("background extractor carried batches", () => {
  test("连败保留先前暂存批；skip 路径退回暂存批；成功后清空 (#450)", async () => {
    const { enqueueBackgroundMemoryExtraction, carriedBatchesForTests } = await import("./background-extractor");
    const workspaceSlug = "carried-ws";
    const threadId = "thread-carried";

    // 第一轮：提取失败 → itemsA 进暂存
    extractImpl = async () => {
      throw new Error("provider down");
    };
    enqueueBackgroundMemoryExtraction({ threadId, runId: "r1", workspaceSlug, items: [userItem("a1")] });
    await waitFor("first failure staged", () => carriedBatchesForTests(threadId).length === 1);

    // 第二轮连败：暂存必须是 [itemsA, itemsB]——修复前 get 已被开头 delete 清空，
    // 只放得回 [itemsB]，itemsA 永久丢失
    enqueueBackgroundMemoryExtraction({ threadId, runId: "r2", workspaceSlug, items: [userItem("b1")] });
    await waitFor("second failure keeps both batches", () => carriedBatchesForTests(threadId).length === 2);
    expect(carriedBatchesForTests(threadId).flat().map((item) => item.id)).toEqual(["a1", "b1"]);
    expect(cursorInfo(workspaceSlug, threadId).status).toBe("failed");

    // 第三轮命中 main_agent 显式记忆变更 → skip：cursor 前进但已并入的暂存批
    // 必须退回暂存（修复前随 skip 被静默消费丢弃），且当轮 itemsC 不入暂存
    await new MemoryCommandService().remember({
      workspaceSlug,
      content: "用户偏好深色主题",
      actor: "main_agent",
      runId: "r3"
    });
    enqueueBackgroundMemoryExtraction({ threadId, runId: "r3", workspaceSlug, items: [userItem("c1")] });
    await waitFor("skipped cursor", () =>
      cursorInfo(workspaceSlug, threadId).status === "skipped" && cursorInfo(workspaceSlug, threadId).lastRunId === "r3");
    expect(carriedBatchesForTests(threadId).flat().map((item) => item.id)).toEqual(["a1", "b1"]);

    // 第四轮提取成功：暂存消费清空，cursor 完成
    extractImpl = async () => [];
    enqueueBackgroundMemoryExtraction({ threadId, runId: "r4", workspaceSlug, items: [userItem("d1")] });
    await waitFor("completed cursor", () =>
      cursorInfo(workspaceSlug, threadId).status === "completed" && cursorInfo(workspaceSlug, threadId).lastRunId === "r4");
    expect(carriedBatchesForTests(threadId)).toEqual([]);
  }, 30000);
});
