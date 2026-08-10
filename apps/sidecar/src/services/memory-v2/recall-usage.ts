import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getMemoryV2ScopePaths } from "./paths";
import type { MemoryV2RecallItem } from "./types";

interface RecallUsageRecord { count: number; lastUsedAt: string }

export function recordMemoryRecallUsage(input: { workspaceSlug?: string; items: MemoryV2RecallItem[] }): void {
  const now = new Date().toISOString();
  for (const scope of ["global", "workspace"] as const) {
    const items = input.items.filter((item) => item.scope === scope && item.id.startsWith("mem_"));
    if (items.length === 0 || (scope === "workspace" && !input.workspaceSlug)) continue;
    const paths = getMemoryV2ScopePaths({ scope, workspaceSlug: input.workspaceSlug });
    const path = join(paths.indexDir, "recall-usage.json");
    let current: Record<string, RecallUsageRecord> = {};
    if (existsSync(path)) {
      try { current = JSON.parse(readFileSync(path, "utf-8")) as Record<string, RecallUsageRecord>; } catch { current = {}; }
    }
    for (const item of items) {
      const previous = current[item.id];
      current[item.id] = { count: (previous?.count ?? 0) + 1, lastUsedAt: now };
    }
    const temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(current, null, 2)}\n`, "utf-8");
    renameSync(temp, path);
  }
}
