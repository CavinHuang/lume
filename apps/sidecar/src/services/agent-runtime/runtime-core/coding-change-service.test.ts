import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  applyCodingDiffAction,
  applyCodingRepositoryPublishAction,
  getCodingBlame,
  getCodingChangeSet,
  getCodingFileOpenTargets,
  getCodingFileDiff,
  getCodingReviewSources,
  getCodingRepositoryPublishState,
  parseUnifiedDiff,
  searchCodingDiffLines,
  searchCodingReview
} from "./coding-change-service";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function createGitWorkspace(root: string, content: string): void {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "index.ts"), content);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "lume@example.test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Lume Test"], { cwd: root });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: root });
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("coding-change-service", () => {
  test("非 Git 工作区回退到 workspace snapshot 基线", async () => {
    const root = makeTempDir("lume-coding-diff-");
    tempDirs.push(root);

    await expect(getCodingChangeSet(root)).resolves.toMatchObject({
      base: "workspace_snapshot",
      isGitRepo: false,
      files: [],
    });
  });

  test("非 Git 工作区 diff 使用受限的 snapshot 预览", async () => {
    const root = makeTempDir("lume-coding-diff-");
    tempDirs.push(root);

    await expect(getCodingFileDiff(root, "src.ts")).resolves.toMatchObject({
      path: "src.ts",
      status: "modified",
      oldContent: "",
    });
  });

  test("非 Git 工作区也拒绝越界路径", async () => {
    const root = makeTempDir("lume-coding-diff-");
    tempDirs.push(root);

    await expect(getCodingChangeSet(root, { paths: ["../outside.ts"] })).resolves.toMatchObject({
      base: "workspace_snapshot",
      files: [],
    });
  });

  test("Git 候选目录应包含目录内的变更文件", async () => {
    const root = makeTempDir("lume-coding-directory-candidate-");
    tempDirs.push(root);
    createGitWorkspace(root, "export const value = 'baseline';\n");
    mkdirSync(join(root, "generated"));
    writeFileSync(join(root, "generated", "output.ts"), "export const output = true;\n");

    const changeSet = await getCodingChangeSet(root, {
      paths: [join(root, "generated")],
    });

    expect(changeSet.files.map((file) => file.path)).toEqual(["generated/output.ts"]);
  }, 20_000);

  test("多根目录用 rootId 区分同名文件并可读取对应 diff", async () => {
    const first = makeTempDir("lume-coding-root-a-");
    const second = makeTempDir("lume-coding-root-b-");
    const snapshot = makeTempDir("lume-coding-root-c-");
    tempDirs.push(first, second, snapshot);
    createGitWorkspace(first, "export const value = 'first';\n");
    createGitWorkspace(second, "export const value = 'second';\n");
    mkdirSync(join(snapshot, "src"), { recursive: true });
    writeFileSync(join(snapshot, "src", "index.ts"), "export const value = 'snapshot';\n");
    writeFileSync(join(first, "src", "index.ts"), "export const value = 'first changed';\n");
    writeFileSync(join(second, "src", "index.ts"), "export const value = 'second changed';\n");
    const canonicalFirst = realpathSync.native(first);
    const canonicalSecond = realpathSync.native(second);
    const canonicalSnapshot = realpathSync.native(snapshot);

    const changeSet = await getCodingChangeSet(canonicalFirst, {
      roots: [canonicalSecond, canonicalSnapshot],
      paths: [
        join(canonicalFirst, "src", "index.ts"),
        join(canonicalSecond, "src", "index.ts"),
        join(canonicalSnapshot, "src", "index.ts"),
      ],
    });

    expect(changeSet.repositories).toHaveLength(3);
    expect(new Set(changeSet.repositories?.map((repository) => repository.rootId)).size).toBe(3);
    expect(changeSet.files).toHaveLength(3);
    expect(new Set(changeSet.files.map((file) => file.rootId)).size).toBe(3);
    expect(changeSet.files.every((file) => file.path === "src/index.ts")).toBe(true);

    const secondRepository = changeSet.repositories?.find((repository) => repository.rootLabel === basename(canonicalSecond));
    expect(secondRepository).toBeDefined();
    const diff = await getCodingFileDiff(canonicalFirst, "src/index.ts", {
      rootId: secondRepository?.rootId,
      roots: [canonicalSecond, canonicalSnapshot],
    });
    expect(diff.rootId).toBe(secondRepository?.rootId);
    if (diff.kind !== "text") throw new Error("expected text diff");
    expect(diff.oldContent).toContain("'second'");
    expect(diff.newContent).toContain("'second changed'");
  }, 60_000);

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

  test("全 Diff 搜索返回路径、左右侧行号并限制结果数", () => {
    const result = searchCodingDiffLines([
      {
        path: "src/needle-file.ts",
        rootId: "root-a",
        lines: [
          { type: "removed", oldLine: 4, text: "const Needle = 'old'" },
          { type: "added", newLine: 7, text: "const needle = 'new'" },
          { type: "context", oldLine: 8, newLine: 8, text: "needle context" },
        ],
      },
    ], "NEEDLE", 3);

    expect(result.truncated).toBe(true);
    expect(result.matches).toEqual([
      expect.objectContaining({
        kind: "path",
        path: "src/needle-file.ts",
        rootId: "root-a",
      }),
      expect.objectContaining({
        kind: "line",
        side: "deletions",
        lineNumber: 4,
        preview: "const Needle = 'old'",
      }),
      expect.objectContaining({
        kind: "line",
        side: "additions",
        lineNumber: 7,
        preview: "const needle = 'new'",
      }),
    ]);
  });

  test("mixed 文件可按 staged 与 unstaged 基线分别审阅和操作", async () => {
    const root = makeTempDir("lume-coding-stage-filter-");
    tempDirs.push(root);
    createGitWorkspace(root, [
      "export const staged = 'before';",
      "export const unstaged = 'before';",
      "",
    ].join("\n"));

    writeFileSync(join(root, "src", "index.ts"), [
      "export const staged = 'after';",
      "export const unstaged = 'before';",
      "",
    ].join("\n"));
    execFileSync("git", ["add", "src/index.ts"], { cwd: root });
    writeFileSync(join(root, "src", "index.ts"), [
      "export const staged = 'after';",
      "export const unstaged = 'after';",
      "",
    ].join("\n"));

    const stagedChanges = await getCodingChangeSet(root, { reviewSource: { kind: "staged" } });
    const unstagedChanges = await getCodingChangeSet(root, { reviewSource: { kind: "unstaged" } });
    expect(stagedChanges.files.map((file) => file.path)).toEqual(["src/index.ts"]);
    expect(unstagedChanges.files.map((file) => file.path)).toEqual(["src/index.ts"]);

    const staged = await getCodingFileDiff(root, "src/index.ts", { reviewSource: { kind: "staged" } });
    const unstaged = await getCodingFileDiff(root, "src/index.ts", { reviewSource: { kind: "unstaged" } });
    if (staged.kind !== "text" || unstaged.kind !== "text") throw new Error("expected text diffs");
    expect(staged.oldContent).toContain("staged = 'before'");
    expect(staged.newContent).toContain("staged = 'after'");
    expect(staged.newContent).toContain("unstaged = 'before'");
    expect(unstaged.oldContent).toContain("staged = 'after'");
    expect(unstaged.oldContent).toContain("unstaged = 'before'");
    expect(unstaged.newContent).toContain("unstaged = 'after'");
    expect(staged.diffHash).not.toBe(unstaged.diffHash);

    const stagedSearch = await searchCodingReview(root, {
      files: [{ path: "src/index.ts" }],
      query: "unstaged = 'after'",
      reviewSource: { kind: "staged" },
    });
    const unstagedSearch = await searchCodingReview(root, {
      files: [{ path: "src/index.ts" }],
      query: "unstaged = 'after'",
      reviewSource: { kind: "unstaged" },
    });
    expect(stagedSearch.matches).toEqual([]);
    expect(unstagedSearch.matches).toContainEqual(expect.objectContaining({
      kind: "line",
      side: "additions",
      lineNumber: 2,
    }));

    await applyCodingDiffAction(root, {
      threadId: "thread-test",
      path: "src/index.ts",
      scope: "hunk",
      hunkIndex: 0,
      stageFilter: "unstaged",
      action: "stage",
      expectedDiffHash: unstaged.diffHash,
    });
    expect(execFileSync("git", ["diff", "--name-only"], { cwd: root, encoding: "utf8" }).trim()).toBe("");
    expect(execFileSync("git", ["diff", "--cached", "--numstat"], { cwd: root, encoding: "utf8" }).trim())
      .toBe("2\t2\tsrc/index.ts");
  }, 30_000);

  test("Branch 与 Committed 来源使用各自稳定的 Git 基线", async () => {
    const root = makeTempDir("lume-coding-review-source-");
    tempDirs.push(root);
    createGitWorkspace(root, "export const value = 'baseline';\n");
    execFileSync("git", ["branch", "review-base"], { cwd: root });

    writeFileSync(join(root, "src", "index.ts"), "export const value = 'committed';\n");
    execFileSync("git", ["add", "src/index.ts"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "committed change"], { cwd: root });
    const commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    writeFileSync(join(root, "src", "index.ts"), "export const value = 'worktree';\n");

    const sources = await getCodingReviewSources(root);
    expect(sources.available).toBe(true);
    expect(sources.branches).toContain("review-base");
    expect(sources.commits.some((commit) => commit.sha === commitSha && commit.subject === "committed change")).toBe(true);

    const branch = await getCodingFileDiff(root, "src/index.ts", {
      reviewSource: { kind: "branch", baseRef: "review-base" },
    });
    const committed = await getCodingFileDiff(root, "src/index.ts", {
      reviewSource: { kind: "commit", commitSha },
    });
    if (branch.kind !== "text" || committed.kind !== "text") throw new Error("expected text diffs");
    expect(branch.oldContent).toContain("'baseline'");
    expect(branch.newContent).toContain("'worktree'");
    expect(branch.actions.canStage).toBe(false);
    expect(committed.oldContent).toContain("'baseline'");
    expect(committed.newContent).toContain("'committed'");
    expect(committed.newContent).not.toContain("'worktree'");
    expect(committed.actions.canStage).toBe(false);

    const branchSearch = await searchCodingReview(root, {
      files: [{ path: "src/index.ts" }],
      query: "worktree",
      reviewSource: { kind: "branch", baseRef: "review-base" },
    });
    const committedSearch = await searchCodingReview(root, {
      files: [{ path: "src/index.ts" }],
      query: "committed",
      reviewSource: { kind: "commit", commitSha },
    });
    expect(branchSearch.matches).toContainEqual(expect.objectContaining({
      kind: "line",
      side: "additions",
      lineNumber: 1,
    }));
    expect(committedSearch.matches).toContainEqual(expect.objectContaining({
      kind: "line",
      side: "additions",
      lineNumber: 1,
    }));
    expect(committedSearch.matches.some((match) => match.preview.includes("worktree"))).toBe(false);
  }, 30_000);

  test("文件级 Stage 与 Unstage 受当前 diff hash 保护", async () => {
    const root = makeTempDir("lume-coding-action-");
    tempDirs.push(root);
    createGitWorkspace(root, "export const value = 'before';\n");
    writeFileSync(join(root, "src", "index.ts"), "export const value = 'after';\n");

    const unstaged = await getCodingFileDiff(root, "src/index.ts");
    if (unstaged.kind !== "text") throw new Error("expected text diff");
    await applyCodingDiffAction(root, {
      threadId: "thread-test",
      path: "src/index.ts",
      scope: "file",
      action: "stage",
      expectedDiffHash: unstaged.diffHash,
    });
    expect(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: root, encoding: "utf8" }).trim())
      .toBe("src/index.ts");

    await expect(applyCodingDiffAction(root, {
      threadId: "thread-test",
      path: "src/index.ts",
      scope: "file",
      action: "unstage",
      expectedDiffHash: unstaged.diffHash,
    })).rejects.toThrow("刷新 Diff");

    const staged = await getCodingFileDiff(root, "src/index.ts");
    if (staged.kind !== "text") throw new Error("expected text diff");
    await applyCodingDiffAction(root, {
      threadId: "thread-test",
      path: "src/index.ts",
      scope: "file",
      action: "unstage",
      expectedDiffHash: staged.diffHash,
    });
    expect(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: root, encoding: "utf8" }).trim())
      .toBe("");
  }, 30_000);

  test("分区级 Stage 与 Unstage 在单次 Git 操作中处理全部文件", async () => {
    const root = makeTempDir("lume-coding-section-");
    tempDirs.push(root);
    createGitWorkspace(root, "export const first = 'before';\n");
    writeFileSync(join(root, "src", "second.ts"), "export const second = 'before';\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "add second"], { cwd: root });
    writeFileSync(join(root, "src", "index.ts"), "export const first = 'after';\n");
    writeFileSync(join(root, "src", "second.ts"), "export const second = 'after';\n");

    const unstaged = await Promise.all([
      getCodingFileDiff(root, "src/index.ts"),
      getCodingFileDiff(root, "src/second.ts"),
    ]);
    await applyCodingDiffAction(root, {
      threadId: "thread-test",
      scope: "section",
      action: "stage",
      files: unstaged.map((file) => ({ path: file.path, expectedDiffHash: file.diffHash })),
    });
    expect(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: root, encoding: "utf8" }).trim().split(/\r?\n/).sort())
      .toEqual(["src/index.ts", "src/second.ts"]);

    const staged = await Promise.all([
      getCodingFileDiff(root, "src/index.ts"),
      getCodingFileDiff(root, "src/second.ts"),
    ]);
    await applyCodingDiffAction(root, {
      threadId: "thread-test",
      scope: "section",
      action: "unstage",
      files: staged.map((file) => ({ path: file.path, expectedDiffHash: file.diffHash })),
    });
    expect(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: root, encoding: "utf8" }).trim())
      .toBe("");
  }, 30_000);

  test("分区级操作在任一文件 hash 过期时不修改 index", async () => {
    const root = makeTempDir("lume-coding-section-stale-");
    tempDirs.push(root);
    createGitWorkspace(root, "export const first = 'before';\n");
    writeFileSync(join(root, "src", "second.ts"), "export const second = 'before';\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "add second"], { cwd: root });
    writeFileSync(join(root, "src", "index.ts"), "export const first = 'after';\n");
    writeFileSync(join(root, "src", "second.ts"), "export const second = 'after';\n");
    const diffs = await Promise.all([
      getCodingFileDiff(root, "src/index.ts"),
      getCodingFileDiff(root, "src/second.ts"),
    ]);
    writeFileSync(join(root, "src", "second.ts"), "export const second = 'newer';\n");

    await expect(applyCodingDiffAction(root, {
      threadId: "thread-test",
      scope: "section",
      action: "stage",
      files: diffs.map((file) => ({ path: file.path, expectedDiffHash: file.diffHash })),
    })).rejects.toThrow("刷新 Diff");
    expect(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: root, encoding: "utf8" }).trim())
      .toBe("");
  }, 30_000);

  test("blame 标记未提交行并从远程地址生成 commit 链接", async () => {
    const root = makeTempDir("lume-coding-blame-");
    tempDirs.push(root);
    createGitWorkspace(root, "export const first = 1;\nexport const second = 2;\n");
    execFileSync("git", ["remote", "add", "origin", "git@github.com:example/lume.git"], { cwd: root });
    writeFileSync(join(root, "src", "index.ts"), "export const first = 1;\nexport const second = 3;\n");

    const result = await getCodingBlame(root, "src/index.ts");
    expect(result.available).toBe(true);
    expect(result.lines[0]?.committed).toBe(true);
    expect(result.lines[0]?.commitUrl).toContain("https://github.com/example/lume/commit/");
    expect(result.lines[1]).toMatchObject({ committed: false });
  }, 30_000);

  test("文件打开目标返回安全本地路径和固定到 HEAD 的 GitHub 链接", async () => {
    const root = makeTempDir("lume-coding-open-target-");
    tempDirs.push(root);
    createGitWorkspace(root, "export const value = 1;\n");
    execFileSync("git", ["remote", "add", "origin", "git@github.com:example/lume.git"], { cwd: root });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

    await expect(getCodingFileOpenTargets(root, "src/index.ts")).resolves.toEqual({
      absolutePath: realpathSync.native(join(root, "src", "index.ts")),
      remoteFileUrl: `https://github.com/example/lume/blob/${head}/src/index.ts`,
      remoteProvider: "github",
      revision: head,
    });

    rmSync(join(root, "src", "index.ts"));
    await expect(getCodingFileOpenTargets(root, "src/index.ts")).resolves.toEqual({
      remoteFileUrl: `https://github.com/example/lume/blob/${head}/src/index.ts`,
      remoteProvider: "github",
      revision: head,
    });
  }, 30_000);

  test("文件打开目标拒绝越界路径", async () => {
    const root = makeTempDir("lume-coding-open-target-safe-");
    tempDirs.push(root);
    createGitWorkspace(root, "export const value = 1;\n");

    await expect(getCodingFileOpenTargets(root, "../outside.ts")).rejects.toThrow("超出项目目录");
  }, 30_000);

  test("仅提交已暂存内容并将当前分支推送到 upstream", async () => {
    const root = makeTempDir("lume-coding-publish-");
    const remote = makeTempDir("lume-coding-publish-remote-");
    tempDirs.push(root, remote);
    execFileSync("git", ["init", "--bare", "-q"], { cwd: remote });
    createGitWorkspace(root, "export const value = 'before';\n");
    const branch = execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim();
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: root });
    execFileSync("git", ["push", "-qu", "origin", branch], { cwd: root });
    writeFileSync(join(root, "src", "index.ts"), "export const value = 'after';\n");

    await expect(getCodingRepositoryPublishState(root)).resolves.toMatchObject({
      available: true,
      stagedCount: 0,
      unstagedCount: 1,
      canCommit: false,
    });

    execFileSync("git", ["add", "--", "src/index.ts"], { cwd: root });
    const state = await getCodingRepositoryPublishState(root);
    if (!state.available) throw new Error(state.reason);
    const result = await applyCodingRepositoryPublishAction(root, {
      threadId: "thread-test",
      action: "commit_and_push",
      message: "test: publish staged change",
      expectedBranch: state.branch,
      expectedHead: state.head,
      expectedIndexHash: state.indexHash,
    });

    expect(result.pushCompleted).toBe(true);
    expect(result.commitHash).toBeTruthy();
    expect(execFileSync("git", [`--git-dir=${remote}`, "show", `${branch}:src/index.ts`], { encoding: "utf8" }))
      .toContain("'after'");
  }, 30_000);

  test("显式选择后可提交未暂存和未跟踪变更", async () => {
    const root = makeTempDir("lume-coding-publish-all-");
    tempDirs.push(root);
    createGitWorkspace(root, "export const value = 'before';\n");
    writeFileSync(join(root, "src", "index.ts"), "export const value = 'after';\n");
    writeFileSync(join(root, "src", "new.ts"), "export const added = true;\n");

    const state = await getCodingRepositoryPublishState(root);
    if (!state.available) throw new Error(state.reason);
    expect(state).toMatchObject({
      stagedCount: 0,
      unstagedCount: 1,
      untrackedCount: 1,
      canCommit: false,
    });

    const result = await applyCodingRepositoryPublishAction(root, {
      threadId: "thread-test",
      action: "commit",
      message: "test: include worktree changes",
      expectedBranch: state.branch,
      expectedHead: state.head,
      expectedIndexHash: state.indexHash,
      includeUnstagedChanges: true,
      expectedWorktreeHash: state.worktreeHash,
    });

    expect(result.commitHash).toBeTruthy();
    expect(execFileSync("git", ["show", "HEAD:src/index.ts"], { cwd: root, encoding: "utf8" })).toContain("'after'");
    expect(execFileSync("git", ["show", "HEAD:src/new.ts"], { cwd: root, encoding: "utf8" })).toContain("added = true");
  }, 30_000);

  test("包含未暂存变更时受工作区指纹保护", async () => {
    const root = makeTempDir("lume-coding-publish-worktree-stale-");
    tempDirs.push(root);
    createGitWorkspace(root, "export const value = 'before';\n");
    writeFileSync(join(root, "src", "index.ts"), "export const value = 'after';\n");
    const state = await getCodingRepositoryPublishState(root);
    if (!state.available) throw new Error(state.reason);
    writeFileSync(join(root, "src", "index.ts"), "export const value = 'newer';\n");

    await expect(applyCodingRepositoryPublishAction(root, {
      threadId: "thread-test",
      action: "commit",
      message: "test: stale worktree",
      expectedBranch: state.branch,
      expectedHead: state.head,
      expectedIndexHash: state.indexHash,
      includeUnstagedChanges: true,
      expectedWorktreeHash: state.worktreeHash,
    })).rejects.toThrow("工作区已变化");
    expect(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).trim()).toBe("1");
  }, 30_000);

  test("提交在暂存区指纹过期时不创建 commit", async () => {
    const root = makeTempDir("lume-coding-publish-stale-");
    tempDirs.push(root);
    createGitWorkspace(root, "export const value = 'before';\n");
    writeFileSync(join(root, "src", "index.ts"), "export const value = 'after';\n");
    execFileSync("git", ["add", "--", "src/index.ts"], { cwd: root });
    const state = await getCodingRepositoryPublishState(root);
    if (!state.available) throw new Error(state.reason);
    writeFileSync(join(root, "src", "index.ts"), "export const value = 'newer';\n");
    execFileSync("git", ["add", "--", "src/index.ts"], { cwd: root });

    await expect(applyCodingRepositoryPublishAction(root, {
      threadId: "thread-test",
      action: "commit",
      message: "test: stale commit",
      expectedBranch: state.branch,
      expectedHead: state.head,
      expectedIndexHash: state.indexHash,
    })).rejects.toThrow("暂存区已变化");
    expect(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).trim()).toBe("1");
  }, 30_000);

  test("staged 大二进制产物使 git 输出超限时 Publish 状态降级为不可用而非全量累积", async () => {
    const root = makeTempDir("lume-coding-publish-big-binary-");
    tempDirs.push(root);
    createGitWorkspace(root, "export const value = 'before';\n");
    mkdirSync(join(root, "assets"), { recursive: true });
    // 不可压缩随机数据：--binary 的 zlib 压不动，base85 编码后 diff 输出必然超 16MB 水位
    writeFileSync(join(root, "assets", "bundle.bin"), randomBytes(17 * 1024 * 1024));
    execFileSync("git", ["add", "assets/bundle.bin"], { cwd: root });

    await expect(getCodingRepositoryPublishState(root)).resolves.toMatchObject({
      available: false,
      reason: "无法读取当前 Git 仓库状态",
    });
  }, 30_000);
});
