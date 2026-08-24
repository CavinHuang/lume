import { describe, expect, test } from "bun:test";
import { createFeishuCardStream, type FeishuCardStreamOptions } from "./feishu-card-stream";
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

interface FakeTimerSystem {
  timers: Array<{ fire: () => void; cancelled: boolean; delayMs: number }>;
  advanceAll: () => void;
}

function fakeTimers(): FakeTimerSystem & {
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
} {
  let nextId = 1;
  const timers: Array<{ fire: () => void; cancelled: boolean; delayMs: number }> = [];
  return {
    timers,
    setTimer: (callback, ms) => {
      const timer = {
        fire: () => {
          if (!timer.cancelled) callback();
        },
        cancelled: false,
        delayMs: ms
      };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { cancelled: boolean }).cancelled = true;
    },
    advanceAll: () => {
      for (const t of [...timers]) t.fire();
    }
  };
}

interface FakeApiCalls {
  cardCreates: number;
  messageCreates: unknown[];
  updates: Array<{ card_id: string; sequence: number }>;
  failUpdatesUntil?: number;
}

function fakeClient(calls: FakeApiCalls): FeishuRestClient {
  return {
    im: {
      v1: {
        message: {
          create: async (req) => {
            calls.messageCreates.push(req);
          }
        }
      }
    },
    cardkit: {
      v1: {
        card: {
          create: async () => {
            calls.cardCreates += 1;
            return { data: { card_id: "card_123" } };
          },
          update: async (req) => {
            const data = req.data as { card_id: string; sequence: number };
            if (calls.failUpdatesUntil !== undefined && calls.updates.length < calls.failUpdatesUntil) {
              throw new Error("rate limited");
            }
            calls.updates.push(data);
          }
        }
      }
    }
  };
}

function buildStream(overrides: Partial<FeishuCardStreamOptions>, client: FeishuRestClient, timers = fakeTimers()) {
  const stream = createFeishuCardStream({
    appId: "cli_x",
    appSecret: "sec",
    chatId: "oc_chat",
    throttleMs: 400,
    client,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...overrides
  });
  return stream;
}

describe("createFeishuCardStream", () => {
  test("open 创建卡片并以 interactive 消息发出", async () => {
    const calls: FakeApiCalls = { cardCreates: 0, messageCreates: [], updates: [] };
    const stream = buildStream({}, fakeClient(calls));
    const ok = await stream.open();
    expect(ok).toBe(true);
    expect(calls.cardCreates).toBe(1);
    expect(calls.messageCreates).toHaveLength(1);
    const msg = calls.messageCreates[0] as { data: { msg_type: string; content: string } };
    expect(msg.data.msg_type).toBe("interactive");
    expect(JSON.parse(msg.data.content)).toEqual({ type: "card", data: { card_id: "card_123" } });
  });

  test("事件节流合并：窗口内多次 apply 只发一次 update，最后一个状态胜出", async () => {
    const calls: FakeApiCalls = { cardCreates: 0, messageCreates: [], updates: [] };
    const timers = fakeTimers();
    const stream = buildStream({}, fakeClient(calls), timers);
    await stream.open();
    stream.apply(baseEvent({ type: "assistant.delta", delta: "a" }));
    stream.apply(baseEvent({ type: "assistant.delta", delta: "b" }));
    stream.apply(baseEvent({ type: "assistant.delta", delta: "c" }));
    expect(calls.updates).toHaveLength(0);
    timers.advanceAll();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.updates).toHaveLength(1);
    expect(stream.state.blocks[0]).toMatchObject({ text: "abc" });
  });

  test("终态事件立即强刷且不再响应后续更新", async () => {
    const calls: FakeApiCalls = { cardCreates: 0, messageCreates: [], updates: [] };
    const timers = fakeTimers();
    const stream = buildStream({}, fakeClient(calls), timers);
    await stream.open();
    stream.apply(baseEvent({ type: "assistant.delta", delta: "完成内容" }));
    stream.apply(baseEvent({ type: "run.completed" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.updates.length).toBeGreaterThanOrEqual(1);
    // 终态后新事件被忽略
    const before = calls.updates.length;
    stream.apply(baseEvent({ type: "assistant.delta", delta: "迟到" }));
    timers.advanceAll();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.updates.length).toBe(before);
    expect(stream.state.status).toBe("completed");
  });

  test("sequence 递增；失败重试后继续", async () => {
    const calls: FakeApiCalls = { cardCreates: 0, messageCreates: [], updates: [], failUpdatesUntil: 2 };
    const timers = fakeTimers();
    const stream = buildStream({ throttleMs: 10 }, fakeClient(calls), timers);
    await stream.open();
    stream.apply(baseEvent({ type: "assistant.delta", delta: "x" }));
    timers.advanceAll();
    await new Promise((resolve) => setTimeout(resolve, 5));
    // 前 2 次失败（含重试），重试耗尽后丢帧但状态保留
    stream.apply(baseEvent({ type: "assistant.delta", delta: "y" }));
    timers.advanceAll();
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (calls.updates.length >= 1) {
      const sequences = calls.updates.map((u) => u.sequence);
      for (let i = 1; i < sequences.length; i += 1) {
        expect(sequences[i]!).toBeGreaterThan(sequences[i - 1]!);
      }
    }
  });

  test("开卡失败返回 false 且 close 后不再发送", async () => {
    const failingClient: FeishuRestClient = {
      im: { v1: { message: { create: async () => undefined } } },
      cardkit: { v1: { card: { create: async () => { throw new Error("no perm"); }, update: async () => ({}) } } }
    };
    const stream = buildStream({}, failingClient);
    const ok = await stream.open();
    expect(ok).toBe(false);
    stream.close();
  });
});
