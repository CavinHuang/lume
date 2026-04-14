import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { TaskContainerCard } from "./TaskContainerCard";

describe("TaskContainerCard", () => {
  test("应渲染 subagent 的正文、thinking 和工具活动", () => {
    const html = renderToString(
      <TaskContainerCard
        defaultExpanded
        group={{
          parent: {
            toolUseId: "run-1",
            toolName: "Agent",
            input: {},
            displayName: "子任务 A",
            done: false
          },
          children: []
        }}
        subagentStream={{
          running: true,
          content: "subagent final output",
          reasoning: "先分析上下文",
          toolActivities: [{
            toolUseId: "tool-1",
            toolName: "Read",
            input: { path: "README.md" },
            done: true,
            result: "ok"
          }]
        }}
      />
    );

    expect(html).toContain("子 Agent 工具过程");
    expect(html).toContain("子 Agent 输出");
    expect(html).toContain("subagent final output");
    expect(html).toContain("思考过程");
    expect(html).toContain("README.md");
  });
});

test("应隐藏 subagent 无文本输出 fallback，避免显示英文占位文案", () => {
  const html = renderToString(
    <TaskContainerCard
      defaultExpanded
      group={{
        parent: {
          toolUseId: "run-2",
          toolName: "Agent",
          input: {},
          displayName: "子任务 B",
          done: true,
          result: "(Subagent completed with no text output)"
        },
        children: []
      }}
    />
  );

  expect(html).not.toContain("Subagent completed with no text output");
});
