import { parentPort, workerData } from "node:worker_threads";

type TransformersModule = {
  pipeline: (
    task: "feature-extraction",
    model: string,
    options: { quantized: boolean; revision: string }
  ) => Promise<(
    texts: string | string[],
    options: { pooling: "mean"; normalize: boolean }
  ) => Promise<{ data: ArrayLike<number>; dims: number[] }>>;
  env: {
    cacheDir?: string;
    allowLocalModels?: boolean;
    allowRemoteModels?: boolean;
  };
};

type WorkerRequest = {
  type: "embed_batch";
  id: number;
  texts: string[];
};

const DEFAULT_MAX_INPUT_LENGTH = 512;

let embedder: Awaited<ReturnType<TransformersModule["pipeline"]>> | undefined;

async function initialize(): Promise<void> {
  const { pipeline, env } = await import("@xenova/transformers") as unknown as TransformersModule;
  const data = workerData as { cacheDir?: string; modelId?: string };
  if (data.cacheDir) env.cacheDir = data.cacheDir;
  env.allowLocalModels = true;
  env.allowRemoteModels = true;
  embedder = await pipeline("feature-extraction", data.modelId ?? "Xenova/bge-small-zh-v1.5", {
    quantized: true,
    revision: "main"
  });
}

parentPort?.on("message", async (message: WorkerRequest) => {
  if (message.type !== "embed_batch") return;
  if (!embedder) {
    parentPort?.postMessage({ type: "error_batch", id: message.id, error: "local embedding model is not ready" });
    return;
  }
  try {
    const truncated = message.texts.map((text) => text.slice(0, DEFAULT_MAX_INPUT_LENGTH));
    const result = await embedder(truncated, { pooling: "mean", normalize: true });
    const data = result.data instanceof Float32Array
      ? result.data
      : Float32Array.from(result.data);
    // result.dims = [batchSize, embedDim]，取最后一维作为向量维度。
    const dims = result.dims[result.dims.length - 1] ?? 0;
    if (dims <= 0 || data.length === 0) {
      parentPort?.postMessage({ type: "error_batch", id: message.id, error: "empty embedding result" });
      return;
    }
    parentPort?.postMessage(
      { type: "result_batch", id: message.id, data, dims },
      // data 为 Float32Array.from / 原生 Float32Array，其 buffer 为 ArrayBuffer（transformers.js
      // 不使用 SharedArrayBuffer），可零拷贝 transfer。TS 的 ArrayBufferLike 类型过宽，断言收窄。
      [data.buffer as ArrayBuffer]
    );
  } catch (error) {
    parentPort?.postMessage({
      type: "error_batch",
      id: message.id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

initialize()
  .then(() => parentPort?.postMessage({ type: "ready" }))
  .catch((error) => {
    parentPort?.postMessage({
      type: "init_error",
      error: error instanceof Error ? error.message : String(error)
    });
  });
