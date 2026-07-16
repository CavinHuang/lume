import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ImPeerRef, ImThreadBinding } from "@lume/shared";
import { getImThreadBindingsPath } from "../infra/config-paths";
import { createLogger } from "../infra/logger";

const CONFIG_VERSION = 1;
const log = createLogger("im-thread-bindings");

interface ImThreadBindingConfig {
  version: number;
  bindings: ImThreadBinding[];
}

export interface UpsertImThreadBindingInput extends ImPeerRef {
  peerName?: string;
  threadId: string;
  contextToken?: string;
}

function readConfig(): ImThreadBindingConfig {
  const path = getImThreadBindingsPath();
  if (!existsSync(path)) {
    return { version: CONFIG_VERSION, bindings: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<ImThreadBindingConfig>;
    return {
      version: Math.max(parsed.version ?? CONFIG_VERSION, CONFIG_VERSION),
      bindings: Array.isArray(parsed.bindings) ? parsed.bindings : []
    };
  } catch (error) {
    log.error("failed to read IM thread bindings", { error });
    return { version: CONFIG_VERSION, bindings: [] };
  }
}

function writeConfig(config: ImThreadBindingConfig): void {
  writeFileSync(getImThreadBindingsPath(), JSON.stringify(config, null, 2), "utf-8");
}

export function createImBindingKey(ref: ImPeerRef): string {
  return `${ref.provider}/${ref.accountId}/${ref.peerKind}/${ref.peerId}`;
}

export function listImThreadBindings(): ImThreadBinding[] {
  return readConfig().bindings;
}

export function getImThreadBindingByPeer(ref: ImPeerRef): ImThreadBinding | null {
  const key = createImBindingKey(ref);
  return readConfig().bindings.find((binding) => binding.key === key) ?? null;
}

export function getImThreadBindingByThreadId(threadId: string): ImThreadBinding | null {
  return readConfig().bindings.find((binding) => binding.threadId === threadId) ?? null;
}

export function upsertImThreadBinding(input: UpsertImThreadBindingInput): ImThreadBinding {
  const config = readConfig();
  const key = createImBindingKey(input);
  const now = Date.now();
  const index = config.bindings.findIndex((binding) => binding.key === key);
  if (index >= 0) {
    const existing = config.bindings[index] as ImThreadBinding;
    const updated: ImThreadBinding = {
      ...existing,
      peerName: input.peerName ?? existing.peerName,
      contextToken: input.contextToken ?? existing.contextToken,
      updatedAt: now
    };
    config.bindings[index] = updated;
    writeConfig(config);
    return updated;
  }

  const binding: ImThreadBinding = {
    key,
    provider: input.provider,
    accountId: input.accountId,
    peerKind: input.peerKind,
    peerId: input.peerId,
    peerName: input.peerName,
    threadId: input.threadId,
    contextToken: input.contextToken,
    createdAt: now,
    updatedAt: now
  };
  config.bindings.push(binding);
  writeConfig(config);
  return binding;
}

export function deleteImThreadBindingsForAccount(accountId: string): void {
  const config = readConfig();
  const nextBindings = config.bindings.filter((binding) => binding.accountId !== accountId);
  if (nextBindings.length === config.bindings.length) return;
  writeConfig({ ...config, bindings: nextBindings });
}

export function listImThreadBindingsForThreadIds(threadIds: Set<string>): ImThreadBinding[] {
  return readConfig().bindings.filter((binding) => threadIds.has(binding.threadId));
}

export function deleteImThreadBindingsForThreadIds(threadIds: Set<string>): ImThreadBinding[] {
  const config = readConfig();
  const removed = config.bindings.filter((binding) => threadIds.has(binding.threadId));
  if (removed.length === 0) return [];
  const nextBindings = config.bindings.filter((binding) => !threadIds.has(binding.threadId));
  writeConfig({ ...config, bindings: nextBindings });
  return removed;
}
