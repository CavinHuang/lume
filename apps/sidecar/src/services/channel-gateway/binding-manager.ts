import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { ChannelSessionBinding, ChannelProvider } from "@lume/shared";
import { getChannelGatewayBindingsPath } from "../config-paths";

interface ChannelBindingsIndex {
  version: number;
  bindings: ChannelSessionBinding[];
}

const INDEX_VERSION = 1;

function writeAtomic(path: string, payload: string): void {
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, payload, "utf-8");
  renameSync(tmpPath, path);
}

function readIndex(): ChannelBindingsIndex {
  const path = getChannelGatewayBindingsPath();
  if (!existsSync(path)) {
    return { version: INDEX_VERSION, bindings: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as ChannelBindingsIndex;
    if (!Array.isArray(parsed.bindings)) {
      throw new Error("bindings 字段缺失");
    }
    return { version: INDEX_VERSION, bindings: parsed.bindings };
  } catch (error) {
    console.error("[ChannelGateway] 读取 bindings 失败:", error);
    return { version: INDEX_VERSION, bindings: [] };
  }
}

function writeIndex(index: ChannelBindingsIndex): void {
  writeAtomic(getChannelGatewayBindingsPath(), JSON.stringify(index, null, 2));
}

export function listChannelSessionBindings(): ChannelSessionBinding[] {
  return readIndex().bindings.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function findChannelSessionBinding(input: {
  provider: ChannelProvider;
  externalChatId: string;
  externalUserId?: string;
}): ChannelSessionBinding | null {
  const bindings = readIndex().bindings;
  return bindings.find((item) =>
    item.provider === input.provider
    && item.externalChatId === input.externalChatId
    && (input.externalUserId ? item.externalUserId === input.externalUserId : true)
  ) ?? null;
}

export function upsertChannelSessionBinding(input: {
  provider: ChannelProvider;
  externalChatId: string;
  externalUserId?: string;
  workspaceId?: string;
  sessionId: string;
}): ChannelSessionBinding {
  const index = readIndex();
  const now = Date.now();
  const existingIndex = index.bindings.findIndex((item) =>
    item.provider === input.provider
    && item.externalChatId === input.externalChatId
    && (input.externalUserId ? item.externalUserId === input.externalUserId : true)
  );
  if (existingIndex >= 0) {
    const current = index.bindings[existingIndex] as ChannelSessionBinding;
    const updated: ChannelSessionBinding = {
      ...current,
      externalUserId: input.externalUserId ?? current.externalUserId,
      workspaceId: input.workspaceId ?? current.workspaceId,
      sessionId: input.sessionId,
      updatedAt: now
    };
    index.bindings[existingIndex] = updated;
    writeIndex(index);
    return updated;
  }

  const created: ChannelSessionBinding = {
    id: randomUUID(),
    provider: input.provider,
    externalChatId: input.externalChatId,
    ...(input.externalUserId ? { externalUserId: input.externalUserId } : {}),
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    sessionId: input.sessionId,
    createdAt: now,
    updatedAt: now
  };
  index.bindings.push(created);
  writeIndex(index);
  return created;
}

