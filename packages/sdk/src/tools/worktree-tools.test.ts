import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createManagedWorktree, removeManagedWorktree } from "./worktree-tools";

const roots: string[] = [];
let previousConfigDir: string | undefined;

beforeEach(() => {
  previousConfigDir = process.env.LUME_CONFIG_DIR;
  const configRoot = mkdtempSync(join(tmpdir(), "lume-worktree-config-"));
  roots.push(configRoot);
  process.env.LUME_CONFIG_DIR = configRoot;
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (previousConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
  else process.env.LUME_CONFIG_DIR = previousConfigDir;
});

describe("worktree lifecycle", () => {
  test("rejects unsafe branch and in-repository paths", { timeout: 30_000 }, () => {
    const root = mkdtempSync(join(tmpdir(), "lume-worktree-tools-"));
    roots.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Lume Test", "commit", "--allow-empty", "-qm", "initial"], { cwd: root });

    expect(() => createManagedWorktree({ cwd: root, branch: "../escape" })).toThrow("Invalid worktree branch name");
    expect(() => createManagedWorktree({ cwd: root, branch: "lume-inside", path: join(root, "nested") })).toThrow("outside the main repository");
  });

  test("refuses to remove a dirty worktree and leaves its branch intact", { timeout: 30_000 }, () => {
    const root = mkdtempSync(join(tmpdir(), "lume-worktree-tools-"));
    roots.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Lume Test", "commit", "--allow-empty", "-qm", "initial"], { cwd: root });

    const branch = `lume-dirty-${basename(root)}`;
    const worktreePath = join(dirname(root), `.worktree-${branch}`);
    roots.push(worktreePath);
    const worktree = createManagedWorktree({ cwd: root, branch, path: worktreePath });
    writeFileSync(join(worktree.path, "dirty.txt"), "keep me\n", "utf8");
    expect(() => removeManagedWorktree(worktree.id)).toThrow("uncommitted or untracked");
    expect(existsSync(worktree.path)).toBe(true);
    expect(() => execFileSync("git", ["show-ref", "--verify", `refs/heads/${branch}`], { cwd: root })).not.toThrow();
    execFileSync("git", ["clean", "-fd"], { cwd: worktree.path });
    removeManagedWorktree(worktree.id);
    expect(existsSync(worktree.path)).toBe(false);
  });
});
