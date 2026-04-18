import type { SDKMessage } from "@lume/agent-sdk";
import type { AgentSendInput } from "@lume/shared";
import type { AgentAskUserQuestionRequest } from "@lume/shared";
import type { AgentToolPermissionRequest } from "@lume/shared";

export interface PiAgentRuntimeEmitter {
  onSdkMessage: (message: SDKMessage) => void;
  onComplete: () => void;
  onError: (error: string) => void;
  onAskUserQuestion: (request: AgentAskUserQuestionRequest) => void;
  onToolPermissionRequest: (request: AgentToolPermissionRequest) => void;
}

export type PiAgentRunStatus = "completed" | "aborted" | "errored";

export interface PiAgentRunResult {
  status: PiAgentRunStatus;
  errorMessage?: string;
}

export interface PiAgentRunParams {
  input: AgentSendInput;
  runtime: {
    sessionId: string;
    deliveryThreadId?: string;
    subagentRunId?: string;
    modelRef?: string;
    channelId: string;
    resolvedModelId: string;
    workspaceId?: string;
    threadType?: AgentSendInput["threadType"];
  };
}
