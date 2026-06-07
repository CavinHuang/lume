# Provider 分组功能实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为供应商配置界面增加分组标签栏，新增 4 个编程套餐 Provider，支持自定义 Provider 的添加、编辑和删除。

**Architecture:** 在 shared 包中定义 ProviderGroup 和 PROVIDER_GROUPS，Web 层用分组标签替换原有筛选，sidecar 层注册新 Provider 适配器并支持自定义 Channel 的 apiFamily 字段。

**Tech Stack:** TypeScript, React, Jotai, Electron IPC

---

## Task 1: Shared 类型 — 新增 ProviderType + ProviderGroup

**Files:**
- Modify: `packages/shared/src/types/channel.ts`

- [ ] **Step 1: 新增 4 个 ProviderType 和相关常量**

在 `ProviderType` 联合类型末尾追加 4 个新值：

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
```

在 `PROVIDER_DEFAULT_URLS` 中追加：

```typescript
'aliyun-coding-plan': 'https://coding.dashscope.aliyuncs.com/v1',
'volcengine-coding-plan': 'https://ark.cn-beijing.volces.com/api/coding/v3',
'minimax-token-plan': 'https://api.minimaxi.com/anthropic/v1',
'xiaomi-token-plan': 'https://token-plan-cn.xiaomimimo.com/v1',
```

在 `PROVIDER_LABELS` 中追加并更新已有标签：

```typescript
// 更新已有
'kimi-coding': 'Kimi Code Plan',
'zai-coding-plan': '智谱 GLM Coding Plan',
// 新增
'aliyun-coding-plan': '阿里云 Coding Plan',
'volcengine-coding-plan': '火山方舟 Coding Plan',
'minimax-token-plan': 'MiniMax Token Plan',
'xiaomi-token-plan': '小米 MiMo Token Plan',
```

在 `PROVIDER_API_FAMILIES` 中追加：

```typescript
'aliyun-coding-plan': 'openai',
'volcengine-coding-plan': 'openai',
'minimax-token-plan': 'anthropic',
'xiaomi-token-plan': 'openai',
```

- [ ] **Step 2: 新增 ProviderGroup 类型和 PROVIDER_GROUPS 常量**

在 `channel.ts` 中 `ProviderApiFamily` 之后追加：

```typescript
/** 供应商分组 */
export type ProviderGroup = 'all' | 'coding-plan' | 'domestic' | 'overseas' | 'transit' | 'local' | 'custom'

export interface ProviderGroupInfo {
  key: ProviderGroup
  label: string
  providers: ProviderType[]
}

export const PROVIDER_GROUPS: ProviderGroupInfo[] = [
  { key: 'all', label: '全部', providers: [] },
  { key: 'coding-plan', label: '编程套餐', providers: ['kimi-coding', 'zai-coding-plan', 'aliyun-coding-plan', 'volcengine-coding-plan', 'minimax-token-plan', 'xiaomi-token-plan'] },
  { key: 'domestic', label: '国内平台', providers: ['deepseek', 'moonshot', 'minimax', 'minimax-cn', 'doubao', 'qwen', 'qwen-portal', 'zai'] },
  { key: 'overseas', label: '海外平台', providers: ['anthropic', 'anthropic-compatible', 'openai', 'google', 'jina'] },
  { key: 'transit', label: '中转/聚合', providers: ['openrouter', 'siliconflow', 'opencode'] },
  { key: 'local', label: '本地/其他', providers: ['ollama', 'lmstudio'] },
  { key: 'custom', label: '自定义', providers: ['custom'] },
]
```

- [ ] **Step 3: 确保 shared 包导出新类型**

检查 `packages/shared/src/types/index.ts` 和 `packages/shared/src/index.ts` 中是否已通过 `export *` 导出了 `channel.ts` 的内容。如果是，则无需额外操作。如果不是，添加导出。

- [ ] **Step 4: 运行 shared 包的构建验证类型**

```bash
cd packages/shared && npx tsc --noEmit
```

Expected: 无类型错误

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/channel.ts
git commit -m "feat(shared): 新增 ProviderType (编程套餐) 和 ProviderGroup 分组类型"
```

---

## Task 2: Shared 类型 — Channel.apiFamily + 自定义协议常量

**Files:**
- Modify: `packages/shared/src/types/channel.ts`

- [ ] **Step 1: Channel 接口新增 apiFamily 字段**

在 `Channel` 接口中 `updatedAt` 之后追加：

```typescript
/** 自定义渠道的协议家族（仅 provider='custom' 时使用） */
apiFamily?: ProviderApiFamily
```

在 `ChannelCreateInput` 中 `enabled` 之前追加：

```typescript
/** 自定义渠道的协议家族（仅 provider='custom' 时使用） */
apiFamily?: ProviderApiFamily
```

在 `ChannelUpdateInput` 中 `enabled` 之前追加：

```typescript
/** 自定义渠道的协议家族（仅 provider='custom' 时使用） */
apiFamily?: ProviderApiFamily
```

- [ ] **Step 2: 新增 CUSTOM_API_FAMILIES 常量**

在 `PROVIDER_API_FAMILY_LABELS` 之后追加：

```typescript
/** 自定义 Provider 可选的协议家族 */
export const CUSTOM_API_FAMILIES: Array<{ value: ProviderApiFamily; label: string }> = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
]
```

- [ ] **Step 3: FetchModelsInput 新增 apiFamily**

在 `FetchModelsInput` 接口中 `apiKey` 之后追加：

```typescript
/** 自定义渠道的协议家族（可选，仅 custom provider 使用） */
apiFamily?: ProviderApiFamily
```

- [ ] **Step 4: 运行类型检查**

```bash
cd packages/shared && npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/channel.ts
git commit -m "feat(shared): Channel 新增 apiFamily 字段，支持自定义协议"
```

---

## Task 3: Sidecar — 注册新 Provider 适配器 + apiFamily 解析

**Files:**
- Modify: `apps/sidecar/src/providers/index.ts`
- Modify: `apps/sidecar/src/services/channel/channel-manager.ts`
- Modify: `apps/sidecar/src/services/channel/model-selection.ts`

- [ ] **Step 1: 适配器注册表新增 Provider**

在 `adapterRegistry` 中追加 4 个新 Provider（使用 OpenAIAdapter，因为 minimax-token-plan 虽然协议是 anthropic 但通过 URL 检测在运行时切换适配器）：

```typescript
['aliyun-coding-plan', new OpenAIAdapter()],
['volcengine-coding-plan', new OpenAIAdapter()],
['minimax-token-plan', new AnthropicAdapter()],
['xiaomi-token-plan', new OpenAIAdapter()],
```

> 注：`minimax-token-plan` 直接注册 `AnthropicAdapter`，因为其协议家族为 `anthropic`，URL 包含 `/anthropic`，且默认应使用 Anthropic 请求格式。

- [ ] **Step 2: channel-manager.ts — resolveProviderApiFamily 支持 apiFamily 参数**

将 `resolveProviderApiFamily` 函数签名和逻辑修改为：

```typescript
function resolveProviderApiFamily(
  provider: Channel["provider"],
  baseUrl: string,
  apiFamily?: ProviderApiFamily
): ProviderApiFamily {
  // 自定义渠道优先使用显式声明的 apiFamily
  if (provider === "custom" && apiFamily) {
    return apiFamily;
  }
  const normalizedBaseUrl = baseUrl.trim().toLowerCase();
  const byProvider = PROVIDER_API_FAMILIES[provider];
  if (normalizedBaseUrl.includes("/anthropic")) {
    return "anthropic";
  }
  return byProvider;
}
```

- [ ] **Step 3: channel-manager.ts — 更新 testChannel 和 fetchModels 传递 apiFamily**

`testChannel` 函数中（约第 382 行），将 `channel.apiFamily` 传入：

```typescript
const family = resolveProviderApiFamily(channel.provider, channel.baseUrl, channel.apiFamily);
```

`testChannelDirect` 函数中（约第 390 行），将 `input.apiFamily` 传入：

```typescript
const family = resolveProviderApiFamily(input.provider, input.baseUrl, input.apiFamily);
```

`fetchModels` 函数中（约第 491 行），将 `input.apiFamily` 传入：

```typescript
const family = resolveProviderApiFamily(input.provider, input.baseUrl, input.apiFamily);
```

- [ ] **Step 4: channel-manager.ts — createChannel 和 updateChannel 处理 apiFamily**

在 `createChannel` 函数中，保存 channel 时包含 `apiFamily`：

```typescript
// 在构建新 channel 对象时加入 apiFamily
const channel: Channel = {
  id: generateId(),
  name: input.name,
  provider: input.provider,
  baseUrl: input.baseUrl,
  apiKey: encryptSecret(input.apiKey),
  models: input.models,
  defaultModelId: input.defaultModelId,
  fallbackModelIds: input.fallbackModelIds,
  enabled: input.enabled,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...(input.apiFamily ? { apiFamily: input.apiFamily } : {}),
};
```

在 `updateChannel` 函数中，处理 `apiFamily` 更新：

```typescript
// 在更新逻辑中加入 apiFamily
if (input.apiFamily !== undefined) channel.apiFamily = input.apiFamily;
```

- [ ] **Step 5: model-selection.ts — resolveChannelModelSelection 支持 apiFamily**

在 `resolveChannelModelSelection` 的 input 参数中增加 `apiFamily` 可选字段：

```typescript
export function resolveChannelModelSelection(input: {
  channelProvider: ProviderType;
  baseUrl: string;
  modelId: string;
  apiFamily?: string;
}): {
```

在函数体中，当 `channelProvider === 'custom'` 且有 `apiFamily` 时，优先使用它来决定适配器：

```typescript
const baseUrlFamily = resolveProviderApiFamilyFromBaseUrl(input.baseUrl);
const providerFamily = input.channelProvider === "custom" && input.apiFamily
  ? input.apiFamily as ProviderApiFamily
  : resolveProviderApiFamilyFromId(parsed.provider);
const resolvedFamily = input.channelProvider === "custom" && input.apiFamily
  ? input.apiFamily as ProviderApiFamily
  : (baseUrlFamily ?? providerFamily);
```

在 `coerceKnownProvider` 的已知 Provider 列表中追加 4 个新值：

```typescript
"aliyun-coding-plan",
"volcengine-coding-plan",
"minimax-token-plan",
"xiaomi-token-plan",
```

- [ ] **Step 6: sidecar RPC handler — 传递 apiFamily**

检查 `apps/sidecar/src/rpc/channel-handlers.ts` 中 `channel:create` 和 `channel:update` 的 handler，确保 `apiFamily` 字段被正确传递到 `createChannel`/`updateChannel` 函数。

检查 `channel:fetch-models` handler，确保将 `apiFamily` 传递到 `fetchModels` 函数。

- [ ] **Step 7: 运行 sidecar 类型检查**

```bash
cd apps/sidecar && npx tsc --noEmit
```

- [ ] **Step 8: Commit**

```bash
git add apps/sidecar/src/providers/index.ts apps/sidecar/src/services/channel/channel-manager.ts apps/sidecar/src/services/channel/model-selection.ts apps/sidecar/src/rpc/channel-handlers.ts
git commit -m "feat(sidecar): 注册新 Provider 适配器，支持自定义 Channel apiFamily"
```

---

## Task 4: Web — 更新 buildModelProviderRows 支持分组和自定义

**Files:**
- Modify: `apps/web/src/components/settings/agent-settings-state.ts`

- [ ] **Step 1: 更新 ModelProviderRow 接口**

```typescript
export interface ModelProviderRow {
  provider: ProviderType
  label: string
  channel: Channel | null
  tone: string
  /** 自定义 Channel 的唯一标识（用于区分多个 custom channel） */
  channelId?: string
}
```

- [ ] **Step 2: 更新 PROVIDER_TONES 追加新 Provider 的色调**

```typescript
const PROVIDER_TONES: Partial<Record<ProviderType, string>> = {
  openai: 'bg-[#efe9ff] text-[#7a54f2]',
  anthropic: 'bg-[#f5e4b8] text-[#6e5928]',
  google: 'bg-[#e6f0ff] text-[#346df1]',
  deepseek: 'bg-[#e9f1ff] text-[#3a65e5]',
  openrouter: 'bg-[#eff4ff] text-[#111827]',
  custom: 'bg-[#eadcff] text-[#7a52e8]',
  zai: 'bg-[#eee7ff] text-[#7557ff]',
  'zai-coding-plan': 'bg-[#eee7ff] text-[#7557ff]',
  moonshot: 'bg-[#111827] text-white',
  'aliyun-coding-plan': 'bg-[#ff6a00]/10 text-[#ff6a00]',
  'volcengine-coding-plan': 'bg-[#3370ff]/10 text-[#3370ff]',
  'minimax-token-plan': 'bg-[#3d5afe]/10 text-[#3d5afe]',
  'xiaomi-token-plan': 'bg-[#ff6900]/10 text-[#ff6900]',
}
```

- [ ] **Step 3: 更新 buildModelProviderRows 支持自定义 Channel**

修改函数：先构建内置 Provider 行，再追加所有 `provider === 'custom'` 的 Channel 作为独立行：

```typescript
export function buildModelProviderRows(channels: Channel[]): ModelProviderRow[] {
  // 内置 Provider
  const builtInRows = (Object.entries(PROVIDER_LABELS) as [ProviderType, string][])
    .filter(([provider]) => provider !== 'custom') // 排除 custom，单独处理
    .map(([provider, label], index) => ({
      provider,
      label,
      channel: channels.find((channel) => channel.provider === provider) ?? null,
      tone: PROVIDER_TONES[provider] ?? 'bg-[#eef2f7] text-[#4d566f]',
      index,
    }))

  // 自定义 Channel（每个生成独立行）
  const customRows = channels
    .filter((channel) => channel.provider === 'custom')
    .map((channel, index) => ({
      provider: 'custom' as ProviderType,
      label: channel.name || '自定义供应商',
      channel,
      tone: PROVIDER_TONES['custom'] ?? 'bg-[#eadcff] text-[#7a52e8]',
      channelId: channel.id,
      index: builtInRows.length + index,
    }))

  return [...builtInRows, ...customRows]
    .sort((a, b) => {
      const aRank = a.channel?.enabled ? 0 : a.channel ? 1 : 2
      const bRank = b.channel?.enabled ? 0 : b.channel ? 1 : 2
      return aRank - bRank || a.index - b.index
    })
    .map(({ provider, label, channel, tone, channelId }) => ({
      provider, label, channel, tone, channelId,
    }))
}
```

- [ ] **Step 4: 更新 getModelProviderFormInitialValue 支持自定义 Channel**

修改函数，当处理自定义 Channel 时使用 channel 的 name 和 baseUrl，而非从 PROVIDER_LABELS/PROVIDER_DEFAULT_URLS 查表：

```typescript
export function getModelProviderFormInitialValue(
  provider: ProviderType,
  channels: Channel[],
  apiKey: string,
  channelId?: string,
): ChannelCreateInput {
  // 自定义 Channel：通过 channelId 查找
  if (provider === 'custom' && channelId) {
    const existing = channels.find((c) => c.id === channelId)
    if (existing) {
      return {
        name: existing.name,
        provider: existing.provider,
        baseUrl: existing.baseUrl,
        apiKey,
        apiFamily: existing.apiFamily,
        models: existing.models,
        defaultModelId: existing.defaultModelId,
        fallbackModelIds: existing.fallbackModelIds,
        enabled: existing.enabled,
      }
    }
    // 新建自定义 Channel
    return {
      name: '',
      provider: 'custom',
      baseUrl: '',
      apiKey,
      apiFamily: 'openai',
      models: [],
      defaultModelId: undefined,
      fallbackModelIds: undefined,
      enabled: false,
    }
  }
  // 内置 Provider（原有逻辑不变）
  const existing = channels.find((channel) => channel.provider === provider)
  if (!existing) {
    return {
      name: PROVIDER_LABELS[provider],
      provider,
      baseUrl: PROVIDER_DEFAULT_URLS[provider],
      apiKey,
      models: [],
      defaultModelId: undefined,
      fallbackModelIds: undefined,
      enabled: false,
    }
  }
  return {
    name: existing.name,
    provider: existing.provider,
    baseUrl: existing.baseUrl,
    apiKey,
    models: existing.models,
    defaultModelId: existing.defaultModelId,
    fallbackModelIds: existing.fallbackModelIds,
    enabled: existing.enabled,
  }
}
```

- [ ] **Step 5: 运行 Web 类型检查**

```bash
cd apps/web && npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/settings/agent-settings-state.ts
git commit -m "feat(web): buildModelProviderRows 支持自定义 Channel 和分组"
```

---

## Task 5: Web — AgentSettings.tsx 分组标签 UI

**Files:**
- Modify: `apps/web/src/components/settings/AgentSettings.tsx`

- [ ] **Step 1: 移除 ProviderFilter 类型，引入 ProviderGroup 状态**

删除 `ProviderFilter` 类型定义和 `MODEL_PROVIDER_QUICK_FILTERS` 常量。

在 import 中添加 `ProviderGroup` 和 `PROVIDER_GROUPS`：

```typescript
import type { ProviderGroup } from '@lume/shared'
import { PROVIDER_GROUPS, PROVIDER_LABELS } from '@lume/shared'
```

将 `providerFilter` state 替换为 `activeGroup`：

```typescript
// 删除: const [providerFilter, setProviderFilter] = useState<ProviderFilter>('all')
// 替换为:
const [activeGroup, setActiveGroup] = useState<ProviderGroup>('all')
```

- [ ] **Step 2: 更新 filteredProviderRows 过滤逻辑**

将 `filteredProviderRows` 的 filter 替换为分组过滤：

```typescript
const filteredProviderRows = React.useMemo(
  () => providerRows.filter((row) => {
    // 分组过滤
    if (activeGroup !== 'all') {
      const groupInfo = PROVIDER_GROUPS.find(g => g.key === activeGroup)
      if (groupInfo && !groupInfo.providers.includes(row.provider)) return false
    }
    // 搜索过滤
    const query = providerSearch.trim().toLowerCase()
    const matchesSearch = !query
      || row.label.toLowerCase().includes(query)
      || row.provider.toLowerCase().includes(query)
    return matchesSearch
  }),
  [activeGroup, providerRows, providerSearch]
)
```

- [ ] **Step 3: 更新 activeProviderRow 选择逻辑**

当处于自定义分组时，需要通过 channelId 追踪选中项。修改 `activeProviderRow` 的计算：

```typescript
const activeProviderRow = React.useMemo(() => {
  // 自定义分组：通过 channelId 查找
  if (activeGroup === 'custom') {
    return providerRows.find((row) => row.channelId === activeProvider) ?? providerRows[0]
  }
  // 其他分组：通过 provider type 查找
  return providerRows.find((row) => row.provider === activeProvider && !row.channelId) ?? providerRows[0]
}, [activeGroup, activeProvider, providerRows])
```

- [ ] **Step 4: 更新 activeProvider 类型为 string**

`activeProvider` 当前类型为 `ProviderType`。需要改为 `string` 以同时支持内置 provider type 和自定义 channel ID：

```typescript
// 修改前: const [activeProvider, setActiveProvider] = useState<ProviderType>('anthropic')
// 修改后:
const [activeProvider, setActiveProvider] = useState<string>('anthropic')
```

`ProviderConfigurationWorkbench` 的 `activeProvider` prop 类型也同步改为 `string`。

在 `ProviderListItem` 的 `onClick` 中，对自定义行传入 `channelId`，对内置行传入 `provider`：

```tsx
<ProviderListItem
  key={row.channelId ?? row.provider}
  row={row}
  selected={activeProvider === (row.channelId ?? row.provider)}
  onClick={() => onActiveProviderChange(row.channelId ?? row.provider)}
/>
```

- [ ] **Step 5: 更新 ProviderConfigurationWorkbench 组件**

替换 `providerFilter` 相关 props 为 `activeGroup`：

```typescript
function ProviderConfigurationWorkbench({
  activeProvider,
  activeProviderRow,
  apiKeyLoading,
  filteredProviderRows,
  initialValue,
  activeGroup,
  providerEnabled,
  providerSearch,
  savingProvider,
  onActiveProviderChange,
  onActiveGroupChange,
  onProviderSearchChange,
  onProviderEnabledChange,
  onProviderSubmit,
}: {
  activeProvider: string
  activeProviderRow?: ProviderRowModel
  apiKeyLoading: boolean
  filteredProviderRows: ProviderRowModel[]
  initialValue: ChannelCreateInput
  activeGroup: ProviderGroup
  providerEnabled: boolean
  providerSearch: string
  savingProvider: boolean
  onActiveProviderChange: (id: string) => void
  onActiveGroupChange: (group: ProviderGroup) => void
  onProviderSearchChange: (value: string) => void
  onProviderEnabledChange: (checked: boolean) => void
  onProviderSubmit: (input: ChannelCreateInput) => Promise<void>
}) {
```

- [ ] **Step 6: 替换左侧面板 UI**

用分组标签栏替换原有的"全部/已配置/未配置"筛选。在 `ProviderConfigurationWorkbench` 的搜索框之前插入标签栏：

```tsx
{/* 分组标签栏 */}
<div className="flex flex-wrap gap-1">
  {PROVIDER_GROUPS.map((group) => (
    <button
      key={group.key}
      type="button"
      onClick={() => onActiveGroupChange(group.key)}
      className={cn(
        'rounded-[5px] px-2 py-1 text-[11px] font-medium transition-colors',
        activeGroup === group.key
          ? 'border border-[color-mix(in_oklab,var(--brand)_40%,var(--border-strong))] bg-[color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] text-[var(--brand)]'
          : 'text-[var(--text-2)] hover:bg-[var(--surface-2)]'
      )}
    >
      {group.label}
    </button>
  ))}
</div>
```

删除原有的 `MODEL_PROVIDER_QUICK_FILTERS` 对应的 3 个按钮 UI。

- [ ] **Step 7: 自定义标签页 — 添加按钮和删除逻辑**

在 Provider 列表下方，仅当 `activeGroup === 'custom'` 时显示添加按钮：

```tsx
{activeGroup === 'custom' && (
  <button
    type="button"
    onClick={() => {
      // 生成一个新的临时 ID，清空右侧表单进入创建模式
      onActiveProviderChange('__new_custom__')
    }}
    className="mt-1 flex h-9 w-full items-center justify-center gap-1.5 rounded-[7px] border border-dashed border-[var(--border)] text-[12px] font-medium text-[var(--text-3)] hover:border-[var(--brand)] hover:text-[var(--brand)]"
  >
    <span className="text-[14px]">＋</span>
    添加自定义供应商
  </button>
)}
```

对于删除按钮，在自定义分组的 ProviderListItem 中增加删除图标：

```tsx
{activeGroup === 'custom' && row.channel && (
  <button
    type="button"
    onClick={(e) => {
      e.stopPropagation()
      if (confirm(`确定删除 "${row.label}"？`)) {
        deleteChannel(row.channel!.id).then(() => reload())
      }
    }}
    className="ml-1 text-[var(--text-3)] hover:text-[#ff4d57]"
  >
    <Trash2 size={12} />
  </button>
)}
```

需要从 `@/lib/desktop-api/channel` 导入 `deleteChannel`。

- [ ] **Step 8: 更新 AgentSettings 传递 props**

确保父组件 `AgentSettings` 正确传递 `activeGroup` 和 `onActiveGroupChange` 给 `ProviderConfigurationWorkbench`。

- [ ] **Step 9: 运行 Web 类型检查**

```bash
cd apps/web && npx tsc --noEmit
```

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/components/settings/AgentSettings.tsx
git commit -m "feat(web): 分组标签栏替换原筛选，支持自定义 Provider 添加/删除"
```

---

## Task 6: Web — ChannelForm 自定义 Provider 协议选择器

**Files:**
- Modify: `apps/web/src/components/settings/ChannelForm.tsx`

- [ ] **Step 1: 导入 CUSTOM_API_FAMILIES**

```typescript
import { PROVIDER_LABELS, PROVIDER_DEFAULT_URLS, CUSTOM_API_FAMILIES } from '@lume/shared'
import type { ProviderApiFamily } from '@lume/shared'
```

- [ ] **Step 2: 新增 apiFamily state**

```typescript
const [apiFamily, setApiFamily] = useState<ProviderApiFamily>(
  initialValue?.apiFamily ?? 'openai'
)
```

在 `useEffect` 的 reset 逻辑中加入：

```typescript
setApiFamily(initialValue?.apiFamily ?? 'openai')
```

- [ ] **Step 3: 在表单中添加协议选择器（仅自定义 Provider）**

在"供应商"选择器之后，添加条件渲染的协议选择器：

```tsx
{provider === 'custom' && (
  <div className="space-y-1.5">
    <Label>协议类型</Label>
    <Select
      value={apiFamily}
      onValueChange={(v) => setApiFamily(v as ProviderApiFamily)}
      disabled={disabled}
    >
      <SelectTrigger><SelectValue /></SelectTrigger>
      <SelectContent>
        {CUSTOM_API_FAMILIES.map((option) => (
          <SelectItem key={option.value + option.label} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  </div>
)}
```

> 注：由于 CUSTOM_API_FAMILIES 有两个 value 为 `'openai'` 的项，需要用 `value + label` 作为 key 来区分。但 `SelectItem` 的 value 必须唯一，所以需要调整方案：用 label 作为 value，再映射回 ProviderApiFamily。

修正方案——直接用 ProviderApiFamily 值作为 Select 的 value：

```tsx
{provider === 'custom' && (
  <div className="space-y-1.5">
    <Label>协议类型</Label>
    <Select
      value={apiFamily}
      onValueChange={(v) => setApiFamily(v as ProviderApiFamily)}
      disabled={disabled}
    >
      <SelectTrigger><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="openai">OpenAI</SelectItem>
        <SelectItem value="anthropic">Anthropic</SelectItem>
      </SelectContent>
    </Select>
  </div>
)}
```

- [ ] **Step 4: handleSubmit 中包含 apiFamily**

```typescript
await onSubmit({
  name: name || PROVIDER_LABELS[provider],
  provider,
  baseUrl,
  apiKey,
  apiFamily: provider === 'custom' ? apiFamily : undefined,
  models,
  enabled: true,
})
```

- [ ] **Step 5: 运行 Web 类型检查**

```bash
cd apps/web && npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/settings/ChannelForm.tsx
git commit -m "feat(web): ChannelForm 自定义 Provider 协议选择器"
```

---

## Task 7: Web — Provider 图标映射更新

**Files:**
- Modify: `apps/web/src/components/model-selection/provider-icon-map.tsx`

- [ ] **Step 1: 新增 4 个编程套餐 Provider 的图标映射**

`@lobehub/icons` 中已确认有以下品牌图标：`AlibabaCloud`, `Volcengine`, `Minimax`, `XiaomiMiMo`, `Kimi`, `SiliconCloud`, `Jina`。

在 import 中追加：

```typescript
import {
  // ... 现有的
  AlibabaCloud,
  Volcengine,
  XiaomiMiMo,
  Kimi,
  SiliconCloud,
  Jina,
} from '@lobehub/icons'
```

在 `PROVIDER_ICON_MAP` 中追加（同时补充缺失的 jina、siliconflow、kimi-coding、ollama、lmstudio、opencode）：

```typescript
// 编程套餐
'kimi-coding': Moonshot as BrandIcon,        // 复用 Moonshot 图标
'aliyun-coding-plan': AlibabaCloud as BrandIcon,
'volcengine-coding-plan': Volcengine as BrandIcon,
'minimax-token-plan': Minimax as BrandIcon,
'xiaomi-token-plan': XiaomiMiMo as BrandIcon,
// 补充其他缺失的
jina: Jina as BrandIcon,
siliconflow: SiliconCloud as BrandIcon,
```

- [ ] **Step 2: 运行 Web 类型检查**

```bash
cd apps/web && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/model-selection/provider-icon-map.tsx
git commit -m "feat(web): 新增编程套餐 Provider 图标映射"
```

---

## Task 8: 集成验证

**Files:** 无新增，端到端验证

- [ ] **Step 1: 全量类型检查**

```bash
# shared
cd packages/shared && npx tsc --noEmit

# sidecar
cd apps/sidecar && npx tsc --noEmit

# web
cd apps/web && npx tsc --noEmit
```

- [ ] **Step 2: 运行现有测试**

```bash
# shared channel 测试
cd packages/shared && npx vitest run src/types/channel.test.ts

# sidecar model-selection 测试
cd apps/sidecar && npx vitest run src/services/channel/model-selection.test.ts

# web ChannelForm 测试
cd apps/web && npx vitest run src/components/settings/ChannelForm.test.ts
```

Expected: 所有现有测试通过（新 ProviderType 应不影响已有测试逻辑）

- [ ] **Step 3: 手动启动应用验证 UI**

```bash
# 启动开发环境
pnpm dev
```

验证：
1. 打开设置 → 模型标签页
2. 左侧面板应显示分组标签栏（全部/编程套餐/国内平台/海外平台/中转/聚合/本地/其他/自定义）
3. 点击不同标签，列表正确过滤
4. 编程套餐标签下显示 6 个新 Provider（含默认 URL）
5. 自定义标签下显示"+ 添加自定义供应商"按钮
6. 添加自定义 Provider 时可选择 OpenAI 或 Anthropic 协议
7. 自定义 Provider 可删除
8. 搜索功能在分组过滤基础上叠加工作
