import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { lstatSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileEditTool } from "./edit";
import { FileReadTool } from "./read";
import { FileWriteTool } from "./write";
import { NotebookEditTool } from "./notebook-edit";
import { FileStateCache } from "../utils/fileCache";
import { captureFileSnapshots, collectCheckpointPaths, requiresWorkspaceCheckpoint, rewindCheckpoint } from "../utils/file-checkpoints";

// Windows needs admin or Developer Mode for real symlinks; probe once and
// skip the symlink-specific tests where creation is not permitted.
const symlinkProbeDir = mkdtempSync(join(tmpdir(), "lume-file-tools-probe-"));
let symlinksSupported = false;
try {
  symlinkSync("target", join(symlinkProbeDir, "probe"), "file");
  symlinksSupported = true;
} catch {
  // keep the suite green on locked-down Windows environments
}
afterAll(() => rmSync(symlinkProbeDir, { recursive: true, force: true }));

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("file tools", () => {
  test("uses target checkpoints for file tools and workspace checkpoints for broad mutation tools", () => {
    expect(collectCheckpointPaths("Write", { file_path: "src/a.ts" })).toEqual(["src/a.ts"]);
    expect(collectCheckpointPaths("Edit", { file_path: "src/b.ts" })).toEqual(["src/b.ts"]);
    for (const toolName of ["Bash", "Task", "Agent", "Delegate"]) {
      expect(requiresWorkspaceCheckpoint(toolName)).toBeTrue();
    }
    expect(requiresWorkspaceCheckpoint("Read")).toBeFalse();
  });

  test("blocks device and UNC paths before filesystem access", async () => {
    const readDevice = await FileReadTool.call({ file_path: "/dev/zero" }, { cwd: process.cwd() });
    const readUnc = await FileReadTool.call({ file_path: "\\\\server\\share\\secret.txt" }, { cwd: process.cwd() });
    const writeDevice = await FileWriteTool.call({ file_path: "/dev/null", content: "unsafe" }, { cwd: process.cwd() });
    const editUnc = await FileEditTool.call({ file_path: "//server/share/secret.txt", old_string: "a", new_string: "b" }, { cwd: process.cwd() });

    expect(readDevice.content).toContain("设备文件");
    expect(readUnc.content).toContain("UNC/SMB");
    expect(writeDevice.content).toContain("设备文件");
    expect(editUnc.content).toContain("UNC/SMB");
  });

  test("suggests nearby paths when Read receives a missing filename", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "coding-state.ts"), "export {}\n", "utf8");

    const result = await FileReadTool.call({ file_path: join(root, "src", "coding-stat.ts") }, { cwd: root });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Similar paths");
    expect(result.content).toContain("coding-state.ts");
  });

  test("captures common Bash mutation targets before execution", () => {
    expect(collectCheckpointPaths("Bash", { command: "echo hi > src/generated.ts" })).toEqual(["src/generated.ts"]);
    expect(collectCheckpointPaths("Bash", { command: "Set-Content -Path src/generated.ts -Value hi" })).toEqual(["src/generated.ts"]);
  });
  test("edits CRLF UTF-8 files without changing their encoding or line endings", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const filePath = join(root, "file.ts");
    const cache = new FileStateCache();
    await writeFile(filePath, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("const before = 1;\r\n", "utf8"),
    ]));
    await FileReadTool.call({ file_path: filePath }, { cwd: root, fileStateCache: cache });

    const result = await FileEditTool.call(
      { file_path: filePath, old_string: "before", new_string: "after" },
      { cwd: root, fileStateCache: cache },
    );

    expect(result.is_error).toBeFalsy();
    expect(await readFile(filePath)).toEqual(Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("const after = 1;\r\n", "utf8"),
    ]));
  });

  test("round-trips a CR-only file through Read and Edit preserving disk bytes (#569)", async () => {
    // CR-only 文件旧口径下 range 视图与 decode 视图永不相等，强制先读后
    // Edit 撞 stale_read 死循环；归一后必须可编辑且磁盘字节保真。
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const filePath = join(root, "classic.txt");
    const cache = new FileStateCache();
    await writeFile(filePath, "alpha\rbeta\r", "utf8");

    await FileReadTool.call({ file_path: filePath }, { cwd: root, fileStateCache: cache });
    const result = await FileEditTool.call(
      { file_path: filePath, old_string: "beta", new_string: "gamma" },
      { cwd: root, fileStateCache: cache },
    );

    expect(result.is_error).toBeFalsy();
    expect(await readFile(filePath, "utf8")).toBe("alpha\rgamma\r");
  });

  test("matches curly quotes without forcing the model back to shell or REPL editing", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const filePath = join(root, "quotes.ts");
    const cache = new FileStateCache();
    await writeFile(filePath, "const message = “hello”;\n", "utf8");
    await FileReadTool.call({ file_path: filePath }, { cwd: root, fileStateCache: cache });

    const result = await FileEditTool.call(
      { file_path: filePath, old_string: 'const message = "hello";', new_string: 'const message = "updated";' },
      { cwd: root, fileStateCache: cache },
    );

    expect(result.is_error).toBeFalsy();
    expect(result._meta?.file).toMatchObject({ normalizedQuotes: true, replacements: 1 });
    // 归一命中必须写进模型可见文本：_meta 会被 API 序列化剥除（#569）。
    expect(String(result.content)).toContain("normalizing curly quotes");
    expect(await readFile(filePath, "utf8")).toBe('const message = "updated";\n');
  });

  test("edits UTF-16LE files while preserving their BOM", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const filePath = join(root, "file.txt");
    const cache = new FileStateCache();
    await writeFile(filePath, Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("before\r\n", "utf16le"),
    ]));
    await FileReadTool.call({ file_path: filePath }, { cwd: root, fileStateCache: cache });

    const result = await FileEditTool.call(
      { file_path: filePath, old_string: "before", new_string: "after" },
      { cwd: root, fileStateCache: cache },
    );

    expect(result.is_error).toBeFalsy();
    expect((await readFile(filePath)).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    expect((await readFile(filePath)).subarray(2).toString("utf16le")).toBe("after\r\n");
  });

  test("rejects an edit when a fully read file changed", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const filePath = join(root, "file.txt");
    const cache = new FileStateCache();
    await writeFile(filePath, "before\n", "utf8");

    await FileReadTool.call({ file_path: filePath }, { cwd: root, fileStateCache: cache });
    await writeFile(filePath, "changed\n", "utf8");
    const result = await FileEditTool.call(
      { file_path: filePath, old_string: "changed", new_string: "updated" },
      { cwd: root, fileStateCache: cache },
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("modified since it was read");
  });

  test("rejects an edit after a partial read when the file changed (#333)", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const filePath = join(root, "partial.txt");
    const cache = new FileStateCache();
    await writeFile(filePath, "line-0\nline-1\nline-2\n", "utf8");

    await FileReadTool.call({ file_path: filePath, offset: 0, limit: 1 }, { cwd: root, fileStateCache: cache });
    await writeFile(filePath, "line-0\nchanged-1\nchanged-2\n", "utf8");
    const result = await FileEditTool.call(
      { file_path: filePath, old_string: "changed-2", new_string: "updated" },
      { cwd: root, fileStateCache: cache },
    );

    // Partial views skip the content comparison but the mtime/size floor must
    // still reject the stale edit.
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("modified since it was read");
    expect(result._meta?.file).toMatchObject({ conflict: "stale_read", retryable: true });
  });

  test("allows an edit after a partial read when the file is untouched (#333)", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const filePath = join(root, "partial-clean.txt");
    const cache = new FileStateCache();
    await writeFile(filePath, "alpha\nbeta\n", "utf8");

    await FileReadTool.call({ file_path: filePath, offset: 0, limit: 1 }, { cwd: root, fileStateCache: cache });
    const result = await FileEditTool.call(
      { file_path: filePath, old_string: "beta", new_string: "updated" },
      { cwd: root, fileStateCache: cache },
    );

    expect(result.is_error).toBeFalsy();
    expect(await readFile(filePath, "utf8")).toBe("alpha\nupdated\n");
  });

  test("rejects an edit when the file was never read and recovers after one Read (#569)", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const filePath = join(root, "unread.txt");
    await writeFile(filePath, "before\n", "utf8");

    const blocked = await FileEditTool.call(
      { file_path: filePath, old_string: "before", new_string: "after" },
      { cwd: root },
    );
    expect(blocked.is_error).toBe(true);
    expect(blocked.content).toContain("has not been read");
    expect(blocked.content).toContain("Read it first");
    expect(blocked._meta?.file).toMatchObject({ conflict: "not_read", retryable: true });

    // 一次 Read 即自愈：Bash 产物流等场景按指引补读后可正常编辑。
    const cache = new FileStateCache();
    await FileReadTool.call({ file_path: filePath }, { cwd: root, fileStateCache: cache });
    const ok = await FileEditTool.call(
      { file_path: filePath, old_string: "before", new_string: "after" },
      { cwd: root, fileStateCache: cache },
    );
    expect(ok.is_error).toBeFalsy();
    expect(await readFile(filePath, "utf8")).toBe("after\n");
  });

  test("tells a capacity-dropped record apart from a never-read file (#655)", async () => {
    // 长会话 LRU 驱逐会产生「明明读过却报未读」的伪错误；容量丢弃与
    // 真未读必须分开表述，模型才能走最短自愈路径（直接重读）。
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const droppedPath = join(root, "dropped.txt");
    const freshPath = join(root, "fresh.txt");
    const neverPath = join(root, "never.txt");
    await writeFile(droppedPath, "alpha\n", "utf8");
    await writeFile(freshPath, "beta\n", "utf8");
    await writeFile(neverPath, "gamma\n", "utf8");
    // maxEntries=1：读第二个文件即把第一个的记录挤出。
    const cache = new FileStateCache(1, 10_000_000);
    await FileReadTool.call({ file_path: droppedPath }, { cwd: root, fileStateCache: cache });
    await FileReadTool.call({ file_path: freshPath }, { cwd: root, fileStateCache: cache });

    const droppedEdit = await FileEditTool.call(
      { file_path: droppedPath, old_string: "alpha", new_string: "delta" },
      { cwd: root, fileStateCache: cache },
    );
    expect(droppedEdit.is_error).toBe(true);
    expect(String(droppedEdit.content)).toContain("capacity limit");
    expect(String(droppedEdit.content)).toContain("Read the file again");
    expect(droppedEdit._meta?.file).toMatchObject({ conflict: "not_read", retryable: true });

    const neverEdit = await FileEditTool.call(
      { file_path: neverPath, old_string: "gamma", new_string: "omega" },
      { cwd: root, fileStateCache: cache },
    );
    expect(neverEdit.is_error).toBe(true);
    expect(String(neverEdit.content)).toContain("has not been read yet");
    expect(String(neverEdit.content)).not.toContain("capacity limit");
  });

  test("requires reading before overwriting an existing file but exempts new files (#569)", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const filePath = join(root, "existing.txt");
    await writeFile(filePath, "before\n", "utf8");

    const blocked = await FileWriteTool.call({ file_path: filePath, content: "after\n" }, { cwd: root });
    expect(blocked.is_error).toBe(true);
    expect(blocked.content).toContain("has not been read");
    expect(blocked._meta?.file).toMatchObject({ conflict: "not_read" });
    expect(await readFile(filePath, "utf8")).toBe("before\n");

    // 新建文件没有可读的旧状态，天然豁免。
    const freshPath = join(root, "fresh.txt");
    const created = await FileWriteTool.call({ file_path: freshPath, content: "new\n" }, { cwd: root });
    expect(created.is_error).toBeFalsy();
  });

  test("escalates the not-found guidance across consecutive failures (#569)", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const filePath = join(root, "miss.txt");
    const cache = new FileStateCache();
    const failures = new Map<string, number>();
    await writeFile(filePath, "alpha\nbeta\n", "utf8");
    await FileReadTool.call({ file_path: filePath }, { cwd: root, fileStateCache: cache });
    const context = { cwd: root, fileStateCache: cache, editFailureCounts: failures };

    const first = await FileEditTool.call(
      { file_path: filePath, old_string: "missing-text", new_string: "x" },
      context,
    );
    expect(first.is_error).toBe(true);
    expect(String(first.content)).not.toContain("consecutive failures");

    const second = await FileEditTool.call(
      { file_path: filePath, old_string: "missing-text", new_string: "x" },
      context,
    );
    expect(second.is_error).toBe(true);
    expect(String(second.content)).toContain("2 consecutive failures");
    expect(String(second.content)).toContain("Read the file again");
    expect(second._meta?.file).toMatchObject({ conflict: "not_found", attempts: 2 });
  });

  test("suggests Write when a failing old_string spans a large block (#569)", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const filePath = join(root, "big.txt");
    const cache = new FileStateCache();
    await writeFile(filePath, Array.from({ length: 6 }, (_, i) => `line-${i}`).join("\n"), "utf8");
    await FileReadTool.call({ file_path: filePath }, { cwd: root, fileStateCache: cache });

    const result = await FileEditTool.call(
      { file_path: filePath, old_string: Array.from({ length: 5 }, (_, i) => `wrong-${i}`).join("\n"), new_string: "replaced" },
      { cwd: root, fileStateCache: cache, editFailureCounts: new Map() },
    );

    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain("prefer the Write tool");
  });

  test("reads only the requested line range into the tool result", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const filePath = join(root, "file.txt");
    await writeFile(filePath, Array.from({ length: 10 }, (_, i) => `line-${i}`).join("\n"), "utf8");

    const result = await FileReadTool.call(
      { file_path: filePath, offset: 3, limit: 2 },
      { cwd: root },
    );

    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("4\tline-3\n5\tline-4");
  });

  test("deduplicates repeated partial reads without sending the range again", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const filePath = join(root, "file.txt");
    const cache = new FileStateCache();
    await writeFile(filePath, "line-0\nline-1\nline-2\n", "utf8");

    await FileReadTool.call({ file_path: filePath, offset: 1, limit: 1 }, { cwd: root, fileStateCache: cache });
    const second = await FileReadTool.call({ file_path: filePath, offset: 1, limit: 1 }, { cwd: root, fileStateCache: cache });

    expect(second.content).toContain("File unchanged since it was last read");
    expect(second._meta?.read).toMatchObject({ unchanged: true });
  });

  test("deduplicates an unchanged full text read", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const filePath = join(root, "unchanged.txt");
    const cache = new FileStateCache();
    await writeFile(filePath, "same content\n", "utf8");

    const first = await FileReadTool.call({ file_path: filePath }, { cwd: root, fileStateCache: cache });
    const second = await FileReadTool.call({ file_path: filePath }, { cwd: root, fileStateCache: cache });

    expect(first.content).toContain("1\tsame content");
    expect(second.content).toContain("File unchanged since it was last read");
    expect(second._meta?.read).toMatchObject({ unchanged: true });
  });

  test("returns an actionable error when the configured text output limit is exceeded", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const filePath = join(root, "large.txt");
    await writeFile(filePath, "one two three four five\n", "utf8");

    const result = await FileReadTool.call(
      { file_path: filePath },
      { cwd: root, toolConfig: { readMaxTokens: 1 } },
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Use offset and limit");
    expect(result._meta?.read).toMatchObject({ maxTokens: 1, truncated: false });
  });

  test("does not cache a rejected read as if the content had been delivered", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const filePath = join(root, "source.ts");
    const cache = new FileStateCache();
    await writeFile(filePath, "const value = 1;\n", "utf8");

    const first = await FileReadTool.call(
      { file_path: filePath },
      { cwd: root, fileStateCache: cache, toolConfig: { readMaxTokens: 1 } },
    );
    const second = await FileReadTool.call(
      { file_path: filePath },
      { cwd: root, fileStateCache: cache, toolConfig: { readMaxTokens: 1 } },
    );

    expect(first.is_error).toBe(true);
    expect(second.is_error).toBe(true);
    expect(second.content).toContain("Use offset and limit");
    expect(second.content).not.toContain("File unchanged since it was last read");
  });

  test("returns provider-compatible image content blocks", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const filePath = join(root, "pixel.png");
    await writeFile(filePath, Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ));

    const result = await FileReadTool.call({ file_path: filePath }, { cwd: root });
    expect(result.is_error).toBeFalsy();
    expect(Array.isArray(result.content)).toBe(true);
    const image = (result.content as any[]).find((block) => block.type === "image");
    expect(image.source).toEqual({
      type: "base64",
      media_type: "image/png",
      data: expect.any(String),
    });
    expect(result._meta?.read).toMatchObject({ kind: "image", dimensions: { width: 1, height: 1 }, multimodal: true });
  });

  test("reports an empty text file as zero lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const filePath = join(root, "empty.txt");
    await writeFile(filePath, "", "utf8");

    const result = await FileReadTool.call({ file_path: filePath }, { cwd: root });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("(empty file)");
    expect(result._meta?.read).toMatchObject({ totalLines: 0, partial: false });
  });

  test("counts a trailing newline without inventing an extra line", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const filePath = join(root, "trailing.txt");
    await writeFile(filePath, "alpha\nbeta\n", "utf8");

    const result = await FileReadTool.call({ file_path: filePath, offset: 0, limit: 2 }, { cwd: root });
    expect(result.is_error).toBeFalsy();
    // "alpha\nbeta\n" is exactly two lines; the old range reader counted three
    // and made Read claim a remaining line that does not exist.
    // #649 review P1-5:窗口未截断且覆盖全部行 = 全文读（partial:false），
    // 否则小文件的显式全读也永远无法解锁写入。
    expect(result._meta?.read).toMatchObject({ totalLines: 2, partial: false });
    expect(String(result.content)).toContain("beta");
  });

  test("treats a windowed read that stopped early as a partial view (#314)", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const filePath = join(root, "long.txt");
    // Padded lines exceed a single stream chunk, so the ranged reader stops
    // early with an unverified count when given an explicit window.
    await writeFile(
      filePath,
      Array.from({ length: 600 }, (_, i) => `line-${i} ${"x".repeat(150)}`).join("\n"),
      "utf8",
    );
    const cache = new FileStateCache();

    // #564:显式范围走 ranged 路径——窗口凑满提前停读时必须强制 partial 视图
    const result = await FileReadTool.call({ file_path: filePath, offset: 0, limit: 100 }, { cwd: root, fileStateCache: cache });

    expect(result.is_error).toBeFalsy();
    expect(result._meta?.read).toMatchObject({ partial: true, truncated: true });
    // The stale-read guard must not mistake the window for the whole file.
    // Read writes its cache under the canonicalized (realpath) key (#336),
    // so the lookup must use the same key, not the lexical input path.
    expect(cache.get(realpathSync(filePath))?.isPartialView).toBe(true);
  });

  test("#564: summarize 与普通读互不短路（视图键参与 unchanged 判定）", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const filePath = join(root, "viewable.ts");
    await writeFile(
      filePath,
      Array.from({ length: 300 }, (_, i) => `function fn${i}() {\n  return ${i}\n}`).join("\n"),
      "utf8",
    );
    const cache = new FileStateCache();

    const rawRead = await FileReadTool.call({ file_path: filePath }, { cwd: root, fileStateCache: cache });
    expect(rawRead._meta?.read).toMatchObject({ summarized: false });
    // 缓存里是 raw 视图时,显式的 summarize 请求不得被 unchanged 短路吞掉
    // （natives 在测试环境不可用走回退,但 unchanged 判定已按视图键区分）
    const outlineRead = await FileReadTool.call({ file_path: filePath, summarize: true }, { cwd: root, fileStateCache: cache });
    expect(outlineRead._meta?.read?.unchanged).toBeUndefined();
  });

  test("#564: 600 行文件无参 Read 返回全文而非骨架/截断", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const filePath = join(root, "medium.ts");
    await writeFile(
      filePath,
      Array.from({ length: 600 }, (_, i) => `const value${i} = ${i}`).join("\n"),
      "utf8",
    );

    const result = await FileReadTool.call({ file_path: filePath }, { cwd: root });

    expect(result.is_error).toBeFalsy();
    expect(result._meta?.read).toMatchObject({ partial: false, summarized: false, totalLines: 600 });
    expect(String(result.content)).toContain("value599");
    expect(String(result.content)).not.toContain("elided");
    expect(String(result.content)).not.toContain("[truncated");
  });

  test("#564: readMaxLines 宿主旋钮可收窄全文直读预算", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const filePath = join(root, "knob.txt");
    await writeFile(
      filePath,
      Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n"),
      "utf8",
    );

    const result = await FileReadTool.call(
      { file_path: filePath },
      { cwd: root, fileStateCache: new FileStateCache(), toolConfig: { readMaxLines: 5 } },
    );

    expect(result.is_error).toBeFalsy();
    expect(result._meta?.read).toMatchObject({ partial: true, truncated: true, limit: 5 });
    expect(String(result.content)).toContain("[truncated: showing lines 1-5 of 20 total");
  });

  test("#564: 超限全文读截断并带尾部标记", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const filePath = join(root, "huge.txt");
    await writeFile(
      filePath,
      Array.from({ length: 2500 }, (_, i) => `line-${i}`).join("\n"),
      "utf8",
    );
    const cache = new FileStateCache();

    const result = await FileReadTool.call({ file_path: filePath }, { cwd: root, fileStateCache: cache });

    expect(result.is_error).toBeFalsy();
    expect(result._meta?.read).toMatchObject({ partial: true, truncated: true, totalLines: 2500 });
    expect(String(result.content)).toContain("[truncated: showing lines 1-2000 of 2500 total");
    // 缓存键是 realpath 规范化路径(#336),查询须同侧
    expect(cache.get(realpathSync(filePath))?.isPartialView).toBe(true);
  });

  test("#649 review P1-5: 超限大文件的显式全覆盖读判全文，解锁 Write/Edit", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const filePath = join(root, "big.txt");
    await writeFile(
      filePath,
      Array.from({ length: 2500 }, (_, i) => `line-${i}`).join("\n"),
      "utf8",
    );
    const cache = new FileStateCache();

    // 无参读被截断 → partial（上面的用例）；显式 offset=0 limit=2500 全覆盖 → full。
    // 否则该文件不存在任何解锁写入的读法，守卫补救指令不可满足。
    const result = await FileReadTool.call({ file_path: filePath, offset: 0, limit: 2500 }, { cwd: root, fileStateCache: cache });

    expect(result.is_error).toBeFalsy();
    // truncated 键只在真截断时存在（条件展开）
    expect(result._meta?.read).toMatchObject({ partial: false, totalLines: 2500 });
    expect(result._meta?.read?.truncated).toBeUndefined();
    expect(cache.get(realpathSync(filePath))?.isPartialView).toBe(false);
    expect(String(result.content)).toContain("line-2499");

    // #649 follow-up:summarize 与显式范围同给时范围优先，但必须显式告知 summarize 被忽略
    const bothGiven = await FileReadTool.call({ file_path: filePath, offset: 0, limit: 100, summarize: true }, { cwd: root, fileStateCache: new FileStateCache() });
    expect(bothGiven.is_error).toBeFalsy();
    expect(String(bothGiven.content)).toContain("summarize 参数未生效");
    expect(String(bothGiven.content)).toContain("line-99");
  });

  test("#649 round3: 尾窗读(offset>0 延伸到 EOF)仍是 partial 视图——缓存只有片段不得标全文", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const filePath = join(root, "tail.txt");
    await writeFile(
      filePath,
      Array.from({ length: 10 }, (_, i) => `line-${i}`).join("\n"),
      "utf8",
    );
    const cache = new FileStateCache();

    // offset=5 读到文件尾:公式若漏 offset===0 会判全文,后续 Edit 内容比对片段≠全文 → 假性 stale 死锁
    const result = await FileReadTool.call({ file_path: filePath, offset: 5, limit: 2000 }, { cwd: root, fileStateCache: cache });

    expect(result.is_error).toBeFalsy();
    expect(result._meta?.read).toMatchObject({ partial: true });
    // 缓存键是 realpath 规范化路径(#336),查询须同侧
    expect(cache.get(realpathSync(filePath))?.isPartialView).toBe(true);
    expect(cache.get(realpathSync(filePath))?.content).not.toContain("line-0");
  });

  test("rejects known binary files instead of decoding them as text", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const filePath = join(root, "archive.zip");
    await writeFile(filePath, Buffer.from([0x50, 0x4b, 0x03, 0x04]));

    const result = await FileReadTool.call({ file_path: filePath }, { cwd: root });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Cannot read binary file as text");
    expect(result._meta?.read).toMatchObject({ kind: "binary", multimodal: false });
  });

  test("returns a structured notebook payload and validates its cells", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const filePath = join(root, "notebook.ipynb");
    await writeFile(filePath, JSON.stringify({
      cells: [
        { cell_type: "code", source: ["print(1)\n"], outputs: [], execution_count: null },
        { cell_type: "markdown", source: ["# Title\n"] },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    }));

    const result = await FileReadTool.call({ file_path: filePath, offset: 1, limit: 1 }, { cwd: root });
    expect(result.is_error).toBeFalsy();
    // Read resolves paths through resolveInputPath (#336): the payload echoes
    // the canonicalized (realpath) path, not the lexical input.
    expect(JSON.parse(result.content as string)).toEqual({
      type: "notebook",
      file: { filePath: realpathSync(filePath), cells: [{ cell_type: "markdown", source: ["# Title\n"] }] },
    });
    expect(result._meta?.read).toMatchObject({ kind: "notebook", totalCells: 2, partial: true });
  });

  test("returns a PDF document block or rendered page image", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const filePath = join(root, "sample.pdf");
    const pdfStream = "BT /F1 12 Tf 72 720 Td (Hello PDF) Tj ET\n";
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      `<< /Length ${Buffer.byteLength(pdfStream)} >>\nstream\n${pdfStream}endstream`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    for (let i = 0; i < objects.length; i++) {
      offsets.push(Buffer.byteLength(pdf));
      pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const xrefOffset = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    await writeFile(filePath, pdf);

    const documentResult = await FileReadTool.call({ file_path: filePath }, { cwd: root });
    expect(documentResult.is_error).toBeFalsy();
    expect((documentResult.content as any[]).some((block) => block.type === "document")).toBe(true);
    expect(documentResult._meta?.read).toMatchObject({ kind: "pdf", totalPages: 1, multimodal: true });

    const pageResult = await FileReadTool.call({ file_path: filePath, pages: "1" }, { cwd: root });
    expect(pageResult.is_error).toBeFalsy();
    expect((pageResult.content as any[]).some((block) => block.type === "image")).toBe(true);
    expect(pageResult._meta?.read).toMatchObject({ kind: "pdf", pages: [1] });
  });

  // bun:test 不认 options.skip 对象(静默执行),须用 skipIf 才能真正跳过
  test.skipIf(!symlinksSupported)("writes through a symlink to its target instead of replacing the link (#367)", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const cache = new FileStateCache();
    await writeFile(join(root, "target.txt"), "before\n", "utf8");
    await symlink(join(root, "target.txt"), join(root, "link.txt"), "file");
    await FileReadTool.call({ file_path: join(root, "link.txt") }, { cwd: root, fileStateCache: cache });

    const result = await FileWriteTool.call({ file_path: join(root, "link.txt"), content: "after\n" }, { cwd: root, fileStateCache: cache });

    expect(result.is_error).toBeFalsy();
    expect(lstatSync(join(root, "link.txt")).isSymbolicLink()).toBe(true);
    expect(await readFile(join(root, "target.txt"), "utf8")).toBe("after\n");
  });

  test.skipIf(!symlinksSupported)("edits through a symlink while keeping the link intact (#367)", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const cache = new FileStateCache();
    await writeFile(join(root, "target.txt"), "alpha\nbeta\n", "utf8");
    await symlink(join(root, "target.txt"), join(root, "link.txt"), "file");
    await FileReadTool.call({ file_path: join(root, "link.txt") }, { cwd: root, fileStateCache: cache });

    const result = await FileEditTool.call(
      { file_path: join(root, "link.txt"), old_string: "beta", new_string: "updated" },
      { cwd: root, fileStateCache: cache },
    );

    expect(result.is_error).toBeFalsy();
    expect(lstatSync(join(root, "link.txt")).isSymbolicLink()).toBe(true);
    expect(await readFile(join(root, "target.txt"), "utf8")).toBe("alpha\nupdated\n");
  });

  test("rejects a dangling symlink instead of silently replacing it (#367)", { skip: !symlinksSupported }, async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    await symlink(join(root, "missing-target.txt"), join(root, "dangling.txt"), "file");

    const write = await FileWriteTool.call({ file_path: join(root, "dangling.txt"), content: "x\n" }, { cwd: root });
    const edit = await FileEditTool.call(
      { file_path: join(root, "dangling.txt"), old_string: "x", new_string: "y" },
      { cwd: root },
    );

    expect(write.is_error).toBe(true);
    expect(edit.is_error).toBe(true);
    expect(lstatSync(join(root, "dangling.txt")).isSymbolicLink()).toBe(true);
  });

  test("re-checks the sandbox against a symlink's resolved target (#367)", { skip: !symlinksSupported }, async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    await mkdir(join(root, "in"));
    await mkdir(join(root, "out"));
    await writeFile(join(root, "out", "secret.txt"), "keep\n", "utf8");
    await symlink(join(root, "out", "secret.txt"), join(root, "in", "link.txt"), "file");
    const cache = new FileStateCache();
    const sandboxContext = {
      cwd: root,
      fileStateCache: cache,
      sandbox: { enabled: true, filesystem: { allowWrite: [join(root, "in")] } },
    } as any;
    // 沙箱 read 只受 denyRead 限制，先经 Read 建立未读防护所需的记录。
    await FileReadTool.call({ file_path: join(root, "in", "link.txt") }, sandboxContext);

    const result = await FileWriteTool.call(
      { file_path: join(root, "in", "link.txt"), content: "clobber\n" },
      sandboxContext,
    );

    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain("denied");
    expect(await readFile(join(root, "out", "secret.txt"), "utf8")).toBe("keep\n");
    expect(realpathSync(join(root, "in", "link.txt"))).toBe(realpathSync(join(root, "out", "secret.txt")));
  });

  test("refuses to overwrite a fully read file after an external change", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const filePath = join(root, "file.txt");
    const cache = new FileStateCache();
    await writeFile(filePath, "before\n", "utf8");
    await FileReadTool.call({ file_path: filePath }, { cwd: root, fileStateCache: cache });
    await writeFile(filePath, "external\n", "utf8");

    const result = await FileWriteTool.call({ file_path: filePath, content: "agent\n" }, { cwd: root, fileStateCache: cache });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("modified since it was read");
    expect(await readFile(filePath, "utf8")).toBe("external\n");
  });

  test("refuses to overwrite after a partial read when the file changed", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const filePath = join(root, "file.txt");
    const cache = new FileStateCache();
    await writeFile(filePath, "before\nsecond\n", "utf8");
    await FileReadTool.call({ file_path: filePath, offset: 0, limit: 1 }, { cwd: root, fileStateCache: cache });
    await writeFile(filePath, "external\nsecond\n", "utf8");

    const result = await FileWriteTool.call({ file_path: filePath, content: "agent\n" }, { cwd: root, fileStateCache: cache });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("modified since it was read");
    expect(await readFile(filePath, "utf8")).toBe("external\nsecond\n");
  });

  test("rejects an oversized write before creating or changing the file", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const filePath = join(root, "large.txt");

    const result = await FileWriteTool.call(
      { file_path: filePath, content: "12345" },
      { cwd: root, toolConfig: { writeMaxBytes: 4 } },
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("exceeding the 4-byte limit");
    await expect(readFile(filePath)).rejects.toThrow();
  });

  test("writes UTF-16LE files while preserving their BOM", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const filePath = join(root, "file.txt");
    const cache = new FileStateCache();
    await writeFile(filePath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("before\r\n", "utf16le")]));
    await FileReadTool.call({ file_path: filePath }, { cwd: root, fileStateCache: cache });

    const result = await FileWriteTool.call({ file_path: filePath, content: "after\n" }, { cwd: root, fileStateCache: cache });

    expect(result.is_error).toBeFalsy();
    expect((await readFile(filePath)).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    expect((await readFile(filePath)).subarray(2).toString("utf16le")).toBe("after\r\n");
  });

  test("rejects a stale notebook edit and captures notebook paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const filePath = join(root, "notebook.ipynb");
    const cache = new FileStateCache();
    const notebook = { cells: [{ id: "cell-1", cell_type: "code", source: ["before\n"], outputs: [], execution_count: null }], metadata: {}, nbformat: 4, nbformat_minor: 5 };
    await writeFile(filePath, JSON.stringify(notebook, null, 1), "utf8");
    await FileReadTool.call({ file_path: filePath }, { cwd: root, fileStateCache: cache });
    await writeFile(filePath, JSON.stringify({ ...notebook, metadata: { changed: true } }, null, 1), "utf8");

    const result = await NotebookEditTool.call({ notebook_path: filePath, cell_id: "cell-1", new_source: "after\n", edit_mode: "replace" }, { cwd: root, fileStateCache: cache });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("modified since it was read");
  });

  test("rewinds a checkpoint atomically while preserving text metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const filePath = join(root, "file.txt");
    await writeFile(filePath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("before\r\n", "utf16le")]));
    const state = {};
    const checkpoint = await captureFileSnapshots(state, "message-1", [filePath]);
    await writeFile(filePath, "after\n", "utf8");

    const result = await rewindCheckpoint(checkpoint);
    expect(result.canRewind).toBe(true);
    expect((await readFile(filePath)).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    expect((await readFile(filePath)).subarray(2).toString("utf16le")).toBe("before\r\n");
  });
});
