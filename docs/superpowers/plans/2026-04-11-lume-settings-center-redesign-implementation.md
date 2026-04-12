# Lume Settings Center Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a single primary system settings source at `~/.lume/lume.json`, merge `lume.yaml` as override-only, and route all system configuration reads through a unified settings module, starting with embedding model settings in the Provider & Model page.

**Architecture:** Build a dedicated system settings service that loads `lume.json`, overlays `lume.yaml`, and exposes `effectiveSystemConfig`. Do not treat `settings.json` as system config anymore; it remains UI state only. Existing settings domains migrate gradually into `lume.json`, but all new runtime reads must go through the settings service immediately.

**Tech Stack:** Bun, TypeScript strict, sidecar services, JSON + YAML config IO, shared config contracts, existing channel/model settings UI, `provider/model` refs.

---

## File Structure

### New Files

- `D:\workspace\projects\ai-projects\lume\packages\shared\src\types\system-config.ts`
  - Shared contracts for `lume.json`, effective config, embedding model refs, and IPC channels if needed.
- `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\system\system-config-service.ts`
  - Primary settings loader for `lume.json` + `lume.yaml` override merge.
- `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\system\system-config-service.test.ts`
  - Tests for default generation, override merge, and embedding model resolution.

### Modified Files

- `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\infra\config-paths.ts`
  - Add `getLumeJsonPath()`.
- `D:\workspace\projects\ai-projects\lume\packages\shared\src\types\index.ts`
  - Export `system-config`.
- `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\embedding.ts`
  - Read embedding model ref from the unified system settings service.
- `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\rpc\system-handlers.ts`
  - Expose system config read/write APIs if needed for the settings page.
- `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\rpc\schemas.ts`
  - Add schemas for updating system config sections.
- `D:\workspace\projects\ai-projects\lume\apps\web\components\settings\ChannelSettings.tsx`
  - Add embedding model settings UI block.
- `D:\workspace\projects\ai-projects\lume\apps\web\components\settings\ChannelForm.tsx`
  - Only if model selection helpers can be reused here.
- `D:\workspace\projects\ai-projects\lume\apps\web\lib\desktop-api\system.ts`
  - Add system config bridge methods.
- `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\system\ui-state-service.ts`
  - Ensure `settings.json` remains UI-state-only.

### Later Migration Targets

- `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\channel\channel-manager.ts`
- `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\system\system-prompt-manager.ts`
- `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\chat\chat-tool-manager.ts`
- `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\automation\automation-manager.ts`

These move later, but the new settings service should already define their destination sections.

---

### Task 1: Add Shared Contracts For `lume.json` And Effective System Config

**Files:**
- Create: `D:\workspace\projects\ai-projects\lume\packages\shared\src\types\system-config.ts`
- Modify: `D:\workspace\projects\ai-projects\lume\packages\shared\src\types\index.ts`
- Test: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\system\system-config-service.test.ts`

- [ ] **Step 1: Write the failing type usage test**

```ts
import { expect, test } from "bun:test";
import type { LumeSystemConfig } from "@lume/shared";

test("system config 应包含 embedding defaultModelRef", () => {
  const config: LumeSystemConfig = {
    version: 1,
    models: {
      embedding: {
        defaultModelRef: "openai/text-embedding-3-small"
      }
    }
  };

  expect(config.models?.embedding?.defaultModelRef).toBe("openai/text-embedding-3-small");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\system\system-config-service.test.ts`

Expected: FAIL because `system-config.ts` does not exist yet.

- [ ] **Step 3: Add shared config contracts**

```ts
// packages/shared/src/types/system-config.ts
export interface LumeSystemModelsConfig {
  embedding?: {
    defaultModelRef?: string;
  };
}

export interface LumeSystemConfig {
  version: 1;
  models?: LumeSystemModelsConfig;
  memory?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  automation?: Record<string, unknown>;
  prompts?: Record<string, unknown>;
  tools?: Record<string, unknown>;
}

export interface EffectiveSystemConfig extends LumeSystemConfig {}
```

- [ ] **Step 4: Export the new shared types**

```ts
// packages/shared/src/types/index.ts
export * from "./system-config";
```

- [ ] **Step 5: Run typecheck**

Run:

```bash
cd D:\workspace\projects\ai-projects\lume\apps\sidecar
bun run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types/system-config.ts packages/shared/src/types/index.ts
git commit -m "feat(settings): ✨新增统一系统配置共享契约"
```

### Task 2: Build The Sidecar System Settings Service Around `lume.json`

**Files:**
- Create: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\system\system-config-service.ts`
- Create: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\system\system-config-service.test.ts`
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\infra\config-paths.ts`

- [ ] **Step 1: Write the failing config service test**

```ts
import { expect, test } from "bun:test";
import { getEffectiveSystemConfig } from "./system-config-service";

test("应从 lume.json 读取主配置，并允许 lume.yaml 覆盖", () => {
  const config = getEffectiveSystemConfig();
  expect(config.version).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\system\system-config-service.test.ts`

Expected: FAIL because service does not exist.

- [ ] **Step 3: Add `lume.json` path helper**

```ts
// apps/sidecar/src/services/infra/config-paths.ts
export function getLumeJsonPath(): string {
  return join(getConfigDir(), "lume.json");
}
```

- [ ] **Step 4: Implement the system config service**

```ts
// system-config-service.ts
export function getEffectiveSystemConfig(): EffectiveSystemConfig {
  const primary = readOrCreateLumeJson();
  const override = getEffectiveLumeConfig();
  return {
    ...primary,
    models: {
      ...(primary.models ?? {}),
      ...(override.models ?? {})
    },
    memory: {
      ...(primary.memory ?? {}),
      ...(override.memory ?? {})
    }
  };
}
```

- [ ] **Step 5: Keep `settings.json` explicitly UI-only**

```ts
// ui-state-service.ts
// Do not add system config writes here. settings.json remains uiState only.
```

- [ ] **Step 6: Run service tests**

Run:

```bash
bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\system\system-config-service.test.ts
bun run --cwd D:\workspace\projects\ai-projects\lume\apps\sidecar typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/sidecar/src/services/infra/config-paths.ts apps/sidecar/src/services/system/system-config-service.ts apps/sidecar/src/services/system/system-config-service.test.ts
git commit -m "feat(settings): ✨建立 lume.json 主配置与统一读取服务"
```

### Task 3: Wire Embedding Resolution To The Unified Settings Service

**Files:**
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\embedding.ts`
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\embedding-provider.test.ts`

- [ ] **Step 1: Write the failing embedding settings test**

```ts
test("resolveEmbeddingProvider 应优先读取 effectiveSystemConfig.models.embedding.defaultModelRef", () => {
  // prepare lume.json with openai/text-embedding-3-small
  const resolved = resolveEmbeddingProvider();
  expect(resolved.model).toBe("text-embedding-3-small");
  expect(resolved.provider).toBe("openai");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\embedding-provider.test.ts`

Expected: FAIL because embedding still reads env vars directly.

- [ ] **Step 3: Parse `provider/model` from effective system config**

```ts
// embedding.ts
const configuredRef = getEffectiveSystemConfig().models?.embedding?.defaultModelRef;
const parsed = parseModelRef(configuredRef);
if (parsed) {
  return resolveProviderFromConfiguredRef(parsed);
}
```

- [ ] **Step 4: Keep env vars as fallback only**

```ts
// If no config ref is present, continue to env-based fallback.
```

- [ ] **Step 5: Run embedding tests**

Run:

```bash
bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\memory\embedding-provider.test.ts
cd D:\workspace\projects\ai-projects\lume\apps\sidecar
bun run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/sidecar/src/services/memory/embedding.ts apps/sidecar/src/services/memory/embedding-provider.test.ts
git commit -m "feat(settings): ✨让 embedding 解析优先读取统一系统设置"
```

### Task 4: Expose System Settings Read/Write APIs

**Files:**
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\rpc\schemas.ts`
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\rpc\system-handlers.ts`
- Modify: `D:\workspace\projects\ai-projects\lume\apps\web\lib\desktop-api\system.ts`

- [ ] **Step 1: Write the failing bridge test**

```ts
import { expect, test } from "bun:test";
import * as systemApi from "@/lib/desktop-api/system";

test("应暴露 embedding system config 读取接口", () => {
  expect(typeof systemApi.getEffectiveSystemConfig).toBe("function");
  expect(typeof systemApi.updateSystemConfigSection).toBe("function");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --cwd D:\workspace\projects\ai-projects\lume\apps\web test:smoke`

Expected: FAIL because the bridge is not exposed.

- [ ] **Step 3: Add RPC endpoints**

```ts
// system-handlers.ts
"system-config:get-effective": async () => getEffectiveSystemConfig(),
"system-config:update-section": async (params) => updateSystemConfigSection(...)
```

- [ ] **Step 4: Add web bridge**

```ts
// apps/web/lib/desktop-api/system.ts
export async function getEffectiveSystemConfig() { ... }
export async function updateSystemConfigSection(path: string, value: unknown) { ... }
```

- [ ] **Step 5: Run web + sidecar typecheck**

Run:

```bash
cd D:\workspace\projects\ai-projects\lume\apps\sidecar
bun run typecheck
cd D:\workspace\projects\ai-projects\lume\apps\web
bun run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/sidecar/src/rpc/schemas.ts apps/sidecar/src/rpc/system-handlers.ts apps/web/lib/desktop-api/system.ts
git commit -m "feat(settings): ✨暴露统一系统配置读写接口"
```

### Task 5: Add Embedding Model Settings UI In Provider & Model Page

**Files:**
- Modify: `D:\workspace\projects\ai-projects\lume\apps\web\components\settings\ChannelSettings.tsx`
- Modify: `D:\workspace\projects\ai-projects\lume\apps\web\components\settings\ChannelForm.tsx` (only if selection helpers are reused)
- Test: `D:\workspace\projects\ai-projects\lume\apps\web\components\settings\ChannelSettings.test.tsx` (create if needed)

- [ ] **Step 1: Write the failing UI contract test**

```tsx
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChannelSettings } from "./ChannelSettings";

test("模型与供应商页应显示 Embedding 模型设置入口", () => {
  const html = renderToStaticMarkup(<ChannelSettings />);
  expect(html).toContain("Embedding");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --cwd D:\workspace\projects\ai-projects\lume\apps\web typecheck`

Expected: FAIL or missing UI assertion because the setting does not exist yet.

- [ ] **Step 3: Add embedding settings block**

```tsx
// ChannelSettings.tsx
<SettingsSection
  title="Embedding Model"
  description="用于记忆向量化与后续非对话 embedding 能力，最终保存为 provider/model。"
>
  {/* provider selector + model selector -> persist defaultModelRef */}
</SettingsSection>
```

- [ ] **Step 4: Save as `provider/model` ref**

```ts
await updateSystemConfigSection("models.embedding.defaultModelRef", `${provider}/${modelId}`);
```

- [ ] **Step 5: Run web smoke**

Run:

```bash
cd D:\workspace\projects\ai-projects\lume\apps\web
bun run typecheck
bun run test:smoke
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/settings/ChannelSettings.tsx apps/web/components/settings/ChannelForm.tsx apps/web/components/settings/ChannelSettings.test.tsx
git commit -m "feat(settings): ✨在模型与供应商页加入 embedding 模型设置"
```

### Task 6: Establish The New System Settings Read Path And Freeze Old Drift

**Files:**
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\system\proxy-settings-manager.ts`
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\system\ui-state-service.ts`
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\channel\channel-manager.ts` (read compatibility only if needed)

- [ ] **Step 1: Write the failing boundary test**

```ts
test("settings.json 应只保留 uiState，不再承载新的系统设置字段", () => {
  const raw = JSON.parse(readFileSync(getSettingsPath(), "utf-8"));
  expect(raw.systemConfig).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails or is missing**

Run: `bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\system\ui-state-service.test.ts`

Expected: fail until the boundary is explicit.

- [ ] **Step 3: Make the separation explicit**

```ts
// ui-state-service.ts
// settings.json only reads/writes uiState

// proxy-settings-manager.ts
// Document that proxy remains legacy until it migrates into lume.json, but do not add new system settings to settings.json.
```

- [ ] **Step 4: Run tests**

Run:

```bash
bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\system\ui-state-service.test.ts
cd D:\workspace\projects\ai-projects\lume\apps\sidecar
bun run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/system/ui-state-service.ts apps/sidecar/src/services/system/proxy-settings-manager.ts
git commit -m "refactor(settings): ♻️明确 uiState 与系统设置边界"
```

### Task 7: Final Verification And Drift Scan

**Files:**
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\scripts\smoke-restart-restore.mjs` if needed

- [ ] **Step 1: Add smoke assertion for embedding config**

```js
// smoke-restart-restore.mjs
// write lume.json with models.embedding.defaultModelRef
// optionally override with lume.yaml
// assert effective system config returns the override value
```

- [ ] **Step 2: Scan for old direct reads**

Run:

```bash
Get-ChildItem -Recurse D:\workspace\projects\ai-projects\lume\apps\sidecar -Include *.ts | Select-String -Pattern "getChannelsPath\\(|getSystemPromptsPath\\(|getChatToolsPath\\(|getMemoryConfigPath\\(" 
```

Expected: only legacy migration points remain; new embedding reads must go through the system settings service.

- [ ] **Step 3: Run full verification**

Run:

```bash
cd D:\workspace\projects\ai-projects\lume\apps\sidecar
bun run typecheck
cd D:\workspace\projects\ai-projects\lume\apps\web
bun run typecheck
cd D:\workspace\projects\ai-projects\lume
bun run smoke:core
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/sidecar/scripts/smoke-restart-restore.mjs
git commit -m "test(settings): ✅补齐设置中心与 embedding 模型配置冒烟验证"
```

---

## Self-Review

### Spec Coverage

- `lume.json` 作为 primary source：Task 2
- `lume.yaml` 作为 override：Task 2
- 系统设置模块统一读取：Task 2, Task 4
- embedding `provider/model` ref：Task 1, Task 3, Task 5
- 模型与供应商页入口：Task 5
- `settings.json` 只保留 uiState：Task 6

### Placeholder Scan

- 无 `TODO` / `TBD`
- 每个任务都给出具体文件、代码、命令和验证方式

### Type Consistency

- 主配置文件统一为 `~/.lume/lume.json`
- override 统一为 `~/.lume/lume.yaml`
- embedding 字段统一为 `models.embedding.defaultModelRef`
- 模型表达统一为 `provider/model`

