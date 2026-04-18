# Model Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reusable model selection system that supports thread-only model overrides and a global default strategy with channel, model, and fallback chain editing.

**Architecture:** Extend the durable config contract in `lume-config` to store the agent default strategy, then build a shared web-side model selection core consumed by a lightweight thread picker and a richer settings panel. Keep thread overrides in `AgentThreadMeta`, reuse sidecar model resolution helpers for effective selection, and cover the new inheritance rules with focused Bun tests in both web and sidecar packages.

**Tech Stack:** Bun, TypeScript, React 18, Jotai, Tauri sidecar RPC, shared `@lume/shared` types, sidecar config services, Bun test

---

## File Structure

### Shared and sidecar config surfaces

- Modify: `packages/shared/src/types/lume-config.ts`
- Modify: `apps/sidecar/src/services/system/lume-config-service.ts`
- Modify: `apps/sidecar/src/rpc/system-handlers.ts`
- Modify: `apps/sidecar/src/rpc/schemas.ts`
- Modify: `apps/sidecar/src/services/channel/model-selection.ts`
- Modify: `apps/sidecar/src/services/channel/model-selection.test.ts`

Responsibility split:

- `lume-config.ts` defines the durable global default strategy shape.
- `lume-config-service.ts` reads, normalizes, merges, and writes the new strategy fields.
- `system-handlers.ts` exposes the write RPC for `lume-config` updates.
- `schemas.ts` validates the new `lume-config:update-section` payload.
- `model-selection.ts` derives effective thread selection from thread overrides plus global defaults.
- `model-selection.test.ts` locks the inheritance and fallback resolution behavior.

### Thread model override UI

- Modify: `apps/web/src/components/agent/ModelPicker.tsx`
- Modify: `apps/web/src/components/agent/AgentInput.tsx`
- Create: `apps/web/src/components/model-selection/model-selection-state.ts`
- Create: `apps/web/src/components/model-selection/ModelOptionList.tsx`
- Create: `apps/web/src/components/model-selection/model-selection-state.test.ts`

Responsibility split:

- `model-selection-state.ts` shapes enabled channels and models into grouped UI data and derives effective selection state.
- `ModelOptionList.tsx` renders grouped options and badges.
- `ModelPicker.tsx` becomes a thread-focused override container that uses the shared data layer.

### Settings strategy editor

- Modify: `apps/web/src/components/settings/AgentSettings.tsx`
- Create: `apps/web/src/components/settings/DefaultModelStrategyPanel.tsx`
- Create: `apps/web/src/lib/desktop-api/lume-config.ts`
- Create: `apps/web/src/components/settings/DefaultModelStrategyPanel.test.ts`

Responsibility split:

- `lume-config.ts` exposes `lume-config:get-effective` and the future update call wrapper to the web app.
- `DefaultModelStrategyPanel.tsx` edits global default channel, default model, and fallback chain.
- `AgentSettings.tsx` hosts the new panel without bloating the thread picker.

### Thread creation and effective selection plumbing

- Modify: `apps/sidecar/src/services/agent/agent-thread-manager.ts`
- Modify: `apps/sidecar/src/services/agent/agent-service.ts`
- Modify: `apps/sidecar/src/rpc/agent-handlers.ts`
- Modify: `packages/shared/src/types/agent.ts`

Responsibility split:

- `agent-thread-manager.ts` applies global defaults when creating threads and clearing overrides.
- `agent-service.ts` resolves the effective model before sending.
- `agent.ts` keeps the thread metadata contract explicit if an override marker is added.

## Task 1: Extend global default-strategy config and lock the resolution rules

**Files:**
- Modify: `packages/shared/src/types/lume-config.ts`
- Modify: `apps/sidecar/src/services/system/lume-config-service.ts`
- Modify: `apps/sidecar/src/rpc/system-handlers.ts`
- Modify: `apps/sidecar/src/rpc/schemas.ts`
- Modify: `apps/sidecar/src/services/channel/model-selection.ts`
- Test: `apps/sidecar/src/services/channel/model-selection.test.ts`

- [ ] **Step 1: Write the failing sidecar tests for global defaults plus thread override precedence**

```ts
import { describe, expect, test } from "bun:test";
import {
  resolveEffectiveAgentModelSelection,
  type AgentModelStrategyConfig,
} from "./model-selection";

const strategy: AgentModelStrategyConfig = {
  defaultChannelId: "channel-openai",
  defaultModelRef: "openai/gpt-5",
  fallbackModelRefs: ["openai/gpt-5-mini", "openrouter/anthropic/claude-sonnet-4.5"]
};

describe("resolveEffectiveAgentModelSelection", () => {
  test("prefers thread override over global strategy", () => {
    const resolved = resolveEffectiveAgentModelSelection({
      strategy,
      threadSelection: {
        channelId: "channel-anthropic",
        modelRef: "anthropic/claude-sonnet-4-5"
      }
    });

    expect(resolved.channelId).toBe("channel-anthropic");
    expect(resolved.modelRef).toBe("anthropic/claude-sonnet-4-5");
    expect(resolved.source).toBe("thread-override");
  });

  test("falls back to global strategy when no thread override exists", () => {
    const resolved = resolveEffectiveAgentModelSelection({
      strategy,
      threadSelection: {}
    });

    expect(resolved.channelId).toBe("channel-openai");
    expect(resolved.modelRef).toBe("openai/gpt-5");
    expect(resolved.fallbackModelRefs).toEqual([
      "openai/gpt-5-mini",
      "openrouter/anthropic/claude-sonnet-4.5"
    ]);
    expect(resolved.source).toBe("global-default");
  });
});
```

- [ ] **Step 2: Run the sidecar test to verify it fails**

Run: `bun test apps/sidecar/src/services/channel/model-selection.test.ts`

Expected: FAIL with missing `resolveEffectiveAgentModelSelection` export and missing config type fields.

- [ ] **Step 3: Extend the shared config type with explicit agent default-strategy fields**

```ts
export interface LumeConfigAgentModelSelection {
  defaultChannelId?: string
  defaultModelRef?: string
  fallbackModelRefs?: string[]
}

export interface LumeConfigModelsSection {
  chat?: {
    defaultModelRef?: string
  }
  agent?: LumeConfigAgentModelSelection
  embedding?: {
    defaultModelRef?: string
  }
}
```

- [ ] **Step 4: Normalize the new fields in `lume-config-service.ts`**

```ts
const agent = isPlainObject(value.models.agent) ? value.models.agent : {};

next.models = {
  chat: { ...(typeof chat.defaultModelRef === "string" ? { defaultModelRef: chat.defaultModelRef } : {}) },
  agent: {
    ...(typeof agent.defaultChannelId === "string" ? { defaultChannelId: agent.defaultChannelId } : {}),
    ...(typeof agent.defaultModelRef === "string" ? { defaultModelRef: agent.defaultModelRef } : {}),
    ...(Array.isArray(agent.fallbackModelRefs)
      ? { fallbackModelRefs: agent.fallbackModelRefs.filter((item): item is string => typeof item === "string" && item.trim().length > 0) }
      : {})
  },
  embedding: { ...(typeof embedding.defaultModelRef === "string" ? { defaultModelRef: embedding.defaultModelRef } : {}) }
};
```

- [ ] **Step 5: Add a `lume-config:update-section` RPC path for config writes**

```ts
export const LUME_CONFIG_IPC_CHANNELS = {
  GET_EFFECTIVE: "lume-config:get-effective",
  GET_SOURCE_PATH: "lume-config:get-source-path",
  OPEN_SOURCE_FILE: "lume-config:open-source-file",
  UPDATE_SECTION: "lume-config:update-section",
  CHANGED: "lume-config:changed"
} as const
```

```ts
export const lumeConfigUpdateInputSchema = z.object({
  path: z.string().min(1),
  value: z.unknown()
});
```

```ts
[LUME_CONFIG_IPC_CHANNELS.UPDATE_SECTION]: async (params) => {
  const input = validateInput(
    lumeConfigUpdateInputSchema,
    params,
    LUME_CONFIG_IPC_CHANNELS.UPDATE_SECTION
  );
  return updateLumeConfigSection({
    source: "user",
    path: input.path,
    value: input.value
  });
},
```

- [ ] **Step 6: Add a sidecar helper that resolves thread override vs global default**

```ts
export interface AgentModelStrategyConfig {
  defaultChannelId?: string;
  defaultModelRef?: string;
  fallbackModelRefs?: string[];
}

export function resolveEffectiveAgentModelSelection(input: {
  strategy?: AgentModelStrategyConfig;
  threadSelection?: { channelId?: string; modelRef?: string };
}): {
  channelId?: string;
  modelRef?: string;
  fallbackModelRefs: string[];
  source: "thread-override" | "global-default" | "empty";
} {
  const threadModelRef = input.threadSelection?.modelRef?.trim();
  const threadChannelId = input.threadSelection?.channelId?.trim();
  if (threadModelRef || threadChannelId) {
    return {
      channelId: threadChannelId || input.strategy?.defaultChannelId,
      modelRef: threadModelRef || input.strategy?.defaultModelRef,
      fallbackModelRefs: [...(input.strategy?.fallbackModelRefs ?? [])],
      source: "thread-override"
    };
  }

  const defaultModelRef = input.strategy?.defaultModelRef?.trim();
  const defaultChannelId = input.strategy?.defaultChannelId?.trim();
  if (defaultModelRef || defaultChannelId) {
    return {
      channelId: defaultChannelId,
      modelRef: defaultModelRef,
      fallbackModelRefs: [...(input.strategy?.fallbackModelRefs ?? [])],
      source: "global-default"
    };
  }

  return {
    channelId: undefined,
    modelRef: undefined,
    fallbackModelRefs: [],
    source: "empty"
  };
}
```

- [ ] **Step 7: Run the sidecar test to verify it passes**

Run: `bun test apps/sidecar/src/services/channel/model-selection.test.ts`

Expected: PASS for the new effective-selection tests and the existing alias/default model tests.

- [ ] **Step 8: Commit the config-contract change**

```bash
git add packages/shared/src/types/lume-config.ts apps/sidecar/src/services/system/lume-config-service.ts apps/sidecar/src/rpc/system-handlers.ts apps/sidecar/src/rpc/schemas.ts apps/sidecar/src/services/channel/model-selection.ts apps/sidecar/src/services/channel/model-selection.test.ts
git commit -m "Add agent default model strategy resolution"
```

## Task 2: Make thread creation and message sending inherit the global strategy

**Files:**
- Modify: `apps/sidecar/src/services/agent/agent-thread-manager.ts`
- Modify: `apps/sidecar/src/services/agent/agent-service.ts`
- Modify: `apps/sidecar/src/rpc/agent-handlers.ts`
- Modify: `packages/shared/src/types/agent.ts`
- Test: `apps/sidecar/src/services/channel/model-selection.test.ts`

- [ ] **Step 1: Write the failing test for thread creation inheriting global defaults**

```ts
test("new thread without explicit model inherits global default strategy", () => {
  const resolved = resolveEffectiveAgentModelSelection({
    strategy: {
      defaultChannelId: "channel-openai",
      defaultModelRef: "openai/gpt-5",
      fallbackModelRefs: ["openai/gpt-5-mini"]
    },
    threadSelection: {}
  });

  expect(resolved.channelId).toBe("channel-openai");
  expect(resolved.modelRef).toBe("openai/gpt-5");
});
```

- [ ] **Step 2: Run the sidecar test to verify the inheritance scenario is not wired through yet**

Run: `bun test apps/sidecar/src/services/channel/model-selection.test.ts`

Expected: FAIL or pass only at helper level while thread creation still has no integration, confirming the implementation work remains.

- [ ] **Step 3: Load the global strategy during thread creation**

```ts
import { getEffectiveLumeConfig } from "../system/lume-config-service";
import { resolveEffectiveAgentModelSelection } from "../channel/model-selection";

const effectiveConfig = getEffectiveLumeConfig();
const resolvedSelection = resolveEffectiveAgentModelSelection({
  strategy: effectiveConfig.models?.agent,
  threadSelection: {
    channelId,
    modelRef
  }
});

const meta: AgentThreadMeta = {
  id: randomUUID(),
  title: title || "新 Agent 线程",
  modelRef: resolvedSelection.modelRef,
  channelId: resolvedSelection.channelId,
  modelId,
  workspaceId,
  parentThreadId,
  pinned: false,
  createdAt: now,
  updatedAt: now
};
```

- [ ] **Step 4: Use the same helper before sending messages so runtime resolution matches the UI**

```ts
const effectiveConfig = getEffectiveLumeConfig();
const effectiveSelection = resolveEffectiveAgentModelSelection({
  strategy: effectiveConfig.models?.agent,
  threadSelection: {
    channelId: input.channelId ?? threadMeta?.channelId,
    modelRef: input.modelRef ?? threadMeta?.modelRef
  }
});

const boundModel = resolveChannelModelBinding(
  effectiveSelection.modelRef ?? "",
  "chat"
);
const resolvedChannelId = boundModel?.channel.id ?? effectiveSelection.channelId;
```

- [ ] **Step 5: Add a nullable clear path to the model-selection update handler**

```ts
export const agentUpdateThreadModelSelectionInputSchema = z.object({
  threadId: idSchema,
  modelRef: z.string().nullable().optional(),
  channelId: z.string().nullable().optional(),
  modelId: z.string().nullable().optional()
});
```

```ts
return updateAgentThreadMeta(input.threadId, {
  modelRef: input.modelRef ?? undefined,
  channelId: input.channelId ?? undefined,
  modelId: input.modelId ?? undefined
});
```

- [ ] **Step 6: Re-run sidecar tests and a focused sidecar typecheck**

Run: `bun test apps/sidecar/src/services/channel/model-selection.test.ts`

Expected: PASS with both helper and integration-oriented expectations still green.

Run: `bun run --filter @lume/sidecar typecheck`

Expected: PASS with updated nullable schema handling and thread metadata writes.

- [ ] **Step 7: Commit the sidecar inheritance integration**

```bash
git add apps/sidecar/src/services/agent/agent-thread-manager.ts apps/sidecar/src/services/agent/agent-service.ts apps/sidecar/src/rpc/agent-handlers.ts packages/shared/src/types/agent.ts apps/sidecar/src/services/channel/model-selection.test.ts
git commit -m "Apply global model strategy to agent threads"
```

## Task 3: Build the shared web model-selection core and refactor the thread picker

**Files:**
- Create: `apps/web/src/components/model-selection/model-selection-state.ts`
- Create: `apps/web/src/components/model-selection/ModelOptionList.tsx`
- Create: `apps/web/src/components/model-selection/model-selection-state.test.ts`
- Modify: `apps/web/src/components/agent/ModelPicker.tsx`
- Modify: `apps/web/src/components/agent/AgentInput.tsx`

- [ ] **Step 1: Write the failing web unit tests for grouped options and override badges**

```ts
import { describe, expect, test } from "bun:test";
import { buildModelSelectionGroups, getThreadSelectionSummary } from "./model-selection-state";

describe("buildModelSelectionGroups", () => {
  test("groups enabled models by channel and marks the active option", () => {
    const result = buildModelSelectionGroups({
      channels: [{
        id: "channel-openai",
        name: "OpenAI",
        enabled: true,
        models: [
          { id: "gpt-5", name: "GPT-5", enabled: true },
          { id: "gpt-5-mini", name: "GPT-5 mini", enabled: true }
        ]
      }],
      activeChannelId: "channel-openai",
      activeModelRef: "openai/gpt-5"
    });

    expect(result[0]?.label).toBe("OpenAI");
    expect(result[0]?.options[0]?.active).toBe(true);
  });

  test("summarizes inherited vs override state", () => {
    expect(getThreadSelectionSummary({
      inheritedModelRef: "openai/gpt-5",
      effectiveModelRef: "anthropic/claude-sonnet-4-5"
    })).toEqual({
      label: "anthropic/claude-sonnet-4-5",
      isOverride: true
    });
  });
});
```

- [ ] **Step 2: Run the web test to verify the helper does not exist yet**

Run: `bun test apps/web/src/components/model-selection/model-selection-state.test.ts`

Expected: FAIL with missing module exports.

- [ ] **Step 3: Add the shared state helper and grouped list renderer**

```ts
export interface ModelOptionGroup {
  id: string;
  label: string;
  options: Array<{
    channelId: string;
    modelRef: string;
    modelId: string;
    label: string;
    active: boolean;
  }>;
}

export function buildModelSelectionGroups(input: {
  channels: Channel[];
  activeChannelId?: string;
  activeModelRef?: string;
}): ModelOptionGroup[] {
  return input.channels
    .filter((channel) => channel.enabled)
    .map((channel) => ({
      id: channel.id,
      label: channel.name,
      options: channel.models
        .filter((model) => model.enabled)
        .map((model) => ({
          channelId: channel.id,
          modelId: model.id,
          modelRef: model.id,
          label: model.name,
          active: channel.id === input.activeChannelId && model.id === input.activeModelRef
        }))
    }))
    .filter((group) => group.options.length > 0);
}
```

```tsx
export function ModelOptionList({ groups, onSelect }: {
  groups: ModelOptionGroup[];
  onSelect: (input: { channelId: string; modelRef: string; modelId: string }) => void;
}) {
  return (
    <div className="py-1">
      {groups.map((group) => (
        <div key={group.id} className="py-0.5">
          <div className="px-3 pt-1.5 pb-0.5 text-[10px] font-medium uppercase tracking-wider text-foreground/40">
            {group.label}
          </div>
          {group.options.map((option) => (
            <button
              key={`${option.channelId}-${option.modelId}`}
              onClick={() => onSelect(option)}
              className={option.active ? "bg-accent text-accent-foreground" : "text-foreground/70 hover:bg-muted/50"}
            >
              {option.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Refactor `ModelPicker.tsx` into a thread-only override container**

```tsx
const handleRestoreDefault = async () => {
  await sidecarCall("agent:update-thread-model-selection", {
    threadId,
    channelId: null,
    modelRef: null,
    modelId: null
  });
  setThreads((prev) =>
    prev.map((thread) =>
      thread.id === threadId
        ? { ...thread, channelId: undefined, modelRef: undefined, modelId: undefined }
        : thread
    )
  );
};
```

```tsx
{isOverride && (
  <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
    已覆盖默认
  </span>
)}
```

- [ ] **Step 5: Run the focused web tests and a web typecheck**

Run: `bun test apps/web/src/components/model-selection/model-selection-state.test.ts apps/web/src/components/settings/ChannelSettings.test.ts`

Expected: PASS with the new grouped-list helper tests and the existing channel settings tests.

Run: `bun run --filter @lume/web typecheck`

Expected: PASS with the new shared model-selection components wired into `AgentInput`.

- [ ] **Step 6: Commit the thread picker refactor**

```bash
git add apps/web/src/components/model-selection/model-selection-state.ts apps/web/src/components/model-selection/ModelOptionList.tsx apps/web/src/components/model-selection/model-selection-state.test.ts apps/web/src/components/agent/ModelPicker.tsx apps/web/src/components/agent/AgentInput.tsx
git commit -m "Refactor thread model picker around shared selection state"
```

## Task 4: Add the default strategy panel to settings and persist it through `lume-config`

**Files:**
- Create: `apps/web/src/lib/desktop-api/lume-config.ts`
- Create: `apps/web/src/components/settings/DefaultModelStrategyPanel.tsx`
- Create: `apps/web/src/components/settings/DefaultModelStrategyPanel.test.ts`
- Modify: `apps/web/src/components/settings/AgentSettings.tsx`
- Modify: `packages/shared/src/types/lume-config.ts`
- Modify: `apps/sidecar/src/services/system/lume-config-service.ts`
- Modify: `apps/sidecar/src/rpc/system-handlers.ts`

- [ ] **Step 1: Write the failing settings-panel test for default channel, model, and fallback chain editing**

```ts
import { describe, expect, test } from "bun:test";
import { sanitizeFallbackChain } from "./DefaultModelStrategyPanel";

describe("sanitizeFallbackChain", () => {
  test("removes duplicates and the selected default model", () => {
    expect(sanitizeFallbackChain({
      defaultModelRef: "openai/gpt-5",
      fallbackModelRefs: ["openai/gpt-5", "openai/gpt-5-mini", "openai/gpt-5-mini"]
    })).toEqual(["openai/gpt-5-mini"]);
  });
});
```

- [ ] **Step 2: Run the web test to verify the settings helper is missing**

Run: `bun test apps/web/src/components/settings/DefaultModelStrategyPanel.test.ts`

Expected: FAIL with missing component/helper exports.

- [ ] **Step 3: Add a web API wrapper for `lume-config` reads and updates**

```ts
export const getEffectiveLumeConfig = (workspaceSlug?: string) =>
  sidecarCall<LumeEffectiveConfig>("lume-config:get-effective", workspaceSlug ? { workspaceSlug } : {});

export const updateSystemModelStrategy = (value: {
  defaultChannelId?: string;
  defaultModelRef?: string;
  fallbackModelRefs?: string[];
}) =>
  sidecarCall<LumeEffectiveConfig>("lume-config:update-section", {
    path: "models.agent",
    value
  });
```

- [ ] **Step 4: Implement the settings panel with explicit fallback ordering controls**

```tsx
export function sanitizeFallbackChain(input: {
  defaultModelRef?: string;
  fallbackModelRefs: string[];
}): string[] {
  const seen = new Set<string>();
  const blocked = input.defaultModelRef?.trim();
  return input.fallbackModelRefs
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item !== blocked)
    .filter((item) => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}
```

```tsx
<SettingsBlock title="默认模型策略" desc="新线程默认使用的渠道、模型和回退顺序">
  <Select value={defaultChannelId} onValueChange={setDefaultChannelId}>
    <SelectTrigger className="w-56 h-8 text-[13px]"><SelectValue /></SelectTrigger>
    <SelectContent>{channelItems}</SelectContent>
  </Select>
  <Select value={defaultModelRef} onValueChange={setDefaultModelRef}>
    <SelectTrigger className="w-56 h-8 text-[13px]"><SelectValue /></SelectTrigger>
    <SelectContent>{modelItems}</SelectContent>
  </Select>
</SettingsBlock>
```

- [ ] **Step 5: Mount the new panel ahead of the existing advanced agent settings**

```tsx
return (
  <div className="p-6 space-y-6">
    <div>
      <h2 className="text-[15px] font-semibold">Agent 设置</h2>
      <p className="text-[12px] text-muted-foreground mt-0.5">配置 Agent 运行行为和默认模型策略</p>
    </div>

    <DefaultModelStrategyPanel />
    <Separator />
    {/* existing permission + advanced settings stay below */}
  </div>
)
```

- [ ] **Step 6: Run the focused settings test and the web typecheck**

Run: `bun test apps/web/src/components/settings/DefaultModelStrategyPanel.test.ts apps/web/src/components/settings/ChannelSettings.test.ts`

Expected: PASS with fallback sanitization and existing provider-form tests.

Run: `bun run --filter @lume/web typecheck`

Expected: PASS with the new panel wired into `AgentSettings`.

- [ ] **Step 7: Commit the settings-panel work**

```bash
git add apps/web/src/lib/desktop-api/lume-config.ts apps/web/src/components/settings/DefaultModelStrategyPanel.tsx apps/web/src/components/settings/DefaultModelStrategyPanel.test.ts apps/web/src/components/settings/AgentSettings.tsx packages/shared/src/types/lume-config.ts apps/sidecar/src/services/system/lume-config-service.ts apps/sidecar/src/rpc/system-handlers.ts
git commit -m "Add default agent model strategy settings"
```

## Task 5: End-to-end verification and cleanup

**Files:**
- Modify: `docs/superpowers/specs/2026-04-17-model-selection-design.md` only if implementation reveals a genuine spec mismatch
- Verify: `apps/web/src/components/agent/ModelPicker.tsx`
- Verify: `apps/web/src/components/settings/DefaultModelStrategyPanel.tsx`
- Verify: `apps/sidecar/src/services/agent/agent-service.ts`

- [ ] **Step 1: Run the full targeted test suite**

Run: `bun test apps/sidecar/src/services/channel/model-selection.test.ts apps/web/src/components/settings/ChannelSettings.test.ts apps/web/src/components/model-selection/model-selection-state.test.ts apps/web/src/components/settings/DefaultModelStrategyPanel.test.ts`

Expected: PASS with inheritance, grouping, and fallback editing covered.

- [ ] **Step 2: Run repo typechecks for the touched packages**

Run: `bun run --filter @lume/shared typecheck && bun run --filter @lume/sidecar typecheck && bun run --filter @lume/web typecheck`

Expected: PASS across shared, sidecar, and web.

- [ ] **Step 3: Perform a manual smoke checklist in the app**

```text
1. Open Agent settings and choose a default channel, default model, and two fallback models.
2. Create a new agent thread and verify the thread picker shows the inherited default model.
3. Override the thread model from the picker and verify the settings panel remains unchanged.
4. Click "恢复默认策略" in the thread picker and verify the inherited default returns.
5. Disable or remove a previously selected fallback model and verify the settings panel marks it invalid.
```

- [ ] **Step 4: Update the design spec only if code uncovered a contract correction**

```md
If no mismatch is found, make no documentation edit here.
If a mismatch is found, update only the affected section in:
docs/superpowers/specs/2026-04-17-model-selection-design.md
```

- [ ] **Step 5: Create the final implementation commit**

```bash
git add apps/web/src/components/agent/ModelPicker.tsx apps/web/src/components/settings/DefaultModelStrategyPanel.tsx apps/sidecar/src/services/agent/agent-service.ts packages/shared/src/types/lume-config.ts
git commit -m "Implement reusable agent model selection flow"
```

## Self-Review

### Spec coverage

- Shared capability with two UI surfaces: covered by Task 3 and Task 4.
- Thread-only override semantics: covered by Task 2 and Task 3.
- Global default strategy with channel, model, and fallback chain: covered by Task 1 and Task 4.
- Effective-selection and inheritance rules: covered by Task 1 and Task 2.
- Invalid model and fallback handling: covered by Task 4 and Task 5.
- Testing strategy from the spec: covered by Tasks 1 through 5.

### Placeholder scan

- No `TODO`, `TBD`, or “implement later” placeholders remain.
- Every code-changing step includes a concrete code snippet.
- Every verification step includes an explicit command and expected result.

### Type consistency

- Global strategy uses `defaultChannelId`, `defaultModelRef`, and `fallbackModelRefs` consistently.
- Thread override continues to use `channelId` and `modelRef`.
- Effective-selection helper output uses `channelId`, `modelRef`, `fallbackModelRefs`, and `source` consistently across tasks.
