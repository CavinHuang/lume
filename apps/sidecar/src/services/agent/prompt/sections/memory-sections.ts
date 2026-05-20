import type { MemoryCitationsMode } from "../../../memory-v2/policy";

export function buildMemorySections(ctx: {
  availableTools?: Set<string>;
  citationsMode?: MemoryCitationsMode;
}): string[] {
  const availableTools = ctx.availableTools ?? new Set<string>();
  const hasMemorySearch = availableTools.has("memory.search");
  const hasMemoryRead = availableTools.has("memory.read");
  const hasMemoryWrite = availableTools.has("memory.remember");

  const sections: string[] = [];

  if (hasMemorySearch || hasMemoryRead || hasMemoryWrite) {
    const lines = [
      "## Memory",
      "",
      "Memory is shared experience, not a dossier. Use loaded memory naturally, as continuity.",
      "Do not mention memory internals unless the user asks how you know.",
      "When memory explains continuity, speak directly: \"我们之前聊过这个话题\". Do not say \"从记忆中可以看出\" or similar evidence-report phrasing."
    ];

    if (hasMemorySearch || hasMemoryRead) {
      lines.push(
        "",
        "Recall: use loaded memory first. Search memory only when the user asks about previous work, the answer depends on history not present below, exact dates/source lines matter, or confidence is low."
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
Structured memory — use memory.remember:
- When the user explicitly asks you to remember something
- When a durable preference, project decision, reusable lesson, or important milestone should affect future work
- When a mistake or correction should prevent future errors

Use memory.remember when the user says "记住这个", "以后都这样", "这是我的偏好", or states a durable preference/fact/decision.
Do NOT save trivial exchanges, greetings, or information already in MEMORY.md.`
      );
    }

    sections.push(lines.join("\n"));
  }

  return sections;
}
