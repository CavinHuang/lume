import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    expect(summary.notebook_path).toBe(filePath);
    expect(summary).not.toHaveProperty("original_file");
    expect(summary).not.toHaveProperty("updated_file");
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
