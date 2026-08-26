import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileReadTool } from "./read";
import { MultiEditTool } from "./multi-edit";
import { FileStateCache } from "../utils/fileCache";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setupFile(content: string): Promise<{ root: string; filePath: string; cache: FileStateCache }> {
  const root = await mkdtemp(join(tmpdir(), "lume-multi-edit-"));
  roots.push(root);
  const filePath = join(root, "target.ts");
  await writeFile(filePath, content, "utf8");
  const cache = new FileStateCache();
  await FileReadTool.call({ file_path: filePath }, { cwd: root, fileStateCache: cache });
  return { root, filePath, cache };
}

describe("MultiEdit", () => {
  test("applies sequential edits atomically and reports per-hunk counts", async () => {
    const { filePath, cache } = await setupFile("const a = 1;\nconst b = 2;\nconst c = 3;\n");

    const result = await MultiEditTool.call({
      file_path: filePath,
      edits: [
        { old_string: "const a = 1;", new_string: "const a = 10;" },
        { old_string: "const b = 2;", new_string: "const b = 20;" },
        { old_string: "const c = 3;", new_string: "const c = 30;\nconst d = 40;" },
      ],
    }, { cwd: tmpdir(), fileStateCache: cache });

    expect(result.is_error).toBeFalsy();
    const data = JSON.parse(String(result.content)) as Record<string, unknown>;
    expect(data.editsApplied).toBe(3);
    expect(data.replacements).toBe(3);
    expect(data.perEditReplacements).toEqual([1, 1, 1]);
    const text = await readFile(filePath, "utf8");
    expect(text).toBe("const a = 10;\nconst b = 20;\nconst c = 30;\nconst d = 40;\n");
  });

  test("later hunks see earlier results (chained edits)", async () => {
    const { filePath, cache } = await setupFile("value: X\n");

    const result = await MultiEditTool.call({
      file_path: filePath,
      edits: [
        { old_string: "X", new_string: "Y" },
        { old_string: "Y", new_string: "Z" },
      ],
    }, { cwd: tmpdir(), fileStateCache: cache });

    expect(result.is_error).toBeFalsy();
    expect(await readFile(filePath, "utf8")).toBe("value: Z\n");
  });

  test("rejects the whole batch when one hunk misses — zero disk write", async () => {
    const original = "alpha\nbeta\n";
    const { filePath, cache } = await setupFile(original);

    const result = await MultiEditTool.call({
      file_path: filePath,
      edits: [
        { old_string: "alpha", new_string: "ALPHA" },
        { old_string: "does-not-exist", new_string: "nope" },
      ],
    }, { cwd: tmpdir(), fileStateCache: cache });

    expect(result.is_error).toBe(true);
    expect(String(result.content ?? result.data)).toContain("edits[1]");
    expect(String(result.content ?? result.data)).toContain("Nothing was written");
    expect(await readFile(filePath, "utf8")).toBe(original);
  });

  test("ambiguous hunk names its index instead of silently picking one", async () => {
    const { filePath, cache } = await setupFile("dup\nmiddle\ndup\n");

    const result = await MultiEditTool.call({
      file_path: filePath,
      edits: [{ old_string: "dup", new_string: "x" }],
    }, { cwd: tmpdir(), fileStateCache: cache });

    expect(result.is_error).toBe(true);
    expect(String(result.content ?? result.data)).toContain("appears 2 times");
    expect((result._meta as any)?.file?.failedEditIndex).toBe(0);
    expect(await readFile(filePath, "utf8")).toBe("dup\nmiddle\ndup\n");
  });

  test("replace_all hunk replaces every occurrence", async () => {
    const { filePath, cache } = await setupFile("dup\nmiddle\ndup\n");

    const result = await MultiEditTool.call({
      file_path: filePath,
      edits: [{ old_string: "dup", new_string: "fixed", replace_all: true }],
    }, { cwd: tmpdir(), fileStateCache: cache });

    expect(result.is_error).toBeFalsy();
    const data = JSON.parse(String(result.content)) as Record<string, unknown>;
    expect(data.replacements).toBe(2);
    expect(await readFile(filePath, "utf8")).toBe("fixed\nmiddle\nfixed\n");
  });

  test("rejects unread files with the shared not-read contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-multi-edit-"));
    roots.push(root);
    const filePath = join(root, "unread.ts");
    await writeFile(filePath, "content\n", "utf8");

    const result = await MultiEditTool.call({
      file_path: filePath,
      edits: [{ old_string: "content", new_string: "changed" }],
    }, { cwd: root, fileStateCache: new FileStateCache() });

    expect(result.is_error).toBe(true);
    expect(String(result.content ?? result.data)).toContain("has not been read yet");
    expect((result._meta as any)?.file?.conflict).toBe("not_read");
  });

  test("rejects stale reads through the shared Edit path", async () => {
    const { root, filePath, cache } = await setupFile("v1\n");
    // 读后被外部修改 → mtime/内容变化
    await writeFile(filePath, "v2-external\n", "utf8");

    const result = await MultiEditTool.call({
      file_path: filePath,
      edits: [{ old_string: "v2-external", new_string: "x" }],
    }, { cwd: root, fileStateCache: cache });

    expect(result.is_error).toBe(true);
    expect(String(result.content ?? result.data)).toContain("has been modified since it was read");
    expect((result._meta as any)?.file?.conflict).toBe("stale_read");
  });

  test("whitespace tolerance tier matches tab-for-space differences and says so", async () => {
    const { filePath, cache } = await setupFile("function f() {\n\treturn 1;\n}\n");

    const result = await MultiEditTool.call({
      file_path: filePath,
      edits: [{ old_string: "function f() {\n    return 1;\n}", new_string: "function g() {\n    return 2;\n}" }],
    }, { cwd: tmpdir(), fileStateCache: cache });

    expect(result.is_error).toBeFalsy();
    const data = JSON.parse(String(result.content)) as Record<string, unknown>;
    expect(String(data.message)).toContain("normalizing tabs and unicode spaces");
    expect((result._meta as any)?.file?.normalizedWhitespace).toBe(true);
    // 容差只作用于匹配；new_string 原样落盘，不做缩进改写
    expect(await readFile(filePath, "utf8")).toBe("function g() {\n    return 2;\n}\n");
  });

  test("validateInput caps batch size and rejects identical pairs", () => {
    const tooMany = MultiEditTool.validateInput?.({
      file_path: "/tmp/x",
      edits: Array.from({ length: 21 }, () => ({ old_string: "a", new_string: "b" })),
    });
    expect(tooMany).toContain("Too many edits");

    const identical = MultiEditTool.validateInput?.({
      file_path: "/tmp/x",
      edits: [{ old_string: "same", new_string: "same" }],
    });
    expect(identical).toContain("identical");
  });

  test("checkpoint capture covers MultiEdit via the shared whitelist", async () => {
    const { collectCheckpointPaths } = await import("../utils/file-checkpoints");
    expect(collectCheckpointPaths("MultiEdit", {
      file_path: "src/a.ts",
      edits: [{ old_string: "a", new_string: "b" }],
    })).toEqual(["src/a.ts"]);
  });
});
