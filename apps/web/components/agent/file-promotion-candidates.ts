import type { FileEntry } from "@lume/shared";
import type { PromotionCandidate } from "./FilePromotionCard";

const IGNORED_FILE_NAMES = new Set([
  ".DS_Store",
  "Thumbs.db"
]);

const IGNORED_EXTENSIONS = new Set([
  ".tmp",
  ".temp",
  ".log",
  ".bak"
]);

function shouldSuggestPromotion(entry: FileEntry): boolean {
  if (entry.isDirectory) return false;
  if (entry.name.startsWith(".")) return false;
  if (IGNORED_FILE_NAMES.has(entry.name)) return false;
  const lowerName = entry.name.toLowerCase();
  for (const ext of IGNORED_EXTENSIONS) {
    if (lowerName.endsWith(ext)) return false;
  }
  return true;
}

export function buildPromotionCandidates(
  entries: FileEntry[],
  previousPaths: Set<string>
): PromotionCandidate[] {
  return entries
    .filter((entry) => shouldSuggestPromotion(entry) && !previousPaths.has(entry.path))
    .map((entry) => ({
      name: entry.name,
      path: entry.path,
      status: "suggested" as const
    }));
}
