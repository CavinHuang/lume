import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { getAliceUserSkillsDir, getDefaultSkillsDir, getUserSkillsDir, getWorkspaceSkillsDir } from "../infra/config-paths";
import { listWorkspaceSkillVersions } from "./skill-evolution-service";
import { saveLocalInstalledSkillMetadata } from "./skills-market-metadata";
import { parseSkillFrontmatter } from "./skill-frontmatter";
import {
  deleteEditableSkill,
  getEditableSkill,
  listEditableSkills,
  saveWorkspaceSkill
} from "./workspace-skill-editor-service";

function withTempConfigDir(): () => void {
  const previous = process.env.LUME_CONFIG_DIR;
  const previousAlice = process.env.ALICE_CONFIG_DIR;
  const next = join(tmpdir(), `lume-workspace-skill-editor-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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

describe("workspace-skill-editor-service", () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  test("creates a workspace skill from editable fields and prompt content", async () => {
    cleanup = withTempConfigDir();

    const result = await saveWorkspaceSkill({
      workspaceSlug: "demo",
      skillSlug: "planner",
      name: "Planning Helper",
      description: "Turns rough asks into executable plans.",
      whenToUse: "When the user asks for a plan.",
      allowedTools: ["bash", "read_file", "bash", ""],
      argumentHint: "Describe the target change",
      disableModelInvocation: true,
      version: "1.1.0",
      prompt: "Use ${ARG} to scope the plan."
    });

    const skillPath = join(getWorkspaceSkillsDir("demo"), "planner", "SKILL.md");
    const content = readFileSync(skillPath, "utf-8");
    const meta = parseSkillFrontmatter(content, "planner");

    expect(result.skill).toEqual({
      slug: "planner",
      name: "Planning Helper",
      description: "Turns rough asks into executable plans.",
      whenToUse: "When the user asks for a plan.",
      allowedTools: ["bash", "read_file"],
      argumentHint: "Describe the target change",
      disableModelInvocation: true,
      version: "1.1.0"
    });
    expect(meta).toEqual(result.skill);
    expect(content).toContain("Use ${ARG} to scope the plan.\n");
    expect(await listWorkspaceSkillVersions({ workspaceSlug: "demo", skillSlug: "planner" })).toEqual([]);
  });

  test("creates a user-global skill when storage scope is user", async () => {
    cleanup = withTempConfigDir();

    await saveWorkspaceSkill({
      storageScope: "user",
      workspaceSlug: "demo",
      skillSlug: "global-planner",
      name: "Global Planner",
      description: "Plans work across workspaces.",
      whenToUse: "When the user asks for a reusable plan.",
      prompt: "Global guidance."
    });

    const userSkillPath = join(getAliceUserSkillsDir(), "global-planner", "SKILL.md");
    const legacyUserSkillPath = join(getUserSkillsDir(), "global-planner", "SKILL.md");
    const workspaceSkillPath = join(getWorkspaceSkillsDir("demo"), "global-planner", "SKILL.md");

    expect(readFileSync(userSkillPath, "utf-8")).toContain("Global guidance.\n");
    expect(existsSync(legacyUserSkillPath)).toBe(false);
    expect(existsSync(workspaceSkillPath)).toBe(false);
  });

  test("manages Alice-compatible project skills under cwd .alice/skills", async () => {
    cleanup = withTempConfigDir();
    const projectDir = join(tmpdir(), `lume-project-skill-editor-${Date.now()}-${Math.random().toString(16).slice(2)}`);

    try {
      await saveWorkspaceSkill({
        storageScope: "project",
        cwd: projectDir,
        workspaceSlug: "demo",
        skillSlug: "project-planner",
        name: "Project Planner",
        description: "Plans work for this project.",
        whenToUse: "When this project needs a plan.",
        prompt: "Project guidance."
      });

      const projectSkillPath = join(projectDir, ".alice", "skills", "project-planner", "SKILL.md");
      const workspaceSkillPath = join(getWorkspaceSkillsDir("demo"), "project-planner", "SKILL.md");
      expect(readFileSync(projectSkillPath, "utf-8")).toContain("Project guidance.\n");
      expect(existsSync(workspaceSkillPath)).toBe(false);

      expect(listEditableSkills({ workspaceSlug: "demo", cwd: projectDir })).toContainEqual({
        storageScope: "project",
        managementSurface: "settings",
        slug: "project-planner",
        name: "Project Planner",
        description: "Plans work for this project.",
        whenToUse: "When this project needs a plan.",
        disableModelInvocation: false
      });

      const detail = getEditableSkill({
        storageScope: "project",
        cwd: projectDir,
        workspaceSlug: "demo",
        skillSlug: "project-planner"
      });
      expect(detail.path).toBe(projectSkillPath);
      expect(detail.content).toContain("Project guidance.");

      deleteEditableSkill({
        storageScope: "project",
        cwd: projectDir,
        workspaceSlug: "demo",
        skillSlug: "project-planner"
      });
      expect(existsSync(projectSkillPath)).toBe(false);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("manages legacy Lume project skills when no Alice project copy exists", async () => {
    cleanup = withTempConfigDir();
    const projectDir = join(tmpdir(), `lume-legacy-project-skill-editor-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const legacySkillDir = join(projectDir, ".lume", "skills", "project-legacy");
    const legacySkillPath = join(legacySkillDir, "SKILL.md");
    const aliceSkillPath = join(projectDir, ".alice", "skills", "project-legacy", "SKILL.md");
    mkdirSync(legacySkillDir, { recursive: true });
    writeFileSync(
      legacySkillPath,
      "---\nname: Project Legacy\ndescription: Legacy project skill.\nwhen_to_use: When legacy project work needs help.\n---\n\nLegacy project prompt.",
      "utf-8"
    );

    try {
      expect(listEditableSkills({ workspaceSlug: "demo", cwd: projectDir })).toContainEqual({
        storageScope: "project",
        managementSurface: "settings",
        slug: "project-legacy",
        name: "Project Legacy",
        description: "Legacy project skill.",
        whenToUse: "When legacy project work needs help."
      });

      const detail = getEditableSkill({
        storageScope: "project",
        cwd: projectDir,
        workspaceSlug: "demo",
        skillSlug: "project-legacy"
      });
      expect(detail.path).toBe(legacySkillPath);
      expect(detail.content).toContain("Legacy project prompt.");

      await saveWorkspaceSkill({
        storageScope: "project",
        cwd: projectDir,
        workspaceSlug: "demo",
        skillSlug: "project-legacy",
        name: "Project Legacy",
        description: "Updated legacy project skill.",
        whenToUse: "When updated legacy project work needs help.",
        prompt: "Updated legacy project prompt."
      });

      expect(readFileSync(legacySkillPath, "utf-8")).toContain("Updated legacy project prompt.\n");
      expect(existsSync(aliceSkillPath)).toBe(false);

      deleteEditableSkill({
        storageScope: "project",
        cwd: projectDir,
        workspaceSlug: "demo",
        skillSlug: "project-legacy"
      });
      expect(existsSync(legacySkillPath)).toBe(false);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("rejects saves missing Alice core skill fields", async () => {
    cleanup = withTempConfigDir();

    await expect(saveWorkspaceSkill({
      workspaceSlug: "demo",
      skillSlug: "empty-planner",
      name: "Empty Planner",
      description: "",
      whenToUse: "When planning is needed.",
      prompt: "Plan carefully."
    })).rejects.toThrow("描述、触发条件和提示词内容不能为空");

    expect(existsSync(join(getWorkspaceSkillsDir("demo"), "empty-planner", "SKILL.md"))).toBe(false);
  });

  test("lists user-global and workspace skills with their storage scopes", async () => {
    cleanup = withTempConfigDir();
    const userSkillDir = join(getAliceUserSkillsDir(), "global-planner");
    const workspaceSkillDir = join(getWorkspaceSkillsDir("demo"), "local-review");
    mkdirSync(userSkillDir, { recursive: true });
    mkdirSync(workspaceSkillDir, { recursive: true });
    writeFileSync(join(userSkillDir, "SKILL.md"), "---\nname: Global Planner\n---\n\nGlobal.", "utf-8");
    writeFileSync(join(workspaceSkillDir, "SKILL.md"), "---\nname: Local Review\n---\n\nLocal.", "utf-8");

    const skills = listEditableSkills({ workspaceSlug: "demo" });
    // Filter out plugin skills (from ~/.lume/plugins/) to focus on user/workspace skills
    const nonPluginSkills = skills.filter(s => s.storageScope !== "plugin");
    expect(nonPluginSkills).toEqual([
      {
        storageScope: "user",
        managementSurface: "settings",
        slug: "global-planner",
        name: "Global Planner"
      },
      {
        storageScope: "workspace",
        managementSurface: "settings",
        slug: "local-review",
        name: "Local Review"
      }
    ]);
  });

  test("manages legacy Lume user-global skills when no Alice copy exists", async () => {
    cleanup = withTempConfigDir();
    const legacySkillDir = join(getUserSkillsDir(), "legacy-planner");
    const legacySkillPath = join(legacySkillDir, "SKILL.md");
    const aliceSkillPath = join(getAliceUserSkillsDir(), "legacy-planner", "SKILL.md");
    mkdirSync(legacySkillDir, { recursive: true });
    writeFileSync(
      legacySkillPath,
      "---\nname: Legacy Planner\ndescription: Legacy global skill.\nwhen_to_use: When legacy work needs a plan.\n---\n\nLegacy prompt.",
      "utf-8"
    );

    expect(listEditableSkills({ workspaceSlug: "demo" })).toContainEqual({
      storageScope: "user",
      managementSurface: "settings",
      slug: "legacy-planner",
      name: "Legacy Planner",
      description: "Legacy global skill.",
      whenToUse: "When legacy work needs a plan."
    });

    const detail = getEditableSkill({
      storageScope: "user",
      workspaceSlug: "demo",
      skillSlug: "legacy-planner"
    });
    expect(detail.path).toBe(legacySkillPath);
    expect(detail.content).toContain("Legacy prompt.");

    await saveWorkspaceSkill({
      storageScope: "user",
      workspaceSlug: "demo",
      skillSlug: "legacy-planner",
      name: "Legacy Planner",
      description: "Updated legacy global skill.",
      whenToUse: "When updated legacy work needs a plan.",
      prompt: "Updated legacy prompt."
    });

    expect(readFileSync(legacySkillPath, "utf-8")).toContain("Updated legacy prompt.\n");
    expect(existsSync(aliceSkillPath)).toBe(false);

    deleteEditableSkill({
      storageScope: "user",
      workspaceSlug: "demo",
      skillSlug: "legacy-planner"
    });
    expect(existsSync(legacySkillPath)).toBe(false);
  });

  test("marks workspace skills installed from the market as market-managed", async () => {
    cleanup = withTempConfigDir();
    const workspaceSkillDir = join(getWorkspaceSkillsDir("demo"), "market-review");
    const sourceSkillDir = join(tmpdir(), `lume-market-review-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(workspaceSkillDir, { recursive: true });
    mkdirSync(sourceSkillDir, { recursive: true });
    writeFileSync(join(workspaceSkillDir, "SKILL.md"), "---\nname: Market Review\n---\n\nMarket.", "utf-8");
    writeFileSync(join(sourceSkillDir, "SKILL.md"), "---\nname: Market Review\n---\n\nSource.", "utf-8");
    saveLocalInstalledSkillMetadata({
      workspaceSlug: "demo",
      skills: [{ slug: "market-review", sourcePath: sourceSkillDir }]
    });

    expect(listEditableSkills({ workspaceSlug: "demo" })).toContainEqual({
      storageScope: "workspace",
      managementSurface: "market",
      sourceType: "local",
      slug: "market-review",
      name: "Market Review"
    });

    rmSync(sourceSkillDir, { recursive: true, force: true });
  });

  test("marks workspace skills matching built-in sources as market-managed", async () => {
    cleanup = withTempConfigDir();
    const defaultSkillDir = join(getDefaultSkillsDir(), "built-in-review");
    const workspaceSkillDir = join(getWorkspaceSkillsDir("demo"), "built-in-review");
    mkdirSync(defaultSkillDir, { recursive: true });
    mkdirSync(workspaceSkillDir, { recursive: true });
    writeFileSync(join(defaultSkillDir, "SKILL.md"), "---\nname: Built-in Review\n---\n\nDefault.", "utf-8");
    writeFileSync(join(workspaceSkillDir, "SKILL.md"), "---\nname: Built-in Review\n---\n\nWorkspace.", "utf-8");

    expect(listEditableSkills({ workspaceSlug: "demo" })).toContainEqual({
      storageScope: "workspace",
      managementSurface: "market",
      sourceType: "built-in",
      slug: "built-in-review",
      name: "Built-in Review"
    });
  });

  test("rejects settings edits and deletes for market-managed workspace skills", async () => {
    cleanup = withTempConfigDir();
    const workspaceSkillDir = join(getWorkspaceSkillsDir("demo"), "market-review");
    const sourceSkillDir = join(tmpdir(), `lume-market-review-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(workspaceSkillDir, { recursive: true });
    mkdirSync(sourceSkillDir, { recursive: true });
    writeFileSync(join(workspaceSkillDir, "SKILL.md"), "---\nname: Market Review\n---\n\nMarket original.", "utf-8");
    writeFileSync(join(sourceSkillDir, "SKILL.md"), "---\nname: Market Review\n---\n\nSource.", "utf-8");
    saveLocalInstalledSkillMetadata({
      workspaceSlug: "demo",
      skills: [{ slug: "market-review", sourcePath: sourceSkillDir }]
    });

    const input = {
      storageScope: "workspace" as const,
      workspaceSlug: "demo",
      skillSlug: "market-review"
    };

    expect(() => getEditableSkill(input)).toThrow("市场管理的 Skill 请在技能市场中管理");
    await expect(saveWorkspaceSkill({
      ...input,
      name: "Changed",
      description: "Changed by settings.",
      whenToUse: "When changing market skills.",
      prompt: "Changed."
    })).rejects.toThrow("市场管理的 Skill 请在技能市场中管理");
    expect(() => deleteEditableSkill(input)).toThrow("市场管理的 Skill 请在技能市场中管理");
    expect(readFileSync(join(workspaceSkillDir, "SKILL.md"), "utf-8")).toContain("Market original.");

    rmSync(sourceSkillDir, { recursive: true, force: true });
  });

  test("reads and deletes user-global skills by storage scope", async () => {
    cleanup = withTempConfigDir();
    const skillDir = join(getAliceUserSkillsDir(), "global-planner");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: Global Planner\n---\n\nGlobal prompt.", "utf-8");

    const detail = getEditableSkill({
      storageScope: "user",
      workspaceSlug: "demo",
      skillSlug: "global-planner"
    });

    expect(detail.skill).toEqual({
      storageScope: "user",
      slug: "global-planner",
      name: "Global Planner"
    });
    expect(detail.content).toContain("Global prompt.");

    deleteEditableSkill({
      storageScope: "user",
      workspaceSlug: "demo",
      skillSlug: "global-planner"
    });

    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(false);
  });

  test("updates an existing workspace skill and backs up the previous SKILL.md", async () => {
    cleanup = withTempConfigDir();
    const skillDir = join(getWorkspaceSkillsDir("demo"), "planner");
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    writeFileSync(skillPath, "# Planner\n\nOld guidance.", "utf-8");

    const result = await saveWorkspaceSkill({
      workspaceSlug: "demo",
      skillSlug: "planner",
      name: "Planner",
      description: "Plans work.",
      whenToUse: "When planning is needed.",
      allowedTools: [],
      prompt: "New guidance."
    });

    expect(result.skill).toMatchObject({
      slug: "planner",
      name: "Planner",
      description: "Plans work.",
      whenToUse: "When planning is needed.",
      disableModelInvocation: false
    });
    expect(readFileSync(skillPath, "utf-8")).toContain("New guidance.\n");

    const versions = await listWorkspaceSkillVersions({ workspaceSlug: "demo", skillSlug: "planner" });
    expect(versions).toHaveLength(1);
    expect(readFileSync(versions[0]!.path, "utf-8")).toBe("# Planner\n\nOld guidance.");
    expect(basename(versions[0]!.path)).toMatch(/^\d{4}-\d{2}-\d{2}_\d{6}_[a-f0-9]{8}\.md$/);
  });

  test("rejects unsafe skill slugs before writing", async () => {
    cleanup = withTempConfigDir();

    await expect(saveWorkspaceSkill({
      workspaceSlug: "demo",
      skillSlug: "../outside",
      name: "Outside",
      prompt: "Nope."
    })).rejects.toThrow("非法 Skill 路径");

    expect(existsSync(join(getWorkspaceSkillsDir("demo"), "..", "outside"))).toBe(false);
  });
});
