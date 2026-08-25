/**
 * Guardrail 类型学：唯一在用的形态是「工具输入安全检查」——
 * tool_input 单 scope、blocking 单模式（顺序执行，首个非 allow 即短路）、
 * allow / reject / require_approval 三种 outcome。
 * 多 scope / parallel / transform 的投机面已删（全仓零消费者）。
 */

export interface LumeGuardrailResult {
  behavior: "allow" | "reject" | "require_approval";
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface LumeGuardrailContext {
  threadId: string;
  runId?: string;
  cwd?: string;
  additionalDirectories?: string[];
  workspaceSlug?: string;
  toolName?: string;
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";
}

export interface LumeGuardrail<TInput = unknown> {
  id: string;
  name: string;
  run(input: TInput, context: LumeGuardrailContext): Promise<LumeGuardrailResult>;
}
