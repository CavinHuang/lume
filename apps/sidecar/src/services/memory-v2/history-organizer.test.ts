import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAgentThread, appendAgentTranscriptMessage } from "../agent/agent-thread-manager";
import { createAgentWorkspace } from "../agent/agent-workspace-manager";
import { listEntries } from "./markdown-store";
import { organizeMemoryHistory } from "./history-organizer";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lume-memory-v2-organize-"));
  process.env.LUME_CONFIG_DIR = root;
});

afterEach(() => {
  delete process.env.LUME_CONFIG_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe("organizeMemoryHistory", () => {
  test("extracts durable claims from existing workspace thread messages", async () => {
    const workspace = createAgentWorkspace("Demo", { slug: "demo" });
    const thread = createAgentThread("memory history", undefined, workspace.id);
    appendAgentTranscriptMessage(thread.id, {
      id: "msg-user-1",
      role: "user",
      content: "叫我 Mason",
      createdAt: 100
    });
    appendAgentTranscriptMessage(thread.id, {
      id: "msg-assistant-1",
      role: "assistant",
      content: "好，以后叫你 Mason。",
      createdAt: 200
    });

    const result = await organizeMemoryHistory({
      workspaceSlug: "demo",
      limit: 20
    });

    expect(result.scannedSources).toBe(1);
    expect(result.scannedMessages).toBe(1);
    expect(result.candidateCount).toBe(1);
    expect(result.actions.new).toBe(1);
    expect(result.items).toEqual([expect.objectContaining({
      sourcePath: `threads/${thread.id}`,
      statement: "用户希望被称呼为 Mason",
      action: "new"
    })]);
    expect(listEntries({ workspaceSlug: "demo", scopes: ["global"] })).toEqual([
      expect.objectContaining({
        statement: "用户希望被称呼为 Mason",
        frontmatter: expect.objectContaining({
          claim: {
            subject: "user/self",
            predicate: "preferred_name",
            object: "Mason"
          }
        })
      })
    ]);
  });

  test("re-running history organization does not append duplicate claims", async () => {
    const workspace = createAgentWorkspace("Demo", { slug: "demo" });
    const thread = createAgentThread("memory history", undefined, workspace.id);
    appendAgentTranscriptMessage(thread.id, {
      id: "msg-user-1",
      role: "user",
      content: "就想叫你 Alice",
      createdAt: 100
    });

    await organizeMemoryHistory({ workspaceSlug: "demo" });
    const second = await organizeMemoryHistory({ workspaceSlug: "demo" });

    expect(second.actions.duplicate).toBe(1);
    expect(listEntries({ workspaceSlug: "demo", scopes: ["global"] })).toHaveLength(1);
  });
});
