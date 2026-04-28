import type { MemoryCitationsMode } from "../../../memory/memory-policy";

export function buildMemorySections(ctx: {
  availableTools?: Set<string>;
  citationsMode?: MemoryCitationsMode;
}): string[] {
  const availableTools = ctx.availableTools ?? new Set<string>();
  const hasMemorySearch = availableTools.has("memory.search") || availableTools.has("memory_search");
  const hasMemoryRead = availableTools.has("memory.read") || availableTools.has("memory_get");
  const hasMemoryWrite = availableTools.has("memory.remember") || availableTools.has("memory.writeEpisode") || availableTools.has("memory.flush") || availableTools.has("memory_save");
  const hasGlobalMemory = availableTools.has("memory.searchGlobal") || availableTools.has("memory.listGlobalCandidates") || availableTools.has("memory.promoteGlobal") || availableTools.has("memory.rejectGlobalCandidate");

  const sections: string[] = [];

  if (hasMemorySearch || hasMemoryRead || hasMemoryWrite || hasGlobalMemory) {
    const lines = [
      "## Memory",
      "",
      "Memory is shared experience, not a dossier. Use loaded memory naturally, as continuity.",
      "Do not mention memory internals unless the user asks how you know."
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
Structured memory — prefer memory.writeEpisode / memory.remember:
- When the user explicitly asks you to remember something
- When a durable preference, project decision, reusable lesson, or important milestone should affect future work
- When a mistake or correction should prevent future errors

Use memory.remember when the user says "记住这个", "以后都这样", "这是我的偏好", or states a durable preference/fact/decision.
Use memory.writeEpisode only for meaningful collaboration episodes; include decisions/preferences/lessons as separate arrays so they become structured memory items.
Do NOT save trivial exchanges, greetings, or information already in MEMORY.md.`
      );
    }

    if (hasGlobalMemory) {
      lines.push(
        "",
        "Global memory: search/list are read-only. Promote or reject global candidates only after explicit user confirmation."
      );
    }

    sections.push(lines.join("\n"));
  }

  return sections;
}
