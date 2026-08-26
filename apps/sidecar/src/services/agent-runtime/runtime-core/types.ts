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
  onComplete: (payload?: { reason?: "max_turns" | "repeat_guard" | "stopped" }) => void;
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
  /** turn_limited 收场的细分标记：SDK repeat guard 硬停（repeated_tool_call）
   * 映射为带标记的 turn_limited 而非新增状态枚举——恢复上下文与 onComplete
   * reason 据此区分文案，其余状态消费者不受影响。 */
  terminationReason?: "repeat_guard";
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

/** attempt 执行器的中止注册回调（attempt.ts / lume-runner.ts / mock-attempt.ts 三处共享）。 */
export interface RunRuntimeCoreAttemptOptions {
  registerAbort: (threadId: string, abort: () => Promise<void>) => void;
  unregisterAbort: (threadId: string) => void;
}
