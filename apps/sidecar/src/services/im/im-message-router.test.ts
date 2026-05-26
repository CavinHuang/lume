import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_IPC_CHANNELS, type AgentSendInput } from "@lume/shared";
import { createImAgentStreamEmitter, routeInboundImMessage } from "./im-message-router";
import { upsertImThreadBinding } from "./im-thread-binding-store";

describe("im-message-router", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-im-router-test-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
    if (tempConfigDir) {
      rmSync(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = "";
    }
  });

  test("creates and reuses one thread per account and peer", async () => {
    const createdThreads: string[] = [];
    const sent: AgentSendInput[] = [];
    const updatedThreads: unknown[] = [];

    await routeInboundImMessage({
      provider: "weixin",
      accountId: "account-1",
      accountLabel: "工作微信",
      workspaceId: "workspace-1",
      peerKind: "dm",
      peerId: "user-1",
      peerName: "Alice",
      text: "hello",
      contextToken: "ctx-1"
    }, {
      createThread(title, workspaceId) {
        const id = `thread-${createdThreads.length + 1}`;
        createdThreads.push(`${title}:${workspaceId}`);
        return { id };
      },
      sendMessage(input) {
        sent.push(input);
      },
      updateThreadMeta(threadId, patch) {
        updatedThreads.push({ threadId, patch });
      }
    });

    await routeInboundImMessage({
      provider: "weixin",
      accountId: "account-1",
      accountLabel: "工作微信",
      peerKind: "dm",
      peerId: "user-1",
      peerName: "Alice",
      text: "again",
      contextToken: "ctx-2"
    }, {
      createThread(title) {
        const id = `thread-${createdThreads.length + 1}`;
        createdThreads.push(title);
        return { id };
      },
      sendMessage(input) {
        sent.push(input);
      }
    });

    expect(createdThreads).toEqual(["微信: Alice:workspace-1"]);
    expect(sent.map((item) => item.threadId)).toEqual(["thread-1", "thread-1"]);
    expect(updatedThreads).toEqual([{
      threadId: "thread-1",
      patch: {
        source: {
          type: "im",
          provider: "weixin",
          accountId: "account-1",
          accountLabel: "工作微信",
          peerKind: "dm",
          peerId: "user-1",
          peerName: "Alice"
        }
      }
    }]);
    expect(sent[0]).toMatchObject({
      userMessage: "hello",
      workspaceId: "workspace-1",
      chatType: "direct",
      threadType: "main",
      messageMetadata: {
        im: {
          provider: "weixin",
          accountId: "account-1",
          accountLabel: "工作微信",
          workspaceId: "workspace-1",
          peerKind: "dm",
          peerId: "user-1",
          peerName: "Alice",
          contextToken: "ctx-1"
        },
        toolPolicy: {
          deny: ["send_im_message"]
        }
      }
    });
  });

  test("same peer under another account creates a distinct thread", async () => {
    const sent: AgentSendInput[] = [];
    let count = 0;
    const deps = {
      createThread() {
        count += 1;
        return { id: `thread-${count}` };
      },
      sendMessage(input: AgentSendInput) {
        sent.push(input);
      }
    };

    await routeInboundImMessage({
      provider: "weixin",
      accountId: "account-1",
      peerKind: "group",
      peerId: "room-1",
      senderId: "user-1",
      text: "hello group"
    }, deps);
    await routeInboundImMessage({
      provider: "weixin",
      accountId: "account-2",
      peerKind: "group",
      peerId: "room-1",
      text: "hello again"
    }, deps);

    expect(sent.map((item) => item.threadId)).toEqual(["thread-1", "thread-2"]);
    expect(sent[0]).toMatchObject({
      userMessage: "user-1: hello group",
      chatType: "group",
      threadType: "group",
      messageMetadata: {
        im: {
          senderId: "user-1"
        }
      }
    });
  });

  test("IM stream emitter notifies UI and auto-delivers assistant text to bound peer", async () => {
    upsertImThreadBinding({
      provider: "weixin",
      accountId: "account-1",
      peerKind: "dm",
      peerId: "user-1",
      threadId: "thread-1",
      contextToken: "ctx-1"
    });

    const notifications: Array<{ method: string; params: unknown }> = [];
    const sent: Array<{ peerId: string; text: string; contextToken?: string }> = [];
    const emitter = createImAgentStreamEmitter("thread-1", {
      emitNotification(method, params) {
        notifications.push({ method, params });
      },
      sendBoundTextMessage(input) {
        sent.push({
          peerId: input.binding.peerId,
          text: input.text,
          contextToken: input.binding.contextToken
        });
        return Promise.resolve({ ok: true });
      }
    });

    emitter.onMessageAppended?.({
      threadId: "thread-1",
      message: {
        id: "user-message-1",
        role: "user",
        content: "你好",
        createdAt: 1
      }
    });
    emitter.onMessageAppended?.({
      threadId: "thread-1",
      message: {
        id: "assistant-message-1",
        role: "assistant",
        content: "你好，我在。",
        createdAt: 2
      }
    });
    await Promise.resolve();

    expect(notifications.map((item) => item.method)).toEqual([
      AGENT_IPC_CHANNELS.MESSAGE_APPENDED,
      AGENT_IPC_CHANNELS.RUNTIME_EVENT,
      AGENT_IPC_CHANNELS.MESSAGE_APPENDED,
      AGENT_IPC_CHANNELS.RUNTIME_EVENT,
      AGENT_IPC_CHANNELS.RUNTIME_EVENT
    ]);
    expect(notifications[1]?.params).toMatchObject({
      threadId: "thread-1",
      event: {
        type: "message.user.submitted",
        text: "你好",
        messageId: "user-message-1"
      }
    });
    expect(notifications[3]?.params).toMatchObject({
      threadId: "thread-1",
      event: {
        type: "im.delivery",
        messageId: "assistant-message-1",
        status: "pending",
        provider: "weixin",
        peerId: "user-1"
      }
    });
    expect(notifications[4]?.params).toMatchObject({
      threadId: "thread-1",
      event: {
        type: "im.delivery",
        messageId: "assistant-message-1",
        status: "sent",
        provider: "weixin",
        peerId: "user-1"
      }
    });
    expect(sent).toEqual([{
      peerId: "user-1",
      text: "你好，我在。",
      contextToken: "ctx-1"
    }]);
  });

  test("IM stream emitter emits failed delivery status when bound send fails", async () => {
    upsertImThreadBinding({
      provider: "weixin",
      accountId: "account-1",
      peerKind: "dm",
      peerId: "user-1",
      threadId: "thread-1"
    });

    const notifications: Array<{ method: string; params: unknown }> = [];
    const previousConsoleError = console.error;
    console.error = () => undefined;
    const emitter = createImAgentStreamEmitter("thread-1", {
      emitNotification(method, params) {
        notifications.push({ method, params });
      },
      sendBoundTextMessage() {
        return Promise.reject(new Error("network down"));
      }
    });

    try {
      emitter.onMessageAppended?.({
        threadId: "thread-1",
        message: {
          id: "assistant-message-1",
          role: "assistant",
          content: "你好，我在。",
          createdAt: 2
        }
      });
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      console.error = previousConsoleError;
    }

    const deliveryEvents = notifications
      .filter((item) => item.method === AGENT_IPC_CHANNELS.RUNTIME_EVENT)
      .map((item) => (item.params as { event?: unknown }).event);
    expect(deliveryEvents).toEqual([
      expect.objectContaining({
        type: "im.delivery",
        status: "pending",
        peerId: "user-1"
      }),
      expect.objectContaining({
        type: "im.delivery",
        status: "failed",
        peerId: "user-1",
        error: {
          code: "im_delivery_failed",
          message: "network down"
        }
      })
    ]);
  });
});
