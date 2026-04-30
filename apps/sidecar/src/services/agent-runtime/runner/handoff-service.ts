import { randomUUID } from "node:crypto";
import type { TraceRecorder } from "../trace/trace-recorder";
import type { LumeHandoffItem } from "./run-items";
import type { LumeRunStateStore } from "./run-state-store";

export interface RecordHandoffIntentInput {
  runId: string;
  fromAgentId: string;
  toAgentId: string;
  reason?: string;
  traceId?: string;
  runStateStore: LumeRunStateStore;
  traceRecorder?: TraceRecorder;
  now?: () => string;
}

export async function recordHandoffIntent(input: RecordHandoffIntentInput): Promise<LumeHandoffItem> {
  const now = input.now ?? (() => new Date().toISOString());
  let traceSpanId: string | undefined;
  if (input.traceRecorder && input.traceId) {
    const span = await input.traceRecorder.startSpan({
      traceId: input.traceId,
      type: "handoff",
      name: `${input.fromAgentId} -> ${input.toAgentId}`,
      input: {
        fromAgentId: input.fromAgentId,
        toAgentId: input.toAgentId,
        reason: input.reason
      }
    });
    await input.traceRecorder.endSpan(span.id, { status: "requested" });
    traceSpanId = span.id;
  }

  const item: LumeHandoffItem = {
    type: "handoff",
    id: randomUUID(),
    fromAgentId: input.fromAgentId,
    toAgentId: input.toAgentId,
    reason: input.reason,
    status: "requested",
    traceSpanId,
    createdAt: now()
  };
  await input.runStateStore.appendItem(input.runId, item);
  return item;
}

export async function acceptHandoff(input: {
  runId: string;
  handoffId: string;
  runStateStore: LumeRunStateStore;
}): Promise<LumeHandoffItem | null> {
  return updateHandoff(input, "accepted");
}

export async function completeHandoff(input: {
  runId: string;
  handoffId: string;
  runStateStore: LumeRunStateStore;
}): Promise<LumeHandoffItem | null> {
  return updateHandoff(input, "completed");
}

export async function failHandoff(input: {
  runId: string;
  handoffId: string;
  runStateStore: LumeRunStateStore;
}): Promise<LumeHandoffItem | null> {
  return updateHandoff(input, "failed");
}

async function updateHandoff(
  input: {
    runId: string;
    handoffId: string;
    runStateStore: LumeRunStateStore;
  },
  status: LumeHandoffItem["status"]
): Promise<LumeHandoffItem | null> {
  const state = await input.runStateStore.get(input.runId);
  if (!state) return null;
  const current = state.generatedItems.find((item): item is LumeHandoffItem => (
    item.type === "handoff" && item.id === input.handoffId
  ));
  if (!current) return null;
  const updated: LumeHandoffItem = {
    ...current,
    status
  };
  await input.runStateStore.update(input.runId, {
    ...(status === "accepted" ? { currentAgentId: current.toAgentId } : {}),
    generatedItems: state.generatedItems.map((item) => (
      item.type === "handoff" && item.id === input.handoffId ? updated : item
    ))
  });
  return updated;
}
