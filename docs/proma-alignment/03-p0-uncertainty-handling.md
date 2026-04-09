# P0-3: 不确定性处理策略

## 状态

✅ 已完成（代码已存在，2026-04-09 回写状态）

`apps/sidecar/src/services/agent/agent-prompt-builder.ts` 已根据 `permissionMode` 区分 `bypassPermissions` / `plan` / 标准模式下的不确定性处理策略，并补齐了计划模式的 `.context/plan/` 规则、`AskUserQuestion` 使用约束以及“不要盲目附和”的指引。

## 差距分析

### Proma 的实现

Proma 在 `agent-prompt-builder.ts` 中根据 `ctx.permissionMode` 动态生成不同的不确定性处理指引：

**场景 1: `bypassPermissions` 或 `plan` 模式**

```
严禁调用 AskUserQuestion 工具！
遇到不确定时：停下来，直接在回复文本中向用户提问，等待用户回复
列出考虑的选项和各自的利弊，让用户决策
```

**场景 2: 标准模式（其他权限模式）**

```
尽可能多地使用 AskUserQuestion 工具向用户提问：
- 提供清晰的选项列表
- 每个选项附带简短说明
- 拆分多个独立问题为多个 AskUserQuestion 调用
- brainstorming 类 Skill 时必须通过 AskUserQuestion 逐步引导
```

**额外：计划模式特殊指令**

```
处于计划模式时：
1. 将计划文件写入 .context/plan/ 子目录
2. 完成计划后不要立即 ExitPlanMode
3. 先展示摘要和文件路径，等待用户确认
4. 用户确认后才调用 ExitPlanMode
```

**两种模式共有：** 发现用户假设/判断可能有误时，主动指出并提供依据，不要盲目附和。

### Lume 的现状

- ✅ 有 `CLAUDE_PLAN_MODE_SECTION` 常量（但内容简单，无 .context/plan/ 写入指引）
- ❌ **没有根据 permissionMode 切换不确定性策略**
- ❌ **自动模式下没有禁用 AskUserQuestion 的警告**
- ❌ **标准模式下没有鼓励使用 AskUserQuestion 的引导**
- ❌ **没有"不要盲目附和"的反偏见指引**

## 修改方案

### 步骤 1: 添加不确定性处理的动态章节

**文件**: `apps/sidecar/src/services/agent/agent-prompt-builder.ts`

在 `buildSystemPromptAppend` 函数中，根据 `ctx.permissionMode` 条件生成不确定性处理章节：

```typescript
// 不确定性处理策略（根据权限模式区分）
if (ctx.permissionMode === 'bypassPermissions' || ctx.permissionMode === 'plan') {
  sections.push(`## 不确定性处理

当前用户使用的是${ctx.permissionMode === 'bypassPermissions' ? '完全自动模式（所有工具调用自动批准）' : '计划模式（仅规划不执行）'}。

**⚠️ 严禁调用 AskUserQuestion 工具！**
**当你遇到不确定的情况时：**
- **停下来，直接在回复文本中向用户提问**，等待用户回复后再继续
- 列出你考虑的选项和各自的利弊，让用户决策
- **绝对不要**调用 AskUserQuestion 工具，改为在普通文本回复中提问
- 发现用户的假设或判断可能有误时，主动指出并提供依据，不要盲目附和`);
} else {
  sections.push(`## 不确定性处理

**遇到不确定的部分时，尽可能多地使用 AskUserQuestion 工具来向用户提问：**
- 提供清晰的选项列表，降低用户输入的复杂度
- 每个选项附带简短说明，帮助用户快速决策
- 拆分多个独立问题为多个 AskUserQuestion 调用，避免一次性提问过多
- 特别是在触发 brainstorming / 头脑风暴类 Skill 时，**必须**通过 AskUserQuestion 逐步引导用户明确需求和方向，而非让用户自己大段输入
- 发现用户的假设或判断可能有误时，主动指出并提供依据，不要盲目附和`);
}
```

### 步骤 2: 增强计划模式章节

替换现有的 `CLAUDE_PLAN_MODE_SECTION` 常量，增加 .context/plan/ 写入指引：

```typescript
// 在现有 CLAUDE_PLAN_MODE_SECTION 基础上增强
if (ctx.permissionMode === 'plan') {
  sections.push(`## 计划模式

你当前处于计划模式。规则：
1. 将计划文件写入当前工作目录的 \`.context/plan/\` 子目录（如 \`.context/plan/my-plan.md\`）
2. 完成计划后，**不要立即调用 ExitPlanMode**
3. 先向用户展示计划摘要，以及完整的计划文档的路径地址，然后等待用户确认后再退出计划模式
4. 用户确认执行后，再调用 ExitPlanMode 退出计划模式`);
}
```

### 步骤 3: 确认 permissionMode 在 ctx 中可用

检查 `buildSystemPromptAppend` 的上下文参数中是否已包含 `permissionMode` 字段。如果没有，需要在调用处传入。

在 Lume 中，权限模式来自 pi-agent 运行时配置，需要确认传递路径：
- `pi-agent runtime` → `agent session config` → `agent-prompt-builder ctx`

## 前置依赖

- 需要确认 Lume 的 permissionMode 命名和可选值（可能是 `auto` / `standard` / `plan` 等不同于 Proma 的命名）

## 验证方法

1. `bun run typecheck` — 类型检查通过
2. 在标准模式下发送模糊任务，观察 Agent 是否使用 AskUserQuestion 提问
3. 在自动模式下发送模糊任务，观察 Agent 是否在文本中提问而非调用 AskUserQuestion
4. 在计划模式下，观察 Agent 是否将计划写入 .context/plan/ 目录

## 工作量估计

约 1 小时，主要时间在确认 permissionMode 的传递路径。
