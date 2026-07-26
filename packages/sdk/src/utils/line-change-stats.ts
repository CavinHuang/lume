import { normalizeLineEndings } from "./text-file.js";

export interface LineChangeStats {
  linesAdded: number;
  linesRemoved: number;
}

/**
 * Counts the changed middle section. File tools make one replacement at a time,
 * so common prefix/suffix keeps the summary useful without a full diff engine.
 */
export function countLineChanges(before: string, after: string): LineChangeStats {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  return {
    linesAdded: Math.max(0, newLines.length - prefix - suffix),
    linesRemoved: Math.max(0, oldLines.length - prefix - suffix),
  };
}

function splitLines(content: string): string[] {
  const normalized = normalizeLineEndings(content);
  return normalized.length === 0 ? [] : normalized.split("\n");
}
