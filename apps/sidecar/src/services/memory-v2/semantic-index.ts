import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getMemoryV2ScopePaths } from "./paths";
import type { MemoryV2EmbedTexts } from "./embedding";
import type { MemoryV2RecallItem } from "./types";
import { dotProduct, toFloat32Array } from "./vector-math";

const INDEX_VERSION = 1;

interface VectorIndexFile {
  version: number;
  modelKey: string;
  docs: VectorIndexDoc[];
}

interface VectorIndexDoc {
  id: string;
  path: string;
  mtimeMs: number;
  item: MemoryV2RecallItem;
  embedding: number[];
}

export interface MemoryV2SemanticSearchStatus {
  status: "disabled" | "not_configured" | "available" | "stale" | "failed";
  message: string;
}

export async function searchSemanticRecall(input: {
  workspaceSlug?: string;
  query: string;
  candidates: MemoryV2RecallItem[];
  embedTexts: MemoryV2EmbedTexts;
  modelKey: string;
  maxResults: number;
}): Promise<MemoryV2RecallItem[]> {
  if (input.candidates.length === 0) return [];
  const indexPath = getIndexPath(input.workspaceSlug);
  const index = await loadOrBuildIndex({
    indexPath,
    modelKey: input.modelKey,
    candidates: input.candidates,
    embedTexts: input.embedTexts
  });
  const [queryEmbedding] = await input.embedTexts([input.query]);
  if (!queryEmbedding || queryEmbedding.length === 0) return [];
  const queryVec = toFloat32Array(queryEmbedding);
  return index.docs
    .map((doc) => ({
      item: doc.item,
      score: dotProduct(queryVec, toFloat32Array(doc.embedding))
    }))
    .filter(({ score }) => score > 0.25)
    .sort((a, b) => b.score - a.score)
    .slice(0, input.maxResults)
    .map(({ item, score }) => ({
      ...item,
      reason: `${item.reason}; semantic match`,
      score: Math.max(item.score, 5 + score * 5)
    }));
}

export function getSemanticIndexStatus(input: {
  workspaceSlug: string;
  semantic: "auto" | "off";
  embeddingModelRef?: string;
}): MemoryV2SemanticSearchStatus {
  if (input.semantic === "off") return { status: "disabled", message: "语义召回已关闭" };
  if (!input.embeddingModelRef) return { status: "not_configured", message: "未配置 embedding，基础召回仍可用" };
  const indexPath = getIndexPath(input.workspaceSlug);
  if (!existsSync(indexPath)) return { status: "stale", message: "索引尚未建立，将在召回时重建" };
  try {
    const parsed = JSON.parse(readFileSync(indexPath, "utf-8")) as Partial<VectorIndexFile>;
    if (parsed.modelKey !== input.embeddingModelRef) {
      return { status: "stale", message: "embedding 模型已变化，索引需要重建" };
    }
    return { status: "available", message: "语义召回可用" };
  } catch {
    return { status: "failed", message: "语义索引读取失败，基础召回仍可用" };
  }
}

function getIndexPath(workspaceSlug?: string): string {
  const paths = workspaceSlug
    ? getMemoryV2ScopePaths({ scope: "workspace", workspaceSlug })
    : getMemoryV2ScopePaths({ scope: "global" });
  return join(paths.indexDir, "vector-index.json");
}

async function loadOrBuildIndex(input: {
  indexPath: string;
  modelKey: string;
  candidates: MemoryV2RecallItem[];
  embedTexts: MemoryV2EmbedTexts;
}): Promise<VectorIndexFile> {
  const signatures = input.candidates.map(candidateSignature);
  const cached = readIndex(input.indexPath);
  if (
    cached
    && cached.version === INDEX_VERSION
    && cached.modelKey === input.modelKey
    && sameSignatures(cached.docs, signatures)
  ) {
    return cached;
  }
  const embeddings = await input.embedTexts(input.candidates.map((item) => item.statement));
  const docs = input.candidates.map((item, index) => ({
    ...signatures[index]!,
    item,
    embedding: embeddings[index] ?? []
  })).filter((doc) => doc.embedding.length > 0);
  const next = {
    version: INDEX_VERSION,
    modelKey: input.modelKey,
    docs
  };
  writeFileSync(input.indexPath, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

function readIndex(path: string): VectorIndexFile | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as VectorIndexFile;
    return parsed;
  } catch {
    return undefined;
  }
}

function candidateSignature(item: MemoryV2RecallItem): Pick<VectorIndexDoc, "id" | "path" | "mtimeMs"> {
  return {
    id: item.id,
    path: item.path,
    mtimeMs: fileMtimeMs(item.path)
  };
}

function sameSignatures(docs: VectorIndexDoc[], signatures: Array<Pick<VectorIndexDoc, "id" | "path" | "mtimeMs">>): boolean {
  if (docs.length !== signatures.length) return false;
  return docs.every((doc, index) => {
    const signature = signatures[index];
    return signature
      && doc.id === signature.id
      && doc.path === signature.path
      && doc.mtimeMs === signature.mtimeMs;
  });
}

function fileMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
