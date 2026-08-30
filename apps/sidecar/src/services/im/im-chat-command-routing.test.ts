import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Channel, ImThreadBinding } from "@lume/shared";
import { routeInboundImMessage, type InboundImRouteMessage } from "./im-message-router";
import { createImAccount } from "./im-config-manager";
import { getImThreadBindingByPeer, upsertImThreadBinding } from "./im-thread-binding-store";
import { resetImSeenMessageCacheForTest } from "./im-seen-message-store";

let testAccountId = "";

function msg(overrides: Partial<InboundImRouteMessage> = {}): InboundImRouteMessage {
  return {
    provider: "feishu",
    accountId: testAccountId,
    peerKind: "dm",
    peerId: "oc_user",
    text: "hello",
    ...overrides
  };
}

const fakeChannels: Channel[] = [
  {
    id: "ch-a",
    name: "OpenAI",
    provider: "openai",
    baseUrl: "",
    apiKey: "",
    enabled: true,
    models: [
      { id: "gpt-5-mini", name: "GPT-5 mini", enabled: true },
      { id: "gpt-5", name: "GPT-5", enabled: true }
    ]
  }
] as unknown as Channel[];

describe("im 会话命令路由", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";
  let accountId = "";

  beforeEach(async () => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-im-cmd-test-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
    resetImSeenMessageCacheForTest();
    const account = await createImAccount({
      provider: "feishu",
      label: "飞书测试",
      accountKey: "cli_x",
      token: "sec",
      workspaceId: undefined,
      enabled: true
    });
    accountId = account.id;
    testAccountId = account.id;
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

  function bind(threadId: string): ImThreadBinding {
    return upsertImThreadBinding({
      provider: "feishu",
      accountId,
      peerKind: "dm",
      peerId: "oc_user",
      threadId
    });
  }

  test("/help 无绑定也回复帮助文本，不创建线程", async () => {
    const sent: string[] = [];
    let createdThreads = 0;
    await routeInboundImMessage(msg({ text: "/help" }), {
      getThreadMeta: () => ({} as never),
      sendBoundTextMessage: async (input) => {
        sent.push(input.text);
        return { ok: true };
      },
      createThread: () => {
        createdThreads += 1;
        return { id: "should-not-create" };
      }
    });
    expect(createdThreads).toBe(0);
    expect(sent[0]).toContain("/model");
  });

  test("/stop 调用停止并回复结果", async () => {
    bind("thread-x");
    const sent: string[] = [];
    const stoppedIds: string[] = [];
    await routeInboundImMessage(msg({ text: "/stop" }), {
      getThreadMeta: () => ({} as never),
      sendBoundTextMessage: async (input) => {
        sent.push(input.text);
        return { ok: true };
      },
      stopThread: async (threadId) => {
        stoppedIds.push(threadId);
        return true;
      }
    });
    expect(stoppedIds).toEqual(["thread-x"]);
    expect(sent[0]).toContain("已停止");
  });

  test("/model <n> <m> 写入线程级模型覆盖", async () => {
    bind("thread-y");
    const sent: string[] = [];
    const updates: Array<{ threadId: string; patch: Record<string, unknown> }> = [];
    await routeInboundImMessage(msg({ text: "/model 1 2" }), {
      getThreadMeta: () => ({} as never),
      sendBoundTextMessage: async (input) => {
        sent.push(input.text);
        return { ok: true };
      },
      listChannels: () => fakeChannels,
      updateThreadModelSelection: (threadId, patch) => {
        updates.push({ threadId, patch });
      }
    });
    expect(sent.join("\n")).toContain("已切换模型");
    expect(updates).toEqual([
      {
        threadId: "thread-y",
        patch: {
          channelId: "ch-a",
          modelRef: "openai/gpt-5",
          modelId: "gpt-5",
          modelSelectionSource: "thread-override"
        }
      }
    ]);
  });

  test("/new 为绑定创建全新线程", async () => {
    bind("thread-old");
    const sent: string[] = [];
    let createdTitle = "";
    const stoppedIds: string[] = [];
    await routeInboundImMessage(msg({ text: "/new", peerName: "张三" }), {
      getThreadMeta: () => ({} as never),
      sendBoundTextMessage: async (input) => {
        sent.push(input.text);
        return { ok: true };
      },
      createThread: (title) => {
        createdTitle = title;
        return { id: "thread-new" };
      },
      stopThread: async (threadId) => {
        stoppedIds.push(threadId);
        return false;
      },
      updateThreadMeta: () => undefined
    });
    expect(createdTitle).toContain("张三");
    expect(getImThreadBindingByPeer(msg())?.threadId).toBe("thread-new");
    expect(sent[0]).toContain("新对话");
    // 换绑前停止旧线程进行中运行，防孤儿运行与悬空审批
    expect(stoppedIds).toEqual(["thread-old"]);
  });

  test("#598 /list 列出同 peer 历史线程（隔离群聊/私聊并排除当前绑定）", async () => {
    bind("thread-cur");
    const sent: string[] = [];
    await routeInboundImMessage(msg({ text: "/list" }), {
      getThreadMeta: () => ({} as never),
      sendBoundTextMessage: async (input) => {
        sent.push(input.text);
        return { ok: true };
      },
      listThreads: () => [
        { id: "thread-cur", title: "当前", createdAt: 1, updatedAt: 100, source: { type: "im", provider: "feishu", accountId, peerKind: "dm", peerId: "oc_user" } },
        { id: "thread-h1", title: "旧对话一", createdAt: 1, updatedAt: 300, source: { type: "im", provider: "feishu", accountId, peerKind: "dm", peerId: "oc_user" } },
        { id: "thread-h2", title: "旧对话二", createdAt: 1, updatedAt: 200, source: { type: "im", provider: "feishu", accountId, peerKind: "dm", peerId: "oc_user" } },
        { id: "thread-group", title: "同 ID 群聊", createdAt: 1, updatedAt: 500, source: { type: "im", provider: "feishu", accountId, peerKind: "group", peerId: "oc_user" } },
        { id: "thread-x", title: "别的 peer", createdAt: 1, updatedAt: 400, source: { type: "im", provider: "feishu", accountId, peerKind: "dm", peerId: "other" } }
      ]
    });
    expect(sent[0]).toContain("旧对话一");
    expect(sent[0]).toContain("旧对话二");
    expect(sent[0]).not.toContain("当前");
    expect(sent[0]).not.toContain("同 ID 群聊");
    expect(sent[0]).not.toContain("别的 peer");
    // 按最近更新排序
    expect((sent[0] ?? "").indexOf("旧对话一")).toBeLessThan((sent[0] ?? "").indexOf("旧对话二"));
  });

  test("#598 /switch <n> 重绑到历史线程并停止旧线程运行", async () => {
    bind("thread-cur");
    const stoppedIds: string[] = [];
    const sent: string[] = [];
    const result = await routeInboundImMessage(msg({ text: "/switch 2" }), {
      getThreadMeta: () => ({} as never),
      sendBoundTextMessage: async (input) => {
        sent.push(input.text);
        return { ok: true };
      },
      stopThread: async (id) => {
        stoppedIds.push(id);
        return true;
      },
      listThreads: () => [
        { id: "thread-h1", title: "旧一", createdAt: 1, updatedAt: 300, source: { type: "im", provider: "feishu", accountId, peerKind: "dm", peerId: "oc_user" } },
        { id: "thread-h2", title: "旧二", createdAt: 1, updatedAt: 200, source: { type: "im", provider: "feishu", accountId, peerKind: "dm", peerId: "oc_user" } }
      ]
    });
    expect(getImThreadBindingByPeer(msg())?.threadId).toBe("thread-h2");
    expect(stoppedIds).toEqual(["thread-cur"]);
    expect(sent[0]).toContain("旧二");
    expect(result?.threadId).toBe("thread-h2");
  });

  test("#598 /switch 序号越界与缺参回复提示", async () => {
    bind("thread-cur");
    const sent: string[] = [];
    await routeInboundImMessage(msg({ text: "/switch 9" }), {
      getThreadMeta: () => ({} as never),
      sendBoundTextMessage: async (input) => {
        sent.push(input.text);
        return { ok: true };
      },
      listThreads: () => [
        { id: "thread-h1", title: "旧一", createdAt: 1, updatedAt: 300, source: { type: "im", provider: "feishu", accountId, peerKind: "dm", peerId: "oc_user" } }
      ]
    });
    expect(sent[0]).toContain("序号超出范围");
    await routeInboundImMessage(msg({ text: "/switch" }), {
      getThreadMeta: () => ({} as never),
      sendBoundTextMessage: async (input) => {
        sent.push(input.text);
        return { ok: true };
      }
    });
    expect(sent[1] ?? "").toContain("命令格式不正确");
  });

  test("命令成功后标记已见：同 messageId 重投不再执行", async () => {
    bind("thread-idem");
    const sent: string[] = [];
    const first = msg({ text: "/stop", messageId: "cmd-m1" });
    await routeInboundImMessage(first, {
      getThreadMeta: () => ({} as never),
      sendBoundTextMessage: async (input) => {
        sent.push(input.text);
        return { ok: true };
      },
      stopThread: async () => true
    });
    // 重投同一命令消息：命中持久去重，直接跳过（不重复回复）
    await routeInboundImMessage({ ...first, text: "/stop" }, {
      getThreadMeta: () => ({} as never),
      sendBoundTextMessage: async (input) => {
        sent.push(input.text);
        return { ok: true };
      }
    });
    expect(sent).toHaveLength(1);
  });

  test("普通消息不受命令白名单影响照常进入 agent 路由", async () => {
    bind("thread-z");
    const sentInputs: unknown[] = [];
    await routeInboundImMessage(msg({ text: "/etc/hosts 是什么" }), {
      getThreadMeta: () => ({} as never),
      sendBoundTextMessage: async (input) => {
        sentInputs.push(input);
        return { ok: true };
      },
      sendMessage: async (input) => {
        sentInputs.push(input);
        return undefined;
      },
      updateThreadMeta: () => undefined
    });
    // 唯一一次投递是 agent 发送，而非命令回复
    expect(sentInputs).toHaveLength(1);
    expect((sentInputs[0] as { userMessage?: string }).userMessage).toContain("/etc/hosts");
  });
});
