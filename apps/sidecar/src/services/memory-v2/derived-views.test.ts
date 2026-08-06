import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rebuildDerivedMemoryViews } from "./derived-views";
import { createMemoryV2Store } from "./markdown-store";
import { getMemoryV2ScopePaths } from "./paths";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lume-derived-memory-"));
  process.env.LUME_CONFIG_DIR = root;
});

afterEach(() => {
  delete process.env.LUME_CONFIG_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe("derived memory views", () => {
  test("builds dynamic capsules and a task-free workspace brief", async () => {
    const store = createMemoryV2Store();
    for (const statement of ["Memory 使用 Markdown 作为事实源", "Memory 的条目必须带 revision"]) {
      store.writeEntry({
        targetScope: "workspace",
        semanticRole: "constraint",
        statement,
        confidence: "high",
        facets: ["memory-storage"],
        appliesWhen: { workspaceSlug: "demo" }
      });
    }
    store.writeEntry({
      targetScope: "workspace",
      semanticRole: "state",
      statement: "下一步实现管理页面",
      confidence: "high",
      facets: ["memory-storage"],
      appliesWhen: { workspaceSlug: "demo" }
    });

    await rebuildDerivedMemoryViews({ scope: "workspace", workspaceSlug: "demo" });
    const paths = getMemoryV2ScopePaths({ scope: "workspace", workspaceSlug: "demo" });
    const brief = readFileSync(paths.workspaceBrief, "utf-8");
    expect(brief).toContain("Memory 使用 Markdown");
    expect(brief).not.toContain("下一步实现管理页面");
    expect(existsSync(paths.capsulesDir)).toBe(true);
    expect(readFileSync(paths.memoryMd, "utf-8")).toContain("Derived index");
  });

  test("does not project entries with recall disabled into derived indexes", async () => {
    const store = createMemoryV2Store();
    store.writeEntry({
      targetScope: "workspace",
      semanticRole: "fact",
      statement: "Do not project this private recall entry",
      confidence: "high",
      appliesWhen: { workspaceSlug: "demo" }
    }, {
      activation: { recall: false, persona: false, suggestion: false, analyst: false }
    });

    await rebuildDerivedMemoryViews({ scope: "workspace", workspaceSlug: "demo" });
    const paths = getMemoryV2ScopePaths({ scope: "workspace", workspaceSlug: "demo" });
    expect(readFileSync(paths.memoryMd, "utf-8")).not.toContain("Do not project this private recall entry");
  });
});
