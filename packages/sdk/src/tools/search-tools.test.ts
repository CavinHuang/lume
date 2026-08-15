import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobTool } from "./glob";
import { GrepTool } from "./grep";
import { createToolSearchTool } from "./tool-search";
import type { ToolDefinition } from "../types";

function makeFakeTool(name: string): ToolDefinition {
  return {
    name,
    description: `fake ${name}`,
    inputSchema: { type: "object", properties: {} },
    async call() {
      return { type: "tool_result", tool_use_id: "", content: "ok" };
    },
  };
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("search tools", () => {
  test("Grep exposes pagination and preserves no-match success semantics", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-search-tools-"));
    roots.push(root);
    await writeFile(join(root, "matches.txt"), "needle one\nother\nneedle two\nneedle three\n", "utf8");

    const result = await GrepTool.call({
      pattern: "needle",
      path: root,
      output_mode: "content",
      offset: 1,
      head_limit: 1,
    }, { cwd: root });

    expect(result.is_error).toBeFalsy();
    expect((result._meta?.search as any)).toMatchObject({ offset: 1, limit: 1, appliedOffset: 1, appliedLimit: 1 });
    expect((result._meta?.search as any).truncated).toBe(true);

    const noMatch = await GrepTool.call({ pattern: "missing", path: root }, { cwd: root });
    expect(noMatch.is_error).toBeFalsy();
    expect(String(noMatch.content)).toContain("No matches found");
  });

  test("Glob reports truncation instead of silently dropping matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-search-tools-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    await Promise.all(Array.from({ length: 501 }, (_, index) => writeFile(join(root, "src", `file-${index}.ts`), "", "utf8")));

    const result = await GlobTool.call({ pattern: "src/*.ts", path: root }, { cwd: root });

    expect(result.is_error).toBeFalsy();
    expect((result._meta?.search as any)).toMatchObject({ limit: 500, truncated: true, appliedLimit: 500 });
    expect(JSON.parse(String(result.content)).matches).toHaveLength(500);
  });
});

describe("ToolSearch promotion", () => {
  test("activates matched tools when the hook is present", async () => {
    const activated: string[][] = [];
    const tool = createToolSearchTool(() => [makeFakeTool("GuanlanSearch")]);
    const result = await tool.call({ query: "guanlan" }, {
      activateTools: (names) => { activated.push(names); return names; },
    } as any);

    expect(activated).toEqual([["GuanlanSearch"]]);
    expect(result.content).toContain("call them directly");
  });

  test("falls back to ExecuteTool guidance without the hook", async () => {
    const tool = createToolSearchTool(() => [makeFakeTool("GuanlanSearch")]);
    const result = await tool.call({ query: "guanlan" }, {} as any);

    expect(result.content).toContain("ExecuteTool");
  });
});
