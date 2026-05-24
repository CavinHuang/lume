import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSendInput } from "@lume/shared";
import { routeInboundImMessage } from "./im-message-router";

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
          allow: ["send_im_message"]
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
});
