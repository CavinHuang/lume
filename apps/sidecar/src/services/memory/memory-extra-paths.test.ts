import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryIndexManager } from "./memory-index-manager";

describe("memory-extra-paths", () => {
  test("indexWorkspace 应索引 extraPaths 中的 markdown 文件", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-memory-extra-root-"));
    const externalRoot = mkdtempSync(join(tmpdir(), "lume-memory-extra-src-"));
    const externalFile = join(externalRoot, "notes.md");

    mkdirSync(join(root, "memory"), { recursive: true });
    writeFileSync(join(root, "MEMORY.md"), "workspace memory", "utf-8");
    writeFileSync(externalFile, "This external memory mentions migration checklist.", "utf-8");

    const manager = new MemoryIndexManager({
      workspaceRoot: root,
      workspaceSlug: "default",
      dbPath: join(root, "default.sqlite"),
      sources: ["memory"],
      extraPaths: [externalRoot]
    });

    await manager.indexWorkspace(true);
    const result = await manager.search({ query: "migration checklist", maxResults: 5 });
    expect(result.some((item) => item.path.startsWith("extra:"))).toBeTrue();

    const extraItem = result.find((item) => item.path.startsWith("extra:"));
    expect(extraItem).toBeDefined();
    if (extraItem) {
      const detail = manager.readFile({ path: extraItem.path, from: 1, lines: 2 });
      expect(detail.text).toContain("external memory");
    }

    manager.dispose();
    rmSync(root, { recursive: true, force: true });
    rmSync(externalRoot, { recursive: true, force: true });
  });
});
