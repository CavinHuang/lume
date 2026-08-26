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
  // 该测试走环境引擎(natives 缺失时落到 PATH 上的 rg/grep)。Windows 下
  // Git-Bash 的 MSYS grep.exe 冷启动单次 spawn 可达 ~3s(#483),两次调用
  // 会顶穿 bun 默认 5s 测试超时,故显式放宽;引擎本身行为不受影响。
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
  }, 20_000);

  test("Grep fallback stops collecting output once the pagination budget is satisfied", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-search-earlystop-"));
    roots.push(root);
    await writeFile(join(root, "matches.txt"), "seed\n", "utf8");

    // A configured ripgrep command forces the process fallback path; the
    // emitter prints far more entries than the requested window.
    const emitter = [
      "-e",
      "for (let i = 1; i <= 50000; i += 1) console.log(`file-${i}.txt`);",
    ];
    const result = await GrepTool.call({
      pattern: "needle",
      path: root,
      offset: 0,
      head_limit: 5,
    }, {
      cwd: root,
      sandbox: { ripgrep: { command: process.execPath, args: emitter } },
    } as any);

    expect(result.is_error).toBeFalsy();
    const meta = result._meta?.search as any;
    expect(meta.engine).toBe("rg");
    expect(meta.truncated).toBe(true);
    // 纯文本流（#565）：正文是换行分隔的条目，不再包 JSON envelope。
    const lines = String(result.content).split("\n").filter(Boolean);
    expect(lines).toHaveLength(5);
    // The search process was killed early instead of buffering all output.
    expect(meta.total).toBeLessThan(50000);
  });

  test("Grep BRE fallback appends a dialect hint for ERE/PCRE patterns", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-grep-bre-"));
    roots.push(root);
    await writeFile(join(root, "pets.txt"), "cat\n dog\n", "utf8");

    // 配置的 rg 不存在（ENOENT）→ 落到 POSIX BRE 的系统 grep 通道。
    const sandbox = { ripgrep: { command: "lume-nonexistent-rg-for-test", args: [] } };

    const breResult = await GrepTool.call({
      pattern: "(cat|dog)",
      path: root,
    }, { cwd: root, sandbox } as any);
    expect(breResult.is_error).toBeFalsy();
    expect((breResult._meta?.search as any).engine).toBe("grep");
    expect((breResult._meta?.search as any).engineDialect).toBe("bre");
    expect(String(breResult.content)).toContain("POSIX BRE fallback grep engine");

    // 无 ERE 语法的普通 pattern 在同一通道不触发方言提示。
    const literalResult = await GrepTool.call({
      pattern: "cat",
      path: root,
      output_mode: "content",
    }, { cwd: root, sandbox } as any);
    expect(literalResult.is_error).toBeFalsy();
    expect((literalResult._meta?.search as any).engineDialect).toBeUndefined();
    expect(String(literalResult.content)).not.toContain("POSIX BRE");
  }, 20_000);

  test("Grep BRE fallback truncates oversized content lines like the rg channel", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-grep-maxcols-"));
    roots.push(root);
    await writeFile(join(root, "wide.txt"), `${"x".repeat(2000)}needle${"y".repeat(2000)}`, "utf8");

    const result = await GrepTool.call({
      pattern: "needle",
      path: root,
      output_mode: "content",
    }, {
      cwd: root,
      sandbox: { ripgrep: { command: "lume-nonexistent-rg-for-test", args: [] } },
    } as any);

    expect(result.is_error).toBeFalsy();
    expect((result._meta?.search as any).engine).toBe("grep");
    const output = String(result.content);
    expect(output).toContain("…");
    expect(output.length).toBeLessThan(600);
  }, 20_000);

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
