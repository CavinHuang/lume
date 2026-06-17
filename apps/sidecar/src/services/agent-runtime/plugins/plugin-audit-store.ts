import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { getPluginAuditPath } from "../../infra/config-paths";
import { createLogger } from "../../infra/logger";
import type { PluginAuditEvent } from "@lume/shared";

const log = createLogger("plugin-audit-store");

type AppendInput = Omit<PluginAuditEvent, "id" | "createdAt"> &
  Partial<Pick<PluginAuditEvent, "id" | "createdAt">>;

/**
 * Append a plugin audit event to the jsonl store. Best-effort: a write failure
 * logs a warning but does NOT throw — audit is observational, it must never
 * break the operation being audited. When `path` is omitted, uses
 * `getPluginAuditPath()` (`~/.lume/plugins-audit.jsonl`).
 */
export async function appendPluginAuditEntry(
  path: string | undefined,
  event: AppendInput,
): Promise<void> {
  const target = path ?? getPluginAuditPath();
  // Put id/createdAt first so an explicit caller value in `event` still wins
  // via spread override.
  const full: PluginAuditEvent = {
    id: event.id ?? randomUUID(),
    createdAt: event.createdAt ?? new Date().toISOString(),
    ...event,
  } as PluginAuditEvent;
  try {
    await mkdir(dirname(target), { recursive: true });
    await appendFile(target, `${JSON.stringify(full)}\n`, "utf-8");
  } catch (error) {
    log.warn("appendPluginAuditEntry failed", {
      pluginId: event.pluginId,
      type: event.type,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Read plugin audit events from a jsonl store. Best-effort: a missing file
 * returns `[]`; malformed lines are skipped (not fatal). When `pluginId` is
 * given only matching events are returned; when `limit` is given the result is
 * tailed to the most recent N (jsonl is chronological append-order).
 */
export async function readPluginAuditEntries(
  path: string,
  input: { pluginId?: string; limit?: number },
): Promise<PluginAuditEvent[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const events: PluginAuditEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as PluginAuditEvent;
      if (input.pluginId && parsed.pluginId !== input.pluginId) continue;
      events.push(parsed);
    } catch {
      // malformed line — skip
    }
  }
  return input.limit && input.limit > 0 ? events.slice(-input.limit) : events;
}
