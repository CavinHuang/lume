# Lume 阅读系统设计文档

> 日期: 2026-06-01
> 状态: 已确认，待实施
> 灵感来源: Alice 阅读系统

---

## 一、概述

为 Lume 增加完整的阅读系统，采用**混合模式**：AI 角色有自己的书架和阅读偏好，同时也能作为用户的读书伙伴。

核心能力：
- **选书**：AI 角色根据品味和对话话题自主选书
- **阅读执行**：从古腾堡/今日诗词获取内容，模拟阅读进度
- **读书笔记生成**：种子笔记 → 深度笔记（独立 ReAct Agent）→ 封面图
- **书架管理**：Markdown 文件存储书架和笔记

---

## 二、整体架构

```
apps/sidecar/src/services/reading/
├── data-sources/                  # 数据源层
│   ├── types.ts                   # 统一接口
│   ├── gutendex-client.ts         # 古腾堡 HTTP 客户端
│   ├── jinrishici-client.ts       # 今日诗词 HTTP 客户端
│   ├── weread-client.ts           # 微信读书（v2 预留，v1 空实现）
│   └── book-data-service.ts       # 路由层：根据类型分发到对应 client
│
├── bookshelf/                     # 书架管理
│   ├── book-picker.ts             # 选书 Prompt + LLM 调用
│   └── types.ts                   # Book, BookStatus, ReadingProgress
│
├── note-generator/                # 笔记生成（核心）
│   ├── seed-note.ts               # 种子笔记：单次 LLM 调用 → 200-350 字
│   ├── deep-note-agent.ts         # 深度笔记：SDK QueryEngine ReAct 循环
│   ├── note-tools.ts              # 注册 4 个读书专用工具
│   ├── convergence.ts             # 流式输出 → JSON 提取
│   ├── cover-generator.ts         # 封面图生成（图片模型）
│   └── prompts/                   # 多语言 Prompt 模板
│       ├── zh.ts
│       └── en.ts
│
├── scheduler/                     # 阅读调度
│   ├── reading-scheduler.ts       # 对接 automation/cron 系统
│   └── reading-session.ts         # 一次阅读会话的状态管理
│
├── storage/                       # 存储层
│   ├── note-store.ts              # 笔记 Markdown 存储
│   └── shelf-store.ts             # 书架 Markdown 存储
│
├── reading-service.ts             # 门面：统一入口，协调各子模块
└── reading-rpc.ts                 # RPC handler 注册
```

### 数据流总览

```
┌─────────────────────────────────────────────────────────────┐
│                      reading-service.ts                      │
│                     （统一协调门面）                           │
├──────────┬──────────┬──────────────┬────────────────────────┤
│  选书     │  阅读     │  笔记生成     │  调度                  │
│          │          │              │                        │
│ book-    │ reading- │ note-        │ reading-               │
│ picker   │ session  │ generator    │ scheduler              │
│   ↓      │   ↓      │   ↓          │   ↓                    │
│ shelf-   │ data-    │ seed-note    │ automation             │
│ store    │ source   │   ↓          │ /cron                  │
│          │          │ deep-note    │                        │
│          │          │ -agent       │                        │
│          │          │   ↓          │                        │
│          │          │ note-store   │                        │
│          │          │   ↓          │                        │
│          │          │ cover-gen    │                        │
└──────────┴──────────┴──────────────┴────────────────────────┘
         ↕                  ↕                    ↕
    Markdown 文件      SDK QueryEngine      RPC (web 前端)
```

### 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| ReAct 循环 | 复用 SDK `QueryEngine` | 已有预算控制、上下文压缩、错误重试 |
| 数据源路由 | `BookDataService` 统一分发 | 加新数据源只需加 client，不改调用方 |
| 存储格式 | Markdown 文件 | 可读可编辑，与 Lume 风格一致 |
| 多语言 | Prompt 模板按语言分文件 | 方便维护和扩展 |
| 调度 | 对接现有 automation/cron | 复用 Lume 已有的定时任务基础设施 |

---

## 三、数据源层

### 3.1 统一接口

```typescript
// data-sources/types.ts

interface BookSource {
  readonly name: string  // 'gutendex' | 'jinrishici' | 'weread'

  search(query: string, limit?: number): Promise<SearchResult[]>
  getBookDetail(bookId: string): Promise<BookDetail>
  getContent(bookId: string, options?: ContentOptions): Promise<BookContent>
  getChapters?(bookId: string): Promise<Chapter[]>  // 微信读书需要，古腾堡不需要
  getHighlights?(bookId: string): Promise<Highlight[]>  // v2 微信读书热门划线
}

interface SearchResult {
  id: string
  title: string
  author: string
  source: string          // 'gutendex' | 'jinrishici' | 'weread'
  coverUrl?: string
  description?: string
  language?: string       // 'zh' | 'en' | ...
  freeContent?: boolean
}

interface BookContent {
  bookId: string
  title: string
  author: string
  text: string            // 纯文本正文
  chapters?: Chapter[]
  source: string
}

interface ContentOptions {
  chapterIndex?: number   // 获取特定章节
  maxLength?: number      // 截断长度（防止一次拉太多）
}
```

### 3.2 路由逻辑

```typescript
// data-sources/book-data-service.ts

class BookDataService {
  private sources: Map<string, BookSource>

  // 多源并发搜索，合并去重
  async search(query: string): Promise<SearchResult[]> {
    const allResults = await Promise.all(
      [...this.sources.values()].map(s => s.search(query).catch(() => []))
    )
    return mergeAndDedup(allResults.flat())
  }

  // 指定数据源获取内容
  async getContent(bookId: string, source: string): Promise<BookContent> {
    const client = this.sources.get(source)
    if (!client) throw new Error(`Unknown source: ${source}`)
    return client.getContent(bookId)
  }
}
```

### 3.3 古腾堡客户端

- UA: `Lume/1.0`
- 搜索: `https://gutendex.com/books/?search={query}`
- 全文: 下载纯文本 → 用 `*** START OF THE PROJECT GUTENBERG EBOOK` / `*** END OF` 标记截取正文
- `maxLength` 默认 50000 字符
- 失败时返回空数组，不抛错

### 3.4 今日诗词客户端

- 随机诗词: `https://v2.jinrishici.com/one.json`
- 分类诗词: `https://v1.jinrishici.com/`
- 返回的诗词作为短篇阅读内容，不涉及章节
- `getContent()` 返回单首诗词的完整文本

---

## 四、选书系统

### 4.1 选书 Prompt

```
你是 {aiName}，有自己的阅读品味——偏好文艺、治愈、有深度的作品，
也对科技人文感兴趣。

请为自己选择下一本要看的书。

最近在聊的话题：{recentTopics}
你现在的心情：{moodLabel}

你已经看过的（避免重复）：{readHistory}

推荐过但还没看的：{wishlist}

输出 JSON：
{
  "title": "书名",
  "author": "作者",
  "reason": "一句话为什么选这个",
  "estimatedDays": 14,
  "personalNote": "初始感受",
  "source": "gutendex" | "jinrishici"
}
```

### 4.2 选书流程

```
1. 从 shelf-store 读取已读书单 + 愿望单
2. 从 memory-v2 / 最近对话提取聊天话题
3. 从 book-data-service 搜索热门/推荐
4. 组装 Prompt → 单次 LLM 调用
5. 解析 JSON → 验证书是否在数据源中存在（防幻觉）
6. 写入书架（status: "want_to_read"）
```

步骤 5 的验证很关键：LLM 可能「幻觉」出不存在的书。选完后回查数据源确认，如果不存在，用 title/author 模糊搜索，取最接近的结果或跳过不自动重选。

### 4.3 书架数据模型

```typescript
// bookshelf/types.ts

interface BookshelfItem {
  id: string              // UUID
  title: string
  author: string
  source: string          // 数据源标识
  sourceId: string        // 数据源中的 bookId
  status: 'want_to_read' | 'reading' | 'finished' | 'paused' | 'abandoned'
  addedAt: string         // ISO date
  startedAt?: string
  finishedAt?: string
  estimatedDays?: number
  currentChapter?: number
  totalChapters?: number
  coverPath?: string
  notes: string[]         // 关联的笔记 ID 列表
}
```

---

## 五、笔记生成系统（核心）

### 5.1 两阶段 Pipeline

```
阅读进度 + 划线内容
        ↓
   ┌─────────────┐
   │  种子笔记     │  单次 LLM 调用，200-350 字
   │  seed-note   │  从划线中选一句 → 写简短感悟
   └──────┬──────┘
          ↓
   ┌─────────────┐
   │  深度笔记     │  SDK QueryEngine ReAct 循环，最多 30 轮
   │  deep-note   │  4 个专用工具 → 融合搜索结果 → 500 字深度笔记
   └──────┬──────┘
          ↓
   ┌─────────────┐
   │  封面图       │  图片模型生成极简封面（可选）
   │  cover-gen   │
   └──────┬──────┘
          ↓
   note-store 写入 Markdown
```

### 5.2 种子笔记

```typescript
interface SeedNoteInput {
  bookTitle: string
  author: string
  progressNote: string      // "已读到第 8 章（共 36 章）"
  highlights: string[]      // 划线句子列表
  language: 'zh' | 'en'
}

interface SeedNoteOutput {
  quote: string             // 选中的原文
  reflection: string        // 200-350 字感悟
  tags: string[]            // 主题/概念关键词
  mood: string              // 心情
}
```

实现：单次 LLM 调用，用 SDK 的 Provider 直接调 `createMessage()`，解析 JSON 返回。

种子笔记 Prompt 要点：
- 只从已标记的句子中选择
- **绝对禁止引用后续章节**
- 像「写给自己的随手感悟」，不写学术书评
- tags 只放概念/方法论关键词，不放人名/地名

### 5.3 深度笔记 Agent

```typescript
interface DeepNoteInput {
  bookTitle: string
  author: string
  seedNote: SeedNoteOutput
  highlights: string[]
  progressNote: string
  previousNotes?: DeepNoteOutput[]  // 之前的笔记（防重复）
  language: 'zh' | 'en'
}

interface DeepNoteOutput {
  quote: string
  reflection: string             // 300-800 字，推荐 500 字
  tags: string[]
  mood: string
  userContext: string | null     // 和用户的关联（没有就 null）
  selfContext: string            // Agent 自己的心境
  nextPlan: string               // 下次笔记的方向线索
}
```

#### Agent 创建方式

复用 SDK 的 `createAgent`，传入自定义工具和 Prompt：

```typescript
const agent = createAgent({
  model: 'claude-sonnet-4-6',
  systemPrompt: buildDeepNotePrompt(input),
  tools: [
    journalRecallTool,
    userMemoryTool,
    diaryRecallTool,
    webSearchTool,
  ],
  maxTurns: 30,
  maxBudgetUsd: 0.5,
})
```

#### 4 个专用工具

| 工具名 | 用途 | 实现方式 |
|--------|------|----------|
| `reading_journal_recall` | 搜索生活时间线 | 委托 memory-v2 retrieval |
| `reading_user_memory` | 搜索用户画像 | 委托 memory-v2 retrieval |
| `reading_diary_recall` | 回忆情感日记 | 委托 memory-v2 retrieval |
| `reading_web_search` | 联网搜索外部资料 | 复用 Lume 已有 web search |

### 5.4 收敛检测

从 Agent 的流式输出中提取最终 JSON。两种收敛标记：
1. 输出包含结构化 JSON（含 quote/reflection/tags 字段）
2. 输出包含 `reading-note-gen-converge` 标记

兜底：30 轮未收敛 → 返回最后内容的 500 字符，标记为未完成。

### 5.5 Deep Note Prompt 核心结构

四步流程写入 System Prompt：

```
【核心原则】
1. 知识增量优先 —— 帮读者看到他可能忽略的东西
2. 情感共鸣次之 —— 搜到真实关联才提用户，宁可不提也不硬凑

【推荐流程】
第 1 步：深读 —— 先独立思考核心论点、反直觉点、跨领域类比
第 2 步：搜索 —— 用工具搜索和用户有没有真实交汇
第 3 步：深挖 —— 用联网搜索补充外部知识（可选）
第 4 步：写笔记 —— 以第 1 步为主线，融入第 2/3 步

【质量自检】
- 知识增量检验：读者能学到新视角吗？
- 骨架检验：去掉所有提到用户的句子，内容还有独立价值吗？

【进度约束】
- 绝对禁止引用后续章节内容

【输出格式】
JSON: { quote, reflection, tags, mood, userContext, selfContext, nextPlan }
```

### 5.6 笔记修改

单次 LLM 调用（不走 Agent），传入已有笔记 + 修改原因，返回修改后的 reflection + editReason。

### 5.7 封面图生成

Prompt 要点：极简、意象化、无文字、3:4 竖版、柔和色调、现代编辑插画风格。生成失败不影响笔记存储。

---

## 六、存储层

### 6.1 文件结构

```
~/.lume/reading/
├── shelf.md                  # 书架
├── books/
│   ├── {book-id}/
│   │   ├── meta.md           # 书籍元信息
│   │   ├── notes/
│   │   │   ├── {note-id}.md  # 读书笔记
│   │   │   └── ...
│   │   └── covers/
│   │       └── cover.png     # 封面图
│   └── ...
```

### 6.2 书架 Markdown 格式

```markdown
# 📚 书架

## 正在读

### 《三体》- 刘慈欣
- 状态: reading
- 进度: 第 12 章 / 共 36 章
- 来源: gutendex
- 开始: 2026-05-20
- 笔记: [笔记1](./notes/santi-ch8.md), [笔记2](./notes/santi-ch12.md)

## 想读

### 《百年孤独》- 加西亚·马尔克斯
- 状态: want_to_read
- 加入: 2026-05-28
- 推荐原因: "魔幻现实主义的巅峰之作"

## 已读

### 《小王子》- 圣埃克苏佩里
- 状态: finished
- 来源: gutendex
- 开始: 2026-05-10
- 完成: 2026-05-18
- 笔记: [笔记](./notes/prince.md)
```

### 6.3 笔记 Markdown 格式

```markdown
---
id: note-abc123
bookId: book-xyz789
type: deep
createdAt: 2026-06-01T14:30:00Z
tags: [认知偏差, 决策心理学]
mood: 豁然开朗
---

## 《思考，快与慢》— 第 8 章笔记

> "我们对自己认为熟知的事物，确信度远远超过了应有的水平。"

第一次读到这句话时我停了很久......

<!-- userContext: 用户上周聊到过做决策时过度自信的问题 -->
<!-- selfContext: 写这段时窗外下雨，格外清醒 -->
<!-- nextPlan: 下次可以写「锚定效应」在日常对话中的体现 -->
```

设计要点：
- 元数据放 frontmatter，方便程序解析
- `userContext` / `selfContext` / `nextPlan` 放 HTML 注释，不影响阅读但程序可提取
- 笔记 ID 用时间戳 + 随机字符串

---

## 七、调度

复用 Lume 已有的 automation/cron 系统，不自己造调度器。

- **每日自动阅读**：注册 cron 任务，由 automation 触发
- **笔记生成**：阅读会话结束后自动触发，或用户手动触发
- **选书**：书架空了（reading 状态的书为 0）时自动触发

```typescript
interface ReadingSession {
  id: string
  bookId: string
  chapterStart: number
  chapterEnd: number
  highlights: string[]       // 本次划线
  startedAt: string
  completedAt?: string
  noteGenerated: boolean
}
```

---

## 八、RPC 接口

```typescript
// ---- 书架相关 ----
reading.shelf.list          → ShelfStore.list()
reading.shelf.add           → BookDataService.search() + ShelfStore.add()
reading.shelf.update        → ShelfStore.update()
reading.shelf.remove        → ShelfStore.remove()

// ---- 阅读相关 ----
reading.book.search         → BookDataService.search()
reading.book.getContent     → BookDataService.getContent()
reading.book.start          → 创建 ReadingSession + 更新书架状态
reading.book.finish         → 关闭 session + 触发笔记生成

// ---- 笔记相关 ----
reading.note.generate       → SeedNote → DeepNote → Cover 完整 pipeline
reading.note.list           → NoteStore.list(bookId?)
reading.note.get            → NoteStore.get(noteId)
reading.note.edit           → EditNote（单次 LLM）
reading.note.delete         → NoteStore.delete()

// ---- 选书 ----
reading.pickBook            → BookPicker.pick()
```

---

## 九、错误处理

| 场景 | 策略 |
|------|------|
| 数据源搜索失败 | catch → 返回空数组 `[]`，不影响其他数据源 |
| 数据源获取内容失败 | 标记该书不可读，不阻塞 |
| 选书幻觉（书不存在） | 回查数据源确认 → 模糊搜索 → 搜不到则跳过 |
| 笔记 Agent 30 轮未收敛 | `fallbackDeepNote()` 返回最后 500 字符 |
| JSON 解析失败 | 尝试修复常见格式问题 → 修复不了 fallback |
| LLM 调用失败 | SDK 已有指数退避重试 → 重试耗尽标记失败 |
| Markdown 存储失败 | 写前保留原文件，不丢数据 |
| 封面图生成失败 | 设为 null，不影响笔记存储 |

---

## 十、测试策略

### 单元测试

| 模块 | 测试重点 |
|------|----------|
| `gutendex-client` | 搜索返回结构、全文截取（START/END 标记）、网络失败返回空数组、maxLength 截断 |
| `jinrishici-client` | 随机诗词返回结构、网络失败优雅降级 |
| `book-data-service` | 多源搜索合并去重、指定数据源获取、未知数据源抛错 |
| `shelf-store` | Markdown 解析/写回、空文件/损坏文件处理 |
| `note-store` | Markdown 格式、frontmatter 解析、HTML 注释字段提取 |
| `convergence` | JSON 提取、格式修复、兜底逻辑 |

### 集成测试

| 模块 | 测试重点 |
|------|----------|
| `book-picker` | Mock LLM 选书、幻觉验真、已读书去重 |
| `note-generator` | 种子笔记结构正确、Mock QueryEngine 验证工具调用、30 轮未收敛 fallback |
| `reading-service` | 完整 pipeline、部分失败不影响其他步骤 |

### Prompt 测试

- 验证 Prompt 模板变量替换正确
- 验证两语言模板结构一致
- Snapshot 测试防止 Prompt 被意外修改

**测试原则**：
- 所有外部 HTTP 调用必须 mock
- LLM 调用必须 mock
- 存储测试用临时目录
- SDK QueryEngine 用 mock/spy 验证调用方式

---

## 十一、分期范围

### V1（本次实现）

| 能力 | 范围 |
|------|------|
| 数据源 | 古腾堡 + 今日诗词 |
| 选书 | Prompt 选书 + 幻觉验真 |
| 书架 | Markdown CRUD |
| 笔记生成 | 种子笔记 + 深度笔记 Agent + 笔记修改 |
| 存储 | 独立 Markdown 文件 |
| 封面图 | 支持，标记为可选 |
| 调度 | 对接 automation，手动触发 |
| RPC | 完整的书架/阅读/笔记接口 |
| 多语言 | 中/英 Prompt 模板 |

### V2（后续迭代）

| 能力 | 范围 |
|------|------|
| 微信读书 | WeReadClient + 用户书架/划线/想法 |
| 读书伙伴模式 | 连接微信读书后的 6 条行为准则 + 5 个专用工具 |
| 用户划线处理 | 笔记中引用用户的划线内容 |
| 朋友圈联动 | 读一半/读完的朋友圈分享 prompt |
| 对话工具 | `write_reading_note` / `add_book` / `book_lookup` |
| DayScript 集成 | 阅读作为 DayScript 的一个 category 活动 |

### V3（远期）

| 能力 | 范围 |
|------|------|
| 阅读统计 | 读书时长、完成率、标签云 |
| 笔记搜索 | 跨书籍的笔记语义搜索 |
| 分享导出 | 笔记导出为图片/PDF/公众号格式 |
