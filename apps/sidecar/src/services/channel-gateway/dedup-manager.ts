import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { ChannelInboundEvent } from "@lume/shared";
import { getChannelGatewayDedupPath } from "../config-paths";

interface DedupEntry {
  key: string;
  createdAt: number;
}

function toDedupKey(event: ChannelInboundEvent): string {
  return `${event.provider}:${event.externalMessageId}`;
}

function readEntries(): DedupEntry[] {
  const path = getChannelGatewayDedupPath();
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf-8").split("\n");
  const entries: DedupEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as DedupEntry;
      if (parsed?.key) entries.push(parsed);
    } catch {
      // ignore bad line
    }
  }
  return entries;
}

export function isChannelEventProcessed(event: ChannelInboundEvent): boolean {
  const key = toDedupKey(event);
  return readEntries().some((item) => item.key === key);
}

export function markChannelEventProcessed(event: ChannelInboundEvent): void {
  const payload: DedupEntry = {
    key: toDedupKey(event),
    createdAt: Date.now()
  };
  appendFileSync(getChannelGatewayDedupPath(), `${JSON.stringify(payload)}\n`, "utf-8");
}

