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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  captureWorkspaceSnapshot,
  diffWorkspaceSnapshots,
  flattenWorkspaceSnapshotDiff,
  type WorkspaceSnapshot,
  type WorkspaceSnapshotDiff
} from "./workspace-snapshot";
import { discoverCodingRoots, getCodingChangeSet } from "./coding-change-service";
import {
  selectVerificationCommands,
  selectVerificationCommandsForWorkspaces,
} from "./coding-verification";

export type CodingVerificationStatus = "not_required" | "unverified" | "verified" | "failed";

/** 执行前钩子等待快照链的上限：正常快照毫秒级，超时只可能是异常环境。 */
const SNAPSHOT_WAIT_TIMEOUT_MS = 10_000;

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
  lspDiagnostics?: {
    files: string[];
    total: number;
    errors: number;
    warnings: number;
    updatedAt: string;
  };
  gitActions?: CodingGitAction[];
  approvalRequestCount?: number;
  turnId?: string;
  userMessageId?: string;
  baselineCommit?: string;
}

interface PersistedCodingRunState {
  version: 1 | 2;
  workspaceRoot: string;
  workspaceRoots?: string[];
  baselineCommit?: string;
  baselineCommits?: Record<string, string>;
  baselineSnapshot?: WorkspaceSnapshot;
  latestSnapshot?: WorkspaceSnapshot;
  baselineSnapshots?: Record<string, WorkspaceSnapshot>;
  latestSnapshots?: Record<string, WorkspaceSnapshot>;
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
  lspDiagnostics?: Record<string, {
    total: number;
    errors: number;
    warnings: number;
    updatedAt: string;
  }>;
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
  let mutationObserved = false;
  let verificationStatus: CodingVerificationStatus = "not_required";
  let verificationMessage = "";
  let promptedWithoutEvidence = false;
  let baselineVerification: PersistedCodingRunState["baselineVerification"];
  let baselineFailure: PersistedCodingRunState["baselineFailure"];
  let workspaceDiff: WorkspaceSnapshotDiff = { added: [], modified: [], deleted: [] };
  let baselineSnapshots: Record<string, WorkspaceSnapshot> = {};
  let latestSnapshots: Record<string, WorkspaceSnapshot> = {};
  let workspaceDiffs: Record<string, WorkspaceSnapshotDiff> = {};
  const attributedCandidates = new Set<string>();
  let pendingBackground = false;
  const pendingBackgroundTaskIds = new Set<string>();
  const pendingVerificationTaskIds = new Set<string>();
  let verificationRepairAttempts = 0;
  let verificationNoEvidenceAttempts = 0;
  const fileChangeStats = new Map<string, FileChangeStats>();
  let changeSet: RuntimeCodingChangeSet | undefined;
  let pendingSnapshot: Promise<void> = Promise.resolve();
  let baselineCommit: string | undefined;
  let baselineCommits: Record<string, string> = {};
  const verificationRecords: CodingVerificationRecord[] = [];
  const lspDiagnostics = new Map<string, {
    total: number;
    errors: number;
    warnings: number;
    updatedAt: string;
  }>();
  const gitActions: CodingGitAction[] = [];
  let recommendedVerificationCommands: string[] = [];

  async function beforeToolExecution(input: {
    toolName: string;
    input: unknown;
    userMessageId?: string;
    cwd: string;
  }): Promise<void> {
    if (workspaceRoots.length === 0) return;
    pendingSnapshot = pendingSnapshot.then(async () => {
      try {
        latestSnapshots = await captureWorkspaceSnapshots(workspaceRoots);
        persist();
      } catch {
        // The post-tool snapshot remains authoritative when a pre-snapshot fails.
      }
    });
    // 兜底：扫描链被异常环境（网络盘/杀毒实时扫描）拖长时放行工具执行，
    // 快照在后台继续收敛，避免工具在执行前钩子上永久 pending（issue #90）。
    await raceSettled(pendingSnapshot, SNAPSHOT_WAIT_TIMEOUT_MS);
  }

  function persist(): void {
    if (!options.statePath || !options.workspaceRoot) return;
    const state: PersistedCodingRunState = {
      version: 2,
      workspaceRoot: options.workspaceRoot,
      workspaceRoots,
      baselineCommit,
      baselineCommits,
      // v2 只持久化集合字段；单根 baselineSnapshot/latestSnapshot 是旧版冗余
      // （同棵树在 state 里出现两次，issue #90 的 245MB 直接来源），读取兼容保留在 restore。
      baselineSnapshots,
      latestSnapshots,
      mutationObserved,
      verificationStatus,
      verificationMessage,
      promptedWithoutEvidence,
      baselineVerification,
      baselineFailure,
      attributedCandidates: [...attributedCandidates],
      pendingBackground,
      pendingBackgroundTaskIds: [...pendingBackgroundTaskIds],
      pendingVerificationTaskIds: [...pendingVerificationTaskIds],
      verificationRepairAttempts,
      verificationNoEvidenceAttempts,
      fileChangeStats: Object.fromEntries(fileChangeStats),
      verificationRecords,
      lspDiagnostics: Object.fromEntries(lspDiagnostics),
      gitActions
    };
    try {
      mkdirSync(dirname(options.statePath), { recursive: true });
      const tempPath = `${options.statePath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tempPath, JSON.stringify(state), "utf-8");
      renameSync(tempPath, options.statePath);
    } catch {
      // State persistence is best effort; the in-memory guard remains authoritative.
    }
  }

  function restore(): void {
    if (!options.statePath || !options.workspaceRoot || !existsSync(options.statePath)) return;
    try {
      const state = JSON.parse(readFileSync(options.statePath, "utf-8")) as Partial<PersistedCodingRunState>;
      if ((state.version !== 1 && state.version !== 2) || state.workspaceRoot !== options.workspaceRoot) return;
      if (state.version === 2 && state.workspaceRoots && !sameWorkspaceRoots(state.workspaceRoots, workspaceRoots)) return;
      baselineCommit = state.baselineCommit;
      baselineCommits = state.baselineCommits ?? {};
      baselineSnapshots = state.baselineSnapshots ?? (
        state.baselineSnapshot ? { [resolve(options.workspaceRoot)]: state.baselineSnapshot } : {}
      );
      latestSnapshots = state.latestSnapshots ?? (
        state.latestSnapshot ? { [resolve(options.workspaceRoot)]: state.latestSnapshot } : {}
      );
      workspaceDiffs = diffSnapshotCollections(baselineSnapshots, latestSnapshots);
      workspaceDiff = options.workspaceRoot
        ? workspaceDiffs[resolve(options.workspaceRoot)] ?? { added: [], modified: [], deleted: [] }
        : { added: [], modified: [], deleted: [] };
      mutationObserved = state.mutationObserved === true;
      verificationStatus = state.verificationStatus ?? "not_required";
      verificationMessage = state.verificationMessage ?? "";
      promptedWithoutEvidence = state.promptedWithoutEvidence === true;
      baselineVerification = state.baselineVerification;
      baselineFailure = state.baselineFailure;
      for (const path of state.attributedCandidates ?? []) attributedCandidates.add(path);
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
      verificationRecords.splice(0, verificationRecords.length, ...(state.verificationRecords ?? []).slice(-8));
      for (const [path, diagnostics] of Object.entries(state.lspDiagnostics ?? {})) {
        if (!diagnostics || typeof diagnostics !== "object") continue;
        lspDiagnostics.set(path, diagnostics);
      }
      gitActions.splice(0, gitActions.length, ...(state.gitActions ?? []).slice(-16));
      }
    } catch {
      // Ignore corrupt or partial state and establish a fresh baseline.
    }
  }

  async function initialize(): Promise<void> {
    restore();
    if (options.workspaceRoot) {
      if (hasGitMetadata(options.workspaceRoot)) {
        const result = spawnSync("git", ["rev-parse", "HEAD"], {
          cwd: options.workspaceRoot,
          encoding: "utf8",
          windowsHide: true,
          timeout: 1000,
        });
        if (result.status === 0) baselineCommit = result.stdout.trim() || undefined;
      }
    }
    if (Object.keys(baselineCommits).length === 0) {
      baselineCommits = captureGitBaselines(workspaceRoots);
    }
    if (workspaceRoots.length === 0 || Object.keys(baselineSnapshots).length > 0) return;
    try {
      baselineSnapshots = await captureWorkspaceSnapshots(workspaceRoots);
      latestSnapshots = baselineSnapshots;
      persist();
    } catch {
      // A missing or inaccessible workspace produces an unverified report later.
    }
  }

  function queueSnapshot(input: { toolName: string; input: unknown; result: ToolResult }): void {
    const toolName = input.toolName;
    const result = input.result;
    if (workspaceRoots.length === 0) return;
    const name = toolName.toLowerCase();
    const isProcessOutput = name === "taskoutput" || name === "processoutput";
    const execution = getExecutionMetadata(result);
    const task = getTaskMetadata(result);
    const processOutputRunning = task?.status
      ? task.status === "running"
      : execution?.terminationReason === "running";
    const shouldSnapshot = name === "bash"
      || ["write", "edit", "notebookedit", "lsp"].includes(name)
      || (isProcessOutput && !processOutputRunning);
    if (!shouldSnapshot) return;
    pendingSnapshot = pendingSnapshot.then(async () => {
      try {
        const snapshots = await captureWorkspaceSnapshots(workspaceRoots);
        if (Object.keys(baselineSnapshots).length === 0) baselineSnapshots = snapshots;
        latestSnapshots = snapshots;
        workspaceDiffs = diffSnapshotCollections(baselineSnapshots, snapshots);
        workspaceDiff = options.workspaceRoot
          ? workspaceDiffs[resolve(options.workspaceRoot)] ?? { added: [], modified: [], deleted: [] }
          : { added: [], modified: [], deleted: [] };
        const executionMutation = execution?.command
          ? isLikelyMutationCommand({ input: { command: execution.command } })
          : false;
        const observedWorkspaceChanges = flattenAbsoluteWorkspaceChanges(workspaceDiffs);
        const shellProducedChanges = name === "bash" && observedWorkspaceChanges.length > 0;
        const taskProducedChanges = isProcessOutput
          && !processOutputRunning
          && observedWorkspaceChanges.length > 0;
        const fileToolProducedChanges = ["write", "edit", "notebookedit", "lsp"].includes(name)
          && result.is_error !== true
          && observedWorkspaceChanges.length > 0;
        if (shellProducedChanges || taskProducedChanges || fileToolProducedChanges || (executionMutation && result.is_error !== true)) {
          for (const path of observedWorkspaceChanges) attributedCandidates.add(path);
          mutationObserved = true;
          if (verificationStatus === "verified" || verificationStatus === "not_required") verificationStatus = "unverified";
        }
        persist();
      } catch {
        // Keep the previous snapshot; direct mutation evidence still applies.
      }
    });
  }

  function observe(input: { toolName: string; input: unknown; result: ToolResult }): void {
    const name = input.toolName.toLowerCase();
    const isProcessOutput = name === "taskoutput" || name === "processoutput";
    const execution = getExecutionMetadata(input.result);
    const task = getTaskMetadata(input.result);
    const raw = input.input && typeof input.input === "object" ? input.input as Record<string, unknown> : {};
    const shellCommand = typeof raw.command === "string" ? raw.command : execution?.command ?? "";
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
    if ((["write", "edit", "notebookedit", "lsp"].includes(name) || bashMutation) && input.result.is_error !== true) {
      mutationObserved = true;
      if (name !== "bash") {
        const path = readMutationPath(input.input, input.result, options.workspaceRoot, workspaceRoots);
        if (path) {
          attributedCandidates.add(path);
          mergeFileChangeStats(fileChangeStats, path, readFileChangeStats(input.result));
        }
      }
      if (verificationStatus === "verified" || verificationStatus === "not_required") verificationStatus = "unverified";
    }
    queueSnapshot(input);
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
    await pendingSnapshot;
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
      changeSet = await refreshAuthoritativeChangeSet();
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
    if (workspaceRoot && changeSet?.files.some((file) => file.rootId)) {
      const discoveredRoots = await discoverCodingRoots(workspaceRoots);
      recommendedVerificationCommands = selectVerificationCommandsForWorkspaces(
        discoveredRoots.map((root) => ({
          workspaceRoot: root.path,
          rootId: root.repository.rootId,
          changedFiles: changeSet?.files
            .filter((file) => file.rootId === root.repository.rootId)
            .map((file) => file.path) ?? [],
        }))
      ).map((candidate) => candidate.command);
    } else {
      recommendedVerificationCommands = workspaceRoot
        ? selectVerificationCommands({
          workspaceRoot,
          changedFiles: changeSet?.files.map((file) => file.path) ?? [],
        }).map((candidate) => candidate.command)
        : [];
    }
    const suggestions = recommendedVerificationCommands.length > 0
      ? `运行以下仓库已有验证脚本（最多选择相关的两项）：\n${recommendedVerificationCommands.map((command) => `- ${command}`).join("\n")}`
      : "当前仓库没有可可靠识别的验证脚本，请明确说明未验证，不要猜测命令。";
    return `[verification needed] 当前 Run 已产生文件或命令变更。${suggestions}`;
  }

  function observeAsyncEvent(message: SDKMessage): boolean {
    if (message.type === "system" && message.subtype === "lsp_diagnostics") {
      lspDiagnostics.set(message.file_path, {
        total: message.diagnostics.total,
        errors: message.diagnostics.errors,
        warnings: message.diagnostics.warnings,
        updatedAt: new Date().toISOString()
      });
      persist();
      return true;
    }
    if (message.type !== "system" || message.subtype !== "task_notification" || !message.execution) {
      return false;
    }
    const status = normalizeBackgroundTaskStatus(message.status);
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
    beforeToolExecution,
    getBaselineCommit: () => baselineCommit,
    getBaselineCommits: () => ({ ...baselineCommits }),
    completionGuard,
    getVerificationStatus: () => verificationStatus,
    getVerificationReport: (): CodingVerificationReport => {
      const allSnapshotChanges = flattenAbsoluteWorkspaceChanges(workspaceDiffs);
      const snapshotChangedFiles = allSnapshotChanges
        .filter((path) => attributedCandidates.has(path))
        .map((path) => displayWorkspacePath(path, options.workspaceRoot));
      const authoritativeFiles = changeSet?.files.map((file) => file.path) ?? [];
      const changedFiles = [...new Set([...snapshotChangedFiles, ...authoritativeFiles])];
      const externalChangedFiles = allSnapshotChanges
        .filter((path) => !attributedCandidates.has(path))
        .map((path) => displayWorkspacePath(path, options.workspaceRoot));
      const authoritativeChangeSet = changeSet?.isGitRepo ? changeSet : undefined;
      const fileChanges = authoritativeChangeSet?.files.length
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
      const lspEntries = [...lspDiagnostics.entries()];
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
        ...(lspEntries.length > 0 ? {
          lspDiagnostics: {
            files: lspEntries.map(([path]) => displayWorkspacePath(path, options.workspaceRoot)),
            total: lspEntries.reduce((sum, [, diagnostics]) => sum + diagnostics.total, 0),
            errors: lspEntries.reduce((sum, [, diagnostics]) => sum + diagnostics.errors, 0),
            warnings: lspEntries.reduce((sum, [, diagnostics]) => sum + diagnostics.warnings, 0),
            updatedAt: lspEntries.reduce((latest, [, diagnostics]) =>
              diagnostics.updatedAt > latest ? diagnostics.updatedAt : latest, ""
            )
          }
        } : {}),
        ...(recommendedVerificationCommands.length > 0 ? { recommendedVerificationCommands } : {}),
        gitActions: [...gitActions],
        ...(options.turnId ? { turnId: options.turnId } : {}),
        ...(options.userMessageId ? { userMessageId: options.userMessageId } : {}),
        ...(baselineCommit ? { baselineCommit } : {})
      };
    },
    refreshChangeSet: async () => {
      await pendingSnapshot;
      if (!options.workspaceRoot || !mutationObserved) return changeSet;
      changeSet = await refreshAuthoritativeChangeSet();
      return changeSet;
    }
  };

  async function refreshAuthoritativeChangeSet(): Promise<RuntimeCodingChangeSet> {
    const workspaceRoot = options.workspaceRoot!;
    const absolutePaths = [...attributedCandidates];
    return getCodingChangeSet(workspaceRoot, {
      paths: absolutePaths,
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

/** 等 promise 结算或超时先放行，二者取先；永不 reject。 */
function raceSettled(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<void>((resolve) => {
    timer = setTimeout(() => resolve(), timeoutMs);
    promise.then(() => resolve(), () => resolve());
  }).finally(() => clearTimeout(timer));
}

function hasGitMetadata(start: string): boolean {
  let current = resolve(start);
  while (true) {
    if (existsSync(resolve(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function captureGitBaselines(roots: string[]): Record<string, string> {
  const baselines: Record<string, string> = {};
  for (const root of roots) {
    if (!hasGitMetadata(root)) continue;
    const rootResult = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 1000,
    });
    const gitRoot = rootResult.status === 0 ? rootResult.stdout.trim() : "";
    if (!gitRoot || baselines[resolve(gitRoot)]) continue;
    const commitResult = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: gitRoot,
      encoding: "utf8",
      windowsHide: true,
      timeout: 1000,
    });
    const commit = commitResult.status === 0 ? commitResult.stdout.trim() : "";
    if (commit) baselines[resolve(gitRoot)] = commit;
  }
  return baselines;
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

async function captureWorkspaceSnapshots(roots: string[]): Promise<Record<string, WorkspaceSnapshot>> {
  const entries = await Promise.all(roots.map(async (root) => [root, await captureWorkspaceSnapshot(root)] as const));
  return Object.fromEntries(entries);
}

function diffSnapshotCollections(
  before: Record<string, WorkspaceSnapshot>,
  after: Record<string, WorkspaceSnapshot>,
): Record<string, WorkspaceSnapshotDiff> {
  return Object.fromEntries(Object.entries(after).map(([root, snapshot]) => [
    root,
    diffWorkspaceSnapshots(before[root], snapshot),
  ]));
}

function flattenAbsoluteWorkspaceChanges(diffs: Record<string, WorkspaceSnapshotDiff>): string[] {
  return [...new Set(Object.entries(diffs).flatMap(([root, diff]) => (
    flattenWorkspaceSnapshotDiff(diff).map((path) => resolve(root, path))
  )))];
}

function displayWorkspacePath(path: string, workspaceRoot?: string): string {
  if (!workspaceRoot || !isPathInside(workspaceRoot, path)) return path;
  return relative(workspaceRoot, path).split("\\").join("/");
}

function isPathInside(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
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

function normalizeBackgroundTaskStatus(status: string): "completed" | "failed" | "stopped" {
  if (status === "completed") return "completed";
  if (status === "stopped" || status === "cancelled" || status === "aborted") return "stopped";
  return "failed";
}
