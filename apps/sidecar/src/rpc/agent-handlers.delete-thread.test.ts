import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_IPC_CHANNELS } from "@lume/shared";
import type { PlanModePhaseTracker } from "../services/agent/plan-mode-phase-tracker";

let runtimeSessionActive = false;

mock.module("../services/agent-runtime/runner/attempt", () => ({
  isAgentRuntimeSessionActive: () => runtimeSessionActive
}));

import { createAgentHandlers } from "./agent-handlers";
import { createAgentThread } from "../services/agent/agent-thread-manager";
import { resolveAgentThreadWorkdir } from "../services/agent/agent-workdir-resolver";
import { createAgentWorkspace } from "../services/agent/agent-workspace-manager";

function createTestPlanModePhaseTracker(): PlanModePhaseTracker {
  return {
    getPhase: () => "idle",
    clearSession: () => undefined
  } as unknown as PlanModePhaseTracker;
}

describe("agent-handlers delete-thread guard", () => {
  const previousConfigDir = process.env.LUME_CONFIG_DIR;

  afterEach(() => {
    runtimeSessionActive = false;
    // 不在此处 rmSync 临时目录：Windows 上删除线程后的句柄释放是异步的，
    // 立即清理会 EBUSY；临时目录交给系统 temp 清理。
    if (previousConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = previousConfigDir;
    }
  });

  function setup(): { threadId: string; workdir: string; handlers: ReturnType<typeof createAgentHandlers> } {
    const configDir = mkdtempSync(join(tmpdir(), "lume-delete-thread-guard-"));
    process.env.LUME_CONFIG_DIR = configDir;
    const projectPath = join(configDir, "project");
    mkdirSync(projectPath, { recursive: true });
    const workspace = createAgentWorkspace("Default", { projectPath });
    const thread = createAgentThread("deletable thread", undefined, workspace.id);
    const handlers = createAgentHandlers({
      writeNotification: () => undefined,
      planModePhaseTracker: createTestPlanModePhaseTracker(),
      notifyPlanModePhaseChange: () => undefined
    });
    return { threadId: thread.id, workdir: resolveAgentThreadWorkdir(thread.id).lumeWorkDir, handlers };
  }

  test("运行中的线程不能被直接删除，其资源保持原样", async () => {
    const { threadId, workdir, handlers } = setup();
    runtimeSessionActive = true;

    let error: unknown;
    try {
      await handlers[AGENT_IPC_CHANNELS.DELETE_THREAD]!({ threadId });
    } catch (caught) {
      error = caught;
    }
    expect(error instanceof Error && error.message).toBe("线程正在运行中，请停止后再删除。");
    expect(existsSync(workdir)).toBe(true);
  });

  test("非活动线程删除行为不变", async () => {
    const { threadId, workdir, handlers } = setup();
    runtimeSessionActive = false;

    const result = await handlers[AGENT_IPC_CHANNELS.DELETE_THREAD]!({ threadId });
    expect(result).toEqual({ ok: true });
    expect(existsSync(workdir)).toBe(false);
  });
});
