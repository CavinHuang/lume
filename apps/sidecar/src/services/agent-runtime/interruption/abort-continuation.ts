import { createFileBackedRunContinuationStore } from "../runtime-core/run-continuation-store";
import { classifyToolKind, hashToolInput } from "./approval-service";

export interface AbortContinuationInput {
  sessionDir: string;
  runId: string;
  threadId: string;
  pendingToolCalls: Array<{ id: string; name: string; input: unknown }>;
}

export async function persistAbortContinuation(input: AbortContinuationInput): Promise<void> {
  const pending = input.pendingToolCalls[0];
  if (!pending) return;
  const now = new Date().toISOString();
  const kind = classifyToolKind(pending.name);
  // ponytail: checkpoint 只记第一个 pending 工具；多工具 abort 边界走 SDK 悬空兜底。
  await createFileBackedRunContinuationStore(input.sessionDir).upsert({
    version: 2,
    runId: input.runId,
    threadId: input.threadId,
    status: "interrupted",
    checkpoint: {
      step: "waiting_for_tool_result",
      toolCallId: pending.id,
      toolName: pending.name,
      toolKind: kind,
      toolCall: {
        id: pending.id,
        name: pending.name,
        input: pending.input,
        inputHash: hashToolInput(pending.input),
        kind
      }
    },
    reason: "run 已被用户中止；恢复时从首个 pending 工具断点继续。",
    createdAt: now,
    updatedAt: now
  });
}
