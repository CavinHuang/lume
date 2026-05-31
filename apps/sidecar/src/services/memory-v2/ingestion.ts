import type {
  MemoryOrganizeHistoryActionCounts,
  MemoryIngestSourcesInput,
  MemoryIngestSourcesItem,
  MemoryIngestSourcesResult
} from "@lume/shared";
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { createLogger } from "../infra/logger";
import { readWorkspacePath } from "../agent/agent-files-service";
import { getAgentWorkspaceBySlug } from "../agent/agent-workspace-manager";
import {
  extractMemoryBatchCandidatesWithLlm,
  type MemoryBatchExtractionCandidate
} from "./extraction";
import { createMemoryV2Store } from "./markdown-store";
import { smartAddMemoryV2Candidate } from "./smart-add";
import type {
  MemoryV2Candidate,
  MemoryV2Scope
} from "./types";

const log = createLogger("memory-v2.ingestion");

const DEFAULT_CHUNK_SIZE = 4000;
const DEFAULT_BATCH_MAX_CHARS = 12000;
const SUPPORTED_WORKSPACE_FILE_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".yaml",
  ".yml"
]);
const MAX_LOCAL_FOLDER_FILES = 200;
const MAX_LOCAL_FOLDER_DEPTH = 6;
const IGNORED_LOCAL_FOLDER_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".cache",
  ".next",
  ".turbo",
  ".venv",
  "__pycache__",
  "build",
  "dist",
  "node_modules"
]);

export type MemoryIngestionSourceKind =
  | "history"
  | "workspace_file"
  | "local_file"
  | "local_folder"
  | "pasted_text";

export interface MemoryIngestionSource {
  id: string;
  kind: MemoryIngestionSourceKind;
  title: string;
  content: string;
  sourceRef: string;
  targetScope?: MemoryV2Scope;
  updatedAt?: number;
  metadata?: Record<string, string>;
}

export interface MemoryIngestionInput {
  workspaceSlug: string;
  sources: MemoryIngestionSource[];
  chunkSize?: number;
  batchMaxChars?: number;
  extractBatchCandidates?: MemoryIngestionBatchExtractor;
}

export type MemoryIngestionItem = MemoryIngestSourcesItem;

export type MemoryIngestionResult = MemoryIngestSourcesResult;

export interface MemoryIngestionChunk {
  id: string;
  source: MemoryIngestionSource;
  sourcePath: string;
  text: string;
  chunkIndex: number;
}

export type MemoryIngestionBatchExtractor = (input: {
  workspaceSlug: string;
  chunks: MemoryIngestionChunk[];
}) => Promise<MemoryBatchExtractionCandidate[]>;

export async function ingestMemorySources(input: MemoryIngestionInput): Promise<MemoryIngestionResult> {
  const workspace = getAgentWorkspaceBySlug(input.workspaceSlug);
  if (!workspace) {
    throw new Error(`工作区不存在: ${input.workspaceSlug}`);
  }

  const actions = emptyActionCounts();
  const items: MemoryIngestionItem[] = [];
  const store = createMemoryV2Store();
  const chunkSize = normalizeChunkSize(input.chunkSize);
  const batchMaxChars = normalizeBatchMaxChars(input.batchMaxChars);
  const chunks: MemoryIngestionChunk[] = [];
  let candidateCount = 0;

  for (const source of input.sources) {
    const sourceChunks = chunkText(source.content, chunkSize);
    if (sourceChunks.length === 0) {
      actions.suppressed += 1;
      items.push({
        sourceId: source.id,
        sourcePath: source.sourceRef,
        statement: source.title,
        action: "suppressed",
        reason: "Source contains no ingestible text."
      });
      continue;
    }

    for (const [index, chunk] of sourceChunks.entries()) {
      chunks.push({
        id: `${source.id}:chunk-${index + 1}`,
        source,
        sourcePath: `${source.sourceRef}#chunk-${index + 1}`,
        text: chunk,
        chunkIndex: index
      });
    }
  }

  const batches = createIngestionBatches(chunks, batchMaxChars);
  const extractBatchCandidates = input.extractBatchCandidates ?? defaultExtractBatchCandidates;
  for (const batch of batches) {
    const candidates = await extractBatchCandidates({
      workspaceSlug: input.workspaceSlug,
      chunks: batch
    });
    const chunkById = new Map(batch.map((chunk) => [chunk.id, chunk]));
    for (const item of candidates) {
      const chunk = chunkById.get(item.sourceId);
      if (!chunk) continue;
      candidateCount += 1;
      const result = await smartAddMemoryV2Candidate({
        workspaceSlug: input.workspaceSlug,
        candidate: candidateWithSourceEvidence(item.candidate, chunk),
        store
      });
      actions[result.action] += 1;
      items.push({
        sourceId: chunk.source.id,
        sourcePath: chunk.sourcePath,
        statement: item.candidate.statement,
        scope: chunk.source.targetScope ?? item.candidate.targetScope,
        kind: item.candidate.kind,
        confidence: item.candidate.confidence,
        action: result.action,
        reason: result.reason,
        ...(result.entry ? { entryId: result.entry.frontmatter.id } : {}),
        ...(result.pending ? { pendingId: result.pending.frontmatter.id } : {})
      });
    }
  }

  const result = {
    workspaceSlug: input.workspaceSlug,
    scannedSources: input.sources.length,
    scannedChunks: chunks.length,
    scannedBatches: batches.length,
    candidateCount,
    actions,
    items
  };

  log.info("ingestMemorySources completed", {
    workspaceSlug: input.workspaceSlug,
    scannedSources: result.scannedSources,
    scannedChunks: result.scannedChunks,
    scannedBatches: result.scannedBatches,
    candidateCount,
    actions
  });

  return result;
}

export async function ingestWorkspaceMemoryFiles(input: {
  workspaceSlug: string;
  paths: string[];
  targetScope?: MemoryV2Scope;
  batchMaxChars?: number;
}): Promise<MemoryIngestionResult> {
  const sources: MemoryIngestionSource[] = [];
  const skippedItems: MemoryIngestionItem[] = [];
  const skippedActions = emptyActionCounts();

  for (const path of input.paths) {
    const sourceRef = `workspace://${input.workspaceSlug}/${path}`;
    if (!isSupportedWorkspaceFile(path)) {
      skippedActions.suppressed += 1;
      skippedItems.push({
        sourcePath: sourceRef,
        statement: path,
        action: "suppressed",
        reason: "Unsupported workspace file type."
      });
      continue;
    }
    const file = readWorkspacePath(input.workspaceSlug, path);
    sources.push({
      id: `workspace:${path}`,
      kind: "workspace_file",
      title: path,
      content: file.content,
      sourceRef,
      targetScope: input.targetScope ?? "workspace",
      metadata: {
        truncated: String(file.truncated)
      }
    });
  }

  const ingested = sources.length > 0
    ? await ingestMemorySources({
      workspaceSlug: input.workspaceSlug,
      sources,
      batchMaxChars: input.batchMaxChars
    })
    : {
      workspaceSlug: input.workspaceSlug,
      scannedSources: 0,
      scannedChunks: 0,
      scannedBatches: 0,
      candidateCount: 0,
      actions: emptyActionCounts(),
      items: []
    };

  return {
    workspaceSlug: input.workspaceSlug,
    scannedSources: input.paths.length,
    scannedChunks: ingested.scannedChunks,
    scannedBatches: ingested.scannedBatches,
    candidateCount: ingested.candidateCount,
    actions: mergeActionCounts(ingested.actions, skippedActions),
    items: [...ingested.items, ...skippedItems]
  };
}

export async function ingestLocalMemoryFiles(input: {
  workspaceSlug: string;
  paths: string[];
  targetScope?: MemoryV2Scope;
  batchMaxChars?: number;
}): Promise<MemoryIngestionResult> {
  const sources: MemoryIngestionSource[] = [];
  const skippedItems: MemoryIngestionItem[] = [];
  const skippedActions = emptyActionCounts();

  for (const path of input.paths) {
    const sourceRef = `file://${path}`;
    if (!isSupportedTextFile(path)) {
      skippedActions.suppressed += 1;
      skippedItems.push({
        sourcePath: sourceRef,
        statement: path,
        action: "suppressed",
        reason: "Unsupported local file type."
      });
      continue;
    }
    const file = await readLocalTextFile(path);
    sources.push({
      id: `local:${path}`,
      kind: "local_file",
      title: path,
      content: file.content,
      sourceRef,
      targetScope: input.targetScope,
      metadata: {
        truncated: String(file.truncated)
      }
    });
  }

  const ingested = sources.length > 0
    ? await ingestMemorySources({
      workspaceSlug: input.workspaceSlug,
      sources,
      batchMaxChars: input.batchMaxChars
    })
    : emptyIngestionResult(input.workspaceSlug);

  return {
    workspaceSlug: input.workspaceSlug,
    scannedSources: input.paths.length,
    scannedChunks: ingested.scannedChunks,
    scannedBatches: ingested.scannedBatches,
    candidateCount: ingested.candidateCount,
    actions: mergeActionCounts(ingested.actions, skippedActions),
    items: [...ingested.items, ...skippedItems]
  };
}

export async function ingestLocalMemoryFolders(input: {
  workspaceSlug: string;
  paths: string[];
  targetScope?: MemoryV2Scope;
  batchMaxChars?: number;
}): Promise<MemoryIngestionResult> {
  const filePaths: string[] = [];
  const skippedItems: MemoryIngestionItem[] = [];
  const skippedActions = emptyActionCounts();

  for (const path of input.paths) {
    const discovered = await listSupportedLocalFolderFiles(path);
    if (discovered.length === 0) {
      skippedActions.suppressed += 1;
      skippedItems.push({
        sourcePath: `file://${path}`,
        statement: path,
        action: "suppressed",
        reason: "No supported local text files found."
      });
      continue;
    }
    filePaths.push(...discovered);
  }

  const ingested = filePaths.length > 0
    ? await ingestLocalMemoryFiles({
      workspaceSlug: input.workspaceSlug,
      paths: filePaths,
      targetScope: input.targetScope,
      batchMaxChars: input.batchMaxChars
    })
    : emptyIngestionResult(input.workspaceSlug);

  return {
    workspaceSlug: input.workspaceSlug,
    scannedSources: filePaths.length + skippedItems.length,
    scannedChunks: ingested.scannedChunks,
    scannedBatches: ingested.scannedBatches,
    candidateCount: ingested.candidateCount,
    actions: mergeActionCounts(ingested.actions, skippedActions),
    items: [...ingested.items, ...skippedItems]
  };
}

export async function ingestExternalMemorySources(
  input: MemoryIngestSourcesInput
): Promise<MemoryIngestSourcesResult> {
  const sources: MemoryIngestionSource[] = [];
  const skippedItems: MemoryIngestionItem[] = [];
  const skippedActions = emptyActionCounts();

  for (const [index, source] of input.sources.entries()) {
    if (source.kind === "pasted_text") {
      const sourceNumber = index + 1;
      sources.push({
        id: `pasted:${sourceNumber}`,
        kind: "pasted_text",
        title: source.title?.trim() || `粘贴文本 ${sourceNumber}`,
        content: source.content,
        sourceRef: `pasted://source-${sourceNumber}`,
        targetScope: source.targetScope
      });
      continue;
    }
    if (source.kind === "workspace_file") {
      const sourceRef = `workspace://${input.workspaceSlug}/${source.path}`;
      if (!isSupportedWorkspaceFile(source.path)) {
        skippedActions.suppressed += 1;
        skippedItems.push({
          sourcePath: sourceRef,
          statement: source.path,
          action: "suppressed",
          reason: "Unsupported workspace file type."
        });
        continue;
      }
      const file = readWorkspacePath(input.workspaceSlug, source.path);
      sources.push({
        id: `workspace:${source.path}`,
        kind: "workspace_file",
        title: source.path,
        content: file.content,
        sourceRef,
        targetScope: source.targetScope ?? "workspace",
        metadata: {
          truncated: String(file.truncated)
        }
      });
      continue;
    }
    if (source.kind === "local_file") {
      const sourceRef = `file://${source.path}`;
      if (!isSupportedTextFile(source.path)) {
        skippedActions.suppressed += 1;
        skippedItems.push({
          sourcePath: sourceRef,
          statement: source.path,
          action: "suppressed",
          reason: "Unsupported local file type."
        });
        continue;
      }
      const file = await readLocalTextFile(source.path);
      sources.push({
        id: `local:${source.path}`,
        kind: "local_file",
        title: source.path,
        content: file.content,
        sourceRef,
        targetScope: source.targetScope,
        metadata: {
          truncated: String(file.truncated)
        }
      });
      continue;
    }
    const discovered = await listSupportedLocalFolderFiles(source.path);
    if (discovered.length === 0) {
      skippedActions.suppressed += 1;
      skippedItems.push({
        sourcePath: `file://${source.path}`,
        statement: source.path,
        action: "suppressed",
        reason: "No supported local text files found."
      });
      continue;
    }
    for (const path of discovered) {
      const file = await readLocalTextFile(path);
      sources.push({
        id: `local:${path}`,
        kind: "local_file",
        title: path,
        content: file.content,
        sourceRef: `file://${path}`,
        targetScope: source.targetScope,
        metadata: {
          truncated: String(file.truncated)
        }
      });
    }
  }

  const ingested = sources.length > 0
    ? await ingestMemorySources({
      workspaceSlug: input.workspaceSlug,
      sources,
      batchMaxChars: input.batchMaxChars
    })
    : emptyIngestionResult(input.workspaceSlug);
  return {
    workspaceSlug: input.workspaceSlug,
    scannedSources: sources.length + skippedItems.length,
    scannedChunks: ingested.scannedChunks,
    scannedBatches: ingested.scannedBatches,
    candidateCount: ingested.candidateCount,
    actions: mergeActionCounts(ingested.actions, skippedActions),
    items: [...ingested.items, ...skippedItems]
  };
}

export function chunkText(text: string, chunkSize = DEFAULT_CHUNK_SIZE): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  if (normalized.length <= chunkSize) return [normalized];

  const chunks: string[] = [];
  let current = "";
  for (const paragraph of normalized.split(/\n{2,}/)) {
    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length <= chunkSize) {
      current = next;
      continue;
    }
    if (current) chunks.push(current);
    if (paragraph.length <= chunkSize) {
      current = paragraph;
      continue;
    }
    for (let index = 0; index < paragraph.length; index += chunkSize) {
      chunks.push(paragraph.slice(index, index + chunkSize).trim());
    }
    current = "";
  }
  if (current) chunks.push(current);
  return chunks.filter(Boolean);
}

export function emptyActionCounts(): MemoryOrganizeHistoryActionCounts {
  return {
    duplicate: 0,
    related: 0,
    mergeable: 0,
    conflict: 0,
    suspected_stale: 0,
    low_confidence: 0,
    new: 0,
    suppressed: 0
  };
}

function candidateWithSourceEvidence(
  candidate: MemoryV2Candidate,
  chunk: MemoryIngestionChunk
): MemoryV2Candidate {
  const targetScope = chunk.source.targetScope ?? candidate.targetScope;
  return {
    ...candidate,
    targetScope,
    evidence: {
      ...candidate.evidence,
      recordIds: [
        ...new Set([
          ...(candidate.evidence?.recordIds ?? []),
          chunk.id
        ])
      ],
      sourceMessages: [
        ...new Set([
          ...(candidate.evidence?.sourceMessages ?? []),
          chunk.text
        ])
      ],
      sourcePaths: [
        ...new Set([
          ...(candidate.evidence?.sourcePaths ?? []),
          chunk.sourcePath
        ])
      ]
    }
  };
}

function createIngestionBatches(chunks: MemoryIngestionChunk[], maxChars: number): MemoryIngestionChunk[][] {
  const batches: MemoryIngestionChunk[][] = [];
  let current: MemoryIngestionChunk[] = [];
  let currentChars = 0;
  for (const chunk of chunks) {
    const nextChars = current.length === 0 ? chunk.text.length : currentChars + chunk.text.length;
    if (current.length > 0 && nextChars > maxChars) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(chunk);
    currentChars += chunk.text.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function defaultExtractBatchCandidates(input: {
  workspaceSlug: string;
  chunks: MemoryIngestionChunk[];
}): Promise<MemoryBatchExtractionCandidate[]> {
  return extractMemoryBatchCandidatesWithLlm({
    workspaceSlug: input.workspaceSlug,
    sources: input.chunks.map((chunk) => ({
      sourceId: chunk.id,
      text: chunk.text
    }))
  });
}

function isSupportedWorkspaceFile(path: string): boolean {
  return isSupportedTextFile(path);
}

function isSupportedTextFile(path: string): boolean {
  return SUPPORTED_WORKSPACE_FILE_EXTENSIONS.has(extname(path).toLowerCase());
}

async function readLocalTextFile(path: string): Promise<{ content: string; truncated: boolean }> {
  const fileStat = await stat(path).catch(() => null);
  if (!fileStat?.isFile()) {
    throw new Error("本地文件不存在");
  }
  const bytes = await readFile(path);
  const limit = 512 * 1024;
  const sampled = bytes.subarray(0, Math.min(bytes.length, 2048));
  if (sampled.includes(0)) {
    throw new Error("暂不支持读取二进制文件");
  }
  return {
    content: bytes.subarray(0, limit).toString("utf-8"),
    truncated: bytes.length > limit
  };
}

async function listSupportedLocalFolderFiles(rootPath: string): Promise<string[]> {
  const rootStat = await stat(rootPath).catch(() => null);
  if (!rootStat?.isDirectory()) {
    throw new Error("本地文件夹不存在");
  }
  const results: string[] = [];

  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > MAX_LOCAL_FOLDER_DEPTH || results.length >= MAX_LOCAL_FOLDER_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (results.length >= MAX_LOCAL_FOLDER_FILES) return;
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || IGNORED_LOCAL_FOLDER_NAMES.has(entry.name)) continue;
        await visit(join(dir, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const path = join(dir, entry.name);
      if (isSupportedTextFile(path)) results.push(path);
    }
  }

  await visit(rootPath, 0);
  return results;
}

function normalizeChunkSize(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_CHUNK_SIZE;
  return Math.max(500, Math.min(12000, Math.trunc(value as number)));
}

function normalizeBatchMaxChars(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_BATCH_MAX_CHARS;
  return Math.max(1, Math.min(50000, Math.trunc(value as number)));
}

function emptyIngestionResult(workspaceSlug: string): MemoryIngestSourcesResult {
  return {
    workspaceSlug,
    scannedSources: 0,
    scannedChunks: 0,
    scannedBatches: 0,
    candidateCount: 0,
    actions: emptyActionCounts(),
    items: []
  };
}

function mergeActionCounts(
  left: MemoryOrganizeHistoryActionCounts,
  right: MemoryOrganizeHistoryActionCounts
): MemoryOrganizeHistoryActionCounts {
  return {
    duplicate: left.duplicate + right.duplicate,
    related: left.related + right.related,
    mergeable: left.mergeable + right.mergeable,
    conflict: left.conflict + right.conflict,
    suspected_stale: left.suspected_stale + right.suspected_stale,
    low_confidence: left.low_confidence + right.low_confidence,
    new: left.new + right.new,
    suppressed: left.suppressed + right.suppressed
  };
}
