import { describe, expect, test } from "bun:test";
import type { LumeRuntimeEvent } from "@lume/shared";
import {
  createSubagentParentProgressReporter,
  resolveSubagentProgressTitle,
} from "./run-subagent";

type TaskProgressEvent = Extract<LumeRuntimeEvent, { type: "task.progress" }>;

function createCollector() {
  const events: TaskProgressEvent[] = [];
  const reporter = createSubagentParentProgressReporter({
    parentThreadId: "parent-thread",
    runId: "sub-run-1",
    title: "调研助手",
    emit: (event) => events.push(event as TaskProgressEvent),
  });
  return { reporter, events };
}

describe("createSubagentParentProgressReporter", () => {
  test("report 发 running 帧：threadId 指向父线程，折叠轮次/工具/最近一行", () => {
    const { reporter, events } = createCollector();
    reporter.report({ toolNames: ["Read", "Grep"], lastLine: "正在检索调用点" });
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe("task.progress");
    expect(event.threadId).toBe("parent-thread");
    expect(event.status).toBe("running");
    expect(event.currentTaskId).toBe("subagent:sub-run-1");
    expect(event.tasks).toHaveLength(1);
    expect(event.tasks[0]).toMatchObject({
      id: "subagent:sub-run-1",
      title: "调研助手",
      status: "running",
    });
    expect(event.tasks[0]!.description).toContain("第 1 轮");
    expect(event.tasks[0]!.description).toContain("Grep");
    expect(event.tasks[0]!.description).toContain("正在检索调用点");
    expect(event.message).toBe(event.tasks[0]!.description);
  });

  test("节流窗内的后续帧丢弃——瞬态信号不得刷爆总线", () => {
    const { reporter, events } = createCollector();
    reporter.report({ toolNames: ["Read"], lastLine: "a" });
    reporter.report({ toolNames: ["Grep"], lastLine: "b" });
    reporter.report({ toolNames: ["Edit"], lastLine: "c" });
    expect(events).toHaveLength(1);
    expect(events[0]!.tasks[0]!.description).toContain("Read");
  });

  test("finalize 三态映射且幂等：completed/errored/aborted → completed/failed/cancelled", () => {
    for (const [status, expected] of [
      ["completed", "completed"],
      ["errored", "failed"],
      ["aborted", "cancelled"],
    ] as const) {
      const { reporter, events } = createCollector();
      reporter.report({ toolNames: ["Read"], lastLine: "x" });
      reporter.finalize(status);
      reporter.finalize(status);
      expect(events).toHaveLength(2);
      expect(events[0]!.status).toBe("running");
      expect(events[1]!.status).toBe(expected);
    }
  });

  test("aborted 终态帧 detail 置「已取消」，completed 保留最后进度串", () => {
    const aborted = createCollector();
    aborted.reporter.report({ toolNames: ["Read"], lastLine: "x" });
    aborted.reporter.finalize("aborted");
    expect(aborted.events[1]!.message).toBe("已取消");

    const completed = createCollector();
    completed.reporter.report({ toolNames: ["Read"], lastLine: "半成品" });
    completed.reporter.finalize("completed");
    expect(completed.events[1]!.message).toContain("半成品");
  });

  test("finalize/close 后残余 report 丢弃；close 不发帧", () => {
    const finalized = createCollector();
    finalized.reporter.finalize("completed");
    finalized.reporter.report({ toolNames: ["Read"], lastLine: "x" });
    expect(finalized.events).toHaveLength(1);

    const closed = createCollector();
    closed.reporter.close();
    closed.reporter.report({ toolNames: ["Read"], lastLine: "x" });
    expect(closed.events).toHaveLength(0);
  });

  test("无工具无文本时 detail 仅剩轮次；换行折叠为单行", () => {
    const { reporter, events } = createCollector();
    reporter.report({ toolNames: [], lastLine: "第一行\n第二行\t第三行" });
    const detail = events[0]!.tasks[0]!.description!;
    expect(detail).toBe("第 1 轮 · 第一行 第二行 第三行");
  });
});

describe("resolveSubagentProgressTitle", () => {
  test("description 缺省/空白时兜底「子代理」", () => {
    expect(resolveSubagentProgressTitle({ description: "  " })).toBe("子代理");
    expect(resolveSubagentProgressTitle({})).toBe("子代理");
    expect(resolveSubagentProgressTitle({ description: "并行调研" })).toBe("并行调研");
  });
});
