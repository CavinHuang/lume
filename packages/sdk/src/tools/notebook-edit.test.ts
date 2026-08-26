import { afterEach, describe, expect, test } from "bun:test";
<<<<<<< HEAD
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
=======
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
>>>>>>> upstream/main
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NotebookEditTool } from "./notebook-edit.js";
import { FileReadTool } from "./read.js";
import { FileStateCache } from "../utils/fileCache.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function makeNotebook(cellIds: string[]): string {
  return JSON.stringify({
    cells: cellIds.map((id) => ({
      id,
      cell_type: "code",
      source: `# ${id}`,
      metadata: {},
      outputs: [],
      execution_count: null,
    })),
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  });
}

async function makeNotebookFile(cellIds: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lume-notebook-"));
  roots.push(root);
  const filePath = join(root, "book.ipynb");
  await writeFile(filePath, makeNotebook(cellIds), "utf-8");
  return filePath;
}

/** 未读防护（#569）生效后，编辑前必须先 Read 建立记录。 */
async function readFirst(filePath: string): Promise<FileStateCache> {
  const cache = new FileStateCache();
  await FileReadTool.call({ file_path: filePath }, { cwd: dirname(filePath), fileStateCache: cache });
  return cache;
}

describe("NotebookEditTool insert anchoring", () => {
  test("insert with omitted cell_id prepends the new cell at the beginning", async () => {
    const filePath = await makeNotebookFile(["a", "b"]);
    const cache = await readFirst(filePath);

    const result = await NotebookEditTool.call(
      { notebook_path: filePath, new_source: "print('hi')", cell_type: "code", edit_mode: "insert" },
      { cwd: dirname(filePath), fileStateCache: cache },
    );

    expect(result.is_error).toBeFalsy();
    const notebook = JSON.parse(await readFile(filePath, "utf-8"));
    expect(notebook.cells).toHaveLength(3);
    expect(notebook.cells[0].source.join("")).toBe("print('hi')");
    expect(notebook.cells[1].id).toBe("a");
    expect(notebook.cells[2].id).toBe("b");
  });

  test("insert with an explicit cell_id still inserts after that cell", async () => {
    const filePath = await makeNotebookFile(["a", "b"]);
    const cache = await readFirst(filePath);

    const result = await NotebookEditTool.call(
      { notebook_path: filePath, new_source: "middle", cell_type: "code", edit_mode: "insert", cell_id: "a" },
      { cwd: dirname(filePath), fileStateCache: cache },
    );

    expect(result.is_error).toBeFalsy();
    const notebook = JSON.parse(await readFile(filePath, "utf-8"));
    expect(notebook.cells.map((cell: { id?: string }) => cell.id)).toEqual(["a", notebook.cells[1].id, "b"]);
  });

  test("replace and delete keep resolving by cell id", async () => {
    const replacePath = await makeNotebookFile(["a", "b"]);
    const replaceCache = await readFirst(replacePath);
    const replaced = await NotebookEditTool.call(
      { notebook_path: replacePath, cell_id: "b", new_source: "# replaced", edit_mode: "replace" },
      { cwd: dirname(replacePath), fileStateCache: replaceCache },
    );
    expect(replaced.is_error).toBeFalsy();
    const replacedNotebook = JSON.parse(await readFile(replacePath, "utf-8"));
    expect(replacedNotebook.cells[1].source.join("")).toBe("# replaced");

    const deletePath = await makeNotebookFile(["a", "b"]);
    const deleteCache = await readFirst(deletePath);
    const deleted = await NotebookEditTool.call(
      { notebook_path: deletePath, cell_id: "a", new_source: "", edit_mode: "delete" },
      { cwd: roots[1]!, fileStateCache: deleteCache },
    );
    expect(deleted.is_error).toBeFalsy();
    const deletedNotebook = JSON.parse(await readFile(deletePath, "utf-8"));
    expect(deletedNotebook.cells.map((cell: { id?: string }) => cell.id)).toEqual(["b"]);
  });

  test("result summary does not embed the full original or updated notebook", async () => {
    const filePath = await makeNotebookFile(["a"]);
    const cache = await readFirst(filePath);

    const result = await NotebookEditTool.call(
      { notebook_path: filePath, cell_id: "a", new_source: "# next", edit_mode: "replace" },
      { cwd: dirname(filePath), fileStateCache: cache },
    );

    expect(result.is_error).toBeFalsy();
    const summary = JSON.parse(String(result.content));
    expect(summary.cell_id).toBe("a");
    expect(summary.new_source).toBe("# next");
<<<<<<< HEAD
    // #728：notebook_path 回显走 realpath 权威口径（与 read 缓存键同侧），macOS
    // tmpdir 的 /var→/private/var symlink 前缀下断言须对齐 canonical 值
=======
    // 缓存键与 Read 同口径后(#663),summary 回显 realpath 规范化路径
    // (macOS tmpdir 的 /var → /private/var);无 symlink 时与输入逐字相等。
>>>>>>> upstream/main
    expect(summary.notebook_path).toBe(realpathSync(filePath));
    expect(summary).not.toHaveProperty("original_file");
    expect(summary).not.toHaveProperty("updated_file");
  });

  test("rejects editing a partially-read notebook whose mtime or size changed after the read (#663)", async () => {
    // partial view 缓存内容≠全文,内容比对不可用;mtime+size 双要素是仅有的
    // 新鲜度底线(与 edit.ts changedSinceRead 同口径)。钉住这条新增拒绝路径,
    // 防止重构静默退回零校验放行。
    const root = await mkdtemp(join(tmpdir(), "lume-notebook-partial-"));
    roots.push(root);
    const filePath = join(root, "book.ipynb");
    const notebook = makeNotebook(["a", "b", "c"]);
    await writeFile(filePath, notebook, "utf-8");

    const cache = new FileStateCache();
    // 范围读(offset=1)产生 partial view
    await FileReadTool.call({ file_path: filePath, offset: 1, limit: 1 }, { cwd: root, fileStateCache: cache });
    const readState = cache.get(realpathSync(filePath))!;
    expect(readState?.isPartialView).toBe(true);
    if (!readState) return;

    // mtime 变化(size 不变)→ 拒绝
    const bumped = new Date(Date.now() + 5_000);
    await utimes(filePath, bumped, bumped);
    const mtimeResult = await NotebookEditTool.call(
      { notebook_path: filePath, cell_id: "a", new_source: "# tampered", edit_mode: "replace" },
      { cwd: root, fileStateCache: cache },
    );
    expect(mtimeResult.is_error).toBe(true);
    expect(mtimeResult.content).toContain("modified since it was read");

    // size 变化(mtime 钉回原值模拟粗粒度时间戳碰撞)→ 同样拒绝
    await writeFile(filePath, `${notebook}\n`, "utf-8");
    await utimes(filePath, new Date(readState.timestamp), new Date(readState.timestamp));
    const sizeResult = await NotebookEditTool.call(
      { notebook_path: filePath, cell_id: "a", new_source: "# tampered", edit_mode: "replace" },
      { cwd: root, fileStateCache: cache },
    );
    expect(sizeResult.is_error).toBe(true);
    expect(sizeResult.content).toContain("modified since it was read");
  });

  test("rejects editing a notebook that was never read (#569)", async () => {
    const filePath = await makeNotebookFile(["a"]);

    const result = await NotebookEditTool.call(
      { notebook_path: filePath, cell_id: "a", new_source: "# next", edit_mode: "replace" },
      { cwd: dirname(filePath) },
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("has not been read");
    expect(result._meta?.file).toMatchObject({ conflict: "not_read" });
  });
});
