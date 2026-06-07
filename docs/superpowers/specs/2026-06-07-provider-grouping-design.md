# Provider 分组功能设计

## 概述

为供应商配置界面的左侧列表增加分组概念，用分类标签栏替换原有的"全部/已配置/未配置"筛选，并支持自定义 Provider 的添加和管理。

## 分组定义

| 分组 Key | 显示名称 | 包含的 Provider |
|----------|----------|----------------|
| `all` | 全部 | 所有（虚拟分组，不做过滤） |
| `coding-plan` | 编程套餐 | `kimi-coding`, `zai-coding-plan`, `aliyun-coding-plan`, `volcengine-coding-plan`, `minimax-token-plan`, `xiaomi-token-plan` |
| `domestic` | 国内平台 | `deepseek`, `moonshot`, `minimax`, `minimax-cn`, `doubao`, `qwen`, `qwen-portal`, `zai` |
| `overseas` | 海外平台 | `anthropic`, `anthropic-compatible`, `openai`, `google`, `jina` |
| `transit` | 中转/聚合 | `openrouter`, `siliconflow`, `opencode` |
| `local` | 本地/其他 | `ollama`, `lmstudio` |
| `custom` | 自定义 | `custom`（支持多个 Channel） |

## 数据模型变更

### 1. 新增 ProviderType（shared/types/channel.ts）

新增 4 个编程套餐 Provider：

```typescript
export type ProviderType =
  | ... // 现有的
  | 'aliyun-coding-plan'      // 阿里云 Coding Plan
  | 'volcengine-coding-plan'  // 火山方舟 Coding Plan
  | 'minimax-token-plan'      // MiniMax Token Plan
  | 'xiaomi-token-plan'       // 小米 MiMo Token Plan
```

对应的默认 URL：

```typescript
'aliyun-coding-plan': 'https://coding.dashscope.aliyuncs.com/v1',
'volcengine-coding-plan': 'https://ark.cn-beijing.volces.com/api/coding/v3',
'minimax-token-plan': 'https://api.minimaxi.com/anthropic/v1',
'xiaomi-token-plan': 'https://token-plan-cn.xiaomimimo.com/v1',
```

对应的协议家族（全部为 `openai`，MiniMax Token Plan 和 Anthropic 兼容可按实际情况调整）：

```typescript
'aliyun-coding-plan': 'openai',
'volcengine-coding-plan': 'openai',
'minimax-token-plan': 'anthropic',  // 使用 anthropic 协议
'xiaomi-token-plan': 'openai',
```

### 2. 更新现有 Provider 标签

```typescript
'kimi-coding': 'Kimi Code Plan',
'zai-coding-plan': '智谱 GLM Coding Plan',
```

### 3. 新增 ProviderGroup 类型（shared/types/channel.ts）

```typescript
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

### 4. Channel 新增 apiFamily 字段（shared/types/channel.ts）

```typescript
export interface Channel {
  // ... 现有字段
  /** 自定义渠道的协议家族（仅 provider='custom' 时使用） */
  apiFamily?: ProviderApiFamily
}
```

`apiFamily` 仅当 `provider === 'custom'` 时有意义。其他 Provider 从 `PROVIDER_API_FAMILIES` 查表获取。

### 5. 自定义协议选项

自定义 Provider 支持选择以下两种协议（已确认：OpenAI 和 OpenAI Compatible 在代码层面无差异，共用 `OpenAIAdapter`，无需区分）：

```typescript
export const CUSTOM_API_FAMILIES: Array<{ value: ProviderApiFamily; label: string }> = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
]
```

## UI 变更

### ProviderConfigurationWorkbench 重构

**左侧面板**：

1. 顶部：分组标签栏（水平滚动，替换原来的"全部/已配置/未配置"）
   - 标签：全部 | 编程套餐 | 国内平台 | 海外平台 | 中转/聚合 | 本地/其他 | 自定义
2. 搜索框（保留现有）
3. Provider 列表（根据选中分组过滤）
4. **"自定义"标签页专属**：列表底部显示 "+ 添加自定义供应商" 按钮

**右侧面板**：

- 非"自定义"标签页：显示选中 Provider 的配置表单（与现有行为一致）
- "自定义"标签页：
  - 选中已有自定义 Channel 时：显示编辑表单（含协议选择器）
  - 点击"+ 添加"时：显示创建表单，包含：
    - 供应商名称（必填）
    - 协议类型（下拉选择：OpenAI / Anthropic）
    - Base URL
    - API Key
    - 模型列表（拉取按钮）

### 交互逻辑

- 点击分组标签 → 过滤左侧列表
- "全部"标签显示所有 Provider（含自定义 Channel）
- "自定义"标签中，每个自定义 Channel 作为独立列表项显示
- 切换分组标签不清除搜索文本
- 自定义 Channel 的显示名称使用 `channel.name`
- 自定义 Channel 支持删除（列表项右键或滑动显示删除按钮，确认后删除）

### agent-settings-state.ts

**新增状态**：

```typescript
const [activeGroup, setActiveGroup] = useState<ProviderGroup>('all')
```

**修改 buildModelProviderRows**：

- 内置 Provider：行为不变（从 `PROVIDER_LABELS` 构建）
- 自定义 Provider：从 channels 中筛选 `provider === 'custom'`，每个 Channel 生成一个独立的 `ModelProviderRow`
  - `provider` 字段为 `'custom'`
  - `label` 字段使用 `channel.name`
  - `channelId` 字段用于区分多个自定义 Channel

**修改 ModelProviderRow**：

```typescript
export interface ModelProviderRow {
  provider: ProviderType
  label: string
  channel: Channel | null
  tone: string
  channelId?: string  // 自定义 Channel 的唯一标识
}
```

**过滤逻辑**：

```typescript
const filteredProviderRows = providerRows.filter((row) => {
  // 分组过滤
  if (activeGroup !== 'all') {
    const groupInfo = PROVIDER_GROUPS.find(g => g.key === activeGroup)
    if (groupInfo && !groupInfo.providers.includes(row.provider)) return false
  }
  // 搜索过滤（保留现有逻辑）
  const query = providerSearch.trim().toLowerCase()
  // ...
})
```

### AgentSettings 状态变更

- 移除 `providerFilter` 状态（被 `activeGroup` 替代）
- 新增 `activeGroup` 状态
- 自定义标签页中，`activeProvider` 变为通过 `channelId` 追踪选中项

## 文件变更清单

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `packages/shared/src/types/channel.ts` | 修改 | 新增 ProviderType、ProviderGroup、PROVIDER_GROUPS、Channel.apiFamily |
| `apps/web/src/components/settings/AgentSettings.tsx` | 修改 | 分组标签 UI、状态管理调整 |
| `apps/web/src/components/settings/agent-settings-state.ts` | 修改 | buildModelProviderRows 支持分组和自定义 |
| `apps/web/src/components/settings/ChannelForm.tsx` | 修改 | 自定义 Provider 的协议选择器 |
| `apps/web/src/components/model-selection/provider-icon-map.tsx` | 修改 | 新增 Provider 图标映射 |
| `apps/web/src/components/settings/ChannelForm.tsx` | 修改 | 自定义 Provider 的协议选择器、删除按钮 |

## 已确认

- [x] OpenAI 和 OpenAI Compatible → 协议值相同（`openai`），代码层面无差异，合并为一个选项
- [x] 自定义 Channel 需要支持删除功能
- [x] `minimax-token-plan` 协议家族为 `anthropic`（URL 路径含 `/anthropic/v1`，使用 `x-api-key` 认证头）
