export type LumeRunItem =
  | LumeUserMessageItem
  | LumeAssistantMessageItem
  | LumeToolCallItem
  | LumeToolResultItem
  | LumeModelStreamItem
  | LumePlanPreviewItem
  | LumeTodoStateItem
  | LumeSystemEventItem
  | LumeApprovalItem
  | LumeSubagentItem
  | LumeHandoffItem;

export interface LumeUserMessageItem {
  type: "user_message";
  id: string;
  content: unknown;
  createdAt: string;
}

export interface LumeAssistantMessageItem {
  type: "assistant_message";
  id: string;
  content: unknown;
  subagentRunId?: string;
  parentToolCallId?: string;
  traceSpanId?: string;
  createdAt: string;
}

export interface LumeToolCallItem {
  type: "tool_call";
  id: string;
  toolName: string;
  input: unknown;
  parentAgentId: string;
  parentToolCallId?: string;
  subagentRunId?: string;
  status: "pending" | "approved" | "running" | "completed" | "failed" | "denied";
  traceSpanId?: string;
  createdAt: string;
}

export interface LumeToolResultItem {
  type: "tool_result";
  id: string;
  toolCallId: string;
  toolName?: string;
  output: unknown;
  parentToolCallId?: string;
  subagentRunId?: string;
  isError?: boolean;
  traceSpanId?: string;
  createdAt: string;
}

export interface LumeModelStreamItem {
  type: "model_stream";
  id: string;
  event: unknown;
  parentToolCallId?: string;
  subagentRunId?: string;
  createdAt: string;
}

export interface LumeSystemEventItem {
  type: "system_event";
  id: string;
  name: string;
  payload?: unknown;
  createdAt: string;
}

export interface LumePlanPreviewItem {
  type: "plan_preview";
  id: string;
  contractId: string;
  title: string;
  summary: string;
  markdown: string;
  planFilePath?: string;
  planVerified?: boolean;
  stepCount: number;
  createdAt: string;
}

export interface LumeTodoStateItem {
  type: "todo_state";
  id: string;
  todos: { content: string; activeForm: string; status: "pending" | "in_progress" | "completed" }[];
  currentActiveForm: string | null;
  createdAt: string;
}

export interface LumeApprovalItem {
  type: "approval";
  id: string;
  interruptionId: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  createdAt: string;
}

export interface LumeSubagentItem {
  type: "subagent";
  id: string;
  runId: string;
  parentRunId?: string;
  parentToolCallId?: string;
  agentId?: string;
  task: string;
  status: "running" | "completed" | "failed" | "cancelled";
  childThreadId: string;
  traceSpanId?: string;
  output?: string;
  error?: string;
  createdAt: string;
}

export interface LumeHandoffItem {
  type: "handoff";
  id: string;
  fromAgentId: string;
  toAgentId: string;
  reason?: string;
  status: "requested" | "accepted" | "completed" | "failed" | "cancelled";
  traceSpanId?: string;
  createdAt: string;
}
