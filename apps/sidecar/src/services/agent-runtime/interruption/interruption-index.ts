import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getRuntimeCoreAgentDir } from "../runtime-core/session-store";
import type { LumeInterruption } from "./interruption";

export interface RuntimeCoreInterruptionRecord {
  sessionDir: string;
  interruption: LumeInterruption;
}

export function listPendingRuntimeCoreInterruptions(): LumeInterruption[] {
  return listPendingRuntimeCoreInterruptionRecords().map((record) => record.interruption);
}

export function listPendingRuntimeCoreInterruptionRecords(): RuntimeCoreInterruptionRecord[] {
  const sessionsDir = join(getRuntimeCoreAgentDir(), "sessions");
  if (!existsSync(sessionsDir)) return [];
  const result: RuntimeCoreInterruptionRecord[] = [];
  for (const sessionName of readdirSync(sessionsDir)) {
    const interruptionsDir = join(sessionsDir, sessionName, "interruptions");
    if (!existsSync(interruptionsDir)) continue;
    for (const file of readdirSync(interruptionsDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const interruption = JSON.parse(readFileSync(join(interruptionsDir, file), "utf-8")) as LumeInterruption;
        if (interruption.status === "pending") {
          result.push({
            sessionDir: join(sessionsDir, sessionName),
            interruption
          });
        }
      } catch {
        // Ignore corrupt interruption records; the live resolver still owns the running request.
      }
    }
  }
  return result.sort((a, b) => a.interruption.createdAt.localeCompare(b.interruption.createdAt));
}
