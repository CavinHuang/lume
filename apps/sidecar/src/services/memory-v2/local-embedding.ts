import { existsSync, readdirSync, statSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { getMemoryLocalModelsDir } from "../infra/config-paths";
import type { MemoryV2EmbedTexts } from "./embedding";

export const LOCAL_ONNX_MODEL_ID = "Xenova/bge-small-zh-v1.5";
const INIT_TIMEOUT_MS = 15_000;
const EMBED_TIMEOUT_MS = 8_000;
const EMBED_BATCH_SIZE = 32;

export type LocalOnnxMemoryEmbeddingStatus = {
  status: "not_cached" | "cached" | "downloading" | "initializing" | "ready" | "failed";
  modelId: string;
  cacheDir: string;
  error?: string;
};

type WorkerMessage =
  | { type: "ready" }
  | { type: "init_error"; error?: string }
  | { type: "result_batch"; id: number; data: Float32Array; dims: number }
  | { type: "error_batch"; id: number; error?: string };

interface PendingRequest {
  resolve: (vectors: number[][]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 将数组按固定大小切分为多批（最后一批可能不足 size）。size<=0 退化为 1。 */
export function chunkTexts<T>(items: readonly T[], size: number): T[][] {
  const safeSize = Math.max(1, Math.floor(size));
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += safeSize) {
    chunks.push(items.slice(index, index + safeSize));
  }
  return chunks;
}

/** 将扁平的 batch×embedDim Float32Array 切回 number[][]（每条一个向量）。
 *  embedDim 非整除时丢弃尾部不足一个完整向量的部分。 */
export function sliceFlatVectors(flat: Float32Array, embedDim: number): number[][] {
  if (embedDim <= 0) return [];
  const count = Math.floor(flat.length / embedDim);
  const vectors: number[][] = [];
  for (let index = 0; index < count; index += 1) {
    const start = index * embedDim;
    vectors.push(Array.from(flat.subarray(start, start + embedDim)));
  }
  return vectors;
}

let runtimeStatus: LocalOnnxMemoryEmbeddingStatus | undefined;

class LocalOnnxEmbeddingWorker {
  private worker?: Worker;
  private nextRequestId = 1;
  private ready?: Promise<void>;
  private resolveReady?: () => void;
  private rejectReady?: (error: Error) => void;
  private readonly pending = new Map<number, PendingRequest>();

  async embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    await this.ensureReady();
    const batches = chunkTexts(texts, EMBED_BATCH_SIZE);
    const results = await Promise.all(batches.map((batch) => this.embedBatch(batch)));
    return results.flat();
  }

  private ensureReady(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
      setLocalOnnxStatus(hasLocalOnnxModelCache() ? "initializing" : "downloading");
      const initTimer = setTimeout(() => {
        const error = new Error("Local ONNX embedding model initialization timed out.");
        setLocalOnnxStatus("failed", error.message);
        this.failInitialization(error);
      }, INIT_TIMEOUT_MS);
      const workerFile = process.versions.bun ? "./local-embedding-worker.ts" : "./local-embedding-worker.mjs";
      this.worker = new Worker(new URL(workerFile, import.meta.url), {
        workerData: {
          cacheDir: getMemoryLocalModelsDir(),
          modelId: LOCAL_ONNX_MODEL_ID
        }
      });
      this.worker.on("message", (message: WorkerMessage) => {
        if (message.type === "ready") {
          clearTimeout(initTimer);
          setLocalOnnxStatus("ready");
          this.resolveReady?.();
          return;
        }
        if (message.type === "init_error") {
          clearTimeout(initTimer);
          const error = new Error(message.error ?? "Local ONNX embedding model failed to initialize.");
          setLocalOnnxStatus("failed", error.message);
          this.failInitialization(error);
          return;
        }
        this.resolvePending(message);
      });
      this.worker.on("error", (error) => {
        clearTimeout(initTimer);
        const normalized = error instanceof Error ? error : new Error(String(error));
        setLocalOnnxStatus("failed", normalized.message);
        this.failInitialization(normalized);
      });
      this.worker.on("exit", (code) => {
        if (code === 0 || !this.ready) return;
        const error = new Error(`Local ONNX embedding worker exited (${code}).`);
        setLocalOnnxStatus("failed", error.message);
        this.failInitialization(error);
      });
    });
    return this.ready;
  }

  private embedBatch(texts: string[]): Promise<number[][]> {
    const worker = this.worker;
    if (!worker) {
      return Promise.reject(new Error("Local ONNX embedding worker is unavailable."));
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error("Local ONNX embedding request timed out.");
        setLocalOnnxStatus("failed", error.message);
        reject(error);
      }, EMBED_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ type: "embed_batch", id, texts });
    });
  }

  private resolvePending(message: WorkerMessage): void {
    if (message.type !== "result_batch" && message.type !== "error_batch") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.type === "error_batch") {
      const error = new Error(message.error ?? "Local ONNX embedding request failed.");
      setLocalOnnxStatus("failed", error.message);
      pending.reject(error);
      return;
    }
    if (!(message.data instanceof Float32Array) || message.data.length === 0 || message.dims <= 0) {
      const error = new Error("Local ONNX embedding response shape is invalid.");
      setLocalOnnxStatus("failed", error.message);
      pending.reject(error);
      return;
    }
    const vectors = sliceFlatVectors(message.data, message.dims);
    if (vectors.length === 0 || vectors.some((vector) => vector.length === 0)) {
      const error = new Error("Local ONNX embedding response shape is invalid.");
      setLocalOnnxStatus("failed", error.message);
      pending.reject(error);
      return;
    }
    pending.resolve(vectors);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private dispose(): void {
    const worker = this.worker;
    worker?.removeAllListeners();
    worker?.terminate().catch(() => undefined);
    this.worker = undefined;
    this.rejectAll(new Error("Local ONNX embedding worker was disposed."));
  }

  reset(): void {
    const error = new Error("Local ONNX embedding worker was reset.");
    const rejectReady = this.rejectReady;
    this.dispose();
    rejectReady?.(error);
    this.ready = undefined;
    this.resolveReady = undefined;
    this.rejectReady = undefined;
  }

  private failInitialization(error: Error): void {
    const rejectReady = this.rejectReady;
    this.dispose();
    rejectReady?.(error);
    this.ready = undefined;
    this.resolveReady = undefined;
    this.rejectReady = undefined;
  }
}

let singleton: LocalOnnxEmbeddingWorker | undefined;

export function createLocalOnnxMemoryEmbeddingProvider(): MemoryV2EmbedTexts {
  singleton ??= new LocalOnnxEmbeddingWorker();
  return (texts) => singleton!.embedTexts(texts);
}

export function retryLocalOnnxMemoryEmbedding(): void {
  singleton?.reset();
  runtimeStatus = undefined;
  void createLocalOnnxMemoryEmbeddingProvider()(["Lume ONNX embedding health check"]).catch(() => undefined);
}

export function getLocalOnnxMemoryEmbeddingStatus(): LocalOnnxMemoryEmbeddingStatus {
  if (runtimeStatus) return runtimeStatus;
  return buildLocalOnnxStatus(hasLocalOnnxModelCache() ? "cached" : "not_cached");
}

function setLocalOnnxStatus(
  status: LocalOnnxMemoryEmbeddingStatus["status"],
  error?: string
): void {
  runtimeStatus = buildLocalOnnxStatus(status, error);
}

function buildLocalOnnxStatus(
  status: LocalOnnxMemoryEmbeddingStatus["status"],
  error?: string
): LocalOnnxMemoryEmbeddingStatus {
  return {
    status,
    modelId: LOCAL_ONNX_MODEL_ID,
    cacheDir: getMemoryLocalModelsDir(),
    ...(error ? { error } : {})
  };
}

function hasLocalOnnxModelCache(): boolean {
  const cacheDir = getMemoryLocalModelsDir();
  if (!existsSync(cacheDir)) return false;
  const modelName = LOCAL_ONNX_MODEL_ID.split("/").at(-1) ?? LOCAL_ONNX_MODEL_ID;
  const needles = [
    LOCAL_ONNX_MODEL_ID,
    LOCAL_ONNX_MODEL_ID.replace("/", "--"),
    modelName
  ];
  return containsModelFile(cacheDir, needles);
}

function containsModelFile(path: string, needles: string[]): boolean {
  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch {
    return false;
  }
  for (const entry of entries) {
    const child = `${path}/${entry}`;
    let stat;
    try {
      stat = statSync(child);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (containsModelFile(child, needles)) return true;
      continue;
    }
    if (!stat.isFile()) continue;
    if (needles.some((needle) => child.includes(needle))) {
      return true;
    }
  }
  return false;
}
