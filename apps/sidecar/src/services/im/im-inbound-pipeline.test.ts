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

  test("群聊多发送者：逐段带发送者前缀且 senderId 置空，避免错误归因", () => {
    const merged = mergeImMessageBatch([
      msg({ peerKind: "group", text: "帮我看看", senderId: "user-a" }),
      msg({ peerKind: "group", text: "还有这个文件", senderId: "user-b" })
    ]);
    expect(merged.text).toBe("user-a: 帮我看看\n\nuser-b: 还有这个文件");
    expect(merged.senderId).toBeUndefined();
  });

  test("群聊单发送者保持原语义（senderId 保留）", () => {
    const merged = mergeImMessageBatch([
      msg({ peerKind: "group", text: "第一条", senderId: "user-a" }),
      msg({ peerKind: "group", text: "第二条", senderId: "user-a" })
    ]);
    expect(merged.text).toBe("第一条\n\n第二条");
    expect(merged.senderId).toBe("user-a");
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

  test("并发重投同一斜杠命令只路由一次", async () => {
    const routed: InboundImRouteMessage[] = [];
    const gate = deferred<void>();
    const pipeline = createImInboundPipeline({
      routeMessage: async (message) => {
        routed.push(message);
        await gate.promise;
        return { threadId: "thread-1" };
      },
      ...localSeen()
    });
    const command = msg({ text: "/approve req-1 allow-once", messageId: "command-1" });

    await Promise.all([pipeline.enqueue(command), pipeline.enqueue({ ...command })]);
    expect(routed).toHaveLength(1);
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
    pipeline.enqueue(msg({ text: "会失败", messageId: "m1" })).catch(() => {});
    await waitFor(() => routed.length === 1);
    // 失败期间另一会话入队并成功（证明槽位未被吞掉）
    pipeline.enqueue(msg({ peerId: "u9", text: "别的会话", messageId: "m9" }));
    await waitFor(() => routed.length === 2 && routed[1]?.peerId === "u9");
    failFirst.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(remembered).toEqual(["m9"]);
  });

  test("enqueue 的 Promise 反映路由结果：成功 resolve、失败 reject（微信 cursor 语义）", async () => {
    const gate = deferred<void>();
    let shouldFail = true;
    const routed: string[] = [];
    const pipeline = createImInboundPipeline({
      quietWindowMs: 10,
      routeMessage: async (m) => {
        routed.push(m.text);
        await gate.promise;
        if (shouldFail) throw new Error("down");
        return { threadId: "t" };
      },
      ...localSeen()
    });
    const first = pipeline.enqueue(msg({ text: "首条", messageId: "m1" }));
    await waitFor(() => routed.length === 1);
    gate.resolve();
    await expect(first).rejects.toThrow("down");
    // 重投后成功：Promise resolve
    shouldFail = false;
    const second = pipeline.enqueue(msg({ text: "重投", messageId: "m1" }));
    await waitFor(() => routed.length === 2);
    gate.resolve();
    await expect(second).resolves.toBeUndefined();
  });

  test("运行超时看门狗：释放槽位且按失败处理，后续消息可继续", async () => {
    const routed: InboundImRouteMessage[] = [];
    const seen = localSeen();
    const pipeline = createImInboundPipeline({
      quietWindowMs: 10,
      maxConcurrentRuns: 1,
      runTimeoutMs: 40,
      routeMessage: async (m) => {
        if (m.peerId === "u-slow") {
          // 挂死：永不返回
          await new Promise(() => undefined);
        }
        routed.push(m);
        return { threadId: "t" };
      },
      ...seen
    });
    const slow = pipeline.enqueue(msg({ peerId: "u-slow", text: "挂死", messageId: "s1" }));
    slow.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 80));
    // 超时释放唯一槽位后，其他会话可以继续路由
    pipeline.enqueue(msg({ peerId: "u-ok", text: "正常", messageId: "ok1" }));
    await waitFor(() => routed.length === 1 && routed[0]?.peerId === "u-ok");
  });

  test("运行失败结束后，阻塞期累积的消息在重新静默窗口后重试", async () => {
    const routed: InboundImRouteMessage[] = [];
    const failGate = deferred<void>();
    let callCount = 0;
    const seen = localSeen();
    const pipeline = createImInboundPipeline({
      quietWindowMs: 10,
      routeMessage: async (m) => {
        callCount += 1;
        routed.push(m);
        if (callCount === 1) {
          await failGate.promise;
          throw new Error("boom");
        }
        return { threadId: "t" };
      },
      ...seen
    });
    pipeline.enqueue(msg({ text: "首批", messageId: "c1" })).catch(() => {});
    await waitFor(() => routed.length === 1);
    // 运行期间入队：被阻塞累积
    pipeline.enqueue(msg({ text: "排队消息", messageId: "c2" }));
    failGate.resolve();
    // 失败后 buffer 非空 → 重新静默窗口 → 第二次路由成功
    await waitFor(() => routed.length === 2);
    expect(routed[1]!.text).toBe("排队消息");
  });
});
