import type { MemorySearchResult, SessionType } from "@lume/shared";
import { readSystemPromptComponents } from "../system/workspace-bootstrap-service";
import { searchLayeredMemory } from "./memory-service";

export interface BuildMemoryContextInput {
  workspaceSlug: string;
  sessionType: SessionType;
  userInput: string;
  maxItems?: number;
  tokenBudget?: number;
}

function truncateForBudget(text: string, tokenBudget?: number): string {
  if (!tokenBudget || tokenBudget <= 0) return text;
  const maxChars = Math.max(200, tokenBudget * 4);
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 1).trimEnd();
}

function normalizeSnippet(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim();
}

function isWorkspaceBriefResult(result: MemorySearchResult): boolean {
  return result.path === "WORKSPACE.md"
    || result.kind === "summary"
    || result.reason === "workspace-brief";
}

function isLongTermWorkspaceMemory(result: MemorySearchResult): boolean {
  return result.path === "MEMORY.md"
    || result.path.endsWith("/MEMORY.md")
    || result.path === "~/.lume/MEMORY.md";
}

function formatRecallLine(index: number, result: MemorySearchResult): string {
  const labelParts = [
    result.kind ?? "memory",
    result.scope ? `scope=${result.scope}` : "",
    result.source ? `source=${result.source}` : ""
  ].filter(Boolean);
  const citation = result.path ? ` (${result.path})` : "";
  return `${index}. [${labelParts.join(", ")}] ${normalizeSnippet(result.snippet)}${citation}`;
}

function splitResults(results: MemorySearchResult[]): {
  global: MemorySearchResult[];
  relevant: MemorySearchResult[];
} {
  const global: MemorySearchResult[] = [];
  const relevant: MemorySearchResult[] = [];
  for (const result of results) {
    if (result.scope === "global") {
      global.push(result);
    } else if (!isWorkspaceBriefResult(result)) {
      relevant.push(result);
    }
  }
  return { global, relevant };
}

export async function buildMemoryContext(input: BuildMemoryContextInput): Promise<string> {
  const maxItems = Math.max(1, Math.min(12, input.maxItems ?? 8));
  const components = readSystemPromptComponents(input.workspaceSlug, {
    sessionType: input.sessionType,
    includeMemory: input.sessionType === "main",
    includeDailyMemory: input.sessionType === "main",
    dailyMemoryDays: 2
  });

  const sections: string[] = ["## Memory Context"];

  if (components.workspace?.trim()) {
    sections.push("### Workspace Brief", truncateForBudget(components.workspace.trim(), Math.min(input.tokenBudget ?? 400, 400)));
  }

  if (input.sessionType === "group" || input.sessionType === "channel") {
    return truncateForBudget(sections.length > 1 ? sections.join("\n\n") : "", input.tokenBudget);
  }

  const results = await searchLayeredMemory({
    workspaceSlug: input.workspaceSlug,
    query: input.userInput,
    maxResults: maxItems,
    includeGlobal: input.sessionType === "main",
    includeWorkspaceBrief: true,
    includeRecent: true,
    includeLongTerm: input.sessionType === "main",
    includeSessions: input.sessionType === "main",
    strategy: "hybrid"
  });

  const visibleResults = input.sessionType === "subagent"
    ? results.filter((result) => result.scope !== "global" && !isLongTermWorkspaceMemory(result))
    : results;

  const { global, relevant } = splitResults(visibleResults);

  if (global.length > 0) {
    sections.push(
      "### Global Preferences",
      global.slice(0, Math.min(3, maxItems)).map((result) => `- ${normalizeSnippet(result.snippet)}`).join("\n")
    );
  }

  if (relevant.length > 0) {
    sections.push(
      "### Relevant Recall",
      relevant.slice(0, maxItems).map((result, index) => formatRecallLine(index + 1, result)).join("\n")
    );
  }

  if (sections.length === 1) {
    return "";
  }

  sections.push("Use these memories as background. Do not expose private memory unless it is directly relevant.");
  return truncateForBudget(sections.join("\n\n"), input.tokenBudget);
}
