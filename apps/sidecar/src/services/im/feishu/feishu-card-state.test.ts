import { describe, expect, test } from "bun:test";
import { initialImRunCardState, reduceImRunCardEvent, type ImRunCardState } from "./feishu-card-state";
import { renderImRunCard } from "./feishu-card-renderer";
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

  test("压缩中间态：started 置位 / completed 复位，幂等（#709 第 4 项）", () => {
    let state = initialImRunCardState(1000);
    state = reduceImRunCardEvent(state, baseEvent({ type: "context.compaction.started", trigger: "prompt_too_long" }));
    expect(state.compacting).toBe(true);
    const again = reduceImRunCardEvent(state, baseEvent({ type: "context.compaction.started" }));
    expect(again).toBe(state);
    state = reduceImRunCardEvent(state, baseEvent({ type: "context.compaction.completed" }));
    expect(state.compacting).toBe(false);
  });

  test("从未 started 时 completed 返回原引用（#725 review R8）", () => {
    const state = initialImRunCardState(1000);
    expect(reduceImRunCardEvent(state, baseEvent({ type: "context.compaction.completed" }))).toBe(state);
  });

  test("终态后迟到的压缩事件被冻结（#725 review R8）", () => {
    let state = initialImRunCardState(1000);
    state = reduceImRunCardEvent(state, baseEvent({ type: "run.completed" }), 5000);
    expect(reduceImRunCardEvent(state, baseEvent({ type: "context.compaction.started" }))).toBe(state);
  });
});

describe("renderImRunCard 压缩中间态标题（#709 第 4 项）", () => {
  test("compacting 且 running 时头部显示「正在压缩上下文」", () => {
    const state: ImRunCardState = { status: "running", blocks: [], startedAtMs: 1000, compacting: true };
    const card = renderImRunCard(state);
    expect(card.header.title.content).toBe("正在压缩上下文");
    // 非压缩运行保持原标题
    const idle = renderImRunCard({ status: "running", blocks: [], startedAtMs: 1000 });
    expect(idle.header.title.content).toBe("正在处理");
  });

  test("compacting 残留 + 终态时显示终态标题而非压缩标题（#725 review R8）", () => {
    const state: ImRunCardState = { status: "completed", blocks: [], startedAtMs: 1000, endedAtMs: 5000, compacting: true };
    expect(renderImRunCard(state).header.title.content).toBe("已完成");
  });
});
