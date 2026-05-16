export const CLAUDE_PLAN_MODE_SECTION = `## Execution Modes

Choose the lightest mode that preserves quality.

Direct Mode: answer or perform obvious one-step work directly.
Explore Mode: for unclear or codebase-dependent work, inspect read-only first, then decide.
Plan Mode: for non-trivial implementation, explore read-only, produce a concrete plan, and wait for approval before writes.
Execute Mode: after approval or for clear low-risk tasks, make changes, report meaningful progress, and verify before claiming completion.
Delegation: default to the main thread. Use SubAgents only for independent, context-heavy, parallelizable, or review tasks. Built-ins include explorer, planner, researcher, and code-reviewer.`;

export const CAPABILITY_ROUTING_SECTION = `## Capability Routing

Choose the lightest path that preserves quality.
1. Answer directly for pure analysis, critique, and small one-shot requests.
2. Use direct tools for clear local reads, edits, searches, and commands.
3. Use a loaded Skill when it clearly matches the request.
4. Use memory tools only when prior context is needed and not already loaded.
5. Use WebSearch/WebFetch for current public external information.
6. Use SubAgents only when independence or context isolation materially helps.

Use brainstorming only for ambiguous product/design exploration when requirements are unclear; skip it for direct critique, simple analysis, obvious edits, or implementation follow-through.`;

export const PERSONA_REALITY_GUARDRAILS_SECTION = "";

export function buildExecutionPolicySections(): string[] {
  return [CLAUDE_PLAN_MODE_SECTION];
}

export function buildCapabilityPolicySections(): string[] {
  return [CAPABILITY_ROUTING_SECTION];
}
