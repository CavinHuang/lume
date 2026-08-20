import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT_PATH = resolve(import.meta.dir, "scripts", "comment.py");

// 与 OfficeToolExecutor.runPython 的候选顺序保持一致
const PYTHON_CANDIDATES = ["python3", "python3.11", "python"];

function detectPython(): string | null {
  for (const candidate of PYTHON_CANDIDATES) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf-8" });
    if (probe.status === 0) return candidate;
  }
  return null;
}

const PYTHON_BIN = detectPython();

function writeFixtureCommentsXml(root: string): void {
  // comment.py 会写 word/_rels/comments.xml.rels，目录结构对齐 office_unpack 产物
  mkdirSync(join(root, "word", "_rels"), { recursive: true });
  writeFileSync(
    join(root, "word", "comments.xml"),
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:comments>',
    "utf-8"
  );
}

function runCommentPy(root: string, commentId: number, text: string, author: string): string {
  const result = spawnSync(
    PYTHON_BIN!,
    [SCRIPT_PATH, root, String(commentId), text, author, ""],
    { encoding: "utf-8" }
  );
  expect(result.status).toBe(0);
  return readFileSync(join(root, "word", "comments.xml"), "utf-8");
}

describe.skipIf(!PYTHON_BIN)("comment.py XML 转义", () => {
  test("批注文本与作者中的 XML 特殊字符被正确转义", () => {
    const root = join(tmpdir(), `lume-comment-py-${crypto.randomUUID()}`);
    try {
      writeFixtureCommentsXml(root);
      const body = runCommentPy(root, 3, 'a<b>&"c"', 'Author "Who" & <Co>');
      expect(body).toContain('<w:t>a&lt;b&gt;&amp;&quot;c&quot;</w:t>');
      expect(body).toContain('w:author="Author &quot;Who&quot; &amp; &lt;Co&gt;"');
      // 产物整体仍是可解析 XML
      expect(body.trim().startsWith("<?xml")).toBe(true);
      expect(body).toContain("</w:comments>");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("普通文本不受转义影响", () => {
    const root = join(tmpdir(), `lume-comment-py-${crypto.randomUUID()}`);
    try {
      writeFixtureCommentsXml(root);
      const body = runCommentPy(root, 1, "普通批注内容", "Assistant");
      expect(body).toContain("<w:t>普通批注内容</w:t>");
      expect(body).toContain('w:author="Assistant"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
