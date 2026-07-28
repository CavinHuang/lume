import type { SDKMessage } from "@lume/shared";
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const TERMINAL_STATUSES = new Set(["completed", "failed", "stopped", "killed", "interrupted"]);

type TaskNotification = Extract<SDKMessage, { type: "system"; subtype: "task_notification" }>;

export const BACKGROUND_TASK_WAKE_PROMPT =
  "后台任务刚刚产生了终态通知。请检查通知中的任务结果，并基于原始目标继续处理；如果不需要进一步动作，就简要说明结果。";

export function isTerminalBackgroundTaskNotification(
  message: SDKMessage,
  threadId: string,
  threadType?: string
): message is TaskNotification {
  if (threadType === "subagent") return false;
  if (message.type !== "system" || message.subtype !== "task_notification") return false;
  if (!message.task_id || !TERMINAL_STATUSES.has(message.status)) return false;
  if (message.subagent_run_id) return false;
  return !message.session_id || message.session_id === threadId;
}

/**
 * Claims terminal task notifications once per thread. The SDK event and the
 * persisted transcript may be delivered through different paths, so the wake
 * decision must be idempotent even when the task itself already is.
 */
export class AgentBackgroundWakeController {
  private readonly claimedTaskIds = new Map<string, Set<string>>();
  private readonly persistentClaims = new Map<string, string>();

  tryClaim(threadId: string, message: SDKMessage, threadType?: string): boolean {
    if (!isTerminalBackgroundTaskNotification(message, threadId, threadType)) return false;
    const taskId = message.task_id;
    const claimPath = claimPersistedContinuation(message);
    if (claimPath === false) return false;
    if (typeof claimPath === "string") this.persistentClaims.set(`${threadId}:${taskId}`, claimPath);
    const claimed = this.claimedTaskIds.get(threadId) ?? new Set<string>();
    if (claimed.has(taskId)) {
      if (typeof claimPath === "string") rollbackClaim(claimPath);
      return false;
    }
    claimed.add(taskId);
    this.claimedTaskIds.set(threadId, claimed);
    return true;
  }

  release(threadId: string, taskId: string): void {
    this.persistentClaims.delete(`${threadId}:${taskId}`);
    const claimed = this.claimedTaskIds.get(threadId);
    if (!claimed) return;
    claimed.delete(taskId);
    if (claimed.size === 0) this.claimedTaskIds.delete(threadId);
  }

  rollback(threadId: string, taskId: string): void {
    const key = `${threadId}:${taskId}`;
    const claimPath = this.persistentClaims.get(key);
    if (claimPath) rollbackClaim(claimPath);
    this.persistentClaims.delete(key);
    this.release(threadId, taskId);
  }

  clearThread(threadId: string): void {
    this.claimedTaskIds.delete(threadId);
    for (const key of this.persistentClaims.keys()) {
      if (key.startsWith(`${threadId}:`)) this.persistentClaims.delete(key);
    }
  }

  reset(): void {
    this.claimedTaskIds.clear();
    this.persistentClaims.clear();
  }
}

function claimPersistedContinuation(message: TaskNotification): string | false | undefined {
  if (!message.output_file) return undefined;
  const jobDir = dirname(message.output_file);
  const statePath = join(jobDir, "state.json");
  if (!existsSync(statePath)) return undefined;
  const claimPath = join(jobDir, "continuation.claim");
  try {
    const fd = openSync(claimPath, "wx");
    closeSync(fd);
  } catch {
    return false;
  }
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    if (state.continuationConsumedAt) {
      rollbackClaim(claimPath);
      return false;
    }
    const temporary = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, JSON.stringify({
      ...state,
      continuationConsumedAt: Date.now(),
      updatedAt: Date.now()
    }, null, 2), "utf8");
    renameSync(temporary, statePath);
    return claimPath;
  } catch {
    rollbackClaim(claimPath);
    return undefined;
  }
}

function rollbackClaim(claimPath: string): void {
  const statePath = join(dirname(claimPath), "state.json");
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    delete state.continuationConsumedAt;
    const temporary = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, JSON.stringify({
      ...state,
      updatedAt: Date.now()
    }, null, 2), "utf8");
    renameSync(temporary, statePath);
  } catch {
    // The state may already have been cleaned up with the task.
  }
  try {
    rmSync(claimPath, { force: true });
  } catch {
    // A failed wake remains recoverable through the persisted task state.
  }
}
