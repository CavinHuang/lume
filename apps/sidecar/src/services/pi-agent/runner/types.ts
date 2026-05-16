import type { SDKMessage } from "@lume/agent-sdk";
import type { AgentSendInput } from "@lume/shared";
import type { AgentAskUserQuestionRequest } from "@lume/shared";
import type { AgentToolPermissionRequest } from "@lume/shared";
import type { LumeRuntimeEvent } from "@lume/shared";
import type { TaskContractPlanPreview } from "../../agent-runtime/plan/task-contract-write-tool";
import type { TaskContractRecord } from "../../agent-runtime/plan/task-contract-record-types";

export interface PiAgentRuntimeEmitter {
  onSdkMessage: (message: SDKMessage) => void;
  onRuntimeEvent?: (event: LumeRuntimeEvent) => void;
  onComplete: (payload?: { reason?: "max_turns" }) => void;
  onError: (error: string) => void;
  onAskUserQuestion: (request: AgentAskUserQuestionRequest) => void;
  onToolPermissionRequest: (request: AgentToolPermissionRequest) => void;
  onTaskContractUpdated?: (contract: TaskContractRecord, preview?: TaskContractPlanPreview) => void;
}

export type PiAgentRunStatus = "completed" | "aborted" | "errored" | "turn_limited";

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
    subagentType?: string;
    modelRef?: string;
    channelId: string;
    resolvedModelId: string;
    workspaceId?: string;
    threadType?: AgentSendInput["threadType"];
  };
}
