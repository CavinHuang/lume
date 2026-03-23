import { describe, expect, test } from "bun:test";
import { resolveAgentSessionWorkspace } from "./workspace-selection";

describe("resolveAgentSessionWorkspace", () => {
  const workspaces = [
    { id: "ws-a", slug: "alpha" },
    { id: "ws-b", slug: "beta" }
  ];

  test("优先使用当前会话绑定的 workspace，避免沿用界面上一次选中的 workspace", () => {
    expect(resolveAgentSessionWorkspace(workspaces, "ws-a", "ws-b")).toEqual({
      id: "ws-b",
      slug: "beta"
    });
  });

  test("会话未绑定 workspace 时回退到当前选中的 workspace", () => {
    expect(resolveAgentSessionWorkspace(workspaces, "ws-a", null)).toEqual({
      id: "ws-a",
      slug: "alpha"
    });
  });
});
