/**
 * Agent 线程 worktree 绑定服务。
 *
 * 对齐「绑定而非创建」模式：本服务不创建 worktree（创建走 Agent bash 或 SDK
 * EnterWorktree 工具），只负责枚举项目仓库的既有 linked worktree、校验绑定、
 * 在 worktree 失效时自愈回退。失效判定用 git 拓扑（--git-common-dir 回溯主仓库
 * 根）而非路径猜测，worktree 位于仓库目录之外时依然可靠。
 */

import { execFile as execFileCallback } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { promisify } from "node:util";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { AGENT_IPC_CHANNELS, type AgentActiveWorktree, type AgentThreadMeta, type SetThreadWorktreeInput, type ThreadWorktreeInfo } from "@lume/shared";
import { createLogger } from "../infra/logger";
import { emitAgentNotification } from "./agent-notification-service";
import { getAgentThreadMeta, tryUpdateAgentThreadMeta, updateAgentThreadMeta } from "./agent-thread-manager";
import { getAgentWorkspace } from "./agent-workspace-manager";
import { normalizeRealpathKey } from "./agent-workdir-resolver";

const log = createLogger("agent-worktree-service");

const execFile = promisify(execFileCallback);

/** git 子进程包装：非零退出/超时/无 git 返回 null，调用方按「不是仓库/不是 worktree」处理。 */
async function runGit(args: string[], cwd: string, timeoutMs = 10_000): Promise<string | null> {
  try {
    const { stdout } = await execFile("git", args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      timeout: timeoutMs
    });
    return stdout;
  } catch {
    return null;
  }
}

/** 已存在路径的规范化（realpath + Windows 大小写归一），用于路径等同性比较。 */
function canonicalExistingPath(path: string): string {
  try {
    return normalizeRealpathKey(path);
  } catch {
    return resolve(path);
  }
}

/**
 * 解析给定路径所属仓库的「主仓库根」。
 *
 * linked worktree 的公共 git 目录恒指向主仓库的 .git，其父目录即主仓库根；
 * 普通仓库返回自身根目录。非 git 路径返回 null。
 */
export async function getMainRepoRoot(somePath: string): Promise<string | null> {
  if (!existsSync(somePath)) return null;
  const commonDir = await runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], somePath);
  if (!commonDir?.trim()) return null;
  return canonicalExistingPath(dirname(commonDir.trim()));
}

/** 解析 `git worktree list --porcelain` 的单个 block。 */
function parseWorktreeBlock(block: string): { path: string; head: string; branch: string; prunable: boolean } | null {
  let path = "";
  let head = "";
  let branch = "";
  let prunable = false;
  for (const line of block.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length).slice(0, 7);
    else if (line.startsWith("branch refs/heads/")) branch = line.slice("branch refs/heads/".length);
    else if (line === "detached") branch = "(detached)";
    else if (line.startsWith("prunable")) prunable = true;
  }
  if (!path) return null;
  return { path, head, branch, prunable };
}

/** 列出项目仓库的全部 worktree（主仓库 + linked）。非 git 路径返回空数组。 */
export async function listWorktrees(repoPath: string): Promise<ThreadWorktreeInfo[]> {
  const output = await runGit(["worktree", "list", "--porcelain"], repoPath);
  if (!output) return [];

  const mainRepoRoot = await getMainRepoRoot(repoPath);
  const mainKey = mainRepoRoot ?? canonicalExistingPath(repoPath);
  const byKey = new Map<string, ThreadWorktreeInfo>();

  for (const block of output.split("\n\n")) {
    const parsed = parseWorktreeBlock(block.trim());
    if (!parsed || parsed.prunable || !existsSync(parsed.path)) continue;
    const key = canonicalExistingPath(parsed.path);
    if (byKey.has(key)) continue;
    byKey.set(key, {
      path: parsed.path,
      branch: parsed.branch || "unknown",
      head: parsed.head,
      isMain: key === mainKey,
      name: basename(parsed.path)
    });
  }

  return Array.from(byKey.values());
}

/** 线程绑定的 worktree 仍有效时返回绑定记录，否则 undefined（同步守卫 + 主仓库根比对）。 */
export async function getValidThreadWorktree(
  thread: Pick<AgentThreadMeta, "activeWorktree">
): Promise<AgentActiveWorktree | undefined> {
  const active = thread.activeWorktree;
  if (!active?.path || !isAbsolute(active.path)) return undefined;
  try {
    if (!statSync(active.path).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  const mainRepoRoot = await getMainRepoRoot(active.path);
  if (!mainRepoRoot || mainRepoRoot !== canonicalExistingPath(active.mainRepoRoot)) return undefined;
  return active;
}

/**
 * 绑定/解绑线程的活动 worktree，返回更新后的线程 meta（成功即广播）。
 *
 * 绑定要求目标目录是「线程所属项目仓库」的 linked worktree（在项目仓库的
 * worktree 列表内且非主 worktree）——列表命中本身即授权，不接受裸路径直写。
 */
export async function setThreadWorktree(input: SetThreadWorktreeInput): Promise<AgentThreadMeta> {
  const thread = getAgentThreadMeta(input.threadId);
  if (!thread) throw new Error(`Agent 线程不存在: ${input.threadId}`);

  let updated: AgentThreadMeta;
  if (input.worktreePath === null) {
    updated = updateAgentThreadMeta(input.threadId, { activeWorktree: undefined });
  } else {
    const workspace = thread.workspaceId ? getAgentWorkspace(thread.workspaceId) : undefined;
    if (!workspace?.projectPath?.trim()) {
      throw new Error("线程所属项目未绑定本地目录，无法使用 worktree");
    }

    const requestedKey = canonicalExistingPath(input.worktreePath);
    const worktrees = await listWorktrees(workspace.projectPath);
    const selected = worktrees.find((worktree) => !worktree.isMain && canonicalExistingPath(worktree.path) === requestedKey);
    if (!selected) throw new Error("指定目录不是该项目的 linked worktree");

    const mainRepoRoot = await getMainRepoRoot(selected.path);
    if (!mainRepoRoot) throw new Error("无法确认 worktree 的主仓库");

    log.info("thread worktree bound", { threadId: input.threadId, path: selected.path, branch: selected.branch });
    updated = updateAgentThreadMeta(input.threadId, {
      activeWorktree: {
        path: canonicalExistingPath(selected.path),
        mainRepoRoot,
        branch: selected.branch,
        selectedAt: Date.now()
      }
    });
  }

  emitAgentNotification(AGENT_IPC_CHANNELS.THREAD_WORKTREE_UPDATED, updated);
  return updated;
}

/**
 * run 入口自愈：线程绑定的 worktree 已失效时清除绑定并广播，返回更新后的
 * meta；无绑定或仍有效返回 null（调用方无需重解析 cwd）。
 */
export async function clearInvalidThreadWorktree(threadId: string): Promise<AgentThreadMeta | null> {
  const thread = getAgentThreadMeta(threadId);
  if (!thread?.activeWorktree) return null;
  if (await getValidThreadWorktree(thread)) return null;

  log.warn("thread worktree invalid, falling back to default cwd", {
    threadId,
    path: thread.activeWorktree.path
  });
  const updated = tryUpdateAgentThreadMeta(threadId, { activeWorktree: undefined });
  if (updated) {
    emitAgentNotification(AGENT_IPC_CHANNELS.THREAD_WORKTREE_UPDATED, updated);
  }
  return updated;
}
