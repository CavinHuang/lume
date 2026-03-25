import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { ChannelProvider, ChannelRetryItem } from "@lume/shared";
import { getChannelGatewayRetryQueuePath } from "../infra/config-paths";

interface RetryQueueIndex {
  version: number;
  items: ChannelRetryItem[];
}

const INDEX_VERSION = 1;

function writeAtomic(path: string, payload: string): void {
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, payload, "utf-8");
  renameSync(tmpPath, path);
}

function readIndex(): RetryQueueIndex {
  const path = getChannelGatewayRetryQueuePath();
  if (!existsSync(path)) {
    return { version: INDEX_VERSION, items: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as RetryQueueIndex;
    if (!Array.isArray(parsed.items)) {
      throw new Error("items 字段缺失");
    }
    return { version: INDEX_VERSION, items: parsed.items };
  } catch (error) {
    console.error("[ChannelGateway] 读取 retry queue 失败:", error);
    return { version: INDEX_VERSION, items: [] };
  }
}

function writeIndex(index: RetryQueueIndex): void {
  writeAtomic(getChannelGatewayRetryQueuePath(), JSON.stringify(index, null, 2));
}

export function listChannelRetryQueue(): ChannelRetryItem[] {
  return readIndex().items.sort((a, b) => a.retryAt - b.retryAt);
}

export function enqueueChannelRetry(input: {
  provider: ChannelProvider;
  outboundMessageId: string;
  reason: string;
  externalChatId?: string;
  text?: string;
  replyToMessageId?: string;
  attempts?: number;
  retryAfterMs?: number;
}): ChannelRetryItem {
  const index = readIndex();
  const attempts = Math.max(1, input.attempts ?? 1);
  const item: ChannelRetryItem = {
    id: randomUUID(),
    provider: input.provider,
    outboundMessageId: input.outboundMessageId,
    reason: input.reason,
    ...(input.externalChatId ? { externalChatId: input.externalChatId } : {}),
    ...(input.text ? { text: input.text } : {}),
    ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
    attempts,
    retryAt: Date.now() + Math.max(1_000, input.retryAfterMs ?? 60_000),
    createdAt: Date.now()
  };
  index.items.push(item);
  writeIndex(index);
  return item;
}

export function dequeueDueChannelRetries(now = Date.now()): ChannelRetryItem[] {
  const index = readIndex();
  const due: ChannelRetryItem[] = [];
  const pending: ChannelRetryItem[] = [];
  for (const item of index.items) {
    if (item.retryAt <= now) {
      due.push(item);
    } else {
      pending.push(item);
    }
  }
  if (due.length > 0) {
    writeIndex({
      ...index,
      items: pending
    });
  }
  return due.sort((a, b) => a.retryAt - b.retryAt);
}
