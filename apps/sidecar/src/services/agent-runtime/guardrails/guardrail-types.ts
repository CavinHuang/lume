export type GuardrailScope =
  | "input"
  | "output"
  | "tool_input"
  | "tool_output"
  | "memory_write"
  | "automation";

export type GuardrailBehavior =
  | "allow"
  | "reject"
  | "require_approval"
  | "transform";

export interface LumeGuardrailResult {
  behavior: GuardrailBehavior;
  reason?: string;
  transformedValue?: unknown;
  metadata?: Record<string, unknown>;
}

export interface LumeGuardrailContext {
  threadId: string;
  runId?: string;
  cwd?: string;
  workspaceSlug?: string;
  toolName?: string;
}

export interface LumeGuardrail<TInput = unknown> {
  id: string;
  name: string;
  scope: GuardrailScope;
  mode: "blocking" | "parallel";
  run(input: TInput, context: LumeGuardrailContext): Promise<LumeGuardrailResult>;
}
