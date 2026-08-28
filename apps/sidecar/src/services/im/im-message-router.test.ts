import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_IPC_CHANNELS, type AgentSendInput, type AgentToolPermissionResponseInput, type CodingRunRevertResult } from "@lume/shared";
import { createAgentWorkspace } from "../agent/agent-workspace-manager";
import { updateLumeConfigSection } from "../system/lume-config-service";
import { createImAgentStreamEmitter, routeInboundImMessage } from "./im-message-router";
import { createImAccount } from "./im-config-manager";
import { hasSeenImMessage, resetImSeenMessageCacheForTest } from "./im-seen-message-store";
import { getImThreadBindingByPeer, getImThreadBindingByThreadId, upsertImThreadBinding } from "./im-thread-binding-store";
import { upsertImMirrorEntry } from "./im-mirror-store";
import { decryptSecret } from "../infra/secret-crypto";

describe("im-message-router", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-im-router-test-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
    resetImSeenMessageCacheForTest();
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
    resetImSeenMessageCacheForTest();
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
      getThreadMeta: () => ({} as never),
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
      getThreadMeta: () => ({} as never),
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
      messageAttachments: undefined,
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
          senderId: undefined,
          contextToken: "ctx-1",
          messageId: undefined
        },
        toolPolicy: {
          deny: ["send_im_message", "AskUserQuestion"]
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

  test("routes direct Weixin /approve commands to tool permission approval instead of agent chat", async () => {
    // 默认安全姿态：白名单为空 = 不允许 IM 审批；本用例显式配置白名单
    updateLumeConfigSection({
      source: "user",
      path: "permissions.approvals",
      value: {
        im: {
          enabled: true,
          allowTextApprove: true,
          accounts: {
            "account-1": {
              approverPeerIds: ["user-1"]
            }
          }
        }
      }
    });
    upsertImThreadBinding({
      provider: "weixin",
      accountId: "account-1",
      peerKind: "dm",
      peerId: "user-1",
      threadId: "thread-1",
      contextToken: "ctx-1"
    });

    const submitted: AgentToolPermissionResponseInput[] = [];
    const sent: string[] = [];
    const notifications: Array<{ method: string; params: unknown }> = [];

    const result = await routeInboundImMessage({
      provider: "weixin",
      accountId: "account-1",
      peerKind: "dm",
      peerId: "user-1",
      text: "/approve perm-1 allow-once",
      messageId: "approve-message-1"
    }, {
      getThreadMeta: () => ({} as never),
      sendMessage() {
        throw new Error("approval command should not enter agent chat");
      },
      submitToolPermission(input) {
        submitted.push(input);
        return { ok: true };
      },
      sendBoundTextMessage(input) {
        sent.push(input.text);
        return Promise.resolve({ ok: true });
      },
      emitNotification(method, params) {
        notifications.push({ method, params });
      }
    });

    expect(result.threadId).toBe("thread-1");
    expect(submitted).toEqual([{
      threadId: "thread-1",
      requestId: "perm-1",
      decision: "allow_once"
    }]);
    expect(sent[0]).toContain("已允许一次");
    expect(hasSeenImMessage("weixin", "account-1", "approve-message-1")).toBeTrue();
    expect(notifications).toContainEqual(expect.objectContaining({
      method: AGENT_IPC_CHANNELS.RUNTIME_EVENT,
      params: expect.objectContaining({
        threadId: "thread-1",
        event: expect.objectContaining({
          type: "permission.resolved",
          requestId: "perm-1",
          decision: "allow_once"
        })
      })
    }));
  });

  test("rejects /approve before a peer has an active thread", async () => {
    const sent: string[] = [];

    const result = await routeInboundImMessage({
      provider: "weixin",
      accountId: "account-1",
      peerKind: "dm",
      peerId: "unbound-user",
      text: "/approve perm-1 allow-once",
      messageId: "unbound-approve-message"
    }, {
      createThread() {
        throw new Error("approval command should not create a thread");
      },
      sendMessage() {
        throw new Error("approval command should not enter agent chat");
      },
      sendBoundTextMessage(input) {
        sent.push(input.text);
        return Promise.resolve({ ok: true });
      }
    });

    expect(result.threadId).toBe("");
    expect(sent).toEqual(["请先发送任意消息建立会话，再处理审批。"]);
    expect(hasSeenImMessage("weixin", "account-1", "unbound-approve-message")).toBeTrue();
  });

  test("绑定线程被归档后消息换绑新建会话，不再路由进不可见线程(#588)", async () => {
    upsertImThreadBinding({
      provider: "weixin",
      accountId: "account-1",
      peerKind: "dm",
      peerId: "user-stale",
      threadId: "thread-archived",
      contextToken: "ctx-stale"
    });

    const createdThreads: string[] = [];
    const sent: AgentSendInput[] = [];
    const notices: string[] = [];
    await routeInboundImMessage({
      provider: "weixin",
      accountId: "account-1",
      peerKind: "dm",
      peerId: "user-stale",
      text: "还在吗",
      contextToken: "ctx-stale"
    }, {
      getThreadMeta: () => ({ id: "thread-archived", status: "archived" } as never),
      createThread() {
        const id = `thread-new-${createdThreads.length + 1}`;
        createdThreads.push(id);
        return { id };
      },
      sendMessage(input) {
        sent.push(input);
      },
      sendBoundTextMessage: async (input) => {
        notices.push(input.text);
        return { ok: true };
      }
    });

    expect(createdThreads).toEqual(["thread-new-1"]);
    expect(sent.map((item) => item.threadId)).toEqual(["thread-new-1"]);
    // 动线 F7 钉:换绑时向 IM 用户告知上下文已清零
    expect(notices.some((text) => text.includes("新建会话"))).toBeTrue();
    // 换绑后旧绑定不再指向归档线程
    const rebound = getImThreadBindingByPeer({
      provider: "weixin",
      accountId: "account-1",
      peerKind: "dm",
      peerId: "user-stale"
    });
    expect(rebound?.threadId).toBe("thread-new-1");
  });

  test("review F2 钉:trashed 线程与已硬删线程(meta undefined)同样触发换绑", async () => {
    for (const [peerId, meta] of [
      ["user-trashed", { id: "thread-t", status: "trashed" }],
      ["user-deleted", undefined],
    ] as const) {
      upsertImThreadBinding({
        provider: "weixin",
        accountId: "account-1",
        peerKind: "dm",
        peerId,
        threadId: "thread-gone",
        contextToken: `ctx-${peerId}`
      });
      const createdThreads: string[] = [];
      await routeInboundImMessage({
        provider: "weixin",
        accountId: "account-1",
        peerKind: "dm",
        peerId,
        text: "hello",
        contextToken: `ctx-${peerId}`
      }, {
        getThreadMeta: () => meta as never,
        createThread() {
          const id = `thread-rebind-${createdThreads.length + 1}`;
          createdThreads.push(id);
          return { id };
        },
        sendMessage: () => undefined,
      });
      expect(createdThreads).toEqual(["thread-rebind-1"]);
    }
  });

  test("rejects Weixin /approve commands when IM text approval is disabled", async () => {
    updateLumeConfigSection({
      source: "user",
      path: "permissions.approvals",
      value: {
        im: {
          enabled: true,
          allowTextApprove: false
        }
      }
    });

    upsertImThreadBinding({
      provider: "weixin",
      accountId: "account-1",
      peerKind: "dm",
      peerId: "user-1",
      threadId: "thread-1",
      contextToken: "ctx-1"
    });

    const submitted: AgentToolPermissionResponseInput[] = [];
    const sent: string[] = [];

    await routeInboundImMessage({
      provider: "weixin",
      accountId: "account-1",
      peerKind: "dm",
      peerId: "user-1",
      text: "/approve perm-1 allow-once"
    }, {
      submitToolPermission(input) {
        submitted.push(input);
        return { ok: true };
      },
      getThreadMeta: () => ({} as never),
      sendBoundTextMessage(input) {
        sent.push(input.text);
        return Promise.resolve({ ok: true });
      }
    });

    expect(submitted).toEqual([]);
    expect(sent[0]).toContain("IM 审批未启用");
  });

  test("uses workspace approval policy for workspace-bound IM accounts", async () => {
    const workspace = createAgentWorkspace("审批工作区", { slug: "approval-ws" });
    const account = createImAccount({
      provider: "weixin",
      label: "工作微信",
      token: "secret-token",
      workspaceId: workspace.id,
      enabled: true
    });
    updateLumeConfigSection({
      source: "user",
      path: "permissions.approvals",
      value: {
        im: {
          enabled: true,
          allowTextApprove: true
        }
      }
    });
    updateLumeConfigSection({
      source: "user",
      workspaceSlug: workspace.slug,
      path: "permissions.approvals",
      value: {
        im: {
          allowTextApprove: false
        }
      }
    });

    upsertImThreadBinding({
      provider: "weixin",
      accountId: account.id,
      peerKind: "dm",
      peerId: "user-1",
      threadId: "thread-1"
    });

    const submitted: AgentToolPermissionResponseInput[] = [];
    const sent: string[] = [];

    await routeInboundImMessage({
      provider: "weixin",
      accountId: account.id,
      peerKind: "dm",
      peerId: "user-1",
      text: "/approve perm-1 allow-once"
    }, {
      submitToolPermission(input) {
        submitted.push(input);
        return { ok: true };
      },
      getThreadMeta: () => ({} as never),
      sendBoundTextMessage(input) {
        sent.push(input.text);
        return Promise.resolve({ ok: true });
      }
    });

    expect(submitted).toEqual([]);
    expect(sent[0]).toContain("IM 审批未启用");
  });

  test("rejects direct Weixin /approve commands from peers outside account approver allowlist", async () => {
    updateLumeConfigSection({
      source: "user",
      path: "permissions.approvals",
      value: {
        im: {
          enabled: true,
          allowTextApprove: true,
          accounts: {
            "account-1": {
              approverPeerIds: ["trusted-user"]
            }
          }
        }
      }
    });

    upsertImThreadBinding({
      provider: "weixin",
      accountId: "account-1",
      peerKind: "dm",
      peerId: "user-1",
      threadId: "thread-1"
    });

    const submitted: AgentToolPermissionResponseInput[] = [];
    const sent: string[] = [];

    await routeInboundImMessage({
      provider: "weixin",
      accountId: "account-1",
      peerKind: "dm",
      peerId: "user-1",
      text: "/approve perm-1 allow-once"
    }, {
      submitToolPermission(input) {
        submitted.push(input);
        return { ok: true };
      },
      getThreadMeta: () => ({} as never),
      sendBoundTextMessage(input) {
        sent.push(input.text);
        return Promise.resolve({ ok: true });
      }
    });

    expect(submitted).toEqual([]);
    expect(sent[0]).toContain("当前会话没有权限处理审批");
  });

  test("uses account-level group approval policy when formatting permission prompts", async () => {
    updateLumeConfigSection({
      source: "user",
      path: "permissions.approvals",
      value: {
        im: {
          enabled: true,
          groupApproval: "desktop-only",
          accounts: {
            "account-1": {
              groupApproval: "disabled"
            }
          }
        }
      }
    });

    upsertImThreadBinding({
      provider: "weixin",
      accountId: "account-1",
      peerKind: "group",
      peerId: "room-1",
      threadId: "thread-1"
    });

    const sent: string[] = [];
    const emitter = createImAgentStreamEmitter("thread-1", {
      emitNotification() {
        // Not relevant to this assertion.
      },
      sendBoundTextMessage(input) {
        sent.push(input.text);
        return Promise.resolve({ ok: true });
      }
    });

    emitter.onToolPermissionRequest({
      threadId: "thread-1",
      requestId: "perm-1",
      toolUseId: "perm-1",
      toolName: "Bash",
      risk: "high",
      reason: "需要执行命令",
      input: {
        command: "git status"
      }
    });
    await Promise.resolve();

    expect(sent).toEqual([]);
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
    expect(sent[0]?.peerId).toBe("user-1");
    expect(sent[0]?.text).toBe("你好，我在。");
    // #598：store 出口的 binding.contextToken 为密文形态，明文仅在出站口还原
    expect(sent[0]?.contextToken).not.toBe("ctx-1");
    expect(decryptSecret(sent[0]?.contextToken ?? "")).toBe("ctx-1");
  });

  test("IM stream emitter sends tool permission approval instructions to direct bound peer", async () => {
    updateLumeConfigSection({
      source: "user",
      path: "permissions.approvals",
      value: {
        im: {
          enabled: true,
          allowTextApprove: true,
          accounts: {
            "account-1": {
              approverPeerIds: ["user-1"]
            }
          }
        }
      }
    });
    upsertImThreadBinding({
      provider: "weixin",
      accountId: "account-1",
      peerKind: "dm",
      peerId: "user-1",
      threadId: "thread-1",
      contextToken: "ctx-1"
    });

    const sent: string[] = [];
    const emitter = createImAgentStreamEmitter("thread-1", {
      emitNotification() {
        // Not relevant to this assertion.
      },
      sendBoundTextMessage(input) {
        sent.push(input.text);
        return Promise.resolve({ ok: true });
      }
    });

    emitter.onToolPermissionRequest({
      threadId: "thread-1",
      requestId: "perm-1",
      toolUseId: "perm-1",
      toolName: "Bash",
      risk: "high",
      reason: "需要执行命令",
      input: {
        command: "git status"
      }
    });
    await Promise.resolve();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("需要确认工具执行");
    expect(sent[0]).toContain("Bash");
    expect(sent[0]).toContain("/approve perm-1 allow-once");
    expect(sent[0]).toContain("/approve perm-1 deny");
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

  test("routes message with image content and passes to agent", async () => {
    const sent: AgentSendInput[] = [];
    await routeInboundImMessage({
      provider: "weixin",
      accountId: "acct-1",
      workspaceId: "workspace-1",
      peerKind: "dm",
      peerId: "user-img",
      text: "[图片]",
      contents: [{ type: "image", url: "https://cdn.example.com/img.jpg" }],
      messageId: "msg-img-1",
    }, {
      createThread: (title) => ({ id: "thread-img" }),
      sendMessage(input) {
        sent.push(input);
      },
      getThreadMeta: () => ({} as never),
      sendBoundTextMessage: async () => ({ ok: true }),
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.userMessage).toContain("图片");
    expect(sent[0]!.messageMetadata?.im).toMatchObject({
      peerId: "user-img",
      peerKind: "dm",
    });
  });

  test("routes message with voice content using text field", async () => {
    const sent: AgentSendInput[] = [];
    await routeInboundImMessage({
      provider: "weixin",
      accountId: "acct-1",
      peerKind: "dm",
      peerId: "user-voice",
      text: "[语音: 你好]",
      contents: [{ type: "voice", text: "你好", playtime: 2000 }],
      messageId: "msg-voice-1",
    }, {
      createThread: (title) => ({ id: "thread-voice" }),
      sendMessage(input) {
        sent.push(input);
      },
      getThreadMeta: () => ({} as never),
      sendBoundTextMessage: async () => ({ ok: true }),
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.userMessage).toContain("你好");
  });

  test("routes message without contents (backward compat)", async () => {
    const sent: AgentSendInput[] = [];
    await routeInboundImMessage({
      provider: "weixin",
      accountId: "acct-1",
      peerKind: "dm",
      peerId: "user-text",
      text: "plain text message",
    }, {
      createThread: (title) => ({ id: "thread-text" }),
      sendMessage(input) {
        sent.push(input);
      },
      getThreadMeta: () => ({} as never),
      sendBoundTextMessage: async () => ({ ok: true }),
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.userMessage).toBe("plain text message");
  });

  test("routes message with file content as agent attachment", async () => {
    const sent: AgentSendInput[] = [];
    await routeInboundImMessage({
      provider: "weixin",
      accountId: "acct-1",
      peerKind: "dm",
      peerId: "user-file",
      text: "[文件: report.pdf]",
      contents: [{ type: "file", fileName: "report.pdf", fileSize: 1024, downloadUrl: "https://cdn.example.com/report.pdf" }],
      messageId: "msg-file-1",
    }, {
      createThread: () => ({ id: "thread-file" }),
      sendMessage(input) { sent.push(input); },
      getThreadMeta: () => ({} as never),
      sendBoundTextMessage: async () => ({ ok: true }),
    });

    expect(sent).toHaveLength(1);
    // workspaceSlug 不可用 → saveMedia 未注入 → resolver 对 file 原样返回（不下载）
    // → buildImMediaAttachments 仍生成附件，供 agent 用文件读取工具访问
    expect(sent[0]!.messageAttachments).toEqual([
      expect.objectContaining({
        filename: "report.pdf",
        mediaType: "application/octet-stream",
        size: 1024,
      }),
    ]);
  });

  test("同一 messageId 重投只路由一次，不同 messageId 正常路由（#157）", async () => {
    const sent: AgentSendInput[] = [];
    const deps = {
      createThread(title: string) {
        return { id: "thread-dedup" };
      },
      sendMessage(input: AgentSendInput) {
        sent.push(input);
      },
    };

    const first = await routeInboundImMessage({
      provider: "dingtalk",
      accountId: "account-dedup",
      peerKind: "dm",
      peerId: "user-dedup",
      text: "original",
      messageId: "msg-1"
    }, deps);
    expect(first).toEqual({ threadId: "thread-dedup" });

    // 服务端重投同一消息：不再触发 sendMessage，返回已绑定 threadId
    const duplicate = await routeInboundImMessage({
      provider: "dingtalk",
      accountId: "account-dedup",
      peerKind: "dm",
      peerId: "user-dedup",
      text: "original",
      messageId: "msg-1"
    }, deps);
    expect(duplicate).toEqual({ threadId: "thread-dedup" });

    const second = await routeInboundImMessage({
      provider: "dingtalk",
      accountId: "account-dedup",
      peerKind: "dm",
      peerId: "user-dedup",
      text: "next",
      messageId: "msg-2"
    }, deps);
    expect(second).toEqual({ threadId: "thread-dedup" });

    expect(sent.map((item) => item.userMessage)).toEqual(["original", "next"]);
  });

  test("/revert 权限模型与 IM 审批对齐：白名单外拒绝、白名单内执行(#714)", async () => {
    upsertImThreadBinding({
      provider: "weixin",
      accountId: "account-revert",
      peerKind: "dm",
      peerId: "user-revert",
      threadId: "thread-revert",
      contextToken: "ctx-r1"
    });
    const sent: string[] = [];
    let revertCalls = 0;
    const baseDeps = {
      getThreadMeta: () => ({ id: "thread-revert" }) as never,
      sendBoundTextMessage(input: { text: string }): Promise<{ ok: true }> {
        sent.push(input.text);
        return Promise.resolve({ ok: true });
      },
      revertRun: async (): Promise<CodingRunRevertResult> => {
        revertCalls += 1;
        return {
          status: "restored",
          filesChanged: ["a.ts"],
          conflicts: [],
          committedPaths: [],
          failedFiles: [],
          nonRewindableFiles: []
        };
      }
    };

    // 默认安全姿态：approverPeerIds 为空 → 拒绝且不执行
    await routeInboundImMessage({
      provider: "weixin",
      accountId: "account-revert",
      peerKind: "dm",
      peerId: "user-revert",
      text: "/revert run-1"
    }, baseDeps);
    expect(sent.at(-1)).toContain("没有权限");
    expect(revertCalls).toBe(0);

    // 白名单命中 → 执行并回复桶计数摘要
    updateLumeConfigSection({
      source: "user",
      path: "permissions.approvals",
      value: {
        im: {
          enabled: true,
          allowTextApprove: true,
          accounts: {
            "account-revert": { approverPeerIds: ["user-revert"] }
          }
        }
      }
    });
    await routeInboundImMessage({
      provider: "weixin",
      accountId: "account-revert",
      peerKind: "dm",
      peerId: "user-revert",
      text: "/revert run-1"
    }, baseDeps);
    expect(revertCalls).toBe(1);
    expect(sent.at(-1)).toContain("/revert run-1");
    expect(sent.at(-1)).toContain("已还原 1 个文件");

    // 缺 runId 参数 → 用法提示，不执行
    await routeInboundImMessage({
      provider: "weixin",
      accountId: "account-revert",
      peerKind: "dm",
      peerId: "user-revert",
      text: "/revert"
    }, baseDeps);
    expect(sent.at(-1)).toContain("用法");
    expect(revertCalls).toBe(1);
  });
});

describe("im-message-router #544 镜像群反向续聊", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-im-router-mirror-test-"));
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

  const mirrorThreadId = "thr_desktop_origin";

  function seedMirrorEntry(): void {
    upsertImMirrorEntry({
      threadId: mirrorThreadId,
      accountId: "acc-mirror",
      chatId: "oc_mirror",
      carrier: "card"
    });
  }

  function mirrorMessage(text: string, messageId?: string) {
    return {
      provider: "feishu" as const,
      accountId: "acc-mirror",
      accountLabel: "镜像承担",
      peerKind: "group" as const,
      peerId: "oc_mirror",
      peerName: "镜像群",
      text,
      ...(messageId ? { messageId } : {})
    };
  }

  function makeDeps() {
    const sent: AgentSendInput[] = [];
    const metaUpdates: unknown[] = [];
    const mirrorTexts: string[] = [];
    const stoppedThreads: string[] = [];
    let createdThreads = 0;
    return {
      sent,
      metaUpdates,
      mirrorTexts,
      stoppedThreads,
      deps: {
        getThreadMeta: () => undefined,
        createThread: () => {
          createdThreads += 1;
          return { id: `thr_new_${createdThreads}` };
        },
        sendMessage: async (input: AgentSendInput) => {
          sent.push(input);
        },
        updateThreadMeta: (threadId: string, patch: unknown) => {
          metaUpdates.push({ threadId, patch });
        },
        stopThread: async (threadId: string) => {
          stoppedThreads.push(threadId);
          return true;
        },
        sendMirrorText: async (_entry: unknown, _message: unknown, text: string) => {
          mirrorTexts.push(text);
        }
      }
    };
  }

  test("镜像群文本路由回原桌面线程，且零绑定写入、零 source 污染", async () => {
    seedMirrorEntry();
    const { deps, sent, metaUpdates } = makeDeps();

    const result = await routeInboundImMessage(mirrorMessage("继续这个任务"), deps);

    expect(result.threadId).toBe(mirrorThreadId);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.threadId).toBe(mirrorThreadId);
    // 提交 origin 保持 im.*（防递归守卫的另一半证据链）
    expect(sent[0]?.traceContext?.origin).toBe("im.feishu");
    // 自环不变量三钉：不建绑定、不写 source meta、不建新线程
    expect(getImThreadBindingByThreadId(mirrorThreadId)).toBeNull();
    expect(metaUpdates).toHaveLength(0);
  });

  test("同一 messageId 重投只提交一次（去重语义延续）", async () => {
    seedMirrorEntry();
    const { deps, sent } = makeDeps();

    await routeInboundImMessage(mirrorMessage("第一条", "mid-1"), deps);
    await routeInboundImMessage(mirrorMessage("第一条", "mid-1"), deps);

    expect(sent).toHaveLength(1);
  });

  test("/stop 停原线程并回执；其余斜杠命令回引导文案不建线程", async () => {
    seedMirrorEntry();
    const { deps, sent, stoppedThreads, mirrorTexts } = makeDeps();

    await routeInboundImMessage(mirrorMessage("/stop"), deps);
    expect(stoppedThreads).toEqual([mirrorThreadId]);
    expect(mirrorTexts.at(-1)).toContain("已停止");
    expect(sent).toHaveLength(0);

    await routeInboundImMessage(mirrorMessage("/new"), deps);
    expect(mirrorTexts.at(-1)).toContain("镜像群仅支持");
    expect(sent).toHaveLength(0);
  });
});
