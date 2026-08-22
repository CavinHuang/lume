import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileEditTool } from "./edit";
import { FileReadTool } from "./read";
import { FileWriteTool } from "./write";
import { NotebookEditTool } from "./notebook-edit";
import { FileStateCache } from "../utils/fileCache";
import { captureFileSnapshots, collectCheckpointPaths, requiresWorkspaceCheckpoint, rewindCheckpoint } from "../utils/file-checkpoints";

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
    await writeFile(filePath, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("const before = 1;\r\n", "utf8"),
    ]));

    const result = await FileEditTool.call(
      { file_path: filePath, old_string: "before", new_string: "after" },
      { cwd: root },
    );

    expect(result.is_error).toBeFalsy();
    expect(await readFile(filePath)).toEqual(Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("const after = 1;\r\n", "utf8"),
    ]));
  });

  test("matches curly quotes without forcing the model back to shell or REPL editing", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const filePath = join(root, "quotes.ts");
    await writeFile(filePath, "const message = “hello”;\n", "utf8");

    const result = await FileEditTool.call(
      { file_path: filePath, old_string: 'const message = "hello";', new_string: 'const message = "updated";' },
      { cwd: root },
    );

    expect(result.is_error).toBeFalsy();
    expect(result._meta?.file).toMatchObject({ normalizedQuotes: true, replacements: 1 });
    expect(await readFile(filePath, "utf8")).toBe('const message = "updated";\n');
  });

  test("edits UTF-16LE files while preserving their BOM", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const filePath = join(root, "file.txt");
    await writeFile(filePath, Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("before\r\n", "utf16le"),
    ]));

    const result = await FileEditTool.call(
      { file_path: filePath, old_string: "before", new_string: "after" },
      { cwd: root },
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
    expect(result._meta?.read).toMatchObject({ totalLines: 2, partial: true });
    expect(String(result.content)).toContain("beta");
  });

  test("treats a windowed read that stopped early as a partial view (#314)", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-file-tools-"));
    roots.push(root);
    const filePath = join(root, "long.txt");
    // 600 padded lines exceed both the default 500-line window and a single
    // stream chunk, so the ranged reader stops early with an unverified count;
    // .txt is not summarized, so Read takes the ranged path.
    await writeFile(
      filePath,
      Array.from({ length: 600 }, (_, i) => `line-${i} ${"x".repeat(150)}`).join("\n"),
      "utf8",
    );
    const cache = new FileStateCache();

    const result = await FileReadTool.call({ file_path: filePath }, { cwd: root, fileStateCache: cache });

    expect(result.is_error).toBeFalsy();
    expect(result._meta?.read).toMatchObject({ partial: true, truncated: true });
    // The stale-read guard must not mistake the window for the whole file.
    expect(cache.get(filePath)?.isPartialView).toBe(true);
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
    expect(JSON.parse(result.content as string)).toEqual({
      type: "notebook",
      file: { filePath, cells: [{ cell_type: "markdown", source: ["# Title\n"] }] },
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
    await writeFile(filePath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("before\r\n", "utf16le")]));

    const result = await FileWriteTool.call({ file_path: filePath, content: "after\n" }, { cwd: root });

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
