import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotebookEditTool } from "./notebook-edit.js";

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

describe("NotebookEditTool insert anchoring", () => {
  test("insert with omitted cell_id prepends the new cell at the beginning", async () => {
    const filePath = await makeNotebookFile(["a", "b"]);

    const result = await NotebookEditTool.call(
      { notebook_path: filePath, new_source: "print('hi')", cell_type: "code", edit_mode: "insert" },
      { cwd: roots[0]! },
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

    const result = await NotebookEditTool.call(
      { notebook_path: filePath, new_source: "middle", cell_type: "code", edit_mode: "insert", cell_id: "a" },
      { cwd: roots[0]! },
    );

    expect(result.is_error).toBeFalsy();
    const notebook = JSON.parse(await readFile(filePath, "utf-8"));
    expect(notebook.cells.map((cell: { id?: string }) => cell.id)).toEqual(["a", notebook.cells[1].id, "b"]);
  });

  test("replace and delete keep resolving by cell id", async () => {
    const replacePath = await makeNotebookFile(["a", "b"]);
    const replaced = await NotebookEditTool.call(
      { notebook_path: replacePath, cell_id: "b", new_source: "# replaced", edit_mode: "replace" },
      { cwd: roots[0]! },
    );
    expect(replaced.is_error).toBeFalsy();
    const replacedNotebook = JSON.parse(await readFile(replacePath, "utf-8"));
    expect(replacedNotebook.cells[1].source.join("")).toBe("# replaced");

    const deletePath = await makeNotebookFile(["a", "b"]);
    const deleted = await NotebookEditTool.call(
      { notebook_path: deletePath, cell_id: "a", new_source: "", edit_mode: "delete" },
      { cwd: roots[1]! },
    );
    expect(deleted.is_error).toBeFalsy();
    const deletedNotebook = JSON.parse(await readFile(deletePath, "utf-8"));
    expect(deletedNotebook.cells.map((cell: { id?: string }) => cell.id)).toEqual(["b"]);
  });

  test("result summary does not embed the full original or updated notebook", async () => {
    const filePath = await makeNotebookFile(["a"]);

    const result = await NotebookEditTool.call(
      { notebook_path: filePath, cell_id: "a", new_source: "# next", edit_mode: "replace" },
      { cwd: roots[0]! },
    );

    expect(result.is_error).toBeFalsy();
    const summary = JSON.parse(String(result.content));
    expect(summary.cell_id).toBe("a");
    expect(summary.new_source).toBe("# next");
    expect(summary.notebook_path).toBe(filePath);
    expect(summary).not.toHaveProperty("original_file");
    expect(summary).not.toHaveProperty("updated_file");
  });
});
