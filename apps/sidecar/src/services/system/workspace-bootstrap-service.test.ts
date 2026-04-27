import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentWorkspacePath } from "../infra/config-paths";
import {
  ensureBootstrapFiles,
  filterComponentsForSessionType,
  resolveLoadedLongTermMemoryPath,
  readTemplateContent
} from "./workspace-bootstrap-service";

describe("workspace-bootstrap-service", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-bootstrap-test-"));
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

  test("readTemplateContent 应移除 frontmatter", () => {
    const content = readTemplateContent("SOUL");
    expect(content.startsWith("---")).toBeFalse();
    expect(content).toContain("# SOUL.md");

    const workspace = readTemplateContent("WORKSPACE");
    expect(workspace.startsWith("---")).toBeFalse();
    expect(workspace).toContain("# WORKSPACE.md");
  });

  test("核心 persona 模板应包含默认克制的人格引导结构", () => {
    const soul = readTemplateContent("SOUL");
    const identity = readTemplateContent("IDENTITY");
    const agents = readTemplateContent("AGENTS");

    expect(soul).toContain("## Core Truths");
    expect(soul).toContain("## Subjecthood");
    expect(soul).toContain("## Appearance and Self-Recognition");
    expect(identity).toContain("## Appearance");
    expect(identity).toContain("## Self-Recognition");
    expect(agents).toContain("## Persona Guardrails");
  });

  test("ensureBootstrapFiles 默认创建核心文件和 WORKSPACE（不再创建 BOOTSTRAP，且不自动创建 HEARTBEAT/MEMORY）", () => {
    const workspaceSlug = `bootstrap-default-${Date.now()}`;
    const workspacePath = getAgentWorkspacePath(workspaceSlug);

    try {
      const result = ensureBootstrapFiles(workspaceSlug);
      expect(result.created).toContain("SOUL.md");
      expect(result.created).toContain("AGENTS.md");
      expect(result.created).toContain("WORKSPACE.md");
      expect(result.created).not.toContain("BOOTSTRAP.md");

      expect(existsSync(join(workspacePath, "HEARTBEAT.md"))).toBeFalse();
      expect(existsSync(join(workspacePath, "MEMORY.md"))).toBeFalse();
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  test("非全新工作区不应创建 BOOTSTRAP.md", () => {
    const workspaceSlug = `bootstrap-existing-${Date.now()}`;
    const workspacePath = getAgentWorkspacePath(workspaceSlug);

    try {
      mkdirSync(workspacePath, { recursive: true });
      writeFileSync(join(workspacePath, "AGENTS.md"), "# existing", "utf-8");

      const result = ensureBootstrapFiles(workspaceSlug);
      expect(result.created).not.toContain("BOOTSTRAP.md");
      expect(result.skipped).not.toContain("BOOTSTRAP.md");
      expect(existsSync(join(workspacePath, "BOOTSTRAP.md"))).toBeFalse();
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  test("filterComponentsForSessionType 在 subagent 仅保留 AGENTS/TOOLS", () => {
    const filtered = filterComponentsForSessionType(
      {
        soul: "soul",
        user: "user",
        identity: "identity",
        workspace: "workspace",
        agents: "agents",
        tools: "tools",
        heartbeat: "heartbeat",
        memory: "memory",
        dailyMemory: "daily"
      },
      "subagent"
    );
    expect(filtered).toEqual({
      workspace: "workspace",
      agents: "agents",
      tools: "tools"
    });
  });

  test("resolveLoadedLongTermMemoryPath 仅存在旧 memory.md 时应返回 null", () => {
    const workspaceSlug = `bootstrap-memory-path-alt-${Date.now()}`;
    const workspacePath = getAgentWorkspacePath(workspaceSlug);

    try {
      mkdirSync(workspacePath, { recursive: true });
      writeFileSync(join(workspacePath, "memory.md"), "alt", "utf-8");
      expect(resolveLoadedLongTermMemoryPath(workspaceSlug)).toBeNull();
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  test("resolveLoadedLongTermMemoryPath 同时存在时仅接受 MEMORY.md", () => {
    const workspaceSlug = `bootstrap-memory-path-both-${Date.now()}`;
    const workspacePath = getAgentWorkspacePath(workspaceSlug);

    try {
      mkdirSync(workspacePath, { recursive: true });
      writeFileSync(join(workspacePath, "MEMORY.md"), "primary", "utf-8");
      writeFileSync(join(workspacePath, "memory.md"), "alt", "utf-8");
      expect(resolveLoadedLongTermMemoryPath(workspaceSlug)).toBe("MEMORY.md");
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  test("resolveLoadedLongTermMemoryPath 主文件为空时返回 null", () => {
    const workspaceSlug = `bootstrap-memory-path-fallback-${Date.now()}`;
    const workspacePath = getAgentWorkspacePath(workspaceSlug);

    try {
      mkdirSync(workspacePath, { recursive: true });
      writeFileSync(join(workspacePath, "MEMORY.md"), "   \n", "utf-8");
      writeFileSync(join(workspacePath, "memory.md"), "alt", "utf-8");
      const dirEntries = new Set(readdirSync(workspacePath));
      const bothDistinct = dirEntries.has("MEMORY.md") && dirEntries.has("memory.md");
      const resolved = resolveLoadedLongTermMemoryPath(workspaceSlug);
      if (bothDistinct) {
        expect(resolved).toBeNull();
      } else {
        expect(resolved === null || resolved === "MEMORY.md").toBeTrue();
      }
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});
