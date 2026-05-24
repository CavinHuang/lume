import { parentPort, workerData } from "node:worker_threads";

type TransformersModule = {
  pipeline: (
    task: "feature-extraction",
    model: string,
    options: { quantized: boolean; revision: string }
  ) => Promise<(text: string, options: { pooling: "mean"; normalize: boolean }) => Promise<{ data: ArrayLike<number> }>>;
  env: {
    cacheDir?: string;
    allowLocalModels?: boolean;
    allowRemoteModels?: boolean;
  };
};

type WorkerRequest = {
  type: "embed";
  id: number;
  text: string;
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
  if (message.type !== "embed") return;
  if (!embedder) {
    parentPort?.postMessage({ type: "error", id: message.id, error: "local embedding model is not ready" });
    return;
  }
  try {
    const result = await embedder(message.text.slice(0, DEFAULT_MAX_INPUT_LENGTH), {
      pooling: "mean",
      normalize: true
    });
    parentPort?.postMessage({
      type: "result",
      id: message.id,
      embedding: Array.from(result.data)
    });
  } catch (error) {
    parentPort?.postMessage({
      type: "error",
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
