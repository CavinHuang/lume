import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { getPluginAuditPath } from "../../infra/config-paths";
import { createLogger } from "../../infra/logger";
import type { PluginAuditEvent } from "@lume/shared";

const log = createLogger("plugin-audit-store");

/**
 * Audit file growth is capped (#531 复审)：the jsonl trail has no reader in the
 * product yet but must stay available for forensics, so instead of growing
 * forever the store rewrites down to a bounded newest-tail once the cap is
 * crossed. Constants are deliberately not configurable (YAGNI).
 */
const PLUGIN_AUDIT_MAX_BYTES = 5 * 1024 * 1024;
const PLUGIN_AUDIT_TAIL_BYTES = 2 * 1024 * 1024;

type AppendInput = Omit<PluginAuditEvent, "id" | "createdAt"> &
  Partial<Pick<PluginAuditEvent, "id" | "createdAt">>;

/** Keep only the newest `PLUGIN_AUDIT_TAIL_BYTES` (line-aligned) past the cap. */
async function enforceAuditCap(target: string): Promise<void> {
  let size: number;
  try {
    size = (await stat(target)).size;
  } catch {
    return; // missing file — nothing to rotate
  }
  if (size < PLUGIN_AUDIT_MAX_BYTES) return;
  const buf = await readFile(target);
  const tailStart = Math.max(0, buf.length - PLUGIN_AUDIT_TAIL_BYTES);
  const newlineIdx = tailStart === 0 ? -1 : buf.indexOf(10, tailStart); // "\n"
  const kept = newlineIdx === -1 ? buf.subarray(tailStart) : buf.subarray(newlineIdx + 1);
  // Best-effort under concurrency: a racing append may be swallowed during the
  // rare rewrite window — acceptable for an observational trail.
  await writeFile(target, kept);
}

/**
 * Append a plugin audit event to the jsonl store. Best-effort: a write failure
 * logs a warning but does NOT throw — audit is observational, it must never
 * break the operation being audited. When `path` is omitted, uses
 * `getPluginAuditPath()` (`~/.lume/plugins-audit.jsonl`). The file is kept
 * bounded by line-aligned tail rotation (`enforceAuditCap`).
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
    await enforceAuditCap(target).catch(() => undefined); // rotation is best-effort too
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
 * given only matching events are returned; when `workspaceSlug` is given events
 * are further filtered to that workspace (same pluginId across workspaces must
 * not bleed together); when `limit` is given the result is tailed to the most
 * recent N (jsonl is chronological append-order).
 */
export async function readPluginAuditEntries(
  path: string,
  input: { pluginId?: string; workspaceSlug?: string; limit?: number },
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
      if (input.workspaceSlug && parsed.workspaceSlug !== input.workspaceSlug) continue;
      events.push(parsed);
    } catch {
      // malformed line — skip
    }
  }
  return input.limit && input.limit > 0 ? events.slice(-input.limit) : events;
}
