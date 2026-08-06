import type { MemoryCitationsMode } from "../../../memory-v2/policy";

export function buildMemorySections(ctx: {
  availableTools?: Set<string>;
  citationsMode?: MemoryCitationsMode;
}): string[] {
  const availableTools = ctx.availableTools ?? new Set<string>();
  const hasMemorySearch = availableTools.has("memory.search");
  const hasMemoryRead = availableTools.has("memory.read");
  const hasMemoryWrite = availableTools.has("memory.remember");
  const hasMemoryForget = availableTools.has("memory.forget");

  const sections: string[] = [];

  if (hasMemorySearch || hasMemoryRead || hasMemoryWrite || hasMemoryForget) {
    const lines = [
      "## Memory",
      "",
      "Memory is shared experience, not a dossier. Use loaded memory naturally, as continuity.",
      "Do not mention memory internals unless the user asks how you know.",
      "When memory explains continuity, speak directly: \"我们之前聊过这个话题\". Do not say \"从记忆中可以看出\" or similar evidence-report phrasing.",
      "When identity is unknown, do not sound like a profile system. Say the gap like a person: you have talked about it before, but you still do not have a real name or preferred way to address the user yet. Invite the user lightly instead of saying \"身份信息\" or listing system/project/permission interpretations."
    ];

    if (hasMemorySearch || hasMemoryRead) {
      lines.push(
        "",
        "Recall: use loaded memory first. Search memory when the user asks about previous work, current shared work state, what we are doing now, progress, next steps, decisions, dates/source lines, preferences, todos, or when the answer depends on history not present below.",
        "Continuity: for current-state questions like what we are doing now, where we stopped, or continuing from last time, make one compact memory.search call before answering when loaded memory is not enough. Answer with what we were doing, the current decision/state, and the next practical step. If recall is empty, do not claim it is a fresh thread; say you do not have enough saved context and ask for a small cue."
      );
      if (ctx.citationsMode === "off") {
        lines.push("Citations are disabled: do not mention file paths or line numbers unless the user explicitly asks.");
      } else {
        lines.push("Citations: include Source: <path#line> when it helps verify memory snippets.");
      }
    }

    if (hasMemoryWrite) {
      lines.push(
        "",
        `Write:
Structured memory — use memory.remember proactively and immediately:
- When the user explicitly asks you to remember something
- When a durable identity fact, preference, project constraint, confirmed decision, or reusable lesson should affect future work
- When a correction should replace an older memory; set explicitCorrection=true

Use memory.remember when the user says "记住这个", "以后都这样", "这是我的偏好", or states a durable preference/fact/decision.
Only content is required. Let scope default to auto; do not choose a taxonomy for the user.
When the memory is a stable fact edge, include claim:
- User's preferred name: claim subject=user/self, predicate=preferred_name, object=<name>
- Assistant nickname given by the user: claim subject=assistant/self, predicate=preferred_name, object=<name>
Assistant nickname claims are user preferences; do not treat them as product identity changes.
Do NOT save tasks/Todos/plans in progress, facts readily available from code/Wiki/Skills, temporary execution details, unsupported assistant guesses, secrets, sensitive personal data unless explicitly requested, or anything the user says not to remember.
Never persist an assistant inference unless the conversation or a tool result directly supports it.`
      );
    }

    if (hasMemoryForget) {
      lines.push("Forget: use memory.forget only after an explicit user request and only with a specific memory id. It archives reversibly; never infer a forget request.");
    }

    sections.push(lines.join("\n"));
  }

  return sections;
}
