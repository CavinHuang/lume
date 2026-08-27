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
  const cached = readIndex(input.indexPath);
  const modelMatches = !!cached
    && cached.version === INDEX_VERSION
    && cached.modelKey === input.modelKey;
  // #527-4：签名按 id 走 Map 比对——候选列表顺序不再是重建触发器；
  // 签名仍含 mtimeMs 作为逐文档失效信号，但只在向量缺失时补嵌该条，
  // 取消「任一差异→全部候选重嵌入」的全有或全无设计（touch 只伤单条）
  const cachedById = new Map<string, VectorIndexDoc>(
    modelMatches ? cached!.docs.map((doc) => [doc.id, doc]) : []
  );
  const plan = input.candidates.map((item) => {
    const signature = candidateSignature(item);
    const hit = cachedById.get(item.id);
    const usable =
      hit && hit.path === signature.path && hit.mtimeMs === signature.mtimeMs;
    return { item, signature, ...(usable && hit ? { cachedEmbedding: hit.embedding } : {}) };
  });

  const pending = plan.filter((entry) => !entry.cachedEmbedding);
  const pendingEmbeddings = pending.length > 0
    ? await input.embedTexts(pending.map((entry) => entry.item.statement))
    : [];
  const embeddingById = new Map<string, number[]>();
  pending.forEach((entry, index) => {
    embeddingById.set(entry.signature.id, pendingEmbeddings[index] ?? []);
  });

  const docs = plan.flatMap((entry) => {
    const embedding = entry.cachedEmbedding ?? embeddingById.get(entry.signature.id) ?? [];
    if (embedding.length === 0) return [];
    return [{ ...entry.signature, item: entry.item, embedding }];
  });
  const next = {
    version: INDEX_VERSION,
    modelKey: input.modelKey,
    docs
  };
  // 全命中时无需回写（内容与缓存语义等价），避免每次召回白写一遍索引
  if (pending.length > 0 || !modelMatches) {
    writeFileSync(input.indexPath, JSON.stringify(next, null, 2), "utf-8");
  }
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

function fileMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
