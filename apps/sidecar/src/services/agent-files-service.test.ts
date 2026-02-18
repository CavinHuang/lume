import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  deleteAgentPlan,
  getAgentSessionPath,
  listAgentPlans,
  readAgentPlan
} from "./agent-files-service";

const createdDirs: string[] = [];
const originalConfigDir = process.env.LUME_CONFIG_DIR;

function createTempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lume-agent-files-"));
  createdDirs.push(dir);
  process.env.LUME_CONFIG_DIR = dir;
  return dir;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  process.env.LUME_CONFIG_DIR = originalConfigDir;
});

describe("agent-files-service plans", () => {
  test("应支持 list/read/delete plan 文件", () => {
    createTempConfigDir();
    const workspaceSlug = "workspace-a";
    const sessionId = "session-a";
    const sessionDir = getAgentSessionPath(workspaceSlug, sessionId);
    const plansDir = join(sessionDir, "plans");
    mkdirSync(plansDir, { recursive: true });

    const planFileName = "20260218-demo-plan.md";
    const planPath = join(plansDir, planFileName);
    writeFileSync(
      planPath,
      "---\nsummary: \"演示计划\"\ncreated: 2026-02-18T00:00:00.000Z\nslug: 20260218-demo-plan\n---\n# Plan\nstep 1\n",
      "utf-8"
    );
    writeFileSync(join(plansDir, "plan.md"), "# latest\n", "utf-8");

    const plans = listAgentPlans(workspaceSlug, sessionId);
    expect(plans.length).toBe(2);
    expect(plans.some((item) => item.name === planFileName)).toBeTrue();
    const targetPlan = plans.find((item) => item.name === planFileName);
    expect(targetPlan?.summary).toBe("演示计划");

    const readResult = readAgentPlan(workspaceSlug, sessionId, planFileName);
    expect(readResult.path.endsWith(`/plans/${planFileName}`) || readResult.path.endsWith(`\\plans\\${planFileName}`)).toBeTrue();
    expect(readResult.content.includes("step 1")).toBeTrue();

    const deleteResult = deleteAgentPlan(workspaceSlug, sessionId, planFileName);
    expect(deleteResult.ok).toBeTrue();
    const remaining = listAgentPlans(workspaceSlug, sessionId);
    expect(remaining.length).toBe(1);
    expect(remaining[0]?.name).toBe("plan.md");
  });

  test("应拒绝读取越界 plan 路径", () => {
    createTempConfigDir();
    const workspaceSlug = "workspace-b";
    const sessionId = "session-b";
    getAgentSessionPath(workspaceSlug, sessionId);

    expect(() => readAgentPlan(workspaceSlug, sessionId, "../secrets.md")).toThrow(
      "Plan 路径超出会话 plans 目录"
    );
  });
});
