import type { AgentSendInput } from "@lume/shared";
import type { AgentEvent } from "@lume/shared";
import type { AgentAskUserQuestionRequest } from "@lume/shared";
import type { AgentToolPermissionRequest } from "@lume/shared";

export interface PiAgentRuntimeEmitter {
  onEvent: (event: AgentEvent) => void;
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
    channelId: string;
    modelId: string;
    workspaceId?: string;
    sessionType?: AgentSendInput["sessionType"];
  };
}
