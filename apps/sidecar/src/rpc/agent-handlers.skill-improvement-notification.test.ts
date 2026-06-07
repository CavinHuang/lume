import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_IPC_CHANNELS } from "@lume/shared";
import type { PlanModePhaseTracker } from "../services/agent/plan-mode-phase-tracker";
import { createAgentWorkspace } from "../services/agent/agent-workspace-manager";
import { createAgentHandlers } from "./agent-handlers";

const analyzeThreadWorkspaceSkillImprovementsMock = mock(async (_input: unknown) => [{
  workspaceSlug: "demo",
  storageScope: "workspace" as const,
  skillSlug: "planner",
  usageCount: 1,
  analyzedSessionIds: ["thread-1"],
  updates: [{
    section: "Rules",
    change: "Ask for constraints first",
    reason: "Thread feedback showed missing constraints"
  }]
}]);

function createTestPlanModePhaseTracker(): PlanModePhaseTracker {
  return {
    isLikelyExecutionRequest: () => false,
    getPhase: () => "idle",
    clearSession: () => undefined
  } as unknown as PlanModePhaseTracker;
}

function createHandlers(notifications: Array<{ method: string; params: unknown }>) {
  return createAgentHandlers({
    writeNotification: (method, params) => notifications.push({ method, params }),
    planModePhaseTracker: createTestPlanModePhaseTracker(),
    notifyPlanModePhaseChange: () => undefined,
    appendAgentMessage: (input, emit) => {
      emit.onComplete?.();
      return {
        ok: true,
        mode: "sent",
        queuedCount: 0,
        input
      };
    },
    analyzeThreadWorkspaceSkillImprovements: analyzeThreadWorkspaceSkillImprovementsMock
  });
}

describe("agent-handlers skill improvement notifications", () => {
  const previousConfigDir = process.env.LUME_CONFIG_DIR;

  afterEach(() => {
    analyzeThreadWorkspaceSkillImprovementsMock.mockClear();
    if (process.env.LUME_CONFIG_DIR) {
      rmSync(process.env.LUME_CONFIG_DIR, { recursive: true, force: true });
    }
    if (previousConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = previousConfigDir;
    }
  });

  test("emits skill improvement suggestions after a completed thread turn", async () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-skill-improvement-notify-"));
    const workspace = createAgentWorkspace("Demo", { slug: "demo" });
    const notifications: Array<{ method: string; params: unknown }> = [];
    const handlers = createHandlers(notifications);

    await handlers[AGENT_IPC_CHANNELS.SEND_THREAD_MESSAGE]!({
      threadId: "thread-1",
      workspaceId: workspace.id,
      userMessage: "use planner"
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(analyzeThreadWorkspaceSkillImprovementsMock).toHaveBeenCalledTimes(1);
    expect(analyzeThreadWorkspaceSkillImprovementsMock.mock.calls[0]?.[0]).toMatchObject({
      workspaceSlug: "demo",
      threadId: "thread-1",
      cwd: expect.stringContaining(join("agent-workspaces", "demo", "threads", "thread-1"))
    });
    expect(notifications).toContainEqual({
      method: AGENT_IPC_CHANNELS.SKILL_IMPROVEMENT_SUGGESTED,
      params: {
        threadId: "thread-1",
        workspaceSlug: "demo",
        suggestions: [{
          workspaceSlug: "demo",
          storageScope: "workspace",
          skillSlug: "planner",
          usageCount: 1,
          analyzedSessionIds: ["thread-1"],
          updates: [{
            section: "Rules",
            change: "Ask for constraints first",
            reason: "Thread feedback showed missing constraints"
          }]
        }]
      }
    });
  });
});
