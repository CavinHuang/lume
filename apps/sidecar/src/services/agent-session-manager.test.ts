import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAgentSession,
  getAgentSessionMeta,
  getAgentSessionMessages,
  migrateChatToAgentSession,
  moveAgentSessionToWorkspace,
  updateAgentSessionMeta,
  toggleAgentSessionPin
} from "./agent-session-manager";
import { createAgentWorkspace } from "./agent-workspace-manager";
import { getAgentWorkspacePath } from "./config-paths";
import { appendMessage, createConversation } from "./conversation-manager";

describe("agent-session-manager advanced ops", () => {
  let previousConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-agent-session-manager-"));
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

  test("toggleAgentSessionPin 应可在置顶和取消置顶之间切换", () => {
    const created = createAgentSession("测试会话");
    const pinned = toggleAgentSessionPin(created.id);

    expect(pinned.pinned).toBeTrue();
    expect(getAgentSessionMeta(created.id)?.pinned).toBeTrue();

    const unpinned = toggleAgentSessionPin(created.id);
    expect(unpinned.pinned).toBeFalse();
    expect(getAgentSessionMeta(created.id)?.pinned).toBeFalse();
  });

  test("moveAgentSessionToWorkspace 应迁移 session 工作目录并更新 workspaceId", () => {
    const sourceWorkspace = createAgentWorkspace("源工作区");
    const targetWorkspace = createAgentWorkspace("目标工作区");
    const created = createAgentSession("迁移会话", undefined, sourceWorkspace.id);

    const sourceSessionDir = join(getAgentWorkspacePath(sourceWorkspace.slug), created.id);
    const targetSessionDir = join(getAgentWorkspacePath(targetWorkspace.slug), created.id);
    writeFileSync(join(sourceSessionDir, "note.txt"), "hello", "utf-8");
    updateAgentSessionMeta(created.id, {
      sdkSessionId: "sdk-session",
      piSessionId: "pi-session"
    });

    const moved = moveAgentSessionToWorkspace(created.id, targetWorkspace.id);

    expect(moved.workspaceId).toBe(targetWorkspace.id);
    expect(moved.sdkSessionId).toBeUndefined();
    expect(moved.piSessionId).toBeUndefined();
    expect(existsSync(sourceSessionDir)).toBeFalse();
    expect(existsSync(targetSessionDir)).toBeTrue();
    expect(readFileSync(join(targetSessionDir, "note.txt"), "utf-8")).toBe("hello");
  });

  test("moveAgentSessionToWorkspace 在无源工作目录时也应创建目标目录", () => {
    const targetWorkspace = createAgentWorkspace("目标工作区");
    const created = createAgentSession("新会话");

    const moved = moveAgentSessionToWorkspace(created.id, targetWorkspace.id);
    const targetSessionDir = join(getAgentWorkspacePath(targetWorkspace.slug), created.id);

    expect(moved.workspaceId).toBe(targetWorkspace.id);
    expect(existsSync(targetSessionDir)).toBeTrue();
    expect(getAgentSessionMeta(created.id)?.workspaceId).toBe(targetWorkspace.id);
  });

  test("moveAgentSessionToWorkspace 当目标目录已存在时应以源目录覆盖", () => {
    const sourceWorkspace = createAgentWorkspace("源工作区");
    const targetWorkspace = createAgentWorkspace("目标工作区");
    const created = createAgentSession("覆盖迁移会话", undefined, sourceWorkspace.id);

    const sourceSessionDir = join(getAgentWorkspacePath(sourceWorkspace.slug), created.id);
    const targetSessionDir = join(getAgentWorkspacePath(targetWorkspace.slug), created.id);
    writeFileSync(join(sourceSessionDir, "source.txt"), "source", "utf-8");
    mkdirSync(targetSessionDir, { recursive: true });
    writeFileSync(join(targetSessionDir, "target.txt"), "target", "utf-8");

    const moved = moveAgentSessionToWorkspace(created.id, targetWorkspace.id);

    expect(moved.workspaceId).toBe(targetWorkspace.id);
    expect(existsSync(join(targetSessionDir, "source.txt"))).toBeTrue();
    expect(existsSync(join(targetSessionDir, "target.txt"))).toBeFalse();
    expect(existsSync(sourceSessionDir)).toBeFalse();
  });

  test("migrateChatToAgentSession 应迁移 user/assistant 文本消息", () => {
    const conversation = createConversation("聊天记录");
    appendMessage(conversation.id, {
      id: "msg-user",
      role: "user",
      content: "你好",
      createdAt: 1
    });
    appendMessage(conversation.id, {
      id: "msg-assistant",
      role: "assistant",
      content: "我在",
      createdAt: 2,
      model: "demo-model"
    });
    appendMessage(conversation.id, {
      id: "msg-system",
      role: "system",
      content: "ignore me",
      createdAt: 3
    });

    const session = createAgentSession("目标会话");
    const migrated = migrateChatToAgentSession(conversation.id, session.id);
    const messages = getAgentSessionMessages(session.id);

    expect(migrated).toBe(2);
    expect(messages.length).toBe(2);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toBe("你好");
    expect(messages[1]?.role).toBe("assistant");
    expect(messages[1]?.content).toBe("我在");
    expect(messages[1]?.model).toBe("demo-model");
  });
});
