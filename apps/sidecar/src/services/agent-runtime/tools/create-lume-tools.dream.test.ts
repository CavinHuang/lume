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

    expect(tools.availableToolNames.sort()).toEqual([
      "Glob",
      "Grep",
      "Read",
      "ls",
      "memory.evidence.read",
      "memory.evidence.search",
      "memory.read",
      "memory.search"
    ].sort());
    expect(tools.availableToolNames).not.toContain("Write");
    expect(tools.availableToolNames).not.toContain("Bash");
    expect(tools.availableToolNames).not.toContain("memory.remember");
  });
});
