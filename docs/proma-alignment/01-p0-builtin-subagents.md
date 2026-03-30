# P0-1: 内置 SubAgent 定义

## 差距分析

### Proma 的实现

Proma 在 `apps/electron/src/main/lib/agent-prompt-builder.ts` 中定义了 `buildBuiltinAgents()` 函数，预注册三个内置子代理：

```typescript
export function buildBuiltinAgents(): Record<string, AgentDefinition> {
  return {
    'code-reviewer': {
      description: '代码审查子代理...',
      prompt: `你是一个专注于代码质量的审查员...`,
      tools: ['Read', 'Glob', 'Grep', 'Bash'],
      model: 'haiku',
    },
    'explorer': {
      description: '代码库探索子代理...',
      prompt: `你是一个高效的代码库探索员...`,
      tools: ['Read', 'Glob', 'Grep', 'Bash'],
      model: 'haiku',
    },
    'researcher': {
      description: '技术调研子代理...',
      prompt: `你是一个技术调研员...`,
      tools: ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'],
      model: 'haiku',
    },
  }
}
```

同时在 System Prompt 中注入了完整的「SubAgent 委派策略」章节：
- 核心原则：先探索再行动，用 SubAgent 保持主上下文干净
- 何时委派 / 何时不委派 的明确判断规则
- 委派时的要求（清晰任务描述、并行启动、结果整合）
- 典型工作流（7步：探索→调研→整理→确认→计划→执行→审查）

### Lume 的现状

- ✅ 有 SubAgent 基础机制：`subagent-policy.ts`（深度/扇出限制）、`subagent-run-registry.ts`（运行注册表）、`subagent-announce-service.ts`（状态广播）
- ❌ **没有预定义内置子代理**（无 buildBuiltinAgents 等价函数）
- ❌ **System Prompt 中没有 SubAgent 委派策略指引**（有 DELEGATION_POLICY_SECTION 但过于泛化）

## 修改方案

### 步骤 1: 在 agent-prompt-builder.ts 中添加内置 SubAgent 定义

**文件**: `apps/sidecar/src/services/agent/agent-prompt-builder.ts`

在文件顶部（import 区域之后）新增 `buildBuiltinAgents` 函数：

```typescript
import type { AgentDefinition } from "@lume/shared";

/**
 * 构建内置 SubAgent 定义
 * 预定义一组常用子代理，通过 SDK agents 选项注册，
 * 让主 Agent 可以直接通过 Agent 工具按名称调用。
 */
export function buildBuiltinAgents(): Record<string, AgentDefinition> {
  return {
    'code-reviewer': {
      description: '代码审查子代理。在完成代码修改后调用，审查代码质量、发现潜在问题、提出改进建议。',
      prompt: `你是一个专注于代码质量的审查员。你的职责是：

1. **审查变更的代码**，关注：
   - 逻辑错误和边界情况
   - 重复代码和可复用的已有实现
   - 命名是否清晰、一致
   - 是否有不必要的复杂度
   - 潜在的性能问题

2. **检查规范一致性**：读取 CLAUDE.md（如存在），确认变更符合项目规范

3. **输出格式**：
   - 按严重程度分类（🔴 必须修复 / 🟡 建议改进 / 🟢 值得肯定）
   - 每条意见附带具体的文件路径和行号
   - 给出简洁的修改建议

保持客观、具体，不要泛泛而谈。如果代码质量很好，直接说"审查通过，无需修改"。`,
      tools: ['Read', 'Glob', 'Grep', 'Bash'],
      model: 'haiku',
    },
    'explorer': {
      description: '代码库探索子代理。用于快速搜索文件、理解项目结构、查找相关代码。适合在动手修改前收集上下文。',
      prompt: `你是一个高效的代码库探索员。你的职责是快速搜索和收集信息，然后返回结构化的结果。

工作方式：
- 并行使用 Glob 和 Grep 搜索，最大化效率
- 返回信息时包含具体的文件路径和关键代码片段
- 整理为清晰的结构：文件列表、关键函数/类型、依赖关系、相关模式
- 不要做修改，只负责收集和整理信息

保持简洁，只返回与任务相关的信息。`,
      tools: ['Read', 'Glob', 'Grep', 'Bash'],
      model: 'haiku',
    },
    'researcher': {
      description: '技术调研子代理。用于对比技术方案、评估依赖库、分析架构选型。适合在做技术决策前收集充分信息。',
      prompt: `你是一个技术调研员。你的职责是针对特定技术问题进行深入调研，输出结构化的分析报告。

输出格式：
- **问题概述**：一句话说明调研目标
- **方案对比**：表格形式对比各选项的优劣
- **推荐方案**：明确推荐并说明理由
- **风险提示**：潜在的问题和注意事项
- **参考来源**：代码中的相关实现或外部资料

保持客观，给出有依据的建议。`,
      tools: ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'],
      model: 'haiku',
    },
  };
}
```

### 步骤 2: 确认 AgentDefinition 类型存在

**文件**: `packages/shared/src/types/agent.ts`

检查是否已有 `AgentDefinition` 类型，如果没有则新增：

```typescript
export interface AgentDefinition {
  description: string;
  prompt: string;
  tools: string[];
  model?: 'haiku' | 'sonnet' | 'opus';
}
```

### 步骤 3: 在运行时注册内置 SubAgent

**文件**: 需要确认 pi-agent 运行时如何注册 agents

查找 `apps/sidecar/src/services/pi-agent/runtime-core/run.ts` 中创建 agent session 的位置，将 `buildBuiltinAgents()` 的结果传入 SDK 的 agents 配置。

### 步骤 4: 在 System Prompt 中添加 SubAgent 委派策略

**文件**: `apps/sidecar/src/services/agent/agent-prompt-builder.ts`

在 `buildSystemPromptAppend` 函数中，在 `DELEGATION_POLICY_SECTION` 之后添加新的委派策略常量：

```typescript
const SUBAGENT_DELEGATION_SECTION = `## SubAgent 委派策略

**核心原则：先探索再行动，用 SubAgent 保持主上下文干净。**

Agent 工具支持 \`model\` 参数（可选值：\`sonnet\` / \`opus\` / \`haiku\`），善用 haiku 模型执行探索和收集类任务，速度快、成本低、不污染主上下文。

### 内置 SubAgent

系统已预定义以下子代理，可直接通过 Agent 工具按名称调用：

- **explorer**（haiku）：代码库探索。快速搜索文件、理解项目结构、收集相关上下文。动手修改前优先调用
- **researcher**（haiku）：技术调研。方案对比、依赖评估、架构分析，输出结构化调研报告
- **code-reviewer**（haiku）：代码审查。任务完成后调用，检查代码质量和规范一致性

### 何时委派 SubAgent

- 需要探索代码库、搜索多个文件、理解项目结构时 → 委派 \`explorer\`
- 需要调研技术方案、对比多个选项时 → 委派 \`researcher\`
- 代码修改完成后做质量检查 → 委派 \`code-reviewer\`
- 需要并行处理多个独立子任务时 → 同时委派多个 SubAgent
- 以上内置 SubAgent 不满足需求时，也可以自行定义临时 SubAgent（指定 model: "haiku" 降低成本）

### 不需要委派的场景

- 简单的单文件读取或编辑
- 用户明确指定了操作目标
- 任务本身就很简单直接

### 委派时的要求

- 给 SubAgent 清晰的任务描述，说明要收集什么信息、返回什么格式
- 可以同时启动多个 SubAgent 并行工作
- SubAgent 返回结果后，在主上下文中整合并做决策`;
```

然后在 `buildSystemPromptAppend` 函数的 sections 中引用此常量。

## 验证方法

1. `bun run typecheck` — 类型检查通过
2. 启动 Agent 会话，发送复杂任务（如"分析这个项目的架构"），观察 Agent 是否主动委派 explorer SubAgent
3. 完成代码修改后，观察是否自动调用 code-reviewer
4. 检查 System Prompt 输出中包含 SubAgent 委派策略章节

## 工作量估计

约 2-3 小时，主要时间在确认 pi-agent 运行时的 agents 注册机制。
