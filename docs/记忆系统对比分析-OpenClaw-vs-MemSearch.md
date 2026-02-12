# 记忆系统对比分析：OpenClaw vs MemSearch

> 为 Lume Agent 记忆系统设计提供技术参考
> 生成时间：2026-02-12

---

## 📊 快速对比表

| 特性维度 | OpenClaw | MemSearch | 推荐方案 |
|---------|----------|----------|----------|
| **存储架构** | SQLite + FTS5 + sqlite-vec | Milvus (Lite/Server/Cloud) | 取决于规模需求 |
| **数据源** | Markdown 文件（唯一真实来源） | Markdown 文件（唯一真实来源） | **保持 Markdown-First** |
| **向量搜索** | sqlite-vec 或 JS 降级 | Milvus 混合搜索 (RRF) | SQLite 更轻量，Milvus 更强大 |
| **全文搜索** | FTS5 BM25 | BM25 稀疏向量 | **两者都必需** |
| **分块策略** | Token 估算 + 固定重叠 | 字符数限制 + 可配置重叠 | 支持动态重叠更好 |
| **嵌入缓存** | SQLite 表缓存 | 无显式缓存 | OpenClaw 的去重更完善 |
| **批处理** | OpenAI/Gemini Batch API | OpenAI/Gemini Batch API | 两者相同 |
| **文件监控** | Chokidar (debounce 1500ms) | Watchdog (debounce 1500ms) | 两者相同 |
| **会话索引** | 原生支持（JSONL） | 支持（可选） | **建议启用会话索引** |
| **压缩机制** | 预压缩刷新 (Pre-Flush) | LLM 驱动压缩 | 两者配合使用 |
| **降级策略** | 4 层降级链 | 无显式降级 | OpenClaw 更完善 |

---

## 🏗️ 架构设计对比

### OpenClaw 架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                    OpenClaw 记忆系统架构                       │
└─────────────────────────────────────────────────────────────────────┘

┌──────────────┐                    ┌──────────────┐
│  Markdown 文件 │◄────────►│ SQLite 索引  │◄────►│  Memory Search Tool
│  (唯一真实来源)  │              │              │         │
│                  │              │              │         │
│ MEMORY.md      │              │  chunks_vec   │         │
│ memory/*.md    │              │  (向量表)     │         │
│                │              │  chunks_fts  │         │
│                │              │  (全文表)     │         │
│                │              └──────────────┘         │
│                │                                  │
│                │                    ┌───────────────────┐
│                │                    │  Hybrid Search    │
│                │◄───────────────────│ (向量+BM25合并)  │
│                │                    └───────────────────┘
│                │                                  │
└──────────────────────────────────────────────────────────┘

关键特性：
- 文件监控: Chokidar 监听变化 → 自动触发索引
- 预压缩刷新: 上下文接近限制时自动保存记忆
- 优雅降级: sqlite-vec 不可用时 JS 层计算
```

### MemSearch 架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                   MemSearch 记忆系统架构                        │
└─────────────────────────────────────────────────────────────────────┘

┌──────────────┐                    ┌──────────────┐
│  Markdown 文件 │◄────────►│ Milvus 向量库 │◄────►│  Search & Compact API
│  (唯一真实来源)  │              │              │         │
│                  │              │              │         │
│ MEMORY.md      │              │  chunks (存储) │         │
│ memory/*.md    │              │  + vec0 索引  │         │
│                │              │  (向量表)     │         │
│                │              │              │         │
│                │              └──────────────┘         │
│                │                                  │
│                │                    ┌───────────────────┐
│                │                    │  Hybrid Search    │
│                │◄───────────────────│ (RRF 重排序)    │
│                │                    └───────────────────┘
│                │                                  │
└──────────────────────────────────────────────────────────┘

关键特性：
- 文件监控: Watchdog 监听变化 → 自动触发索引
- LLM 压缩: 自动将旧 chunks 压缩为摘要写回 Markdown
- 嵌入缓存: 无显式实现，依赖 Milvus 内部缓存
```

---

## 🔍 核心算法对比

### 1. 混合搜索策略

| 方面 | OpenClaw | MemSearch | 分析 |
|------|----------|----------|------|
| **合并方式** | 加权联合 (Union) | RRF (Reciprocal Rank Fusion) | OpenClaw 的方法更简单直接 |
| **向量权重** | 0.7 (默认) | 可配置 | OpenClaw 有固定默认值更好用 |
| **关键词权重** | 0.3 (默认) | 可配置 | 同上 |
| **得分公式** | `0.7*vecScore + 0.3*textScore` | `RRF(d)` | OpenClaw 保持分数幅度更有意义 |
| **候选扩充** | 4x (默认) | 依赖 RRF 算法 | MemSearch 需要 RRF 获取足够候选 |

**代码对比：**

```typescript
// OpenClaw: 简单加权平均
const score = 0.7 * entry.vectorScore + 0.3 * entry.textScore;

// MemSearch: RRF 重排序
results = client.hybrid_search(
    reqs=[dense_req, bm25_req],
    ranker=RRFRanker(k=60),  // k=60 是 RRF 常数
    limit=top_k
)
```

### 2. 分块策略对比

| 特性 | OpenClaw | MemSearch | 推荐 |
|------|----------|----------|------|
| **分块单位** | Token 估算 (~4 chars/token) | 字符数限制 | **建议使用 Token 估算** |
| **默认大小** | 400 tokens (~1600 chars) | 1500 chars | OpenClaw 更适合 LLM 上下文 |
| **重叠策略** | 固定 80 tokens (~320 chars) | 可配置 2 lines | **建议动态重叠** |
| **边界处理** | 超长行按字符截断 | 在段落边界分割 | 两者结合更优 |

**代码对比：**

```typescript
// OpenClaw: 基于 Token 的固定重叠
const maxChars = chunking.tokens * 4;      // 1 token ≈ 4 chars
const overlapChars = chunking.overlap * 4;   // 固定比例

// MemSearch: 基于字符数的配置重叠
const max_chunk_size = 1500
const overlap_lines = 2  // 可按行配置
```

### 3. 嵌入生成对比

| 特性 | OpenClaw | MemSearch | 分析 |
|------|----------|----------|------|
| **本地嵌入** | node-llama-cpp (自动下载) | 无 | **建议支持本地嵌入** |
| **OpenAI** | ✅ 批处理 | ✅ 批处理 | 两者相同 |
| **Gemini** | ✅ 批处理 | ✅ 批处理 | 两者相同 |
| **Voyage** | ✅ 批处理 | ❌ | OpenClaw 支持更多提供商 |
| **降级链** | 4 层 (local → openai → gemini → voyage) | 无 | **OpenClaw 的降级更完善** |

**关键代码：**

```typescript
// OpenClaw: 完整的降级链
if (requestedProvider === "auto") {
  // 1. 尝试本地
  if (canAutoSelectLocal(options)) {
    try {
      return await createProvider("local");
    } catch (err) {
      localError = formatLocalSetupError(err);
    }
  }

  // 2. 降级到 OpenAI
  for (const provider of ["openai", "gemini"] as const) {
    try {
      return await createProvider(provider);
    } catch (err) {
      if (isMissingApiKeyError(err)) {
        continue;  // 尝试下一个
      }
      throw new Error(message, { cause: err });
    }
  }
}

// MemSearch: 无显式降级实现
// 依赖 Milvus 的内部错误处理
```

### 4. Chunk ID 生成对比

| 特性 | OpenClaw | MemSearch | 兼容性 |
|------|----------|----------|------|
| **ID 格式** | `markdown:${source}:${startLine}:${endLine}:${contentHash}:${model}` | 相同格式 | ✅ 完全兼容 |
| **哈希算法** | SHA-256(content).substring(0, 16) | SHA-256(content).substring(0, 16) | ✅ 完全相同 |
| **哈希用途** | 去重检测 | 主键 + 去重 | ✅ 用途相同 |

---

## 📁 数据库 Schema 对比

### OpenClaw Schema

```sql
-- 文件表
CREATE TABLE files (
  path TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'memory',
  hash TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL
);

-- 分块表
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'memory',
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  hash TEXT NOT NULL,
  model TEXT NOT NULL,
  text TEXT NOT NULL,
  embedding TEXT NOT NULL,        -- JSON 序列化
  updated_at INTEGER NOT NULL
);

-- 嵌入缓存表
CREATE TABLE embedding_cache (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  hash TEXT NOT NULL,
  embedding TEXT NOT NULL,
  dims INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, model, provider_key, hash)
);

-- FTS5 全文搜索表
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text,
  id UNINDEXED,
  path UNINDEXED,
  source UNINDEXED,
  model UNINDEXED,
  start_line UNINDEXED,
  end_line UNINDEXED
);

-- 向量加速表 (sqlite-vec)
CREATE VIRTUAL TABLE chunks_vec USING vec0(
  id TEXT PRIMARY KEY,
  embedding FLOAT[dims]
);
```

### MemSearch Schema (Milvus)

```python
# Milvus Collection: memsearch_chunks
schema = {
    "fields": [
        {
            "name": "chunk_hash",
            "type": "VARCHAR",
            "max_length": 64,
            "primary_key": True
        },
        {
            "name": "embedding",
            "type": "FLOAT_VECTOR",
            "dim": 1536  # OpenAI text-embedding-3-small
        },
        {
            "name": "sparse_vector",
            "type": "SPARSE_FLOAT_VECTOR",
            "auto_generated": True  # BM25 函数自动生成
        },
        {
            "name": "content",
            "type": "VARCHAR",
            "max_length": 65535,
            "enable_analyzer": True
        },
        {
            "name": "source",
            "type": "VARCHAR",
            "max_length": 1024
        },
        {
            "name": "heading",
            "type": "VARCHAR",
            "max_length": 1024
        },
        {
            "name": "heading_level",
            "type": "INT64"
        },
        {
            "name": "start_line",
            "type": "INT64"
        },
        {
            "name": "end_line",
            "type": "INT64"
        }
    ],
    "functions": [
        {
            "name": "bm25_fn",
            "type": "BM25",
            "input_fields": ["content"],
            "output_fields": ["sparse_vector"]
        }
    ],
    "indexes": [
        {
            "field_name": "embedding",
            "index_type": "FLAT",
            "metric_type": "COSINE"
        },
        {
            "field_name": "sparse_vector",
            "index_type": "SPARSE_INVERTED_INDEX",
            "metric_type": "BM25"
        }
    ]
}
```

**关键差异：**

| 方面 | OpenClaw | MemSearch | 分析 |
|------|----------|----------|------|
| **向量存储** | SQLite TEXT 字段 (JSON 序列化） | Milvus FLOAT_VECTOR | Milvus 专为向量优化 |
| **稀疏向量** | 无 (依赖 FTS5) | BM25 函数自动生成 | MemSearch 更完整 |
| **全文搜索** | FTS5 虚拟表 | BM25 稀疏向量 | 两者本质相同 |
| **嵌入缓存** | 专用表 + LRU 修剪 | 无显式缓存 | OpenClaw 的缓存更可控 |

---

## 🔄 搜索流程对比

### OpenClaw 搜索流程

```typescript
async search(query: string, opts?: {...}): Promise<MemorySearchResult[]> {
  // 1. 预热会话索引
  void this.warmSession(opts?.sessionKey);

  // 2. 按需同步索引
  if (this.settings.sync.onSearch && (this.dirty || this.sessionsDirty)) {
    void this.sync({ reason: "search" });
  }

  // 3. 构建查询
  const cleaned = query.trim();
  const minScore = opts?.minScore ?? this.settings.query.minScore;
  const maxResults = opts?.maxResults ?? this.settings.query.maxResults;
  const hybrid = this.settings.query.hybrid;

  // 4. 计算候选数量
  const candidates = Math.min(200, maxResults * hybrid.candidateMultiplier);

  // 5. 并行执行两种搜索
  const keywordResults = hybrid.enabled
    ? await this.searchKeyword(cleaned, candidates).catch(() => [])
    : [];

  const queryVec = await this.embedQueryWithTimeout(cleaned);
  const vectorResults = hasVector
    ? await this.searchVector(queryVec, candidates).catch(() => [])
    : [];

  // 6. 合并结果
  if (!hybrid.enabled) {
    return vectorResults.filter(entry => entry.score >= minScore).slice(0, maxResults);
  }

  const merged = this.mergeHybridResults({
    vector: vectorResults,
    keyword: keywordResults,
    vectorWeight: hybrid.vectorWeight,
    textWeight: hybrid.textWeight,
  });

  return merged.filter(entry => entry.score >= minScore).slice(0, maxResults);
}
```

### MemSearch 搜索流程

```python
async def search(self, query: str, *, top_k: int = 10) -> list[dict]:
    # 1. 分词和构建查询
    fts_query = build_fts_query(raw)

    # 2. 生成查询向量
    query_embedding = await embed_query(query)

    # 3. 构建搜索请求
    dense_req = AnnSearchRequest(
        data=[query_embedding],
        anns_field="embedding",
        param={"metric_type": "COSINE"},
        limit=top_k
    )

    bm25_req = AnnSearchRequest(
        data=[fts_query],
        anns_field="sparse_vector",
        param={"metric_type": "BM25"},
        limit=top_k
    )

    # 4. 执行混合搜索 (RRF)
    results = client.hybrid_search(
        reqs=[dense_req, bm25_req],
        ranker=RRFRanker(k=60),
        limit=top_k
    )

    return results
```

**关键差异：**

| 方面 | OpenClaw | MemSearch | 分析 |
|------|----------|----------|------|
| **错误处理** | try-catch + 独立降级 | Milvus 异常 | OpenClaw 更健壮 |
| **超时控制** | 每个查询独立超时 | 统一超时 | OpenClaw 更精细 |
| **结果截断** | 服务端截断 (snippetMaxChars) | 服务端截断 | 两者相同 |

---

## 💡 为 Lume Agent 设计记忆系统的建议

### 1. 推荐架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                   Lume Agent 记忆系统（推荐架构）              │
└─────────────────────────────────────────────────────────────────────┘

┌──────────────────────────┐                    ┌───────────────────┐
│   Markdown 文件       │◄────────►│ 向量数据库        │◄────►│  Memory Service
│  (唯一真实来源)       │              │              │         │
│                      │              │              │         │
│ MEMORY.md             │              │  chunks 表       │         │
│ memory/*.md           │              │ + vec0 虚拟表  │         │
│ memory/compacted/   │              │  (自动压缩)     │         │
│                      │              │              │         │
│                      │              └──────────────┘         │
│                      │                                  │
│                      │                    ┌───────────────────┐
│                      │                    │ Hybrid Search     │
│                      │◄───────────────────│ (向量+BM25+RRF) │
│                      │                    └───────────────────┘
│                      │                                  │
└──────────────────────────────────────────────────────────┘
```

**核心组件：**

1. **Markdown Store** - 文件持久化层
   - `MEMORY.md` - 长期记忆
   - `memory/YYYY-MM-DD.md` - 日期日志
   - `memory/compacted/*.md` - 自动压缩的摘要

2. **Vector Store** - 向量索引层
   - SQLite + sqlite-vec (轻量，足够个人使用)
   - 或 Milvus (需要时可升级)

3. **Hybrid Search** - 混合搜索引擎
   - 向量搜索 (语义相似)
   - BM25 搜索 (关键词精确匹配)
   - RRF/加权合并

4. **Memory Service** - 记忆管理服务
   - 索引构建
   - 增量更新
   - 搜索查询
   - 压缩管理
   - 缓存管理

### 2. 技术选型建议

| 组件 | 推荐方案 | 理由 |
|------|----------|------|------|
| **存储** | SQLite (开发阶段) → Milvus (生产时) | SQLite 更轻量，Milvus 更专业 |
| **向量搜索** | sqlite-vec (本地计算) → Milvus vec0 | Milvus 性能更好 |
| **全文搜索** | SQLite FTS5 → Milvus BM25 | 两者都足够用 |
| **分块算法** | Token 估算 + 固定重叠 → Token 估算 + 可配置重叠 | 动态重叠更灵活 |
| **嵌入生成** | OpenAI API → OpenAI API | 保持相同即可 |
| **文件监控** | Chokidar → Chokidar | 保持相同 |
| **压缩机制** | 预刷新 → LLM 自动压缩 | 两者配合使用更佳 |

### 3. 实现优先级

**阶段 1：MVP (最小可行产品）**
1. ✅ 使用 SQLite + FTS5
2. ✅ 简单的加权联合混合搜索
3. ✅ 基于 Token 的固定分块 (400 tokens, 80 overlap)
4. ✅ 文件监控 (Chokidar)
5. ✅ OpenAI 嵌入 API
6. ❌ 暂不实现会话索引

**阶段 2：功能完善**
1. ✅ 添加 sqlite-vec 加速
2. ✅ 实现嵌入缓存 (SQLite 表)
3. ✅ 支持会话文件索引
4. ✅ 添加预压缩刷新机制
5. ✅ 支持更多嵌入提供商 (Gemini, Voyage)

**阶段 3：性能优化 (可选)**
1. ✅ 迁移到 Milvus (如果需要)
2. ✅ 实现本地嵌入支持
3. ✅ 优化批量索引性能
4. ✅ 实现更智能的压缩策略

### 4. 关键代码片段参考

#### 4.1 Chunk ID 生成 (兼容 OpenClaw/MemSearch)

```typescript
function computeChunkId(
  source: string,
  startLine: number,
  endLine: number,
  contentHash: string,
  model: string
): string {
  const raw = `markdown:${source}:${startLine}:${endLine}:${contentHash}:${model}`;
  return hashlib.sha256(raw).digest().substring(0, 16);
}
```

#### 4.2 混合搜索合并 (推荐 RRF 方式)

```typescript
function mergeHybridResults(params: {
  vector: SearchResult[];
  keyword: SearchResult[];
  vectorWeight: number;
  textWeight: number;
}): SearchResult[] {
  const byId = new Map<string, {
    id: string,
    path: string,
    startLine: number,
    endLine: number,
    source: string,
    snippet: string,
    vectorScore: number,
    textScore: number,
    score: number;
  }>();

  // 添加向量结果
  for (const r of params.vector) {
    byId.set(r.id, { ...r, vectorScore: r.score, textScore: 0 });
  }

  // 添加关键词结果
  for (const r of params.keyword) {
    const existing = byId.get(r.id);
    if (existing) {
      existing.textScore = r.score;
    } else {
      byId.set(r.id, { ...r, vectorScore: 0, textScore: r.score });
    }
  }

  // RRF 合并 (如果使用 Milvus)
  // 如果使用 OpenClaw 方式，用简单的加权平均
  const merged = Array.from(byId.values()).map(entry => ({
    ...entry,
    score: params.vectorWeight * entry.vectorScore + params.textWeight * entry.textScore,
  }));

  return merged.sort((a, b) => b.score - a.score);
}
```

#### 4.3 Markdown 分块算法

```typescript
export function chunkMarkdown(
  content: string,
  chunking: { tokens: number; overlap: number }
): MemoryChunk[] {
  const lines = content.split("\n");
  if (lines.length === 0) return [];

  // Token 估算: 1 token ≈ 4 chars
  const maxChars = Math.max(32, chunking.tokens * 4);
  const overlapChars = Math.max(0, chunking.overlap * 4);

  const chunks: MemoryChunk[] = [];
  let current: Array<{ line: string; lineNo: number }> = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length === 0) return;
    const text = current.map(e => e.line).join("\n");
    chunks.push({
      startLine: current[0].lineNo,
      endLine: current[current.length - 1].lineNo,
      text,
      hash: hashText(text),
    });
  };

  // 保留重叠部分 (从后向前保留 N 字符)
  const carryOverlap = () => {
    if (overlapChars <= 0 || current.length === 0) {
      current = [];
      currentChars = 0;
      return;
    }

    let acc = 0;
    const kept = [];
    for (let i = current.length - 1; i >= 0; i--) {
      const entry = current[i];
      acc += entry.line.length + 1;
      kept.unshift(entry);
      if (acc >= overlapChars) break;
    }
    current = kept;
    currentChars = kept.reduce((sum, e) => sum + e.line.length + 1, 0);
  };

  // 主分块循环
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    // 处理超长行
    const segments: string[] = [];
    if (line.length === 0) {
      segments.push("");
    } else {
      for (let start = 0; start < line.length; start += maxChars) {
        segments.push(line.slice(start, start + maxChars));
      }
    }

    for (const segment of segments) {
      const lineSize = segment.length + 1;

      // 如果当前块会超限，先输出
      if (currentChars + lineSize > maxChars && current.length > 0) {
        flush();
        carryOverlap();
      }

      current.push({ line: segment, lineNo: i + 1 });
      currentChars += lineSize;
    }
  }

  flush();
  return chunks;
}
```

---

## 📋 实现检查清单

### MVP 阶段 (必需)

- [ ] 存储：SQLite 数据库表结构
- [ ] 索引：Markdown 文件扫描
- [ ] 索引：Markdown 分块处理
- [ ] 索引：FTS5 全文搜索表
- [ ] 搜索：混合搜索 (向量 + BM25)
- [ ] 搜索：结果合并和排序
- [ ] 嵌入：OpenAI API 集成
- [ ] 监控：Markdown 文件变化监听
- [ ] 工具：memory_search 工具实现
- [ ] 工具：memory_get 工具实现

### 功能完善阶段 (重要)

- [ ] 加速：sqlite-vec 向量搜索
- [ ] 缓存：嵌入结果缓存表
- [ ] 降级：多提供商降级策略
- [ ] 压缩：记忆压缩功能
- [ ] 会话：JSONL 会话文件索引
- [ ] 批处理：OpenAI Batch API
- [ ] 配置：完整的配置系统

### 性能优化阶段 (可选)

- [ ] 向量存储：Milvus 替代 SQLite (大规模场景)
- [ ] 本地嵌入：node-llama-cpp 本地嵌入
- [ ] 分布式：多租户支持
- [ ] 分片：大规模数据分片

---

## 🎯 设计决策建议

### 1. 存储选择

**推荐：开发阶段使用 SQLite，生产环境可选 Milvus**

**理由：**
- SQLite 零运维，单文件部署，适合个人 Agent
- Milvus 专业向量搜索，性能更好，可水平扩展
- 两者 Markdown-First 设计一致，迁移成本低

### 2. 混合搜索策略

**推荐：使用 RRF 重排序 (如果用 Milvus)**

**理由：**
- RRF 是学术界验证的重排序方法
- Milvus 原生支持 RRF
- OpenClaw 的简单加权方法在候选数少时可能不够准确

**注意：** 如果使用 SQLite + 自定义实现，OpenClaw 的加权方法更简单直接。

### 3. 分块策略

**推荐：基于 Token 估算 + 可配置重叠**

**理由：**
- Token 估算更适合 LLM 上下文
- 可配置重叠适应不同文档风格
- OpenClaw 的固定 80 tokens 重叠可能过大

### 4. 压缩策略

**推荐：预刷新 + LLM 自动压缩**

**理由：**
- 预刷新避免上下文丢失
- LLM 压缩节省存储空间
- 两者配合效果最佳

---

## 📚 参考实现

### 完整源代码

1. **OpenClaw**: https://github.com/openclaw/openclaw/tree/main/src/memory
2. **MemSearch**: https://github.com/zilliztech/memsearch

### 技术文档

1. **OpenClaw Memory 官方文档**: https://docs.openclaw.ai/concepts/memory
2. **PingCAP 技术博客**: https://www.pingcap.com/blog/local-first-rag-using-sqlite-ai-agent-memory-openclaw/
3. **SQLite FTS5 文档**: https://www.sqlite.org/fts5.html
4. **sqlite-vec 项目**: https://github.com/asg017/sqlite-vec
5. **Milvus 文档**: https://milvus.io/docs

### 关键论文

1. **Reciprocal Rank Fusion**: https://plg.lids.cz/wp-content/uploads/2017/12/14/to rank-fusion.pdf
2. **BM25 算法**: https://en.wikipedia.org/wiki/Okapi_BM25

---

**生成时间：** 2026-02-12
**文档版本：** 1.0
**适用项目：** Lume Agent 记忆系统设计
