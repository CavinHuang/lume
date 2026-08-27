import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_IPC_CHANNELS } from "@lume/shared";
import type { FileCheckpoint } from "@lume/agent-sdk";

/**
 * Coding 快照还原 handler 接线测试（#714）：走真实 checkpoint 服务 + 临时
 * LUME_CONFIG_DIR，钉死「Run 未结束拒绝 / runId 缺失拒绝 / 成功路径还原」边界。
 * isAgentRuntimeSessionActive / resolveAgentThreadWorkdir 以 mock.module 注入：
 * 工厂必须枚举全量导出（合跑共享 registry 时缺具名导出会毒害兄弟测试文件），
 * 且不得 import 真实 attempt 模块（其模块图在 test 侧挂死），门控真值由测试变量驱动。
 */

let sessionActive = false;
const workdirsByThread: Record<string, string> = {};

mock.module("../services/agent-runtime/runner/attempt", () => ({
  runRuntimeCoreAttempt: () => {
    throw new Error("not used in tests");
  },
  acquireRuntimeActivityPlaceholder: () => undefined,
  releaseRuntimeActivityPlaceholder: () => undefined,
  runAgentRuntime: () => {
    throw new Error("not used in tests");
  },
  stopAgentRuntime: async () => false,
  isAgentRuntimeSessionActive: (threadId: string) => sessionActive,
  stopAllAgentRuntimeSessions: async () => undefined,
}));
mock.module("../services/agent/agent-workdir-resolver", () => ({
  normalizeRealpathKey: (path: string) => path,
  assertExistingDirectory: (path: string) => path,
  deriveProjectName: (projectPath: string) => projectPath,
  getThreadFileContextId: (thread: { id: string }) => thread.id,
  ensureFileContextDirs: () => {
    throw new Error("not used in tests");
  },
  resolveAgentWorkdirForMeta: () => {
    throw new Error("not used in tests");
  },
  resolveAgentThreadWorkdir: (threadId: string) => ({ agentCwd: workdirsByThread[threadId] ?? "" }),
  resolveAgentThreadLumeWorkDir: () => {
    throw new Error("not used in tests");
  },
}));

describe("coding revert handlers(#714)", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";
  let handlers: Record<string, (params: unknown) => Promise<unknown>>;

  beforeEach(async () => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-coding-revert-handlers-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
    sessionActive = false;
    const { createCodingHandlers } = await import("./coding-handlers");
    handlers = createCodingHandlers();
  });

  afterEach(async () => {
    if (prevConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
    else process.env.LUME_CONFIG_DIR = prevConfigDir;
    if (tempConfigDir) {
      rmSync(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = "";
    }
  });

  async function persistFixture(threadId: string, cwd: string, runId: string): Promise<void> {
    const { getRuntimeCoreSessionDir } = await import("../services/agent-runtime/runtime-core/session-store");
    const { persistCodingRunCheckpoint } = await import(
      "../services/agent-runtime/runtime-core/coding-run-checkpoint-service"
    );
    const existingPath = join(cwd, "existing.ts");
    const createdPath = join(cwd, "created.ts");
    mkdirSync(cwd, { recursive: true });
    await writeFile(existingPath, "before\n", "utf8");
    const checkpoint: FileCheckpoint = {
      userMessageId: runId,
      createdAt: new Date().toISOString(),
      files: {
        [existingPath]: { path: existingPath, existed: true, content: "before\n", encoding: "utf8", lineEnding: "LF" },
        [createdPath]: { path: createdPath, existed: false },
      },
    };
    await writeFile(existingPath, "after\n", "utf8");
    await writeFile(createdPath, "created\n", "utf8");
    expect(await persistCodingRunCheckpoint({
      sessionDir: getRuntimeCoreSessionDir(threadId),
      runId,
      cwd,
      checkpoint,
    })).toBe(true);
  }

  test("门控：Coding Run 进行中时拒绝撤销", async () => {
    sessionActive = true;
    await expect(
      handlers[AGENT_IPC_CHANNELS.REVERT_CODING_RUN]!({ threadId: "t1", runId: "run-1" }),
    ).rejects.toThrow("Coding Run 尚未结束，无法撤销文件改动");
  });

  test("参数校验：runId 缺失直接拒绝且不触碰文件系统", async () => {
    await expect(
      handlers[AGENT_IPC_CHANNELS.REVERT_CODING_RUN]!({ threadId: "t1" }),
    ).rejects.toThrow("参数非法");
    sessionActive = true;
    // 门控在 schema 之后：缺 runId 时即便会话活跃也先报参数错，而非门控文案
    await expect(
      handlers[AGENT_IPC_CHANNELS.REVERT_CODING_RUN]!({ threadId: "t1" }),
    ).rejects.toThrow("参数非法");
  });

  test("成功路径：按快照还原改动并删除 Run 新建文件", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lume-coding-revert-cwd-"));
    try {
      await persistFixture("t-success", cwd, "run-1");
      const result = (await handlers[AGENT_IPC_CHANNELS.REVERT_CODING_RUN]!({
        threadId: "t-success",
        runId: "run-1",
      })) as {
        status: string;
        filesChanged: string[];
        conflicts: string[];
        committedPaths: string[];
        failedFiles: string[];
      };

      expect(result.status).toBe("restored");
      expect(result.filesChanged).toHaveLength(2);
      expect(result.conflicts).toEqual([]);
      expect(result.committedPaths).toEqual([]);
      expect(result.failedFiles).toEqual([]);
      expect(await readFile(join(cwd, "existing.ts"), "utf8")).toBe("before\n");
      await expect(readFile(join(cwd, "created.ts"), "utf8")).rejects.toThrow();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("单文件通道：REVERT_CODING_FILE 只还原指定路径（rootId 缺省走 agentCwd）", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lume-coding-revert-file-"));
    try {
      workdirsByThread["t-file"] = cwd;
      await persistFixture("t-file", cwd, "run-file");
      const result = (await handlers[AGENT_IPC_CHANNELS.REVERT_CODING_FILE]!({
        threadId: "t-file",
        runId: "run-file",
        path: join(cwd, "existing.ts"),
      })) as { status: string; filesChanged: string[] };

      expect(result.status).toBe("restored");
      expect(result.filesChanged).toEqual([join(cwd, "existing.ts")]);
      expect(await readFile(join(cwd, "existing.ts"), "utf8")).toBe("before\n");
      // 另一文件不受影响
      expect(await readFile(join(cwd, "created.ts"), "utf8")).toBe("created\n");
    } finally {
      delete workdirsByThread["t-file"];
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
