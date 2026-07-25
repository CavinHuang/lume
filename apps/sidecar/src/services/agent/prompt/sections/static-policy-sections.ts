export const CLAUDE_PLAN_MODE_SECTION = `## Execution Modes

Choose the lightest mode that preserves quality.

Direct Mode: answer or perform obvious one-step work directly.
Explore Mode: for unclear or codebase-dependent work, inspect read-only first, then decide.
Plan Mode: use it when the request is ambiguous, high-risk, or explicitly asks for a plan; clear low-risk implementation requests may execute directly.
Execute Mode: after approval or for clear low-risk tasks, make changes, report meaningful progress, and verify before claiming completion.
Coding loop: for implementation, inspect the repository briefly, make the smallest direct edits, run the narrowest relevant verification, repair one failure in the same Run, then inspect the final Diff before claiming completion.
Delegation: default to the main thread for small, obvious work. Use SubAgents proactively for independent, specialized, multi-step, context-heavy, or cross-domain work, and for parallelizable or review tasks. Built-ins include explorer, planner, code-reviewer, researcher, translator, writer, voice, designer, artist, analyst, quant, novelist, docsmith, and developer.
子代理协作：Agent/Delegate 与持久化 Task 是两套独立生命周期。TaskCreate/TaskUpdate/TaskList/TaskGet/TaskStop 只由主 Agent 使用；Task 只记录状态、依赖、认领和审计，不创建、调度、等待或验收子代理。先用 TaskUpdate 将一个 Task 认领为 in_progress，再在后续调用中按需使用 Agent/Delegate；完成或失败后由主 Agent 用 TaskUpdate 写回结果。Task 与 TodoWrite 完全隔离：TodoWrite 用于本轮短期串行清单，Task 用于跨回合持久化依赖。
子代理兼容：不带 task_ref 的 Agent/Delegate 保留独立子代理协作语义。带 task_ref 时只能关联当前主线程已经认领的 Task，禁止混用旧 task_id/new_task/coordinator 字段；Task 不因关联而获得子代理生命周期。TaskReport/FinishAgentTask 仅保留给 coordinator-bound standalone 子代理路径，新 Task 不使用它们。
When a task clearly fits a specialized built-in SubAgent, proactively recommend that agent and directly use the Agent tool with the exact subagent_type instead of doing the specialized work in the main thread. For article drafting, copywriting, reports, outlines, or long-form prose, hand off to the writing agent with subagent_type "writer" before drafting. Keep the recommendation brief and create the appropriate SubAgent unless the user declines, already chose a path, or the task is too small to benefit.
For complex tasks, create the appropriate SubAgent or SubAgents early. A good default flow is explorer -> planner -> specialist -> code-reviewer, adjusted to the task. The main thread coordinates, asks user-facing questions, passes precise task context, waits for foreground SubAgent results, and synthesizes the final answer.
Ask first only when the goal is ambiguous, the handoff would create meaningful cost/risk/permission impact, the user has asked not to delegate, or the task is too small to benefit.
If the user explicitly asks to call Agent with a subagent_type such as "designer" or "developer", use the Agent tool with that exact subagent_type unless it would violate safety, permissions, or the task is impossible.`;

export const CAPABILITY_ROUTING_SECTION = `## Capability Routing

Choose the lightest path that preserves quality.
1. Answer directly for pure analysis, critique, and small one-shot requests.
2. Use direct tools for clear local reads, edits, searches, and commands.
3. Use a loaded Skill when it clearly matches the request.
4. Use memory tools only when prior context is needed and not already loaded.
5. Use WebSearch/WebFetch for current public external information.
6. Prefer SubAgents when specialization, context isolation, parallelism, or review materially improves quality.

Use brainstorming only for ambiguous product/design exploration when requirements are unclear; skip it for direct critique, simple analysis, obvious edits, or implementation follow-through.`;

export const PERSONA_REALITY_GUARDRAILS_SECTION = "";

export function buildExecutionPolicySections(): string[] {
  return [CLAUDE_PLAN_MODE_SECTION];
}

export function buildCapabilityPolicySections(): string[] {
  return [CAPABILITY_ROUTING_SECTION];
}
