import { isPathInside } from "./path-containment";
import {
  type CompletionGuardResult,
  type SDKMessage,
  type ToolResult,
} from "@lume/agent-sdk";
import type {
  CodingGitAction,
  CodingTurnPhase,
  CodingVerificationRecord,
  RuntimeCodingChangeSet,
} from "@lume/shared";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { discoverCodingRoots, getCodingChangeSet } from "./coding-change-service";
import { createCodingWorkspaceMonitor } from "./coding-workspace-monitor";
import {
  selectVerificationCommands,
  selectVerificationCommandsForWorkspaces,
} from "./coding-verification";

export type CodingVerificationStatus = "not_required" | "unverified" | "verified" | "failed";

const MAX_RESTORED_STATE_BYTES = 1024 * 1024;
const MAX_PERSISTED_CANDIDATES = 2_000;
const PERSIST_DEBOUNCE_MS = 50;
const COMPLETION_CHANGESET_WAIT_MS = 750;

export interface CodingVerificationReport {
  phase: CodingTurnPhase;
  status: CodingVerificationStatus;
  message?: string;
  baselineFailure?: {
    command: string;
    signature: string;
  };
  workspaceChanged: boolean;
  changedFiles: string[];
  fileChanges?: Array<{ path: string; addedLines?: number; removedLines?: number }>;
  totalAddedLines?: number;
  totalRemovedLines?: number;
  changeSet?: RuntimeCodingChangeSet;
  externalChangedFiles: string[];
  pendingBackground: boolean;
  verificationRepairAttempts?: number;
  verificationNoEvidenceAttempts?: number;
  verificationRecords?: CodingVerificationRecord[];
  recommendedVerificationCommands?: string[];
  gitActions?: CodingGitAction[];
  approvalRequestCount?: number;
  turnId?: string;
  userMessageId?: string;
  baselineCommit?: string;
}

interface PersistedCodingRunState {
  version: 1 | 2 | 3;
  workspaceRoot: string;
  workspaceRoots?: string[];
  baselineCommit?: string;
  baselineCommits?: Record<string, string>;
  mutationObserved: boolean;
  verificationStatus: CodingVerificationStatus;
  verificationMessage: string;
  promptedWithoutEvidence: boolean;
  baselineVerification?: { command: string; signature: string };
  baselineFailure?: { command: string; signature: string };
  attributedCandidates: string[];
  pendingBackground: boolean;
  pendingBackgroundTaskIds?: string[];
  pendingVerificationTaskIds?: string[];
  /** Legacy v1 field retained only for in-flight state migration. */
  blockingBackgroundTaskIds?: string[];
  verificationRepairAttempts?: number;
  verificationNoEvidenceAttempts?: number;
  fileChangeStats?: Record<string, FileChangeStats>;
  verificationRecords?: CodingVerificationRecord[];
  gitActions?: CodingGitAction[];
}

interface FileChangeStats {
  addedLines: number;
  removedLines: number;
}

export interface CodingRunTrackerOptions {
  workspaceRoot?: string;
  additionalRoots?: string[];
  statePath?: string;
  turnId?: string;
  userMessageId?: string;
}

export function createCodingRunTracker(options: CodingRunTrackerOptions = {}) {
  const workspaceRoots = uniqueWorkspaceRoots(options.workspaceRoot, options.additionalRoots);
  const gitWorkspaceRoots = workspaceRoots.filter(hasGitMetadata);
  const workspaceMonitor = createCodingWorkspaceMonitor(workspaceRoots, {
    // Git is the authoritative, incremental index for repositories. Recursively
    // installing filesystem watchers there can itself enumerate a very large tree,
    // so those watchers are initialized outside the runtime's event loop.
    watchRoots: workspaceRoots.filter((root) => !gitWorkspaceRoots.includes(root)),
    isolatedWatchRoots: gitWorkspaceRoots,
  });
  let mutationObserved = false;
  let verificationStatus: CodingVerificationStatus = "not_required";
  let verificationMessage = "";
  let promptedWithoutEvidence = false;
  let baselineVerification: PersistedCodingRunState["baselineVerification"];
  let baselineFailure: PersistedCodingRunState["baselineFailure"];
  const attributedCandidates = new Set<string>();
  const pendingShellMutationPaths: string[][] = [];
  let pendingBackground = false;
  const pendingBackgroundTaskIds = new Set<string>();
  const pendingVerificationTaskIds = new Set<string>();
  let verificationRepairAttempts = 0;
  let verificationNoEvidenceAttempts = 0;
  const fileChangeStats = new Map<string, FileChangeStats>();
  let changeSet: RuntimeCodingChangeSet | undefined;
  let authoritativeRefresh: Promise<RuntimeCodingChangeSet | undefined> | undefined;
  let authoritativeRefreshRequested = false;
  let authoritativeWaitDeadline = 0;
  let baselineCommit: string | undefined;
  let baselineCommits: Record<string, string> = {};
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  let persistInFlight: Promise<void> | undefined;
  let persistDirty = false;
  let disposed = false;
  let successfulShellObserved = false;
  const verificationRecords: CodingVerificationRecord[] = [];
  const gitActions: CodingGitAction[] = [];
  let recommendedVerificationCommands: string[] = [];

  async function beforeToolExecution(input: {
    toolName: string;
    input: unknown;
    userMessageId?: string;
    cwd: string;
  }): Promise<void> {
    workspaceMonitor.beginTool(input.toolName);
    if (input.toolName.toLowerCase() === "bash") {
      pendingShellMutationPaths.push(readShellMutationPaths(input.input, input.cwd, workspaceRoots));
    }
  }

  function persist(): void {
    if (!options.statePath || !options.workspaceRoot || disposed) return;
    persistDirty = true;
    if (persistTimer || persistInFlight) return;
    persistTimer = setTimeout(() => {
      persistTimer = undefined;
      void flushState();
    }, PERSIST_DEBOUNCE_MS);
  }

  function createPersistedState(): PersistedCodingRunState {
    const candidates = [...new Set([
      ...attributedCandidates,
      ...workspaceMonitor.getAttributedPaths(),
    ])].slice(-MAX_PERSISTED_CANDIDATES);
    return {
      version: 3,
      workspaceRoot: options.workspaceRoot!,
      workspaceRoots,
      baselineCommit,
      baselineCommits,
      mutationObserved,
      verificationStatus,
      verificationMessage,
      promptedWithoutEvidence,
      baselineVerification,
      baselineFailure,
      attributedCandidates: candidates,
      pendingBackground,
      pendingBackgroundTaskIds: [...pendingBackgroundTaskIds],
      pendingVerificationTaskIds: [...pendingVerificationTaskIds],
      verificationRepairAttempts,
      verificationNoEvidenceAttempts,
      fileChangeStats: Object.fromEntries(fileChangeStats),
      verificationRecords,
      gitActions
    };
  }

  async function flushState(): Promise<void> {
    if (!options.statePath || !options.workspaceRoot || disposed || persistInFlight) return persistInFlight;
    if (!persistDirty) return;
    persistDirty = false;
    const statePath = options.statePath;
    const payload = JSON.stringify(createPersistedState());
    const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    persistInFlight = (async () => {
      try {
        await mkdir(dirname(statePath), { recursive: true });
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1_000);
        try {
          await writeFile(tempPath, payload, { encoding: "utf-8", signal: controller.signal });
        } finally {
          clearTimeout(timeout);
        }
        await rename(tempPath, statePath);
      } catch {
        // State persistence is best effort; the in-memory guard remains authoritative.
      }
    })().finally(() => {
      persistInFlight = undefined;
      if (persistDirty && !disposed) persist();
    });
    await persistInFlight;
  }

  async function restore(): Promise<void> {
    if (!options.statePath || !options.workspaceRoot) return;
    try {
      const metadata = await stat(options.statePath);
      if (metadata.size > MAX_RESTORED_STATE_BYTES) return;
      const state = JSON.parse(await readFile(options.statePath, "utf-8")) as Partial<PersistedCodingRunState>;
      if ((state.version !== 1 && state.version !== 2 && state.version !== 3)
        || state.workspaceRoot !== options.workspaceRoot) return;
      if (state.version >= 2 && state.workspaceRoots && !sameWorkspaceRoots(state.workspaceRoots, workspaceRoots)) return;
      baselineCommit = state.baselineCommit;
      baselineCommits = state.baselineCommits ?? {};
      mutationObserved = state.mutationObserved === true;
      verificationStatus = state.verificationStatus ?? "not_required";
      verificationMessage = state.verificationMessage ?? "";
      promptedWithoutEvidence = state.promptedWithoutEvidence === true;
      baselineVerification = state.baselineVerification;
      baselineFailure = state.baselineFailure;
      for (const path of state.attributedCandidates ?? []) {
        attributedCandidates.add(path);
        workspaceMonitor.recordAttributedPath(path);
      }
      pendingBackground = state.pendingBackground === true;
      for (const taskId of state.pendingBackgroundTaskIds ?? []) pendingBackgroundTaskIds.add(taskId);
      for (const taskId of state.pendingVerificationTaskIds ?? []) pendingVerificationTaskIds.add(taskId);
      if (!state.pendingVerificationTaskIds) {
        for (const taskId of state.blockingBackgroundTaskIds ?? []) pendingVerificationTaskIds.add(taskId);
      }
      verificationRepairAttempts = typeof state.verificationRepairAttempts === "number"
        ? Math.max(0, state.verificationRepairAttempts)
        : 0;
      verificationNoEvidenceAttempts = typeof state.verificationNoEvidenceAttempts === "number"
        ? Math.max(0, state.verificationNoEvidenceAttempts)
        : 0;
      for (const [path, stats] of Object.entries(state.fileChangeStats ?? {})) {
        if (!stats || typeof stats !== "object") continue;
        const addedLines = Number(stats.addedLines);
        const removedLines = Number(stats.removedLines);
        if (Number.isFinite(addedLines) && Number.isFinite(removedLines)) {
          fileChangeStats.set(path, {
            addedLines: Math.max(0, addedLines),
            removedLines: Math.max(0, removedLines),
          });
        }
      }
      verificationRecords.splice(0, verificationRecords.length, ...(state.verificationRecords ?? []).slice(-8));
      gitActions.splice(0, gitActions.length, ...(state.gitActions ?? []).slice(-16));
    } catch {
      // Missing, corrupt, partial, or oversized legacy state establishes a fresh baseline.
    }
  }

  async function initialize(): Promise<void> {
    workspaceMonitor.start();
    await restore();
    if (Object.keys(baselineCommits).length === 0) {
      const baselines = await captureGitBaselines(workspaceRoots, options.workspaceRoot);
      baselineCommits = baselines.commits;
      baselineCommit = baselines.primaryCommit;
    }
    persist();
  }

  function observe(input: { toolName: string; input: unknown; result: ToolResult }): void {
    const name = input.toolName.toLowerCase();
    const isProcessOutput = name === "taskoutput" || name === "processoutput";
    const execution = getExecutionMetadata(input.result);
    const task = getTaskMetadata(input.result);
    const toolStillRunning = task?.status
      ? task.status === "running"
      : execution?.terminationReason === "running";
    if (["bash", "write", "edit", "notebookedit"].includes(name)) {
      workspaceMonitor.finishTool(name, task?.id, name === "bash" && toolStillRunning);
    }
    if (isProcessOutput && !toolStillRunning) {
      workspaceMonitor.finishBackgroundTask(task?.id);
    }
    const raw = input.input && typeof input.input === "object" ? input.input as Record<string, unknown> : {};
    const shellCommand = typeof raw.command === "string" ? raw.command : execution?.command ?? "";
    if (name === "bash") {
      const predictedPaths = pendingShellMutationPaths.shift() ?? [];
      if (input.result.is_error !== true) {
        successfulShellObserved = true;
        for (const path of predictedPaths) {
          attributedCandidates.add(path);
          workspaceMonitor.recordAttributedPath(path);
        }
      }
    }
    if (name === "bash" && shellCommand) recordGitAction(shellCommand, input.result, execution);
    if (name === "bash" && execution?.terminationReason === "running") {
      pendingBackground = true;
      if (task?.id) {
        pendingBackgroundTaskIds.add(task.id);
        const raw = input.input && typeof input.input === "object" ? input.input as Record<string, unknown> : {};
        const command = typeof raw.command === "string" ? raw.command : execution.command ?? "";
        const purpose = typeof raw.purpose === "string" ? raw.purpose : execution.purpose ?? "";
        if (isVerificationCommand(command, purpose)) pendingVerificationTaskIds.add(task.id);
      }
    }
    if (isProcessOutput && (execution || task)) {
      if (execution?.command) updateGitAction(execution.command, input.result, execution);
      const processOutputRunning = task?.status
        ? task.status === "running"
        : execution?.terminationReason === "running";
      if (processOutputRunning) {
        pendingBackground = true;
        if (task?.id) pendingBackgroundTaskIds.add(task.id);
      } else {
        if (task?.id) {
          pendingBackgroundTaskIds.delete(task.id);
          pendingVerificationTaskIds.delete(task.id);
        } else if (pendingBackgroundTaskIds.size === 0) {
          pendingBackground = false;
        }
        pendingBackground = pendingBackgroundTaskIds.size > 0;
      }
    }
    const bashMutation = name === "bash" && isLikelyMutationCommand(input);
    if ((["write", "edit", "notebookedit"].includes(name) || bashMutation) && input.result.is_error !== true) {
      mutationObserved = true;
      if (name !== "bash") {
        const path = readMutationPath(input.input, input.result, options.workspaceRoot, workspaceRoots);
        if (path) {
          attributedCandidates.add(path);
          workspaceMonitor.recordAttributedPath(path);
          mergeFileChangeStats(fileChangeStats, path, readFileChangeStats(input.result));
        }
      }
      if (verificationStatus === "verified" || verificationStatus === "not_required") verificationStatus = "unverified";
      if (options.workspaceRoot) void startAuthoritativeRefresh();
    }
    if (name !== "bash" && !isProcessOutput) {
      persist();
      return;
    }
    if ((isProcessOutput && !execution) || executionOutcome(execution) === "running") {
      persist();
      return;
    }
    const command = name === "bash" && typeof raw.command === "string" ? raw.command : execution?.command ?? "";
    const purpose = name === "bash" && typeof raw.purpose === "string" ? raw.purpose : execution?.purpose ?? "";
    if (!isVerificationCommand(command, purpose)) {
      persist();
      return;
    }
    const signature = verificationSignature(input.result);
    const outcome = executionOutcome(execution);
    if (outcome === "interrupted") {
      verificationStatus = "unverified";
      verificationMessage = "后台验证在应用或执行器恢复期间被中断，结果不确定；这不计为代码验证失败。";
      recordVerification(command, input.result, execution, signature, "inconclusive");
      persist();
      return;
    }
    recordVerification(command, input.result, execution, signature);
    if (execution?.semanticOutcome === "no_matches" && outcome === "succeeded") {
      verificationNoEvidenceAttempts += 1;
      verificationStatus = "unverified";
      verificationMessage = "验证命令只返回了搜索无匹配，未提供完整测试或类型检查结果。请直接运行原始验证命令，不要用 grep、findstr、Select-String 或 head 过滤。";
      promptedWithoutEvidence = false;
      persist();
      return;
    }
    if (!mutationObserved && outcome !== "succeeded") {
      baselineVerification = { command, signature };
      persist();
      return;
    }
    if (outcome !== "succeeded") {
      if (baselineVerification?.command === command && baselineVerification.signature === signature) {
        baselineFailure = { command, signature };
        verificationStatus = "unverified";
        verificationMessage = "验证命令在修改前已经失败，本次失败与基线一致，无法归因于当前修改。";
        promptedWithoutEvidence = true;
        persist();
        return;
      }
      verificationStatus = "failed";
      verificationMessage = stringifyResult(input.result);
      persist();
      return;
    }
    verificationStatus = "verified";
    verificationMessage = "";
    verificationNoEvidenceAttempts = 0;
    baselineFailure = undefined;
    persist();
  }

  async function completionGuard(): Promise<CompletionGuardResult> {
    await workspaceMonitor.settle();
    synchronizeWorkspaceMonitor();
    const verificationStillRunning = [...pendingVerificationTaskIds]
      .some((taskId) => pendingBackgroundTaskIds.has(taskId));
    if (verificationStillRunning) {
      persist();
      // Claude Code treats an auto-backgrounded command as a completed tool
      // call. Verification remains pending and is updated by its terminal
      // task notification instead of holding this model turn open.
      return undefined;
    }
    if (mutationObserved && options.workspaceRoot) {
      await waitForAuthoritativeRefresh(startAuthoritativeRefresh());
    }
    if (verificationNoEvidenceAttempts >= 2) {
      return {
        type: "stop",
        errorCode: "verification_inconclusive",
        message: "验证命令连续返回搜索无匹配，无法确认测试或类型检查结果，已停止继续尝试。请直接运行未过滤的验证命令并查看完整输出。"
      };
    }
    if (!mutationObserved || verificationStatus === "verified" || verificationStatus === "not_required") return undefined;
    if (verificationStatus === "failed") {
      if (verificationRepairAttempts >= 1) {
        return {
          type: "stop",
          errorCode: "verification_failed_after_repair",
          message: `验证在一次自动修复后仍失败，已停止继续消耗 token。${verificationMessage || "请查看失败日志后手动继续。"}`
        };
      }
      verificationRepairAttempts += 1;
      persist();
      return {
        type: "continue",
        message: `[verification failed] ${(verificationMessage || "上一次验证失败").slice(0, 800)}。请在当前 Run 中修复问题并重新执行验证；最多自动修复一次。`
      };
    }
    if (promptedWithoutEvidence) return undefined;
    promptedWithoutEvidence = true;
    const workspaceRoot = options.workspaceRoot;
    const candidatePaths = getCandidatePaths();
    if (candidatePaths.length > 0) {
      recommendedVerificationCommands = selectVerificationCommandsForWorkspaces(
        workspaceRoots.map((root) => ({
          workspaceRoot: root,
          changedFiles: candidatePaths
            .filter((path) => isPathInside(root, path))
            .map((path) => displayWorkspacePath(path, root)),
        })),
      ).map((candidate) => candidate.command);
    } else if (workspaceRoot && changeSet?.files.some((file) => file.rootId)) {
      const discoveredRoots = await withDeadline(discoverCodingRoots(workspaceRoots), COMPLETION_CHANGESET_WAIT_MS);
      recommendedVerificationCommands = discoveredRoots
        ? selectVerificationCommandsForWorkspaces(
          discoveredRoots.map((root) => ({
            workspaceRoot: root.path,
            rootId: root.repository.rootId,
            changedFiles: changeSet?.files
              .filter((file) => file.rootId === root.repository.rootId)
              .map((file) => file.path) ?? [],
          }))
        ).map((candidate) => candidate.command)
        : selectVerificationCommands({
          workspaceRoot,
          changedFiles: getCandidatePaths().map((path) => displayWorkspacePath(path, workspaceRoot)),
        }).map((candidate) => candidate.command);
    } else {
      recommendedVerificationCommands = workspaceRoot
        ? selectVerificationCommands({
          workspaceRoot,
          changedFiles: changeSet?.files.map((file) => file.path) ?? candidatePaths,
        }).map((candidate) => candidate.command)
        : [];
    }
    const suggestions = recommendedVerificationCommands.length > 0
      ? `运行以下仓库已有验证脚本（最多选择相关的两项）：\n${recommendedVerificationCommands.map((command) => `- ${command}`).join("\n")}`
      : "当前仓库没有可可靠识别的验证脚本，请明确说明未验证，不要猜测命令。";
    return `[verification needed] 当前 Run 已产生文件或命令变更。${suggestions}`;
  }

  function observeAsyncEvent(message: SDKMessage): boolean {
    if (message.type !== "system" || message.subtype !== "task_notification" || !message.execution) {
      return false;
    }
    const status = normalizeCodingExitStatus(message.status);
    observe({
      toolName: "ProcessOutput",
      input: { task_id: message.task_id },
      result: {
        type: "tool_result",
        tool_use_id: message.tool_use_id ?? "",
        content: message.message ?? message.summary ?? `Background process ${status}`,
        ...(status === "failed" || status === "stopped" ? { is_error: true } : {}),
        _meta: {
          execution: message.execution,
          task: { id: message.task_id, status, kind: "shell" }
        }
      }
    });
    return true;
  }

  return {
    observe,
    observeAsyncEvent,
    initialize,
    waitForWorkspaceMonitorReady: workspaceMonitor.waitUntilReady,
    beforeToolExecution,
    getBaselineCommit: () => baselineCommit,
    getBaselineCommits: () => ({ ...baselineCommits }),
    completionGuard,
    getVerificationStatus: () => verificationStatus,
    getVerificationReport: (): CodingVerificationReport => {
      const candidateFiles = getCandidatePaths()
        .map((path) => displayWorkspacePath(path, options.workspaceRoot));
      const authoritativeFiles = changeSet?.files.map((file) => file.path) ?? [];
      const changedFiles = changeSet?.isGitRepo
        ? [...new Set(authoritativeFiles)]
        : [...new Set([...candidateFiles, ...authoritativeFiles])];
      const externalChangedFiles = workspaceMonitor.getExternalPaths()
        .map((path) => displayWorkspacePath(path, options.workspaceRoot));
      const authoritativeChangeSet = changeSet?.isGitRepo ? changeSet : undefined;
      const fileChanges = authoritativeChangeSet
        ? authoritativeChangeSet.files
        : changedFiles.map((path) => {
          const absolutePath = options.workspaceRoot && !isAbsolute(path)
            ? resolve(options.workspaceRoot, path)
            : path;
          return {
            path,
            ...(fileChangeStats.get(absolutePath) ?? fileChangeStats.get(path) ?? {})
          };
        });
      const totalAddedLines = authoritativeChangeSet?.totalAddedLines
        ?? fileChanges.reduce((sum, change) => sum + (change.addedLines ?? 0), 0);
      const totalRemovedLines = authoritativeChangeSet?.totalRemovedLines
        ?? fileChanges.reduce((sum, change) => sum + (change.removedLines ?? 0), 0);
      return {
        phase: getCodingTurnPhase(),
        status: verificationStatus,
        ...(verificationMessage ? { message: verificationMessage } : {}),
        ...(baselineFailure ? { baselineFailure } : {}),
        workspaceChanged: changedFiles.length > 0,
        changedFiles,
        ...(fileChanges.length > 0 ? { fileChanges } : {}),
        ...(totalAddedLines > 0 ? { totalAddedLines } : {}),
        ...(totalRemovedLines > 0 ? { totalRemovedLines } : {}),
        ...(changeSet ? { changeSet } : {}),
        externalChangedFiles,
        pendingBackground,
        verificationRepairAttempts,
        verificationNoEvidenceAttempts,
        verificationRecords: [...verificationRecords],
        ...(recommendedVerificationCommands.length > 0 ? { recommendedVerificationCommands } : {}),
        gitActions: [...gitActions],
        ...(options.turnId ? { turnId: options.turnId } : {}),
        ...(options.userMessageId ? { userMessageId: options.userMessageId } : {}),
        ...(baselineCommit ? { baselineCommit } : {})
      };
    },
    refreshChangeSet: async () => {
      await workspaceMonitor.settle();
      synchronizeWorkspaceMonitor();
      if (!options.workspaceRoot || !mutationObserved) return changeSet;
      return waitForAuthoritativeRefresh(startAuthoritativeRefresh());
    },
    dispose: async () => {
      workspaceMonitor.dispose();
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = undefined;
      }
      await waitForSettled(flushState(), 500);
      disposed = true;
    },
  };

  function synchronizeWorkspaceMonitor(): void {
    const observed = workspaceMonitor.getAttributedPaths();
    for (const path of observed) attributedCandidates.add(path);
    if (observed.length === 0 && !(workspaceMonitor.hasUnresolvedChanges() && successfulShellObserved)) return;
    mutationObserved = true;
    if (verificationStatus === "verified" || verificationStatus === "not_required") {
      verificationStatus = "unverified";
    }
    persist();
  }

  function getCandidatePaths(): string[] {
    return [...new Set([...attributedCandidates, ...workspaceMonitor.getAttributedPaths()])];
  }

  function startAuthoritativeRefresh(): Promise<RuntimeCodingChangeSet | undefined> {
    authoritativeRefreshRequested = true;
    if (authoritativeRefresh) return authoritativeRefresh;
    authoritativeRefresh = (async () => {
      do {
        authoritativeRefreshRequested = false;
        try {
          changeSet = await refreshAuthoritativeChangeSet();
          persist();
        } catch {
          // Candidate paths remain available when Git or filesystem reconciliation fails.
        }
      } while (authoritativeRefreshRequested && !disposed);
      return changeSet;
    })().finally(() => {
      authoritativeRefresh = undefined;
    });
    return authoritativeRefresh;
  }

  async function waitForAuthoritativeRefresh(
    refresh: Promise<RuntimeCodingChangeSet | undefined>,
  ): Promise<RuntimeCodingChangeSet | undefined> {
    if (authoritativeWaitDeadline === 0) {
      authoritativeWaitDeadline = Date.now() + COMPLETION_CHANGESET_WAIT_MS;
    }
    const remainingMs = authoritativeWaitDeadline - Date.now();
    if (remainingMs <= 0) return changeSet;
    return (await withDeadline(refresh, remainingMs)) ?? changeSet;
  }

  async function refreshAuthoritativeChangeSet(): Promise<RuntimeCodingChangeSet> {
    const workspaceRoot = options.workspaceRoot!;
    const absolutePaths = getCandidatePaths();
    const requiresFullGitReconciliation = workspaceMonitor.hasUnresolvedChanges();
    return getCodingChangeSet(workspaceRoot, {
      // A degraded watcher may have missed siblings or descendants. In that state
      // candidates are only evidence that a mutation happened, never a safe filter.
      paths: absolutePaths.length > 0 && !requiresFullGitReconciliation
        ? absolutePaths
        : undefined,
      turnId: options.turnId,
      roots: options.additionalRoots
    });
  }

  function getCodingTurnPhase(): CodingTurnPhase {
    if (verificationStatus === "failed") return "failed";
    if (pendingBackground) return "verifying";
    if (!mutationObserved) return "executing";
    if (verificationStatus === "verified") return "ready_for_review";
    return promptedWithoutEvidence ? "verifying" : "executing";
  }

  function recordVerification(
    command: string,
    result: ToolResult,
    execution: ReturnType<typeof getExecutionMetadata>,
    signature: string,
    forcedStatus?: CodingVerificationRecord["status"],
  ): void {
    const status: CodingVerificationRecord["status"] = forcedStatus ?? (executionOutcome(execution) !== "succeeded"
      ? "failed"
      : execution?.semanticOutcome === "no_matches"
        ? "inconclusive"
        : "passed");
    verificationRecords.push({
      command,
      status,
      startedAt: new Date(Date.now() - (execution?.durationMs ?? 0)).toISOString(),
      finishedAt: new Date().toISOString(),
      ...(execution?.durationMs !== undefined ? { durationMs: execution.durationMs } : {}),
      ...(status === "failed" || status === "inconclusive" ? { message: signature.slice(0, 800) } : {}),
    });
    if (verificationRecords.length > 8) verificationRecords.splice(0, verificationRecords.length - 8);
  }

  function recordGitAction(
    command: string,
    result: ToolResult,
    execution: ReturnType<typeof getExecutionMetadata>,
  ): void {
    const match = command.match(/\bgit\s+(commit|push|merge|rebase|reset|clean|checkout|restore|cherry-pick|revert)\b/i);
    if (!match) return;
    const kind = normalizeGitActionKind(match[1]!);
    gitActions.push({
      kind,
      command: command.slice(0, 500),
      status: execution?.terminationReason === "running"
        ? "running"
        : result.is_error === true
          ? "failed"
          : "completed",
      createdAt: new Date().toISOString(),
    });
    if (gitActions.length > 16) gitActions.splice(0, gitActions.length - 16);
    persist();
  }

  function updateGitAction(
    command: string,
    result: ToolResult,
    execution: ReturnType<typeof getExecutionMetadata>,
  ): void {
    const existing = [...gitActions].reverse().find((action) => action.status === "running" && action.command === command.slice(0, 500));
    if (!existing) return;
    existing.status = result.is_error === true ? "failed" : execution?.terminationReason === "running" ? "running" : "completed";
    persist();
  }
}

function normalizeGitActionKind(value: string): CodingGitAction["kind"] {
  if (value === "cherry-pick" || value === "revert") return "other";
  return value as CodingGitAction["kind"];
}

function hasGitMetadata(start: string): boolean {
  return Boolean(findGitMetadataRoot(start));
}

function findGitMetadataRoot(start: string): string | undefined {
  let current = resolve(start);
  while (true) {
    if (existsSync(resolve(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function captureGitBaselines(
  roots: string[],
  primaryRoot?: string,
): Promise<{ commits: Record<string, string>; primaryCommit?: string }> {
  const gitRoots = [...new Set(roots.map(findGitMetadataRoot).filter((root): root is string => Boolean(root)))];
  const entries = await Promise.all(gitRoots.map(async (root) => {
    const commit = await readGitHead(root);
    return commit ? [resolve(root), commit] as const : undefined;
  }));
  const commits = Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => Boolean(entry)));
  const primaryGitRoot = primaryRoot ? findGitMetadataRoot(primaryRoot) : undefined;
  return {
    commits,
    ...(primaryGitRoot ? { primaryCommit: commits[primaryGitRoot] } : {}),
  };
}

async function readGitHead(gitRoot: string): Promise<string | undefined> {
  try {
    const dotGit = resolve(gitRoot, ".git");
    const dotGitStat = await stat(dotGit);
    const gitDirectory = dotGitStat.isDirectory()
      ? dotGit
      : resolve(gitRoot, (await readFile(dotGit, "utf8")).trim().replace(/^gitdir:\s*/i, ""));
    const head = (await readFile(resolve(gitDirectory, "HEAD"), "utf8")).trim();
    if (/^[0-9a-f]{40,64}$/i.test(head)) return head;
    const ref = head.match(/^ref:\s+(.+)$/i)?.[1];
    if (!ref) return undefined;
    const commonDirectory = await readFile(resolve(gitDirectory, "commondir"), "utf8")
      .then((value) => resolve(gitDirectory, value.trim()), () => gitDirectory);
    for (const directory of [gitDirectory, commonDirectory]) {
      const commit = await readFile(resolve(directory, ref), "utf8").then((value) => value.trim(), () => "");
      if (/^[0-9a-f]{40,64}$/i.test(commit)) return commit;
    }
    const packedRefs = await readFile(resolve(commonDirectory, "packed-refs"), "utf8").catch(() => "");
    const packedCommit = packedRefs.split(/\r?\n/)
      .find((line) => line.endsWith(` ${ref}`))
      ?.split(" ", 1)[0];
    return packedCommit && /^[0-9a-f]{40,64}$/i.test(packedCommit) ? packedCommit : undefined;
  } catch {
    return undefined;
  }
}

function mergeFileChangeStats(
  statsByPath: Map<string, FileChangeStats>,
  path: string,
  next: FileChangeStats | undefined
): void {
  if (!next) return;
  const previous = statsByPath.get(path) ?? { addedLines: 0, removedLines: 0 };
  statsByPath.set(path, {
    addedLines: previous.addedLines + next.addedLines,
    removedLines: previous.removedLines + next.removedLines,
  });
}

function readFileChangeStats(result: ToolResult): FileChangeStats | undefined {
  const meta = result._meta?.file;
  if (!meta || typeof meta !== "object") return undefined;
  const record = meta as Record<string, unknown>;
  const addedLines = Number(record.linesAdded);
  const removedLines = Number(record.linesRemoved);
  if (!Number.isFinite(addedLines) || !Number.isFinite(removedLines)) return undefined;
  return {
    addedLines: Math.max(0, addedLines),
    removedLines: Math.max(0, removedLines),
  };
}

function isVerificationCommand(command: string, purpose: string): boolean {
  if (purpose.trim().toLowerCase() === "verification") return true;
  return /(^|\s)(test|tests|typecheck|tsc|lint|build|check|verify|vitest|jest)(\s|$)/i.test(command);
}

function isLikelyMutationCommand(input: { input: unknown }): boolean {
  const raw = input.input && typeof input.input === "object" ? input.input as Record<string, unknown> : {};
  const command = typeof raw.command === "string" ? raw.command : "";
  return /(^|\s)(rm|mv|cp|mkdir|rmdir|touch|del|copy|move|git\s+(apply|checkout|clean|reset)|sed\s+-i|perl\s+-i)(\s|$)/i.test(command)
    || /(?:>>?|\|\s*(?:tee|Set-Content)|Set-Content|Out-File|writeFile|write_text|unlink\s*\()/i.test(command);
}

function readShellMutationPaths(input: unknown, cwd: string, workspaceRoots: string[]): string[] {
  if (!input || typeof input !== "object") return [];
  const command = (input as Record<string, unknown>).command;
  if (typeof command !== "string" || !command) return [];
  const rawPaths: string[] = [];
  const collect = (pattern: RegExp) => {
    for (const match of command.matchAll(pattern)) {
      const value = match.slice(1).find((candidate) => Boolean(candidate?.trim()));
      if (value) rawPaths.push(value);
    }
  };
  collect(/>>?\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g);
  collect(/(?:Set-Content|Out-File)\b[^\r\n]*?-(?:LiteralPath|Path)\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gi);
  collect(/\bPath\(\s*(?:"([^"]+)"|'([^']+)')\s*\)\.(?:write_text|write_bytes|touch|unlink)\b/g);
  return [...new Set(rawPaths
    .filter((path) => !/[$%`*?]/.test(path))
    .map((path) => resolve(cwd, path)))]
    .filter((path) => workspaceRoots.some((root) => isPathInside(root, path)));
}

function readMutationPath(
  input: unknown,
  result: ToolResult,
  workspaceRoot: string | undefined,
  workspaceRoots: string[],
): string | undefined {
  const resolvedPath = result._meta?.file && typeof result._meta.file === "object"
    ? (result._meta.file as Record<string, unknown>).path
    : undefined;
  if (typeof resolvedPath === "string" && workspaceRoots.some((root) => isPathInside(root, resolvedPath))) {
    return resolve(resolvedPath);
  }
  if (!input || typeof input !== "object") return undefined;
  const value = (input as Record<string, unknown>).file_path
    ?? (input as Record<string, unknown>).notebook_path
    ?? (input as Record<string, unknown>).path;
  if (typeof value !== "string" || !value.trim() || !workspaceRoot) return undefined;
  const canonical = resolve(workspaceRoot, value);
  return workspaceRoots.some((root) => isPathInside(root, canonical)) ? canonical : undefined;
}

function uniqueWorkspaceRoots(workspaceRoot?: string, additionalRoots: string[] = []): string[] {
  const roots = [workspaceRoot, ...additionalRoots]
    .filter((root): root is string => Boolean(root))
    .map((root) => resolve(root));
  return [...new Set(roots.map((root) => process.platform === "win32" ? root.toLowerCase() : root))]
    .map((normalized) => roots.find((root) => (
      (process.platform === "win32" ? root.toLowerCase() : root) === normalized
    ))!);
}

function sameWorkspaceRoots(left: string[], right: string[]): boolean {
  const normalizeRoot = (root: string) => process.platform === "win32"
    ? resolve(root).toLowerCase()
    : resolve(root);
  return [...left].map(normalizeRoot).sort().join("\n") === [...right].map(normalizeRoot).sort().join("\n");
}

function displayWorkspacePath(path: string, workspaceRoot?: string): string {
  if (!workspaceRoot || !isPathInside(workspaceRoot, path)) return path;
  return relative(workspaceRoot, path).split("\\").join("/");
}

async function waitForSettled(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise.then(() => undefined, () => undefined),
    new Promise<void>((resolveTimeout) => {
      timer = setTimeout(resolveTimeout, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    promise.then((value) => ({ settled: true as const, value }), () => ({ settled: false as const })),
    new Promise<{ settled: false }>((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout({ settled: false }), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return result.settled ? result.value : undefined;
}

function stringifyResult(result: ToolResult): string {
  if (typeof result.content === "string") return result.content.slice(0, 1000);
  try {
    return JSON.stringify(result.content).slice(0, 1000);
  } catch {
    return "工具验证失败";
  }
}

function verificationSignature(result: ToolResult): string {
  const text = stringifyResult(result);
  return `${result.is_error === true ? "error" : "ok"}:${text.slice(0, 2000)}`;
}

function getExecutionMetadata(result: ToolResult): {
  version?: number;
  outcome?: string;
  command?: string;
  purpose?: string;
  durationMs?: number;
  terminationReason?: string;
  semanticOutcome?: string;
} | undefined {
  const execution = result._meta?.execution;
  return execution && typeof execution === "object"
    ? execution as { version?: number; outcome?: string; command?: string; purpose?: string; durationMs?: number; terminationReason?: string; semanticOutcome?: string }
    : undefined;
}

function executionOutcome(execution: ReturnType<typeof getExecutionMetadata>): "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "interrupted" {
  if (execution?.version === 2) {
    if (execution.outcome === "running" || execution.outcome === "succeeded" || execution.outcome === "failed"
      || execution.outcome === "timed_out" || execution.outcome === "cancelled" || execution.outcome === "interrupted") {
      return execution.outcome;
    }
    return "failed";
  }
  if (execution?.terminationReason === "running") return "running";
  if (execution?.terminationReason === "completed") return "succeeded";
  if (execution?.terminationReason === "timeout") return "timed_out";
  if (execution?.terminationReason === "aborted") return "cancelled";
  if (execution?.terminationReason === "interrupted") return "interrupted";
  return "failed";
}

function getTaskMetadata(result: ToolResult): {
  id?: string;
  status?: string;
  autoBackgrounded?: boolean;
} | undefined {
  const task = result._meta?.task;
  return task && typeof task === "object"
    ? task as { id?: string; status?: string; autoBackgrounded?: boolean }
    : undefined;
}

function normalizeCodingExitStatus(status: string): "completed" | "failed" | "stopped" {
  if (status === "completed") return "completed";
  if (status === "stopped" || status === "cancelled" || status === "aborted") return "stopped";
  return "failed";
}
