import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_IPC_CHANNELS } from "@lume/shared";
import type { PlanModePhaseTracker } from "../services/agent/plan-mode-phase-tracker";
import { getWorkspaceSkillsDir } from "../services/infra/config-paths";

function withTempConfigDir(): () => void {
  const previous = process.env.LUME_CONFIG_DIR;
  const next = join(tmpdir(), `lume-agent-handlers-skill-evolution-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  process.env.LUME_CONFIG_DIR = next;
  return () => {
    if (previous === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = previous;
    }
    rmSync(next, { recursive: true, force: true });
  };
}

function createTestPlanModePhaseTracker(): PlanModePhaseTracker {
  return {
    isLikelyExecutionRequest: () => false,
    getPhase: () => "idle",
    clearSession: () => undefined
  } as unknown as PlanModePhaseTracker;
}

async function createHandlers() {
  const { createAgentHandlers } = await import("./agent-handlers");
  return createAgentHandlers({
    writeNotification: () => undefined,
    planModePhaseTracker: createTestPlanModePhaseTracker(),
    notifyPlanModePhaseChange: () => undefined
  });
}

describe("agent-handlers skill evolution RPC", () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  test("lists and restores workspace skill versions", async () => {
    cleanup = withTempConfigDir();
    const skillDir = join(getWorkspaceSkillsDir("demo"), "planner");
    mkdirSync(join(skillDir, ".versions"), { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    writeFileSync(skillPath, "# Planner\n\nChanged.", "utf-8");
    writeFileSync(join(skillDir, ".versions", "SKILL_20260605_010203_abcd.md"), "# Planner\n\nOriginal.", "utf-8");

    const handlers = await createHandlers();
    const versions = await handlers[AGENT_IPC_CHANNELS.LIST_SKILL_VERSIONS]!({
      workspaceSlug: "demo",
      skillSlug: "planner"
    }) as Array<{ filename: string }>;

    expect(versions.map((item) => item.filename)).toEqual(["SKILL_20260605_010203_abcd.md"]);

    const restored = await handlers[AGENT_IPC_CHANNELS.RESTORE_SKILL_VERSION]!({
      workspaceSlug: "demo",
      skillSlug: "planner",
      filename: "SKILL_20260605_010203_abcd.md"
    }) as { success: boolean };

    expect(restored.success).toBe(true);
    expect(readFileSync(skillPath, "utf-8")).toBe("# Planner\n\nOriginal.");
  });

  test("analyzes workspace skill improvement suggestions", async () => {
    cleanup = withTempConfigDir();
    const skillDir = join(getWorkspaceSkillsDir("demo"), "planner");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Planner\n\nCurrent.", "utf-8");

    const handlers = await createHandlers();
    const result = await handlers[AGENT_IPC_CHANNELS.ANALYZE_SKILL_IMPROVEMENT]!({
      workspaceSlug: "demo",
      skillSlug: "planner"
    }) as { skillSlug: string; usageCount: number; analyzedSessionIds: string[]; updates: unknown[] };

    expect(result).toEqual({
      skillSlug: "planner",
      usageCount: 0,
      analyzedSessionIds: [],
      updates: []
    });
  });

  test("applies workspace skill improvement suggestions", async () => {
    cleanup = withTempConfigDir();
    const skillDir = join(getWorkspaceSkillsDir("demo"), "planner");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Planner\n\nCurrent.", "utf-8");

    const handlers = await createHandlers();
    const result = await handlers[AGENT_IPC_CHANNELS.APPLY_SKILL_IMPROVEMENT]!({
      workspaceSlug: "demo",
      skillSlug: "planner",
      updates: []
    }) as { success: boolean; error?: string };

    expect(result).toEqual({
      success: false,
      error: "没有改进建议"
    });
  });

  test("saves editable workspace skill fields through RPC", async () => {
    cleanup = withTempConfigDir();

    const handlers = await createHandlers();
    const result = await handlers[AGENT_IPC_CHANNELS.SAVE_SKILL]!({
      workspaceSlug: "demo",
      skillSlug: "planner",
      name: "Planner",
      description: "Plans work.",
      whenToUse: "When planning is needed.",
      allowedTools: ["bash"],
      argumentHint: "Task description",
      disableModelInvocation: false,
      version: "1.0.0",
      prompt: "Plan ${ARG}."
    }) as { ok: boolean; skill: { slug: string; name: string; allowedTools?: string[] } };

    expect(result.ok).toBe(true);
    expect(result.skill).toMatchObject({
      slug: "planner",
      name: "Planner",
      allowedTools: ["bash"]
    });
    expect(readFileSync(join(getWorkspaceSkillsDir("demo"), "planner", "SKILL.md"), "utf-8"))
      .toContain("Plan ${ARG}.\n");
  });

  test("lists and reads editable user-global skills through RPC", async () => {
    cleanup = withTempConfigDir();

    const handlers = await createHandlers();
    await handlers[AGENT_IPC_CHANNELS.SAVE_SKILL]!({
      storageScope: "user",
      workspaceSlug: "demo",
      skillSlug: "global-planner",
      name: "Global Planner",
      description: "Plans work across workspaces.",
      whenToUse: "When the user asks for a reusable plan.",
      prompt: "Global prompt."
    });

    const skills = await handlers[AGENT_IPC_CHANNELS.LIST_EDITABLE_SKILLS]!({
      workspaceSlug: "demo"
    }) as Array<{
      storageScope: string;
      managementSurface?: string;
      slug: string;
      name: string;
      description?: string;
      whenToUse?: string;
      disableModelInvocation?: boolean;
    }>;

    expect(skills).toEqual([{
      storageScope: "user",
      managementSurface: "settings",
      slug: "global-planner",
      name: "Global Planner",
      description: "Plans work across workspaces.",
      whenToUse: "When the user asks for a reusable plan.",
      disableModelInvocation: false
    }]);

    const detail = await handlers[AGENT_IPC_CHANNELS.GET_EDITABLE_SKILL]!({
      storageScope: "user",
      workspaceSlug: "demo",
      skillSlug: "global-planner"
    }) as { content: string; skill: { storageScope: string; slug: string } };

    expect(detail.skill).toMatchObject({
      storageScope: "user",
      slug: "global-planner"
    });
    expect(detail.content).toContain("Global prompt.");
  });
});
