/**
 * 会话级 Vault focus 状态（移植自 Proma 的 setVaultUserContext）：
 * renderer 只提交相对路径，sidecar 校验后按 threadId 存储；过期序列号被
 * 丢弃，切换/关闭集成后旧 focus 自动失效。线程删除时必须清理。
 */
import { basename } from "node:path";
import type { ObsidianVaultFocus } from "@lume/shared";
import { resolveAuthorizedVaultRoot } from "./vault-registry";
import { resolveSafeVaultEntry } from "./vault-facade";

export interface ObsidianVaultFocusSnapshot {
  vaultPath: string
  displayName: string
  focus: ObsidianVaultFocus
  openedAt: number
}

const focusByThread = new Map<string, ObsidianVaultFocusSnapshot>()

function normalizeFocus(focus: ObsidianVaultFocus): ObsidianVaultFocus {
  if (!focus || (focus.kind !== "file" && focus.kind !== "folder") || !Number.isSafeInteger(focus.sequence) || focus.sequence < 0) {
    throw new Error("Vault focus 非法");
  }
  return focus;
}

export function setObsidianVaultFocus(threadId: string, vaultPath: string, focus: ObsidianVaultFocus): void {
  if (!threadId) return;
  const normalized = normalizeFocus(focus);
  const root = resolveAuthorizedVaultRoot(vaultPath);
  const previous = focusByThread.get(threadId);
  if (previous && normalized.sequence < previous.focus.sequence) return;
  focusByThread.set(threadId, {
    vaultPath: root,
    displayName: basename(root) || "Vault",
    focus: { kind: normalized.kind, relativePath: resolveSafeVaultEntry(root, normalized.kind, normalized.relativePath), sequence: normalized.sequence },
    openedAt: Date.now(),
  });
}

export function getObsidianVaultFocus(threadId: string): ObsidianVaultFocusSnapshot | null {
  const snapshot = focusByThread.get(threadId);
  if (!snapshot) return null;
  try {
    // 集成关闭或该 vault 已不在授权集时立即失效，绝不让 agent 带着过期授权跑。
    const root = resolveAuthorizedVaultRoot(snapshot.vaultPath);
    return { ...snapshot, focus: { ...snapshot.focus, relativePath: resolveSafeVaultEntry(root, snapshot.focus.kind, snapshot.focus.relativePath) } };
  } catch {
    focusByThread.delete(threadId);
    return null;
  }
}

export function clearObsidianVaultFocus(threadId: string): void {
  focusByThread.delete(threadId);
}
