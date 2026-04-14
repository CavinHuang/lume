import { describe, expect, test } from "bun:test";
import type { TaskGroup } from "./agent-tool-activity";
import {
  filterOrderedSdkBlocksForTaskGroups,
  normalizeSubagentResultText,
  resolveTaskTerminalVisualState
} from "./subagent-rendering";

const group = (toolUseId: string): TaskGroup => ({
  parent: {
    toolUseId,
    toolName: "Agent",
    input: {},
    done: true
  },
  children: []
});

describe("subagent-rendering", () => {
  test("应隐藏已由 TaskContainerCard 承载的 Agent/Task ordered block，避免重复渲染", () => {
    const blocks = [
      { type: "text", text: "我来委派一个 explorer subagent" },
      { type: "tool_use", id: "run-1", name: "Agent", input: { prompt: "inspect" } },
      { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "README.md" } }
    ];

    const filtered = filterOrderedSdkBlocksForTaskGroups(blocks, [group("run-1")]);

    expect(filtered).toEqual([
      { type: "text", text: "我来委派一个 explorer subagent" },
      { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "README.md" } }
    ]);
  });

  test("应把 subagent 无文本输出 fallback 视为无可见正文", () => {
    expect(normalizeSubagentResultText("(Subagent completed with no text output)")).toBeUndefined();
    expect(normalizeSubagentResultText("\n(Subagent completed with no text output)\n")).toBeUndefined();
    expect(normalizeSubagentResultText("真实输出")).toBe("真实输出");
  });

  test("应仅将明确失败态视为错误，避免 accepted/running 被渲染为 Failed", () => {
    expect(resolveTaskTerminalVisualState("completed")).toEqual({ done: true, isError: false });
    expect(resolveTaskTerminalVisualState("errored")).toEqual({ done: true, isError: true });
    expect(resolveTaskTerminalVisualState("failed")).toEqual({ done: true, isError: true });
    expect(resolveTaskTerminalVisualState("accepted")).toEqual({ done: false, isError: false });
    expect(resolveTaskTerminalVisualState("running")).toEqual({ done: false, isError: false });
    expect(resolveTaskTerminalVisualState(undefined)).toEqual({ done: false, isError: false });
  });
});
