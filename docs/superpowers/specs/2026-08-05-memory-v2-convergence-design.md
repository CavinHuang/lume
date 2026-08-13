# Lume Memory-v2 收敛设计规范

**日期**：2026-08-05  
**状态**：草稿  
**目标**：收敛分类、提升积极性、体验更好、更精准、更好管理、更及时  
**实现目标**：`apps/sidecar/src/services/memory-v2/` + `apps/web/src/components/settings/MemorySettings.tsx`

> 前置研究参见 `2026-08-05-memory-system-v2-design.md`（分析了 Claude Code 源码和 TencentDB 架构）。

---

## 1. 核心问题诊断

通过读取 memory-v2 全部源码，当前系统的实质性问题是**三层分类体系不对齐**：

```
外部 MemoryKind（9种）  →  内部 MemoryV2Kind（5种）  →  UI分类（4种）
raw / summary / fact        preference / fact               profile
preference / decision       decision / lesson               workflow
episode / lesson            state                           voice
milestone / artifact                                        instruction
```

- **Agent 困境**：调用 `memory.remember` 时需从9种 kind 中选择，但 UI 只有4个分类，且 UI 分类不由 kind 决定，而由 **tags** 决定（`classifyMemoryEntryLayer` 函数）。Agent 不知道写哪个 kind + 加哪些 tags 才能让记忆出现在正确的 UI 分类里。
- **用户困境**：在 UI 里看到的是"偏好/事实/决策/经验/状态"这些 kind labels，但实际查看时发现同类信息分散在不同分类，难以理解和管理。
- **召回困境**：`kindIntentBoost` 基于 `MemoryV2Kind`（5种）做意图匹配，但写入时用的是外部9种 kind，映射关系不直觉。

**次要问题**：
- "从历史对话生成记忆"需手动点击，没有自动触发机制
- `valid_to` / `suspected_stale` 字段存在于数据层但 UI 里无法主动设置
- `memory.remember` 工具的提示词对 kind 选择没有足够引导

---

## 2. 设计目标

| 目标 | 衡量标准 |
|------|----------|
| 分类收敛 | Agent 调用 `memory.remember` 时只需从4种 kind 选择，无歧义 |
| UI 分类与 kind 对齐 | UI 分类直接由 kind 决定，不再依赖 tags |
| 写入端主动 | run 结束后自动触发轻量提取，无需用户点击按钮 |
| 召回更精准 | kindIntentBoost 基于新4种 kind 重映射，每种 kind 语义更清晰 |
| 管理更方便 | UI 可手动设置 valid_to，suspected_stale 可一键标记 |

---

## 3. Kind 分类收敛方案

### 3.1 新四分法

废弃9种外部 kind，统一为4种**语义清晰**的 kind，直接对应 UI 4个分类：

| 新 kind | 语义 | 对应 UI 分类 | 典型内容 |
|---------|------|-------------|---------|
| `profile` | 用户画像与身份 | 身份记忆 | 名字、角色、稳定个人信息 |
| `workflow` | 工作方式与项目上下文 | 工作方式 | 偏好、习惯、决策、约定、任务状态 |
| `voice` | 表达与写作风格 | 写作风格 | 文风、语气、格式偏好 |
| `instruction` | 长期规则与指令 | 用户指令 | 规则、事实源、约束、需遵守的规范 |

### 3.2 旧 kind 迁移映射

| 旧外部 kind | → 新 kind |
|------------|----------|
| `raw` | `workflow`（原始状态记录） |
| `summary` / `state`（内部） | `workflow`（项目/任务状态） |
| `fact` | `instruction`（事实/规则） 或 `profile`（个人事实） |
| `preference` | `workflow` 或 `voice` |
| `decision` | `workflow`（项目决策） |
| `episode` / `milestone` | `workflow`（过程/里程碑） |
| `lesson` | `instruction`（学到的规则） |
| `artifact` | `instruction`（产物指针） |

**迁移策略**：写一个 migration function，根据现有 tags 和旧 kind 推断新 kind；向后兼容（旧数据有 kind 但读不到新值时 fallback 到 `workflow`）。

### 3.3 UI 分类改为 kind 驱动

废弃 `classifyMemoryEntryLayer` 中的 tag-based 分类，改为：

```ts
function classifyMemoryEntryLayer(entry: MemorySettingsEntrySummary): MemoryUserCategory {
  // 直接由 kind 决定，不再解析 tags
  if (entry.kind === 'profile') return 'profile'
  if (entry.kind === 'voice') return 'voice'
  if (entry.kind === 'instruction') return 'instruction'
  return 'workflow'  // default
}
```

---

## 4. 写入端主动：post-run 自动提取

### 4.1 触发机制

每次会话 run 完成时（`MemoryV2Source.type = 'run_completed'` 已存在于类型定义），在 run 结束后触发轻量提取：

```
run completed
  → 写入 runs/run_<id>.jsonl（已有）
  → 触发 lightweight extraction（新增）
    → 只提取 high-confidence candidates（≥0.75）
    → 跳过 low/medium confidence（进 pending 队列）
    → 直接写入 entries/（不经人工审核）
```

### 4.2 实现位置

- sidecar：在处理 `run_completed` 事件的地方添加 `autoExtractFromRun(runId)`
- 阈值可配置：`MemoryRuntimeConfig.autoCapture.minConfidence`（默认 0.75）
- 开关：`MemoryRuntimeConfig.autoCapture.enabled`（默认 true）
- 频率限制：每个 run 最多提取 N 条（默认 5），避免大量噪声

### 4.3 UI 控制

在 MemorySettings "高级设置" 区增加 "自动提取" toggle：

```
[✓] 运行后自动提取记忆
    每次对话结束后自动提取高置信度记忆（≥75%）
    低置信度内容仍需手动整理
```

---

## 5. 管理端改善：valid_to + 手动 stale 标记

### 5.1 有效期字段（valid_to）

`MemoryV2EntryFrontmatter.valid_to` 字段已存在（目前 UI 未暴露）。

新增：在 `MemoryDetailPanel` 编辑模式下显示有效期日期选择器：
```
有效期：[日期选择器]  ← 可选，为空表示永久有效
        设置后过期时自动标记为 suspected_stale
```

### 5.2 手动标记 suspected_stale

在 `MemoryDetailPanel` 的按钮区增加：
```
[编辑] [删除] [标记过期] [打开源文件]
```

"标记过期" → 将 entry status 设为 `suspected_stale`，UI 立即更新显示⚠️。

### 5.3 suspected_stale 分组展示

当前 `EntryRow` 已有 `suspected_stale` badge，但过期记忆与正常记忆混在一起。改为：在每个 UI 分类底部显示"可能过期"折叠区，与正常记忆分组。

---

## 6. Agent 工具引导优化

### 6.1 memory.remember 工具描述更新

在 tools.ts/prompt 中，将 kind 说明简化为4种并附上使用场景：

```
kind（必填，选一）：
- profile：用户的名字、角色、稳定个人事实（"叫我 Leo"、"后端工程师"）
- workflow：工作偏好、项目约定、任务状态、决策记录（"偏好先讨论方案"、"PR 合并规则"）
- voice：写作风格、语气、表达格式（"回答要简洁"、"代码注释用英文"）
- instruction：长期规则、事实源、始终遵守的指令（"不直接改 main 分支"、"测试用 bun:test"）
```

### 6.2 scope 使用规范

在工具描述中明确：
- `global`：跨项目有效（profile/voice 默认）
- `workspace`：当前工作区有效（workflow/instruction 默认，因为项目特定）

---

## 7. 内部 MemoryV2Kind 映射调整

新外部 kind（4种）映射到内部存储 kind：

```ts
// 新的外部→内部映射
function toMemoryV2Kind(kind?: string): MemoryV2Kind {
  if (kind === 'profile') return 'fact'        // 身份是事实
  if (kind === 'voice') return 'preference'    // 风格是偏好
  if (kind === 'instruction') return 'fact'    // 规则是事实（pinned=true）
  return 'state'                               // workflow 对应状态/偏好/决策
}
```

这个映射不影响存储，只影响内部的 `kindIntentBoost` 召回逻辑，需要同步更新。

---

## 8. 实现范围与不做的事

**In scope**：
- Kind 分类收敛（外部9→4，UI分类由 kind 驱动）
- post-run 自动提取（autoCapture）
- valid_to 日期选择器 + 手动 suspected_stale 标记
- memory.remember 工具描述更新
- 旧数据迁移函数

**Not in scope（follow-up）**：
- 重构内部 `MemoryV2Kind`（保持5种不变，只改外部暴露层）
- memory.remember 的 scope 自动推断（保持现有行为）
- 会话内实时捕获（需要更大的架构改动，留后续）
- MemorySettings 的整体 UI 重设计

---

## 9. 文件改动范围

| 文件 | 改动 |
|------|------|
| `packages/shared/src/types/memory.ts`（或同等位置） | 收敛外部 `MemoryKind` 为4种 |
| `apps/sidecar/src/services/memory-v2/tools.ts` | `toMemoryV2Kind` 映射 + 工具描述 |
| `apps/sidecar/src/services/memory-v2/extraction.ts` | `inferKind` 使用新4种 kind |
| `apps/sidecar/src/services/memory-v2/retrieval.ts` | `kindIntentBoost` 更新映射 |
| `apps/sidecar/src/services/memory-v2/markdown-store.ts` | 迁移函数：旧 kind → 新 kind |
| sidecar run-completed 处理点 | 添加 `autoExtractFromRun` 触发 |
| `apps/sidecar/src/services/memory-v2/policy.ts` | 新增 `autoCapture` 配置字段 |
| `apps/web/src/components/settings/memory-settings-state.ts` | 更新 `MEMORY_KIND_LABELS`，简化分类函数 |
| `apps/web/src/components/settings/MemorySettings.tsx` | valid_to 日期选择器 + 手动 stale 按钮 + autoCapture toggle |

---

## 10. 成功标准

| 场景 | 改进前 | 改进后 |
|------|--------|--------|
| Agent 写记忆时选 kind | 从9种中猜测 + 手动加 tags | 从4种中明确选择，不需要 tags 控制分类 |
| 用户查看记忆 | 每个分类中的条目来源不明确 | 每个条目的 kind 直接对应它所在的分类 |
| 对话结束后 | 需手动点击"从历史对话生成记忆" | 高置信记忆自动写入，低置信进 pending |
| 处理过期记忆 | 只能等 suspected_stale 自动出现 | 可手动标记 + 设置 valid_to |

---

*本 spec 基于 memory-v2 代码完整分析（claim.ts / types.ts / tools.ts / retrieval.ts / extraction.ts / history-organizer.ts / paths.ts / MemorySettings.tsx / memory-settings-state.ts）*
