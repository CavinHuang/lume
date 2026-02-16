import { createHash } from "node:crypto";
import {
  DEFAULT_CHUNK_OVERLAP_TOKENS,
  DEFAULT_CHUNK_TOKENS,
  DEFAULT_EMBEDDING_MODEL,
  TOKEN_TO_CHAR_RATIO
} from "./constants";
import type { ChunkingConfig, MemoryChunk } from "./types";

interface LineEntry {
  line: string;
  lineNo: number;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function buildChunk(entries: LineEntry[], path: string, model: string): MemoryChunk {
  const startLine = entries[0]?.lineNo ?? 1;
  const endLine = entries[entries.length - 1]?.lineNo ?? startLine;
  const text = entries.map((entry) => entry.line).join("\n");
  const contentHash = sha256(text).slice(0, 16);
  const raw = `markdown:${path}:${startLine}:${endLine}:${contentHash}:${model}`;

  return {
    id: sha256(raw).slice(0, 16),
    path,
    text,
    startLine,
    endLine,
    hash: contentHash,
    model
  };
}

function splitLongLine(line: string, maxChars: number): string[] {
  if (line.length === 0) return [""];

  const segments: string[] = [];
  for (let start = 0; start < line.length; start += maxChars) {
    segments.push(line.slice(start, start + maxChars));
  }
  return segments;
}

function sumEntriesChars(entries: LineEntry[]): number {
  return entries.reduce((total, entry) => total + entry.line.length + 1, 0);
}

function carryOverlap(entries: LineEntry[], overlapChars: number): LineEntry[] {
  if (overlapChars <= 0 || entries.length === 0) return [];

  let acc = 0;
  const kept: LineEntry[] = [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!entry) continue;
    kept.unshift(entry);
    acc += entry.line.length + 1;
    if (acc >= overlapChars) break;
  }

  return kept;
}

export function resolveChunkingConfig(input?: Partial<ChunkingConfig>): ChunkingConfig {
  return {
    tokens: input?.tokens ?? DEFAULT_CHUNK_TOKENS,
    overlap: input?.overlap ?? DEFAULT_CHUNK_OVERLAP_TOKENS,
    model: input?.model ?? DEFAULT_EMBEDDING_MODEL
  };
}

export function chunkMarkdown(content: string, path: string, input?: Partial<ChunkingConfig>): MemoryChunk[] {
  if (!content.trim()) return [];

  const config = resolveChunkingConfig(input);
  const maxChars = Math.max(32, config.tokens * TOKEN_TO_CHAR_RATIO);
  const overlapChars = Math.max(0, config.overlap * TOKEN_TO_CHAR_RATIO);
  const lines = content.split("\n");

  const chunks: MemoryChunk[] = [];
  let current: LineEntry[] = [];
  let currentChars = 0;

  const flushWithOverlap = (): void => {
    if (current.length === 0) return;

    const snapshot = [...current];
    chunks.push(buildChunk(snapshot, path, config.model));

    current = carryOverlap(snapshot, overlapChars);
    currentChars = sumEntriesChars(current);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;
    const segments = splitLongLine(line, maxChars);

    for (const segment of segments) {
      const segmentSize = segment.length + 1;
      if (currentChars + segmentSize > maxChars && current.length > 0) {
        flushWithOverlap();
      }
      current.push({ line: segment, lineNo });
      currentChars += segmentSize;
    }
  }

  if (current.length > 0) {
    chunks.push(buildChunk(current, path, config.model));
  }

  return chunks;
}

/**
 * Remap chunk startLine/endLine from content-relative positions to original
 * source file positions using a lineMap.
 *
 * Migrated from:
 * /Users/cavinhuang/workspace/projects/test/openclaw/src/memory/internal.ts
 */
export function remapChunkLines(
  chunks: Array<{ startLine: number; endLine: number }>,
  lineMap: number[] | undefined
): void {
  if (!lineMap || lineMap.length === 0) {
    return;
  }
  for (const chunk of chunks) {
    chunk.startLine = lineMap[chunk.startLine - 1] ?? chunk.startLine;
    chunk.endLine = lineMap[chunk.endLine - 1] ?? chunk.endLine;
  }
}
