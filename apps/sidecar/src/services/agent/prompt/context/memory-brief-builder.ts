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

  // 仅承载数据；使用记忆的行为规则由静态 prompt 的「## 记忆」段单点声明
  const lines: string[] = [];

  if (durable.length > 0) {
    lines.push("长期：");
    for (const item of durable) {
      lines.push(`- ${item}`);
    }
  }

  if (recent.length > 0) {
    lines.push(...(lines.length > 0 ? [""] : []), "近期：");
    for (const item of recent) {
      lines.push(`- ${item}`);
    }
  }

  return lines.join("\n");
}
