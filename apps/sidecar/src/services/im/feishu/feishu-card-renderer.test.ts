import { describe, expect, test } from "bun:test";
import { initialImRunCardState, reduceImRunCardEvent } from "./feishu-card-state";
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

function stateWith(...events: LumeRuntimeEvent[]) {
  let state = initialImRunCardState(1000);
  for (const event of events) state = reduceImRunCardEvent(state, event);
  return state;
}

describe("renderImRunCard", () => {
  test("运行中：蓝色头部、streaming_mode 开启、空内容显示占位", () => {
    const card = renderImRunCard(initialImRunCardState(1000));
    expect(card.header).toMatchObject({ title: { content: "正在处理" }, template: "blue" });
    expect(card.config.streaming_mode).toBe(true);
    expect(card.body.elements).toEqual([{ tag: "markdown", content: "…" }]);
  });

  test("完成态：绿色头部、streaming_mode 关闭、含耗时脚注", () => {
    const state = reduceImRunCardEvent(
      stateWith(baseEvent({ type: "assistant.delta", delta: "结果" })),
      baseEvent({ type: "run.completed" }),
      16000
    );
    const card = renderImRunCard(state);
    expect(card.header.template).toBe("green");
    expect(card.config.streaming_mode).toBe(false);
    const contents = card.body.elements.map((e) => (e.tag === "markdown" ? e.content : ""));
    expect(contents.join("\n")).toContain("耗时 15 秒");
  });

  test("思考块渲染为折叠面板", () => {
    const state = stateWith(
      baseEvent({ type: "assistant.thinking_delta", delta: "内部推理" }),
      baseEvent({ type: "assistant.delta", delta: "回复" })
    );
    const card = renderImRunCard(state);
    const panel = card.body.elements.find((e) => e.tag === "collapsible_panel") as Record<string, unknown>;
    expect(panel).toBeDefined();
    expect(JSON.stringify(panel)).toContain("思考过程");
    expect(JSON.stringify(panel)).toContain("内部推理");
  });

  test("工具超过 3 个收进摘要面板且默认收起", () => {
    const events = Array.from({ length: 4 }, (_, i) =>
      baseEvent({ type: "tool.started", toolCallId: `tc${i}`, toolName: `tool_${i}` })
    );
    const card = renderImRunCard(stateWith(...events));
    const panels = card.body.elements.filter((e) => e.tag === "collapsible_panel");
    expect(panels).toHaveLength(1);
    expect(panels[0]).toMatchObject({ expanded: false });
    expect(JSON.stringify(panels[0])).toContain("工具调用（4）");
  });

  test("失败态红色头部且脚注带错误信息", () => {
    const state = reduceImRunCardEvent(
      initialImRunCardState(1000),
      baseEvent({ type: "run.failed", error: { code: "x", message: "模型超时" } }),
      4000
    );
    const card = renderImRunCard(state);
    expect(card.header).toMatchObject({ template: "red", title: { content: "运行失败" } });
    const contents = card.body.elements.map((e) => (e.tag === "markdown" ? e.content : ""));
    expect(contents.join("\n")).toContain("模型超时");
  });

  test("超长文本截断保护（保留头尾）", () => {
    const long = "字".repeat(9000);
    const state = stateWith(baseEvent({ type: "assistant.delta", delta: long }));
    const card = renderImRunCard(state);
    const md = card.body.elements[0] as { tag: string; content: string };
    expect(md.content.length).toBeLessThan(long.length);
    expect(md.content.startsWith("字")).toBe(true);
    expect(md.content.endsWith("字")).toBe(true);
  });
});
