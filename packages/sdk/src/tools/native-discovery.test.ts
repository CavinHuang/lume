import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let nativeAvailable = true;
let fuzzyResult: unknown = [{ path: "src/read.ts", is_directory: false, score: 100 }];
let workspaceResult: unknown = {
  entries: [{ path: "src", file_type: "dir", mtime: null, size: null }],
  agents_md_files: ["docs/AGENTS.md"],
  truncated: false,
};
const nativeFuzzyFindMock = mock(async (..._args: unknown[]) => fuzzyResult);
const nativeListWorkspaceMock = mock(async (..._args: unknown[]) => workspaceResult);

mock.module("@lume/natives", () => ({
  countStringTokens: () => 0,
  isNativeAvailable: () => nativeAvailable,
  nativeFuzzyFind: nativeFuzzyFindMock,
  nativeGlob: async () => null,
  nativeGrep: async () => null,
  nativeSearch: () => null,
  nativeSummarize: () => null,
  nativeListWorkspace: nativeListWorkspaceMock,
}));

const { getAllBaseTools } = await import("./index.js");

function getTool(name: string) {
  return getAllBaseTools().find((tool) => tool.name === name);
}

describe("native discovery tools", () => {
  beforeEach(() => {
    nativeAvailable = true;
    fuzzyResult = [{ path: "src/read.ts", is_directory: false, score: 100 }];
    workspaceResult = {
      entries: [{ path: "src", file_type: "dir", mtime: null, size: null }],
      agents_md_files: ["docs/AGENTS.md"],
      truncated: false,
    };
    nativeFuzzyFindMock.mockClear();
    nativeListWorkspaceMock.mockClear();
  });

  test("FindFiles calls native fuzzy find with the resolved path", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-find-files-"));
    try {
      const tool = getTool("FindFiles");
      expect(tool).toBeDefined();

      const result = await tool!.call(
        { query: "read", path: ".", max_results: 7 },
        { cwd: root } as any,
      );

      expect(result.is_error).toBe(false);
      expect(nativeFuzzyFindMock).toHaveBeenCalledWith("read", root, 7);
      expect(JSON.parse(String(result.content))).toEqual({
        query: "read",
        path: root,
        matches: [{ path: "src/read.ts", is_directory: false, score: 100 }],
        total_matches: 1,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("FindFiles rejects sandbox-denied paths before native work", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-find-files-sandbox-"));
    try {
      const tool = getTool("FindFiles");
      expect(tool).toBeDefined();

      const result = await tool!.call(
        { query: "read", path: root },
        { cwd: root, sandbox: { enabled: true, filesystem: { denyRead: [root] } } } as any,
      );

      expect(result.is_error).toBe(true);
      expect(String(result.content)).toContain("Sandbox denied read access");
      expect(nativeFuzzyFindMock).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("FindFiles returns an explicit error when native fuzzy find is unavailable", async () => {
    nativeAvailable = false;
    const root = mkdtempSync(join(tmpdir(), "lume-find-files-unavailable-"));
    try {
      const tool = getTool("FindFiles");
      expect(tool).toBeDefined();

      const result = await tool!.call({ query: "read" }, { cwd: root } as any);

      expect(result.is_error).toBe(true);
      expect(String(result.content)).toContain("Native fuzzy find is unavailable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ListWorkspaceTree calls native workspace scan with max depth", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-workspace-tree-"));
    try {
      const tool = getTool("ListWorkspaceTree");
      expect(tool).toBeDefined();

      const result = await tool!.call(
        { path: ".", max_depth: 3, collect_agents_md: true },
        { cwd: root } as any,
      );

      expect(result.is_error).toBe(false);
      expect(nativeListWorkspaceMock).toHaveBeenCalledWith({
        path: root,
        max_depth: 3,
        collect_agents_md: true,
      });
      expect(JSON.parse(String(result.content))).toEqual({
        path: root,
        entries: [{ path: "src", file_type: "dir", mtime: null, size: null }],
        agentsMdFiles: ["docs/AGENTS.md"],
        truncated: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ListWorkspaceTree returns an explicit error when native scan is unavailable", async () => {
    nativeAvailable = false;
    const root = mkdtempSync(join(tmpdir(), "lume-workspace-tree-unavailable-"));
    try {
      const tool = getTool("ListWorkspaceTree");
      expect(tool).toBeDefined();

      const result = await tool!.call({ path: "." }, { cwd: root } as any);

      expect(result.is_error).toBe(true);
      expect(String(result.content)).toContain("Native workspace scan is unavailable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
