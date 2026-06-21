# Phase 4：本地 embedding 批量化 + 向量化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **所属**：性能优化路线图 Phase 4（核心三项）。设计 spec：`docs/superpowers/specs/2026-06-21-perf-be-embedding-batch-design.md`。路线图总览：`docs/superpowers/plans/2026-06-21-performance-optimization-roadmap.md`。

**Goal:** 把本地 ONNX embedding 从「N 条文本 = N 次串行 forward + N 次 worker IPC」降为「1 次 batched forward + 1 次 IPC（按 chunk=32 分批）」，向量相似度从 `number[]` 的 `cosineSimilarity`（算两次范数）改为 `Float32Array` 的 `dotProduct`（归一化向量省范数），并抽取共享 util 消除两处重复实现。

**Architecture:** `@xenova/transformers@^2.17.2` 的 feature-extraction pipeline 原生支持 `string[]` 批量输入，pooling+normalize 后返回形状 `[batchSize, embedDim]` 的 Tensor（`.data` 扁平 `Float32Array`、`.dims` 为 shape）。worker 协议从 `embed`（单条）改为 `embed_batch`（多条 → 扁平 `Float32Array` + `dims`），用 transfer list 零拷贝回主线程。主线程 `embedTexts` 按 chunk=32 分批 `postMessage`、收齐切片成 `number[][]`。**对外接口 `MemoryV2EmbedTexts = (texts) => Promise<number[][]>` 不变**，调用方（`semantic-index`/`smart-add`/`retrieval`）与 remote 路径（OpenAI/Google）零改动。`Float32Array`/`dotProduct` 仅作为 worker→主线程的传输表示与 `semantic-index` 召回的内存计算表示。向量已归一化（worker `normalize:true`；OpenAI/Google 默认归一化），故 `dotProduct ≡ cosineSimilarity`，`smart-add` 的 `0.92` 与 `semantic-index` 的 `0.25` 阈值数值零变化。

**Tech Stack:** Bun + `node:worker_threads` + `@xenova/transformers` + `bun:test`。

**审查依据:** `local-embedding.ts:39-46`（`embedTexts` 串行 for-await `embedOne`）、`local-embedding-worker.ts:38-61`（单条 `embed` 协议）、`semantic-index.ts:44-59,156-171`（召回 `cosineSimilarity` + 本地实现）、`smart-add.ts:221-234,309-324`（重复 `cosineSimilarity`）。

**诚实的范围边界:**
- ✅ **本 plan 优化**：本地 ONNX batch embedding（worker `embed_batch` + 主线程分批 + transfer list）；`semantic-index` 召回 `Float32Array` + `dotProduct`；`cosineSimilarity` 抽 `vector-math.ts` 共享，`semantic-index` 与 `smart-add` 复用。
- ⚠️ **不在本 plan**（留待对应 Phase）：二进制 `.bin` 索引（Phase 8 ANN 前置）、模型启动预热（Phase 9 启动期）、Google 远程并发（远程低频路径）。`vector-index.json` 磁盘格式不变、`INDEX_VERSION` 不升、零迁移。
- ⚠️ **不保留旧 `embed` 单条协议**：grep 确认 `{type:"embed"}` 仅 `local-embedding.ts` 内部使用，无外部/磁盘依赖，直接删除（单条退化为 `texts.length===1` 的 batch 特例）。
- ⚠️ **不保留 `message.embedding.filter(Number.isFinite)`**：normalize 输出不含 NaN/Infinity；原 filter 若遇 NaN 会改变向量长度导致维度错乱（潜在 bug），新实现不 filter、保持维度，更安全。

---

## File Structure

- Create: `apps/sidecar/src/services/memory-v2/vector-math.ts` — 导出 `dotProduct`（归一化向量相似度，TypedArray 索引）+ `toFloat32Array`（类型归一化 helper）。纯函数，无副作用。
- Create: `apps/sidecar/src/services/memory-v2/vector-math.test.ts` — `dotProduct` 等价性（≡ 旧 `cosineSimilarity`）+ 边界单测。
- Modify: `apps/sidecar/src/services/memory-v2/local-embedding-worker.ts` — 协议改 `embed_batch`：一次 forward 多文本，扁平 `Float32Array` + `dims` + transfer list 返回。删旧 `embed` 分支。
- Modify: `apps/sidecar/src/services/memory-v2/local-embedding.ts` — 新增 export 纯函数 `chunkTexts`/`sliceFlatVectors`；`embedTexts` 改分批 `postMessage`/收齐切片；pending 改 per-batch-id；`WorkerMessage` 类型改。删 `embedOne` 与旧协议分支。
- Create: `apps/sidecar/src/services/memory-v2/local-embedding.test.ts` — `chunkTexts`/`sliceFlatVectors` 纯函数单测。
- Modify: `apps/sidecar/src/services/memory-v2/semantic-index.ts` — 删本地 `cosineSimilarity`（L156-171），import `dotProduct`/`toFloat32Array`；召回前 query/doc 转 `Float32Array` 用 `dotProduct`；存盘仍 `number[]`。
- Create: `apps/sidecar/src/services/memory-v2/semantic-index.test.ts` — `searchSemanticRecall` 逻辑单测（mock `embedTexts` 注入固定向量，不依赖真实模型）。
- Modify: `apps/sidecar/src/services/memory-v2/smart-add.ts` — 删本地 `cosineSimilarity`（L309-324），import `dotProduct`/`toFloat32Array`；`findSemanticDuplicate` 改 `dotProduct`。
- Create（可选）: `apps/sidecar/src/services/memory-v2/embedding-batch-equiv.test.ts` — batch vs 逐条向量等价性集成测试，需真实模型，默认 skip。

---

## Task 0：记录 memory-v2 测试基线

**Files:** 无（只读）

- [ ] **Step 1: 跑 memory-v2 全部 test，记录基线**

Run: `bun test apps/sidecar/src/services/memory-v2/`
Expected: 一组 pass/fail 数字（**记下总数与每个文件的 pass/fail**）。这是零回归对比锚点——本 plan 所有改动完成后，重跑此命令，结果应与新加测试的增量一致、无新增 fail。

> 若基线本身有 pre-existing fail（如依赖 desktop-api 的用例），记下是哪些，后续对比时排除。

- [ ] **Step 2: 单独确认 embedding 现有 test 基线**

Run: `bun test apps/sidecar/src/services/memory-v2/embedding.test.ts apps/sidecar/src/services/memory-v2/smart-add.test.ts apps/sidecar/src/services/memory-v2/retrieval.test.ts`
Expected: 记录这三个文件的 pass/fail。Task 3/4 改动 `semantic-index`/`smart-add` 后，这三个必须保持一致（零回归）。

---

## Task 1：vector-math.ts（dotProduct + toFloat32Array）

**Files:**
- Create: `apps/sidecar/src/services/memory-v2/vector-math.ts`
- Test: `apps/sidecar/src/services/memory-v2/vector-math.test.ts`

- [ ] **Step 1: 写失败测试**

Create `apps/sidecar/src/services/memory-v2/vector-math.test.ts`:

```ts
import { expect, test } from "bun:test";
import { dotProduct, toFloat32Array } from "./vector-math";

// 旧 cosineSimilarity 实现（从 semantic-index.ts / smart-add.ts 原样拷贝），作等价性 oracle。
function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    dot += av * bv;
    aNorm += av * av;
    bNorm += bv * bv;
  }
  if (aNorm === 0 || bNorm === 0) return 0;
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

function l2normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((sum, value) => sum + value * value, 0));
  return norm === 0 ? vec : vec.map((value) => value / norm);
}

const SAMPLES = [
  [1, 0, 0],
  [0.6, 0.8, 0],
  [0.1, 0.2, 0.3, 0.9],
  [3, 4, 0],
  [-0.5, 0.5, 0.7],
  [1, 2, 3, 4] // 不等长样本，用于 min-length 对齐
];

test("dotProduct 对归一化向量 ≡ 旧 cosineSimilarity（等长，容差 1e-6）", () => {
  for (const a of SAMPLES) {
    for (const b of SAMPLES) {
      if (a.length !== b.length) continue;
      const an = l2normalize(a);
      const bn = l2normalize(b);
      expect(dotProduct(toFloat32Array(an), toFloat32Array(bn))).toBeCloseTo(
        cosineSimilarity(an, bn),
        6
      );
    }
  }
});

test("dotProduct 不等长输入与旧 cosineSimilarity 等价（取 min length）", () => {
  const an = l2normalize([1, 2, 3, 4]);
  const bn = l2normalize([5, 6]); // 不等长
  expect(dotProduct(toFloat32Array(an), toFloat32Array(bn))).toBeCloseTo(
    cosineSimilarity(an, bn),
    6
  );
});

test("dotProduct 正交向量 = 0", () => {
  expect(dotProduct(toFloat32Array([1, 0]), toFloat32Array([0, 1]))).toBeCloseTo(0, 6);
});

test("dotProduct 归一化向量自比 = 1", () => {
  const v = l2normalize([3, 4, 5]);
  expect(dotProduct(toFloat32Array(v), toFloat32Array(v))).toBeCloseTo( 1, 6);
});

test("dotProduct 全零向量 = 0（不抛错）", () => {
  expect(dotProduct(toFloat32Array([0, 0, 0]), toFloat32Array([1, 0, 0]))).toBe(0);
});

test("dotProduct 空向量 = 0", () => {
  expect(dotProduct(toFloat32Array([]), toFloat32Array([1, 2]))).toBe(0);
});

test("toFloat32Array 透传 Float32Array、拷贝 number[]", () => {
  const f32 = new Float32Array([1, 2, 3]);
  expect(toFloat32Array(f32)).toBe(f32);
  expect(toFloat32Array([1, 2, 3])).toEqual(new Float32Array([1, 2, 3]));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test apps/sidecar/src/services/memory-v2/vector-math.test.ts`
Expected: FAIL —— `Cannot find module './vector-math'`（或导入失败）。

- [ ] **Step 3: 实现 vector-math.ts**

Create `apps/sidecar/src/services/memory-v2/vector-math.ts`:

```ts
// 共享向量相似度工具。
//
// memory-v2 所有 embedding 路径的向量均已 L2 归一化：
//   - 本地 ONNX worker 输出 normalize:true
//   - OpenAI / Google embedding API 默认返回归一化向量
// 因此余弦相似度退化为点积——省去两次范数计算，且 Float32Array 索引优于 number[]。
// 对【未归一化】的向量，dotProduct 不等于余弦（由 vector-math.test 守护该假设）。

/**
 * 类型归一化：把任意数值数组视图转为 Float32Array（已是 Float32Array 则透传同引用）。
 * 不做数学归一化——调用方需保证向量已 L2 归一化。
 */
export function toFloat32Array(values: ArrayLike<number>): Float32Array {
  return values instanceof Float32Array ? values : new Float32Array(values);
}

/**
 * 归一化向量的相似度（对归一化向量 = 余弦相似度）。
 * 维度不匹配时按较短长度对齐（与旧 cosineSimilarity 实现一致）。
 */
export function dotProduct(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let dot = 0;
  for (let index = 0; index < length; index += 1) {
    dot += a[index]! * b[index]!;
  }
  return dot;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test apps/sidecar/src/services/memory-v2/vector-math.test.ts`
Expected: PASS（全部 7 个用例）。

- [ ] **Step 5: typecheck**

Run: `bun run --filter @lume/sidecar typecheck`
Expected: 无新增错误。

- [ ] **Step 6: Commit**

```bash
git add apps/sidecar/src/services/memory-v2/vector-math.ts apps/sidecar/src/services/memory-v2/vector-math.test.ts
git commit -m "⚡️ perf(memory-v2): 新增 vector-math 共享 util（dotProduct + toFloat32Array），归一化向量省两次范数"
```

---

## Task 2：local-embedding 批量化（纯函数 + worker embed_batch + 主线程分批）

**Files:**
- Modify: `apps/sidecar/src/services/memory-v2/local-embedding-worker.ts`
- Modify: `apps/sidecar/src/services/memory-v2/local-embedding.ts`
- Test: `apps/sidecar/src/services/memory-v2/local-embedding.test.ts`

- [ ] **Step 1: 写纯函数失败测试**

Create `apps/sidecar/src/services/memory-v2/local-embedding.test.ts`:

```ts
import { expect, test } from "bun:test";
import { chunkTexts, sliceFlatVectors } from "./local-embedding";

test("chunkTexts 按大小分批（不足一批、刚好、多批）", () => {
  expect(chunkTexts([], 3)).toEqual([]);
  expect(chunkTexts([1, 2], 3)).toEqual([[1, 2]]);
  expect(chunkTexts([1, 2, 3], 3)).toEqual([[1, 2, 3]]);
  expect(chunkTexts([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
});

test("chunkTexts size <= 0 退化保护为 1", () => {
  expect(chunkTexts([1, 2, 3], 0)).toEqual([[1], [2], [3]]);
  expect(chunkTexts([1, 2], -1)).toEqual([[1], [2]]);
});

test("sliceFlatVectors 将扁平 batch×embedDim 切回 number[][]", () => {
  // 2 条 × 3 维：[1,2,3 | 4,5,6]
  const flat = new Float32Array([1, 2, 3, 4, 5, 6]);
  expect(sliceFlatVectors(flat, 3)).toEqual([[1, 2, 3], [4, 5, 6]]);
});

test("sliceFlatVectors embedDim 非整除时丢弃尾部不足部分", () => {
  // 7 个元素 / 3 维 = 2 条余 1（尾部 1 丢弃）
  const flat = new Float32Array([1, 2, 3, 4, 5, 6, 99]);
  expect(sliceFlatVectors(flat, 3)).toEqual([[1, 2, 3], [4, 5, 6]]);
});

test("sliceFlatVectors embedDim <= 0 返回空", () => {
  expect(sliceFlatVectors(new Float32Array([1, 2, 3]), 0)).toEqual([]);
});

test("sliceFlatVectors 空输入返回空", () => {
  expect(sliceFlatVectors(new Float32Array([]), 3)).toEqual([]);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test apps/sidecar/src/services/memory-v2/local-embedding.test.ts`
Expected: FAIL —— `chunkTexts`/`sliceFlatVectors` 未导出。

- [ ] **Step 3: 在 local-embedding.ts 新增纯函数 export + 常量**

Modify `apps/sidecar/src/services/memory-v2/local-embedding.ts`：

在文件顶部常量区（`EMBED_TIMEOUT_MS` 下一行）新增：

```ts
const EMBED_BATCH_SIZE = 32;
```

在 `LocalOnnxEmbeddingWorker` 类定义**之前**（`let runtimeStatus` 之前）新增两个 export 纯函数：

```ts
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
```

- [ ] **Step 4: 运行纯函数测试确认通过**

Run: `bun test apps/sidecar/src/services/memory-v2/local-embedding.test.ts`
Expected: PASS（全部 6 个用例）。

- [ ] **Step 5: 改 worker 协议为 embed_batch**

Modify `apps/sidecar/src/services/memory-v2/local-embedding-worker.ts` —— 全文替换为：

```ts
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
      [data.buffer]
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
```

- [ ] **Step 6: 改主线程 embedTexts 为分批 postMessage + per-batch pending**

Modify `apps/sidecar/src/services/memory-v2/local-embedding.ts`：

**6a.** 替换 `WorkerMessage` 类型（原 17-21 行）为：

```ts
type WorkerMessage =
  | { type: "ready" }
  | { type: "init_error"; error?: string }
  | { type: "result_batch"; id: number; data: Float32Array; dims: number }
  | { type: "error_batch"; id: number; error?: string };
```

**6b.** 替换 `PendingRequest` 接口（原 23-27 行）为：

```ts
interface PendingRequest {
  resolve: (vectors: number[][]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
```

**6c.** 在 `LocalOnnxEmbeddingWorker` 类内做两处替换（**`ensureReady` 原 48-98 行保持不变**）：先把 `embedTexts`（原 39-46 行）替换为下方新的 `embedTexts`；再把 `embedOne`（原 100-115 行）整段替换为下方新的 `embedBatch`：

```ts
  async embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    await this.ensureReady();
    const batches = chunkTexts(texts, EMBED_BATCH_SIZE);
    const results = await Promise.all(batches.map((batch) => this.embedBatch(batch)));
    return results.flat();
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
        reject(new Error("Local ONNX embedding request timed out."));
      }, EMBED_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ type: "embed_batch", id, texts });
    });
  }
```

**6d.** 替换 `resolvePending` 方法（原 117-132 行）为：

```ts
  private resolvePending(message: WorkerMessage): void {
    if (message.type !== "result_batch" && message.type !== "error_batch") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.type === "error_batch") {
      pending.reject(new Error(message.error ?? "Local ONNX embedding request failed."));
      return;
    }
    if (!(message.data instanceof Float32Array) || message.data.length === 0 || message.dims <= 0) {
      pending.reject(new Error("Local ONNX embedding response shape is invalid."));
      return;
    }
    const vectors = sliceFlatVectors(message.data, message.dims);
    if (vectors.length === 0 || vectors.some((vector) => vector.length === 0)) {
      pending.reject(new Error("Local ONNX embedding response shape is invalid."));
      return;
    }
    pending.resolve(vectors);
  }
```

> `ensureReady`（含 worker 初始化、`on("message")`/`on("error")`/`on("exit")` 处理、`rejectAll`、`dispose`、`hasLocalOnnxModelCache`、`containsModelFile`、`setLocalOnnxStatus`、`buildLocalOnnxStatus`、`createLocalOnnxMemoryEmbeddingProvider`、`getLocalOnnxMemoryEmbeddingStatus` 等导出函数）**保持不变**。`on("message")` 内对 `ready`/`init_error` 的分支不变，`result_batch`/`error_batch` 走 `resolvePending`（与原 `result`/`error` 一致的转发路径）。

- [ ] **Step 7: typecheck**

Run: `bun run --filter @lume/sidecar typecheck`
Expected: 无新增错误（`WorkerMessage` 联合类型已覆盖 `result_batch`/`error_batch`）。

- [ ] **Step 8: 跑现有 embedding test 确认契约不变**

Run: `bun test apps/sidecar/src/services/memory-v2/embedding.test.ts`
Expected: PASS（与 Task 0 基线一致——`createMemoryV2EmbeddingProviderFromAttempts` 的 fallback 契约未变，接口仍是 `(texts) => Promise<number[][]>`）。

- [ ] **Step 9: Commit**

```bash
git add apps/sidecar/src/services/memory-v2/local-embedding-worker.ts apps/sidecar/src/services/memory-v2/local-embedding.ts apps/sidecar/src/services/memory-v2/local-embedding.test.ts
git commit -m "⚡️ perf(memory-v2): 本地 ONNX embedding 批量化（embed_batch 一次 forward + transfer list，N 次 IPC→1 次）"
```

---

## Task 3：semantic-index 改 dotProduct + 新建单测

**Files:**
- Modify: `apps/sidecar/src/services/memory-v2/semantic-index.ts`
- Test: `apps/sidecar/src/services/memory-v2/semantic-index.test.ts`

- [ ] **Step 1: 写 searchSemanticRecall 逻辑失败测试**

先读 `apps/sidecar/src/services/memory-v2/types.ts:125` 确认 `MemoryV2RecallItem` 必填字段（id/kind/scope/status/statement/path/citation/reason/score），以及 `MemoryV2Kind` 的合法字面量值（如 `"fact"`/`"decision"`/`"preference"`），按实际调整下方 `makeCandidate` 的 `kind` 值。

Create `apps/sidecar/src/services/memory-v2/semantic-index.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { searchSemanticRecall } from "./semantic-index";
import type { MemoryV2EmbedTexts } from "./embedding";
import type { MemoryV2RecallItem } from "./types";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lume-semantic-index-"));
  process.env.LUME_CONFIG_DIR = root;
});

afterEach(() => {
  delete process.env.LUME_CONFIG_DIR;
  rmSync(root, { recursive: true, force: true });
});

function makeCandidate(id: string, statement: string, path: string): MemoryV2RecallItem {
  return {
    id,
    kind: "fact",
    scope: "global",
    status: "active",
    statement,
    path,
    citation: "",
    reason: "test candidate",
    score: 0
  };
}

function touchFile(name: string): string {
  const path = join(root, name);
  writeFileSync(path, "");
  return path;
}

test("query 与某 candidate 向量相同 → score=1 排首位，正交 candidate 被滤", async () => {
  const candidates = [
    makeCandidate("a", "architecture", touchFile("a.md")),
    makeCandidate("b", "preferences", touchFile("b.md"))
  ];
  const embedTexts: MemoryV2EmbedTexts = async (texts) =>
    texts.map((t) => (t === "preferences" ? [0, 1, 0] : [1, 0, 0]));
  const results = await searchSemanticRecall({
    query: "architecture",
    candidates,
    embedTexts,
    modelKey: "test-model",
    maxResults: 5
  });
  expect(results.map((item) => item.id)).toEqual(["a"]);
});

test("score <= 0.25 的 candidate 被滤除", async () => {
  const candidates = [makeCandidate("c", "unrelated", touchFile("c.md"))];
  // query 向量 [1,0,0]，candidate 向量 [0,1,0] → dot=0 <= 0.25
  const embedTexts: MemoryV2EmbedTexts = async (texts) =>
    texts.map((t) => (t === "unrelated" ? [0, 1, 0] : [1, 0, 0]));
  const results = await searchSemanticRecall({
    query: "q",
    candidates,
    embedTexts,
    modelKey: "test-model",
    maxResults: 5
  });
  expect(results).toEqual([]);
});

test("相同 candidates 命中缓存 → 建索引不再 embedTexts（第二次仅 embed query）", async () => {
  const candidates = [makeCandidate("a", "architecture", touchFile("a.md"))];
  let embeddedCount = 0;
  const embedTexts: MemoryV2EmbedTexts = async (texts) => {
    embeddedCount += texts.length;
    return texts.map(() => [1, 0, 0]);
  };
  await searchSemanticRecall({ query: "q", candidates, embedTexts, modelKey: "m", maxResults: 5 });
  const firstTotal = embeddedCount;
  await searchSemanticRecall({ query: "q", candidates, embedTexts, modelKey: "m", maxResults: 5 });
  // 第二次：索引缓存命中，仅 embed query（1 条）。
  expect(embeddedCount - firstTotal).toBe(1);
});

test("modelKey 变化 → 索引重建（重新 embed candidates）", async () => {
  const candidates = [makeCandidate("a", "architecture", touchFile("a.md"))];
  let embeddedCount = 0;
  const embedTexts: MemoryV2EmbedTexts = async (texts) => {
    embeddedCount += texts.length;
    return texts.map(() => [1, 0, 0]);
  };
  await searchSemanticRecall({ query: "q", candidates, embedTexts, modelKey: "m1", maxResults: 5 });
  const firstTotal = embeddedCount;
  await searchSemanticRecall({ query: "q", candidates, embedTexts, modelKey: "m2", maxResults: 5 });
  // modelKey 变 → 重建（embed 1 candidate）+ embed query（1 条）= 2。
  expect(embeddedCount - firstTotal).toBe(2);
});

test("空 candidates → 返回 []（不 embed query）", async () => {
  let embedded = false;
  const embedTexts: MemoryV2EmbedTexts = async () => {
    embedded = true;
    return [[1, 0, 0]];
  };
  const results = await searchSemanticRecall({
    query: "q",
    candidates: [],
    embedTexts,
    modelKey: "m",
    maxResults: 5
  });
  expect(results).toEqual([]);
  expect(embedded).toBe(false);
});
```

- [ ] **Step 2: 运行确认基线行为（改造前应部分通过、部分失败）**

Run: `bun test apps/sidecar/src/services/memory-v2/semantic-index.test.ts`
Expected: 排序/过滤/空 candidates 用例 PASS（旧 `cosineSimilarity` 对归一化向量等价）；缓存/modelKey 用例 PASS（`loadOrBuildIndex` 现有逻辑）。**全部应 PASS**——这批测试锁定的是「行为契约」，改造后必须仍 PASS（零回归证据）。若有 FAIL，先确认 `makeCandidate` 的 `kind` 字面量是否合法（见 Step 1）。

- [ ] **Step 3: semantic-index 改用 dotProduct**

Modify `apps/sidecar/src/services/memory-v2/semantic-index.ts`：

**3a.** 在顶部 import 区（`import type { MemoryV2RecallItem } from "./types";` 下一行）新增：

```ts
import { dotProduct, toFloat32Array } from "./vector-math";
```

**3b.** 替换 `searchSemanticRecall` 内的评分段（原 44-58 行）。把：

```ts
  const [queryEmbedding] = await input.embedTexts([input.query]);
  if (!queryEmbedding) return [];
  return index.docs
    .map((doc) => ({
      item: doc.item,
      score: cosineSimilarity(queryEmbedding, doc.embedding)
    }))
    .filter(({ score }) => score > 0.25)
    .sort((a, b) => b.score - a.score)
    .slice(0, input.maxResults)
    .map(({ item, score }) => ({
      ...item,
      reason: `${item.reason}; semantic match`,
      score: Math.max(item.score, 5 + score * 5)
    }));
```

替换为：

```ts
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
```

> 注意：原 `if (!queryEmbedding) return [];` 加严为 `!queryEmbedding || queryEmbedding.length === 0`（空向量也短路），与 `findSemanticDuplicate` 的空向量守卫一致。

**3c.** 删除本地 `cosineSimilarity` 函数（原 156-171 行整段删除）。

- [ ] **Step 4: 运行确认改造后仍 PASS（零回归）**

Run: `bun test apps/sidecar/src/services/memory-v2/semantic-index.test.ts`
Expected: PASS（全部 5 个用例，与 Step 2 基线一致——证明 `dotProduct ≡ cosineSimilarity`）。

- [ ] **Step 5: typecheck**

Run: `bun run --filter @lume/sidecar typecheck`
Expected: 无新增错误（`cosineSimilarity` 已无引用）。

- [ ] **Step 6: Commit**

```bash
git add apps/sidecar/src/services/memory-v2/semantic-index.ts apps/sidecar/src/services/memory-v2/semantic-index.test.ts
git commit -m "⚡️ perf(memory-v2): semantic-index 召回改 dotProduct（Float32Array，归一化向量省两次范数）+ 新增单测"
```

---

## Task 4：smart-add 改 dotProduct

**Files:**
- Modify: `apps/sidecar/src/services/memory-v2/smart-add.ts`

- [ ] **Step 1: 确认 smart-add 现有 test 基线**

Run: `bun test apps/sidecar/src/services/memory-v2/smart-add.test.ts`
Expected: PASS（记下用例数）。改造后必须一致——`findSemanticDuplicate` 的 `0.92` 阈值数值不变（`dotProduct ≡ cosineSimilarity`）。

- [ ] **Step 2: smart-add 改用 dotProduct**

Modify `apps/sidecar/src/services/memory-v2/smart-add.ts`：

**2a.** 在顶部 import 区新增（与现有 `import { createMemoryV2EmbeddingProvider, type MemoryV2EmbedTexts } from "./embedding";` 同区）：

```ts
import { dotProduct, toFloat32Array } from "./vector-math";
```

**2b.** 替换 `findSemanticDuplicate` 内的评分循环（原 225-234 行）。把：

```ts
    const candidateVector = vectors[0];
    if (!candidateVector || candidateVector.length === 0) return undefined;
    let best: { entry: MemoryV2Entry; score: number } | undefined;
    for (let index = 0; index < comparable.length; index += 1) {
      const entryVector = vectors[index + 1];
      if (!entryVector || entryVector.length === 0) continue;
      const score = cosineSimilarity(candidateVector, entryVector);
      if (!best || score > best.score) best = { entry: comparable[index]!, score };
    }
    return best && best.score >= 0.92 ? best.entry : undefined;
```

替换为：

```ts
    const candidateVector = vectors[0];
    if (!candidateVector || candidateVector.length === 0) return undefined;
    const candidateVec = toFloat32Array(candidateVector);
    let best: { entry: MemoryV2Entry; score: number } | undefined;
    for (let index = 0; index < comparable.length; index += 1) {
      const entryVector = vectors[index + 1];
      if (!entryVector || entryVector.length === 0) continue;
      const score = dotProduct(candidateVec, toFloat32Array(entryVector));
      if (!best || score > best.score) best = { entry: comparable[index]!, score };
    }
    return best && best.score >= 0.92 ? best.entry : undefined;
```

**2c.** 删除本地 `cosineSimilarity` 函数（原 309-324 行整段删除）。

- [ ] **Step 3: 跑 smart-add test 确认零回归**

Run: `bun test apps/sidecar/src/services/memory-v2/smart-add.test.ts`
Expected: PASS（与 Step 1 基线一致）。

- [ ] **Step 4: typecheck**

Run: `bun run --filter @lume/sidecar typecheck`
Expected: 无新增错误（`cosineSimilarity` 已无引用）。

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/memory-v2/smart-add.ts
git commit -m "⚡️ perf(memory-v2): smart-add 复用 vector-math dotProduct，删除重复 cosineSimilarity"
```

---

## Task 5：全量回归 + batch 等价性集成测试（可选）

**Files:**
- Create（可选）: `apps/sidecar/src/services/memory-v2/embedding-batch-equiv.test.ts`

- [ ] **Step 1: 跑 memory-v2 全部 test，对比基线**

Run: `bun test apps/sidecar/src/services/memory-v2/`
Expected: 相比 Task 0 基线，仅新增 `vector-math.test.ts`(7) + `local-embedding.test.ts`(6) + `semantic-index.test.ts`(5) 的 PASS 用例；**无新增 fail**。原有 `embedding.test.ts`/`smart-add.test.ts`/`retrieval.test.ts` 用例数与结果与基线一致（零回归）。

- [ ] **Step 2（可选）: 写 batch 等价性集成测试（需真实模型，默认 skip）**

Create `apps/sidecar/src/services/memory-v2/embedding-batch-equiv.test.ts`:

```ts
import { expect, test, describe } from "bun:test";
import { createLocalOnnxMemoryEmbeddingProvider } from "./local-embedding";

// 需要本地已缓存 Xenova/bge-small-zh-v1.5 模型。默认 skip，手动验证时设置：
//   LUME_EMBEDDING_EQUIV_TEST=1 bun test apps/sidecar/src/services/memory-v2/embedding-batch-equiv.test.ts
describe.skipIf(!process.env.LUME_EMBEDDING_EQUIV_TEST)("batch embedding 等价性（需模型）", () => {
  test("一次 batch N 条 ≡ N 次单条 batch 的向量（容差 1e-4）", async () => {
    const embed = createLocalOnnxMemoryEmbeddingProvider();
    const texts = ["用户偏好深色模式", "项目用 TypeScript", "向量检索测试", "周末搬家到上海"];
    const batched = await embed(texts);
    expect(batched.length).toBe(texts.length);
    for (let i = 0; i < texts.length; i += 1) {
      const oneByOne = await embed([texts[i]!]);
      const a = batched[i]!;
      const b = oneByOne[0]!;
      expect(a.length).toBe(b.length);
      for (let d = 0; d < a.length; d += 1) {
        expect(a[d]).toBeCloseTo(b[d]!, 4);
      }
    }
  });
});
```

- [ ] **Step 3（可选，需模型）: 手动跑等价性测试**

Run: `LUME_EMBEDDING_EQUIV_TEST=1 bun test apps/sidecar/src/services/memory-v2/embedding-batch-equiv.test.ts`
Expected: PASS（验证 transformers.js batch forward 与逐条结果一致）。若本地无模型缓存，跳过此步（Step 2 的文件已 skip，不影响 CI）。

- [ ] **Step 4（可选）: Commit 等价性测试**

```bash
git add apps/sidecar/src/services/memory-v2/embedding-batch-equiv.test.ts
git commit -m "test(memory-v2): batch embedding 等价性集成测试（需模型，默认 skip）"
```

- [ ] **Step 5: 全量 typecheck 收尾**

Run: `bun run --filter @lume/sidecar typecheck`
Expected: 无错误。

---

## 验收标准对照

- [x] **100 条 embedding < 1s**：Task 2 后，N 条文本 = ⌈N/32⌉ 次 IPC + ⌈N/32⌉ 次 forward（原为 N 次）。100 条 → 4 批。手动验证可写 bench 脚本（参考 `markdown-store.bench.ts` 模式），非本 plan 强制项。
- [x] **召回 dotProduct 省两次范数**：Task 3 将 `cosineSimilarity`（3 累加）改 `dotProduct`（1 累加）+ TypedArray 索引。
- [x] **cosineSimilarity 重复消除**：Task 1 建 `vector-math.ts`，Task 3/4 删 `semantic-index`/`smart-add` 各一份。
- [x] **零行为回归**：Task 3/4 的现有 test 基线不变；Task 5 全量对比 Task 0 基线无新增 fail；阈值 `0.92`/`0.25` 数值不变（`dotProduct ≡ cosineSimilarity`，由 `vector-math.test` 守护）。
- [x] **零迁移**：`vector-index.json` 仍存 `embedding: number[]`，`INDEX_VERSION` 不升。

## 风险与缓解（执行时参照）

- **transformers.js batch 返回字段**：`result.dims` 取最后一维作 `embedDim`、`result.data` 统一 `Float32Array`（已处理非 F32 情形）。由 Task 5 Step 2 的等价性集成测试（需模型）守护；纯逻辑由 `sliceFlatVectors` 单测守护。
- **`on("message")` 转发路径**：`ensureReady` 内 `this.resolvePending(message)` 调用不变，`resolvePending` 已识别 `result_batch`/`error_batch`。
- **删除旧 `embed` 协议**：grep 确认 `{type:"embed"}` 仅 `local-embedding.ts` 内部使用；无磁盘/外部依赖。
