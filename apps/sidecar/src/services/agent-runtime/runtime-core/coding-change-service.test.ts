import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  getCodingChangeSet,
  getCodingFileDiff,
  parseUnifiedDiff
} from "./coding-change-service";

const tempDirs: string[] = [];

function createGitWorkspace(root: string, content: string): void {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "index.ts"), content);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "lume@example.test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Lume Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: root });
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("coding-change-service", () => {
  test("非 Git 工作区回退到 workspace snapshot 基线", async () => {
    const root = mkdtempSync(join(process.env.TEMP ?? process.env.TMP ?? ".", "lume-coding-diff-"));
    tempDirs.push(root);

    await expect(getCodingChangeSet(root)).resolves.toMatchObject({
      base: "workspace_snapshot",
      isGitRepo: false,
      files: [],
    });
  });

  test("非 Git 工作区 diff 使用受限的 snapshot 预览", async () => {
    const root = mkdtempSync(join(process.env.TEMP ?? process.env.TMP ?? ".", "lume-coding-diff-"));
    tempDirs.push(root);

    await expect(getCodingFileDiff(root, "src.ts")).resolves.toMatchObject({
      path: "src.ts",
      status: "modified",
      oldContent: "",
    });
  });

  test("非 Git 工作区也拒绝越界路径", async () => {
    const root = mkdtempSync(join(process.env.TEMP ?? process.env.TMP ?? ".", "lume-coding-diff-"));
    tempDirs.push(root);

    await expect(getCodingChangeSet(root, { paths: ["../outside.ts"] })).resolves.toMatchObject({
      base: "workspace_snapshot",
      files: [],
    });
  });

  test("多根目录用 rootId 区分同名文件并可读取对应 diff", async () => {
    const first = mkdtempSync(join(process.env.TEMP ?? process.env.TMP ?? ".", "lume-coding-root-a-"));
    const second = mkdtempSync(join(process.env.TEMP ?? process.env.TMP ?? ".", "lume-coding-root-b-"));
    const snapshot = mkdtempSync(join(process.env.TEMP ?? process.env.TMP ?? ".", "lume-coding-root-c-"));
    tempDirs.push(first, second, snapshot);
    createGitWorkspace(first, "export const value = 'first';\n");
    createGitWorkspace(second, "export const value = 'second';\n");
    mkdirSync(join(snapshot, "src"), { recursive: true });
    writeFileSync(join(snapshot, "src", "index.ts"), "export const value = 'snapshot';\n");
    writeFileSync(join(first, "src", "index.ts"), "export const value = 'first changed';\n");
    writeFileSync(join(second, "src", "index.ts"), "export const value = 'second changed';\n");

    const changeSet = await getCodingChangeSet(first, {
      roots: [second, snapshot],
      paths: [
        join(first, "src", "index.ts"),
        join(second, "src", "index.ts"),
        join(snapshot, "src", "index.ts"),
      ],
    });

    expect(changeSet.repositories).toHaveLength(3);
    expect(new Set(changeSet.repositories?.map((repository) => repository.rootId)).size).toBe(3);
    expect(changeSet.files).toHaveLength(3);
    expect(new Set(changeSet.files.map((file) => file.rootId)).size).toBe(3);
    expect(changeSet.files.every((file) => file.path === "src/index.ts")).toBe(true);

    const secondRepository = changeSet.repositories?.find((repository) => repository.rootLabel === basename(second));
    expect(secondRepository).toBeDefined();
    const diff = await getCodingFileDiff(first, "src/index.ts", {
      rootId: secondRepository?.rootId,
      roots: [second, snapshot],
    });
    expect(diff.rootId).toBe(secondRepository?.rootId);
    expect(diff.oldContent).toContain("'second'");
    expect(diff.newContent).toContain("'second changed'");
  }, 20_000);

  test("解析 Git unified diff 的行号和变更类型", () => {
    expect(parseUnifiedDiff([
      "diff --git a/src.ts b/src.ts",
      "@@ -2,3 +2,4 @@ function run() {",
      " keep();",
      "-old();",
      "+new();",
      "+extra();",
      " return true;",
      "",
    ].join("\n"))).toEqual([
      { type: "context", oldLine: 2, newLine: 2, text: "keep();" },
      { type: "removed", oldLine: 3, text: "old();" },
      { type: "added", newLine: 3, text: "new();" },
      { type: "added", newLine: 4, text: "extra();" },
      { type: "context", oldLine: 4, newLine: 5, text: "return true;" },
    ]);
  });

  test("保留 unified diff 中的空白新增行和上下文行", () => {
    const lines = parseUnifiedDiff("@@ -1,2 +1,3 @@\n const value = 1\n+\n+const next = 2\n");
    expect(lines).toEqual([
      { type: "context", oldLine: 1, newLine: 1, text: "const value = 1" },
      { type: "added", newLine: 2, text: "" },
      { type: "added", newLine: 3, text: "const next = 2" },
    ]);
  });
});
