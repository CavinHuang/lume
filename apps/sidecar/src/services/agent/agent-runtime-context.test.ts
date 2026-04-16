import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentThread } from "./agent-thread-manager";
import { resolveAgentDynamicContextInput, resolveAgentRuntimeRoutingTrace } from "./agent-runtime-context";
import { getAgentWorkspacePath } from "../infra/config-paths";

describe("agent-runtime-context", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-agent-runtime-context-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
    if (tempConfigDir) {
      rmSync(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = "";
    }
  });

  test("应从 session meta 组装 dynamic context 输入", () => {
    const meta = createAgentThread("Runtime Context Title", "channel-a", "workspace-a", "parent-a", "model-a");

    const result = resolveAgentDynamicContextInput({
      threadId: meta.id,
      userMessage: "help me",
      workspaceName: "Workspace Name",
      workspaceSlug: "workspace-slug",
      agentCwd: "D:/workspace/projects/ai-projects/lume",
      availableTools: ["Skill", "read"],
      threadType: "main",
      chatType: "direct",
      fallbackModelId: "fallback-model"
    });

    expect(result.sessionId).toBe(meta.id);
    expect(result.sessionTitle).toBe("Runtime Context Title");
    expect(result.parentSessionId).toBe("parent-a");
    expect(result.workspaceId).toBe("workspace-a");
    expect(result.channelId).toBe("channel-a");
    expect(result.modelId).toBe("model-a");
    expect(result.workspaceName).toBe("Workspace Name");
    expect(result.workspaceSlug).toBe("workspace-slug");
    expect(result.agentCwd).toBe("D:/workspace/projects/ai-projects/lume");
  });

  test("应解析 runtime routing trace", () => {
    const workspaceSlug = "routing-trace-workspace";
    const workspacePath = getAgentWorkspacePath(workspaceSlug);
    const skillDir = join(workspacePath, "skills", "planner");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      ['---', 'name: "Planner"', 'description: "Breaks work into execution plans"', '---', '', '# Planner'].join("\n"),
      "utf-8"
    );

    const trace = resolveAgentRuntimeRoutingTrace({
      workspaceSlug,
      userMessage: "help me create an execution plan",
      availableTools: ["Skill", "browser", "read", "write"]
    });

    expect(trace.capabilityLanes).toEqual(["skills", "browser", "raw-tools"]);
    expect(trace.preferredCapabilityRoute).toBe("skills");
    expect(trace.reason).toContain("loaded skill metadata");
  });

  test("存在 workspace skills 时，即使未显式传入 Skill 工具也应补出 skills lane", () => {
    const workspaceSlug = "routing-trace-workspace-no-skill-tool";
    const workspacePath = getAgentWorkspacePath(workspaceSlug);
    const skillDir = join(workspacePath, "skills", "planner");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      ['---', 'name: "Planner"', 'description: "Breaks work into execution plans"', '---', '', '# Planner'].join("\n"),
      "utf-8"
    );

    const trace = resolveAgentRuntimeRoutingTrace({
      workspaceSlug,
      userMessage: "help me create an execution plan",
      availableTools: ["read", "write"]
    });

    expect(trace.capabilityLanes).toEqual(["skills", "raw-tools"]);
    expect(trace.preferredCapabilityRoute).toBe("skills");
  });
});
