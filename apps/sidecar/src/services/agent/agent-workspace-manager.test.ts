import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getLumeConfigYamlPath,
  getWorkspaceMcpPath,
  getWorkspaceSkillsDir
} from "../infra/config-paths";
import {
  createAgentWorkspace,
  getAgentWorkspaceBySlug,
  listAgentWorkspaces,
  getWorkspaceMcpConfig,
  getWorkspaceSkills
} from "./agent-workspace-manager";

function withTempConfigDir(): () => void {
  const previous = process.env.LUME_CONFIG_DIR;
  const next = join(tmpdir(), `lume-workspace-manager-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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
    expect(result.servers["workspace-server"]?.type).toBe("http");
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
