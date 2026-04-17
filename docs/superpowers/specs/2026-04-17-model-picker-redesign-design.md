# Model Picker UI Redesign

Date: 2026-04-17
Status: Draft
Scope: Visual redesign of the thread-level ModelPicker dropdown component
Depends on: `2026-04-17-model-selection-design.md` (approved system architecture)

## Summary

Redesign the thread-level ModelPicker component to improve visual quality, add model metadata display, and introduce search filtering. The redesign follows the existing "enhanced dropdown" interaction pattern — trigger button + dropdown menu — while matching a reference visual style characterized by compact layouts, subtle opacity layering, and scaled capability rows.

## Goals

- Match the reference design's visual style: compact, muted opacity hierarchy, `scale(0.75)` capability rows
- Add provider icons via `@lobehub/icons` ProviderIcon component
- Display model metadata: context window, capability icons, pricing
- Add search/filter functionality for the model list
- Keep the existing interaction pattern (dropdown, not modal/drawer)

## Non-Goals

- Changing the interaction paradigm (staying with dropdown, not modal or drawer)
- Redesigning the settings surface (DefaultModelStrategyPanel)
- Adding advanced filtering by capability, price range, or provider
- Model recommendation or ranking
- Changing backend model resolution logic

## Visual Design

### Reference style characteristics

The redesign replicates and enhances the following visual patterns from the reference design:

- **Compact two-line rows**: Model name (14px font-medium) on top, metadata row below
- **Scaled metadata row**: `transform: scale(0.75); transform-origin: left;` with `opacity: 0.8` for the entire capability area
- **Subtle opacity hierarchy**: Secondary icons at `opacity: 0.5`, text labels at `opacity: 0.5`, pricing at `opacity: 0.4`
- **Selection state**: `bg-primary/15` (light) / `bg-primary/25` (dark) with no border, just background
- **Check indicator**: Left-aligned lucide Check icon, `opacity: 0` when not selected, visible with accent color when selected
- **Rounded corners**: Items use `rounded-sm` (6px), container uses `rounded-xl` (12px)

### Trigger button

```
[ProviderIcon(16px)] Model Name  [200K badge]  [▾]
```

- Left: `ProviderIcon` from `@lobehub/icons`, `size={16}`, `type="avatar"` or fallback to generic icon
- Center: Model name, `font-medium text-sm`, truncated at 160px
- Right: Context window badge (`text-[11px] text-muted-foreground bg-secondary px-1.5 py-0.5 rounded`) + chevron down
- Override state: Additional "已覆盖" badge in accent color

### Dropdown menu

Layout from top to bottom:

1. **Search bar**: `⌕ 搜索模型...` — filters model list by name in real-time
2. **Channel groups**: Each group has a header + model items
3. **Footer bar**: Override status text + "恢复默认" action link

### Channel group header

```
[ProviderIcon(14px)] Channel Name
```

- `text-xs font-medium text-muted-foreground`
- Icon + name inline with `-ml-0.5` alignment
- Icon from `@lobehub/icons` ProviderIcon, mapped from channel provider field

### Model item row

```
[✓] Model Name
    [wrench] [brain] [eye] 200K  $X/$Y
```

- **Line 1**: Model name, `text-sm font-medium truncate`
- **Line 2** (scaled 0.75, origin-left):
  - Capability icons (lucide): `Wrench` (tool use), `Brain` (reasoning), `Eye` (vision)
  - Context window: `text-[9px] font-medium opacity-50`
  - Pricing: `text-[9px] font-medium opacity-40`, format `$input/$output` per 1M tokens
- **Left check**: `lucide Check h-4 w-4`, `opacity-0` when not selected, `text-accent` when selected
- **Hover**: `cursor-pointer` with subtle background transition

### Pricing format

- Format: `$input/$output` (per 1M tokens)
- Example: `$3/$15`, `$0.8/$4`, `$15/$75`
- Display only when pricing data is available; omit the field entirely if unknown
- Positioned at the right end of the capability row, lowest opacity layer (0.4)

## Data Model

### Static model metadata

A new static data file in `packages/shared` provides model metadata that cannot be inferred from the channel configuration alone.

**Location**: `packages/shared/src/data/model-meta.ts`

**Shape**:

```typescript
interface ModelMeta {
  /** Canonical model ID used for matching (e.g., "claude-sonnet-4-20250514") */
  id: string
  /** Aliases that also match this entry (e.g., ["claude-3-5-sonnet", "claude-sonnet-4"]) */
  aliases?: string[]
  /** Human-readable display name */
  displayName: string
  /** Context window size in tokens */
  contextWindow: number
  /** Capabilities */
  capabilities: {
    vision?: boolean
    toolUse?: boolean
    reasoning?: boolean
  }
  /** Pricing per 1M tokens (USD) */
  pricing?: {
    input: number
    output: number
  }
  /** Brief description (optional, for future tooltip/expand) */
  description?: string
}

type ModelMetaRegistry = ModelMeta[]
```

**Matching logic**: Given a model ID from a channel, find the first `ModelMeta` where `id` matches or the model ID appears in `aliases`. If no match is found, the model displays with name only (no metadata row enhancement).

### Provider icon mapping

**Location**: `apps/web/src/components/model-selection/provider-icon-map.ts`

Maps channel `provider` field to `@lobehub/icons` provider names:

```typescript
const PROVIDER_ICON_MAP: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  gemini: 'google',
  deepseek: 'deepseek',
  ollama: 'ollama',
  groq: 'groq',
  mistral: 'mistral',
  // ... extend as needed
}
```

Fallback for unmapped providers: generic `Cpu` icon from lucide-react.

## Component Architecture

### Modified components

**`ModelPicker.tsx`** (trigger + dropdown container):
- Add search state and filtering logic
- Update trigger to show ProviderIcon
- Pass filtered groups to ModelOptionList
- Handle keyboard navigation (↑↓ arrows, Enter, Escape)

**`model-selection-state.ts`** (shared logic):
- Update `buildModelSelectionGroups()` to merge `ModelMeta` data into each model option
- Add `buildFilteredGroups(groups, searchTerm)` for search filtering
- Each model option gains optional `meta?: ModelMeta` field

**`ModelOptionList.tsx`** (presentational list):
- Accept enhanced model options that include `meta` field
- Render enhanced model items with capability icons, context window, pricing from meta
- Render channel group headers with ProviderIcon
- Show search-empty state when filter yields no results

### New files

**`packages/shared/src/data/model-meta.ts`**:
- Static model metadata registry
- Lookup helper function `findModelMeta(modelId: string): ModelMeta | undefined`

**`apps/web/src/components/model-selection/provider-icon-map.ts`**:
- Provider name to `@lobehub/icons` provider mapping
- `ProviderIcon` wrapper component with fallback

### New dependency

**`@lobehub/icons`**: Added to `apps/web/package.json`

## Interaction Details

### Search filtering

- Debounced input (150ms) filters model names across all channel groups
- Empty groups (all models filtered out) are hidden
- Clear search button (×) appears when input is non-empty
- Search state is local to the dropdown; reset on close

### Keyboard navigation

- `↑` / `↓`: Move focus between model items
- `Enter`: Select the focused model
- `Escape`: Close the dropdown without changes
- Focus trap within dropdown while open

### Selection behavior

- Unchanged from current implementation: immediate application via `agent:update-thread-model-selection`
- Loading state on the selected item during the API call
- Error toast on failure

### Override indicator

- Footer bar shows "已覆盖默认策略" when `modelSelectionSource === 'thread-override'`
- "恢复默认" link calls the existing clear-override logic

## Capability Icon Mapping

| Capability | Lucide icon | Meaning |
|-----------|-------------|---------|
| `vision` | `Eye` | Supports image/vision input |
| `toolUse` | `Wrench` | Supports function/tool calling |
| `reasoning` | `Brain` | Extended reasoning / thinking mode |

Icons render at `h-2.5 w-2.5 opacity-50` within the scaled row, same as the reference design.

## Edge Cases

### Model without metadata

When `findModelMeta()` returns undefined for a model:
- Show model name only (line 1)
- Skip the metadata row entirely (no broken partial display)
- Still show the check indicator if selected

### Unknown provider

When a channel's provider is not in `PROVIDER_ICON_MAP`:
- Use `Cpu` icon from lucide-react as fallback
- Channel group header still shows the channel name

### No search results

When all models are filtered out:
- Show empty state: "没有匹配的模型" with muted styling
- Keep the search input focused for easy correction

## Testing Strategy

### Unit tests

- `findModelMeta()` matches by id and aliases
- `buildModelSelectionGroups()` correctly merges meta data
- Search filtering produces correct results
- Provider icon mapping returns correct provider names

### Component tests

- ModelPicker renders trigger with correct model name and provider icon
- Dropdown shows search bar and grouped model list
- Model items display capability icons, context window, pricing
- Selection triggers the correct API call
- Override state displays footer bar correctly
- Keyboard navigation works (↑↓ Enter Escape)

### Integration tests

- End-to-end model switch updates thread state
- Clearing override restores inherited model
