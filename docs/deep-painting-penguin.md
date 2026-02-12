# Lume Agent 记忆系统完整实现计划

> 基于对 OpenClaw 和 MemSearch 的深入调研，为 Lume Agent 项目制定完整的记忆系统实现计划

**规划时间**: 2026-02-12
**规划版本**: 1.0
**状态**: 可行（分阶段实施中）

## 可行性评审结论（2026-02-12）

### 结论
- 任务可行，但原文档中的阶段性 `✅` 与仓库真实实现不一致，需要按“先核心、再集成”推进。
- 依赖 OpenClaw 的设计可直接复用到 Lume 当前架构（`Tauri + Next.js + Bun sidecar`），尤其是纯逻辑部分。

### OpenClaw 可复用设计（已完成阅读与对照）
- `Markdown-First`：Markdown 是 Source of Truth，索引可重建。
- `chunkMarkdown`：Token 近似切块 + overlap（`tokens=400`, `overlap=80`）。
- `Hybrid Search`：向量与关键词并集合并（Union）+ 70/30 加权。
- `bm25RankToScore`：`1 / (1 + rank)` 归一化策略。
- `buildFtsQuery`：英文 token 化后构造 `AND` 查询。

### 与当前仓库的差距
- 现有代码尚未落地完整 memory 索引/搜索服务与 MCP 工具链路。
- 本次先完成可复用核心算法基线（纯逻辑 + 测试），为后续 SQLite/Embedding/Watcher 集成做稳定底座。

---

## 一、项目背景与需求分析

### 1.1 现有技术栈
- **前端**: Next.js 15 + React 18 + Jotai 状态管理
- **后端**: Bun + TypeScript
- **桌面框架**: Tauri
- **配置存储**: `~/.lume/` (JSON + JSONL 文件）

### 1.2 记忆系统现状
- ⚠️ **已完成基础能力（Chunker + Hybrid merge + SQLite 索引管理器 + 关键词检索 + Lite 向量检索）**
- ⚠️ **已接入持久化索引存储（SQLite files/chunks/chunks_fts，vec 表为可选）**
- ⚠️ **已接入本地 Lite Embedding（无需 API Key）；远程高质量 Embedding 提供商尚未接入**
- ⚠️ **已支持 Markdown 文件索引编排（`MEMORY.md` + `memory/*.md`）**
- ❌ **无记忆压缩机制**
- ⚠️ **已接入文件监控自动同步（workspace 级 fs.watch + 1500ms 防抖）**

### 1.3 用户需求
- 为 Lume Agent 实现持久化记忆系统
- 支持语义搜索（向量和关键词）
- 参考 OpenClaw 的成熟设计
- 与现有 MCP/Skills 体系集成

---

## 二、架构设计原则（参考 OpenClaw）

### 2.1 Markdown-First 设计理念
```
核心原则：Markdown 文件是唯一的真实来源（Source of Truth）
┌─────────────────────────────────────────────────────┐
│                   Lume Agent 记忆系统架构                    │
└─────────────────────────────────────────────────────────────┘

┌──────────────┐                    ┌───────────────────┐     ┌──────────────────┐
│ Markdown 文件 │◄────────►│ 向量索引层      │◄──►│ 搜索服务层      │
│ (唯一真实来源)  │              │              │              │              │
│                  │              │              │              │
└──────────────┘    └───────────────────┘     └───────────────────┘     └───────────────────┘
                                   │
                            ▼
                      Agent 工具集成层
```

**关键特点：**
- ⬜ 人类可读：可直接用文本编辑器检查和编辑记忆
- ⬜ Git 友好：版本控制友好
- ⬜ 可移植性：单个 `.sqlite` 文件包含所有数据
- ⬜ 调试友好：阅读文本而非查询数据库

### 2.2 两层记忆结构

| 记忆类型 | 文件路径 | 加载时机 | 用途 |
|---------|---------|---------|
| **长期记忆** | `MEMORY.md` | 仅主私人会话 | 稳定的事实、偏好、关键决策 |
| **运行日志** | `memory/YYYY-MM-DD.md` | 会话开始时读取今天+昨天 | 按日期的运行上下文 |
| **会话索引** | `.sqlite` 索引表 | 语义搜索和全文检索 |

### 2.3 存储架构

```
~/.lume/workspaces/{workspaceSlug}/
├── MEMORY.md              # 长期记忆
├── memory/
│   ├── 2026-02-12.md      # 当日日志
│   ├── 2026-02-13.md
│   └── ...
├── {workspaceSlug}.sqlite     # 记忆索引
└── memory/
    ├── compacted/            # 压缩后的记忆
    └── 2026-02-summary.md   # 压缩摘要
```

---

## 三、数据库 Schema 设计

### 3.1 核心表结构

```sql
-- 文件跟踪表
CREATE TABLE files (
  path TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'memory',
  hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL
);

-- 分块存储表
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'memory',
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  hash TEXT NOT NULL,
  model TEXT NOT NULL,
  text TEXT NOT NULL,
  heading TEXT,
  heading_level INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 嵌入缓存表
CREATE TABLE embedding_cache (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  hash TEXT NOT NULL,
  embedding TEXT NOT NULL,
  dims INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, model, hash)
);

-- FTS5 全文搜索表
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text,
  id UNINDEXED,
  path UNINDEXED,
  workspace_id UNINDEXED,
  source UNINDEXED,
  model UNINDEXED,
  start_line UNINDEXED,
  end_line UNINDEXED,
  heading UNINDEXED,
  heading_level UNINDEXED
);

-- 向量加速表（使用 sqlite-vec 扩展）
CREATE VIRTUAL TABLE chunks_vec USING vec0(
  id TEXT PRIMARY KEY,
  embedding FLOAT[1536]  -- OpenAI text-embedding-3-small
);
```

### 3.2 索引字段说明

| 字段 | 用途 | 说明 |
|------|------|------|
| `id` | 主键 | 复合格式：`{workspace}:{path}:{startLine}:{endLine}:{hash}:{model}` |
| `embedding` | 向量数据 | JSON 序列化的浮点数组（1536 维） |
| `hash` | 内容哈希 | SHA-256 哈希，用于去重检测 |
| `model` | 嵌入模型 | 标识使用的嵌入模型（如 `text-embedding-3-small`） |
| `heading` | 标题 | 所属的 Markdown 标题（如果有） |
| `heading_level` | 标题层级 | 0-6，0 表示前导部分 |

---

## 四、核心模块实现

### 4.1 MemoryChunker - Markdown 分块器

**职责**: 将 Markdown 文件分割为可索引的块

**核心算法**（参考 OpenClaw）：
```typescript
export function chunkMarkdown(
  content: string,
  path: string,
  config: ChunkingConfig
): MemoryChunk[] {
  const lines = content.split("\n");
  const maxChars = config.tokens * 4;  // Token 估算：1 token ≈ 4 chars
  const overlapChars = config.overlap * 4;

  const chunks: MemoryChunk[] = [];
  let current: Array<{ line: string; lineNo: number }> = [];
  let currentChars = 0;

  // 分块主循环
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;

    // 处理超长行
    const segments: string[] = [];
    if (line.length === 0) {
      segments.push("");
    } else {
      for (let start = 0; start < line.length; start += maxChars) {
        segments.push(line.slice(start, start + maxChars));
      }
    }

    // 边界处理
    for (const segment of segments) {
      const lineSize = segment.length + 1; // +1 for newline

      // 如果当前块会超限，先输出
      if (currentChars + lineSize > maxChars && current.length > 0) {
        flush();  // 输出当前块
        carryOverlap();  // 保留重叠部分
      }

      current.push({ line: segment, lineNo });
      currentChars += lineSize;
    }
  }

  flush();  // 输出最后一个块
  return chunks;
}
```

**配置参数**：
- `tokens`: 400（默认，每块约 1600 字符）
- `overlap`: 80（默认，约 320 字符重叠）

### 4.2 EmbeddingManager - 嵌入管理器

**职责**: 管理嵌入生成，支持多提供商和缓存

**提供商优先级**（参考 OpenClaw）：
1. **Local** - 本地嵌入（node-llama-cpp）
2. **OpenAI** - OpenAI API（text-embedding-3-small）
3. **Gemini** - Google Gemini（gemini-embedding-001）
4. **Voyage** - Voyage API（voyage-3-lite）

**缓存机制**：
```typescript
class EmbeddingCache {
  private cache: Map<string, number[]>;  // hash → embedding
  private db: Database;

  async get(text: string): Promise<number[] | null> {
    const hash = this.sha256(text);

    // 1. 内存缓存
    if (this.cache.has(hash)) {
      return this.cache.get(hash);
    }

    // 2. SQLite 缓存
    const row = this.db.prepare(
      `SELECT embedding FROM embedding_cache WHERE hash = ?`
    ).get(hash);

    if (row) {
      return JSON.parse(row.embedding);
    }

    return null;
  }

  async set(text: string, embedding: number[]): Promise<void> {
    const hash = this.sha256(text);

    // 更新内存缓存
    this.cache.set(hash, embedding);

    // 更新 SQLite 缓存
    this.db.prepare(
      `INSERT OR REPLACE INTO embedding_cache (provider, model, hash, embedding, dims, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      this.config.provider,
      this.config.model,
      hash,
      JSON.stringify(embedding),
      embedding.length,
      Date.now()
    );
  }
}
```

### 4.3 MemoryIndexManager - 索引管理器

**职责**: 管理文件索引的构建、更新、删除和搜索

**核心方法**：
```typescript
class MemoryIndexManager {
  // 构建或更新单个文件的索引
  async indexFile(
    filePath: string,
    force?: boolean
  ): Promise<number>;

  // 构建或更新整个目录的索引
  async indexDirectory(
    dirPath: string,
    force?: boolean
  ): Promise<number>;

  // 删除文件的索引
  async removeFile(
    filePath: string
  ): Promise<void>;

  // 搜索记忆
  async search(
    query: string,
    options?: SearchOptions
  ): Promise<SearchResult[]>;

  // 获取索引统计
  getStats(): Promise<IndexStats>;
}
```

### 4.4 MemorySearchService - 搜索服务

**职责**: 实现混合搜索（向量 + BM25 全文）

**搜索算法**（参考 OpenClaw 加权联合）：
```typescript
export function mergeHybridResults(
  vectorResults: SearchResult[],
  textResults: SearchResult[],
  vectorWeight: number = 0.7,  // 默认权重
  textWeight: number = 0.3    // 默认权重
): SearchResult[] {
  const byId = new Map<string, SearchResult>();

  // 1. 添加向量结果
  for (const result of vectorResults) {
    byId.set(result.id, {
      ...result,
      vectorScore: result.score,
      textScore: 0,
      source: 'vector',
    });
  }

  // 2. 合并全文搜索结果
  for (const result of textResults) {
    const existing = byId.get(result.id);
    if (existing) {
      existing.textScore = result.score;
      existing.source = 'hybrid';
    } else {
      byId.set(result.id, {
        ...result,
        vectorScore: 0,
        textScore: result.score,
        source: 'text',
      });
    }
  }

  // 3. 计算最终得分
  const merged = Array.from(byId.values()).map(result => {
    const score = result.vectorScore * vectorWeight +
                 result.textScore * textWeight;
    return {
      ...result,
      score,
      source: 'hybrid',
    };
  });

  // 4. 按得分排序
  return merged
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}
```

### 4.5 MemoryFileWatcher - 文件监控器

**职责**: 监控 Markdown 文件变化，自动触发索引更新

**实现**（参考 OpenClaw）：
```typescript
import chokidar from 'chokidar';

class MemoryFileWatcher {
  private watchers: Map<string, FSWatcher>;
  private debounceTimers: Map<string, NodeJS.Timeout>;

  watch(
    workspaceId: string,
    paths: string[],
    callback: (filePath: string) => void
  ): void {
    for (const path of paths) {
      const watcher = chokidar.watch(path, {
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 1500,  // 1.5 秒防抖
          pollInterval: 100,
        },
      });

      watcher.on('change', (path) => {
        this.scheduleCallback(filePath);  // 防抖调度
      });

      watcher.on('unlink', (path) => {
        this.scheduleCallback(filePath);
      });

      this.watchers.set(path, watcher);
    }
  }

  private scheduleCallback(filePath: string): void {
    // 清除旧计时器
    if (this.debounceTimers.has(filePath)) {
      clearTimeout(this.debounceTimers.get(filePath)!);
    }

    // 设置新的防抖计时器
    const timer = setTimeout(() => {
      this.callback(filePath);  // 执行回调
      this.debounceTimers.delete(filePath);
    }, 1500);

    this.debounceTimers.set(filePath, timer);
  }
}
```

### 4.6 本次已完成（可复用核心逻辑）

- 已新增 `apps/sidecar/src/services/memory/memory-chunker.ts`
  - `chunkMarkdown`：Token 估算切块 + overlap（对齐 OpenClaw 设计）。
  - `resolveChunkingConfig`：统一默认参数与模型配置入口。
- 已新增 `apps/sidecar/src/services/memory/hybrid-search.ts`
  - `mergeHybridResults`：向量 + 关键词并集合并并加权排序。
  - `bm25RankToScore`：BM25 rank 归一化。
  - `buildFtsQuery`：FTS `AND` 查询构建。
- 已新增 `apps/sidecar/src/services/memory/memory-index-manager.ts`
  - SQLite schema 初始化（`meta/files/chunks/embedding_cache/chunks_fts`，`chunks_vec` 可选创建）。
  - `indexFile` / `indexWorkspace`：索引 `MEMORY.md` 与 `memory/*.md`。
  - `search`：关键词检索 + 混合结果聚合（向量分支预留），结果输出 `snippet` + `citation`。
  - `readFile`：按 path/from/lines 的安全片段读取（对齐 OpenClaw `memory_get` 思路）。
  - `getStats`：索引统计信息。
- 已新增 `apps/sidecar/src/services/memory-service.ts` 与 sidecar RPC：
  - `memory:index-workspace`
  - `memory:index-file`
  - `memory:search`
  - `memory:stats`
  - `memory:get`
  - `memory:save`
- 已新增 `apps/sidecar/src/services/memory-sync-watcher.ts`
  - 监听 `~/.lume/agent-workspaces/**/(MEMORY.md|memory/*.md)` 变化。
  - 变更后自动触发增量索引；删除后自动清理索引记录。
- 已新增 `apps/sidecar/src/services/memory/embeddings-lite.ts`
  - 本地 deterministic embedding（支持英文 token + 中文 Han 字符 token）。
  - `memory:search` 默认携带 query embedding，启用向量分支。
- 已新增 `apps/sidecar/src/services/memory/embedding-provider.ts`
  - Provider 解析与回退：`auto -> openai/gemini -> lite`。
  - 环境变量：`LUME_MEMORY_PROVIDER`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`。
  - 索引与查询统一走 embedding cache（`embedding_cache`）。
  - 批量 embedding：OpenAI batch 输入，Gemini/Lite 并发执行（并发与批大小可配置常量）。
- 向量检索路径：
  - 运行时优先探测并尝试 `sqlite-vec` (`chunks_vec + vec_distance_cosine`)。
  - 不可用时自动回退到 JS cosine 路径（不中断功能）。
- 已新增 `memory:status` RPC
  - 返回当前 provider/model/fallback 与 `fts/vec` 可用状态。
- 已在 Agent 消息发送链路接入 recall 注入（参考 OpenClaw mandatory recall 思路）：
  - 发送前按用户消息做 `memory:search`，将结果以 `<memory_recall>` 注入 prompt。
  - 位置：`apps/sidecar/src/services/agent-service.ts` + `apps/sidecar/src/services/agent-prompt-builder.ts`
- 已新增测试：
  - `apps/sidecar/src/services/memory/memory-chunker.test.ts`
  - `apps/sidecar/src/services/memory/hybrid-search.test.ts`
  - `apps/sidecar/src/services/memory/memory-index-manager.test.ts`
  - `apps/sidecar/src/services/memory/memory-save.test.ts`
  - `apps/sidecar/src/services/memory/embeddings-lite.test.ts`
  - `apps/sidecar/src/services/memory/embedding-provider.test.ts`
  - `apps/sidecar/src/services/agent-prompt-builder.test.ts`
  - `apps/sidecar/src/services/memory/memory-index-manager.reconcile.test.ts`
  - `apps/sidecar/src/services/memory-service.test.ts`
- 验证结果：
  - `bun run --filter @lume/shared typecheck` 通过
  - `bun run --filter @lume/sidecar typecheck` 通过
  - `bun test apps/sidecar/src/services/memory` 通过（12/12）
  - `bun test apps/sidecar/src/services` 通过（16/16）

---

## 五、实现路径（分 5 个阶段，约 8-10 周）

### Phase 1: 核心存储和索引（3 周）

**目标**: 建立基础记忆存储和索引能力

**任务清单**：
1. ✅ 创建 SQLite 数据库 Schema（当前已落地 files/chunks/chunks_fts，chunks_vec 为可选创建）
2. ✅ 实现 MemoryChunker 分块器（Token 估算 + 重叠）
3. ⬜ 实现 EmbeddingManager（OpenAI API 集成）
4. ✅ 实现 MemoryIndexManager（文件索引 + 基础检索）
5. ✅ 已实现配置文件 `~/.lume/memory/config.json`（含 `version`，缺失时自动生成，兼容旧格式）
6. ✅ 添加单元测试（chunker/hybrid/index-manager）

**可交付成果**:
- 可以扫描和索引 Markdown 文件
- 嵌入向量存储在 SQLite
- 基本的 CRUD 操作正常工作
- 配置系统可管理嵌入参数

**验收标准**:
- 索引文件后能通过 `memory_search` 工具检索到内容
- 文件监控正常触发索引更新
- 单元测试覆盖率 > 80%

---

### Phase 2: 搜索接口（2 周）

**目标**: 实现混合搜索能力

**任务清单**：
1. ⬜ 实现 MemorySearchService（向量 + BM25 混合搜索）
2. ⬜ 创建 FTS5 全文搜索表
3. ✅ 实现向量搜索（cosine 相似度，Lite Embedding 版本）
4. ✅ 实现加权结果合并算法
5. ✅ 添加搜索结果排序和过滤
6. ⬜ 实现缓存机制减少重复嵌入（当前仅 schema 预留 `embedding_cache`）
7. ⚠️ 已集成到 Agent prompt recall，MCP tool 化仍待补齐

**可交付成果**:
- `memory_search` 工具可执行语义搜索
- 向量搜索延迟 < 500ms
- 全文搜索延迟 < 100ms
- 混合搜索结果准确
- 搜索结果包含相关性得分和来源信息

**验收标准**:
- 能搜索到包含特定关键词的记忆
- 能搜索到语义相关的记忆
- 搜索结果按相关性排序
- 缓存命中率 > 50%（减少重复 API 调用）

---

### Phase 3: 文件监控（2 周）

**目标**: 自动同步文件变化

**任务清单**：
1. ⚠️ 使用 `fs.watch` 完成工作区级监听（MVP 可用，后续可替换 Chokidar）
2. ✅ 实现防抖逻辑（1500ms）
3. ✅ 实现增量索引更新
4. ✅ 实现文件删除处理
5. ⬜ 添加监控状态管理

**可交付成果**:
- 文件变化后 1.5 秒内触发索引更新
- 防抖机制减少不必要的索引操作 > 80%
- 监控器稳定运行，无内存泄漏
- 支持多个路径同时监控

**验收标准**:
- 文件修改后自动触发索引更新
- 防抖机制正常工作
- 监控器资源正确释放
- 文件删除后索引正确清理

---

### Phase 4: 记忆压缩（2 周）

**目标**: 实现记忆压缩机制，减少存储和搜索开销

**任务清单**：
1. ⬜ 实现 MemoryCompactor 压缩器
2. ⬜ 集成 LLM API（Claude API）
3. ⬜ 实现压缩策略（超过 N 天的记忆）
4. ⬜ 创建压缩结果存储逻辑
5. ⬜ 添加定期压缩调度

**可交付成果**:
- 可以手动触发记忆压缩
- 自动压缩 7 天前的记忆
- 压缩结果写回 `memory/compacted/YYYY-MM-DD.md`
- 压缩后原始索引自动更新

**验收标准**:
- 压缩后原始索引被删除
- 压缩内容可被搜索到
- 压缩质量良好，保留关键信息

---

### Phase 5: 工具集成（1 周）

**目标**: 将记忆系统集成到 Agent 工具

**任务清单**:
1. ✅ 已实现 `memory_search` Agent 工具（通过 Claude SDK 内置 `createSdkMcpServer` 注册）
2. ✅ 已实现 `memory_get` Agent 工具（通过 Claude SDK 内置 `createSdkMcpServer` 注册）
3. ✅ 已实现 `memory_save` Agent 工具（通过 Claude SDK 内置 `createSdkMcpServer` 注册）
4. ✅ 更新 Agent Prompt Builder，强制“先 `memory_search` 再 `memory_get`”
5. ✅ 已补齐 memory 工具策略层（allow/deny + `group:memory` 展开）
6. ✅ 已补齐 citation mode 行为（`on/off/auto`，auto=仅 direct 启用）
7. ✅ 已补齐 OpenClaw 风格 `sources + extraPaths`（支持 `memory`/`sessions` 来源与额外路径索引）
5. ⬜ 添加配置界面（开关和参数）

**可交付成果**:
- Agent 可调用 `memory_search` 工具搜索记忆
- Agent 可调用 `memory_get` 读取完整记忆文件
- Agent 可调用 `memory_save` 保存新记忆
- 配置界面可控制记忆功能开关

**验收标准**:
- `memory_search` 工具返回相关记忆片段
- `memory_get` 工具返回完整文件内容
- `memory_save` 工具成功写入 Markdown 文件
- 配置更改实时生效

---

## 六、关键技术决策

### 6.1 数据库选型

| 阶段 | 开发 | 生产 | 推荐方案 |
|------|------|------|------|
| **当前** | SQLite | SQLite | - |
| **扩展** | 可选 Milvus | 可选 Milvus | **开发阶段使用 SQLite，生产环境可选 Milvus |

**推荐**: 开发阶段使用 SQLite（零运维），生产环境根据规模选择是否迁移 Milvus

### 6.2 嵌入模型选型

| 模型 | 维度 | 成本 | 速度 | 推荐场景 |
|------|------|------|----------|
| **text-embedding-3-small** | 1536 | 低 | 快 | 日常对话、代码搜索 |
| **gemini-embedding-001** | 768 | 中 | 中 | 多模态内容 |
| **local (可选)** | 384 | 免费 | 慢 | 离线场景 |

**推荐**: 默认使用 OpenAI，提供本地嵌入作为备选

### 6.3 分块参数

| 参数 | 推荐值 | 说明 |
|------|---------|------|
| `tokens` | 400 | 约 1600 字符/块 | 适合 LLM 上下文 |
| `overlap` | 80 | 约 320 字符重叠 | 保持上下文连贯性 |

### 6.4 搜索权重

| 参数 | 推荐值 | 说明 |
|------|---------|------|
| `vectorWeight` | 0.7 | 语义搜索权重 | 优先理解意图 |
| `textWeight` | 0.3 | 关键词搜索权重 | 优先精确匹配 |

---

## 七、风险与缓解措施

### 7.1 技术风险

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|----------|------|
| sqlite-vec 加载失败 | 向量搜索不可用 | 10% | 提供 JS 层降级实现 |
| 嵌入 API 失败 | 无法生成向量 | 5% | 多提供商降级策略 |
| 文件监控失败 | 变化不同步 | 2% | 看异常处理和重试机制 |
| 数据库损坏 | 索引丢失 | 1% | 定期备份和版本控制 |
| 压缩失败 | 记忆丢失 | 2% | 压缩前自动备份 |

### 7.2 缓解措施

1. **多提供商降级**: 主提供商失败时自动切换
2. **嵌入缓存**: 减少重复 API 调用
3. **定期备份**: 每日自动备份 SQLite 数据库
4. **错误处理**: 完善的错误日志和用户提示
5. **优雅降级**: 任何功能失败时保持基本可用性

---

## 八、测试策略

### 8.1 单元测试

**目标**: 确保每个模块功能正确

**测试范围**：
- MemoryChunker 分块逻辑测试
- EmbeddingManager 嵌入和缓存测试
- MemoryIndexManager CRUD 操作测试
- MemorySearchService 搜索功能测试
- MemoryFileWatcher 监控功能测试

**测试工具**: Jest + Testing Library

**验收标准**:
- 单元测试覆盖率 > 80%
- 关键功能有测试用例覆盖
- 所有测试用例都能正常通过

### 8.2 集成测试

**目标**: 验证各模块协同工作

**测试场景**:
- 文件变化 → 自动索引更新 → 搜索可找到新内容
- 嵌入失败 → 降级到备选提供商 → 搜索仍然可用
- 记忆压缩 → 旧索引删除 → 新索引可搜索压缩内容

**验收标准**:
- 端到端测试通过率 > 90%
- 关键用户场景验证通过
- 性能指标满足要求（搜索延迟 < 500ms）

---

## 九、成功指标

### 9.1 功能指标

| 指标 | 目标值 | 测量方法 |
|------|---------|----------|
| **索引覆盖率** | > 95% | 统计已索引文件占比 |
| **搜索准确率** | > 85% | 相关结果在前 10 名内 |
| **搜索延迟** | < 500ms | P95 延迟 |
| **缓存命中率** | > 50% | 重复请求使用缓存 |
| **文件监控响应** | < 2s | 文件变化到索引更新的时间 |

### 9.2 用户体验指标

| 指标 | 目标值 | 测量方法 |
|------|---------|----------|
| **记忆检索成功率** | > 90% | 用户搜索到相关记忆的比例 |
| **工具使用率** | > 30% | memory_search 工具调用频率 |
| **配置可用性** | 100% | 所有关键配置都可修改 |

---

## 十、项目里程碑

### 10.1 里程碑时间线

| 阶段 | 预计完成时间 | 关键交付物 |
|------|---------|----------|
| **Phase 1** | 第 3 周 | SQLite Schema + 基础索引 |
| **Phase 2** | 第 5 周 | 混合搜索服务 |
| **Phase 3** | 第 7 周 | 文件监控集成 |
| **Phase 4** | 第 9 周 | 记忆压缩机制 |
| **Phase 5** | 第 11 周 | 工具集成完成 |

---

## 十一、后续优化方向

### 11.1 短期优化（1-3 个月）

1. **性能优化**
   - 批量嵌入处理
   - 向量索引优化（HNSW 算法）
   - 搜索结果缓存
   - 连接池管理

2. **功能增强**
   - 多模态记忆支持（图片、代码片段）
   - 记忆图谱构建（实体关系抽取）
   - 个性化记忆（用户偏好学习）

3. **可扩展性**
   - Milvus 迁移准备
   - 分布式存储支持
   - 插件化记忆后端

---

## 十二、总结与建议

### 12.1 核心优势

本实现方案的**核心优势**：

1. **Markdown-First 设计**
   - 人类可读性：用户可直接检查和编辑记忆
   - Git 友好：版本控制清晰
   - 可移植性：单文件数据迁移
   - 调试友好：问题排查直观

2. **混合搜索**
   - 结合语义和关键词搜索的优势
   - 可配置的权重平衡
   - 高召回率

3. **模块化架构**
   - 清晰的职责分离
   - 可独立测试和升级
   - 易于维护和扩展

4. **渐进式实现**
   - 分阶段推进，降低风险
   - 每个阶段都有明确的验收标准
   - 便于问题追踪和修复

### 12.2 与 OpenClaw 的对比

| 特性 | OpenClaw | Lume 实现 | 分析 |
|------|----------|----------|
| **代码成熟度** | ⭐⭐⭐⭐ | ⭐⭐⭐ | OpenClaw 有多年的生产经验 |
| **本地优先** | ✅ | 计划中 | 后续接入 node-llama-cpp |
| **文件监控** | Chokidar | Chokidar | 完全相同 |
| **混合搜索** | 加权联合 | 加权联合（已落地纯逻辑） | 与 OpenClaw 保持一致，便于调参 |
| **嵌入提供商** | 4 种 | 计划 3 种 | 先完成 OpenAI/Gemini/Local |

**Lume 实现的优势**：
- 更清晰的项目结构和类型定义
- 更好的错误处理和日志
- 更灵活的配置系统
- 与现有 MCP/Skills 体系集成
- 更现代的测试框架

### 12.3 实施建议

1. **第一阶段（1-3 个月）**: 建立核心存储和索引
   - 优先实现基础功能
   - 参考 OpenClaw 的成熟代码设计
   - 使用 SQLite 作为零运维解决方案

2. **第二阶段（4-6 个月）**: 完善搜索和监控
   - 实现混合搜索
   - 添加文件监控
   - 优化搜索性能

3. **第三阶段（7-11 个月）**: 高级功能
   - 记忆压缩机制
   - 工具集成
   - 性能优化

4. **生产就绪**: 可选 Milvus 迁移

---

## 附录：参考资源

### 13.1 技术文档

本实现计划参考的调研文档：

1. `docs/OpenClaw记忆系统技术分析.md` - OpenClaw 源代码深度分析
2. `docs/MemSearch记忆系统技术分析.md` - MemSearch 系统分析
3. `docs/记忆系统对比分析-OpenClaw-vs-MemSearch.md` - 两个项目对比分析

### 13.2 关键代码库

- OpenClaw: https://github.com/openclaw/openclaw
- MemSearch: https://github.com/zilliztech/memsearch
- sqlite-vec: https://github.com/asg017/sqlite-vec
- FTS5: https://www.sqlite.org/fts5.html

---

**规划状态**: 待用户审批后开始实施

**预计总工时**: 约 8-10 周

**关键风险**:
- SQLite 扩展兼容性问题
- 嵌入 API 成本控制
- 文件监控跨平台兼容性

**缓解措施**:
- 充分的兼容性测试
- 多提供商降级策略
- 优雅的错误处理和用户提示

---

**计划制定完成，等待用户审批后开始实施！**
