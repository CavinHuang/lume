import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { clearSkills, registerSkill } from "../skills/registry";
import { SkillTool } from "./skill-tool";

afterEach(() => {
  clearSkills();
});

test("SkillTool prompt hides skills with disableModelInvocation", async () => {
  registerSkill({
    name: "auto-skill",
    description: "Visible to the model",
    getPrompt: async () => [{ type: "text", text: "auto" }]
  });
  registerSkill({
    name: "manual-skill",
    description: "Manual only",
    disableModelInvocation: true,
    getPrompt: async () => [{ type: "text", text: "manual" }]
  });

  const prompt = await SkillTool.prompt?.({ cwd: process.cwd() } as any);

  expect(prompt).toContain("auto-skill");
  expect(prompt).not.toContain("manual-skill");
});

test("SkillTool prompt exposes argument hints but not trigger details", async () => {
  registerSkill({
    name: "code-review",
    description: "Review code quality",
    whenToUse: "when the user asks for code review",
    argumentHint: "path to review",
    getPrompt: async () => [{ type: "text", text: "review" }]
  });

  const prompt = await SkillTool.prompt?.({ cwd: process.cwd() } as any);

  expect(prompt).toContain("code-review");
  expect(prompt).toContain("Review code quality");
  expect(prompt).not.toContain("when the user asks for code review");
  expect(prompt).not.toContain("Trigger:");
  expect(prompt).toContain("path to review");
});

test("SkillTool prompt includes display name aliases alongside skill ids", async () => {
  registerSkill({
    name: "code-review",
    aliases: ["代码审查"],
    description: "Review code quality",
    getPrompt: async () => [{ type: "text", text: "review" }]
  });

  const prompt = await SkillTool.prompt?.({ cwd: process.cwd() } as any);

  expect(prompt).toContain("code-review");
  expect(prompt).toContain("代码审查");
  expect(prompt).toContain("- code-review (代码审查): Review code quality");
});

test("SkillTool stays enabled when only manual skills are registered", () => {
  registerSkill({
    name: "manual-skill",
    description: "Manual only",
    disableModelInvocation: true,
    getPrompt: async () => [{ type: "text", text: "manual" }]
  });

  expect(SkillTool.isEnabled?.()).toBe(true);
});

test("SkillTool returns additive deferred tool activations", async () => {
  registerSkill({
    name: "browser",
    description: "Browser runtime",
    activatedTools: ["mcp__node_repl__js"],
    getPrompt: async () => [{ type: "text", text: "use browser" }]
  });

  const result = await SkillTool.call({ skill: "browser" }, { cwd: process.cwd() } as any);

  expect(JSON.parse(String(result.content))).toMatchObject({
    activatedTools: ["mcp__node_repl__js"]
  });
});

test("SkillTool asks for argumentHint instead of executing when args are missing", async () => {
  let promptCalled = false;
  registerSkill({
    name: "code-review",
    description: "Review code quality",
    argumentHint: "请告诉我要审查的文件路径",
    getPrompt: async () => {
      promptCalled = true;
      return [{ type: "text", text: "review" }];
    }
  });

  const result = await SkillTool.call({ skill: "code-review" }, { cwd: process.cwd() } as any);

  expect(result.is_error).toBe(true);
  expect(String(result.content)).toContain("请告诉我要审查的文件路径");
  expect(promptCalled).toBe(false);
});

test("SkillTool records filesystem skill usage with the active session id", async () => {
  const root = join(tmpdir(), `sdk-skill-tool-usage-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const skillDir = join(root, "demo");
  mkdirSync(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  writeFileSync(skillPath, "# Demo\n", "utf-8");

  try {
    registerSkill({
      name: "demo",
      description: "Demo skill",
      sourcePath: skillPath,
      getPrompt: async () => [{ type: "text", text: "demo prompt" }]
    });

    await SkillTool.call({ skill: "demo" }, { cwd: root, sessionId: "thread-demo" } as any);

    const lines = readFileSync(join(skillDir, "usage.jsonl"), "utf-8").trim().split("\n");
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { ts: expect.any(Number), sessionId: "thread-demo" }
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
