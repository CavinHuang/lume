import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFeishuCardStream,
  type FeishuCardStreamOptions,
  abortActiveFeishuRunCards,
  recoverInterruptedFeishuRunCards
} from "./feishu-card-stream";
import { createImAccount } from "../im-config-manager";
import { initialImRunCardState } from "./feishu-card-state";
import { listActiveFeishuCards, registerActiveFeishuCard } from "./feishu-card-recovery-store";
import type { FeishuRestClient } from "./feishu-api";
import type { LumeRuntimeEvent } from "@lume/shared";

function baseEvent(partial: Partial<LumeRuntimeEvent> & { type: LumeRuntimeEvent["type"] }): LumeRuntimeEvent {
  return {
    id: "e1",
    threadId: "t",
    runId: "r",
    createdAt: new Date().toISOString(),
    ...partial
  } as LumeRuntimeEvent;
}

/** 虚拟时钟：支持按毫秒推进并按到期顺序触发定时器（覆盖节流周期行为） */
function fakeClock() {
  let nowMs = 0;
  const timers: Array<{ fireAt: number; fired: boolean; fire: () => void; cancelled: boolean }> = [];
  return {
    nowMs: () => nowMs,
    setTimer: (callback: () => void, ms: number) => {
      const timer = {
        fireAt: nowMs + ms,
        fired: false,
        fire: () => {
          if (!timer.cancelled && !timer.fired) {
            timer.fired = true;
            callback();
          }
        },
        cancelled: false
      };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle: unknown) => {
      (handle as { cancelled: boolean }).cancelled = true;
    },
    /** 推进虚拟时间；到期的定时器按序触发（含期间新排的），一次性触发不重入 */
    advance(ms: number) {
      const target = nowMs + ms;
      for (;;) {
        const due = timers
          .filter((t) => !t.cancelled && !t.fired && t.fireAt <= target)
          .sort((a, b) => a.fireAt - b.fireAt)[0];
        if (!due) break;
        nowMs = Math.max(nowMs, due.fireAt);
        due.fire();
      }
      nowMs = target;
    }
  };
}

interface FakeApiCalls {
  cardCreates: Array<{ payloadType: string; hasFullJson: boolean }>;
  messageCreates: unknown[];
  updates: Array<{ cardId: string; sequence: number; fullJson: boolean; cardJson: string }>;
  /** 前 N 次 update 失败（模拟限流），create 不受影响 */
  failUpdateAttempts?: number;
}

function fakeClient(calls: FakeApiCalls): FeishuRestClient {
  return {
    im: {
      v1: {
        message: {
          create: async (req) => {
            calls.messageCreates.push(req);
          },
          get: async () => ({ code: 0 })
        },
        chat: {
          get: async () => ({ code: 0 }),
          create: async () => ({ code: 0, data: { chat_id: "oc_group" } }),
          update: async () => ({ code: 0 })
        },
        chatMembers: {
          create: async () => ({ code: 0 }),
          delete: async () => ({ code: 0 })
        }
      }
    },
    bot: {
      v3: {
        botInfo: {
          get: async () => ({ code: 0 })
        }
      }
    },
    cardkit: {
      v1: {
        card: {
          create: async (req) => {
            const data = req.data as { type: string; data: string };
            calls.cardCreates.push({ payloadType: data.type, hasFullJson: data.data.includes('"schema"') });
            return { code: 0, data: { card_id: "card_123" } };
          },
          update: async (req) => {
            if ((calls.failUpdateAttempts ?? 0) > 0) {
              calls.failUpdateAttempts = (calls.failUpdateAttempts ?? 0) - 1;
              throw new Error("rate limited");
            }
            calls.updates.push({
              cardId: req.path.card_id,
              sequence: req.data.sequence,
              fullJson: req.data.card.type === "card_json" && req.data.card.data.includes('"schema"'),
              cardJson: req.data.card.data
            });
            return { code: 0 };
          }
        }
      }
    }
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createFeishuCardStream", () => {
  test("open 按契约创建卡片实体并以 interactive 消息发出", async () => {
    const calls: FakeApiCalls = { cardCreates: [], messageCreates: [], updates: [] };
    const stream = createFeishuCardStream({
      appId: "cli_x",
      appSecret: "sec",
      chatId: "oc_chat",
      client: fakeClient(calls)
    });
    expect(await stream.open()).toBe(true);
    expect(calls.cardCreates).toHaveLength(1);
    expect(calls.cardCreates[0]).toEqual({ payloadType: "card_doc", hasFullJson: true });
    const msgReq = calls.messageCreates[0] as { data: { msg_type: string; content: string } };
    expect(msgReq.data.msg_type).toBe("interactive");
    expect(JSON.parse(msgReq.data.content)).toEqual({ type: "card", data: { card_id: "card_123" } });
  });

  test("节流（非防抖）：持续事件流按固定周期刷出而非无限顺推", async () => {
    const calls: FakeApiCalls = { cardCreates: [], messageCreates: [], updates: [] };
    const clock = fakeClock();
    const stream = createFeishuCardStream({
      appId: "cli_x",
      appSecret: "sec",
      chatId: "oc_chat",
      throttleMs: 400,
      client: fakeClient(calls),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    });
    await stream.open();
    // 模拟连续 token 流：每 100ms 一个 delta，共 1 秒 → 至少应产生 2 次推送
    for (let i = 0; i < 10; i += 1) {
      stream.apply(baseEvent({ type: "assistant.delta", delta: `t${i}`, messageId: "m1" }));
      clock.advance(100);
      await settle();
    }
    expect(calls.updates.length).toBeGreaterThanOrEqual(2);
    // 最后状态胜出：最终内容完整
    expect(stream.state.blocks[0]).toMatchObject({ text: "t0t1t2t3t4t5t6t7t8t9" });
  });

  test("update 走全量契约：path.card_id + card_json + 完整 JSON（终态变色生效）", async () => {
    const calls: FakeApiCalls = { cardCreates: [], messageCreates: [], updates: [] };
    const clock = fakeClock();
    const stream = createFeishuCardStream({
      appId: "cli_x",
      appSecret: "sec",
      chatId: "oc_chat",
      throttleMs: 50,
      client: fakeClient(calls),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    });
    await stream.open();
    stream.apply(baseEvent({ type: "assistant.delta", delta: "内容", messageId: "m1" }));
    stream.apply(baseEvent({ type: "run.completed" }));
    clock.advance(500);
    await settle();
    expect(calls.updates.length).toBeGreaterThanOrEqual(1);
    const last = calls.updates[calls.updates.length - 1]!;
    expect(last.cardId).toBe("card_123");
    expect(last.fullJson).toBe(true);
    expect(stream.state.status).toBe("completed");
  });

  test("业务错误码（HTTP 200 code≠0）触发退避重试，恢复后继续推送且 sequence 单调递增", async () => {
    const calls: FakeApiCalls = { cardCreates: [], messageCreates: [], updates: [], failUpdateAttempts: 2 };
    const clock = fakeClock();
    const stream = createFeishuCardStream({
      appId: "cli_x",
      appSecret: "sec",
      chatId: "oc_chat",
      throttleMs: 20,
      client: fakeClient(calls),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    });
    await stream.open();
    stream.apply(baseEvent({ type: "assistant.delta", delta: "x", messageId: "m1" }));
    // 增量推进（重试休眠在失败微任务落定后才排入）：覆盖 0.2s/0.4s 退避间隔
    for (let i = 0; i < 20; i += 1) {
      clock.advance(100);
      await settle();
    }
    expect(calls.updates).toHaveLength(1);

    stream.apply(baseEvent({ type: "assistant.delta", delta: "y", messageId: "m1" }));
    for (let i = 0; i < 10; i += 1) {
      clock.advance(100);
      await settle();
    }
    expect(calls.updates).toHaveLength(2);
    expect(calls.updates[1]!.sequence).toBeGreaterThan(calls.updates[0]!.sequence);
  });

  test("终态事件立即强刷且冻结后续更新", async () => {
    const calls: FakeApiCalls = { cardCreates: [], messageCreates: [], updates: [] };
    const clock = fakeClock();
    const stream = createFeishuCardStream({
      appId: "cli_x",
      appSecret: "sec",
      chatId: "oc_chat",
      throttleMs: 400,
      client: fakeClient(calls),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    });
    await stream.open();
    stream.apply(baseEvent({ type: "assistant.delta", delta: "完成内容", messageId: "m1" }));
    stream.apply(baseEvent({ type: "run.completed" }));
    await settle();
    expect(calls.updates.length).toBeGreaterThanOrEqual(1);
    const before = calls.updates.length;
    stream.apply(baseEvent({ type: "assistant.delta", delta: "迟到", messageId: "m1" }));
    clock.advance(2000);
    await settle();
    expect(calls.updates.length).toBe(before);
    expect(stream.state.status).toBe("completed");
  });

  test("开卡失败返回 false 且 close 后不再发送", async () => {
    const failingClient: FeishuRestClient = {
      im: { v1: { message: { create: async () => undefined, get: async () => ({ code: 0 }) }, chat: { get: async () => ({ code: 0 }), create: async () => ({ code: 0, data: { chat_id: "oc_group" } }), update: async () => ({ code: 0 }) }, chatMembers: { create: async () => ({ code: 0 }), delete: async () => ({ code: 0 }) } } }, bot: { v3: { botInfo: { get: async () => ({ code: 0 }) } } },
      cardkit: {
        v1: {
          card: {
            create: async () => {
              throw new Error("no perm");
            },
            update: async () => ({ code: 0 })
          }
        }
      }
    };
    const stream = createFeishuCardStream({
      appId: "cli_x",
      appSecret: "sec",
      chatId: "oc_chat",
      client: failingClient
    });
    expect(await stream.open()).toBe(false);
    stream.close();
  });

  test("业务码非 0 的 create 视为开卡失败", async () => {
    const rejectedClient: FeishuRestClient = {
      im: { v1: { message: { create: async () => undefined, get: async () => ({ code: 0 }) }, chat: { get: async () => ({ code: 0 }), create: async () => ({ code: 0, data: { chat_id: "oc_group" } }), update: async () => ({ code: 0 }) }, chatMembers: { create: async () => ({ code: 0 }), delete: async () => ({ code: 0 }) } } }, bot: { v3: { botInfo: { get: async () => ({ code: 0 }) } } },
      cardkit: {
        v1: {
          card: {
            create: async () => ({ code: 230001 }),
            update: async () => ({ code: 0 })
          }
        }
      }
    };
    const stream = createFeishuCardStream({
      appId: "cli_x",
      appSecret: "sec",
      chatId: "oc_chat",
      client: rejectedClient
    });
    expect(await stream.open()).toBe(false);
  });

  test("卡片实体创建成功但消息发送业务码非 0 时仍回退文本", async () => {
    const calls: FakeApiCalls = { cardCreates: [], messageCreates: [], updates: [] };
    const client = fakeClient(calls);
    client.im.v1.message.create = async () => ({ code: 230002 }) as never;
    const stream = createFeishuCardStream({
      appId: "cli_x",
      appSecret: "sec",
      chatId: "oc_chat",
      client
    });

    expect(await stream.open()).toBe(false);
  });
});

describe("abortActiveFeishuRunCards（#598 优雅关停卡片收尾）", () => {
  test("把活跃 running 卡片置 interrupted 终态并强刷，随后从登记表移除", async () => {
    const calls: FakeApiCalls = { cardCreates: [], messageCreates: [], updates: [] };
    const stream = createFeishuCardStream({
      appId: "cli_x",
      appSecret: "sec",
      chatId: "oc_chat",
      client: fakeClient(calls)
    });
    expect(await stream.open()).toBe(true);
    stream.apply({ type: "message.user.submitted", threadId: "t", messageId: "m1", text: "你好" } as never);
    await settle();

    await abortActiveFeishuRunCards("测试关停");
    await settle();

    // 中断终态落盘并强刷过（updates 至少多一条）
    expect(stream.state.status).toBe("interrupted");
    expect(stream.state.endedAtMs).toBeDefined();
    expect(calls.updates.length).toBeGreaterThan(0);
    // 收尾后登记表清空：再 abort 是空操作（不再产生新 update）
    const countAfterAbort = calls.updates.length;
    await abortActiveFeishuRunCards();
    await settle();
    expect(calls.updates.length).toBe(countAfterAbort);
  });
});

describe("recoverInterruptedFeishuRunCards（#598 强杀后启动补偿）", () => {
  test("下次启动用账号凭据补写中断终态并清除恢复条目", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    const configDir = mkdtempSync(join(tmpdir(), "lume-feishu-card-recover-run-"));
    process.env.LUME_CONFIG_DIR = configDir;
    try {
      const account = createImAccount({
        provider: "feishu",
        accountKey: "cli_x",
        label: "飞书",
        token: "sec",
        enabled: true
      });
      registerActiveFeishuCard({
        cardId: "stale-card",
        accountId: account.id,
        chatId: "oc_chat",
        state: {
          ...initialImRunCardState(1000),
          blocks: [{ kind: "text", id: "text:m1", text: "已生成的部分内容" }]
        }
      });
      const calls: FakeApiCalls = { cardCreates: [], messageCreates: [], updates: [] };

      await expect(recoverInterruptedFeishuRunCards({ getClient: () => fakeClient(calls) })).resolves.toEqual({
        recovered: 1,
        failed: 0,
        discarded: 0
      });

      expect(listActiveFeishuCards()).toEqual([]);
      const recovered = JSON.parse(calls.updates[0]!.cardJson) as { header: { title: { content: string } }; body: unknown };
      expect(recovered.header.title.content).toBe("已中断");
      expect(JSON.stringify(recovered.body)).toContain("已生成的部分内容");
      expect(JSON.stringify(recovered.body)).toContain("上次进程异常退出");
    } finally {
      if (previousConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
      else process.env.LUME_CONFIG_DIR = previousConfigDir;
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
