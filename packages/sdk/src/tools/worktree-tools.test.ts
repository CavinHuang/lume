import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagedWorktree, removeManagedWorktree } from "./worktree-tools";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("worktree lifecycle", () => {
  test("creates and removes a managed worktree without shell interpolation", () => {
    const root = mkdtempSync(join(tmpdir(), "lume-worktree-tools-"));
    roots.push(root);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "file.txt"), "initial\n", "utf8");
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Lume Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });

    const worktree = createManagedWorktree({ cwd: root, branch: "lume-test-branch" });
    expect(existsSync(worktree.path)).toBe(true);
    expect(worktree.branch).toBe("lume-test-branch");

    removeManagedWorktree(worktree.id);
    expect(existsSync(worktree.path)).toBe(false);
  });
});
