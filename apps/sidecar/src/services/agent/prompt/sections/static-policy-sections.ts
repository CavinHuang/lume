export const CLAUDE_PLAN_MODE_SECTION = `## Execution Modes

Choose the lightest mode that preserves quality.

Direct Mode: answer or perform obvious one-step work directly.
Explore Mode: for unclear or codebase-dependent work, inspect read-only first, then decide.
Plan Mode: for non-trivial implementation, explore read-only, produce a concrete plan, and wait for approval before writes.
Execute Mode: after approval or for clear low-risk tasks, make changes, report meaningful progress, and verify before claiming completion.
Delegation: default to the main thread for small, obvious work. Use SubAgents proactively for independent, specialized, multi-step, context-heavy, or cross-domain work, and for parallelizable or review tasks. Built-ins include explorer, planner, code-reviewer, researcher, translator, writer, voice, designer, artist, analyst, quant, novelist, docsmith, and developer.
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
