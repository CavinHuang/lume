import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentWorkspacePath } from "../infra/config-paths";
import {
  ensureBootstrapFiles,
  filterComponentsForSessionType,
  resolveLoadedLongTermMemoryPath,
  readSystemPromptComponents,
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
  });

  test("核心 persona 模板应包含 Prompt V2 companion 结构", () => {
    const soul = readTemplateContent("SOUL");
    const identity = readTemplateContent("IDENTITY");
    const agents = readTemplateContent("AGENTS");
    const bootstrap = readTemplateContent("BOOTSTRAP");

    expect(soul).toContain("## Core Truths");
    expect(soul).toContain("## Subjecthood");
    expect(soul).toContain("## Appearance and Self-Recognition");
    expect(identity).toContain("## Appearance");
    expect(identity).toContain("## Self-Recognition");
    expect(agents).toContain("## Persona Guardrails");
    expect(bootstrap).toContain("## Persona Setup");
  });

  test("ensureBootstrapFiles 默认仅创建核心文件与 BOOTSTRAP（不自动创建 HEARTBEAT/MEMORY）", () => {
    const workspaceSlug = `bootstrap-default-${Date.now()}`;
    const workspacePath = getAgentWorkspacePath(workspaceSlug);

    try {
      const result = ensureBootstrapFiles(workspaceSlug);
      expect(result.created).toContain("SOUL.md");
      expect(result.created).toContain("AGENTS.md");
      expect(result.created).toContain("BOOTSTRAP.md");

      expect(existsSync(join(workspacePath, "HEARTBEAT.md"))).toBeFalse();
      expect(existsSync(join(workspacePath, "MEMORY.md"))).toBeFalse();
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  test("非全新工作区不应再次创建 BOOTSTRAP.md", () => {
    const workspaceSlug = `bootstrap-existing-${Date.now()}`;
    const workspacePath = getAgentWorkspacePath(workspaceSlug);

    try {
      mkdirSync(workspacePath, { recursive: true });
      writeFileSync(join(workspacePath, "AGENTS.md"), "# existing", "utf-8");

      const result = ensureBootstrapFiles(workspaceSlug);
      expect(result.created).not.toContain("BOOTSTRAP.md");
      expect(result.skipped).toContain("BOOTSTRAP.md");
      expect(existsSync(join(workspacePath, "BOOTSTRAP.md"))).toBeFalse();
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  test("readSystemPromptComponents 应兼容 memory.md 作为备用长期记忆", () => {
    const workspaceSlug = `bootstrap-memory-alt-${Date.now()}`;
    const workspacePath = getAgentWorkspacePath(workspaceSlug);

    try {
      mkdirSync(workspacePath, { recursive: true });
      const altMemoryPath = join(workspacePath, "memory.md");
      writeFileSync(altMemoryPath, "---\ntitle: memory\n---\n# alt memory\nremember this", "utf-8");

      const components = readSystemPromptComponents(workspaceSlug, {
        sessionType: "main",
        includeMemory: true,
        includeDailyMemory: false
      });

      expect(components.memory).toContain("remember this");
      expect(components.memory?.startsWith("---")).toBeFalse();
      expect(readFileSync(altMemoryPath, "utf-8")).toContain("alt memory");
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
        agents: "agents",
        tools: "tools",
        heartbeat: "heartbeat",
        memory: "memory",
        dailyMemory: "daily"
      },
      "subagent"
    );
    expect(filtered).toEqual({
      agents: "agents",
      tools: "tools"
    });
  });

  test("resolveLoadedLongTermMemoryPath 仅存在 memory.md 时应返回 memory.md", () => {
    const workspaceSlug = `bootstrap-memory-path-alt-${Date.now()}`;
    const workspacePath = getAgentWorkspacePath(workspaceSlug);

    try {
      mkdirSync(workspacePath, { recursive: true });
      writeFileSync(join(workspacePath, "memory.md"), "alt", "utf-8");
      expect(resolveLoadedLongTermMemoryPath(workspaceSlug)).toBe("memory.md");
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  test("resolveLoadedLongTermMemoryPath 同时存在时优先非空 MEMORY.md", () => {
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

  test("resolveLoadedLongTermMemoryPath 主文件为空时回退 memory.md", () => {
    const workspaceSlug = `bootstrap-memory-path-fallback-${Date.now()}`;
    const workspacePath = getAgentWorkspacePath(workspaceSlug);

    try {
      mkdirSync(workspacePath, { recursive: true });
      writeFileSync(join(workspacePath, "MEMORY.md"), "   \n", "utf-8");
      writeFileSync(join(workspacePath, "memory.md"), "alt", "utf-8");
      // 在大小写不敏感文件系统上，两个名字可能指向同一文件，此时无法稳定构造“主文件为空、备用非空”。
      const dirEntries = new Set(readdirSync(workspacePath));
      const bothDistinct = dirEntries.has("MEMORY.md") && dirEntries.has("memory.md");
      const resolved = resolveLoadedLongTermMemoryPath(workspaceSlug);
      if (bothDistinct) {
        expect(resolved).toBe("memory.md");
      } else {
        expect(resolved === "MEMORY.md" || resolved === "memory.md").toBeTrue();
      }
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});
