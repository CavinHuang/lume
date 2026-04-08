import { describe, expect, test } from "bun:test";
import type { AgentThreadMeta } from "@lume/shared";
import {
  buildChildThreadMap,
  deriveAgentGroups,
  derivePinnedAgentThreads,
  filterRootAgentThreads
} from "./left-sidebar-agent-sessions";

const threads: AgentThreadMeta[] = [
  {
    id: "parent-a",
    title: "Parent A",
    workspaceId: "ws-a",
    createdAt: 1,
    updatedAt: 20
  },
  {
    id: "child-a1",
    title: "Child A1",
    parentThreadId: "parent-a",
    workspaceId: "ws-a",
    createdAt: 2,
    updatedAt: 10
  },
  {
    id: "child-a2",
    title: "Child A2",
    parentThreadId: "parent-a",
    workspaceId: "ws-a",
    createdAt: 3,
    updatedAt: 11
  },
  {
    id: "parent-b",
    title: "Parent B",
    workspaceId: "ws-b",
    pinned: true,
    createdAt: 4,
    updatedAt: 30
  }
];

describe("left-sidebar-agent-sessions", () => {
  test("buildChildThreadMap 应按 parentThreadId 聚合并按 createdAt 正序排序", () => {
    const map = buildChildThreadMap(threads, "ws-a");
    expect(map.get("parent-a")?.map((item: AgentThreadMeta) => item.id)).toEqual(["child-a1", "child-a2"]);
    expect(map.has("parent-b")).toBe(false);
  });

  test("filterRootAgentThreads 应过滤子线程并按 updatedAt 倒序排序", () => {
    expect(filterRootAgentThreads(threads, null).map((item: AgentThreadMeta) => item.id)).toEqual(["parent-b", "parent-a"]);
    expect(filterRootAgentThreads(threads, "ws-a").map((item: AgentThreadMeta) => item.id)).toEqual(["parent-a"]);
  });

  test("derivePinnedAgentThreads 与 deriveAgentGroups 应基于根线程结果工作", () => {
    const roots = filterRootAgentThreads(threads, null);
    expect(derivePinnedAgentThreads(roots).map((item: AgentThreadMeta) => item.id)).toEqual(["parent-b"]);
    expect(deriveAgentGroups(roots).flatMap((group) => group.items.map((item: AgentThreadMeta) => item.id))).toEqual(["parent-b", "parent-a"]);
  });
});
