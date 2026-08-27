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

/**
 * listPending 请求面的共享小原语(#531 复审 M1)：ask-user / tool-permission
 * 两个 session 的同构段。更大的 waitFor/Promise 骨架差异（状态对象 vs
 * decision、bypass/fingerprint 业务规则）受 700+ 行专项测试钉保护且为真实
 * 业务面——经复审维持"不可安全参数化"的裁定，只归位这两段零风险重复。
 */
export function toApprovalThreadView<
  P extends { threadId: string; approvalSessionId: string; request: { threadId: string; originThreadId?: string } },
>(pendings: Iterable<P>): P["request"][] {
  return Array.from(pendings, (pending) => ({
    ...pending.request,
    threadId: pending.approvalSessionId,
    ...(pending.request.originThreadId ? {} : (
      pending.threadId !== pending.approvalSessionId
        ? { originThreadId: pending.threadId }
        : {}
    ))
  }));
}

export function collectPersistedInterruptionPayloads<T>(
  target: T[],
  types: ReadonlySet<LumeInterruption["type"]>,
  idOf: (payload: T) => string | undefined,
): T[] {
  const seen = new Set(target.map(idOf));
  for (const interruption of listPendingRuntimeCoreInterruptions()) {
    if (!types.has(interruption.type)) continue;
    const payload = interruption.payload as T;
    const id = idOf(payload);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    target.push(payload);
  }
  return target;
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
