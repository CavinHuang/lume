import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@lume/shared";
import { getAliceUserSkillsDir, getUserSkillsDir, getWorkspaceSkillsDir } from "../infra/config-paths";
import { saveLocalInstalledSkillMetadata } from "./skills-market-metadata";
import {
  analyzeWorkspaceSkillImprovement,
  analyzeThreadWorkspaceSkillImprovements,
  applyWorkspaceSkillImprovement,
  createWorkspaceSkillImprovementModelCall,
  listWorkspaceSkillVersions,
  restoreWorkspaceSkillVersion
} from "./skill-evolution-service";

function withTempConfigDir(): () => void {
  const previous = process.env.LUME_CONFIG_DIR;
  const previousAlice = process.env.ALICE_CONFIG_DIR;
  const next = join(tmpdir(), `lume-skill-evolution-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  process.env.LUME_CONFIG_DIR = next;
  process.env.ALICE_CONFIG_DIR = join(next, "alice");
  return () => {
    if (previous === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = previous;
    }
    if (previousAlice === undefined) {
      delete process.env.ALICE_CONFIG_DIR;
    } else {
      process.env.ALICE_CONFIG_DIR = previousAlice;
    }
    rmSync(next, { recursive: true, force: true });
  };
}

function writeWorkspaceSkill(workspaceSlug: string, skillSlug: string, content: string): string {
  const skillDir = join(getWorkspaceSkillsDir(workspaceSlug), skillSlug);
  mkdirSync(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  writeFileSync(skillPath, content, "utf-8");
  return skillPath;
}

function writeUserSkill(skillSlug: string, content: string): string {
  const skillDir = join(getAliceUserSkillsDir(), skillSlug);
  mkdirSync(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  writeFileSync(skillPath, content, "utf-8");
  return skillPath;
}

function writeProjectSkill(projectDir: string, skillSlug: string, content: string): string {
  const skillDir = join(projectDir, ".alice", "skills", skillSlug);
  mkdirSync(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  writeFileSync(skillPath, content, "utf-8");
  return skillPath;
}

function markWorkspaceSkillAsLocalMarketManaged(workspaceSlug: string, skillSlug: string): void {
  const sourceDir = join(tmpdir(), `lume-market-source-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, "SKILL.md"), "---\nname: Market Source\n---\n\nSource.", "utf-8");
  saveLocalInstalledSkillMetadata({
    workspaceSlug,
    skills: [{ slug: skillSlug, sourcePath: sourceDir }]
  });
}

describe("skill-evolution-service", () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  test("applies and restores workspace skill improvements through slug-scoped paths", async () => {
    cleanup = withTempConfigDir();
    const skillPath = writeWorkspaceSkill("demo", "planner", "# Planner\n\nOld rule.");

    const applied = await applyWorkspaceSkillImprovement({
      workspaceSlug: "demo",
      skillSlug: "planner",
      updates: [{ section: "Rules", change: "Use new rule", reason: "Observed miss" }],
      callModel: async () => "<updated_file># Planner\n\nNew rule.</updated_file>"
    });

    expect(applied.success).toBe(true);
    expect(readFileSync(skillPath, "utf-8")).toBe("# Planner\n\nNew rule.");
    const versions = await listWorkspaceSkillVersions({ workspaceSlug: "demo", skillSlug: "planner" });
    expect(versions).toHaveLength(1);

    const restored = await restoreWorkspaceSkillVersion({
      workspaceSlug: "demo",
      skillSlug: "planner",
      filename: versions[0]!.filename
    });

    expect(restored.success).toBe(true);
    expect(readFileSync(skillPath, "utf-8")).toBe("# Planner\n\nOld rule.");
  });

  test("applies, analyzes, and restores user-global skill improvements by storage scope", async () => {
    cleanup = withTempConfigDir();
    const skillPath = writeUserSkill("global-planner", "# Global Planner\n\nOld rule.");
    writeFileSync(
      join(getAliceUserSkillsDir(), "global-planner", "usage.jsonl"),
      JSON.stringify({ ts: 2000, sessionId: "thread-user" }) + "\n",
      "utf-8"
    );

    const analyzed = await analyzeWorkspaceSkillImprovement({
      storageScope: "user",
      workspaceSlug: "demo",
      skillSlug: "global-planner",
      getRecentMessages: () => [message("user", "global skill feedback", 1)],
      callModel: async ({ userPrompt }) => {
        expect(userPrompt).toContain("# Global Planner");
        expect(userPrompt).toContain("global skill feedback");
        return "<updates>[{\"section\":\"Rules\",\"change\":\"Prefer reusable steps\",\"reason\":\"User asked globally\"}]</updates>";
      }
    });

    expect(analyzed).toMatchObject({
      skillSlug: "global-planner",
      usageCount: 1,
      analyzedSessionIds: ["thread-user"],
      updates: [{ section: "Rules", change: "Prefer reusable steps", reason: "User asked globally" }]
    });

    const applied = await applyWorkspaceSkillImprovement({
      storageScope: "user",
      workspaceSlug: "demo",
      skillSlug: "global-planner",
      updates: analyzed.updates,
      callModel: async () => "<updated_file># Global Planner\n\nNew global rule.</updated_file>"
    });

    expect(applied.success).toBe(true);
    expect(readFileSync(skillPath, "utf-8")).toBe("# Global Planner\n\nNew global rule.");
    const versions = await listWorkspaceSkillVersions({
      storageScope: "user",
      workspaceSlug: "demo",
      skillSlug: "global-planner"
    });
    expect(versions).toHaveLength(1);

    const restored = await restoreWorkspaceSkillVersion({
      storageScope: "user",
      workspaceSlug: "demo",
      skillSlug: "global-planner",
      filename: versions[0]!.filename
    });

    expect(restored.success).toBe(true);
    expect(readFileSync(skillPath, "utf-8")).toBe("# Global Planner\n\nOld rule.");
  });

  test("rejects skill slugs that escape the workspace skills directory", async () => {
    cleanup = withTempConfigDir();

    await expect(listWorkspaceSkillVersions({
      workspaceSlug: "demo",
      skillSlug: "../outside"
    })).rejects.toThrow("非法 Skill 路径");
  });

  test("rejects direct evolution operations for market-managed workspace skills", async () => {
    cleanup = withTempConfigDir();
    const skillPath = writeWorkspaceSkill("demo", "market-review", "# Market Review\n\nOriginal.");
    const versionsDir = join(getWorkspaceSkillsDir("demo"), "market-review", "versions");
    mkdirSync(versionsDir, { recursive: true });
    writeFileSync(join(versionsDir, "SKILL_20260605_010203_abcd.md"), "# Market Review\n\nBackup.", "utf-8");
    markWorkspaceSkillAsLocalMarketManaged("demo", "market-review");

    await expect(analyzeWorkspaceSkillImprovement({
      workspaceSlug: "demo",
      skillSlug: "market-review",
      getRecentMessages: () => [],
      callModel: async () => {
        throw new Error("model should not be called");
      }
    })).rejects.toThrow("市场管理的 Skill 请在技能市场中管理");

    await expect(listWorkspaceSkillVersions({
      workspaceSlug: "demo",
      skillSlug: "market-review"
    })).rejects.toThrow("市场管理的 Skill 请在技能市场中管理");

    await expect(applyWorkspaceSkillImprovement({
      workspaceSlug: "demo",
      skillSlug: "market-review",
      updates: [{ section: "Rules", change: "Change market skill", reason: "No" }],
      callModel: async () => "<updated_file># Market Review\n\nChanged.</updated_file>"
    })).resolves.toMatchObject({
      success: false,
      error: "市场管理的 Skill 请在技能市场中管理"
    });

    await expect(restoreWorkspaceSkillVersion({
      workspaceSlug: "demo",
      skillSlug: "market-review",
      filename: "SKILL_20260605_010203_abcd.md"
    })).resolves.toMatchObject({
      success: false,
      error: "市场管理的 Skill 请在技能市场中管理"
    });

    expect(readFileSync(skillPath, "utf-8")).toBe("# Market Review\n\nOriginal.");
  });

  test("analyzes recent sessions recorded in workspace skill usage", async () => {
    cleanup = withTempConfigDir();
    const skillPath = writeWorkspaceSkill("demo", "planner", "# Planner\n\nOld guidance.");
    writeFileSync(
      join(getWorkspaceSkillsDir("demo"), "planner", "usage.jsonl"),
      [
        JSON.stringify({ ts: 1000, sessionId: "old-thread" }),
        JSON.stringify({ ts: 2000, sessionId: "thread-1" }),
        JSON.stringify({ ts: 3000, sessionId: "thread-2" })
      ].join("\n"),
      "utf-8"
    );

    const requestedThreadIds: string[] = [];
    const result = await analyzeWorkspaceSkillImprovement({
      workspaceSlug: "demo",
      skillSlug: "planner",
      maxSessions: 2,
      getRecentMessages: (threadId) => {
        requestedThreadIds.push(threadId);
        return [
          message("status", "ignored", 1),
          message("user", `user feedback from ${threadId}`, 2),
          message("assistant", `assistant result from ${threadId}`, 3)
        ];
      },
      callModel: async ({ userPrompt }) => {
        expect(userPrompt).toContain("# Planner");
        expect(userPrompt).toContain("user feedback from thread-2");
        expect(userPrompt).toContain("assistant result from thread-1");
        expect(userPrompt).not.toContain("ignored");
        return "<updates>[" +
          "{\"section\":\"Rules\",\"change\":\"Ask for constraints first\",\"reason\":\"Recent runs missed context\"}" +
          "]</updates>";
      }
    });

    expect(skillPath.endsWith("SKILL.md")).toBe(true);
    expect(requestedThreadIds).toEqual(["thread-2", "thread-1"]);
    expect(result).toEqual({
      skillSlug: "planner",
      usageCount: 3,
      analyzedSessionIds: ["thread-2", "thread-1"],
      updates: [{
        section: "Rules",
        change: "Ask for constraints first",
        reason: "Recent runs missed context"
      }]
    });
  });

  test("does not call the model when a workspace skill has no usage evidence", async () => {
    cleanup = withTempConfigDir();
    writeWorkspaceSkill("demo", "planner", "# Planner\n\nOld guidance.");

    const result = await analyzeWorkspaceSkillImprovement({
      workspaceSlug: "demo",
      skillSlug: "planner",
      getRecentMessages: () => {
        throw new Error("messages should not be requested");
      },
      callModel: async () => {
        throw new Error("model should not be called");
      }
    });

    expect(result).toEqual({
      skillSlug: "planner",
      usageCount: 0,
      analyzedSessionIds: [],
      updates: []
    });
  });

  test("creates a model call from the workspace agent default model", async () => {
    const providerCalls: unknown[] = [];
    const attempt = createWorkspaceSkillImprovementModelCall({
      workspaceSlug: "demo",
      getEffectiveConfig: () => ({
        models: {
          chat: { defaultModelRef: "openai/gpt-5-mini" },
          agent: { defaultModelRef: "deepseek/skill-evolver" }
        }
      }),
      resolveBinding(modelRef) {
        expect(modelRef).toBe("deepseek/skill-evolver");
        return {
          channel: {
            id: "channel-1",
            provider: "deepseek",
            baseUrl: "https://api.deepseek.com"
          },
          modelId: "skill-evolver",
          family: "openai"
        };
      },
      decryptApiKey(channelId) {
        expect(channelId).toBe("channel-1");
        return "test-key";
      },
      createProvider(options) {
        expect(options).toEqual({
          apiType: "deepseek-chat-completions",
          apiKey: "test-key",
          baseURL: "https://api.deepseek.com"
        });
        return {
          apiType: options.apiType,
          async createMessage(params) {
            providerCalls.push(params);
            return {
              content: [
                { type: "text", text: "<updates>[]</updates>" }
              ],
              stopReason: "end_turn",
              usage: { input_tokens: 1, output_tokens: 2 }
            };
          }
        };
      }
    });

    expect(attempt?.modelRef).toBe("deepseek/skill-evolver");
    await expect(attempt!.callModel({
      systemPrompt: "system prompt",
      userPrompt: "user prompt"
    })).resolves.toBe("<updates>[]</updates>");
    expect(providerCalls).toEqual([{
      model: "skill-evolver",
      maxTokens: 1200,
      system: "system prompt",
      messages: [{
        role: "user",
        content: "user prompt"
      }]
    }]);
  });

  test("applies workspace skill improvements with the workspace default model", async () => {
    cleanup = withTempConfigDir();
    const skillPath = writeWorkspaceSkill("demo", "planner", "# Planner\n\nOld rule.");

    const applied = await applyWorkspaceSkillImprovement({
      workspaceSlug: "demo",
      skillSlug: "planner",
      updates: [{ section: "Rules", change: "Use new rule", reason: "Observed miss" }],
      getEffectiveConfig: () => ({
        models: {
          agent: { defaultModelRef: "openai/skill-evolver" }
        }
      }),
      resolveBinding: () => ({
        channel: {
          id: "channel-1",
          provider: "openai",
          baseUrl: "https://api.openai.com/v1"
        },
        modelId: "skill-evolver",
        family: "openai"
      }),
      decryptApiKey: () => "test-key",
      createProvider: (options) => ({
        apiType: options.apiType,
        async createMessage(params) {
          expect(params.model).toBe("skill-evolver");
          expect(params.messages[0]?.content).toContain("Use new rule");
          return {
            content: [
              { type: "text", text: "<updated_file># Planner\n\nNew rule.</updated_file>" }
            ],
            stopReason: "end_turn",
            usage: { input_tokens: 3, output_tokens: 4 }
          };
        }
      })
    });

    expect(applied.success).toBe(true);
    expect(readFileSync(skillPath, "utf-8")).toBe("# Planner\n\nNew rule.");
  });

  test("scans only skills used by the completed thread", async () => {
    cleanup = withTempConfigDir();
    writeWorkspaceSkill("demo", "planner", "# Planner\n\nCurrent planner guidance.");
    writeWorkspaceSkill("demo", "reviewer", "# Reviewer\n\nCurrent reviewer guidance.");
    writeFileSync(
      join(getWorkspaceSkillsDir("demo"), "planner", "usage.jsonl"),
      JSON.stringify({ ts: 3000, sessionId: "thread-1" }) + "\n",
      "utf-8"
    );
    writeFileSync(
      join(getWorkspaceSkillsDir("demo"), "reviewer", "usage.jsonl"),
      JSON.stringify({ ts: 3000, sessionId: "other-thread" }) + "\n",
      "utf-8"
    );

    const requestedThreadIds: string[] = [];
    const result = await analyzeThreadWorkspaceSkillImprovements({
      workspaceSlug: "demo",
      threadId: "thread-1",
      getRecentMessages: (threadId) => {
        requestedThreadIds.push(threadId);
        return [
          message("user", "planner missed constraints", 1),
          message("assistant", "I should ask for constraints first", 2)
        ];
      },
      callModel: async ({ userPrompt }) => {
        expect(userPrompt).toContain("Current planner guidance");
        expect(userPrompt).not.toContain("Current reviewer guidance");
        return "<updates>[" +
          "{\"section\":\"Rules\",\"change\":\"Ask for constraints first\",\"reason\":\"Thread feedback showed missing constraints\"}" +
          "]</updates>";
      }
    });

    expect(requestedThreadIds).toEqual(["thread-1"]);
    expect(result).toEqual([{
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
    }]);
  });

  test("thread-level improvement analysis includes user-global skills with storage scope", async () => {
    cleanup = withTempConfigDir();
    writeWorkspaceSkill("demo", "planner", "# Planner\n\nWorkspace guidance.");
    writeUserSkill("global-planner", "# Global Planner\n\nUser guidance.");
    writeFileSync(
      join(getWorkspaceSkillsDir("demo"), "planner", "usage.jsonl"),
      JSON.stringify({ ts: 2000, sessionId: "thread-1" }) + "\n",
      "utf-8"
    );
    writeFileSync(
      join(getAliceUserSkillsDir(), "global-planner", "usage.jsonl"),
      JSON.stringify({ ts: 3000, sessionId: "thread-1" }) + "\n",
      "utf-8"
    );

    const analyzedSkillPrompts: string[] = [];
    const result = await analyzeThreadWorkspaceSkillImprovements({
      workspaceSlug: "demo",
      threadId: "thread-1",
      getRecentMessages: () => [
        message("user", "planner missed constraints", 1),
        message("assistant", "I should ask for constraints first", 2)
      ],
      callModel: async ({ userPrompt }) => {
        analyzedSkillPrompts.push(userPrompt);
        return "<updates>[" +
          "{\"section\":\"Rules\",\"change\":\"Ask for constraints first\",\"reason\":\"Thread feedback showed missing constraints\"}" +
          "]</updates>";
      }
    });

    expect(analyzedSkillPrompts[0]).toContain("User guidance");
    expect(analyzedSkillPrompts[1]).toContain("Workspace guidance");
    expect(result.map((item) => ({
      storageScope: item.storageScope,
      skillSlug: item.skillSlug,
      workspaceSlug: item.workspaceSlug
    }))).toEqual([
      { storageScope: "user", skillSlug: "global-planner", workspaceSlug: "demo" },
      { storageScope: "workspace", skillSlug: "planner", workspaceSlug: "demo" }
    ]);
  });

  test("thread-level improvement analysis includes Alice project skills when cwd is available", async () => {
    cleanup = withTempConfigDir();
    const projectDir = join(tmpdir(), `lume-project-skill-evolution-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const projectSkillPath = writeProjectSkill(projectDir, "project-planner", "# Project Planner\n\nProject guidance.");
    writeFileSync(
      join(projectDir, ".alice", "skills", "project-planner", "usage.jsonl"),
      JSON.stringify({ ts: 4000, sessionId: "thread-1" }) + "\n",
      "utf-8"
    );

    try {
      const analyzedSkillPrompts: string[] = [];
      const result = await analyzeThreadWorkspaceSkillImprovements({
        workspaceSlug: "demo",
        cwd: projectDir,
        threadId: "thread-1",
        getRecentMessages: () => [
          message("user", "project planner missed constraints", 1),
          message("assistant", "I should ask for project constraints first", 2)
        ],
        callModel: async ({ userPrompt }) => {
          analyzedSkillPrompts.push(userPrompt);
          expect(userPrompt).toContain("Project guidance");
          return "<updates>[" +
            "{\"section\":\"Rules\",\"change\":\"Ask for project constraints first\",\"reason\":\"Thread feedback showed missing project constraints\"}" +
            "]</updates>";
        }
      });

      expect(projectSkillPath).toBe(join(projectDir, ".alice", "skills", "project-planner", "SKILL.md"));
      expect(analyzedSkillPrompts).toHaveLength(1);
      expect(result).toEqual([{
        workspaceSlug: "demo",
        storageScope: "project",
        cwd: projectDir,
        skillSlug: "project-planner",
        usageCount: 1,
        analyzedSessionIds: ["thread-1"],
        updates: [{
          section: "Rules",
          change: "Ask for project constraints first",
          reason: "Thread feedback showed missing project constraints"
        }]
      }]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("thread-level improvement analysis skips market-managed skills", async () => {
    cleanup = withTempConfigDir();
    writeWorkspaceSkill("demo", "planner", "# Planner\n\nCurrent planner guidance.");
    writeWorkspaceSkill("demo", "market-review", "# Market Review\n\nCurrent market guidance.");
    markWorkspaceSkillAsLocalMarketManaged("demo", "market-review");
    writeFileSync(
      join(getWorkspaceSkillsDir("demo"), "planner", "usage.jsonl"),
      JSON.stringify({ ts: 2000, sessionId: "thread-1" }) + "\n",
      "utf-8"
    );
    writeFileSync(
      join(getWorkspaceSkillsDir("demo"), "market-review", "usage.jsonl"),
      JSON.stringify({ ts: 3000, sessionId: "thread-1" }) + "\n",
      "utf-8"
    );

    const result = await analyzeThreadWorkspaceSkillImprovements({
      workspaceSlug: "demo",
      threadId: "thread-1",
      getRecentMessages: () => [
        message("user", "planner missed constraints", 1),
        message("assistant", "I should ask for constraints first", 2)
      ],
      callModel: async ({ userPrompt }) => {
        expect(userPrompt).toContain("Current planner guidance");
        expect(userPrompt).not.toContain("Current market guidance");
        return "<updates>[" +
          "{\"section\":\"Rules\",\"change\":\"Ask for constraints first\",\"reason\":\"Thread feedback showed missing constraints\"}" +
          "]</updates>";
      }
    });

    expect(result.map((item) => item.skillSlug)).toEqual(["planner"]);
  });
});

function message(role: AgentMessage["role"], content: string, createdAt: number): AgentMessage {
  return {
    id: `${role}-${createdAt}`,
    role,
    content,
    createdAt
  };
}
