import type { CompletionGuardResult, ToolResult } from "@lume/agent-sdk";
import type { RuntimeCodingChangeSet } from "@lume/shared";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, relative, resolve } from "node:path";
import {
  captureWorkspaceSnapshot,
  diffWorkspaceSnapshots,
  flattenWorkspaceSnapshotDiff,
  type WorkspaceSnapshot,
  type WorkspaceSnapshotDiff
} from "./workspace-snapshot";
import { getCodingChangeSet } from "./coding-change-service";

export type CodingVerificationStatus = "not_required" | "unverified" | "verified" | "failed";

export interface CodingVerificationReport {
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
  approvalRequestCount?: number;
  turnId?: string;
  userMessageId?: string;
  routeReason?: string;
  toolSelectionReason?: string;
  baselineCommit?: string;
}

interface PersistedCodingRunState {
  version: 1;
  workspaceRoot: string;
  baselineCommit?: string;
  baselineSnapshot?: WorkspaceSnapshot;
  latestSnapshot?: WorkspaceSnapshot;
  mutationObserved: boolean;
  verificationStatus: CodingVerificationStatus;
  verificationMessage: string;
  promptedWithoutEvidence: boolean;
  baselineVerification?: { command: string; signature: string };
  baselineFailure?: { command: string; signature: string };
  attributedCandidates: string[];
  pendingBackground: boolean;
  verificationRepairAttempts?: number;
  verificationNoEvidenceAttempts?: number;
  backgroundWaitPrompted?: boolean;
  fileChangeStats?: Record<string, FileChangeStats>;
}

interface FileChangeStats {
  addedLines: number;
  removedLines: number;
}

export interface CodingRunTrackerOptions {
  workspaceRoot?: string;
  statePath?: string;
  turnId?: string;
  userMessageId?: string;
  routeReason?: string;
  toolSelectionReason?: string;
}

export function createCodingRunTracker(options: CodingRunTrackerOptions = {}) {
  let mutationObserved = false;
  let verificationStatus: CodingVerificationStatus = "not_required";
  let verificationMessage = "";
  let promptedWithoutEvidence = false;
  let baselineVerification: PersistedCodingRunState["baselineVerification"];
  let baselineFailure: PersistedCodingRunState["baselineFailure"];
  let baselineSnapshot: WorkspaceSnapshot | undefined;
  let latestSnapshot: WorkspaceSnapshot | undefined;
  let workspaceDiff: WorkspaceSnapshotDiff = { added: [], modified: [], deleted: [] };
  const attributedCandidates = new Set<string>();
  let pendingBackground = false;
  let verificationRepairAttempts = 0;
  let verificationNoEvidenceAttempts = 0;
  let backgroundWaitPrompted = false;
  const fileChangeStats = new Map<string, FileChangeStats>();
  let changeSet: RuntimeCodingChangeSet | undefined;
  let pendingSnapshot: Promise<void> = Promise.resolve();
  let baselineCommit: string | undefined;

  async function beforeToolExecution(input: {
    toolName: string;
    input: unknown;
    userMessageId?: string;
    cwd: string;
  }): Promise<void> {
    if (!options.workspaceRoot) return;
    pendingSnapshot = pendingSnapshot.then(async () => {
      try {
        latestSnapshot = await captureWorkspaceSnapshot(options.workspaceRoot!);
        persist();
      } catch {
        // The post-tool snapshot remains authoritative when a pre-snapshot fails.
      }
    });
    await pendingSnapshot;
  }

  function persist(): void {
    if (!options.statePath || !options.workspaceRoot) return;
    const state: PersistedCodingRunState = {
      version: 1,
      workspaceRoot: options.workspaceRoot,
      baselineCommit,
      baselineSnapshot,
      latestSnapshot,
      mutationObserved,
      verificationStatus,
      verificationMessage,
      promptedWithoutEvidence,
      baselineVerification,
      baselineFailure,
      attributedCandidates: [...attributedCandidates],
      pendingBackground,
      verificationRepairAttempts,
      verificationNoEvidenceAttempts,
      backgroundWaitPrompted,
      fileChangeStats: Object.fromEntries(fileChangeStats)
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
      if (state.version !== 1 || state.workspaceRoot !== options.workspaceRoot) return;
      baselineSnapshot = state.baselineSnapshot;
      baselineCommit = state.baselineCommit;
      latestSnapshot = state.latestSnapshot;
      if (baselineSnapshot && latestSnapshot) workspaceDiff = diffWorkspaceSnapshots(baselineSnapshot, latestSnapshot);
      mutationObserved = state.mutationObserved === true;
      verificationStatus = state.verificationStatus ?? "not_required";
      verificationMessage = state.verificationMessage ?? "";
      promptedWithoutEvidence = state.promptedWithoutEvidence === true;
      baselineVerification = state.baselineVerification;
      baselineFailure = state.baselineFailure;
      for (const path of state.attributedCandidates ?? []) attributedCandidates.add(path);
      pendingBackground = state.pendingBackground === true;
      verificationRepairAttempts = typeof state.verificationRepairAttempts === "number"
        ? Math.max(0, state.verificationRepairAttempts)
        : 0;
      verificationNoEvidenceAttempts = typeof state.verificationNoEvidenceAttempts === "number"
        ? Math.max(0, state.verificationNoEvidenceAttempts)
        : 0;
      backgroundWaitPrompted = state.backgroundWaitPrompted === true;
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
    } catch {
      // Ignore corrupt or partial state and establish a fresh baseline.
    }
  }

  async function initialize(): Promise<void> {
    restore();
    if (options.workspaceRoot) {
      const result = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: options.workspaceRoot,
        encoding: "utf8",
        windowsHide: true,
      });
      if (result.status === 0) baselineCommit = result.stdout.trim() || undefined;
    }
    if (!options.workspaceRoot || baselineSnapshot) return;
    try {
      baselineSnapshot = await captureWorkspaceSnapshot(options.workspaceRoot);
      latestSnapshot = baselineSnapshot;
      persist();
    } catch {
      // A missing or inaccessible workspace produces an unverified report later.
    }
  }

  function queueSnapshot(input: { toolName: string; input: unknown; result: ToolResult }): void {
    const toolName = input.toolName;
    const result = input.result;
    if (!options.workspaceRoot) return;
    const name = toolName.toLowerCase();
    const execution = getExecutionMetadata(result);
    const shouldSnapshot = name === "bash"
      || ["write", "edit", "notebookedit", "lsp"].includes(name)
      || (name === "taskoutput" && execution?.terminationReason !== "running");
    if (!shouldSnapshot) return;
    pendingSnapshot = pendingSnapshot.then(async () => {
      try {
        const snapshot = await captureWorkspaceSnapshot(options.workspaceRoot!);
        if (!baselineSnapshot) baselineSnapshot = snapshot;
        latestSnapshot = snapshot;
        workspaceDiff = diffWorkspaceSnapshots(baselineSnapshot, snapshot);
        const executionMutation = execution?.command
          ? isLikelyMutationCommand({ input: { command: execution.command } })
          : false;
        const observedWorkspaceChanges = flattenWorkspaceSnapshotDiff(workspaceDiff);
        const shellProducedChanges = name === "bash" && observedWorkspaceChanges.length > 0;
        const taskProducedChanges = name === "taskoutput"
          && execution?.terminationReason !== "running"
          && observedWorkspaceChanges.length > 0;
        if (shellProducedChanges || taskProducedChanges || (executionMutation && result.is_error !== true)) {
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
    const execution = getExecutionMetadata(input.result);
    if (name === "bash" && execution?.terminationReason === "running") pendingBackground = true;
    if (name === "taskoutput" && execution && execution.terminationReason !== "running") pendingBackground = false;
    const bashMutation = name === "bash" && isLikelyMutationCommand(input);
    if ((["write", "edit", "notebookedit", "lsp"].includes(name) || bashMutation) && input.result.is_error !== true) {
      mutationObserved = true;
      if (name !== "bash") {
        const path = readMutationPath(input.input, options.workspaceRoot);
        if (path) {
          attributedCandidates.add(path);
          mergeFileChangeStats(fileChangeStats, path, readFileChangeStats(input.result));
        }
      }
      if (verificationStatus === "verified" || verificationStatus === "not_required") verificationStatus = "unverified";
    }
    queueSnapshot(input);
    if (name !== "bash") {
      persist();
      return;
    }
    const raw = input.input && typeof input.input === "object" ? input.input as Record<string, unknown> : {};
    const command = typeof raw.command === "string" ? raw.command : "";
    const purpose = typeof raw.purpose === "string" ? raw.purpose : "";
    if (!isVerificationCommand(command, purpose)) {
      persist();
      return;
    }
    const signature = verificationSignature(input.result);
    if (getExecutionMetadata(input.result)?.semanticOutcome === "no_matches" && input.result.is_error !== true) {
      verificationNoEvidenceAttempts += 1;
      verificationStatus = "unverified";
      verificationMessage = "验证命令只返回了搜索无匹配，未提供完整测试或类型检查结果。请直接运行原始验证命令，不要用 grep、findstr、Select-String 或 head 过滤。";
      promptedWithoutEvidence = false;
      persist();
      return;
    }
    if (!mutationObserved && input.result.is_error === true) {
      baselineVerification = { command, signature };
      persist();
      return;
    }
    if (input.result.is_error === true) {
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
    if (pendingBackground) {
      if (backgroundWaitPrompted) {
        return {
          type: "stop",
          errorCode: "background_pending",
          message: "后台命令仍未结束，已停止本轮以避免重复等待。"
        };
      }
      backgroundWaitPrompted = true;
      persist();
      return "[background pending] 后台命令仍在运行，请在当前 Run 中使用 ProcessOutput 等待其终态后再完成。";
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
    return "[verification needed] 当前 Run 已产生文件或命令变更。请执行相关测试、类型检查、Lint、构建或最小验证；若项目没有可靠入口，完成时明确说明未验证。";
  }

  return {
    observe,
    initialize,
    beforeToolExecution,
    getBaselineCommit: () => baselineCommit,
    completionGuard,
    getVerificationStatus: () => verificationStatus,
    getVerificationReport: (): CodingVerificationReport => {
      const snapshotChangedFiles = flattenWorkspaceSnapshotDiff(workspaceDiff).filter((path) => attributedCandidates.has(path));
      const authoritativeFiles = changeSet?.files.map((file) => file.path) ?? [];
      const changedFiles = [...new Set([...snapshotChangedFiles, ...authoritativeFiles])];
      const externalChangedFiles = flattenWorkspaceSnapshotDiff(workspaceDiff).filter((path) => !attributedCandidates.has(path));
      const authoritativeChangeSet = changeSet?.isGitRepo ? changeSet : undefined;
      const fileChanges = authoritativeChangeSet?.files.length
        ? authoritativeChangeSet.files
        : changedFiles.map((path) => ({
          path,
          ...(fileChangeStats.has(path) ? fileChangeStats.get(path) : {})
        }));
      const totalAddedLines = authoritativeChangeSet?.totalAddedLines
        ?? fileChanges.reduce((sum, change) => sum + (change.addedLines ?? 0), 0);
      const totalRemovedLines = authoritativeChangeSet?.totalRemovedLines
        ?? fileChanges.reduce((sum, change) => sum + (change.removedLines ?? 0), 0);
      return {
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
        ...(options.turnId ? { turnId: options.turnId } : {}),
        ...(options.userMessageId ? { userMessageId: options.userMessageId } : {}),
        ...(options.routeReason ? { routeReason: options.routeReason } : {}),
        ...(options.toolSelectionReason ? { toolSelectionReason: options.toolSelectionReason } : {}),
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
    const absolutePaths = [...attributedCandidates].map((path) => resolve(workspaceRoot, path));
    return getCodingChangeSet(workspaceRoot, { paths: absolutePaths, turnId: options.turnId });
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
  return /(^|\s)(test|tests|typecheck|tsc|lint|build|check|verify|vitest|jest|bun)(\s|$)/i.test(command);
}

function isLikelyMutationCommand(input: { input: unknown }): boolean {
  const raw = input.input && typeof input.input === "object" ? input.input as Record<string, unknown> : {};
  const command = typeof raw.command === "string" ? raw.command : "";
  return /(^|\s)(rm|mv|cp|mkdir|rmdir|touch|del|copy|move|npm|pnpm|yarn|bun|git\s+(apply|checkout|clean|reset)|sed\s+-i|perl\s+-i)(\s|$)/i.test(command)
    || /(?:>>?|\|\s*(?:tee|Set-Content)|Set-Content|Out-File|writeFile|write_text|unlink\s*\()/i.test(command);
}

function readMutationPath(input: unknown, workspaceRoot?: string): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = (input as Record<string, unknown>).file_path
    ?? (input as Record<string, unknown>).notebook_path
    ?? (input as Record<string, unknown>).path;
  if (typeof value !== "string" || !value.trim() || !workspaceRoot) return undefined;
  const canonical = resolve(workspaceRoot, value);
  const relativePath = relative(workspaceRoot, canonical).split("\\").join("/");
  return relativePath === ".." || relativePath.startsWith("../") ? undefined : relativePath;
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
  command?: string;
  terminationReason?: string;
  semanticOutcome?: string;
} | undefined {
  const execution = result._meta?.execution;
  return execution && typeof execution === "object"
    ? execution as { command?: string; terminationReason?: string }
    : undefined;
}
