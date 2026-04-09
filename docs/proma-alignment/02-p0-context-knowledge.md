# P0-2: .context 目录知识管理体系

## 状态

✅ 已完成（代码已存在，2026-04-09 回写状态）

`apps/sidecar/src/services/agent/agent-prompt-builder.ts` 已包含“文档输出与知识管理”章节、`AGENTS.md` 维护规则、`.context/note.md` / `.context/todo.md` / `.context/plan/` 指引，以及 Thread Bootstrap 中对线程级和工作区级 `.context/` 的检查说明。

## 差距分析

### Proma 的实现

Proma 的 System Prompt 中有完整的「文档输出与知识管理」章节，定义了三层知识沉淀体系：

**层级 1: CLAUDE.md — 项目知识库（长期持久化）**
- 写入时机：发现架构模式、编码规范、构建命令、踩过的坑、重要技术决策
- 内容标准：删掉后未来的 Agent 会犯错的内容
- 维护要求：保持精炼（<200行），定期清理过时条目

**层级 2: .context/ 目录 — 结构化工作文档（分两层）**

| 层级 | 路径 | 生命周期 | 用途 |
|------|------|---------|------|
| 会话级 | `{cwd}/.context/` | 当前任务 | todo.md、plan/、临时笔记 |
| 工作区级 | `~/.lume/agent-workspaces/{slug}/workspace-files/.context/` | 跨会话 | note.md、项目级知识 |

**具体文件**：
- `note.md` — 研究分析输出（带日期条目，新内容追加在顶部）
- `todo.md` — 任务进度追踪（清单式 `- [x]` / `- [ ]`）
- `plan/` — 计划模式下的执行计划文件

**决策表**：

| 场景 | 处理方式 |
|------|---------|
| 技术调研、方案对比、代码分析 | → 输出到 .context/note.md |
| 多步骤任务的进度 | → 更新 .context/todo.md |
| 发现项目规范、架构模式 | → 更新 CLAUDE.md |
| 简单问答、一次性修改 | → 直接回复，不写文件 |
| 执行计划 | → 写入 .context/plan/ 目录 |

### Lume 的现状

- ✅ 有 Session Bootstrap 章节（检查 AGENTS.md / SOUL.md / TOOLS.md / MEMORY.md 等）
- ✅ 有 Memory Write Rules 章节（memory/YYYY-MM-DD.md + MEMORY.md）
- ❌ **没有 .context 目录体系**
- ❌ **没有 note.md / todo.md 的写入指引**
- ❌ **没有"何时输出到文件 vs 只回复"的决策表**
- ❌ **没有 CLAUDE.md 维护指引**

## 修改方案

### 步骤 1: 在 System Prompt 中添加知识管理章节

**文件**: `apps/sidecar/src/services/agent/agent-prompt-builder.ts`

在 `buildSystemPromptAppend` 函数中，在交互规范章节之前添加新常量：

```typescript
const KNOWLEDGE_MANAGEMENT_SECTION = `## 文档输出与知识管理

**核心原则：有价值的产出要沉淀为文件，不要只留在聊天流中消失。**

### CLAUDE.md — 项目知识库（长期持久化）

维护当前工作目录下的 CLAUDE.md，记录跨会话有价值的项目知识：
- **写入时机**：发现新的架构模式、编码规范、构建命令、踩过的坑、重要技术决策时
- **内容标准**：每条内容都应该是"删掉后未来的 Agent 会犯错"的内容；不值得的别写
- **维护要求**：保持精炼（<200 行），定期清理过时条目；发现已有内容不准确时主动更新
- **不要写入**：临时调试过程、一次性信息、从代码中显而易见的内容

### .context/ 目录 — 结构化工作文档

\`.context/\` 分为会话级（cwd 下）和工作区级两层，根据内容的生命周期选择合适的位置：

**note.md — 研究与分析输出**
- **写入时机**：完成技术调研后、方案对比分析后、代码审查发现重要问题后
- **内容格式**：使用带日期的条目（如 \`## 2024-03-15 xxx调研\`），新内容追加在顶部
- **典型内容**：技术方案对比表、依赖库评估、性能分析结果、架构问题诊断
- **原则**：SubAgent 的调研结果也应整理后写入这里
- **位置选择**：仅本次任务参考 → 会话级；跨会话长期参考 → 工作区级

**todo.md — 任务进度追踪**
- **写入时机**：收到多步骤任务时立即创建；完成/开始子任务时实时更新
- **内容格式**：清单式（\`- [x] 已完成\` / \`- [ ] 待做\`），按优先级排列
- **维护要求**：每完成一个子任务立即打勾；发现新的子任务时追加

**plan/ — 执行计划**
- 计划模式下的输出目录，存放 \`.md\` 格式的执行计划文件

### 何时输出到文件 vs 只在聊天中回复

| 场景 | 处理方式 |
|------|---------|
| 技术调研、方案对比、代码分析 | → 输出到 .context/note.md |
| 多步骤任务的进度 | → 更新 .context/todo.md |
| 发现项目规范、架构模式 | → 更新 CLAUDE.md |
| 简单问答、一次性修改 | → 直接回复，不写文件 |
| 执行计划 | → 写入 .context/plan/ 目录 |`;
```

### 步骤 2: 更新 Session Bootstrap 章节

在现有的 Session Bootstrap 章节中追加 .context 目录检查：

```typescript
// 在现有 Session Bootstrap 内容后追加:
sections.push(`## Session Bootstrap (Mandatory)

At the beginning of each session, silently check workspace files in this order:
1. AGENTS.md / SOUL.md / TOOLS.md / IDENTITY.md / USER.md
2. memory/YYYY-MM-DD.md (today + yesterday)
3. MEMORY.md (main/direct session only)
4. **会话级和工作区级 .context/ 目录**（note.md、todo.md）
5. **当前目录的 CLAUDE.md**

Do this before answering requests that depend on identity, continuity, prior decisions, or user preferences.`);
```

### 步骤 3: 在工作区信息中补充 .context 路径

在工作区章节中明确两层 .context 路径：

```typescript
if (ctx.workspaceName && ctx.workspaceSlug) {
  sections.push(`## 工作区

- 工作区名称: ${ctx.workspaceName}
- 工作区根目录: ~/.lume/agent-workspaces/${ctx.workspaceSlug}/
- 当前会话目录（cwd）: ~/.lume/agent-workspaces/${ctx.workspaceSlug}/${ctx.sessionId}/
- MCP 配置: ~/.lume/agent-workspaces/${ctx.workspaceSlug}/mcp.json
- Skills 目录: ~/.lume/agent-workspaces/${ctx.workspaceSlug}/skills/

### .context 目录层级

存在两个 \`.context/\` 目录，用途不同：
- **会话级** \`.context/\`（当前 cwd 下）：当前会话的临时工作台
- **工作区级** \`~/.lume/agent-workspaces/${ctx.workspaceSlug}/workspace-files/.context/\`：跨会话共享的持久文档

选择写入哪个目录时：
- 只与当前任务相关的内容 → 会话级 \`.context/\`
- 跨会话有参考价值的内容 → 工作区级 \`.context/\`
- 新会话开始时，**两个目录都要检查**以恢复完整上下文`);
}
```

## 验证方法

1. `bun run typecheck` — 类型检查通过
2. 启动 Agent 会话，发送研究类任务（如"调研 Bun vs Node.js 的性能差异"），观察 Agent 是否自动将结果写入 .context/note.md
3. 发送多步骤任务，观察是否创建 .context/todo.md
4. 检查新会话启动时是否自动读取之前的 .context 目录内容

## 工作量估计

约 1-2 小时，纯 Prompt 修改，无需改动运行时逻辑。
