import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentThreadMeta,
  AgentWorkspace,
  AgentWorkspaceRemovalImpact,
  AgentWorkspaceRemoveMode,
  AgentWorkspaceRemoveResult,
  AgentWorkspaceStatus
} from "@lume/shared";
import {
  bindLegacyAgentWorkspace,
  deleteAgentWorkspace,
  deleteAgentWorkspaceInternalData,
  getAgentWorkspace,
  getAgentWorkspaceStatus,
  relocateUnavailableAgentWorkspace
} from "./agent-workspace-manager";
import {
  broadcastAgentThreadListChanged,
  clearWorkspaceFromAgentThreads,
  invalidateAgentThreadRuntimeState,
  listAllAgentThreads,
  trashAgentThreads
} from "./agent-thread-manager";
import {
  disableAutomationJobsReferencingProject,
  listAutomationJobsReferencingProject
} from "../automation/automation-manager";
import {
  clearImAccountWorkspaceBindings,
  listImAccountsForWorkspace
} from "../im/im-config-manager";
import {
  deleteImThreadBindingsForThreadIds,
  listImThreadBindingsForThreadIds
} from "../im/im-thread-binding-store";
import { getWorkspaceMcpManager } from "../mcp/workspace-mcp-manager";
import { getAgentFileContextRootPath } from "../infra/config-paths";
import { resolveAgentThreadWorkdir } from "./agent-workdir-resolver";
import { getWikiService } from "../wiki/wiki-service";
import { getPlanningTodoStore } from "../planning/planning-todo-store";
import { agentLifecycleLocks } from "./agent-lifecycle-lock-manager";

const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;
const PROJECT_DISABLED_REASON = "项目已移除，自动化任务已停用";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collectProjectThreads(workspaceId: string): AgentThreadMeta[] {
  const allThreads = listAllAgentThreads();
  const byParent = new Map<string, AgentThreadMeta[]>();
  for (const thread of allThreads) {
    if (!thread.parentThreadId) continue;
    const children = byParent.get(thread.parentThreadId) ?? [];
    children.push(thread);
    byParent.set(thread.parentThreadId, children);
  }

  const affected = new Map<string, AgentThreadMeta>();
  const queue = allThreads.filter((thread) => thread.workspaceId === workspaceId);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (affected.has(current.id)) continue;
    affected.set(current.id, current);
    for (const child of byParent.get(current.id) ?? []) {
      queue.push(child);
    }
  }
  return [...affected.values()];
}

function impactFor(workspaceId: string, threads: AgentThreadMeta[]): AgentWorkspaceRemovalImpact {
  const threadIds = new Set(threads.map((thread) => thread.id));
  return {
    workspaceId,
    threads: threads.length,
    automations: listAutomationJobsReferencingProject({ workspaceId, threadIds }).length,
    imAccounts: listImAccountsForWorkspace(workspaceId).length,
    imThreadBindings: listImThreadBindingsForThreadIds(threadIds).length,
    planningTodos: getPlanningTodoStore().count(workspaceId),
    planningTodoAction: 'unassigned'
  };
}

async function stopAndDrainThreads(threadIds: string[], timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS): Promise<void> {
  if (threadIds.length === 0) return;
  const { stopAgent } = await import("./agent-service");
  const runtime = await import("../agent-runtime/runtime-core/attempt");
  for (const threadId of threadIds) {
    stopAgent(threadId);
    await runtime.stopAgentRuntime(threadId).catch(() => false);
  }

  const startedAt = Date.now();
  while (threadIds.some((threadId) => runtime.isAgentRuntimeSessionActive(threadId))) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("停止项目运行超时，项目索引和路径保持不变");
    }
    await sleep(25);
  }
}

async function drainProjectRuntime(workspace: AgentWorkspace, threads: AgentThreadMeta[]): Promise<void> {
  await stopAndDrainThreads(threads.map((thread) => thread.id));
  await getWorkspaceMcpManager().disposeWorkspace(workspace.slug);
}

function materializeThreadFileContexts(threads: AgentThreadMeta[]): void {
  for (const thread of threads) {
    const resolvedWorkdir = resolveAgentThreadWorkdir(thread.id);
    const expectedRoot = resolve(getAgentFileContextRootPath(thread.fileContextId ?? thread.id));
    if (resolve(resolvedWorkdir.lumeWorkDir) !== expectedRoot) {
      throw new Error(`线程 ${thread.id} 的旧 Lume 工作目录迁移失败，项目保持不变`);
    }
  }
}
function invalidateThreads(threads: AgentThreadMeta[]): void {
  for (const thread of threads) {
    invalidateAgentThreadRuntimeState(thread.id);
  }
}

function requireWorkspace(workspaceId: string): AgentWorkspace {
  const workspace = getAgentWorkspace(workspaceId);
  if (!workspace) {
    throw new Error(`项目不存在: ${workspaceId}`);
  }
  return workspace;
}

export function getProjectAvailability(workspaceId: string): AgentWorkspaceStatus {
  return getAgentWorkspaceStatus(workspaceId);
}

export async function bindUnboundLegacyProject(workspaceId: string, projectPath: string): Promise<AgentWorkspace> {
  const workspace = requireWorkspace(workspaceId);
  const threads = collectProjectThreads(workspaceId);
  await drainProjectRuntime(workspace, threads);
  const updated = bindLegacyAgentWorkspace(workspaceId, projectPath);
  invalidateThreads(threads);
  broadcastAgentThreadListChanged();
  return updated;
}

export async function relocateUnavailableProject(workspaceId: string, projectPath: string): Promise<AgentWorkspace> {
  const workspace = requireWorkspace(workspaceId);
  const status = getAgentWorkspaceStatus(workspaceId);
  if (status.availability === "available") {
    throw new Error("项目目录仍可访问，不能迁移到其他目录");
  }
  const threads = collectProjectThreads(workspaceId);
  await drainProjectRuntime(workspace, threads);
  const updated = relocateUnavailableAgentWorkspace(workspaceId, projectPath);
  invalidateThreads(threads);
  broadcastAgentThreadListChanged();
  return updated;
}

export function getProjectRemovalImpact(workspaceId: string): AgentWorkspaceRemovalImpact {
  requireWorkspace(workspaceId);
  return impactFor(workspaceId, collectProjectThreads(workspaceId));
}

export async function removeProject(input: {
  workspaceId: string;
  mode: AgentWorkspaceRemoveMode;
}): Promise<AgentWorkspaceRemoveResult> {
  const threadsForLock = collectProjectThreads(input.workspaceId);
  const release = await agentLifecycleLocks.acquire([
    `workspace:${input.workspaceId}`,
    ...threadsForLock.map((thread) => `thread:${thread.id}`),
  ]);
  try {
  const workspace = requireWorkspace(input.workspaceId);
  const threads = collectProjectThreads(input.workspaceId);
  const threadIds = new Set(threads.map((thread) => thread.id));
  const impact = impactFor(input.workspaceId, threads);
  const planningStore = getPlanningTodoStore();
  const planningSnapshot = planningStore.snapshotWorkspaceTodos(input.workspaceId);
  const planningOperationId = randomUUID();
  let planningOperation = planningStore.reserveOperation({
    operationId: planningOperationId,
    kind: input.mode === "keepHistory" ? "project_keep_history" : "project_delete_lume_data"
  });
  let planningCommitted = false;

  try {

  await drainProjectRuntime(workspace, threads);
  materializeThreadFileContexts(threads);
  // Wiki 归档是 destructive sequence 的前置条件；失败时项目保持存在。
  getWikiService().archiveWorkspace(input.workspaceId);

  const planningResult = planningStore.removeWorkspace(input.workspaceId, input.mode);
  planningCommitted = true;
  planningOperation = planningStore.advanceOperation(planningOperationId, { phase: "planning_committed", status: "running" });

  disableAutomationJobsReferencingProject({
    workspaceId: input.workspaceId,
    threadIds,
    reason: PROJECT_DISABLED_REASON
  });
  clearImAccountWorkspaceBindings(input.workspaceId);

  if (input.mode === "deleteLumeData") {
    deleteImThreadBindingsForThreadIds(threadIds);
  }

  const convertedThreads = clearWorkspaceFromAgentThreads(input.workspaceId);
  invalidateThreads(convertedThreads.length > 0 ? convertedThreads : threads);

  if (input.mode === "deleteLumeData") {
    trashAgentThreads(threadIds);
  }
  planningOperation = planningStore.advanceOperation(planningOperationId, { phase: "threads_processed", status: "running" });

  deleteAgentWorkspaceInternalData(workspace.slug);
  deleteAgentWorkspace(input.workspaceId);
  planningOperation = planningStore.advanceOperation(planningOperationId, { phase: "workspace_removed", status: "running" });
  broadcastAgentThreadListChanged();
  planningOperation = planningStore.advanceOperation(planningOperationId, { phase: "finalized", status: "completed", recoverable: false });

  return {
    ...impact,
    planningTodos: planningResult.count,
    planningTodoAction: input.mode === "keepHistory" ? "unassigned" : "trash",
    mode: input.mode,
    planningOperation
  };
  } catch (error) {
    if (planningCommitted) {
      try {
        planningOperation = planningStore.advanceOperation(planningOperationId, { phase: "compensating", status: "running", compensation: "pending", recoverable: true, error: error instanceof Error ? error.message : String(error) });
        planningStore.restoreWorkspaceSnapshot(planningSnapshot, planningOperationId);
        planningOperation = planningStore.advanceOperation(planningOperationId, { phase: "finalized", status: "compensated", compensation: "completed", recoverable: false, error: error instanceof Error ? error.message : String(error) });
      } catch (compensationError) {
        planningOperation = planningStore.advanceOperation(planningOperationId, { phase: "compensating", status: "partial", compensation: "failed", recoverable: true, error: compensationError instanceof Error ? compensationError.message : String(compensationError) });
      }
    } else {
      planningOperation = planningStore.advanceOperation(planningOperationId, { phase: "finalized", status: "failed", recoverable: false, error: error instanceof Error ? error.message : String(error) });
    }
    const failure = error instanceof Error ? error : new Error(String(error));
    Object.assign(failure, { planningOperation });
    throw failure;
  }
  } finally {
    release();
  }
}
