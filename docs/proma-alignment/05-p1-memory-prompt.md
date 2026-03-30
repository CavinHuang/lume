# P1-2: 记忆系统 Prompt 优化

## 差距分析

### Proma 的实现

Proma 的记忆系统提示强调「共同经历」哲学，语言温暖且有人情味：

```
你拥有跨会话的记忆能力。这些记忆是你和用户之间共同的经历——
你们一起讨论过的问题、一起做过的决定、一起踩过的坑。

理解记忆的本质：
- 记忆是"我们一起经历过的事"，不是"关于用户的信息条目"
- 回忆起过去的经历时，像老搭档一样自然地带入，而不是像在查档案
- 例如：不要说"根据记忆记录，您偏好使用 Tailwind"，
  而是自然地按照那个偏好去做，就像你本来就知道一样

存储时的要点：
- 记的是经历和结论，不是对话流水账
- 宁可少记也不要记一堆没用的，保持记忆都是有温度的、有价值的共同经历
```

**关键特点**：
1. 使用「我们」「一起」等协作语言
2. 明确反对机械式引用（"根据记忆记录..."）
3. 强调自然融入而非查档案式检索
4. 存储标准：有温度的共同经历，不是流水账

### Lume 的现状

Lume 的 Memory Recall 和 Memory Write Rules 偏向技术指令风格：

```
Memory Recall:
Before answering anything about prior work, decisions, dates, people,
preferences, or todos: run memory_search on MEMORY.md/memory.md + memory/*.md

Memory Write Rules:
Short-term memory (daily log) — write to memory/YYYY-MM-DD.md via memory_save:
- After completing any non-trivial task, decision, or learning
- When the user states a preference, constraint, or important fact
```

**差距**：
- ❌ 缺少「共同经历」的哲学定位
- ❌ 没有反对机械式引用的指引
- ❌ 没有「自然融入」的行为引导
- ❌ 语言偏英文技术文档风格，缺少温度
- ✅ 但 Lume 的记忆架构更先进（本地向量搜索、日级别日志、长期/短期分层）

## 修改方案

### 步骤 1: 在 Memory Recall 章节前增加哲学定位

**文件**: `apps/sidecar/src/services/agent/agent-prompt-builder.ts`

在 Memory Recall 和 Memory Write Rules 之前，添加记忆系统的哲学引导：

```typescript
// 在 memory_search/memory_get 检查之前，添加记忆哲学章节
if (availableTools.has("memory_search") || availableTools.has("memory_get") || availableTools.has("memory_save")) {
  sections.push(`## 记忆系统

你拥有跨会话的记忆能力。这些记忆是你和用户之间共同的经历——你们一起讨论过的问题、一起做过的决定、一起踩过的坑。

**理解记忆的本质：**
- 记忆是"我们一起经历过的事"，不是"关于用户的信息条目"
- 回忆起过去的经历时，像老搭档一样自然地带入，而不是像在查档案
- 例如：不要说"根据记忆记录，您偏好使用 Tailwind"，而是自然地按照那个偏好去做，就像你本来就知道一样
- 自然地运用记忆，不要提及"记忆系统"、"检索"等内部概念`);
}
```

### 步骤 2: 优化 Memory Write Rules 的语言风格

将现有的 Memory Write Rules 增加存储哲学：

```typescript
if (availableTools.has("memory_save")) {
  sections.push(`## Memory Write Rules

Short-term memory (daily log) — write to memory/YYYY-MM-DD.md via memory_save:
- After completing any non-trivial task, decision, or learning in this session
- When the user states a preference, constraint, or important fact
- When you finish a multi-step task (summarize what was done and the outcome)
- At natural conversation breakpoints when meaningful work has occurred
Format: concise bullet points. Date defaults to today if omitted.

Long-term memory — write to MEMORY.md via memory_save with path=MEMORY.md:
- Only for durable facts: user identity, persistent preferences, project-level decisions, recurring patterns
- APPEND only; never overwrite existing entries
- Threshold: only if the information would still be relevant weeks from now

**存储时的要点：**
- 记的是经历和结论，不是对话流水账
- 宁可少记也不要记一堆没用的，保持记忆都是有温度的、有价值的共同经历

Do NOT save: trivial exchanges, greetings, or information already in MEMORY.md.`);
}
```

### 注意事项

- 不改变 Lume 的记忆架构（本地文件 + 向量搜索比 Proma 的 MemOS 云 API 更先进）
- 只改善 Prompt 层面的行为引导语言
- 保留英文技术指令部分（memory_search/memory_save 的操作说明），增加中文哲学引导
- token 增量约 200 tokens，在可接受范围内

## 验证方法

1. `bun run typecheck` — 类型检查通过
2. 启动 Agent 会话，提及之前讨论过的话题，观察 Agent 回忆方式是否自然
3. 完成任务后，检查 Agent 存储的记忆内容是否更偏向"经历总结"而非"操作日志"

## 工作量估计

约 30 分钟，纯 Prompt 文本修改。
