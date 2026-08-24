import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { buildProjectInstructionsSection, discoverProjectInstructionFiles } from "./project-instructions-section";

describe("project instructions discovery", () => {
  test("#563: 从 agentCwd 发现 CLAUDE.md 并注入项目指令段", () => {
    const root = mkdtempSync(join(tmpdir(), "lume-proj-"));
    try {
      writeFileSync(join(root, "CLAUDE.md"), "---\ntitle: x\n---\n\n# 项目约定\n\n使用 bun test 跑测试。");
      const section = buildProjectInstructionsSection(root);
      expect(section).toContain("## 项目指令");
      expect(section).toContain("使用 bun test 跑测试。");
      // front matter 已被清洗
      expect(section).not.toContain("title: x");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("#563: 向上遍历发现祖先目录的指令文件", () => {
    const root = mkdtempSync(join(tmpdir(), "lume-proj-"));
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    try {
      writeFileSync(join(root, "AGENTS.md"), "根目录架构约定。");
      const found = discoverProjectInstructionFiles(nested);
      expect(found.length).toBe(1);
      expect(found[0]!.path).toBe(join(root, "AGENTS.md"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("#563: 同目录 CLAUDE.md 优先于 AGENTS.md", () => {
    const root = mkdtempSync(join(tmpdir(), "lume-proj-"));
    try {
      writeFileSync(join(root, "CLAUDE.md"), "claude 约定");
      writeFileSync(join(root, "AGENTS.md"), "agents 约定");
      const found = discoverProjectInstructionFiles(root);
      expect(found.length).toBe(1);
      expect(found[0]!.content).toContain("claude 约定");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("#563: 无指令文件时返回空串（行为不变）", () => {
    const root = mkdtempSync(join(tmpdir(), "lume-proj-"));
    try {
      expect(buildProjectInstructionsSection(root)).toBe("");
      expect(buildProjectInstructionsSection(undefined)).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("#563: 超长文件截断并带标记", () => {
    const root = mkdtempSync(join(tmpdir(), "lume-proj-"));
    try {
      writeFileSync(join(root, "CLAUDE.md"), `很长的文档。${"x".repeat(20_000)}`);
      const section = buildProjectInstructionsSection(root);
      expect(section).toContain("[已截断：原文件");
      expect(section.length).toBeLessThan(20_000 + 500);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
