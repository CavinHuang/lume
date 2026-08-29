import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createAgentWorkspace } from "./agent-workspace-manager";
import { createAgentThread } from "./agent-thread-manager";
import { resolveAgentThreadWorkdir } from "./agent-workdir-resolver";
import {
  getMainRepoRoot,
  getValidThreadWorktree,
  listWorktrees,
  setThreadWorktree
} from "./agent-worktree-service";
import { resetPlanningTodoStoreForTests } from "../planning/planning-todo-store";

const roots: string[] = [];
let previousConfigDir: string | undefined;
let configDir = "";

beforeEach(() => {
  previousConfigDir = process.env.LUME_CONFIG_DIR;
  configDir = mkdtempSync(join(tmpdir(), "lume-agent-worktree-"));
  process.env.LUME_CONFIG_DIR = configDir;
});

afterEach(() => {
  resetPlanningTodoStoreForTests();
  if (previousConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
  else process.env.LUME_CONFIG_DIR = previousConfigDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function canonical(path: string): string {
  const real = realpathSync(path);
  return process.platform === "win32" ? real.toLowerCase() : real;
}

function initRepo(name: string): string {
  const repo = join(configDir, "projects", name);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=Lume Test", "commit", "--allow-empty", "-qm", "initial"],
    { cwd: repo }
  );
  return repo;
}

function addLinkedWorktree(repo: string, branch: string): string {
  const worktreePath = join(dirname(repo), `.worktree-${branch}`);
  roots.push(worktreePath);
  execFileSync("git", ["worktree", "add", "-b", branch, worktreePath], { cwd: repo });
  return worktreePath;
}

describe("agent-worktree-service", () => {
  test("非 git 路径返回空列表与 null 主仓库根", async () => {
    const plain = mkdtempSync(join(tmpdir(), "lume-agent-worktree-plain-"));
    roots.push(plain);
    expect(await listWorktrees(plain)).toEqual([]);
    expect(await getMainRepoRoot(plain)).toBeNull();
  });

  test("枚举主仓库与 linked worktree 并以主仓库根判定 isMain", async () => {
    const repo = initRepo("repo");
    const worktreePath = addLinkedWorktree(repo, `feature-${basename(configDir)}`);
    const repoKey = canonical(repo);

    const worktrees = await listWorktrees(repo);
    expect(worktrees).toHaveLength(2);

    const main = worktrees.find((worktree) => worktree.isMain);
    const linked = worktrees.find((worktree) => !worktree.isMain);
    expect(main && canonical(main.path)).toBe(repoKey);
    expect(linked && canonical(linked.path)).toBe(canonical(worktreePath));
    expect(linked?.branch).toBe(`feature-${basename(configDir)}`);
    expect(linked?.head).toMatch(/^[0-9a-f]{7}$/);
    expect(linked?.name).toBe(basename(worktreePath));

    expect(canonical((await getMainRepoRoot(worktreePath))!)).toBe(repoKey);
    expect(canonical((await getMainRepoRoot(repo))!)).toBe(repoKey);
  });

  test("目录被删除的 worktree 不再出现在列表", async () => {
    const repo = initRepo("stale");
    const worktreePath = addLinkedWorktree(repo, "gone-branch");
    const worktreeKey = canonical(worktreePath);
    rmSync(worktreePath, { recursive: true, force: true });

    const worktrees = await listWorktrees(repo);
    expect(worktrees.some((worktree) => canonical(worktree.path) === worktreeKey)).toBeFalse();
  });

  test("getValidThreadWorktree 校验目录存在与主仓库根匹配", async () => {
    const repo = initRepo("valid");
    const worktreePath = addLinkedWorktree(repo, "valid-branch");
    const mainRepoRoot = await getMainRepoRoot(worktreePath);
    expect(mainRepoRoot).not.toBeNull();

    expect(
      await getValidThreadWorktree({
        activeWorktree: { path: worktreePath, mainRepoRoot: mainRepoRoot!, branch: "valid-branch", selectedAt: 1 }
      })
    ).toBeDefined();

    expect(
      await getValidThreadWorktree({
        activeWorktree: { path: join(configDir, "missing"), mainRepoRoot: mainRepoRoot!, branch: "x", selectedAt: 1 }
      })
    ).toBeUndefined();

    expect(
      await getValidThreadWorktree({
        activeWorktree: { path: worktreePath, mainRepoRoot: join(configDir, "other-repo"), branch: "x", selectedAt: 1 }
      })
    ).toBeUndefined();

    expect(await getValidThreadWorktree({})).toBeUndefined();
  });

  test("setThreadWorktree 绑定后 resolver 落到 worktree，解绑回到项目根", async () => {
    const repo = initRepo("bind");
    const worktreePath = addLinkedWorktree(repo, "bind-branch");
    roots.push(worktreePath);
    const workspace = createAgentWorkspace("bind-project", { projectPath: repo });
    const thread = createAgentThread("bind thread", undefined, workspace.id);

    const bound = await setThreadWorktree({ threadId: thread.id, worktreePath });
    expect(bound.activeWorktree && canonical(bound.activeWorktree.path)).toBe(canonical(worktreePath));
    expect(bound.activeWorktree?.branch).toBe("bind-branch");
    expect(bound.activeWorktree && canonical(bound.activeWorktree.mainRepoRoot)).toBe(canonical(repo));

    const workdir = resolveAgentThreadWorkdir(thread.id);
    expect(canonical(workdir.agentCwd)).toBe(canonical(worktreePath));
    expect(canonical(workdir.projectRoot!)).toBe(canonical(worktreePath));

    const unbound = await setThreadWorktree({ threadId: thread.id, worktreePath: null });
    expect(unbound.activeWorktree).toBeUndefined();
    const restored = resolveAgentThreadWorkdir(thread.id);
    expect(canonical(restored.agentCwd)).toBe(canonical(repo));
  });

  test("setThreadWorktree 拒绝主 worktree 与项目外路径", async () => {
    const repo = initRepo("reject");
    const otherRepo = initRepo("other");
    const worktreePath = addLinkedWorktree(otherRepo, "other-branch");
    roots.push(worktreePath);
    const workspace = createAgentWorkspace("reject-project", { projectPath: repo });
    const thread = createAgentThread("reject thread", undefined, workspace.id);

    await expect(setThreadWorktree({ threadId: thread.id, worktreePath: repo })).rejects.toThrow(
      "指定目录不是该项目的 linked worktree"
    );
    await expect(setThreadWorktree({ threadId: thread.id, worktreePath })).rejects.toThrow(
      "指定目录不是该项目的 linked worktree"
    );
  });

  test("绑定的 worktree 目录被删时 resolver 同步回退项目根", async () => {
    const repo = initRepo("heal");
    const worktreePath = addLinkedWorktree(repo, "heal-branch");
    roots.push(worktreePath);
    const workspace = createAgentWorkspace("heal-project", { projectPath: repo });
    const thread = createAgentThread("heal thread", undefined, workspace.id);

    await setThreadWorktree({ threadId: thread.id, worktreePath });
    expect(canonical(resolveAgentThreadWorkdir(thread.id).agentCwd)).toBe(canonical(worktreePath));

    rmSync(worktreePath, { recursive: true, force: true });
    // 同步守卫回退默认 cwd；主仓库根漂移的深度校验由 run 入口完成。
    expect(canonical(resolveAgentThreadWorkdir(thread.id).agentCwd)).toBe(canonical(repo));
  });
});
