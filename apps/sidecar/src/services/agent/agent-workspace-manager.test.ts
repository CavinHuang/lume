import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getAliceUserSkillsDir,
  getLumeConfigYamlPath,
  getUserSkillsDir,
  getWorkspaceMcpPath,
  getWorkspaceSkillsDir
} from "../infra/config-paths";
import {
  createAgentWorkspace,
  getAgentWorkspaceBySlug,
  listAgentWorkspaces,
  getWorkspaceMcpConfig,
  getRuntimeSkills,
  saveWorkspaceMcpConfig,
  getWorkspaceSkills
} from "./agent-workspace-manager";

function withTempConfigDir(): () => void {
  const previous = process.env.LUME_CONFIG_DIR;
  const previousAlice = process.env.ALICE_CONFIG_DIR;
  const next = join(tmpdir(), `lume-workspace-manager-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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

function writeSkill(workspaceSlug: string, skillSlug: string): void {
  const skillsDir = getWorkspaceSkillsDir(workspaceSlug);
  const skillDir = join(skillsDir, skillSlug);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${skillSlug}\nversion: 1.0.0\n---\n# ${skillSlug}\n`,
    "utf-8"
  );
}

describe("agent-workspace-manager lume.yaml integration", () => {
  let restoreEnv: (() => void) | null = null;

  afterEach(() => {
    restoreEnv?.();
    restoreEnv = null;
  });

  test("getWorkspaceMcpConfig 应叠加 lume.yaml 的 effective mcp", () => {
    restoreEnv = withTempConfigDir();
    const workspaceSlug = "demo";
    const mcpPath = getWorkspaceMcpPath(workspaceSlug);

    writeFileSync(
      mcpPath,
      JSON.stringify({
        servers: {
          local: {
            type: "stdio",
            command: "local",
            enabled: true
          }
        }
      }),
      "utf-8"
    );

    writeFileSync(
      getLumeConfigYamlPath(),
      [
        "version: 1",
        "mcp:",
        "  servers:",
        "    global-server:",
        "      type: stdio",
        "      command: global",
        "      enabled: true",
        "workspaces:",
        "  demo:",
        "    mcp:",
        "      servers:",
        "        local:",
        "          type: stdio",
        "          command: override",
        "          enabled: false",
        "        workspace-server:",
        "          type: http",
        "          url: https://example.com",
        "          enabled: true",
        ""
      ].join("\n"),
      "utf-8"
    );

    const result = getWorkspaceMcpConfig(workspaceSlug);
    expect(Object.keys(result.servers).sort()).toEqual(["local", "workspace-server"]);
    expect(result.servers.local?.enabled).toBe(false);
    expect(result.servers.local?.command).toBe("override");
    expect(result.servers["workspace-server"]?.transport).toBe("streamable_http");
    expect(result.servers["workspace-server"]?.type).toBeUndefined();
  });

  test("getWorkspaceMcpConfig 应跳过缺少必要字段的 MCP 条目", () => {
    restoreEnv = withTempConfigDir();
    const workspaceSlug = "demo";

    writeFileSync(
      getWorkspaceMcpPath(workspaceSlug),
      JSON.stringify({
        servers: {
          valid: {
            type: "stdio",
            command: "node",
            enabled: true
          },
          missingCommand: {
            type: "stdio",
            enabled: true
          },
          missingUrl: {
            transport: "streamable_http",
            enabled: true
          }
        }
      }),
      "utf-8"
    );

    const result = getWorkspaceMcpConfig(workspaceSlug);
    expect(Object.keys(result.servers)).toEqual(["valid"]);
    expect(result.servers.valid?.transport).toBe("stdio");
  });

  test("saveWorkspaceMcpConfig 应写入 canonical transport 并省略 legacy type", () => {
    restoreEnv = withTempConfigDir();
    const workspaceSlug = "demo";

    saveWorkspaceMcpConfig(workspaceSlug, {
      servers: {
        remote: {
          transport: "streamable_http",
          type: "http",
          url: "https://example.com/mcp",
          enabled: true,
          disabledTools: ["echo"]
        }
      }
    });

    const saved = JSON.parse(readFileSync(getWorkspaceMcpPath(workspaceSlug), "utf-8"));
    expect(saved.servers.remote.transport).toBe("streamable_http");
    expect(saved.servers.remote.type).toBeUndefined();
    expect(saved.servers.remote.disabledTools).toEqual(["echo"]);
  });

  test("getWorkspaceSkills 应按 lume.yaml skills 配置过滤", () => {
    restoreEnv = withTempConfigDir();
    const workspaceSlug = "demo";

    writeSkill(workspaceSlug, "alpha");
    writeSkill(workspaceSlug, "beta");
    writeSkill(workspaceSlug, "gamma");

    writeFileSync(
      getLumeConfigYamlPath(),
      [
        "version: 1",
        "workspaces:",
        "  demo:",
        "    skills:",
        "      enabled:",
        "        - alpha",
        "        - beta",
        "      disabled:",
        "        - beta",
        ""
      ].join("\n"),
      "utf-8"
    );

    const skills = getWorkspaceSkills(workspaceSlug);
    expect(skills.map((item) => item.slug)).toEqual(["alpha"]);
  });

  test("getWorkspaceSkills 应解析 Alice 风格 skill 字段", () => {
    restoreEnv = withTempConfigDir();
    const workspaceSlug = "demo";
    const skillDir = join(getWorkspaceSkillsDir(workspaceSlug), "code-review");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        'name: "代码审查"',
        'description: "审查代码质量"',
        'when_to_use: "当用户要求 code review 时使用"',
        'allowed_tools: ["read_file", "bash"]',
        'argument_hint: "请提供文件路径"',
        "disable_model_invocation: true",
        'icon: "search"',
        'version: "1.2.3"',
        "---",
        "# Code Review",
      ].join("\n"),
      "utf-8"
    );

    const [skill] = getWorkspaceSkills(workspaceSlug);

    expect(skill).toMatchObject({
      slug: "code-review",
      name: "代码审查",
      description: "审查代码质量",
      whenToUse: "当用户要求 code review 时使用",
      allowedTools: ["read_file", "bash"],
      argumentHint: "请提供文件路径",
      disableModelInvocation: true,
      icon: "search",
      version: "1.2.3"
    });
  });

  test("getWorkspaceSkills 应按展示名稳定排序", () => {
    restoreEnv = withTempConfigDir();
    const workspaceSlug = "demo";

    const betaDir = join(getWorkspaceSkillsDir(workspaceSlug), "beta-slug");
    const alphaDir = join(getWorkspaceSkillsDir(workspaceSlug), "alpha-slug");
    mkdirSync(betaDir, { recursive: true });
    mkdirSync(alphaDir, { recursive: true });
    writeFileSync(
      join(betaDir, "SKILL.md"),
      "---\nname: Beta Skill\ndescription: second\n---\n# Beta\n",
      "utf-8"
    );
    writeFileSync(
      join(alphaDir, "SKILL.md"),
      "---\nname: Alpha Skill\ndescription: first\n---\n# Alpha\n",
      "utf-8"
    );

    expect(getWorkspaceSkills(workspaceSlug).map((skill) => skill.slug)).toEqual(["alpha-slug", "beta-slug"]);
  });

  test("getRuntimeSkills 应合并用户全局与工作区技能，且不污染 getWorkspaceSkills", () => {
    restoreEnv = withTempConfigDir();
    const workspaceSlug = "demo";

    const globalOnlyDir = join(getUserSkillsDir(), "global-planner");
    const userSharedDir = join(getUserSkillsDir(), "shared-planner");
    const workspaceSharedDir = join(getWorkspaceSkillsDir(workspaceSlug), "shared-planner");
    mkdirSync(globalOnlyDir, { recursive: true });
    mkdirSync(userSharedDir, { recursive: true });
    mkdirSync(workspaceSharedDir, { recursive: true });
    writeFileSync(
      join(globalOnlyDir, "SKILL.md"),
      "---\nname: Global Planner\ndescription: global only\n---\n# Global\n",
      "utf-8"
    );
    writeFileSync(
      join(userSharedDir, "SKILL.md"),
      "---\nname: User Shared\ndescription: user copy\n---\n# User\n",
      "utf-8"
    );
    writeFileSync(
      join(workspaceSharedDir, "SKILL.md"),
      "---\nname: Workspace Shared\ndescription: workspace copy\n---\n# Workspace\n",
      "utf-8"
    );

    expect(getWorkspaceSkills(workspaceSlug).map((skill) => skill.slug)).toEqual(["shared-planner"]);
    expect(getRuntimeSkills(workspaceSlug).map((skill) => [skill.slug, skill.name])).toEqual([
      ["global-planner", "Global Planner"],
      ["shared-planner", "Workspace Shared"]
    ]);
  });

  test("getRuntimeSkills 应加载 Alice 兼容项目 skill 并覆盖同名用户全局 skill", () => {
    restoreEnv = withTempConfigDir();
    const workspaceSlug = "demo";
    const projectDir = join(
      tmpdir(),
      `lume-alice-project-skills-test-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );

    try {
      const userSkillDir = join(getUserSkillsDir(), "code-review");
      const aliceProjectSkillDir = join(projectDir, ".alice", "skills", "code-review");
      mkdirSync(userSkillDir, { recursive: true });
      mkdirSync(aliceProjectSkillDir, { recursive: true });
      writeFileSync(
        join(userSkillDir, "SKILL.md"),
        "---\nname: User Code Review\ndescription: user copy\n---\n# User\n",
        "utf-8"
      );
      writeFileSync(
        join(aliceProjectSkillDir, "SKILL.md"),
        "---\nname: Project Code Review\ndescription: project copy\n---\n# Project\n",
        "utf-8"
      );

      expect(getRuntimeSkills(workspaceSlug, projectDir).map((skill) => [skill.slug, skill.name])).toEqual([
        ["code-review", "Project Code Review"]
      ]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("getRuntimeSkills 应让 Alice 项目 skill 覆盖旧 Lume 项目 skill", () => {
    restoreEnv = withTempConfigDir();
    const workspaceSlug = "demo";
    const projectDir = join(
      tmpdir(),
      `lume-alice-project-over-legacy-test-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );

    try {
      const legacyProjectSkillDir = join(projectDir, ".lume", "skills", "code-review");
      const aliceProjectSkillDir = join(projectDir, ".alice", "skills", "code-review");
      mkdirSync(legacyProjectSkillDir, { recursive: true });
      mkdirSync(aliceProjectSkillDir, { recursive: true });
      writeFileSync(
        join(legacyProjectSkillDir, "SKILL.md"),
        "---\nname: Legacy Project Code Review\ndescription: legacy project copy\n---\n# Legacy\n",
        "utf-8"
      );
      writeFileSync(
        join(aliceProjectSkillDir, "SKILL.md"),
        "---\nname: Alice Project Code Review\ndescription: alice project copy\n---\n# Alice\n",
        "utf-8"
      );

      expect(getRuntimeSkills(workspaceSlug, projectDir).map((skill) => [skill.slug, skill.name])).toEqual([
        ["code-review", "Alice Project Code Review"]
      ]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("getRuntimeSkills 应加载 Alice 兼容用户全局 skill 并覆盖旧 Lume 全局 skill", () => {
    restoreEnv = withTempConfigDir();
    const workspaceSlug = "demo";
    const legacyUserSkillDir = join(getUserSkillsDir(), "global-planner");
    const aliceUserSkillDir = join(getAliceUserSkillsDir(), "global-planner");

    mkdirSync(legacyUserSkillDir, { recursive: true });
    mkdirSync(aliceUserSkillDir, { recursive: true });
    writeFileSync(
      join(legacyUserSkillDir, "SKILL.md"),
      "---\nname: Legacy Global Planner\ndescription: lume legacy\n---\n# Legacy\n",
      "utf-8"
    );
    writeFileSync(
      join(aliceUserSkillDir, "SKILL.md"),
      "---\nname: Alice Global Planner\ndescription: alice global\n---\n# Alice\n",
      "utf-8"
    );

    expect(getRuntimeSkills(workspaceSlug).map((skill) => [skill.slug, skill.name])).toEqual([
      ["global-planner", "Alice Global Planner"]
    ]);
  });
});

describe("agent-workspace-manager workspace creation", () => {
  let restoreEnv: (() => void) | null = null;

  afterEach(() => {
    restoreEnv?.();
    restoreEnv = null;
  });

  test("createAgentWorkspace 应接受显式 slug 并规范化为 kebab-case", () => {
    restoreEnv = withTempConfigDir();

    const workspace = createAgentWorkspace("CLI Workspace", { slug: "  My_Custom Slug  " });

    expect(workspace.slug).toBe("my-custom-slug");
    expect(getAgentWorkspaceBySlug("my-custom-slug")?.id).toBe(workspace.id);
    expect(listAgentWorkspaces().map((item) => item.slug)).toEqual(["my-custom-slug"]);
  });

  test("createAgentWorkspace 应拒绝重复的显式 slug", () => {
    restoreEnv = withTempConfigDir();

    createAgentWorkspace("First Workspace", { slug: "CLI Workspace" });

    expect(() => createAgentWorkspace("Second Workspace", { slug: "cli-workspace" })).toThrow(
      "workspace slug 已存在"
    );
  });
});
