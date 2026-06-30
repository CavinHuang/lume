import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { getAllBaseTools } = await import("./index.js");

function getTool(name: string) {
  return getAllBaseTools().find((tool) => tool.name === name);
}

describe("filesystem discovery tools", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lume-discovery-"));
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "src", "read.ts"), "export const value = 1\n");
    writeFileSync(join(root, "docs", "AGENTS.md"), "instructions\n");
  });

  test("FindFiles fuzzy finds files under the resolved path", async () => {
    try {
      const tool = getTool("FindFiles");
      expect(tool).toBeDefined();

      const result = await tool!.call(
        { query: "read", path: ".", max_results: 7 },
        { cwd: root } as any,
      );

      expect(result.is_error).toBe(false);
      const payload = JSON.parse(String(result.content));
      expect(payload.query).toBe("read");
      expect(payload.path).toBe(root);
      expect(toPosix(payload.matches[0].path)).toEndWith("src/read.ts");
      expect(payload.matches[0].is_directory).toBe(false);
      expect(payload.total_matches).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("FindFiles rejects sandbox-denied paths before traversal", async () => {
    try {
      const tool = getTool("FindFiles");
      expect(tool).toBeDefined();

      const result = await tool!.call(
        { query: "read", path: root },
        { cwd: root, sandbox: { enabled: true, filesystem: { denyRead: [root] } } } as any,
      );

      expect(result.is_error).toBe(true);
      expect(String(result.content)).toContain("Sandbox denied read access");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ListWorkspaceTree lists bounded entries and AGENTS.md files", async () => {
    try {
      const tool = getTool("ListWorkspaceTree");
      expect(tool).toBeDefined();

      const result = await tool!.call(
        { path: ".", max_depth: 3, collect_agents_md: true },
        { cwd: root } as any,
      );

      expect(result.is_error).toBe(false);
      const payload = JSON.parse(String(result.content));
      expect(payload.path).toBe(root);
      expect(payload.entries.some((entry: { path: string }) => toPosix(entry.path).endsWith("src"))).toBe(true);
      expect(toPosix(payload.agentsMdFiles[0])).toEndWith("docs/AGENTS.md");
      expect(payload.truncated).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}
