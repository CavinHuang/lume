# Model Picker UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the thread-level ModelPicker with provider icons, model metadata, and search filtering, matching a compact reference visual style.

**Architecture:** Add a static model metadata registry in `packages/shared` and a provider icon mapping layer. Enhance the existing `ModelOptionList` to display capabilities, context window, and pricing. Add search filtering to the `ModelPicker` dropdown. Install `@lobehub/icons` for provider brand icons.

**Tech Stack:** React, TypeScript, Tailwind CSS, Jotai, lucide-react, @lobehub/icons, Bun Test

---

## File Structure

### New files
- `packages/shared/src/data/model-meta.ts` — static model metadata registry + lookup helper
- `packages/shared/src/data/model-meta.test.ts` — tests for lookup logic
- `apps/web/src/components/model-selection/provider-icon-map.tsx` — ProviderType → @lobehub/icons mapping + wrapper component

### Modified files
- `packages/shared/src/index.ts` — re-export model-meta
- `apps/web/src/components/model-selection/model-selection-state.ts` — extend ModelSelectionOption with meta, update buildModelSelectionGroups
- `apps/web/src/components/model-selection/model-selection-state.test.ts` — update existing tests + add meta-related tests
- `apps/web/src/components/model-selection/ModelOptionList.tsx` — enhanced visual rendering with provider icons, capability icons, metadata
- `apps/web/src/components/agent/ModelPicker.tsx` — add search, provider icon on trigger, keyboard nav

---

### Task 1: Install @lobehub/icons

**Files:**
- Modify: `apps/web/package.json`

- [ ] **Step 1: Install the package**

Run: `cd apps/web && bun add @lobehub/icons`

- [ ] **Step 2: Verify installation**

Run: `cd apps/web && bun run typecheck`
Expected: No new type errors from the new dependency

- [ ] **Step 3: Commit**

```bash
git add apps/web/package.json bun.lock
git commit -m "chore: add @lobehub/icons dependency for provider icons"
```

---

### Task 2: Create model metadata registry

**Files:**
- Create: `packages/shared/src/data/model-meta.ts`
- Create: `packages/shared/src/data/model-meta.test.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/data/model-meta.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test'
import { findModelMeta } from './model-meta'

describe('findModelMeta', () => {
  test('matches by exact model id', () => {
    const meta = findModelMeta('claude-sonnet-4-20250514')
    expect(meta).toBeDefined()
    expect(meta!.displayName).toBe('Claude Sonnet 4')
    expect(meta!.contextWindow).toBe(200_000)
  })

  test('matches by alias', () => {
    const meta = findModelMeta('claude-3-5-sonnet')
    expect(meta).toBeDefined()
    expect(meta!.displayName).toBe('Claude Sonnet 4')
  })

  test('returns undefined for unknown model', () => {
    expect(findModelMeta('unknown-model-xyz')).toBeUndefined()
  })

  test('returns pricing when available', () => {
    const meta = findModelMeta('claude-sonnet-4-20250514')
    expect(meta!.pricing).toEqual({ input: 3, output: 15 })
  })

  test('returns capabilities correctly', () => {
    const meta = findModelMeta('claude-sonnet-4-20250514')
    expect(meta!.capabilities).toEqual({
      vision: true,
      toolUse: true,
      reasoning: true,
    })
  })

  test('matches OpenAI models', () => {
    const meta = findModelMeta('gpt-4o')
    expect(meta).toBeDefined()
    expect(meta!.displayName).toBe('GPT-4o')
    expect(meta!.contextWindow).toBe(128_000)
  })

  test('matches Gemini models', () => {
    const meta = findModelMeta('gemini-2.5-pro')
    expect(meta).toBeDefined()
    expect(meta!.displayName).toBe('Gemini 2.5 Pro')
    expect(meta!.contextWindow).toBe(1_000_000)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/shared/src/data/model-meta.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create the model metadata registry**

Create `packages/shared/src/data/model-meta.ts`:

```typescript
/**
 * Static model metadata registry.
 *
 * Provides human-readable information about known models:
 * display name, context window, capabilities, and pricing.
 * Unknown models gracefully degrade to name-only display.
 */

export interface ModelCapabilities {
  vision?: boolean
  toolUse?: boolean
  reasoning?: boolean
}

export interface ModelPricing {
  /** USD per 1M input tokens */
  input: number
  /** USD per 1M output tokens */
  output: number
}

export interface ModelMeta {
  /** Canonical model ID for exact matching */
  id: string
  /** Alternative IDs/names that also match this entry */
  aliases?: string[]
  /** Human-readable display name */
  displayName: string
  /** Context window size in tokens */
  contextWindow: number
  /** Model capabilities */
  capabilities: ModelCapabilities
  /** Pricing per 1M tokens (USD), omitted if unknown */
  pricing?: ModelPricing
  /** Brief description for future tooltip use */
  description?: string
}

/**
 * Registry of known model metadata.
 * Keep entries sorted by provider for maintainability.
 */
const MODEL_META_REGISTRY: ModelMeta[] = [
  // ── Anthropic ──────────────────────────────────────────
  {
    id: 'claude-sonnet-4-20250514',
    aliases: ['claude-sonnet-4', 'claude-3-5-sonnet', 'claude-3-5-sonnet-20241022', 'claude-3.5-sonnet'],
    displayName: 'Claude Sonnet 4',
    contextWindow: 200_000,
    capabilities: { vision: true, toolUse: true, reasoning: true },
    pricing: { input: 3, output: 15 },
    description: '擅长代码和日常任务',
  },
  {
    id: 'claude-opus-4-20250514',
    aliases: ['claude-opus-4', 'claude-3-opus', 'claude-3-opus-20240229'],
    displayName: 'Claude Opus 4',
    contextWindow: 200_000,
    capabilities: { vision: true, toolUse: true, reasoning: true },
    pricing: { input: 15, output: 75 },
    description: '最强推理能力',
  },
  {
    id: 'claude-haiku-4-5-20251001',
    aliases: ['claude-haiku-4-5', 'claude-3-5-haiku', 'claude-3-5-haiku-20241022'],
    displayName: 'Claude Haiku 4.5',
    contextWindow: 200_000,
    capabilities: { vision: true, toolUse: true, reasoning: false },
    pricing: { input: 0.8, output: 4 },
    description: '快速响应，经济实惠',
  },

  // ── OpenAI ─────────────────────────────────────────────
  {
    id: 'gpt-4o',
    aliases: ['gpt-4o-2024-11-20', 'gpt-4o-2024-08-06'],
    displayName: 'GPT-4o',
    contextWindow: 128_000,
    capabilities: { vision: true, toolUse: true, reasoning: false },
    pricing: { input: 2.5, output: 10 },
    description: 'OpenAI 旗舰模型',
  },
  {
    id: 'gpt-4o-mini',
    aliases: ['gpt-4o-mini-2024-07-18'],
    displayName: 'GPT-4o mini',
    contextWindow: 128_000,
    capabilities: { vision: true, toolUse: true, reasoning: false },
    pricing: { input: 0.15, output: 0.6 },
  },
  {
    id: 'o3',
    aliases: ['o3-2025-04-16'],
    displayName: 'o3',
    contextWindow: 200_000,
    capabilities: { vision: true, toolUse: true, reasoning: true },
    pricing: { input: 10, output: 40 },
  },
  {
    id: 'o3-mini',
    aliases: ['o3-mini-2025-01-31'],
    displayName: 'o3-mini',
    contextWindow: 200_000,
    capabilities: { vision: false, toolUse: true, reasoning: true },
    pricing: { input: 1.1, output: 4.4 },
  },
  {
    id: 'o4-mini',
    aliases: ['o4-mini-2025-04-16'],
    displayName: 'o4-mini',
    contextWindow: 200_000,
    capabilities: { vision: true, toolUse: true, reasoning: true },
    pricing: { input: 1.1, output: 4.4 },
  },

  // ── Google ─────────────────────────────────────────────
  {
    id: 'gemini-2.5-pro',
    aliases: ['gemini-2.5-pro-preview-05-06'],
    displayName: 'Gemini 2.5 Pro',
    contextWindow: 1_000_000,
    capabilities: { vision: true, toolUse: true, reasoning: true },
    pricing: { input: 1.25, output: 10 },
    description: '超长上下文窗口',
  },
  {
    id: 'gemini-2.5-flash',
    aliases: ['gemini-2.5-flash-preview-05-20'],
    displayName: 'Gemini 2.5 Flash',
    contextWindow: 1_000_000,
    capabilities: { vision: true, toolUse: true, reasoning: true },
    pricing: { input: 0.15, output: 0.6 },
  },
  {
    id: 'gemini-2.0-flash',
    displayName: 'Gemini 2.0 Flash',
    contextWindow: 1_000_000,
    capabilities: { vision: true, toolUse: true, reasoning: false },
    pricing: { input: 0.1, output: 0.4 },
  },

  // ── DeepSeek ───────────────────────────────────────────
  {
    id: 'deepseek-r1',
    aliases: ['deepseek-reasoner'],
    displayName: 'DeepSeek R1',
    contextWindow: 128_000,
    capabilities: { vision: false, toolUse: false, reasoning: true },
    pricing: { input: 0.55, output: 2.19 },
  },
  {
    id: 'deepseek-chat',
    aliases: ['deepseek-v3'],
    displayName: 'DeepSeek V3',
    contextWindow: 128_000,
    capabilities: { vision: false, toolUse: true, reasoning: false },
    pricing: { input: 0.27, output: 1.1 },
  },
]

/** Build a lookup map from IDs and aliases to ModelMeta entries */
function buildLookupMap(): Map<string, ModelMeta> {
  const map = new Map<string, ModelMeta>()
  for (const meta of MODEL_META_REGISTRY) {
    map.set(meta.id, meta)
    if (meta.aliases) {
      for (const alias of meta.aliases) {
        map.set(alias, meta)
      }
    }
  }
  return map
}

const lookupMap = buildLookupMap()

/**
 * Find model metadata by model ID.
 * Checks exact ID match first, then known aliases.
 * Returns undefined for unknown models.
 */
export function findModelMeta(modelId: string): ModelMeta | undefined {
  // Exact match
  const exact = lookupMap.get(modelId)
  if (exact) return exact

  // Try case-insensitive match for common variations
  const lower = modelId.toLowerCase()
  for (const [key, meta] of lookupMap) {
    if (key.toLowerCase() === lower) return meta
  }

  // Try prefix match (e.g., "claude-sonnet-4-20250514" from "claude-sonnet-4")
  for (const meta of MODEL_META_REGISTRY) {
    if (modelId.startsWith(meta.id) || meta.id.startsWith(modelId)) return meta
    if (meta.aliases?.some((alias) => modelId.startsWith(alias) || alias.startsWith(modelId))) return meta
  }

  return undefined
}

/** Format context window size for display */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${tokens / 1_000_000}M`
  if (tokens >= 1_000) return `${tokens / 1_000}K`
  return String(tokens)
}

/** Format pricing for display */
export function formatPricing(pricing: ModelPricing): string {
  const fmt = (n: number) => (n < 1 ? String(n) : String(n))
  return `$${fmt(pricing.input)}/$${fmt(pricing.output)}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/shared/src/data/model-meta.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Re-export from shared index**

Add to `packages/shared/src/index.ts` after the existing exports:

```typescript
export * from "./data/model-meta";
```

- [ ] **Step 6: Verify typecheck**

Run: `bun run --filter @lume/shared typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/data/ packages/shared/src/index.ts
git commit -m "feat(shared): add model metadata registry with lookup helper"
```

---

### Task 3: Create provider icon mapping

**Files:**
- Create: `apps/web/src/components/model-selection/provider-icon-map.tsx`

- [ ] **Step 1: Create the provider icon mapping component**

Create `apps/web/src/components/model-selection/provider-icon-map.tsx`:

```tsx
/**
 * Maps ProviderType to @lobehub/icons provider names.
 * Falls back to a generic Cpu icon for unknown providers.
 */
import { Cpu } from 'lucide-react'
import { ProviderIcon } from '@lobehub/icons'
import type { ProviderType } from '@lume/shared'

/** Maps our ProviderType values to @lobehub/icons provider identifier strings */
const PROVIDER_ICON_MAP: Partial<Record<ProviderType, string>> = {
  anthropic: 'anthropic',
  'anthropic-compatible': 'anthropic',
  openai: 'openai',
  google: 'google',
  deepseek: 'deepseek',
  ollama: 'ollama',
  openrouter: 'openrouter',
  minimax: 'minimax',
  'minimax-cn': 'minimax',
  moonshot: 'moonshot',
  zhipu: 'zhipu',
  zai: 'zhipu',
  qwen: 'qwen',
  'qwen-portal': 'qwen',
  groq: 'groq',
  mistral: 'mistral',
  doubao: 'doubao',
}

interface ChannelProviderIconProps {
  provider: ProviderType
  size?: number
  className?: string
}

/**
 * Renders the appropriate provider icon for a given ProviderType.
 * Falls back to a generic Cpu icon for unmapped providers.
 */
export function ChannelProviderIcon({ provider, size = 14, className }: ChannelProviderIconProps) {
  const iconProvider = PROVIDER_ICON_MAP[provider]

  if (iconProvider) {
    return <ProviderIcon provider={iconProvider} size={size} type="avatar" shape="square" className={className} />
  }

  return <Cpu size={size} className={className} />
}

/** Get the @lobehub/icons provider name for a ProviderType, or null if unmapped */
export function getProviderIconName(provider: ProviderType): string | null {
  return PROVIDER_ICON_MAP[provider] ?? null
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: PASS (no type errors)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/model-selection/provider-icon-map.tsx
git commit -m "feat(web): add provider icon mapping with @lobehub/icons"
```

---

### Task 4: Extend model selection state with metadata

**Files:**
- Modify: `apps/web/src/components/model-selection/model-selection-state.ts`
- Modify: `apps/web/src/components/model-selection/model-selection-state.test.ts`

- [ ] **Step 1: Write failing tests for meta merging**

Add to `apps/web/src/components/model-selection/model-selection-state.test.ts`:

```typescript
import { findModelMeta, type ModelMeta } from '@lume/shared'

// Add a describe block at the end of the file:

describe('buildModelSelectionGroups with metadata', () => {
  test('augments each option with matching ModelMeta', () => {
    const result = buildModelSelectionGroups({
      channels,
      activeChannelId: 'channel-openai',
      activeModelRef: 'openai/gpt-5',
    })

    // gpt-5 has no match in registry, so meta should be undefined
    expect(result[0].options[0].meta).toBeUndefined()

    // claude-sonnet-4-5 should match via alias
    const openrouterGroup = result[1]
    expect(openrouterGroup.options[0].meta).toBeDefined()
    expect(openrouterGroup.options[0].meta!.displayName).toBe('Claude Sonnet 4')
  })

  test('augments groups with provider field', () => {
    const result = buildModelSelectionGroups({
      channels,
      activeChannelId: 'channel-openai',
      activeModelRef: 'openai/gpt-5',
    })

    expect(result[0].provider).toBe('openai')
    expect(result[1].provider).toBe('openrouter')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/web/src/components/model-selection/model-selection-state.test.ts`
Expected: FAIL — `meta` and `provider` properties don't exist on types

- [ ] **Step 3: Update the types and buildModelSelectionGroups**

Modify `apps/web/src/components/model-selection/model-selection-state.ts`:

```typescript
import type { AgentThreadMeta, Channel, ChannelModel, ModelMeta } from '@lume/shared'
import { findModelMeta } from '@lume/shared'

export interface ModelSelectionOption {
  channelId: string
  modelRef: string
  modelId: string
  label: string
  active: boolean
  /** Static metadata (capabilities, pricing, etc.) if model is known */
  meta?: ModelMeta
}

export interface ModelOptionGroup {
  id: string
  label: string
  /** Provider type for icon rendering */
  provider: string
  options: ModelSelectionOption[]
}

export interface ThreadSelectionSummary {
  label: string
  hasLoadedChannels: boolean
  isOverride: boolean
  isUnavailable: boolean
  /** Static metadata for the effective model, if known */
  meta?: ModelMeta
}

// ... existing helper functions unchanged (normalizeOptional, isCanonicalModelRef, etc.) ...

// Replace buildModelSelectionGroups:
export function buildModelSelectionGroups(input: {
  channels: Channel[]
  activeChannelId?: string
  activeModelRef?: string
}): ModelOptionGroup[] {
  return input.channels
    .filter((channel) => channel.enabled)
    .map((channel) => ({
      id: channel.id,
      label: channel.name,
      provider: channel.provider,
      options: channel.models
        .filter((model) => model.enabled)
        .map((model) => ({
          channelId: channel.id,
          modelId: model.id,
          modelRef: buildModelRef(channel, model.id),
          label: model.name,
          active: matchesSelection({
            channel,
            model,
            activeChannelId: input.activeChannelId,
            activeModelRef: input.activeModelRef,
          }),
          meta: findModelMeta(model.id) ?? findModelMeta(model.name),
        })),
    }))
    .filter((group) => group.options.length > 0)
}
```

Also update `getThreadSelectionSummary` to include meta:

```typescript
export function getThreadSelectionSummary(input: {
  channels: Channel[]
  channelsLoaded?: boolean
  thread?: Pick<AgentThreadMeta, 'channelId' | 'modelRef' | 'modelSelectionSource'> | null
}): ThreadSelectionSummary {
  const hasLoadedChannels = input.channelsLoaded ?? false
  const modelRef = normalizeOptional(input.thread?.modelRef)
  const match = findSelectionMatch({
    channels: input.channels,
    channelId: input.thread?.channelId,
    modelRef,
  })

  if (match) {
    const meta = findModelMeta(match.model.id) ?? findModelMeta(match.model.name)
    return {
      label: match.model.name,
      hasLoadedChannels,
      isOverride: input.thread?.modelSelectionSource === 'thread-override',
      isUnavailable: !match.channel.enabled || !match.model.enabled,
      meta,
    }
  }

  return {
    label: modelRef ?? '',
    hasLoadedChannels,
    isOverride: input.thread?.modelSelectionSource === 'thread-override',
    isUnavailable: hasLoadedChannels && Boolean(modelRef),
  }
}
```

- [ ] **Step 4: Run all model-selection tests**

Run: `bun test apps/web/src/components/model-selection/model-selection-state.test.ts`
Expected: All tests PASS (existing + new)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/model-selection/model-selection-state.ts apps/web/src/components/model-selection/model-selection-state.test.ts
git commit -m "feat(web): extend model selection state with metadata lookup"
```

---

### Task 5: Redesign ModelOptionList with enhanced visuals

**Files:**
- Modify: `apps/web/src/components/model-selection/ModelOptionList.tsx`

- [ ] **Step 1: Rewrite ModelOptionList with enhanced rendering**

Replace the entire content of `apps/web/src/components/model-selection/ModelOptionList.tsx`:

```tsx
import { Brain, Check, Eye, Wrench } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatContextWindow, formatPricing } from '@lume/shared'
import { ChannelProviderIcon } from './provider-icon-map'
import type { ModelOptionGroup, ModelSelectionOption } from './model-selection-state'

interface ModelOptionListProps {
  groups: ModelOptionGroup[]
  onSelect: (option: ModelSelectionOption) => void
}

/** Map capability flags to lucide icons */
function CapabilityIcon({ capability }: { capability: 'vision' | 'toolUse' | 'reasoning' }) {
  const iconMap = {
    vision: Eye,
    toolUse: Wrench,
    reasoning: Brain,
  }
  const Icon = iconMap[capability]
  return <Icon className="size-[10px] opacity-50" />
}

/** Render the scaled metadata row for a model option */
function ModelMetaRow({ meta }: { meta: import('@lume/shared').ModelMeta }) {
  return (
    <div className="flex items-center gap-2 text-muted-foreground/80 scale-[0.75] origin-left">
      {meta.capabilities.vision && <CapabilityIcon capability="vision" />}
      {meta.capabilities.toolUse && <CapabilityIcon capability="toolUse" />}
      {meta.capabilities.reasoning && <CapabilityIcon capability="reasoning" />}
      <span className="text-[9px] font-medium opacity-50">
        {formatContextWindow(meta.contextWindow)}
      </span>
      {meta.pricing && (
        <span className="text-[9px] font-medium opacity-40">
          {formatPricing(meta.pricing)}
        </span>
      )}
    </div>
  )
}

export function ModelOptionList({ groups, onSelect }: ModelOptionListProps) {
  return (
    <div className="py-1">
      {groups.map((group) => (
        <div key={group.id} className="py-0.5">
          {/* Channel group header with provider icon */}
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground flex items-center gap-1.5 -ml-0.5">
            <ChannelProviderIcon provider={group.provider as any} size={16} className="text-foreground/40 shrink-0" />
            <span>{group.label}</span>
          </div>

          {/* Model items */}
          {group.options.map((option) => (
            <button
              key={`${option.channelId}-${option.modelId}`}
              onClick={() => onSelect(option)}
              className={cn(
                'w-full flex items-start gap-2 px-2 py-1.5 text-sm rounded-sm cursor-pointer select-none transition-colors',
                option.active
                  ? 'bg-primary/15 dark:bg-primary/25'
                  : 'hover:bg-muted/50'
              )}
            >
              {/* Check indicator */}
              <Check
                className={cn(
                  'size-4 shrink-0 mt-0.5',
                  option.active ? 'opacity-100 text-primary' : 'opacity-0'
                )}
              />

              {/* Model content */}
              <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                <span className="truncate">{option.label}</span>
                {option.meta && (
                  <div className="flex items-center justify-between">
                    <ModelMetaRow meta={option.meta} />
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/model-selection/ModelOptionList.tsx
git commit -m "feat(web): redesign ModelOptionList with provider icons and metadata"
```

---

### Task 6: Enhance ModelPicker with search and provider icon trigger

**Files:**
- Modify: `apps/web/src/components/agent/ModelPicker.tsx`

- [ ] **Step 1: Rewrite ModelPicker with search, provider icon, and keyboard nav**

Replace the entire content of `apps/web/src/components/agent/ModelPicker.tsx`:

```tsx
/**
 * ModelPicker - 线程模型覆盖选择器
 *
 * 展示当前线程的有效模型，并允许对当前线程设置或清除覆盖。
 * 支持搜索过滤和键盘导航。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Search } from 'lucide-react'
import { useAtom } from 'jotai'
import { agentThreadsAtom } from '@/atoms'
import { sidecarCall } from '@/lib/desktop-api'
import { listChannels } from '@/lib/desktop-api/channel'
import { cn } from '@/lib/utils'
import { ModelOptionList } from '@/components/model-selection/ModelOptionList'
import { ChannelProviderIcon } from '@/components/model-selection/provider-icon-map'
import {
  buildModelSelectionGroups,
  getThreadSelectionSummary,
} from '@/components/model-selection/model-selection-state'
import type { AgentThreadMeta, Channel } from '@lume/shared'

interface ModelPickerProps {
  threadId: string
}

function mergeUpdatedThread(
  threads: AgentThreadMeta[],
  updatedThread: AgentThreadMeta
): AgentThreadMeta[] {
  return threads.map((thread) => (
    thread.id === updatedThread.id
      ? { ...thread, ...updatedThread }
      : thread
  ))
}

/** Filter groups by search term, hiding empty groups */
function filterGroups(
  groups: import('@/components/model-selection/model-selection-state').ModelOptionGroup[],
  searchTerm: string
): import('@/components/model-selection/model-selection-state').ModelOptionGroup[] {
  if (!searchTerm.trim()) return groups

  const lower = searchTerm.toLowerCase()
  return groups
    .map((group) => ({
      ...group,
      options: group.options.filter(
        (opt) =>
          opt.label.toLowerCase().includes(lower) ||
          opt.modelId.toLowerCase().includes(lower)
      ),
    }))
    .filter((group) => group.options.length > 0)
}

export function ModelPicker({ threadId }: ModelPickerProps) {
  const [threads, setThreads] = useAtom(agentThreadsAtom)
  const thread = threads.find((item) => item.id === threadId)
  const [channels, setChannels] = useState<Channel[]>([])
  const [channelsLoaded, setChannelsLoaded] = useState(false)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    listChannels()
      .then((items) => setChannels(items))
      .catch(console.error)
      .finally(() => setChannelsLoaded(true))
  }, [])

  // Close on outside click
  useEffect(() => {
    if (!open) return

    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [open])

  // Focus search input when opening
  useEffect(() => {
    if (open) {
      setSearch('')
      // Defer to next frame so the DOM is ready
      requestAnimationFrame(() => searchInputRef.current?.focus())
    }
  }, [open])

  const groups = useMemo(() => buildModelSelectionGroups({
    channels,
    activeChannelId: thread?.channelId,
    activeModelRef: thread?.modelRef,
  }), [channels, thread?.channelId, thread?.modelRef])

  const filteredGroups = useMemo(() => filterGroups(groups, search), [groups, search])

  const summary = useMemo(() => getThreadSelectionSummary({
    channels,
    channelsLoaded,
    thread,
  }), [channels, channelsLoaded, thread])

  const canRestoreDefault = thread?.modelSelectionSource === 'thread-override'

  const handleSelect = async (input: {
    channelId: string
    modelRef: string
    modelId: string
  }) => {
    setOpen(false)

    try {
      const updatedThread = await sidecarCall<AgentThreadMeta>('agent:update-thread-model-selection', {
        threadId,
        channelId: input.channelId,
        modelRef: input.modelRef,
        modelId: input.modelId,
      })
      setThreads((prev) => mergeUpdatedThread(prev, updatedThread))
    } catch (error) {
      console.error('[ModelPicker] 切换模型失败:', error)
    }
  }

  const handleRestoreDefault = async () => {
    setOpen(false)

    try {
      const updatedThread = await sidecarCall<AgentThreadMeta>('agent:update-thread-model-selection', {
        threadId,
        channelId: null,
        modelRef: null,
        modelId: null,
      })
      setThreads((prev) => mergeUpdatedThread(prev, updatedThread))
    } catch (error) {
      console.error('[ModelPicker] 恢复默认策略失败:', error)
    }
  }

  if (groups.length === 0 && !summary.label) {
    return null
  }

  return (
    <div className="relative flex items-center gap-1.5">
      {/* Trigger button with provider icon */}
      <button
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11.5px] text-foreground/60 hover:bg-muted/50 hover:text-foreground/80 transition-colors"
        title={summary.isUnavailable ? '当前线程模型不可用，点击重新选择' : '切换模型'}
      >
        {summary.meta ? (
          <ChannelProviderIcon provider={thread?.channelId ? (channels.find(c => c.id === thread.channelId)?.provider ?? 'custom') : 'custom'} size={11} />
        ) : undefined}
        <span className="truncate max-w-[160px]">
          {summary.label}
        </span>
        <ChevronDown size={10} className="text-foreground/40" />
      </button>

      {canRestoreDefault && (
        <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
          已覆盖默认
        </span>
      )}
      {summary.hasLoadedChannels && summary.isUnavailable && (
        <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-400">
          当前模型不可用
        </span>
      )}

      {/* Dropdown */}
      {open && (
        <div
          ref={menuRef}
          className="absolute bottom-full mb-1 left-0 z-50 min-w-[260px] max-h-[360px] overflow-y-auto rounded-lg border border-border/60 bg-popover shadow-lg"
        >
          {/* Search input */}
          <div className="p-1.5 border-b border-border/40">
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted/50">
              <Search size={13} className="text-muted-foreground/50 shrink-0" />
              <input
                ref={searchInputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索模型..."
                className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground/50 outline-none"
              />
            </div>
          </div>

          {/* Filtered model list or empty state */}
          {filteredGroups.length > 0 ? (
            <ModelOptionList groups={filteredGroups} onSelect={handleSelect} />
          ) : (
            <div className="py-6 text-center text-xs text-muted-foreground/50">
              没有匹配的模型
            </div>
          )}

          {/* Footer: restore default */}
          {canRestoreDefault && (
            <div className="border-t border-border/50 p-1">
              <button
                onClick={handleRestoreDefault}
                className={cn(
                  'w-full rounded-md px-3 py-1.5 text-left text-[12px] transition-colors',
                  'text-foreground/70 hover:bg-muted/50 hover:text-foreground'
                )}
              >
                恢复默认策略
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/agent/ModelPicker.tsx
git commit -m "feat(web): enhance ModelPicker with search and provider icon trigger"
```

---

### Task 7: Run full verification

**Files:** None (verification only)

- [ ] **Step 1: Run all tests in the project**

Run: `bun test`
Expected: All existing + new tests pass

- [ ] **Step 2: Run typecheck across all packages**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 3: Commit any remaining fixes**

If any test or typecheck failures occurred, fix them and commit:

```bash
git add -u
git commit -m "fix: resolve typecheck and test issues from model picker redesign"
```
