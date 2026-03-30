# P1-3: Skill 改进提示（skill_improvement_hint）

## 差距分析

### Proma 的实现

Proma 在 `buildDynamicContext()` 函数中，当检测到 `skill-creator` 处于启用状态时，注入 `<skill_improvement_hint>` 到每条消息的动态上下文中：

```typescript
// 当 skill-creator 处于启用状态时，注入 Skill 持续改进提示
const hasSkillCreator = skills.some((s) => s.slug === 'skill-creator')
if (hasSkillCreator) {
  wsLines.push('')
  wsLines.push([
    '<skill_improvement_hint>',
    'skill-creator 已启用。在调用其他 Skill 前后，留意以下信号：',
    '- 用户主动修正了某个 Skill 产出的内容（格式、流程、术语等）→ 该 Skill 可能需要更新',
    '- 用户反复描述一类任务但没有匹配的 Skill → 可能值得创建新 Skill',
    '- 某个 Skill 的输出持续需要大量后续调整 → 可能需要重构',
    '发现上述信号时，先简要告知用户观察到的改进点，征得同意后再通过 skill-creator 执行创建、更新或重构。',
    '不要在每次调用 Skill 后都提出建议——仅在确实观察到可复用的改进模式时才提出。',
    '</skill_improvement_hint>',
  ].join('\n'))
}
```

**关键设计**：
1. 条件注入：仅当 skill-creator 启用时才生效
2. 信号驱动：不是每次都提建议，而是观察到特定信号才触发
3. 需用户同意：先告知再执行，不自作主张
4. 放在动态上下文中：每条消息都能看到，但不占用系统 prompt 的 cache

### Lume 的现状

- ✅ 有 `skill-creator` Skill（`apps/sidecar/default-skills/skill-creator/`）
- ✅ 有动态上下文注入机制（需确认 Lume 的等价位置）
- ❌ **没有 skill_improvement_hint 自动注入**
- ❌ **Agent 不会主动建议改进已有 Skill**

## 修改方案

### 步骤 1: 确认 Lume 的动态上下文注入点

需要确认 Lume 中等价于 Proma `buildDynamicContext()` 的位置。可能的候选：
- `agent-prompt-builder.ts` 中的 per-message context 注入
- pi-agent 运行时的 system message 更新机制

### 步骤 2: 添加 skill_improvement_hint 注入逻辑

**文件**: `apps/sidecar/src/services/agent/agent-prompt-builder.ts`（或对应的动态上下文构建函数）

在构建工作区上下文时，检查 skills 列表中是否包含 `skill-creator`，如包含则注入提示：

```typescript
// Skill 持续改进提示
const hasSkillCreator = skills.some((s) => s.slug === 'skill-creator');
if (hasSkillCreator) {
  dynamicLines.push(`
<skill_improvement_hint>
skill-creator 已启用。在调用其他 Skill 前后，留意以下信号：
- 用户主动修正了某个 Skill 产出的内容（格式、流程、术语等）→ 该 Skill 可能需要更新
- 用户反复描述一类任务但没有匹配的 Skill → 可能值得创建新 Skill
- 某个 Skill 的输出持续需要大量后续调整 → 可能需要重构
发现上述信号时，先简要告知用户观察到的改进点，征得同意后再通过 skill-creator 执行创建、更新或重构。
不要在每次调用 Skill 后都提出建议——仅在确实观察到可复用的改进模式时才提出。
</skill_improvement_hint>`);
}
```

### 步骤 3: 确保 skills 列表在动态上下文中可用

确认动态上下文构建函数能够访问当前会话加载的 skills 列表（包含 slug 字段）。

## 验证方法

1. `bun run typecheck` — 类型检查通过
2. 在工作区中启用 skill-creator，然后调用另一个 Skill 并主动修正其输出
3. 观察 Agent 是否注意到修正并建议更新该 Skill
4. 确认未启用 skill-creator 时不会出现改进提示

## 工作量估计

约 1 小时，主要时间在确认 Lume 的动态上下文注入机制。
