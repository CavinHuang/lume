import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAgentThread } from "../../agent/agent-thread-manager";
import { createAgentWorkspace } from "../../agent/agent-workspace-manager";
import { createLumeRuntimeTools } from "./create-lume-tools";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lume-dream-tools-"));
  process.env.LUME_CONFIG_DIR = root;
});

afterEach(() => {
  delete process.env.LUME_CONFIG_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe("Dream runtime tools", () => {
  test("exposes only read-only memory, evidence and project tools", () => {
    const workspace = createAgentWorkspace("Demo", { slug: "demo" });
    const thread = createAgentThread("Dream", undefined, workspace.id, undefined, undefined, {
      memoryProfile: { kind: "dream", jobId: "job-1" }
    });

    const tools = createLumeRuntimeTools({
      threadId: thread.id,
      workspaceId: workspace.id,
      workspaceSlug: workspace.slug,
      threadType: "subagent",
      includeCitations: false,
      emitAskUserQuestion: () => undefined,
      emitToolPermissionRequest: () => undefined
    });

    const customNames = tools.customTools.map((tool) => tool.name).sort();
    expect(customNames).toEqual([
      "memory.evidence.read",
      "memory.evidence.search",
      "memory.read",
      "memory.search"
    ]);
    expect(customNames).not.toContain("Write");
    expect(customNames).not.toContain("Bash");
    expect(customNames).not.toContain("memory.remember");
  });
});
