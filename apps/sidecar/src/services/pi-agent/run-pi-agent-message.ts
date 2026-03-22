import { createLogger } from "../logger";
import type { AgentAskUserQuestionRequest, AgentEvent, AgentToolPermissionRequest } from "@lume/shared";
import type { AgentSendInput } from "@lume/shared";
import type { PiAgentRunResult } from "./runner/types";

type PiAgentEventEmitter = {
  onEvent: (event: AgentEvent) => void;
  onComplete: () => void;
  onError: (error: string) => void;
  onAskUserQuestion: (request: AgentAskUserQuestionRequest) => void;
  onToolPermissionRequest: (request: AgentToolPermissionRequest) => void;
};

const log = createLogger("pi-agent-runtime");

export async function runPiAgentMessage(
  input: AgentSendInput,
  emit: PiAgentEventEmitter
): Promise<PiAgentRunResult> {
  if (!input.channelId || !input.modelId) {
    const msg = "Pi Agent runtime 缺少 channelId/modelId。";
    emit.onError(msg);
    return { status: "errored", errorMessage: msg };
  }
  log.info("Pi Agent runtime 已接管请求，进入 runner", {
    sessionId: input.sessionId.slice(0, 8)
  });
  const channelId = input.channelId;
  const modelId = input.modelId;
  const { runPiAgent } = await withPiAiBunCompatibility(async () => import("./runner/run"));
  return runPiAgent(
    {
      input,
      runtime: {
        sessionId: input.sessionId,
        channelId,
        modelId,
        workspaceId: input.workspaceId,
        sessionType: input.sessionType
      }
    },
    emit
  );
}

async function withPiAiBunCompatibility<T>(task: () => Promise<T>): Promise<T> {
  const versions = process.versions as Record<string, string | undefined>;
  const isBunRuntime = Boolean(versions.bun);
  const originalNodeVersion = versions.node;
  if (!isBunRuntime) {
    return task();
  }
  versions.node = "";
  try {
    return await task();
  } finally {
    versions.node = originalNodeVersion;
  }
}
