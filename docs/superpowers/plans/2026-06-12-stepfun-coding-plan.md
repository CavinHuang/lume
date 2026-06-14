# 阶跃星辰 Step Plan 集成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将阶跃星辰 Step Plan 编程套餐作为新的模型提供商集成到 Lume 中，使用户可通过订阅制 API 使用 step-3.7-flash 等旗舰模型。

**Architecture:** Step Plan 使用 OpenAI 兼容协议（`https://api.stepfun.com/step_plan/v1`），复用现有的 `OpenAIAdapter`。作为一个新的 `ProviderType`（`stepfun-coding-plan`）注册到编程套餐分组中，同时添加 `stepfun` 作为国内平台提供商。

**Tech Stack:** TypeScript, React, @lobehub/icons (Stepfun 图标已可用)

---

## File Structure

| 操作 | 文件路径 | 职责 |
|------|---------|------|
| Modify | `packages/shared/src/types/channel.ts` | 添加 `stepfun` 和 `stepfun-coding-plan` 到 ProviderType 联合类型及相关常量映射 |
| Modify | `packages/shared/src/data/model-meta.ts` | 添加阶跃星辰模型元数据 |
| Modify | `apps/sidecar/src/providers/index.ts` | 注册 stepfun 适配器 |
| Modify | `apps/sidecar/src/services/channel/model-selection.ts` | 添加到 coerceKnownProvider 列表 |
| Modify | `apps/web/src/components/model-selection/provider-icon-map.tsx` | 添加 Stepfun 图标映射 |
| Modify | `apps/web/src/components/settings/agent-settings-state.ts` | 添加 stepfun 颜色主题 |

---

### Task 1: 注册 ProviderType 及常量映射

**Files:**
- Modify: `packages/shared/src/types/channel.ts`

- [ ] **Step 1: 添加 `stepfun` 和 `stepfun-coding-plan` 到 ProviderType 联合类型**

在 `ProviderType` 类型定义中，`'xiaomi-token-plan'` 后面添加两个新类型：

```typescript
export type ProviderType =
  | 'anthropic'
  | 'anthropic-compatible'
  | 'openai'
  | 'jina'
  | 'siliconflow'
  | 'openrouter'
  | 'deepseek'
  | 'google'
  | 'zai'
  | 'zai-coding-plan'
  | 'moonshot'
  | 'minimax'
  | 'minimax-cn'
  | 'doubao'
  | 'qwen'
  | 'qwen-portal'
  | 'kimi-coding'
  | 'ollama'
  | 'lmstudio'
  | 'opencode'
  | 'custom'
  | 'aliyun-coding-plan'
  | 'volcengine-coding-plan'
  | 'minimax-token-plan'
  | 'xiaomi-token-plan'
  | 'stepfun'
  | 'stepfun-coding-plan'
```

- [ ] **Step 2: 添加到 PROVIDER_GROUPS 编程套餐和国内平台分组**

在 `PROVIDER_GROUPS` 数组中：
- `coding-plan` 分组的 `providers` 数组末尾添加 `'stepfun-coding-plan'`
- `domestic` 分组的 `providers` 数组末尾添加 `'stepfun'`

```typescript
{ key: 'coding-plan', label: '编程套餐', providers: ['kimi-coding', 'zai-coding-plan', 'aliyun-coding-plan', 'volcengine-coding-plan', 'minimax-token-plan', 'xiaomi-token-plan', 'stepfun-coding-plan'] },
{ key: 'domestic', label: '国内平台', providers: ['deepseek', 'moonshot', 'minimax', 'minimax-cn', 'doubao', 'qwen', 'qwen-portal', 'zai', 'stepfun'] },
```

- [ ] **Step 3: 添加到 PROVIDER_DEFAULT_URLS**

在 `PROVIDER_DEFAULT_URLS` 末尾（`'xiaomi-token-plan'` 之后）添加：

```typescript
  stepfun: 'https://api.stepfun.com/v1',
  'stepfun-coding-plan': 'https://api.stepfun.com/step_plan/v1',
```

- [ ] **Step 4: 添加到 PROVIDER_LABELS**

在 `PROVIDER_LABELS` 末尾添加：

```typescript
  stepfun: '阶跃星辰',
  'stepfun-coding-plan': '阶跃星辰 Step Plan',
```

- [ ] **Step 5: 添加到 PROVIDER_API_FAMILIES**

在 `PROVIDER_API_FAMILIES` 末尾添加（两者均使用 OpenAI 兼容协议）：

```typescript
  stepfun: 'openai',
  'stepfun-coding-plan': 'openai',
```

- [ ] **Step 6: 验证编译通过**

Run: `cd /Users/cavinhuang/workspace/projects/ai-projects/Lume && npx tsc --noEmit -p packages/shared/tsconfig.json 2>&1 | head -30`
Expected: 无类型错误。如果出现类型不完整的错误，说明遗漏了某个 Record 常量映射。

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/types/channel.ts
git commit -m "feat: 添加 stepfun 和 stepfun-coding-plan 到 ProviderType"
```

---

### Task 2: 添加阶跃星辰模型元数据

**Files:**
- Modify: `packages/shared/src/data/model-meta.ts`

- [ ] **Step 1: 在 MODEL_META_REGISTRY 中添加阶跃星辰模型**

在 `MODEL_META_REGISTRY` 数组中（可以放在其他国内模型块之后），添加以下模型条目：

```typescript
  // ── 阶跃星辰 Stepfun ──
  {
    id: 'step-3.7-flash',
    displayName: 'Step 3.7 Flash',
    contextWindow: 131_072,
    capabilities: { vision: true, toolUse: true, reasoning: true },
    description: '阶跃星辰旗舰多模态推理模型，支持三档推理强度',
  },
  {
    id: 'step-3.5-flash-2603',
    aliases: ['step-3.5-flash-2603'],
    displayName: 'Step 3.5 Flash 2603',
    contextWindow: 131_072,
    capabilities: { vision: false, toolUse: true, reasoning: true },
    description: '针对高频 Agent 场景优化，Token 效率提升、推理速度更快',
  },
  {
    id: 'step-3.5-flash',
    displayName: 'Step 3.5 Flash',
    contextWindow: 131_072,
    capabilities: { vision: false, toolUse: true, reasoning: true },
    description: '196B MoE 架构，高速推理，专为智能体和代码任务优化',
  },
  {
    id: 'step-router-v1',
    displayName: 'Step Router V1',
    contextWindow: 131_072,
    capabilities: { vision: false, toolUse: true, reasoning: true },
    description: '智能路由模型，自动在 deepseek-v4-pro 与 step-3.5-flash 之间切换',
  },
```

- [ ] **Step 2: 验证编译通过**

Run: `cd /Users/cavinhuang/workspace/projects/ai-projects/Lume && npx tsc --noEmit -p packages/shared/tsconfig.json 2>&1 | head -30`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/data/model-meta.ts
git commit -m "feat: 添加阶跃星辰 Step 模型元数据"
```

---

### Task 3: 注册 Sidecar 适配器

**Files:**
- Modify: `apps/sidecar/src/providers/index.ts`

- [ ] **Step 1: 在 adapterRegistry 中注册 stepfun 和 stepfun-coding-plan**

在 `adapterRegistry` 的 Map 定义中（`'xiaomi-token-plan'` 条目之后），添加：

```typescript
  ['stepfun', new OpenAIAdapter()],
  ['stepfun-coding-plan', new OpenAIAdapter()],
```

- [ ] **Step 2: 验证编译通过**

Run: `cd /Users/cavinhuang/workspace/projects/ai-projects/Lume && npx tsc --noEmit -p apps/sidecar/tsconfig.json 2>&1 | head -30`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add apps/sidecar/src/providers/index.ts
git commit -m "feat: 注册 stepfun 和 stepfun-coding-plan 适配器到 sidecar"
```

---

### Task 4: 更新模型选择 Provider 识别

**Files:**
- Modify: `apps/sidecar/src/services/channel/model-selection.ts`

- [ ] **Step 1: 将 `stepfun` 和 `stepfun-coding-plan` 添加到 coerceKnownProvider 的已知 provider 列表**

在 `coerceKnownProvider` 函数的数组中（`"xiaomi-token-plan"` 之后），添加：

```typescript
    "stepfun",
    "stepfun-coding-plan",
```

完整的 coerceKnownProvider 数组应为：
```typescript
function coerceKnownProvider(provider: string): ProviderType {
  return ([
    "anthropic",
    "anthropic-compatible",
    "openai",
    "jina",
    "siliconflow",
    "openrouter",
    "deepseek",
    "google",
    "zai",
    "zai-coding-plan",
    "moonshot",
    "minimax",
    "minimax-cn",
    "doubao",
    "qwen",
    "qwen-portal",
    "kimi-coding",
    "ollama",
    "lmstudio",
    "opencode",
    "custom",
    "aliyun-coding-plan",
    "volcengine-coding-plan",
    "minimax-token-plan",
    "xiaomi-token-plan",
    "stepfun",
    "stepfun-coding-plan",
  ] as const).includes(provider as ProviderType)
    ? (provider as ProviderType)
    : "custom";
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/sidecar/src/services/channel/model-selection.ts
git commit -m "feat: 将 stepfun 添加到已知 provider 识别列表"
```

---

### Task 5: 添加 UI 图标映射

**Files:**
- Modify: `apps/web/src/components/model-selection/provider-icon-map.tsx`

- [ ] **Step 1: 导入 Stepfun 图标**

在 `@lobehub/icons` 的导入语句中添加 `Stepfun`：

```typescript
import {
  AlibabaCloud,
  Anthropic,
  DeepSeek,
  Doubao,
  Google,
  Jina,
  Kimi,
  Minimax,
  Moonshot,
  OpenAI,
  OpenRouter,
  Qwen,
  SiliconCloud,
  Stepfun,
  Volcengine,
  XiaomiMiMo,
  ZAI,
} from '@lobehub/icons'
```

- [ ] **Step 2: 在 PROVIDER_ICON_MAP 中添加映射**

在 `PROVIDER_ICON_MAP` 对象中（`siliconflow` 条目之后），添加：

```typescript
  stepfun: Stepfun as BrandIcon,
  'stepfun-coding-plan': Stepfun as BrandIcon,
```

- [ ] **Step 3: 验证编译通过**

Run: `cd /Users/cavinhuang/workspace/projects/ai-projects/Lume && npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -30`
Expected: 无错误。如果 `Stepfun` 导入失败，说明 `@lobehub/icons@5.5.4` 中可能需要通过其他路径导入，需检查 `icons.d.ts` 的实际导出名。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/model-selection/provider-icon-map.tsx
git commit -m "feat: 添加阶跃星辰 Stepfun 图标映射"
```

---

### Task 6: 添加设置页面颜色主题

**Files:**
- Modify: `apps/web/src/components/settings/agent-settings-state.ts`

- [ ] **Step 1: 在 PROVIDER_TONES 中添加 stepfun 颜色**

在 `PROVIDER_TONES` 对象中（`'xiaomi-token-plan'` 之后），添加：

```typescript
  stepfun: 'bg-[#6c5ce7]/10 text-[#6c5ce7]',
  'stepfun-coding-plan': 'bg-[#6c5ce7]/10 text-[#6c5ce7]',
```

> 注：`#6c5ce7` 是阶跃星辰品牌紫色主色调的近似值，如需精确值可后续调整。

- [ ] **Step 2: 验证编译通过**

Run: `cd /Users/cavinhuang/workspace/projects/ai-projects/Lume && npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -30`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/settings/agent-settings-state.ts
git commit -m "feat: 添加阶跃星辰 stepfun 颜色主题"
```

---

### Task 7: 全量编译验证 + 最终提交

**Files:**
- None (验证任务)

- [ ] **Step 1: 运行全量 TypeScript 编译检查**

Run: `cd /Users/cavinhuang/workspace/projects/ai-projects/Lume && npx tsc --noEmit 2>&1 | head -50`
Expected: 无错误。如果有错误，检查是否遗漏了某个 Record<ProviderType, ...> 常量中的条目。

- [ ] **Step 2: 可选 — Squash merge 所有 stepfun 相关 commit**

如果前面分步提交了 6 个 commit，可以 squash 为一个：

```bash
git rebase -i HEAD~6
```

将后面 5 个 commit 的 `pick` 改为 `squash`，合并为一个 commit：
```
feat: 添加阶跃星辰 Step Plan 编程套餐提供商

- 注册 stepfun 和 stepfun-coding-plan 到 ProviderType
- 添加 Step 模型元数据 (step-3.7-flash, step-3.5-flash 等)
- 注册 OpenAIAdapter 到 sidecar 适配器注册表
- 添加 Stepfun 图标映射和颜色主题
```

---

## Self-Review Checklist

### 1. Spec Coverage
- [x] ProviderType 联合类型 — Task 1 Step 1
- [x] 编程套餐分组 — Task 1 Step 2
- [x] 国内平台分组 — Task 1 Step 2
- [x] 默认 Base URL — Task 1 Step 3
- [x] 显示名称 — Task 1 Step 4
- [x] API 协议家族 — Task 1 Step 5
- [x] 模型元数据 — Task 2
- [x] Sidecar 适配器注册 — Task 3
- [x] 模型选择 Provider 识别 — Task 4
- [x] UI 图标 — Task 5
- [x] 设置页面颜色 — Task 6

### 2. Placeholder Scan
- 无 TBD / TODO / "implement later" 等占位符
- 所有代码步骤均包含完整代码

### 3. Type Consistency
- `ProviderType` 新增的 `'stepfun'` 和 `'stepfun-coding-plan'` 在所有 `Record<ProviderType, ...>` 常量中均有对应条目
- 适配器注册使用 `OpenAIAdapter`，与 `PROVIDER_API_FAMILIES` 中 `openai` 协议一致
- `coerceKnownProvider` 列表与 `ProviderType` 联合类型同步
