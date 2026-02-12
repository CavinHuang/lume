# MemSearch 记忆系统技术分析

> 基于 [Zilliz/MemSearch](https://github.com/zilliztech/memsearch) 的记忆系统实现深度解析
> 分析版本: main (2026-02-12)

---

## 一、项目概述

**MemSearch** 是一个受 OpenClaw 记忆系统启发的、基于 Markdown 的语义记忆搜索库，由 Zilliz（Milvus 背后的公司）开发。它提供了一个独立的、可插入任何 AI 框架的记忆解决方案。

### 1.1 核心设计理念

| 设计原则 | 实现方式 |
|---------|----------|
| **Markdown 是唯一的真实来源** | 所有记忆以人类可读的 `.md` 文件存储 |
| **向量存储是派生索引** | 可随时从 Markdown 重建 |
| **零供应商锁定** | 无专有数据库格式 |

---

## 二、整体架构和目录结构

### 2.1 核心目录结构

```
memsearch/
├── src/memsearch/          # 主要源代码
│   ├── __init__.py        # 模块入口
│   ├── core.py            # MemSearch 主编排类
│   ├── chunker.py         # Markdown 分块逻辑
│   ├── embeddings/        # 嵌入提供商
│   ├── store.py           # Milvus 存储层
│   ├── scanner.py         # 文件扫描器
│   ├── watcher.py         # 文件监控器
│   ├── compact.py         # 记忆压缩
│   ├── transcript.py      # JSONL 转录本解析
│   ├── config.py          # 配置系统
│   └── cli.py           # CLI 接口
├── ccplugin/              # Claude Code 插件
│   ├── hooks/            # Shell 脚本钩子
│   └── .claude-plugin/
└── tests/                # 测试文件
```

### 2.2 数据流架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Search Pipeline                                   │
└─────────────────────────────────────────────────────────────────────────┘
     Query: "how to configure Redis?"
              │
              ▼
     ┌──────────┐  ┌─────────────┐  ┌──────────────┐
     │ Embed    │→ │ Cosine      │→ │ Top-K results│
     │ query    │  │ similarity  │  │ with source  │
     └──────────┘  │ (Milvus)    │  │ info         │
                    └─────────────┘  └──────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│  Ingest Pipeline                                  │
└─────────────────────────────────────────────────────────────────────────┘
  MEMORY.md
  memory/2026-02-09.md
              │
              ▼
     ┌──────────┐  ┌────────────┐  ┌──────────────┐
     │ Chunker  │→ │ Dedup      │→ │ Embed &      │
     │          │  │(chunk_hash │  │ Milvus       │
     │          │  │ PK)        │  │ upsert       │
     └──────────┘  └────────────┘  └──────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│  Watch Pipeline                                   │
└─────────────────────────────────────────────────────────────────────────┘
  File watcher (1500ms debounce) → auto re-index/delete stale

┌─────────────────────────────────────────────────────────────────────────┐
│  Compact Pipeline                                 │
└─────────────────────────────────────────────────────────────────────────┘
  Retrieve chunks → LLM summarize → write memory/YYYY-MM-DD.md
```

---

## 三、记忆存储机制

### 3.1 向量数据库：Milvus

**为什么选择 Milvus：**
- 开源、可扩展的向量数据库
- 支持混合搜索（稠密向量 + BM25 稀疏向量）
- 从嵌入式到分布式集群的无缝升级路径

### 3.2 三种部署模式

| 模式 | `milvus_uri` | 适用场景 |
|------|---------------|----------|
| **Milvus Lite** (默认) | `~/.memsearch/milvus.db` | 个人使用、开发 - 零配置 |
| **Milvus Server** | `http://localhost:19530` | 多智能体、团队环境 |
| **Zilliz Cloud** | `https://in03-xxx.api.gcp-us-west1.zillizcloud.com` | 生产环境、完全托管 |

### 3.3 Collection Schema 设计

```python
# Milvus Collection: memsearch_chunks
schema = {
    "fields": [
        {
            "name": "chunk_hash",           # 主键，SHA-256哈希
            "type": "VARCHAR",
            "max_length": 64,
            "primary_key": True
        },
        {
            "name": "embedding",            # 稠密向量
            "type": "FLOAT_VECTOR",
            "dim": 1536  # OpenAI text-embedding-3-small
        },
        {
            "name": "sparse_vector",        # BM25稀疏向量
            "type": "SPARSE_FLOAT_VECTOR",
            "auto_generated": True  # 通过BM25函数自动生成
        },
        {
            "name": "content",              # 原始内容
            "type": "VARCHAR",
            "max_length": 65535,
            "enable_analyzer": True  # 启用全文搜索分析器
        },
        {
            "name": "source",               # 源文件路径
            "type": "VARCHAR",
            "max_length": 1024
        },
        {
            "name": "heading",              # 所属标题
            "type": "VARCHAR",
            "max_length": 1024
        },
        {
            "name": "heading_level",        # 标题层级(0-6)
            "type": "INT64"
        },
        {
            "name": "start_line",          # 起始行号
            "type": "INT64"
        },
        {
            "name": "end_line"             # 结束行号
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

### 3.4 关键存储操作

```python
# 核心存储类
class MilvusStore:
    def upsert(self, chunks: list[dict]) -> int:
        """插入或更新chunk（以chunk_hash为主键）"""

    def search(self, query_embedding: list[float],
              query_text: str, top_k: int) -> list[dict]:
        """混合搜索：稠密向量 + BM25 + RRF重排序"""

    def query(self, filter_expr: str) -> list[dict]:
        """标量过滤查询"""

    def delete_by_source(self, source: str) -> None:
        """删除指定源文件的所有chunks"""

    def delete_by_hashes(self, hashes: list[str]) -> None:
        """根据内容哈希删除chunks"""
```

---

## 四、记忆检索机制

### 4.1 混合搜索 (RRF 重排序)

**双路召回 + RRF（Reciprocal Rank Fusion）重排序：**

```python
def search(self, query_embedding, query_text, top_k):
    # 稠密向量搜索（语义相似度）
    dense_req = AnnSearchRequest(
        data=[query_embedding],
        anns_field="embedding",
        param={"metric_type": "COSINE"},
        limit=top_k
    )

    # BM25全文搜索（关键词匹配）
    bm25_req = AnnSearchRequest(
        data=[query_text],
        anns_field="sparse_vector",
        param={"metric_type": "BM25"},
        limit=top_k
    )

    # RRF合并两个结果集
    results = client.hybrid_search(
        reqs=[dense_req, bm25_req],
        ranker=RRFRanker(k=60),  # k=60是RRF参数
        limit=top_k
    )
```

**RRF 公式：**
```
RRF_score(d) = Σ (k / (k + rank_i(d)))

其中：
- d = 文档
- rank_i(d) = 文档 d 在排序器 i 中的排名
- k = 常数（通常为 60）
```

### 4.2 Chunk ID 格式（兼容 OpenClaw）

```python
def compute_chunk_id(source: str, start_line: int, end_line: int,
                 content_hash: str, model: str) -> str:
    """计算复合chunk ID，匹配OpenClaw格式"""
    raw = f"markdown:{source}:{start_line}:{end_line}:{content_hash}:{model}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]
```

**ID 组成部分：**
- `markdown:` - 前缀标识文档类型
- `source` - 文件路径
- `start_line:end_line` - 行号范围
- `content_hash` - SHA-256 内容哈希（前16字符）
- `model` - 嵌入模型名称

---

## 五、记忆更新策略

### 5.1 去重机制

```python
@dataclass(frozen=True)
class Chunk:
    content: str
    source: str
    heading: str
    heading_level: int
    start_line: int
    end_line: int
    content_hash: str = field(default="", repr=False)

    def __post_init__(self):
        if not self.content_hash:
            h = hashlib.sha256(self.content.encode()).hexdigest()[:16]
            object.__setattr__(self, "content_hash", h)
```

**去重流程：**
1. 计算每个 chunk 的 SHA-256 哈希
2. 生成复合 chunk ID
3. 对比现有索引中的 ID
4. 只嵌入和存储新 chunks

### 5.2 增量索引

```python
async def _index_file(self, f: ScannedFile, *, force: bool = False):
    # 读取现有chunks的ID
    old_ids = self._store.hashes_by_source(source)

    # 计算当前文件chunks的ID
    chunk_ids = {
        compute_chunk_id(c.source, c.start_line, c.end_line,
                      c.content_hash, model)
        for c in chunks
    }

    # 删除已不在文件中的chunks
    stale = old_ids - chunk_ids
    if stale:
        self._store.delete_by_hashes(list(stale))

    if not force:
        # 只嵌入新chunks
        chunks = [
            c for c in chunks
            if compute_chunk_id(...) not in old_ids
        ]

    return await self._embed_and_store(chunks)
```

### 5.3 文件监控

```python
class FileWatcher:
    """1500ms防抖的文件监控器"""

    def __init__(self, paths, callback, debounce_ms=1500):
        self._debounce_s = debounce_ms / 1000.0
        self._timers: dict[str, threading.Timer] = {}
        self._pending: dict[str, str] = {}

    def _schedule(self, event_type: str, path: str):
        """防抖调度"""
        with self._lock:
            self._pending[path] = event_type
            if path in self._timers:
                self._timers[path].cancel()  # 取消之前的计时器
            timer = threading.Timer(self._debounce_s, self._fire, args=(path,))
            self._timers[path] = timer
            timer.start()
```

---

## 六、记忆的数据结构

### 6.1 Chunk 数据结构

```python
@dataclass(frozen=True)
class Chunk:
    """从markdown文档提取的单个chunk"""
    content: str              # chunk实际内容
    source: str               # 源文件路径
    heading: str              # 最近标题（前导部分为空）
    heading_level: int        # 0表示前导部分
    start_line: int           # 起始行号（1-based）
    end_line: int             # 结束行号
    content_hash: str         # SHA-256哈希（前16字符）
```

### 6.2 Markdown 分块策略

```python
def chunk_markdown(text: str, source: str,
                  max_chunk_size: int = 1500,
                  overlap_lines: int = 2) -> list[Chunk]:
    """按标题分割markdown，超大段落继续细分"""

    # 1. 找到所有标题位置
    heading_positions = []
    for i, line in enumerate(lines):
        match = _HEADING_RE.match(line)  # /^(#{1,6})\s+(.+)$/
        if match:
            heading_positions.append((i, len(match.group(1)), match.group(2)))

    # 2. 构建标题之间的sections
    sections = []
    for start, end, heading, level in heading_positions:
        section_text = "\n".join(lines[start:end]).strip()
        if len(section_text) <= max_chunk_size:
            sections.append((start, end, heading, level))
        else:
            # 3. 超大section在段落边界分割
            sections.extend(_split_large_section(
                lines[start:end], source, heading, level,
                start, max_size, overlap
            ))

    # 4. 创建Chunk对象
    return [Chunk(...) for start, end, heading, level in sections]
```

**分块规则：**
1. **按标题分割** - 优先在 `#` 至 `######` 标题处分块
2. **大小限制** - 超过 `max_chunk_size`（默认1500字符）的块进一步分割
3. **段落边界** - 在空行处分割，保持语义完整性
4. **重叠保留** - 携带 `overlap_lines`（默认2行）上下文

### 6.3 配置数据结构

```python
@dataclass
class MemSearchConfig:
    milvus: MilvusConfig
    embedding: EmbeddingConfig
    compact: CompactConfig
    chunking: ChunkingConfig
    watch: WatchConfig

@dataclass
class MilvusConfig:
    uri: str = "~/.memsearch/milvus.db"
    token: str = ""
    collection: str = "memsearch_chunks"

@dataclass
class EmbeddingConfig:
    provider: str = "openai"
    model: str = ""

@dataclass
class ChunkingConfig:
    max_chunk_size: int = 1500
    overlap_lines: int = 2

@dataclass
class CompactConfig:
    llm_provider: str = "openai"
    llm_model: str = ""
    prompt_file: str = ""

@dataclass
class WatchConfig:
    debounce_ms: int = 1500
```

**配置优先级（从低到高）：**
1. 内置默认值
2. 全局配置 `~/.memsearch/config.toml`
3. 项目配置 `.memsearch.toml`
4. CLI 参数

---

## 七、关键技术栈

### 7.1 嵌入提供商

| 提供商 | 安装 | 默认模型 | 维度 | API密钥 |
|--------|------|----------|------|---------|
| **OpenAI** | `memsearch` | `text-embedding-3-small` | 1536 | `OPENAI_API_KEY` |
| **Google** | `memsearch[google]` | `gemini-embedding-001` | 768 | `GOOGLE_API_KEY` |
| **Voyage** | `memsearch[voyage]` | `voyage-3-lite` | 512 | `VOYAGE_API_KEY` |
| **Ollama** | `memsearch[ollama]` | `nomic-embed-text` | 768 | 无（本地） |
| **Local** | `memsearch[local]` | `all-MiniLM-L6-v2` | 384 | 无（本地） |

### 7.2 核心依赖

```toml
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
dependencies = [
    "pymilvus[milvus_lite]>=2.5.0",  # Milvus向量数据库
    "click>=8.1",                      # CLI框架
    "watchdog>=4.0",                   # 文件监控
    "setuptools<75",                    # 依赖管理
    "tomli_w>=1.0",                    # TOML写入
    "tomli>=2.0; python_version < '3.11'",  # TOML读取
    "openai>=1.0",                     # OpenAI客户端
]

[project.optional-dependencies]
google = ["google-genai>=1.0"]
voyage = ["voyageai>=0.3"]
ollama = ["ollama>=0.4"]
local = ["sentence-transformers>=3.0"]  # 本地嵌入
anthropic = ["anthropic>=0.40"]
all = ["memsearch[google,voyage,ollama,local,anthropic]"]
```

### 7.3 用于压缩的 LLM 提供商

```python
async def compact_chunks(chunks, llm_provider="openai", model=None, prompt_template=None):
    """使用LLM压缩chunks为摘要"""

    if llm_provider == "openai":
        return await _compact_openai(prompt, model or "gpt-4o-mini")
    elif llm_provider == "anthropic":
        return await _compact_anthropic(prompt, model or "claude-sonnet-4-5-20250929")
    elif llm_provider == "gemini":
        return await _compact_gemini(prompt, model or "gemini-2.0-flash")

COMPACT_PROMPT = """
You are a knowledge compression assistant. Given the following chunks of text
from a knowledge base, create a concise but comprehensive summary that preserves
all key facts, decisions, code patterns, and actionable insights.

Chunks:
{chunks}

Write a clear, well-structured markdown summary. Use headings and bullet points.
Preserve technical details, code snippets, and specific decisions."""
```

---

## 八、记忆系统的 API 设计

### 8.1 核心类 API

```python
from memsearch import MemSearch

# 初始化
ms = MemSearch(
    paths=["./memory"],           # 要索引的路径
    embedding_provider="openai",    # 嵌入提供商
    embedding_model="text-embedding-3-small",
    milvus_uri="~/.memsearch/milvus.db",
    collection="memsearch_chunks",
    max_chunk_size=1500,
    overlap_lines=2
)

# 索引
async def index(*, force: bool = False) -> int:
    """扫描路径并索引所有markdown文件
    返回: 索引的chunk数量
    同时删除不再存在的文件的chunks
    """

async def search(query: str, *, top_k: int = 10) -> list[dict]:
    """语义搜索
    返回: 包含content, source, heading, score等字段的字典列表
    """

async def compact(*, source: str = None,
               llm_provider: str = "openai",
               llm_model: str = None,
               prompt_template: str = None,
               output_dir: str | None = None) -> str:
    """将索引的chunks压缩为摘要并追加到日常日志
    摘要追加到 memory/YYYY-MM-DD.md
    下一次 index() 或 watch() 将其作为正常markdown文件拾取
    """

def watch(*, on_event: Callable[[str, str, Path], None] = None,
           debounce_ms: int | None = None) -> FileWatcher:
    """监控配置的路径的markdown变化并自动索引
    返回: FileWatcher对象，调用 watcher.stop() 停止
    """
```

### 8.2 CLI 命令

```bash
# 索引命令
memsearch index ./memory/                          # 索引markdown文件
memsearch index ./memory/ --force                   # 强制重新索引

# 搜索命令
memsearch search "how to configure Redis"         # 语义搜索
memsearch search "query" -k 5                    # top-5结果
memsearch search "query" --json-output            # JSON格式输出

# 监控命令
memsearch watch ./memory/                          # 自动索引文件变化

# 压缩命令
memsearch compact                                  # LLM驱动的记忆压缩
memsearch compact --source "./memory/old.md"   # 只压缩特定源

# 配置命令
memsearch config init                              # 交互式配置向导
memsearch config get milvus.uri                  # 获取配置值
memsearch config set embedding.provider ollama     # 设置配置值
memsearch config list                               # 显示配置

# 统计命令
memsearch stats                                    # 显示索引统计

# 重置命令
memsearch reset --yes                              # 删除所有索引数据
```

### 8.3 Claude Code 插件集成

**四个生命周期钩子：**

```json
{
  "hooks": {
    "SessionStart": [
      {
        "type": "command",
        "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh",
        "timeout": 10
      }
    ],
    "UserPromptSubmit": [
      {
        "type": "command",
        "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks/user-prompt-submit.sh",
        "timeout": 15
      }
    ],
    "Stop": [
      {
        "type": "command",
        "async": true,
        "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks/stop.sh",
        "timeout": 120
      }
    ],
    "SessionEnd": [
      {
        "type": "command",
        "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks/session-end.sh",
        "timeout": 10
      }
    ]
  }
}
```

**渐进式披露（三层架构）：**

```
L1: 自动注入（UserPromptSubmit钩子）
───────────────────────────────────────
每个提示 → top-k搜索结果，含chunk_hash + 200字符预览

L2: 按需展开（memsearch expand）
───────────────────────────────────────
Agent运行: memsearch expand <chunk_hash>
→ 完整markdown section + session/turn锚点元数据

L3: 转录本下钻（memsearch transcript）
───────────────────────────────────────
Agent运行: memsearch transcript <jsonl_path> --turn <uuid> --context 3
→ 来自JSONL转录本的原始对话轮次
```

**锚点格式：**
```html
<!-- session:abc123 turn:def456 transcript:/path/to/session.jsonl -->
```

---

## 九、与 OpenClaw 的对比

| 特性 | OpenClaw | MemSearch |
|------|-----------|------------|
| **向量数据库** | SQLite + sqlite-vec | Milvus (Lite/Server/Cloud) |
| **混合搜索** | 加权联合 | RRF 重排序 |
| **部署模式** | 本地优先 | 可扩展到云端 |
| **Claude 集成** | 原生内置 | 插件形式 |
| **压缩机制** | 预压缩刷新 | LLM 驱动压缩 |
| **全文搜索** | FTS5 BM25 | BM25 稀疏向量 |
| **可扩展性** | 单用户设计 | 支持多租户 |

---

## 十、关键创新点

### 10.1 Markdown-First 架构

**优势：**
- 人类可读 - 可直接用文本编辑器编辑
- Git 友好 - 版本控制友好
- 零供应商锁定 - 纯文本格式
- 可移植性 - 复制目录即可迁移

### 10.2 智能去重

**SHA-256 内容哈希：**
- 相同内容只嵌入一次
- 不同位置的相同内容会产生不同 chunk ID
- 切换嵌入模型会触发重新索引

### 10.3 混合搜索

**稠密 + 稀疏向量 + RRF：**
- 语义搜索
- 关键词搜索（BM25）
- Reciprocal Rank Fusion 重排序

### 10.4 自动记忆压缩

**类似 OpenClaw 的 compact 循环：**
- 定期将旧 chunks 压缩为摘要
- 使用轻量级 LLM（Haiku）降低成本
- 压缩结果写回 markdown，自动被索引

---

## 十一、技术亮点总结

| 特性 | 实现方式 | 优势 |
|------|----------|------|
| **去重** | SHA-256 内容哈希 + 复合 chunk ID | 避免重复嵌入，节省 API 成本 |
| **增量索引** | 对比新旧 chunk ID 集合 | 只处理变化，快速同步 |
| **混合搜索** | Milvus 混合搜索 + RRF | 语义+关键词双路召回 |
| **文件监控** | Watchdog + 1500ms 防抖 | 实时同步，减少误触发 |
| **配置系统** | 4 层优先级 + TOML | 灵活配置，多环境支持 |
| **可扩展性** | 提供商协议 + 工厂模式 | 轻松添加新嵌入后端 |
| **Claude 集成** | 4 个 Shell 钩子 + CLI | 零 IPC 开销，原生集成 |
| **渐进式披露** | L1 自动 → L2 展开 → L3 转录本 | 按需深入，上下文高效 |

---

## 十二、适用场景

1. **AI 智能体记忆** - 为自主智能体提供持久化语义记忆
2. **知识库搜索** - 构建可搜索的文档/笔记系统
3. **会话历史** - 存储和检索对话历史
4. **代码辅助** - 记录项目决策和实现细节
5. **个人知识管理** - 基于 Markdown 的 PKM 系统

---

## 参考资源

- [MemSearch GitHub](https://github.com/zilliztech/memsearch)
- [Milvus 文档](https://milvus.io/docs)
- [Zilliz Cloud](https://zillizcloud.com/)
