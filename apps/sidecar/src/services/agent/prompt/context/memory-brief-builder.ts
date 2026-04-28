export interface MemoryBriefInput {
  longTermMemory?: string;
  dailyMemory?: string;
}

function extractMeaningfulLines(content?: string): string[] {
  if (!content?.trim()) return [];
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^#{1,6}\s+/.test(line))
    .filter((line) => !/^---+$/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);
}

function uniqueTake(lines: string[], limit: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of lines) {
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(line);
    if (result.length >= limit) break;
  }
  return result;
}

export function buildMemoryBrief(input: MemoryBriefInput): string {
  const durable = uniqueTake(extractMeaningfulLines(input.longTermMemory), 6);
  const recent = uniqueTake(extractMeaningfulLines(input.dailyMemory), 4);
  if (durable.length === 0 && recent.length === 0) return "";

  const lines = [
    "Memory is shared experience, not a dossier.",
    "Use loaded memory naturally. Search only when deeper detail is needed."
  ];

  if (durable.length > 0) {
    lines.push("", "Durable:");
    for (const item of durable) {
      lines.push(`- ${item}`);
    }
  }

  if (recent.length > 0) {
    lines.push("", "Recent:");
    for (const item of recent) {
      lines.push(`- ${item}`);
    }
  }

  return lines.join("\n");
}
