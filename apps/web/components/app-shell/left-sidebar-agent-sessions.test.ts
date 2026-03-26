import { describe, expect, test } from "bun:test";
import type { AgentSessionMeta } from "@lume/shared";
import {
  buildChildSessionMap,
  deriveAgentGroups,
  derivePinnedAgentSessions,
  filterRootAgentSessions
} from "./left-sidebar-agent-sessions";

const sessions: AgentSessionMeta[] = [
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
    parentSessionId: "parent-a",
    workspaceId: "ws-a",
    createdAt: 2,
    updatedAt: 10
  },
  {
    id: "child-a2",
    title: "Child A2",
    parentSessionId: "parent-a",
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
] as AgentSessionMeta[];

describe("left-sidebar-agent-sessions", () => {
  test("buildChildSessionMap 应按 parentSessionId 聚合并按 createdAt 正序排序", () => {
    const map = buildChildSessionMap(sessions, "ws-a");
    expect(map.get("parent-a")?.map((item) => item.id)).toEqual(["child-a1", "child-a2"]);
    expect(map.has("parent-b")).toBe(false);
  });

  test("filterRootAgentSessions 应过滤子会话并按 updatedAt 倒序排序", () => {
    expect(filterRootAgentSessions(sessions, null).map((item) => item.id)).toEqual(["parent-b", "parent-a"]);
    expect(filterRootAgentSessions(sessions, "ws-a").map((item) => item.id)).toEqual(["parent-a"]);
  });

  test("derivePinnedAgentSessions 与 deriveAgentGroups 应基于根会话结果工作", () => {
    const roots = filterRootAgentSessions(sessions, null);
    expect(derivePinnedAgentSessions(roots).map((item) => item.id)).toEqual(["parent-b"]);
    expect(deriveAgentGroups(roots).flatMap((group) => group.items.map((item) => item.id))).toEqual(["parent-b", "parent-a"]);
  });
});
