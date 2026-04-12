import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MemoryDistillationResult } from "@lume/shared";
import { getAgentWorkspacePath, getGlobalMemoryPath } from "../infra/config-paths";

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

export async function distillWorkspaceMemory(input: {
  workspaceSlug: string;
}): Promise<MemoryDistillationResult> {
  const workspacePath = getAgentWorkspacePath(input.workspaceSlug);
  const workspaceMemoryPath = join(workspacePath, "MEMORY.md");
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

  const workspaceMemory = readTextIfExists(workspaceMemoryPath);
  const globalCandidates = workspaceMemory
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("[global] "))
    .map((line) => line.slice("[global] ".length).trim())
    .filter(Boolean);

  const promotedToGlobal = globalCandidates.filter((line) => {
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
    promotedToGlobal
  };
}
