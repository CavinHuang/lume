# OpenClaw 记忆系统技术分析

> 基于开源项目 [OpenClaw](https://github.com/openclaw/openclaw) 的记忆系统实现深度解析
> 分析版本: main@9025da2 (2026-01-30)

---

## 一、核心设计理念

### 1.1 文件作为唯一真实来源 (Files as Source of Truth)

OpenClaw 的记忆系统采用了一个革命性的设计原则：**Markdown 文件是规范的、人类可读的数据源**，而 SQLite 索引仅为加速检索而存在。

```
~/.openclaw/
├── workspace/
│   ├── MEMORY.md              # 长期记忆（精选、稳定的事实、偏好）
│   └── memory/
│       ├── 2026-01-15.md      # 按日期的运行日志（仅追加）
│       ├── 2026-01-16.md
│       └── ...
└── memory/
    └── {agentId}.sqlite      # 向量索引（衍生数据，可重建）
```

**关键设计决策：**

| 特性 | 实现方式 | 优势 |
|------|----------|------|
| **可读性** | 纯 Markdown 文本 | 用户可直接检查、编辑记忆 |
| **可移植性** | 单个 `.sqlite` 文件 | 备份和迁移简单 |
| **版本控制** | Git 友好 | 可追踪所有变更历史 |
| **调试友好** | 阅读文本而非查询数据库 | 问题排查直观 |

### 1.2 两层记忆结构

1. **MEMORY.md** - 精选的长期记忆
   - 稳定的事实、偏好、关键决策
   - 仅在主私人会话中加载（不在群组上下文中）

2. **memory/YYYY-MM-DD.md** - 按日期的运行日志
   - 仅追加（append-only）的运行上下文
   - 会话开始时读取今天 + 昨天的日志

---

## 二、SQLite 存储架构

### 2.1 数据库 Schema 设计

索引存储在 `~/.openclaw/memory/{agentId}.sqlite`，包含以下核心表：

| 表名 | 用途 | 关键字段 |
|------|------|----------|
| `files` | 文件跟踪 | `path`, `mtime`, `size`, `content_hash` |
| `chunks` | 文本分块存储 | `text`, `start_line`, `end_line`, `embedding`, `model` |
| `chunks_vec` (虚拟表) | 向量加速 | `id`, `embedding` (binary float vectors) |
| `chunks_fts` (虚拟表) | 全文搜索 | FTS5 BM25 索引 |
| `embedding_cache` | 嵌入缓存 | `hash`, `embedding` (SHA-256 去重) |

### 2.2 核心 SQL 查询

**向量搜索（使用 sqlite-vec 扩展）：**

```sql
SELECT c.id, c.path, c.start_line, c.end_line, c.text,
       vec_distance_cosine(v.embedding, ?) AS dist
FROM chunks_vec v
JOIN chunks c ON c.id = v.id
WHERE c.model = ?
ORDER BY dist ASC
LIMIT ?
```

**全文搜索（FTS5 + BM25）：**

```sql
SELECT *, bm25(chunks_fts) as rank
FROM chunks_fts
WHERE chunks_fts MATCH 'OpenClaw AND Memory'
ORDER BY rank
```

### 2.3 优雅降级机制

```javascript
// src/memory/internal.ts (简化版)
async function searchMemory(queryVector, limit = 5) {
  try {
    // 快速路径：原生向量搜索
    return await db.all(`
      SELECT c.text, vec_distance_cosine(v.embedding, ?) AS dist
      FROM chunks_vec v
      JOIN chunks c ON c.id = v.id
      ORDER BY dist ASC LIMIT ?`,
      [queryVector, limit]
    );
  } catch (err) {
    console.warn("sqlite-vec not found. Falling back to JS-based search.");

    // 安全路径：JavaScript 暴力计算
    const allChunks = await db.all("SELECT id, text, embedding FROM chunks");

    return allChunks
      .map(chunk => ({
        ...chunk,
        dist: cosineSimilarity(queryVector, JSON.parse(chunk.embedding))
      }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, limit);
  }
}
```

**降级路径：**
1. `sqlite-vec` 可用 → 数据库内向量搜索（最快）
2. 扩展缺失 → JS 层余弦相似度计算（较慢但功能完整）
3. 两者都失败 → 仍然可读 Markdown 文件

---

## 三、混合搜索算法

### 3.1 加权联合策略（Union, Not Intersection）

OpenClaw 采用 **联合而非交集** 的合并策略：

```javascript
// src/memory/hybrid.ts
export function mergeHybridResults(params: {
  vector: HybridVectorResult[];
  keyword: HybridKeywordResult[];
  vectorWeight: number;    // 默认 0.7
  textWeight: number;       // 默认 0.3
}): Array<{...}> {
  const byId = new Map<string, {...}>();

  // 添加所有向量结果
  for (const r of params.vector) {
    byId.set(r.id, {
      ...r,
      vectorScore: r.vectorScore,
      textScore: 0,
    });
  }

  // 合并关键词结果（联合，不是交集）
  for (const r of params.keyword) {
    const existing = byId.get(r.id);
    if (existing) {
      existing.textScore = r.textScore;
    } else {
      byId.set(r.id, { ...r, vectorScore: 0, textScore: r.textScore });
    }
  }

  // 加权组合
  const merged = Array.from(byId.values()).map((entry) => {
    const score = params.vectorWeight * entry.vectorScore
                + params.textWeight * entry.textScore;
    return { ...entry, score };
  });

  return merged.toSorted((a, b) => b.score - a.score);
}
```

**为什么用联合而不是交集？**

| 查询类型 | 向量搜索 | 关键词搜索 | 联合策略 | 交集策略 |
|----------|----------|------------|----------|----------|
| "commit ab3f2c1" | 弱（匹配描述） | 强（精确匹配） | ✅ 成功 | ❌ 失败 |
| "架构决策" | 强（语义理解） | 弱（需精确词） | ✅ 成功 | ❌ 失败 |
| "两者都匹配" | 强 | 强 | ✅ 成功 | ✅ 成功 |

### 3.2 BM25 排名归一化

```javascript
export function bm25RankToScore(rank: number): number {
  const normalized = Number.isFinite(rank) ? Math.max(0, rank) : 999;
  return 1 / (1 + normalized);
  // Rank 0 → 1.0, Rank 1 → 0.5, Rank 9 → 0.1
}
```

公式 `1 / (1 + rank)` 创造平滑衰减—顶部结果占主导，但较低排名仍有贡献。

### 3.3 关键词查询构建

```javascript
export function buildFtsQuery(raw: string): string | null {
  const tokens = raw.match(/[A-Za-z0-9_]+/g)
    ?.map((t) => t.trim()).filter(Boolean) ?? [];

  if (tokens.length === 0) return null;

  const quoted = tokens.map((t) => `"${t.replaceAll('"', '')}"`);
  return quoted.join(" AND ");  // 所有 token 必须匹配
}
```

**示例：** `"commit hash"` → `"commit" AND "hash"`

### 3.4 搜索编排

```javascript
// src/memory/manager.ts
async search(query: string, opts?: {...}): Promise<MemorySearchResult[]> {
  const candidates = Math.min(200, maxResults * hybrid.candidateMultiplier);

  // 1. 关键词搜索
  const keywordResults = hybrid.enabled
    ? await this.searchKeyword(cleaned, candidates).catch(() => [])
    : [];

  // 2. 向量搜索
  const queryVec = await this.embedQueryWithTimeout(cleaned);
  const vectorResults = hasVector
    ? await this.searchVector(queryVec, candidates).catch(() => [])
    : [];

  // 3. 合并结果
  const merged = this.mergeHybridResults({
    vector: vectorResults,
    keyword: keywordResults,
    vectorWeight: hybrid.vectorWeight,   // 0.7
    textWeight: hybrid.textWeight,       // 0.3
  });

  return merged.filter((entry) => entry.score >= minScore).slice(0, maxResults);
}
```

**candidateMultiplier: 4** — 如果请求 6 个结果，系统从每个搜索获取 24 个候选后再合并。

### 3.5 默认配置

```javascript
hybrid: {
  vectorWeight: 0.7,      // 语义相似度权重
  textWeight: 0.3,         // 关键词匹配权重
  candidateMultiplier: 4       // 候选扩充倍数
}
```

---

## 四、Markdown 分块算法

### 4.1 分块策略

```javascript
// src/memory/internal.ts (简化版)
export function chunkMarkdown(
  content: string,
  chunking: { tokens: number; overlap: number }
): MemoryChunk[] {
  const lines = content.split("\n");
  const maxChars = Math.max(32, chunking.tokens * 4);   // ~4 字符/Token
  const overlapChars = Math.max(0, chunking.overlap * 4);

  // ... 分块逻辑 ...

  const carryOverlap = () => {
    // 保留最后 N 字符的行用于重叠
    let acc = 0;
    const kept = [];
    for (let i = current.length - 1; i >= 0; i--) {
      acc += entry.line.length + 1;
      kept.unshift(entry);
      if (acc >= overlapChars) break;
    }
    current = kept;
  };
}
```

### 4.2 默认分块参数

| 参数 | 值 | 说明 |
|------|-----|------|
| `tokens` | 400 | 每块目标 Token 数 (~1600 字符) |
| `overlap` | 80 | 重叠 Token 数 (~320 字符) |

**重叠的好处：** 跨越边界的句子会出现在两个块中，提高检索命中率。

### 4.3 Chunk ID 格式

```javascript
function computeChunkId(
  source: string,
  start_line: number,
  end_line: number,
  content_hash: string,
  model: string
): string {
  const raw = `markdown:${source}:${start_line}:${end_line}:${content_hash}:${model}`;
  return hashlib.sha256(raw).hexdigest().substring(0, 16);
}
```

**ID 组成部分：**
- `markdown:` - 前缀标识文档类型
- `source` - 文件路径
- `start_line:end_line` - 行号范围
- `content_hash` - SHA-256 内容哈希（前16字符）
- `model` - 嵌入模型名称

---

## 五、预压缩刷新机制 (Pre-Compaction Flush)

### 5.1 问题背景

当会话超出上下文限制时，压缩会丢弃信息，可能导致宝贵的上下文丢失。

### 5.2 解决方案

在达到软阈值前，触发一个**静默的智能轮次**，提示模型保存持久记忆。

```javascript
// src/auto-reply/reply/memory-flush.ts
export const DEFAULT_MEMORY_FLUSH_PROMPT = [
  "Pre-compaction memory flush.",
  "Store durable memories now (use memory/YYYY-MM-DD.md; create memory/ if needed).",
  `If nothing to store, reply with ${SILENT_REPLY_TOKEN}.`,
].join(" ");
```

### 5.3 触发条件

```javascript
export function shouldRunMemoryFlush(params: {
  entry?: Pick<SessionEntry, "totalTokens" | "compactionCount" | "memoryFlushCompactionCount">;
  contextWindowTokens: number;
  reserveTokensFloor: number;      // 默认 20,000
  softThresholdTokens: number;      // 默认 4,000
}): boolean {
  const totalTokens = params.entry?.totalTokens;
  if (!totalTokens || totalTokens <= 0) return false;

  // 计算阈值: contextWindow - reserve - softThreshold
  const threshold = Math.max(0,
    params.contextWindowTokens
    - params.reserveTokensFloor
    - params.softThresholdTokens
  );

  if (totalTokens < threshold) return false;

  // 每个压缩周期只刷新一次
  const compactionCount = params.entry?.compactionCount ?? 0;
  const lastFlushAt = params.entry?.memoryFlushCompactionCount;
  if (typeof lastFlushAt === "number" && lastFlushAt === compactionCount) {
    return false;  // 本周期已刷新
  }

  return true;
}
```

**计算示例：**
- 上下文窗口：200K Tokens
- 保留阈值：20K Tokens
- 软阈值：4K Tokens
- **触发点：** ~176K Tokens

刷新通常以 `NO_REPLY` 响应，保持交互无缝。

---

## 六、嵌入提供商 (Embedding Providers)

### 6.1 本地优先降级链

```javascript
// src/memory/embeddings.ts
if (requestedProvider === "auto") {
  // 1. 尝试本地（如果已配置且模型文件存在）
  if (canAutoSelectLocal(options)) {
    try {
      const local = await createProvider("local");
      return { ...local, requestedProvider };
    } catch (err) {
      localError = formatLocalSetupError(err);
    }
  }

  // 2. 降级到远程提供商
  for (const provider of ["openai", "gemini"] as const) {
    try {
      const result = await createProvider(provider);
      return { ...result, requestedProvider };
    } catch (err) {
      if (isMissingApiKeyError(err)) {
        missingKeyErrors.push(message);
        continue;  // 尝试下一个提供商
      }
      throw new Error(message, { cause: err });
    }
  }
}
```

**优先级顺序：**

| 优先级 | 提供商 | 模型 | 特点 |
|-------|---------|------|------|
| 1 | **Local** | embeddinggemma-300M | 离线、隐私 |
| 2 | **OpenAI** | text-embedding-3-small | 快速、批量折扣 |
| 3 | **Gemini** | gemini-embedding-001 | 原生支持 |
| 4 | **Voyage** | voyage-3-lite | 备选方案 |
| Fallback | BM25-only | - | 纯关键词搜索 |

### 6.2 本地嵌入自动下载

- 默认模型：`hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf` (~0.6 GB)
- 当 `memorySearch.provider = "local"` 时，`node-llama-cpp` 自动下载到缓存
- 原生构建要求：`pnpm approve-builds` → 选择 `node-llama-cpp` → `pnpm rebuild`

### 6.3 批量索引 (Batch Indexing)

```javascript
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      remote: {
        batch: {
          enabled: true,
          concurrency: 2  // 并发批量作业
        }
      }
    }
  }
}
```

**OpenAI 批量 API 的优势：**
- 大型索引操作速度更快
- 定价降低 50%
- 异步处理

---

## 七、记忆工具 API

### 7.1 memory_search 工具

```javascript
// src/agents/tools/memory-tool.ts
return {
  label: "Memory Search",
  name: "memory_search",
  description:
    "Mandatory recall step: semantically search MEMORY.md + memory/*.md " +
    "(and optional session transcripts) before answering questions about " +
    "prior work, decisions, dates, people, preferences, or todos; " +
    "returns top snippets with path + lines.",
  parameters: MemorySearchSchema,
  execute: async (_toolCallId, params) => {
    const query = readStringParam(params, "query", { required: true });
    const { manager, error } = await getMemorySearchManager({ cfg, agentId });
    if (!manager) {
      return jsonResult({ results: [], disabled: true, error });
    }
    const results = await manager.search(query, {
      maxResults,
      minScore,
      sessionKey
    });
    return jsonResult({
      results,
      provider: status.provider,
      model: status.model,
      fallback: status.fallback,
    });
  },
};
```

### 7.2 memory_get 工具

读取特定记忆文件的内容（从起始行开始，读取 N 行）。

---

## 八、关键常量配置

| 常量 | 值 | 用途 |
|------|-----|------|
| `SNIPPET_MAX_CHARS` | 700 | 每个结果返回的最大字符数 |
| `EMBEDDING_BATCH_MAX_TOKENS` | 8000 | �嵌入 API 调用的批量大小 |
| `EMBEDDING_INDEX_CONCURRENCY` | 4 | 并发嵌入请求数 |
| `DEFAULT_MEMORY_FLUSH_SOFT_TOKENS` | 4000 | 压缩刷新前的缓冲区 |
| `chunking.tokens` | 400 | 每块的目标大小 |
| `chunking.overlap` | 80 | 块之间的重叠 |
| `hybrid.vectorWeight` | 0.7 | 向量搜索权重 |
| `hybrid.textWeight` | 0.3 | 关键词搜索权重 |
| `hybrid.candidateMultiplier` | 4 | 候选扩充倍数 |

---

## 九、值得借鉴的设计模式

### 1. 文件作为唯一真实来源
- Markdown 文件是规范的
- SQLite 索引是衍生的
- 调试就是阅读，而不是查询

### 2. 混合搜索作为加权联合
- 采用联合而非交集
- 对任一方法有效的查询都能成功
- 70/30 权重可调节平衡

### 3. 预压缩刷新
- 在上下文溢出前提示代理保存
- `memoryFlushCompactionCount` 跟踪防止双重刷新

### 4. 优雅降级
- 嵌入失败？关键词搜索仍然工作
- 关键词失败？向量搜索仍然工作
- 两者都失败？你仍然拥有 Markdown 文件

### 5. 本地优先，非仅本地
- 提供商降级链（本地 → OpenAI → Gemini）
- 可以使用本地模型完全离线运行
- 或者如果更方便，使用云嵌入

---

## 十、SQLite 与其他数据库的对比

| 特性 | SQLite (OpenClaw) | 专用向量 DB | 传统 RDBMS |
|------|-------------------|-------------|--------------|
| **Setup** | 零运维（下载即用） | 需要独立服务/Docker | 需要服务器进程 |
| **Portability** | 单个 .sqlite 文件 | 数据迁移高开销 | 复杂迁移 |
| **Search** | 向量 + 关键词（混合） | 专用向量 | 主要关键词/关系 |

---

## 十一、QMD 后端（实验性）

OpenClaw 支持可选的 QMD 后端替代内置 SQLite 索引器：

**特点：**
- 本地优先搜索 sidecar（BM25 + 向量 + 重排序）
- Markdown 保持为真实来源
- 通过 Bun + node-llama-cpp 运行
- 自动从 HuggingFace 下载 GGUF 模型

**配置：**
```javascript
memory: {
  backend: "qmd",
  qmd: {
    includeDefaultMemory: true,
    update: { interval: "5m", debounceMs: 15000 },
    limits: { maxResults: 6, timeoutMs: 4000 },
    scope: {
      default: "deny",
      rules: [{ action: "allow", match: { chatType: "direct" } }]
    }
  }
}
```

---

## 十二、安全考虑

持久记忆带来了安全挑战：

1. **访问私有数据** - 配置和记忆存储在可预测位置
2. **暴露于不受信任的内容** - 执行外部命令时的记忆泄露
3. **在保留记忆的同时执行外部通信** - API 密钥和记忆的双重风险

1Password 的安全评估警告：
> "一个被盗的 API 令牌已经很糟糕……但一百个被盗的令牌和会话，加上一个描述你是谁、你在构建什么、你和谁一起工作的长期记忆文件，那就完全是另一回事了。"

---

## 总结

OpenClaw 的记忆架构代表了一种哲学选择：**优先考虑透明度、人类控制和优雅降级**，而不是托管向量数据库的便利性。

**核心优势：**
- 文件优先的方法意味着用户完全拥有他们的数据
- 混合 BM25 + 向量搜索解决了实际的检索限制
- 预压缩刷新机制解决了上下文窗口悬崖问题
- 优雅降级确保系统始终可用

**适用场景：**
- 个人 AI 助手（本地优先）
- 需要数据隐私的场景
- 离线环境运行需求
- 对透明度有高要求的专业用户

**限制：**
- 单用户设计（非多租户）
- 大规模时需要迁移到分布式数据库
- 文件同步需要手动配置

---

## 参考资源

- [OpenClaw 官方文档 - Memory](https://docs.openclaw.ai/concepts/memory)
- [PingCAP - Local-First RAG with SQLite](https://www.pingcap.com/blog/local-first-rag-using-sqlite-ai-agent-memory-openclaw/)
- [MMNTM - OpenClaw Memory Architecture](https://www.mmntm.net/articles/openclaw-memory-architecture)
- [OpenClaw GitHub](https://github.com/openclaw/openclaw)
