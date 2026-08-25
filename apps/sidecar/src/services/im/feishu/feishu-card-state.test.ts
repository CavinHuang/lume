import { describe, expect, test } from "bun:test";
import { initialImRunCardState, reduceImRunCardEvent } from "./feishu-card-state";
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

describe("reduceImRunCardEvent", () => {
  test("assistant.delta 按消息聚合追加文本块", () => {
    let state = initialImRunCardState(1000);
    state = reduceImRunCardEvent(state, baseEvent({ type: "assistant.delta", delta: "你好", messageId: "m1" }));
    state = reduceImRunCardEvent(state, baseEvent({ type: "assistant.delta", delta: "，世界", messageId: "m1" }));
    expect(state.blocks).toEqual([{ kind: "text", id: "text:m1", text: "你好，世界" }]);
  });

  test("thinking 与 text 分块且互不串扰", () => {
    let state = initialImRunCardState(1000);
    state = reduceImRunCardEvent(state, baseEvent({ type: "assistant.thinking_delta", delta: "想一想", messageId: "m1" }));
    state = reduceImRunCardEvent(state, baseEvent({ type: "assistant.delta", delta: "正文", messageId: "m1" }));
    expect(state.blocks.map((b) => b.kind)).toEqual(["thinking", "text"]);
  });

  test("有 delta 块时 assistant.final 不叠加（防重复文本）", () => {
    let state = initialImRunCardState(1000);
    state = reduceImRunCardEvent(state, baseEvent({ type: "assistant.delta", delta: "增量全文", messageId: "m1" }));
    state = reduceImRunCardEvent(state, baseEvent({
      type: "assistant.final",
      blocks: [{ type: "text", text: "增量全文" }]
    }));
    const texts = state.blocks.filter((b) => b.kind === "text");
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatchObject({ text: "增量全文" });
  });

  test("无 delta 时 assistant.final 兜底补建（非流式模型）", () => {
    let state = initialImRunCardState(1000);
    state = reduceImRunCardEvent(state, baseEvent({
      type: "assistant.final",
      blocks: [
        { type: "thinking", text: "推理" },
        { type: "text", text: "答案" }
      ]
    }));
    expect(state.blocks).toEqual([
      { kind: "thinking", id: "thinking:stream", text: "推理" },
      { kind: "text", id: "text:stream", text: "答案" }
    ]);
  });

  test("工具块生命周期 running → ok / failed", () => {
    let state = initialImRunCardState(1000);
    state = reduceImRunCardEvent(state, baseEvent({ type: "tool.started", toolCallId: "tc1", toolName: "bash" }));
    state = reduceImRunCardEvent(state, baseEvent({ type: "tool.completed", toolCallId: "tc1", resultPreview: "done" }));
    expect(state.blocks[0]).toMatchObject({ kind: "tool", toolName: "bash", status: "ok", preview: "done" });
    state = reduceImRunCardEvent(state, baseEvent({ type: "tool.started", toolCallId: "tc2", toolName: "edit" }));
    state = reduceImRunCardEvent(state, baseEvent({ type: "tool.failed", toolCallId: "tc2", error: { code: "x", message: "boom" } }));
    expect(state.blocks[1]).toMatchObject({ kind: "tool", toolName: "edit", status: "failed", error: "boom" });
  });

  test("终态转换：completed/failed/cancelled/turn_limited 且幂等", () => {
    const started = initialImRunCardState(1000);
    const done = reduceImRunCardEvent(started, baseEvent({ type: "run.completed" }), 5000);
    expect(done).toMatchObject({ status: "completed", endedAtMs: 5000 });
    // 终态后忽略后续事件
    expect(reduceImRunCardEvent(done, baseEvent({ type: "run.failed", error: { code: "x", message: "y" } }))).toBe(done);

    const failed = reduceImRunCardEvent(started, baseEvent({ type: "run.failed", error: { code: "e", message: "坏了" } }), 6000);
    expect(failed).toMatchObject({ status: "failed", error: "坏了" });
    const cancelled = reduceImRunCardEvent(started, baseEvent({ type: "run.cancelled" }), 7000);
    expect(cancelled.status).toBe("interrupted");
    const limited = reduceImRunCardEvent(started, baseEvent({ type: "run.turn_limited" }), 8000);
    expect(limited.status).toBe("turn_limited");
  });

  test("无关事件返回原引用", () => {
    const state = initialImRunCardState(1000);
    expect(reduceImRunCardEvent(state, baseEvent({ type: "im.delivery" }))).toBe(state);
  });
});
