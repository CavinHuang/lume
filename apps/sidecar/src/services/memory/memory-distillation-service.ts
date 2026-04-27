import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MemoryDistillationResult, MemoryDistillInput, MemoryKind } from "@lume/shared";
import { getAgentWorkspacePath, getGlobalMemoryPath, getWorkspaceMemoryDbPath } from "../infra/config-paths";
import { MemoryRepository } from "./memory-repository";
import { generateGlobalCandidates } from "./memory-global-promoter";

function readTextIfExists(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf-8");
}

function appendUniqueLines(path: string, lines: string[]): boolean {
  if (lines.length === 0) return false;
  const existing = readTextIfExists(path);
  const existingSet = new Set(
    existing
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  );
  const toAppend = lines.filter((line) => !existingSet.has(line.trim()));
  if (toAppend.length === 0) return false;

  const prefix = existing.trim().length > 0 ? "\n" : "";
  writeFileSync(path, `${existing}${prefix}${toAppend.join("\n")}\n`, "utf-8");
  return true;
}

function normalizeDistilledLine(line: string): string {
  return line
    .replace(/^[-*]\s+/, "")
    .replace(/^\[(decision|preference|fact|lesson|milestone|episode)\]\s*/i, "")
    .trim();
}

function classifyDistilledLine(line: string): MemoryKind {
  if (/^\s*[-*]?\s*\[decision\]/i.test(line) || /\b(decided|decision|采用|确定)\b/i.test(line)) {
    return "decision";
  }
  if (/^\s*[-*]?\s*\[preference\]/i.test(line) || /\b(prefers?|preference|偏好)\b/i.test(line)) {
    return "preference";
  }
  if (/^\s*[-*]?\s*\[lesson\]/i.test(line) || /\b(lesson|pitfall|踩坑)\b/i.test(line)) {
    return "lesson";
  }
  if (/^\s*[-*]?\s*\[milestone\]/i.test(line) || /\b(milestone|released|完成)\b/i.test(line)) {
    return "milestone";
  }
  if (/^\s*[-*]?\s*\[episode\]/i.test(line)) {
    return "episode";
  }
  return "fact";
}

function appendWorkspaceBriefDecisions(path: string, decisions: string[]): boolean {
  if (decisions.length === 0) return false;
  const existing = readTextIfExists(path);
  const existingSet = new Set(
    existing
      .split(/\r?\n/)
      .map((line) => line.replace(/^[-*]\s+/, "").trim())
      .filter(Boolean)
  );
  const toAppend = decisions.filter((line) => !existingSet.has(line.trim()));
  if (toAppend.length === 0) return false;

  const base = existing.trim().length > 0
    ? existing
    : [
        "# WORKSPACE.md - Workspace Brief",
        "",
        "## Important Decisions",
        ""
      ].join("\n");
  const hasDecisionHeading = /^## Important Decisions\s*$/im.test(base);
  const prefix = base.endsWith("\n") ? "" : "\n";
  const block = toAppend.map((line) => `- ${line}`).join("\n");
  const next = hasDecisionHeading
    ? `${base}${prefix}${block}\n`
    : `${base}${prefix}\n## Important Decisions\n\n${block}\n`;
  writeFileSync(path, next, "utf-8");
  return true;
}

function collectWorkspaceDailyMemoryLines(workspacePath: string): string[] {
  const memoryDir = join(workspacePath, "memory");
  if (!existsSync(memoryDir)) return [];

  const files = readdirSync(memoryDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/i.test(entry.name))
    .map((entry) => join(memoryDir, entry.name))
    .sort();

  return files.flatMap((file) =>
    readFileSync(file, "utf-8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
  );
}

export async function distillWorkspaceMemory(input: MemoryDistillInput): Promise<MemoryDistillationResult> {
  const workspacePath = getAgentWorkspacePath(input.workspaceSlug);
  const workspaceMemoryPath = join(workspacePath, "MEMORY.md");
  const workspaceBriefPath = join(workspacePath, "WORKSPACE.md");
  const globalMemoryPath = getGlobalMemoryPath();
  const dailyLines = collectWorkspaceDailyMemoryLines(workspacePath);

  const counts = new Map<string, number>();
  for (const line of dailyLines) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }

  const distilledWorkspaceLines = Array.from(counts.entries())
    .filter(([, count]) => count >= 2)
    .map(([line]) => line);

  const updatedWorkspaceMemory = appendUniqueLines(workspaceMemoryPath, distilledWorkspaceLines);

  const repository = new MemoryRepository({
    dbPath: getWorkspaceMemoryDbPath(input.workspaceSlug),
    workspaceSlug: input.workspaceSlug
  });
  let createdItems = 0;
  let skippedItems = 0;
  const decisionLines: string[] = [];
  const createdMemoryIds: string[] = [];
  try {
    const existingItems = await repository.listByWorkspace(input.workspaceSlug);
    const existingDistilledContent = new Set(
      existingItems
        .filter((item) => item.source === "distillation")
        .map((item) => item.content.trim())
    );
    for (const rawLine of distilledWorkspaceLines) {
      const content = normalizeDistilledLine(rawLine);
      if (!content) continue;
      if (existingDistilledContent.has(content)) {
        skippedItems += 1;
        continue;
      }
      const kind = classifyDistilledLine(rawLine);
      const saved = await repository.save({
        workspaceSlug: input.workspaceSlug,
        scope: "workspace",
        kind,
        source: "distillation",
        content,
        sourcePath: "MEMORY.md",
        importance: kind === "decision" || kind === "preference" ? 4 : 3,
        confidence: 0.8
      });
      createdItems += 1;
      createdMemoryIds.push(saved.id);
      existingDistilledContent.add(content);
      if (kind === "decision") {
        decisionLines.push(content);
      }
    }
  } finally {
    repository.dispose();
  }

  const updatedWorkspaceBrief = appendWorkspaceBriefDecisions(workspaceBriefPath, decisionLines);
  const generatedGlobalCandidates = input.generateGlobalCandidates
    ? await generateGlobalCandidates({
        workspaceSlug: input.workspaceSlug,
        memoryIds: createdMemoryIds
      })
    : [];

  const workspaceMemory = readTextIfExists(workspaceMemoryPath);
  const globalPromotionLines = workspaceMemory
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("[global] "))
    .map((line) => line.slice("[global] ".length).trim())
    .filter(Boolean);

  const promotedToGlobal = globalPromotionLines.filter((line) => {
    const before = readTextIfExists(globalMemoryPath);
    const globalDir = dirname(globalMemoryPath);
    if (!existsSync(globalDir)) {
      mkdirSync(globalDir, { recursive: true });
    }
    const changed = appendUniqueLines(globalMemoryPath, [line]);
    const after = readTextIfExists(globalMemoryPath);
    return changed && before !== after;
  });

  return {
    workspaceSlug: input.workspaceSlug,
    updatedWorkspaceMemory,
    promotedToGlobal,
    createdItems,
    updatedItems: 0,
    skippedItems,
    invalidatedItems: 0,
    updatedWorkspaceBrief,
    scannedFiles: dailyLines.length > 0 ? 1 : 0,
    candidateItems: distilledWorkspaceLines.length,
    globalCandidateCount: generatedGlobalCandidates.length
  };
}
