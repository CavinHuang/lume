import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getAgentSessionMessages, listAgentSessions } from "./agent-session-manager";
import { listAgentWorkspaces } from "./agent-workspace-manager";
import { getConversationMessages } from "./conversation-manager";
import {
  getAgentSessionsIndexPath,
  getAgentWorkspacesIndexPath,
  getConversationMessagesPath
} from "./config-paths";

describe("index recovery", () => {
  let previousConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-index-recovery-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = previousConfigDir;
    }
    if (tempConfigDir) {
      rmSync(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = "";
    }
  });

  test("agent sessions 索引损坏时应自动备份并回退空列表", () => {
    const indexPath = getAgentSessionsIndexPath();
    writeFileSync(indexPath, "{broken-json", "utf-8");

    const sessions = listAgentSessions();
    expect(sessions).toEqual([]);

    const files = readdirSync(tempConfigDir);
    expect(files.some((name) => name.startsWith("agent-sessions.json.corrupt-"))).toBeTrue();
  });

  test("agent workspaces 索引损坏时应自动备份并回退空列表", () => {
    const indexPath = getAgentWorkspacesIndexPath();
    writeFileSync(indexPath, "{broken-json", "utf-8");

    const workspaces = listAgentWorkspaces();
    expect(workspaces).toEqual([]);

    const files = readdirSync(tempConfigDir);
    expect(files.some((name) => name.startsWith("agent-workspaces.json.corrupt-"))).toBeTrue();
  });

  test("conversation 消息文件损坏时应自动备份并回退空列表", () => {
    const conversationId = "conversation-broken";
    const messagesPath = getConversationMessagesPath(conversationId);
    writeFileSync(messagesPath, "{bad-json-line}\n", "utf-8");

    const messages = getConversationMessages(conversationId);
    expect(messages).toEqual([]);

    const conversationDir = join(tempConfigDir, "conversations");
    const files = readdirSync(conversationDir);
    expect(files.some((name) => name.startsWith(`${conversationId}.jsonl.corrupt-`))).toBeTrue();
  });
});
