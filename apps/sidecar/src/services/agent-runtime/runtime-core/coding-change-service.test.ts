import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  getCodingChangeSet,
  getCodingFileDiff,
  parseUnifiedDiff
} from "./coding-change-service";

const tempDirs: string[] = [];

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
});
