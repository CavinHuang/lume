import { Worker } from "node:worker_threads";
import { getMemoryLocalModelsDir } from "../infra/config-paths";
import type { MemoryV2EmbedTexts } from "./embedding";

const LOCAL_ONNX_MODEL_ID = "Xenova/bge-small-zh-v1.5";
const INIT_TIMEOUT_MS = 15_000;
const EMBED_TIMEOUT_MS = 8_000;

type WorkerMessage =
  | { type: "ready" }
  | { type: "init_error"; error?: string }
  | { type: "result"; id: number; embedding?: number[] }
  | { type: "error"; id: number; error?: string };

interface PendingRequest {
  resolve: (embedding: number[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class LocalOnnxEmbeddingWorker {
  private worker?: Worker;
  private nextRequestId = 1;
  private ready?: Promise<void>;
  private resolveReady?: () => void;
  private rejectReady?: (error: Error) => void;
  private readonly pending = new Map<number, PendingRequest>();

  async embedTexts(texts: string[]): Promise<number[][]> {
    await this.ensureReady();
    const vectors: number[][] = [];
    for (const text of texts) {
      vectors.push(await this.embedOne(text));
    }
    return vectors;
  }

  private ensureReady(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
      const initTimer = setTimeout(() => {
        this.dispose();
        reject(new Error("Local ONNX embedding model initialization timed out."));
      }, INIT_TIMEOUT_MS);
      this.worker = new Worker(new URL("./local-embedding-worker.ts", import.meta.url), {
        workerData: {
          cacheDir: getMemoryLocalModelsDir(),
          modelId: LOCAL_ONNX_MODEL_ID
        }
      });
      this.worker.on("message", (message: WorkerMessage) => {
        if (message.type === "ready") {
          clearTimeout(initTimer);
          this.resolveReady?.();
          return;
        }
        if (message.type === "init_error") {
          clearTimeout(initTimer);
          const error = new Error(message.error ?? "Local ONNX embedding model failed to initialize.");
          this.dispose();
          this.rejectReady?.(error);
          return;
        }
        this.resolvePending(message);
      });
      this.worker.on("error", (error) => {
        clearTimeout(initTimer);
        this.dispose();
        this.rejectReady?.(error instanceof Error ? error : new Error(String(error)));
      });
      this.worker.on("exit", (code) => {
        if (code === 0) return;
        const error = new Error(`Local ONNX embedding worker exited (${code}).`);
        this.rejectAll(error);
        this.ready = undefined;
      });
    });
    return this.ready;
  }

  private embedOne(text: string): Promise<number[]> {
    const worker = this.worker;
    if (!worker) {
      return Promise.reject(new Error("Local ONNX embedding worker is unavailable."));
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Local ONNX embedding request timed out."));
      }, EMBED_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ type: "embed", id, text });
    });
  }

  private resolvePending(message: WorkerMessage): void {
    if (message.type !== "result" && message.type !== "error") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.type === "error") {
      pending.reject(new Error(message.error ?? "Local ONNX embedding request failed."));
      return;
    }
    if (!Array.isArray(message.embedding) || message.embedding.length === 0) {
      pending.reject(new Error("Local ONNX embedding response shape is invalid."));
      return;
    }
    pending.resolve(message.embedding.filter((value) => Number.isFinite(value)));
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private dispose(): void {
    this.worker?.terminate().catch(() => undefined);
    this.worker = undefined;
    this.rejectAll(new Error("Local ONNX embedding worker was disposed."));
  }
}

let singleton: LocalOnnxEmbeddingWorker | undefined;

export function createLocalOnnxMemoryEmbeddingProvider(): MemoryV2EmbedTexts {
  singleton ??= new LocalOnnxEmbeddingWorker();
  return (texts) => singleton!.embedTexts(texts);
}
