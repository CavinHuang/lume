import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentWorkspacePath, getGlobalStructuredMemoryDbPath } from "../infra/config-paths";
import { closeMemoryManagers, writeWorkspaceMemory } from "./memory-service";
import { buildMemoryContext } from "./memory-prompt-builder";
import { MemoryRepository } from "./memory-repository";

function removeDirWithRetry(path: string): void {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

describe("memory-prompt-builder", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-memory-prompt-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    closeMemoryManagers();
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
    if (tempConfigDir) {
      removeDirWithRetry(tempConfigDir);
      tempConfigDir = "";
    }
  });

  test("main session 注入 workspace brief、global preference 和相关召回", async () => {
    const workspaceSlug = `memory-prompt-main-${Date.now()}`;
    const root = getAgentWorkspacePath(workspaceSlug);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "WORKSPACE.md"), "Lume is a local-first desktop app with auditable memory.", "utf-8");

    await writeWorkspaceMemory({
      workspaceSlug,
      content: "The workspace memory design keeps daily evidence and structured recall.",
      kind: "decision",
      scope: "workspace",
      source: "manual",
      importance: 4,
      confidence: 0.9
    });

    const globalRepository = new MemoryRepository({
      dbPath: getGlobalStructuredMemoryDbPath(),
      workspaceSlug: "__global__"
    });
    await globalRepository.save({
      workspaceSlug: "__global__",
      scope: "global",
      kind: "preference",
      source: "promotion",
      content: "User prefers auditable local-first product decisions.",
      importance: 5,
      confidence: 0.95
    });
    globalRepository.dispose();

    const context = await buildMemoryContext({
      workspaceSlug,
      sessionType: "main",
      userInput: "继续设计 auditable memory",
      maxItems: 6
    });

    expect(context).toContain("## Memory Context");
    expect(context).toContain("### Workspace Brief");
    expect(context).toContain("local-first desktop app");
    expect(context).toContain("### Global Preferences");
    expect(context).toContain("auditable local-first product decisions");
    expect(context).toContain("### Relevant Recall");
    expect(context).toContain("structured recall");
  });

  test("subagent 不注入 global 或 MEMORY.md 长期记忆", async () => {
    const workspaceSlug = `memory-prompt-sub-${Date.now()}`;
    const root = getAgentWorkspacePath(workspaceSlug);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "WORKSPACE.md"), "Subagents may read the workspace brief.", "utf-8");
    writeFileSync(join(root, "MEMORY.md"), "private long term marker", "utf-8");

    const globalRepository = new MemoryRepository({
      dbPath: getGlobalStructuredMemoryDbPath(),
      workspaceSlug: "__global__"
    });
    await globalRepository.save({
      workspaceSlug: "__global__",
      scope: "global",
      kind: "preference",
      source: "promotion",
      content: "private global marker",
      importance: 5,
      confidence: 0.95
    });
    globalRepository.dispose();

    const context = await buildMemoryContext({
      workspaceSlug,
      sessionType: "subagent",
      userInput: "private marker",
      maxItems: 5
    });

    expect(context).toContain("Subagents may read the workspace brief");
    expect(context).not.toContain("private global marker");
    expect(context).not.toContain("private long term marker");
  });
});
