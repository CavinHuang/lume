import type { SDKMessage } from "@lume/agent-sdk";
import type { AgentSendInput, FileReferenceBinding, RuntimeCodingReport } from "@lume/shared";
import type { AgentAskUserQuestionRequest } from "@lume/shared";
import type { AgentBrowserAuthRequest } from "@lume/shared";
import type { AgentDesktopActionRequest } from "@lume/shared";
import type { AgentToolPermissionRequest } from "@lume/shared";
import type { LumeRuntimeEvent } from "@lume/shared";

export interface AgentRuntimeEmitter {
  onSdkMessage: (message: SDKMessage) => void;
  onRuntimeEvent?: (event: LumeRuntimeEvent) => void;
  onComplete: (payload?: { reason?: "max_turns" }) => void;
  onError: (error: string) => void;
  onAskUserQuestion: (request: AgentAskUserQuestionRequest) => void;
  onBrowserAuthRequest: (request: AgentBrowserAuthRequest) => void;
  onDesktopActionRequest?: (request: AgentDesktopActionRequest) => void;
  onToolPermissionRequest: (request: AgentToolPermissionRequest) => void;
  onTodoUpdated?: (state: { todos: { content: string; activeForm: string; status: "pending" | "in_progress" | "completed" }[]; currentActiveForm: string | null }) => void;
}

export type AgentRuntimeRunStatus = "completed" | "aborted" | "errored" | "turn_limited";

export interface AgentRuntimeRunResult {
  status: AgentRuntimeRunStatus;
  errorMessage?: string;
  verificationStatus?: "not_required" | "unverified" | "verified" | "failed";
  codingReport?: RuntimeCodingReport;
}

export interface AgentRuntimeRunParams {
  input: AgentSendInput;
  runtime: {
    sessionId: string;
    /** Raw user text for persistence/UI; never forwarded to the model or a child runtime. */
    visibleUserMessage?: string;
    deliveryThreadId?: string;
    subagentRunId?: string;
    subagentId?: string;
    subagentTaskId?: string;
    subagentAttempt?: number;
    subagentType?: string;
    modelRef?: string;
    channelId: string;
    resolvedModelId: string;
    workspaceId?: string;
    threadType?: AgentSendInput["threadType"];
    fileReferenceBinding?: FileReferenceBinding;
    abortSignal?: AbortSignal;
  };
}
