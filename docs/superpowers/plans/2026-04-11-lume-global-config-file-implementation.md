# Lume Global Config File Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single file-backed system configuration layer at `~/.lume/lume.yaml` with per-workspace overrides, hot reload, audit logging, and initial integration for agent/provider/MCP/skills/permissions.

**Architecture:** Introduce a sidecar-owned config service that reads and writes `lume.yaml`, computes effective settings by overlaying `workspaces.<slug>` onto global defaults, and publishes reload events. Keep runtime/UI state out of this file. Existing MCP/skill/tool-policy flows will be re-pointed to the config service incrementally instead of rewriting the whole settings stack at once.

**Tech Stack:** Bun, TypeScript strict, sidecar RPC, Tauri desktop bridge, YAML parser/stringifier, existing `@lume/shared` contracts, sidecar file watcher.

---

## File Structure

### New Files

- `D:\workspace\projects\ai-projects\lume\packages\shared\src\types\lume-config.ts`
  - Shared schema/types/events for `lume.yaml`, effective config payloads, audit entries, and IPC channel constants.
- `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\system\lume-config-service.ts`
  - Canonical read/normalize/merge/write/watch service for `lume.yaml` and `lume.audit.jsonl`.
- `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\system\lume-config-service.test.ts`
  - Focused tests for default generation, workspace overlay, invalid YAML fallback, audit append, and hot reload.
- `D:\workspace\projects\ai-projects\lume\apps\web\lib\desktop-api/lume-config.ts`
  - Web bridge for loading/opening effective config and config source path.

### Modified Files

- `D:\workspace\projects\ai-projects\lume\packages\shared\src\types\index.ts`
  - Export new `lume-config` shared types.
- `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\infra\config-paths.ts`
  - Add `getLumeConfigYamlPath()` and `getLumeConfigAuditPath()`.
- `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\system\workspace-watcher.ts`
  - Watch `lume.yaml` in addition to workspaces and emit config-change notifications.
- `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\rpc\schemas.ts`
  - Add schemas for config read/write/open APIs.
- `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\rpc\system-handlers.ts`
  - Expose `lume.yaml` APIs.
- `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\agent\agent-workspace-manager.ts`
  - Source workspace MCP/skill effective state from config service.
- `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\pi-agent\tools\permissions\tool-policy.ts`
  - Layer `permissions.toolPolicy` overrides from `lume.yaml` on top of existing runtime config.
- `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\pi-agent\runtime-core\attempt.ts`
  - Add config dir to runtime accessible directories so agent workers can intentionally modify `lume.yaml`.
- `D:\workspace\projects\ai-projects\lume\apps\web\lib\desktop-api/system.ts`
  - Re-export config RPC helpers if this codebase keeps system-oriented bridges there.
- `D:\workspace\projects\ai-projects\lume\apps\web\components\settings\AgentSettings.tsx`
  - Stop instructing the agent to edit `mcp.json`; point it to `lume.yaml` and show effective MCP source.
- `D:\workspace\projects\ai-projects\lume\apps\web\components\settings\SkillsSettings.tsx`
  - Update copy to explain skill enablement comes from `lume.yaml`, while skill files still live in `skills/`.
- `D:\workspace\projects\ai-projects\lume\apps\sidecar\package.json`
  - Add YAML dependency.

---

### Task 1: Add Shared Contracts And Config Paths

**Files:**
- Create: `D:\workspace\projects\ai-projects\lume\packages\shared\src\types\lume-config.ts`
- Modify: `D:\workspace\projects\ai-projects\lume\packages\shared\src\types\index.ts`
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\infra\config-paths.ts`
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\package.json`
- Test: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\infra\config-paths.test.ts`

- [ ] **Step 1: Write the failing path/type test**

```ts
import { expect, test } from "bun:test";
import {
  getConfigDir,
  getLumeConfigYamlPath,
  getLumeConfigAuditPath
} from "./config-paths";

test("应返回 lume.yaml 与 lume.audit.jsonl 路径", () => {
  const root = getConfigDir().replace(/\\/g, "/");
  expect(getLumeConfigYamlPath().replace(/\\/g, "/")).toBe(`${root}/lume.yaml`);
  expect(getLumeConfigAuditPath().replace(/\\/g, "/")).toBe(`${root}/lume.audit.jsonl`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\infra\config-paths.test.ts`

Expected: FAIL with `getLumeConfigYamlPath is not exported` or equivalent missing-symbol error.

- [ ] **Step 3: Add minimal shared config contracts**

```ts
// packages/shared/src/types/lume-config.ts
export interface LumeConfigAgentSection {
  defaultChannelId?: string;
  defaultModelId?: string;
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  thinkingLevel?: "off" | "low" | "medium" | "high" | "max";
}

export interface LumeConfigPermissionsSection {
  toolPolicy?: {
    allow?: string[];
    deny?: string[];
  };
}

export interface LumeConfigSectionSet {
  agent?: LumeConfigAgentSection;
  providers?: Record<string, unknown>;
  mcp?: Record<string, unknown>;
  skills?: {
    enabled?: string[];
    disabled?: string[];
  };
  permissions?: LumeConfigPermissionsSection;
}

export interface LumeConfigFile extends LumeConfigSectionSet {
  version: 1;
  workspaces?: Record<string, LumeConfigSectionSet>;
}

export interface LumeEffectiveConfig extends LumeConfigSectionSet {
  version: 1;
  workspaceSlug?: string;
  sourcePath: string;
}

export interface LumeConfigAuditEntry {
  at: string;
  source: "user" | "agent" | "system";
  workspaceSlug?: string;
  path: string;
  summary: string;
}

export const LUME_CONFIG_IPC_CHANNELS = {
  GET_EFFECTIVE: "lume-config:get-effective",
  GET_SOURCE_PATH: "lume-config:get-source-path",
  OPEN_SOURCE_FILE: "lume-config:open-source-file"
} as const;
```

- [ ] **Step 4: Add config path helpers and export barrel**

```ts
// apps/sidecar/src/services/infra/config-paths.ts
export function getLumeConfigYamlPath(): string {
  return join(getConfigDir(), "lume.yaml");
}

export function getLumeConfigAuditPath(): string {
  return join(getConfigDir(), "lume.audit.jsonl");
}
```

```ts
// packages/shared/src/types/index.ts
export * from "./lume-config";
```

```json
// apps/sidecar/package.json
{
  "dependencies": {
    "yaml": "^2.8.1"
  }
}
```

- [ ] **Step 5: Run targeted tests and typecheck**

Run:

```bash
bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\infra\config-paths.test.ts
bun run typecheck
```

Expected: path test PASS and sidecar typecheck PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types/lume-config.ts packages/shared/src/types/index.ts apps/sidecar/src/services/infra/config-paths.ts apps/sidecar/src/services/infra/config-paths.test.ts apps/sidecar/package.json bun.lock
git commit -m "feat(config): ✨新增 lume.yaml 共享契约与配置路径"
```

### Task 2: Build The Sidecar `lume.yaml` Service

**Files:**
- Create: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\system\lume-config-service.ts`
- Create: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\system\lume-config-service.test.ts`
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\system\ui-state-service.ts`

- [ ] **Step 1: Write the failing service tests**

```ts
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getEffectiveLumeConfig,
  updateLumeConfigSection
} from "./lume-config-service";

test("应生成默认 lume.yaml 并返回 workspace overlay 后的有效配置", () => {
  const dir = mkdtempSync(join(tmpdir(), "lume-config-"));
  process.env.LUME_CONFIG_DIR = dir;
  const config = getEffectiveLumeConfig("default");
  expect(config.version).toBe(1);
  expect(config.sourcePath.replace(/\\/g, "/")).toContain("/lume.yaml");
  rmSync(dir, { recursive: true, force: true });
});

test("写入 workspace 覆盖后应追加审计记录", () => {
  const dir = mkdtempSync(join(tmpdir(), "lume-config-audit-"));
  process.env.LUME_CONFIG_DIR = dir;
  updateLumeConfigSection({
    source: "agent",
    workspaceSlug: "default",
    path: "agent.defaultModelId",
    value: "claude-sonnet-4"
  });
  const audit = readFileSync(join(dir, "lume.audit.jsonl"), "utf-8");
  expect(audit).toContain("\"source\":\"agent\"");
  expect(audit).toContain("\"path\":\"agent.defaultModelId\"");
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\system\lume-config-service.test.ts`

Expected: FAIL because `lume-config-service.ts` does not exist.

- [ ] **Step 3: Implement the minimal config service**

```ts
// apps/sidecar/src/services/system/lume-config-service.ts
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import YAML from "yaml";
import type { LumeConfigAuditEntry, LumeConfigFile, LumeEffectiveConfig } from "@lume/shared";
import { getLumeConfigAuditPath, getLumeConfigYamlPath } from "../infra/config-paths";

const DEFAULT_LUME_CONFIG: LumeConfigFile = {
  version: 1,
  agent: {},
  providers: {},
  mcp: {},
  skills: { enabled: [], disabled: [] },
  permissions: {},
  workspaces: {}
};

function writeYamlAtomic(path: string, payload: string): void {
  const tmpPath = `${path}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, payload, "utf-8");
  renameSync(tmpPath, path);
}

function ensureConfigFile(): LumeConfigFile {
  const path = getLumeConfigYamlPath();
  if (!existsSync(path)) {
    writeYamlAtomic(path, YAML.stringify(DEFAULT_LUME_CONFIG));
    return structuredClone(DEFAULT_LUME_CONFIG);
  }
  try {
    return normalizeLumeConfig(YAML.parse(readFileSync(path, "utf-8")));
  } catch {
    return structuredClone(DEFAULT_LUME_CONFIG);
  }
}

export function getEffectiveLumeConfig(workspaceSlug?: string): LumeEffectiveConfig {
  const file = ensureConfigFile();
  const overlay = workspaceSlug ? file.workspaces?.[workspaceSlug] ?? {} : {};
  return {
    version: 1,
    sourcePath: getLumeConfigYamlPath(),
    workspaceSlug,
    agent: { ...(file.agent ?? {}), ...(overlay.agent ?? {}) },
    providers: { ...(file.providers ?? {}), ...(overlay.providers ?? {}) },
    mcp: { ...(file.mcp ?? {}), ...(overlay.mcp ?? {}) },
    skills: {
      ...(file.skills ?? {}),
      ...(overlay.skills ?? {})
    },
    permissions: {
      ...(file.permissions ?? {}),
      ...(overlay.permissions ?? {})
    }
  };
}

export function updateLumeConfigSection(input: {
  source: "user" | "agent" | "system";
  workspaceSlug?: string;
  path: string;
  value: unknown;
  summary?: string;
}): void {
  const file = ensureConfigFile();
  const root = input.workspaceSlug
    ? (file.workspaces ??= {})[input.workspaceSlug] ?? ((file.workspaces ??= {})[input.workspaceSlug] = {})
    : file;
  setPath(root as Record<string, unknown>, input.path, input.value);
  writeYamlAtomic(getLumeConfigYamlPath(), YAML.stringify(file));
  const audit: LumeConfigAuditEntry = {
    at: new Date().toISOString(),
    source: input.source,
    workspaceSlug: input.workspaceSlug,
    path: input.path,
    summary: input.summary ?? `set ${input.path}`
  };
  appendFileSync(getLumeConfigAuditPath(), `${JSON.stringify(audit)}\n`, "utf-8");
}
```

- [ ] **Step 4: Preserve existing `settings.json` UI-state flow**

```ts
// apps/sidecar/src/services/system/ui-state-service.ts
// Keep using settings.json for uiState. Do not redirect uiState into lume.yaml.
console.warn("[UI State] uiState 仍保留在 settings.json，未并入 lume.yaml");
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\system\lume-config-service.test.ts
bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\system\ui-state-service.test.ts
```

Expected: both PASS; `ui-state-service` behavior remains unchanged.

- [ ] **Step 6: Commit**

```bash
git add apps/sidecar/src/services/system/lume-config-service.ts apps/sidecar/src/services/system/lume-config-service.test.ts apps/sidecar/src/services/system/ui-state-service.ts
git commit -m "feat(config): ✨新增 lume.yaml 读取写入与审计服务"
```

### Task 3: Add Hot Reload And RPC Access

**Files:**
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\system\workspace-watcher.ts`
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\rpc\schemas.ts`
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\rpc\system-handlers.ts`
- Create: `D:\workspace\projects\ai-projects\lume\apps\web\lib\desktop-api/lume-config.ts`
- Modify: `D:\workspace\projects\ai-projects\lume\apps\web\lib\desktop-api/system.ts`

- [ ] **Step 1: Write failing RPC exposure tests**

```ts
import { expect, test } from "bun:test";
import { LUME_CONFIG_IPC_CHANNELS } from "@lume/shared";
import * as systemApi from "@/lib/desktop-api/system";

test("应暴露读取有效 lume config 的 bridge", () => {
  expect(typeof systemApi.getEffectiveLumeConfig).toBe("function");
  expect(LUME_CONFIG_IPC_CHANNELS.GET_EFFECTIVE).toBe("lume-config:get-effective");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test D:\workspace\projects\ai-projects\lume\apps\web\lib\desktop-api.agent-runtime-status.test.ts`

Expected: FAIL because `getEffectiveLumeConfig` is not exported yet.

- [ ] **Step 3: Add watcher event and sidecar handlers**

```ts
// apps/sidecar/src/services/system/workspace-watcher.ts
import { getLumeConfigYamlPath } from "../infra/config-paths";
import { LUME_CONFIG_IPC_CHANNELS } from "@lume/shared";

const lumeConfigPath = getLumeConfigYamlPath();

safeWatch(lumeConfigPath, {}, () => {
  emit(LUME_CONFIG_IPC_CHANNELS.GET_EFFECTIVE, { changed: true });
}, "Lume 全局配置");
```

```ts
// apps/sidecar/src/rpc/system-handlers.ts
[LUME_CONFIG_IPC_CHANNELS.GET_EFFECTIVE]: async (params) => {
  const input = validateInput(workspaceSlugInputSchema.partial(), params, LUME_CONFIG_IPC_CHANNELS.GET_EFFECTIVE);
  return getEffectiveLumeConfig(input.workspaceSlug);
},
[LUME_CONFIG_IPC_CHANNELS.GET_SOURCE_PATH]: async () => ({ path: getLumeConfigYamlPath() }),
[LUME_CONFIG_IPC_CHANNELS.OPEN_SOURCE_FILE]: async () => openPathInSystem(getLumeConfigYamlPath())
```

- [ ] **Step 4: Add web bridge helpers**

```ts
// apps/web/lib/desktop-api/lume-config.ts
import { LUME_CONFIG_IPC_CHANNELS, type LumeEffectiveConfig } from "@lume/shared";
import { sidecarCall } from "./core";

export async function getEffectiveLumeConfig(workspaceSlug?: string): Promise<LumeEffectiveConfig> {
  return sidecarCall<LumeEffectiveConfig>(LUME_CONFIG_IPC_CHANNELS.GET_EFFECTIVE, workspaceSlug ? { workspaceSlug } : {});
}

export async function openLumeConfigFile(): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(LUME_CONFIG_IPC_CHANNELS.OPEN_SOURCE_FILE);
}
```

- [ ] **Step 5: Run typecheck and smoke**

Run:

```bash
cd D:\workspace\projects\ai-projects\lume\apps\web
bun run typecheck
cd D:\workspace\projects\ai-projects\lume
bun run smoke:core
```

Expected: typecheck PASS and smoke PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/sidecar/src/services/system/workspace-watcher.ts apps/sidecar/src/rpc/schemas.ts apps/sidecar/src/rpc/system-handlers.ts apps/web/lib/desktop-api/lume-config.ts apps/web/lib/desktop-api/system.ts
git commit -m "feat(config): ✨打通 lume.yaml 热加载与跨端读取接口"
```

### Task 4: Integrate MCP, Skills, And Permissions With Effective Config

**Files:**
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\agent\agent-workspace-manager.ts`
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\pi-agent\tools\permissions\tool-policy.ts`
- Test: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\agent\agent-workspace-manager.test.ts`
- Test: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\pi-agent\tools\permissions\tool-policy.test.ts`

- [ ] **Step 1: Write failing integration tests**

```ts
test("workspace MCP enabled 覆盖应来自 lume.yaml", () => {
  updateLumeConfigSection({
    source: "system",
    workspaceSlug: "default",
    path: "mcp.servers.context7.enabled",
    value: false
  });
  const config = getWorkspaceMcpConfig("default");
  expect(config.servers.context7?.enabled).toBe(false);
});

test("permissions.toolPolicy 应叠加到 runtime tool policy", () => {
  updateLumeConfigSection({
    source: "system",
    path: "permissions.toolPolicy.deny",
    value: ["delete_file"]
  });
  const policies = resolveEffectiveToolPolicies({});
  expect(policies.some((item) => item.deny?.includes("delete_file"))).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\agent\agent-workspace-manager.test.ts
bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\pi-agent\tools\permissions\tool-policy.test.ts
```

Expected: FAIL because config overrides are not read yet.

- [ ] **Step 3: Layer `lume.yaml` into MCP, skills, and permissions**

```ts
// apps/sidecar/src/services/agent/agent-workspace-manager.ts
import { getEffectiveLumeConfig } from "../system/lume-config-service";

export function getWorkspaceMcpConfig(workspaceSlug: string): WorkspaceMcpConfig {
  const legacy = readLegacyWorkspaceMcpConfig(workspaceSlug);
  const effective = getEffectiveLumeConfig(workspaceSlug);
  return {
    servers: {
      ...legacy.servers,
      ...((effective.mcp?.servers as Record<string, WorkspaceMcpConfig["servers"][string]>) ?? {})
    }
  };
}

export function getWorkspaceSkills(workspaceSlug: string): SkillMeta[] {
  const discovered = readSkillDirs(workspaceSlug);
  const effective = getEffectiveLumeConfig(workspaceSlug);
  const enabled = new Set(effective.skills?.enabled ?? []);
  const disabled = new Set(effective.skills?.disabled ?? []);
  if (enabled.size === 0 && disabled.size === 0) return discovered;
  return discovered.filter((skill) => {
    if (disabled.has(skill.slug)) return false;
    if (enabled.size === 0) return true;
    return enabled.has(skill.slug);
  });
}
```

```ts
// apps/sidecar/src/services/pi-agent/tools/permissions/tool-policy.ts
import { getEffectiveLumeConfig } from "../../../system/lume-config-service";

export function resolveEffectiveToolPolicies(input: ResolveEffectiveToolPolicyInput): ToolPolicy[] {
  const policies = [...existingPolicies];
  const workspaceSlug = typeof input.messageMetadata?.workspaceSlug === "string"
    ? input.messageMetadata.workspaceSlug
    : undefined;
  const lumePolicy = getEffectiveLumeConfig(workspaceSlug).permissions?.toolPolicy;
  if (lumePolicy) {
    policies.push(lumePolicy);
  }
  return policies;
}
```

- [ ] **Step 4: Run the focused tests**

Run:

```bash
bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\agent\agent-workspace-manager.test.ts
bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\pi-agent\tools\permissions\tool-policy.test.ts
```

Expected: PASS with `lume.yaml` overrides applied.

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/agent/agent-workspace-manager.ts apps/sidecar/src/services/agent/agent-workspace-manager.test.ts apps/sidecar/src/services/pi-agent/tools/permissions/tool-policy.ts apps/sidecar/src/services/pi-agent/tools/permissions/tool-policy.test.ts
git commit -m "feat(config): ✨让 MCP Skills 与权限策略接入 lume.yaml"
```

### Task 5: Let Runtime Sessions And Agents Reach `lume.yaml`

**Files:**
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\pi-agent\runtime-core\attempt.ts`
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\agent\agent-prompt-builder.ts`
- Test: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\pi-agent\runtime-core\run.test.ts`
- Test: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\agent\agent-prompt-builder.test.ts`

- [ ] **Step 1: Write failing runtime access tests**

```ts
test("runtime additionalDirectories 应包含 Lume config dir", async () => {
  const prepared = await prepareRuntimeCoreAttempt(runtime, input);
  expect(prepared.additionalDirectories).toContain(getConfigDir());
});

test("动态提示应告知 agent 使用 ~/.lume/lume.yaml 配置系统行为", () => {
  const prompt = buildDynamicContext({
    workspaceSlug: "default",
    workspaceName: "默认工作区"
  });
  expect(prompt).toContain("~/.lume/lume.yaml");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\pi-agent\runtime-core\run.test.ts
bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\agent\agent-prompt-builder.test.ts
```

Expected: FAIL because config dir is not exposed yet and prompt text does not mention `lume.yaml`.

- [ ] **Step 3: Update runtime and prompt context**

```ts
// apps/sidecar/src/services/pi-agent/runtime-core/attempt.ts
import { getConfigDir } from "../../infra/config-paths";

return {
  agentCwd,
  agentDir: getRuntimeCoreAgentDir(),
  workspaceName,
  workspaceSlug,
  additionalDirectories: [agentCwd, getConfigDir()]
};
```

```ts
// apps/sidecar/src/services/agent/agent-prompt-builder.ts
lines.push("系统配置文件: ~/.lume/lume.yaml");
lines.push("当需要切换默认模型、provider、MCP、Skills、permissions 时，优先更新 lume.yaml。");
lines.push("lume.yaml 只覆盖系统配置，不存放 UI 状态、草稿或临时运行态。");
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\pi-agent\runtime-core\run.test.ts
bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\agent\agent-prompt-builder.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/pi-agent/runtime-core/attempt.ts apps/sidecar/src/services/pi-agent/runtime-core/run.test.ts apps/sidecar/src/services/agent/agent-prompt-builder.ts apps/sidecar/src/services/agent/agent-prompt-builder.test.ts
git commit -m "feat(config): ✨让 agent runtime 可访问并理解 lume.yaml"
```

### Task 6: Align Settings UI Copy With The New Config Source

**Files:**
- Modify: `D:\workspace\projects\ai-projects\lume\apps\web\components\settings\AgentSettings.tsx`
- Modify: `D:\workspace\projects\ai-projects\lume\apps\web\components\settings\SkillsSettings.tsx`
- Modify: `D:\workspace\projects\ai-projects\lume\apps\web\components\settings\SettingsPanel.tsx`
- Test: `D:\workspace\projects\ai-projects\lume\apps\web\components\agent\agent-session-lifecycle.test.ts`

- [ ] **Step 1: Add a small failing UI contract test**

```ts
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentSettings } from "./AgentSettings";

test("AgentSettings 文案应指向 lume.yaml 作为系统配置入口", () => {
  const html = renderToStaticMarkup(<AgentSettings />);
  expect(html).toContain("lume.yaml");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test D:\workspace\projects\ai-projects\lume\apps\web\components\settings\AgentSettings.test.tsx`

Expected: FAIL because current copy still references `mcp.json`.

- [ ] **Step 3: Update settings copy and CTA prompts**

```tsx
// apps/web/components/settings/AgentSettings.tsx
const configPath = "~/.lume/lume.yaml";
const promptMessage = `请帮我配置当前系统的 Agent / Provider / MCP 行为。

## 配置入口
- 主配置文件: ${configPath}
- 当前 workspace: ${workspace?.name}
- workspace 覆盖块: workspaces.${workspaceSlug}

请优先更新 lume.yaml，而不是直接编辑旧的 mcp.json。`;
```

```tsx
// apps/web/components/settings/SkillsSettings.tsx
const promptMessage = `请帮我调整当前 workspace 的 Skill 启用状态。

- 系统配置入口: ~/.lume/lume.yaml
- 当前 workspace 覆盖块: workspaces.${workspaceSlug}.skills
- Skill 文件目录仍然是: ~/.lume/agent-workspaces/${workspaceSlug}/skills/`;
```

- [ ] **Step 4: Run web smoke**

Run:

```bash
cd D:\workspace\projects\ai-projects\lume\apps\web
bun run test:smoke
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/settings/AgentSettings.tsx apps/web/components/settings/SkillsSettings.tsx apps/web/components/settings/SettingsPanel.tsx
git commit -m "feat(config): ✨更新设置页文案并指向 lume.yaml"
```

### Task 7: End-To-End Verification And Cleanup

**Files:**
- Modify: `D:\workspace\projects\ai-projects\lume\scripts\smoke-core.mjs`
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\scripts\smoke-restart-restore.mjs`
- Test: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\system\lume-config-service.test.ts`

- [ ] **Step 1: Extend smoke coverage**

```js
// scripts/smoke-core.mjs
await rpc("lume-config:get-effective", { workspaceSlug: "default" });
await writeFile(configPath, `
version: 1
agent:
  defaultModelId: "gpt-5.4"
workspaces:
  default:
    agent:
      defaultModelId: "claude-sonnet-4"
`);
const effective = await rpc("lume-config:get-effective", { workspaceSlug: "default" });
assert.equal(effective.agent.defaultModelId, "claude-sonnet-4");
```

- [ ] **Step 2: Run smokes**

Run:

```bash
cd D:\workspace\projects\ai-projects\lume
bun run smoke:core
cd D:\workspace\projects\ai-projects\lume\apps\web
bun run test:smoke
cd D:\workspace\projects\ai-projects\lume\apps\sidecar
bun run typecheck
```

Expected: all PASS.

- [ ] **Step 3: Final cleanup pass**

```ts
// Verify no new code writes uiState into lume.yaml and no settings prompts still mention mcp.json as the primary config source.
```

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke-core.mjs apps/sidecar/scripts/smoke-restart-restore.mjs
git commit -m "test(config): ✅补齐 lume.yaml 冒烟验证"
```

---

## Self-Review

### Spec Coverage

- 单文件 `lume.yaml`：Task 1, Task 2
- `workspaces.<slug>` 覆盖：Task 2
- 热加载：Task 3
- 审计：Task 2
- 只覆盖系统配置，不覆盖 UI 状态：Task 2
- 接入 agent/providers/mcp/skills/permissions：Task 4, Task 5
- 用户/agent 明确配置入口：Task 5, Task 6

### Placeholder Scan

- 未保留 `TODO` / `TBD`
- 所有任务都给出具体文件、命令、最小代码示例

### Type Consistency

- 统一使用 `LumeConfigFile` / `LumeEffectiveConfig` / `LumeConfigAuditEntry`
- 主文件名统一为 `lume.yaml`
- workspace 覆盖路径统一为 `workspaces.<slug>`

