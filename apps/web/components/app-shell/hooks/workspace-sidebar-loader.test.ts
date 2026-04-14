import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentWorkspace } from "@lume/shared";

const ensureDefaultAgentWorkspace = mock(async (): Promise<AgentWorkspace> => ({
  id: "default-id",
  name: "默认工作区",
  slug: "default",
  createdAt: 1,
  updatedAt: 1
}));

const listAgentWorkspaces = mock(async (): Promise<AgentWorkspace[]> => ([{
  id: "default-id",
  name: "默认工作区",
  slug: "default",
  createdAt: 1,
  updatedAt: 1
}]));

mock.module("../../../lib/desktop-api/agent", () => ({
  ensureDefaultAgentWorkspace,
  listAgentWorkspaces
}));

describe("workspace-sidebar-loader", () => {
  beforeEach(() => {
    ensureDefaultAgentWorkspace.mockReset();
    listAgentWorkspaces.mockReset();
  });

  test("并发初始化时应复用同一个工作区加载请求", async () => {
    let resolveEnsure!: (workspace: AgentWorkspace) => void;
    ensureDefaultAgentWorkspace.mockImplementation(
      () => new Promise<AgentWorkspace>((resolve) => {
        resolveEnsure = resolve;
      })
    );
    listAgentWorkspaces.mockResolvedValue([{
      id: "default-id",
      name: "默认工作区",
      slug: "default",
      createdAt: 1,
      updatedAt: 1
    }]);

    const { loadWorkspaceSidebarSnapshot } = await import("./workspace-sidebar-loader");

    const firstPromise = loadWorkspaceSidebarSnapshot();
    const secondPromise = loadWorkspaceSidebarSnapshot();

    expect(ensureDefaultAgentWorkspace).toHaveBeenCalledTimes(1);
    expect(listAgentWorkspaces).toHaveBeenCalledTimes(0);

    resolveEnsure({
      id: "default-id",
      name: "默认工作区",
      slug: "default",
      createdAt: 1,
      updatedAt: 1
    });

    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first.workspaces).toHaveLength(1);
    expect(second.workspaces).toHaveLength(1);
    expect(first).toEqual(second);
    expect(ensureDefaultAgentWorkspace).toHaveBeenCalledTimes(1);
    expect(listAgentWorkspaces).toHaveBeenCalledTimes(1);
  });

  test("初始化失败后应允许再次重试", async () => {
    ensureDefaultAgentWorkspace.mockRejectedValueOnce(new Error("首次失败"));
    ensureDefaultAgentWorkspace.mockResolvedValue({
      id: "default-id",
      name: "默认工作区",
      slug: "default",
      createdAt: 1,
      updatedAt: 1
    });
    listAgentWorkspaces.mockResolvedValue([{
      id: "default-id",
      name: "默认工作区",
      slug: "default",
      createdAt: 1,
      updatedAt: 1
    }]);

    const { loadWorkspaceSidebarSnapshot } = await import("./workspace-sidebar-loader");

    await expect(loadWorkspaceSidebarSnapshot()).rejects.toThrow("首次失败");

    const result = await loadWorkspaceSidebarSnapshot();

    expect(result.workspaces).toHaveLength(1);
    expect(ensureDefaultAgentWorkspace).toHaveBeenCalledTimes(2);
    expect(listAgentWorkspaces).toHaveBeenCalledTimes(1);
  });
});
