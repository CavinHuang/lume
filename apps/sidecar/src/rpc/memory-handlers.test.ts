import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MEMORY_IPC_CHANNELS } from "@lume/shared";
import { createAgentThread, appendAgentTranscriptMessage } from "../services/agent/agent-thread-manager";
import { createAgentWorkspace } from "../services/agent/agent-workspace-manager";
import { createMemoryV2Store } from "../services/memory-v2/markdown-store";
import { createMemoryHandlers } from "./memory-handlers";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lume-memory-rpc-"));
  process.env.LUME_CONFIG_DIR = root;
});

afterEach(() => {
  delete process.env.LUME_CONFIG_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe("memory handlers", () => {
  test("settings snapshot handler reads Memory V2 state", async () => {
    createMemoryV2Store().writeEntry({
      kind: "preference",
      targetScope: "workspace",
      statement: "Memory settings page reads V2 markdown directly.",
      confidence: "high",
      appliesWhen: {
        workspaceSlug: "demo"
      }
    });

    const handlers = createMemoryHandlers();
    const result = await handlers[MEMORY_IPC_CHANNELS.SETTINGS_SNAPSHOT]?.({
      workspaceSlug: "demo"
    });

    expect(result).toMatchObject({
      workspaceSlug: "demo",
      counts: {
        workspace: 1
      }
    });
  });

  test("organize history handler extracts memories from existing thread data", async () => {
    const workspace = createAgentWorkspace("Demo", { slug: "demo" });
    const thread = createAgentThread("memory history", undefined, workspace.id);
    appendAgentTranscriptMessage(thread.id, {
      id: "msg-user-1",
      role: "user",
      content: "叫我 Mason",
      createdAt: 100
    });

    const handlers = createMemoryHandlers();
    const result = await handlers[MEMORY_IPC_CHANNELS.ORGANIZE_HISTORY]?.({
      workspaceSlug: "demo",
      limit: 20
    });

    expect(result).toMatchObject({
      workspaceSlug: "demo",
      scannedMessages: 1,
      candidateCount: 1,
      actions: {
        new: 1
      }
    });
  });
});
