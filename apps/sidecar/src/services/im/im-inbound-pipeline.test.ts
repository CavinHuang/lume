import { describe, expect, test } from "bun:test";
import type { InboundImRouteMessage } from "./im-message-router";
import { createImInboundPipeline, mergeImMessageBatch } from "./im-inbound-pipeline";

function msg(overrides: Partial<InboundImRouteMessage> = {}): InboundImRouteMessage {
  return {
    provider: "feishu",
    accountId: "account-1",
    peerKind: "dm",
    peerId: "user-1",
    text: "hello",
    ...overrides
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 本地去重表注入：杜绝默认 store 把测试 key 写进真实配置目录 */
function localSeen() {
  const seen = new Set<string>();
  return {
    hasSeen: (_provider: string, _accountId: string, messageId: string) => seen.has(messageId),
    remember: (_provider: string, _accountId: string, messageId: string) => {
      seen.add(messageId);
    }
  };
}

describe("mergeImMessageBatch", () => {
  test("多条合并：文本空行拼接、contents 拼接、标量取最后一条", () => {
    const merged = mergeImMessageBatch([
      msg({ text: "第一", senderId: "a", contextToken: "t1", contents: [{ type: "text", text: "x" }] }),
      msg({ text: "第二", senderId: "b", contents: undefined }),
      msg({ text: "", senderId: "c", contextToken: "t3" })
    ]);
    expect(merged.text).toBe("第一\n\n第二");
    expect(merged.senderId).toBe("c");
    expect(merged.contextToken).toBe("t3");
    expect(merged.contents).toEqual([{ type: "text", text: "x" }]);
    expect(merged.messageId).toBeUndefined();
  });

  test("单条也剥 messageId（已见标记归管线管）", () => {
    const merged = mergeImMessageBatch([msg({ messageId: "m1" })]);
    expect(merged.messageId).toBeUndefined();
  });
});

describe("createImInboundPipeline", () => {
  test("静默窗口内连发合并为一次路由", async () => {
    const routed: InboundImRouteMessage[] = [];
    const pipeline = createImInboundPipeline({
      quietWindowMs: 15,
      routeMessage: async (m) => {
        routed.push(m);
        return { threadId: "t" };
      },
      ...localSeen()
    });
    pipeline.enqueue(msg({ text: "一", messageId: "m1" }));
    pipeline.enqueue(msg({ text: "二", messageId: "m2" }));
    pipeline.enqueue(msg({ text: "三", messageId: "m3" }));
    await waitFor(() => routed.length === 1);
    expect(routed[0]!.text).toBe("一\n\n二\n\n三");
    // 窗口过后不再有第二次路由
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(routed.length).toBe(1);
  });

  test("不同会话各自独立成批", async () => {
    const routed: InboundImRouteMessage[] = [];
    const pipeline = createImInboundPipeline({
      quietWindowMs: 15,
      routeMessage: async (m) => {
        routed.push(m);
        return { threadId: "t" };
      }
    });
    pipeline.enqueue(msg({ peerId: "u1", text: "甲" }));
    pipeline.enqueue(msg({ peerId: "u2", text: "乙", accountId: "account-2" }));
    await waitFor(() => routed.length === 2);
    expect(routed.map((m) => m.text).sort()).toEqual(["乙", "甲"]);
  });

  test("运行中新消息累积，结束后重新进入静默窗口再批量路由", async () => {
    const routed: InboundImRouteMessage[] = [];
    const gate = deferred<void>();
    let releaseOn = -1;
    const pipeline = createImInboundPipeline({
      quietWindowMs: 10,
      routeMessage: async (m) => {
        routed.push(m);
        if (routed.length === 1) {
          await gate.promise;
        }
        return { threadId: "t" };
      },
      ...localSeen()
    });
    pipeline.enqueue(msg({ text: "首条", messageId: "m1" }));
    await waitFor(() => routed.length === 1);
    // 运行期间连发三条：不得立即触发第二次运行
    pipeline.enqueue(msg({ text: "排队1", messageId: "m2" }));
    pipeline.enqueue(msg({ text: "排队2", messageId: "m3" }));
    pipeline.enqueue(msg({ text: "排队3", messageId: "m4" }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(routed.length).toBe(1);
    releaseOn = 1;
    gate.resolve();
    // 结束后重新静默窗口 → 剩余消息合并为一次
    await waitFor(() => routed.length === 2);
    expect(routed[1]!.text).toBe("排队1\n\n排队2\n\n排队3");
    expect(releaseOn).toBe(1);
  });

  test("同会话串行且受全局并发上限约束", async () => {
    let activeRuns = 0;
    let maxObserved = 0;
    const gates = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()];
    const started: string[] = [];
    const pipeline = createImInboundPipeline({
      quietWindowMs: 10,
      maxConcurrentRuns: 3,
      routeMessage: async (m) => {
        activeRuns += 1;
        maxObserved = Math.max(maxObserved, activeRuns);
        started.push(m.peerId);
        const gate = gates[started.length - 1]!;
        await gate.promise;
        activeRuns -= 1;
        return { threadId: "t" };
      }
    });
    // 四个不同会话同时入队；上限 3，第 4 个必须等槽位
    pipeline.enqueue(msg({ peerId: "u1", text: "s1" }));
    pipeline.enqueue(msg({ peerId: "u2", text: "s2" }));
    pipeline.enqueue(msg({ peerId: "u3", text: "s3" }));
    pipeline.enqueue(msg({ peerId: "u4", text: "s4" }));
    await waitFor(() => started.length === 3);
    expect(maxObserved).toBe(3);
    gates[0]!.resolve();
    await waitFor(() => started.length === 4);
    expect(started[3]!).toBe("u4");
    for (const gate of gates) gate.resolve();
  });

  test("斜杠命令绕过队列立即路由", async () => {
    const routed: InboundImRouteMessage[] = [];
    const gate = deferred<void>();
    const pipeline = createImInboundPipeline({
      quietWindowMs: 50,
      routeMessage: async (m) => {
        routed.push(m);
        if (!m.text.startsWith("/")) {
          await gate.promise;
        }
        return { threadId: "t" };
      },
      ...localSeen()
    });
    // 先制造一个运行中的阻塞态
    pipeline.enqueue(msg({ text: "普通消息", messageId: "m1" }));
    await waitFor(() => routed.length === 1);
    // 运行中到达的命令必须立即执行，不被静默窗口或运行阻塞
    pipeline.enqueue(msg({ text: "/approve req-1 allow-once", messageId: "m2" }));
    await waitFor(() => routed.length === 2);
    expect(routed[1]!.text).toBe("/approve req-1 allow-once");
    gate.resolve();
  });

  test("重复 messageId 不入队，成功后逐条标记已见", async () => {
    const routed: InboundImRouteMessage[] = [];
    const seen = new Set<string>();
    const remembered: string[] = [];
    const pipeline = createImInboundPipeline({
      quietWindowMs: 10,
      routeMessage: async (m) => {
        routed.push(m);
        return { threadId: "t" };
      },
      hasSeen: (_provider, _accountId, messageId) => seen.has(messageId),
      remember: (_provider, _accountId, messageId) => {
        remembered.push(messageId);
        seen.add(messageId);
      }
    });
    pipeline.enqueue(msg({ text: "一", messageId: "m1" }));
    pipeline.enqueue(msg({ text: "重复", messageId: "m1" }));
    pipeline.enqueue(msg({ text: "二", messageId: "m2" }));
    await waitFor(() => routed.length === 1);
    expect(routed[0]!.text).toBe("一\n\n二");
    expect(remembered.sort()).toEqual(["m1", "m2"]);
    // 已见后重投不再路由
    pipeline.enqueue(msg({ text: "重投", messageId: "m1" }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(routed.length).toBe(1);
  });

  test("路由失败不标记已见且释放槽位，后续消息可继续处理", async () => {
    const routed: InboundImRouteMessage[] = [];
    const remembered: string[] = [];
    const failFirst = deferred<void>();
    let callCount = 0;
    const pipeline = createImInboundPipeline({
      quietWindowMs: 10,
      routeMessage: async (m) => {
        callCount += 1;
        routed.push(m);
        if (callCount === 1) {
          await failFirst.promise;
          throw new Error("boom");
        }
        return { threadId: "t" };
      },
      hasSeen: () => false,
      remember: (_p, _a, id) => remembered.push(id)
    });
    pipeline.enqueue(msg({ text: "会失败", messageId: "m1" }));
    await waitFor(() => routed.length === 1);
    // 失败期间另一会话入队并成功（证明槽位未被吞掉）
    pipeline.enqueue(msg({ peerId: "u9", text: "别的会话", messageId: "m9" }));
    await waitFor(() => routed.length === 2 && routed[1]?.peerId === "u9");
    failFirst.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(remembered).toEqual(["m9"]);
  });
});
