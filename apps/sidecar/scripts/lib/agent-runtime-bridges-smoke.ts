interface PermissionRequestLike {
  requestId?: string;
  toolName?: string;
}

interface AskUserRequestLike {
  toolUseId?: string;
  questions?: Array<{ header?: string }>;
}

interface SubagentRunsLike {
  runs?: Array<{ runId?: string; status?: string; announceStatus?: string }>;
}

interface MessageLike {
  role?: string;
  metadata?: Record<string, unknown>;
}

export function assertBridgeSmokeOutcome(input: {
  permissionRequest: PermissionRequestLike | null;
  askUserRequest: AskUserRequestLike | null;
  statusPhases: string[];
  restoredRuntimeStatus: { phase?: string } | null;
  listSubagentRuns: SubagentRunsLike;
  restoredSubagentRuns: SubagentRunsLike;
  messageAppendedEvent: { runId?: string } | null;
  messages: MessageLike[];
}): void {
  if (!input.permissionRequest?.requestId || input.permissionRequest.toolName !== "write") {
    throw new Error("tool permission request missing or unexpected");
  }

  if (!input.askUserRequest?.toolUseId || (input.askUserRequest.questions?.length ?? 0) === 0) {
    throw new Error("ask user question request missing");
  }

  for (const phase of ["awaiting_permission", "awaiting_user_answer", "completed"]) {
    if (!input.statusPhases.includes(phase)) {
      throw new Error(`runtime status phase missing: ${phase}`);
    }
  }

  if (input.restoredRuntimeStatus?.phase !== "idle") {
    throw new Error("restored runtime status is not idle");
  }

  const firstRun = input.listSubagentRuns.runs?.[0];
  if (!firstRun?.runId || firstRun.status !== "completed" || firstRun.announceStatus !== "delivered") {
    throw new Error("subagent run list missing delivered completed run");
  }

  const restoredRun = input.restoredSubagentRuns.runs?.find((run) => run.runId === firstRun.runId);
  if (!restoredRun || restoredRun.status !== "completed") {
    throw new Error("restored subagent run missing completed run");
  }

  if (input.messageAppendedEvent?.runId !== firstRun.runId) {
    throw new Error("message appended event missing matching runId");
  }

  const announceMessage = input.messages.find(
    (message) =>
      message?.role === "assistant"
      && message.metadata?.subagentAnnounce === true
      && message.metadata?.runId === firstRun.runId
  );
  if (!announceMessage) {
    throw new Error("subagent announce message missing from restored messages");
  }
}
