# Phase 4 设计：本地 embedding 批量化 + 向量化

> 性能优化路线图 Phase 4（核心三项）。路线图总览：`docs/superpowers/plans/2026-06-21-performance-optimization-roadmap.md`。
> 审查反模式 3：本地 ONNX embedding 逐条串行推理 + 全量暴力向量检索。

## 背景与动机

记忆系统（memory-v2）的语义召回依赖本地 ONNX embedding（`Xenova/bge-small-zh-v1.5`）。当前实现存在三个叠加的性能问题：

1. **串行推理 + N 次 IPC**：`local-embedding.ts:42-44` 的 `embedTexts` 对每条文本单独 `postMessage({type:"embed"})` 并 `await` 结果，N 条文本 = N 次 worker 往返 + N 次 ONNX forward。建索引时 candidates 全量传入，实际是「一次性拿到数组、内部拆成串行」。
2. **向量计算冗余**：`semantic-index.ts:156-171` 的 `cosineSimilarity` 每次都算 dot + aNorm + bNorm 三个累加（两次范数），而所有 embedding 经 worker `normalize:true` 已归一化，余弦退化为点积。
3. **重复实现**：`cosineSimilarity` 在 `semantic-index.ts:156` 与 `smart-add.ts:309` 各有一份逐字节相同的实现。

## 目标

- 把 N 条 embedding 从「N 次串行 forward + N 次 IPC」降为「1 次 batched forward + 1 次 IPC（按 chunk 分批）」。
- 向量内存表示与相似度计算改用 `Float32Array` + `dotProduct`，消除归一化向量的冗余范数计算。
- 抽取共享相似度 util，消除两处重复。

## 范围

### 本轮纳入（核心三项）

1. 本地 ONNX batch embedding（worker 协议 `embed_batch` + 主线程分批协调 + transfer list 零拷贝）。
2. 向量 `Float32Array` 化 + `dotProduct`（`semantic-index` 召回路径，省两次范数）。
3. `cosineSimilarity` 抽共享 util（`vector-math.ts`），`semantic-index` 与 `smart-add` 复用，删两份重复。

### 明确排除（留待对应 Phase）

- **二进制 `.bin` 索引**：属 Phase 8（ANN）前置的存储格式质变，本轮磁盘格式不变、零迁移。
- **模型启动预热**（`void ensureReady()` + 可重试超时 + 前端进度事件）：天然属 Phase 9（启动期优化），涉及启动行为 + 前端联动，范围超出 embedding 本身。
- **Google 远程 embedding 并发**（`batchEmbedContents` / `p-limit`）：远程配置路径，本地 ONNX 主路径不涉及，收益边缘。OpenAI 路径本已 batch。

## 架构与数据流

### 写入侧（建索引 `loadOrBuildIndex`）

```
embedTexts(candidates[].statement)
  → LocalOnnxEmbeddingWorker.embedTexts:
      按 chunk=32 分批 → 每批 postMessage({type:"embed_batch", id, texts[]})
  → worker: embedder(texts[], {pooling:"mean", normalize:true}) 一次 forward
      返回 2D Tensor → .data 扁平 Float32Array（rows × dims）
      postMessage({type:"result_batch", id, data, dims}, [data.buffer])  // transfer 零拷贝
  → 主线程: 收齐各批扁平 data → sliceFlatVectors(data, dims) → number[][]
  → semantic-index: 存盘 embedding: number[]（Array.from，格式不变）
```

### 召回侧（`searchSemanticRecall`）

```
加载索引 → doc.embedding(number[]) → toFloat32Array 缓存
  → query: embedTexts([query])[0] → toFloat32Array
  → dotProduct(queryF32, docF32)  // 归一化向量，省两次范数
  → filter(>0.25) → sort desc → slice(maxResults)
```

## 关键设计决策

### 决策 1：`MemoryV2EmbedTexts` 接口保持 `number[][]` 不变

`Float32Array` 仅作为 worker→主线程的**传输表示**（transfer 零拷贝）和 `semantic-index` 的**内存计算表示**（召回前预转）。对外接口 `(texts: string[]) => Promise<number[][]>` 不变，故：

- 调用方（`semantic-index` / `smart-add` / `retrieval`）零改动。
- remote 路径（OpenAI/Google，`embedding.ts`）零改动。
- `embedding.test.ts` 零改动。

**理由**：改 `Float32Array[]` 能多省一次 TypedArray→`number[]` 转换，但 bge-small 512 维、典型几十~几百条向量，该转换 <1ms，不值得为它改接口、牵动 3 个 remote 路径与测试。YAGNI + 最小侵入。

### 决策 2：worker 协议新增 `embed_batch`，删除旧 `embed`

- 新协议：`{ type: "embed_batch", id: number, texts: string[] }` → `{ type: "result_batch", id, data: Float32Array, dims: number }`（transfer `[data.buffer]`）。
- 单条退化为 `texts.length === 1` 的 batch 特例。
- 删除旧 `embed` / `result` / `error` 单条分支。grep 确认 `embed` 仅 `local-embedding.ts` 内部使用，无外部依赖。

**理由**：协议从「N 次往返」简化为「1 次往返」。保留双协议属 YAGNI——batch 已完整覆盖单条。

### 决策 3：`dotProduct` ≡ `cosineSimilarity`（对归一化向量）

当前 `cosineSimilarity` 对任意向量 `dot / (√aNorm · √bNorm)`。改 `dotProduct` 依赖向量归一化。所有 embedding 路径的向量均已归一化：

- 本地 ONNX：worker `normalize:true`。
- OpenAI / Google：embedding API 默认返回归一化向量。

故对归一化向量 `dotProduct ≡ cosineSimilarity`，`smart-add` 的 `0.92` 重复阈值、`semantic-index` 的 `0.25` 过滤阈值**数值零变化**。这是「重构无行为回归」的数学基础，由 TDD 等价性测试守护。

`vector-math.ts` 导出 `dotProduct`（归一化专用，TypedArray 索引，不做范数除法）。不保留通用 `cosineSimilarity`——当前两处调用方都作用于归一化向量，无未归一化场景。

### 决策 4：零迁移（`INDEX_VERSION` 不升）

`vector-index.json` 仍存 `embedding: number[]`（`Float32Array` 序列化前 `Array.from`）。内存表示变了，**磁盘格式没变**，`INDEX_VERSION` 保持 1，旧索引无缝兼容，无需迁移脚本。

## 组件改动清单

| 文件 | 改动 |
|------|------|
| **新建** `apps/sidecar/src/services/memory-v2/vector-math.ts` | 导出 `dotProduct(a: Float32Array, b: Float32Array): number`、`toFloat32Array(values: ArrayLike<number>): Float32Array`。纯函数，无副作用。 |
| `apps/sidecar/src/services/memory-v2/local-embedding-worker.ts` | 协议改 `embed_batch`：`embedder(texts[], opts)` 一次 forward，从 2D Tensor 取扁平 `data`（`Float32Array`）与 `dims`，`postMessage(..., [data.buffer])` transfer。删旧 `embed` 分支。 |
| `apps/sidecar/src/services/memory-v2/local-embedding.ts` | `embedTexts` 按 chunk=32 分批 `postMessage`、`result_batch` 收齐、`sliceFlatVectors` 切片成 `number[][]`；pending 改 per-batch-id；`EMBED_TIMEOUT_MS` 按 batch 计时。删 `embedOne` 与旧 `embed`/`result`/`error` 分支。切片/分批逻辑抽纯函数。 |
| `apps/sidecar/src/services/memory-v2/semantic-index.ts` | 删本地 `cosineSimilarity`（L156-171），import `dotProduct`/`toFloat32Array`；召回前 query 与 doc.embedding 转 `Float32Array`（doc 可预转缓存）；存盘仍 `Array.from` → `number[]`。 |
| `apps/sidecar/src/services/memory-v2/smart-add.ts` | 删本地 `cosineSimilarity`（L309-324），import `dotProduct`/`toFloat32Array`；`findSemanticDuplicate` 内改 `dotProduct(toFloat32Array(candidate), toFloat32Array(entry))`。 |

### 关键实现细节

- **transformers.js batch 返回结构**：`@xenova/transformers@^2.17.2` 的 feature-extraction pipeline 接受 `string | string[]`。传入 `string[]` 时返回 2D Tensor，`.data` 为扁平 `Float32Array`（rows × dims），维度从 `result.dims` / `result.shape` 取（实现时验证具体字段，由 batch 等价性测试守护）。
- **chunk size**：默认 32，防超大 batch 的 tokenize 内存峰值 / 单次 forward 过慢。常量可调。
- **输入截断**：保留 worker 现有 `text.slice(0, 512)` 逐条截断语义（batch 时对每条 text 分别截断后再整体传入）。
- **dims 不硬编码**：bge-small-zh-v1.5 为 512 维，但代码从 result 取，不假设。

## 错误处理

- worker batch forward 失败 → `{ type: "error_batch", id, error }`，主线程 reject 对应 batch 的 promise。
- `embedTexts` 任一 chunk 失败 → 整体 reject（与当前「失败即抛、上层 `embedding.ts` fallback 到下一 attempt」语义一致，不做部分成功）。
- `EMBED_TIMEOUT_MS`（8s）改为按 batch 计时；batch 比 N 次串行快得多，timeout 更宽松，保留超时 reject 机制。
- transfer 后 worker 侧 `Float32Array` 的 `ArrayBuffer` 被 detached：worker 每次新建 TypedArray 返回，无跨请求复用，无问题。

## 测试护栏（TDD）

执行前先跑 `apps/sidecar/src/services/memory-v2/` 全部 test，记录基线（memory 未记录 memory-v2 基线），作为零回归对比锚点。

1. **`vector-math.test.ts`**（新建，纯函数，快）：
   - `dotProduct` 归一化向量 ≡ 旧 `cosineSimilarity` 实现（取旧实现拷贝为 oracle，容差 1e-6）。
   - 正交向量 → 0；单位向量自比 → 1；全零向量 → 0。
   - 维度不匹配 → 取 min length（与旧实现一致）。
2. **`semantic-index.test.ts`**（新建，mock `embedTexts` 注入固定向量，不依赖真实模型）：
   - query 与某 doc 完全相同 → score=1，排首位。
   - `score ≤ 0.25` 被滤除。
   - 相同 candidates + mtime → 命中缓存，不再调 `embedTexts`。
   - `modelKey` 变化 → 重建索引。
   - 空 candidates → 返回 `[]`。
3. **`local-embedding` 纯函数单测**：`chunkTexts(texts, 32)` 分批边界（空、不足一批、刚好、多批）；`sliceFlatVectors(flat, dims)`（count 由 `flat.length / dims` 推导）切片正确性。worker 封装本身（依赖 `Worker` + 模型）不做单测，逻辑全部下沉纯函数。
4. **batch 等价性集成测试**（可选，需模型）：固定文本集，逐条 embed 与 batch embed 的向量逐维一致（容差 1e-5）。标记 `describe.skip` 或环境门控，避免 CI 下载模型。

护栏目标：现有 `embedding.test.ts` / `smart-add.test.ts` / `retrieval.test.ts` 零改动且全绿；memory-v2 基线零回归。

## 验收标准（本轮可达部分）

- **100 条 embedding < 1s**（当前 3–8s，串行 → batch 一次 forward）——本地 ONNX 路径。
- **召回 dotProduct** 比旧 `cosineSimilarity` 省两次范数 + TypedArray 索引，常数项下降。N=1万 向量召回 <50ms 的主体收益留待 Phase 8 ANN，本轮改善常数。
- **零行为回归**：`embedding.test` / `smart-add.test` / `retrieval.test` 零变化；memory-v2 test 基线零回归；`smart-add` 的 `0.92` 与 `semantic-index` 的 `0.25` 阈值数值不变。

## 风险与缓解

- **transformers.js batch 行为差异**（向量化结果与逐条不一致）：用固定文本集的 batch vs 逐条等价性测试（容差 1e-5）守护；标记 skip-on-CI。
- **2D Tensor 字段名不确定**（`.dims` / `.shape`）：实现时验证，由等价性测试 + 切片单测守护。
- **dotProduct 依赖归一化的隐含假设**：`vector-math.test.ts` 显式断言「归一化向量 dotProduct ≡ 旧 cosine」；若将来引入未归一化向量源，该测试会暴露需重新评估。
- **worker 协议删除旧 `embed` 的兼容性**：grep 已确认仅内部使用；无磁盘/跨进程持久化协议，无迁移问题。

## 依赖

无（与 Phase 1/2/3/5 互相独立）。
