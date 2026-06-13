# Lume Plugin Platform Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Phase 1 of the plugin platform: a unified manifest normalizer and Sidecar plugin registry that powers plugin listing/inspection without changing Agent runtime tool behavior.

**Architecture:** SDK owns pure plugin manifest normalization for Lume, Codex, and legacy command manifests. Sidecar owns filesystem discovery, plugin state storage, duplicate precedence, and the compatibility `LIST_PLUGINS` RPC. Runtime capability loading, permission prompts, market backend, and UI upgrades are intentionally deferred to later phases.

**Tech Stack:** TypeScript, Bun test, existing `@lume/agent-sdk` plugin exports, existing Sidecar RPC handlers.

---

## Scope Guard

This plan implements only Phase 1 from [the approved design spec](../specs/2026-06-13-lume-plugin-platform-design.md):

- SDK normalized plugin types and pure normalizer.
- Sidecar registry for discovery, duplicate selection, and state file loading.
- Compatibility migration for `LIST_PLUGINS`.
- No runtime capability loading.
- No permission prompt UI.
- No plugin market UI.
- No MCP startup, hook registration, or command tool exposure changes.

Cleanup/replacement rule: existing `SidecarPluginManager` stays as a thin compatibility wrapper until later phases remove all callers. Do not delete legacy code in this phase unless the new registry fully replaces that exact call path and tests cover the replacement.

## File Structure

SDK:

- Create `packages/sdk/src/plugins/normalized.ts`
  - Defines `NormalizedPlugin`, manifest capability types, diagnostics, source/permission summary helpers, and pure normalize functions.
- Create `packages/sdk/src/plugins/normalized.test.ts`
  - Covers Lume, Codex, legacy command, manifest precedence, unsafe paths, command tool validation, and default permissions.
- Modify `packages/sdk/src/plugins/manifest.ts`
  - Add raw `commandTools` support to `LumePluginManifest` without importing normalized plugin types.
- Modify `packages/sdk/src/plugins/manifest.test.ts`
  - Verifies parser preserves raw command tool entries for the normalizer.
  - Keep existing parser API compatible.
- Modify `packages/sdk/src/plugins/codex-adapter.ts`
  - Reuse Codex default permission constants from `normalized.ts` or export them for normalizer tests.
- Modify `packages/sdk/src/index.ts`
  - Export normalized plugin types/functions.

Sidecar:

- Create `apps/sidecar/src/services/agent-runtime/plugins/plugin-state-store.ts`
  - Reads/writes plugin state file under Sidecar-owned config path.
  - Provides empty defaults when absent.
- Create `apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.ts`
  - Scans roots, reads manifest files, calls SDK normalizer, groups candidates by pluginId, applies duplicate precedence, and returns registry views.
- Create `apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.test.ts`
  - Covers scan roots, Lume/Codex/legacy manifests, duplicate precedence, activeVersion, external review state, and diagnostics.
- Modify `apps/sidecar/src/services/agent-runtime/plugins/plugin-manager.ts`
  - Keep class name for compatibility, delegate `resolveEnabled()` and `buildInterceptorContexts()` to `PluginRegistry`.
- Modify `apps/sidecar/src/services/agent-runtime/plugins/plugin-manager.test.ts`
  - Either update expectations or reduce to compatibility-wrapper tests.
- Modify `apps/sidecar/src/rpc/agent-handlers.ts`
  - `LIST_PLUGINS` uses `PluginRegistry.list()` and returns normalized diagnostics while preserving old fields used by current UI.

Shared/Web:

- Modify `packages/shared/src/types/agent.ts`
  - Add explicit plugin list result types if no suitable type exists.
- Modify `apps/web/src/components/agent/AgentInput.tsx`
  - Accept both legacy array and new `{ plugins, diagnostics }` list result shape.
- Modify `apps/web/src/components/welcome/LumeWelcomeSurface.tsx`
  - Accept both legacy array and new `{ plugins, diagnostics }` list result shape.
- Do not modify plugin market UI in this phase.
- Do not redesign plugin popovers or settings UI in this phase.

---

## Chunk 1: SDK Normalized Plugin Model

### Task 1: Add normalized type contract tests

**Files:**
- Create: `packages/sdk/src/plugins/normalized.test.ts`
- Create: `packages/sdk/src/plugins/normalized.ts`
- Modify: `packages/sdk/src/plugins/manifest.ts`
- Modify: `packages/sdk/src/plugins/manifest.test.ts`
- Modify: `packages/sdk/src/index.ts`

- [ ] **Step 1: Write failing tests for Lume manifest normalization**

Add to `packages/sdk/src/plugins/normalized.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  normalizePluginManifests,
} from "./normalized.js";

describe("normalizePluginManifests", () => {
  test("normalizes a Lume manifest without reading referenced files", () => {
    const result = normalizePluginManifests({
      pluginRoot: "/plugins/acme",
      lumeManifest: {
        schema: "lume-plugin/v1",
        name: "acme",
        version: "1.2.3",
        displayName: "Acme",
        description: "Acme plugin",
        skills: ["./skills/"],
        hooks: "./hooks/hooks.json",
        mcpServers: "./mcp.json",
        commandTools: [{
          name: "acme_echo",
          command: "node",
          args: ["./tools/echo.mjs"],
          cwd: "./",
          timeoutMs: 5000,
          inputSchema: { type: "object", properties: {} },
        }],
        permissions: {
          mcpServers: { register: true },
          tools: { ask: ["acme_echo"] },
        },
      },
    });

    expect(result.pluginId).toBe("acme");
    expect(result.manifestFormat).toBe("lume");
    expect(result.capabilities.skills).toEqual([
      { pluginId: "acme", version: "1.2.3", root: "./skills/" },
    ]);
    expect(result.capabilities.hooksConfigPath).toBe("./hooks/hooks.json");
    expect(result.capabilities.mcpServersConfigPath).toBe("./mcp.json");
    expect(result.capabilities.commandTools[0]?.name).toBe("acme_echo");
    expect(result.permissions.mcpServers?.register).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
rtk bun test packages/sdk/src/plugins/normalized.test.ts
```

Expected: FAIL because `normalized.ts` does not exist.

- [ ] **Step 3: Implement normalized types and Lume normalization**

Create `packages/sdk/src/plugins/normalized.ts` with these exported types and functions:

```ts
import {
  inferDefaults,
  parseManifest,
  validatePluginPath,
  type PluginPermissions,
} from "./manifest.js";
import { adaptCodexPlugin } from "./codex-adapter.js";

export type PluginManifestFormat = "lume" | "codex" | "legacy";
export type PluginDiagnosticSeverity = "info" | "warning" | "error";

export interface PluginDiagnostic {
  pluginId?: string;
  version?: string;
  severity: PluginDiagnosticSeverity;
  code:
    | "ignored_manifest"
    | "legacy_manifest"
    | "invalid_manifest"
    | "unsafe_path"
    | "unsupported_field"
    | "duplicate_plugin_ignored"
    | "permission_review_required"
    | "capability_filtered"
    | "mcp_start_failed"
    | "orphaned_install"
    | "command_tool_invalid";
  message: string;
  path?: string;
}

export interface PluginSkillContribution {
  pluginId: string;
  version: string;
  root: string;
}

export interface CommandToolContribution {
  name: string;
  description?: string;
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  inputSchema?: Record<string, unknown>;
  env?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface PluginManifestCapabilities {
  skills: PluginSkillContribution[];
  hooksConfigPath?: string;
  mcpServersConfigPath?: string;
  commandTools: CommandToolContribution[];
}

export interface NormalizedPlugin {
  pluginId: string;
  name: string;
  version: string;
  root: string;
  manifestFormat: PluginManifestFormat;
  displayName?: string;
  description?: string;
  capabilities: PluginManifestCapabilities;
  permissions: PluginPermissions;
  diagnostics: PluginDiagnostic[];
}

export interface NormalizePluginManifestsInput {
  pluginRoot: string;
  lumeManifest?: Record<string, unknown>;
  codexManifest?: Record<string, unknown>;
  legacyManifest?: Record<string, unknown>;
}

export function normalizePluginManifests(input: NormalizePluginManifestsInput): NormalizedPlugin {
  if (input.lumeManifest) {
    const plugin = normalizeLumeManifest(input.pluginRoot, input.lumeManifest, "lume");
    if (input.codexManifest) {
      plugin.diagnostics.push({
        pluginId: plugin.pluginId,
        version: plugin.version,
        severity: "info",
        code: "ignored_manifest",
        message: "Ignored .codex-plugin/plugin.json because lume-plugin.json is present.",
      });
    }
    return plugin;
  }
  if (input.codexManifest) {
    const adapted = adaptCodexPlugin(input.codexManifest, input.pluginRoot);
    return normalizeLumeManifest(input.pluginRoot, adapted, "codex");
  }
  if (input.legacyManifest) {
    return normalizeLegacyCommandManifest(input.pluginRoot, input.legacyManifest);
  }
  throw new Error("No supported plugin manifest found");
}
```

Then implement helpers. Include `normalizeCommandTools()` in this same step so the first Lume normalization test is executable before Task 2 adds broader coverage:

```ts
function normalizeLumeManifest(
  pluginRoot: string,
  raw: Record<string, unknown>,
  format: "lume" | "codex",
): NormalizedPlugin {
  const manifest = inferDefaults(parseManifest(raw));
  const diagnostics: PluginDiagnostic[] = [];
  collectUnsupportedFields(raw, diagnostics, manifest.name, manifest.version);
  const commandTools = normalizeCommandTools((raw.commandTools ?? []) as unknown, diagnostics, manifest.name, manifest.version);

  return {
    pluginId: manifest.name,
    name: manifest.name,
    version: manifest.version,
    root: pluginRoot,
    manifestFormat: format,
    displayName: manifest.displayName,
    description: manifest.description,
    capabilities: {
      skills: (manifest.skills ?? []).map((root) => ({
        pluginId: manifest.name,
        version: manifest.version,
        root,
      })),
      ...(manifest.hooks ? { hooksConfigPath: manifest.hooks } : {}),
      ...(manifest.mcpServers ? { mcpServersConfigPath: manifest.mcpServers } : {}),
      commandTools,
    },
    permissions: manifest.permissions ?? {},
    diagnostics,
  };
}

function normalizeCommandTools(
  value: unknown,
  diagnostics: PluginDiagnostic[],
  pluginId: string,
  version: string,
): CommandToolContribution[] {
  if (!Array.isArray(value)) return [];
  const result: CommandToolContribution[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      diagnostics.push({ pluginId, version, severity: "warning", code: "command_tool_invalid", message: "Command tool must be an object." });
      continue;
    }
    const tool = entry as Record<string, unknown>;
    if (typeof tool.name !== "string" || typeof tool.command !== "string") {
      diagnostics.push({ pluginId, version, severity: "warning", code: "command_tool_invalid", message: "Command tool requires name and command." });
      continue;
    }
    result.push({
      name: tool.name,
      command: tool.command,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      ...(Array.isArray(tool.args) && tool.args.every((arg) => typeof arg === "string") ? { args: tool.args } : {}),
      ...(typeof tool.cwd === "string" ? { cwd: tool.cwd } : {}),
      ...(typeof tool.timeoutMs === "number" ? { timeoutMs: tool.timeoutMs } : {}),
      ...(tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema) ? { inputSchema: tool.inputSchema as Record<string, unknown> } : {}),
      ...(tool.env && isStringRecord(tool.env) ? { env: tool.env } : {}),
      ...(tool.metadata && typeof tool.metadata === "object" && !Array.isArray(tool.metadata) ? { metadata: tool.metadata as Record<string, unknown> } : {}),
    });
  }
  return result;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every((entry) => typeof entry === "string");
}
```

- [ ] **Step 4: Update `LumePluginManifest` for command tools**

Modify `packages/sdk/src/plugins/manifest.ts`:

Add this field to the existing `LumePluginManifest` interface:

```ts
commandTools?: Array<Record<string, unknown>>;
```

In `parseManifest()`, set:

```ts
commandTools: Array.isArray(raw.commandTools)
  ? raw.commandTools.filter((tool): tool is Record<string, unknown> =>
      Boolean(tool) && typeof tool === "object" && !Array.isArray(tool),
    )
  : undefined,
```

Do not import from `normalized.ts` or validate command tool internals in `manifest.ts`; `normalized.ts` owns the strongly typed `CommandToolContribution` contract and validation. This keeps `manifest.ts` as the lower-level parser and avoids a circular import.

- [ ] **Step 5: Run SDK normalized test**

Run:

```bash
rtk bun test packages/sdk/src/plugins/normalized.test.ts
```

Expected: PASS for the first test.

- [ ] **Step 6: Add parser coverage for raw command tools**

Add a focused assertion to `packages/sdk/src/plugins/manifest.test.ts` that `parseManifest()` preserves object-shaped `commandTools` entries without importing `CommandToolContribution`:

```ts
test("parses raw command tool entries for the normalizer", () => {
  const manifest = parseManifest({
    schema: "lume-plugin/v1",
    name: "tools",
    version: "1.0.0",
    commandTools: [{ name: "echo", command: "echo" }],
  });

  expect(manifest.commandTools).toEqual([{ name: "echo", command: "echo" }]);
});
```

### Task 2: Cover Codex, legacy, path, and command tool behavior

**Files:**
- Modify: `packages/sdk/src/plugins/normalized.test.ts`
- Modify: `packages/sdk/src/plugins/normalized.ts`
- Modify: `packages/sdk/src/index.ts`

- [ ] **Step 1: Add tests for manifest precedence and Codex defaults**

Add:

```ts
test("prefers Lume manifest over Codex manifest in the same root", () => {
  const result = normalizePluginManifests({
    pluginRoot: "/plugins/dual",
    lumeManifest: { schema: "lume-plugin/v1", name: "dual", version: "1.0.0" },
    codexManifest: { name: "codex-dual", version: "9.9.9", interface: {} },
  });

  expect(result.pluginId).toBe("dual");
  expect(result.manifestFormat).toBe("lume");
  expect(result.diagnostics.map((d) => d.code)).toContain("ignored_manifest");
});

test("normalizes Codex manifest with Codex-compatible defaults", () => {
  const result = normalizePluginManifests({
    pluginRoot: "/plugins/codex",
    codexManifest: {
      name: "codex",
      version: "1.0.0",
      skills: "./skills/",
      mcpServers: "./mcp.json",
      interface: { displayName: "Codex Plugin" },
    },
  });

  expect(result.manifestFormat).toBe("codex");
  expect(result.displayName).toBe("Codex Plugin");
  expect(result.permissions.mcpServers?.register).toBe(true);
  expect(result.permissions.shell?.allow).toBe(true);
  expect(result.permissions.tools?.deny).toContain("Bash");
});
```

- [ ] **Step 2: Add tests for legacy command plugin normalization**

Add:

```ts
test("normalizes legacy plugin.json command tools", () => {
  const result = normalizePluginManifests({
    pluginRoot: "/plugins/legacy",
    legacyManifest: {
      name: "legacy",
      version: "local",
      tools: [{
        name: "legacy_echo",
        description: "Echo",
        command: "echo",
        args: ["hello"],
      }],
    },
  });

  expect(result.manifestFormat).toBe("legacy");
  expect(result.version).toBe("local");
  expect(result.capabilities.commandTools.map((tool) => tool.name)).toEqual(["legacy_echo"]);
  expect(result.diagnostics.map((d) => d.code)).toContain("legacy_manifest");
});

test("rejects legacy plugin without command tools", () => {
  expect(() => normalizePluginManifests({
    pluginRoot: "/plugins/legacy-empty",
    legacyManifest: { name: "legacy-empty", tools: [] },
  })).toThrow("command");
});
```

- [ ] **Step 3: Add tests for unsafe command tool paths and invalid shape**

Add:

```ts
test("skips invalid command tools with diagnostics", () => {
  const result = normalizePluginManifests({
    pluginRoot: "/plugins/bad-tool",
    lumeManifest: {
      schema: "lume-plugin/v1",
      name: "bad-tool",
      version: "1.0.0",
      commandTools: [
        { name: "missing-command" },
        { name: "bad-cwd", command: "node", cwd: "../outside" },
      ],
    },
  });

  expect(result.capabilities.commandTools).toEqual([]);
  expect(result.diagnostics.filter((d) => d.code === "command_tool_invalid")).toHaveLength(2);
});

test("skips command tools with invalid optional field shapes", () => {
  const invalidTools = [
    { name: "bad-args", command: "node", args: ["ok", 1] },
    { name: "bad-timeout", command: "node", timeoutMs: "1000" },
    { name: "bad-schema", command: "node", inputSchema: [] },
    { name: "bad-env", command: "node", env: { TOKEN: 1 } },
    { name: "bad-metadata", command: "node", metadata: [] },
  ];
  const result = normalizePluginManifests({
    pluginRoot: "/plugins/bad-optional-fields",
    lumeManifest: {
      schema: "lume-plugin/v1",
      name: "bad-optional-fields",
      version: "1.0.0",
      commandTools: invalidTools,
    },
  });

  expect(result.capabilities.commandTools).toEqual([]);
  expect(result.diagnostics.filter((d) => d.code === "command_tool_invalid")).toHaveLength(invalidTools.length);
});

test("ignores executable module fields with diagnostics", () => {
  const result = normalizePluginManifests({
    pluginRoot: "/plugins/entry",
    lumeManifest: {
      schema: "lume-plugin/v1",
      name: "entry",
      version: "1.0.0",
      entry: "./dist/index.js",
    },
  });

  expect(result.diagnostics).toContainEqual(expect.objectContaining({
    code: "unsupported_field",
    path: "entry",
  }));
});
```

- [ ] **Step 4: Harden `normalizeCommandTools()` and implement legacy helper**

Update the Task 1 `normalizeCommandTools()` implementation to reject invalid optional field shapes instead of silently dropping or casting them:

```ts
function normalizeCommandTools(
  value: unknown,
  diagnostics: PluginDiagnostic[],
  pluginId: string,
  version: string,
): CommandToolContribution[] {
  if (!Array.isArray(value)) return [];
  const result: CommandToolContribution[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      diagnostics.push({ pluginId, version, severity: "warning", code: "command_tool_invalid", message: "Command tool must be an object." });
      continue;
    }
    const tool = entry as Record<string, unknown>;
    if (typeof tool.name !== "string" || typeof tool.command !== "string") {
      diagnostics.push({ pluginId, version, severity: "warning", code: "command_tool_invalid", message: "Command tool requires name and command." });
      continue;
    }
    if (tool.cwd !== undefined) {
      try {
        validatePluginPath(tool.cwd as string, "commandTools.cwd");
      } catch {
        diagnostics.push({ pluginId, version, severity: "warning", code: "command_tool_invalid", message: `Invalid cwd for command tool ${tool.name}.` });
        continue;
      }
    }
    if (tool.args !== undefined && (!Array.isArray(tool.args) || !tool.args.every((arg) => typeof arg === "string"))) {
      diagnostics.push({ pluginId, version, severity: "warning", code: "command_tool_invalid", message: `Invalid args for command tool ${tool.name}.` });
      continue;
    }
    if (tool.timeoutMs !== undefined && typeof tool.timeoutMs !== "number") {
      diagnostics.push({ pluginId, version, severity: "warning", code: "command_tool_invalid", message: `Invalid timeoutMs for command tool ${tool.name}.` });
      continue;
    }
    if (tool.inputSchema !== undefined && (!tool.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema))) {
      diagnostics.push({ pluginId, version, severity: "warning", code: "command_tool_invalid", message: `Invalid inputSchema for command tool ${tool.name}.` });
      continue;
    }
    if (tool.env !== undefined && !isStringRecord(tool.env)) {
      diagnostics.push({ pluginId, version, severity: "warning", code: "command_tool_invalid", message: `Invalid env for command tool ${tool.name}.` });
      continue;
    }
    if (tool.metadata !== undefined && (!tool.metadata || typeof tool.metadata !== "object" || Array.isArray(tool.metadata))) {
      diagnostics.push({ pluginId, version, severity: "warning", code: "command_tool_invalid", message: `Invalid metadata for command tool ${tool.name}.` });
      continue;
    }
    result.push({
      name: tool.name,
      command: tool.command,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      ...(Array.isArray(tool.args) ? { args: tool.args } : {}),
      ...(typeof tool.cwd === "string" ? { cwd: tool.cwd } : {}),
      ...(typeof tool.timeoutMs === "number" ? { timeoutMs: tool.timeoutMs } : {}),
      ...(tool.inputSchema && typeof tool.inputSchema === "object" ? { inputSchema: tool.inputSchema as Record<string, unknown> } : {}),
      ...(isStringRecord(tool.env) ? { env: tool.env } : {}),
      ...(tool.metadata && typeof tool.metadata === "object" ? { metadata: tool.metadata as Record<string, unknown> } : {}),
    });
  }
  return result;
}
```

Keep the `isStringRecord()` helper from Task 1. Also add a small `collectUnsupportedFields()` helper and call it from `normalizeLumeManifest()` before returning:

```ts
function collectUnsupportedFields(raw: Record<string, unknown>, diagnostics: PluginDiagnostic[], pluginId: string, version: string) {
  for (const field of ["entry", "main", "module"]) {
    if (raw[field] !== undefined) {
      diagnostics.push({
        pluginId,
        version,
        severity: "warning",
        code: "unsupported_field",
        message: `Ignored unsupported executable field ${field}.`,
        path: field,
      });
    }
  }
}
```

Then add legacy manifest normalization:

```ts
function normalizeLegacyCommandManifest(pluginRoot: string, raw: Record<string, unknown>): NormalizedPlugin {
  const name = typeof raw.name === "string" ? raw.name : pluginRoot.split("/").pop() ?? "legacy-plugin";
  const version = typeof raw.version === "string" ? raw.version : "local";
  const diagnostics: PluginDiagnostic[] = [{
    pluginId: name,
    version,
    severity: "info",
    code: "legacy_manifest",
    message: "Loaded legacy plugin.json command-only plugin.",
  }];
  const commandTools = normalizeCommandTools(raw.tools, diagnostics, name, version);
  if (commandTools.length === 0) throw new Error("Legacy plugin.json requires at least one command tool.");
  return {
    pluginId: name,
    name,
    version,
    root: pluginRoot,
    manifestFormat: "legacy",
    description: typeof raw.description === "string" ? raw.description : undefined,
    capabilities: { skills: [], commandTools },
    permissions: {
      mcpServers: { register: true },
      shell: { allow: true },
      tools: {
        allow: ["FileRead", "Glob", "Grep", "WebFetch", "WebSearch", "TaskList", "TaskGet", "AskUserQuestion", "Config"],
        deny: ["Bash", "FileWrite", "FileEdit", "NotebookEdit", "EnterWorktree", "ExitWorktree", "AgentTool", "SendMessage"],
      },
    },
    diagnostics,
  };
}
```

- [ ] **Step 5: Export normalized API**

Modify `packages/sdk/src/index.ts`:

```ts
export {
  normalizePluginManifests,
  type NormalizedPlugin,
  type PluginManifestCapabilities,
  type PluginDiagnostic,
  type CommandToolContribution,
  type PluginSkillContribution,
} from './plugins/normalized.js'
```

- [ ] **Step 6: Run SDK plugin tests**

Run:

```bash
rtk bun test packages/sdk/src/plugins/normalized.test.ts packages/sdk/src/plugins/manifest.test.ts packages/sdk/src/plugins/codex-adapter.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit SDK normalizer**

```bash
rtk git add packages/sdk/src/plugins/normalized.ts packages/sdk/src/plugins/normalized.test.ts packages/sdk/src/plugins/manifest.ts packages/sdk/src/plugins/manifest.test.ts packages/sdk/src/index.ts
rtk git commit -m "✨ feat(sdk): 新增插件规范化模型" \
  -m "新增 NormalizedPlugin 作为 Lume/Codex/legacy 插件的统一 manifest 表示，保持 SDK 层纯解析，不读取全局目录。" \
  -m "Constraint: 不加载插件 JS entry" \
  -m "Constraint: command tool 仅做声明式校验" \
  -m "Tested: bun test packages/sdk/src/plugins/normalized.test.ts packages/sdk/src/plugins/manifest.test.ts packages/sdk/src/plugins/codex-adapter.test.ts"
```

---

## Chunk 2: Sidecar Plugin Registry And State

### Task 3: Add plugin state store

**Files:**
- Create: `apps/sidecar/src/services/agent-runtime/plugins/plugin-state-store.ts`
- Create: `apps/sidecar/src/services/agent-runtime/plugins/plugin-state-store.test.ts`

- [ ] **Step 1: Write failing state store tests**

Create `plugin-state-store.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilePluginStateStore } from "./plugin-state-store.js";

describe("FilePluginStateStore", () => {
  test("returns empty state when file is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-plugin-state-"));
    try {
      const store = new FilePluginStateStore(join(root, "plugins-state.json"));
      await expect(store.read()).resolves.toEqual({ plugins: {} });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("writes plugin state atomically enough for callers", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-plugin-state-"));
    try {
      const path = join(root, "plugins-state.json");
      const store = new FilePluginStateStore(path);
      await store.write({
        plugins: {
          alpha: {
            pluginId: "alpha",
            activeVersion: "1.0.0",
            versions: {},
            approvalsByHash: {},
          },
        },
      });
      const raw = JSON.parse(await readFile(path, "utf-8"));
      expect(raw.plugins.alpha.activeVersion).toBe("1.0.0");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
rtk bun test apps/sidecar/src/services/agent-runtime/plugins/plugin-state-store.test.ts
```

Expected: FAIL because `plugin-state-store.ts` / `FilePluginStateStore` does not exist.

- [ ] **Step 3: Implement state store**

Create `plugin-state-store.ts`:

```ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface PluginStateFile {
  plugins: Record<string, PluginInstallRecord>;
}

export interface PluginInstallRecord {
  pluginId: string;
  activeVersion?: string;
  versions: Record<string, PluginInstalledVersion>;
  external?: Record<string, PluginExternalState>;
  approvalsByHash: Record<string, PluginApprovalBundle>;
}

export interface PluginInstalledVersion {
  pluginId: string;
  version: string;
  source: unknown;
  installedRoot: string;
  installedAt: string;
  trustedAt?: string;
  permissionsAcceptedAt?: string;
  permissionsHash?: string;
  sensitiveApprovals: Record<string, unknown>;
}

export interface PluginExternalState {
  sourceKey: string;
  permissionsHash?: string;
  permissionsAcceptedAt?: string;
  sensitiveApprovals: Record<string, unknown>;
}

export interface PluginApprovalBundle {
  permissionsHash: string;
  permissionsAcceptedAt?: string;
  sensitiveApprovals: Record<string, unknown>;
}

export class FilePluginStateStore {
  constructor(private readonly path: string) {}

  async read(): Promise<PluginStateFile> {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf-8")) as Partial<PluginStateFile>;
      return { plugins: raw.plugins ?? {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { plugins: {} };
      throw error;
    }
  }

  async write(state: PluginStateFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
    await rename(tmp, this.path);
  }
}
```

- [ ] **Step 4: Run state store test**

Run:

```bash
rtk bun test apps/sidecar/src/services/agent-runtime/plugins/plugin-state-store.test.ts
```

Expected: PASS.

### Task 4: Add registry discovery and precedence

**Files:**
- Create: `apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.ts`
- Create: `apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.test.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/index.ts`

- [ ] **Step 1: Write failing registry tests**

Create `plugin-registry.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { PluginRegistry } from "./plugin-registry.js";
import { FilePluginStateStore } from "./plugin-state-store.js";

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value), "utf-8");
}

describe("PluginRegistry", () => {
  test("discovers Lume, Codex, and legacy plugin manifests", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-plugin-registry-"));
    try {
      await writeJson(join(root, "plugins", "lume-one", "lume-plugin.json"), {
        schema: "lume-plugin/v1",
        name: "lume-one",
        version: "1.0.0",
      });
      await writeJson(join(root, "plugins", "codex-one", ".codex-plugin", "plugin.json"), {
        name: "codex-one",
        version: "1.0.0",
        interface: {},
      });
      await writeJson(join(root, "plugins", "legacy-one", "plugin.json"), {
        name: "legacy-one",
        tools: [{ name: "echo", command: "echo" }],
      });

      const registry = new PluginRegistry({
        installedRoot: join(root, "plugins"),
        legacyGlobalRoot: join(root, "plugins"),
        stateStore: new FilePluginStateStore(join(root, "state.json")),
      });
      const result = await registry.list({ enabled: [], disabled: [], directories: [] });

      expect(result.plugins.map((p) => p.pluginId).sort()).toEqual(["codex-one", "legacy-one", "lume-one"]);
      expect(result.plugins.find((p) => p.pluginId === "codex-one")?.manifestFormat).toBe("codex");
      expect(result.plugins.find((p) => p.pluginId === "legacy-one")?.manifestFormat).toBe("legacy");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Add duplicate precedence test**

Add:

```ts
test("uses workspace-local candidate before configured directories, installed store, and legacy global root", async () => {
  const root = await mkdtemp(join(tmpdir(), "lume-plugin-registry-"));
  try {
    await writeJson(join(root, "legacy-global", "same", "lume-plugin.json"), {
      schema: "lume-plugin/v1",
      name: "same",
      version: "1.0.0",
    });
    await writeJson(join(root, "installed", "same", "3.0.0", "lume-plugin.json"), {
      schema: "lume-plugin/v1",
      name: "same",
      version: "3.0.0",
    });
    await writeJson(join(root, "extra", "same", "lume-plugin.json"), {
      schema: "lume-plugin/v1",
      name: "same",
      version: "2.0.0",
    });
    await writeJson(join(root, "workspace", ".lume", "plugins", "same", "lume-plugin.json"), {
      schema: "lume-plugin/v1",
      name: "same",
      version: "local",
    });

    const stateStore = new FilePluginStateStore(join(root, "state.json"));
    await stateStore.write({
      plugins: {
        same: {
          pluginId: "same",
          activeVersion: "3.0.0",
          versions: {
            "3.0.0": {
              pluginId: "same",
              version: "3.0.0",
              source: { type: "local" },
              installedRoot: join(root, "installed", "same", "3.0.0"),
              installedAt: "2026-06-13T00:00:00.000Z",
              sensitiveApprovals: {},
            },
          },
          approvalsByHash: {},
        },
      },
    });

    const registry = new PluginRegistry({
      installedRoot: join(root, "installed"),
      legacyGlobalRoot: join(root, "legacy-global"),
      workspaceRoot: join(root, "workspace", ".lume", "plugins"),
      stateStore,
    });
    const result = await registry.list({ enabled: [], disabled: [], directories: [join(root, "extra")] });

    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0]?.root).toContain("workspace");
    expect(result.diagnostics.map((d) => d.code)).toContain("duplicate_plugin_ignored");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Add state-backed and invalid-manifest tests**

Add these tests before implementation:

```ts
test("uses activeVersion from installed plugin state", async () => {
  const root = await mkdtemp(join(tmpdir(), "lume-plugin-registry-"));
  try {
    const stateStore = new FilePluginStateStore(join(root, "state.json"));
    await writeJson(join(root, "installed", "alpha", "1.0.0", "lume-plugin.json"), {
      schema: "lume-plugin/v1",
      name: "alpha",
      version: "1.0.0",
    });
    await writeJson(join(root, "installed", "alpha", "2.0.0", "lume-plugin.json"), {
      schema: "lume-plugin/v1",
      name: "alpha",
      version: "2.0.0",
    });
    await stateStore.write({
      plugins: {
        alpha: {
          pluginId: "alpha",
          activeVersion: "1.0.0",
          versions: {
            "1.0.0": {
              pluginId: "alpha",
              version: "1.0.0",
              source: { type: "market" },
              installedRoot: join(root, "installed", "alpha", "1.0.0"),
              installedAt: "2026-06-13T00:00:00.000Z",
              permissionsHash: "hash-1",
              permissionsAcceptedAt: "2026-06-13T00:00:00.000Z",
              sensitiveApprovals: {},
            },
            "2.0.0": {
              pluginId: "alpha",
              version: "2.0.0",
              source: { type: "market" },
              installedRoot: join(root, "installed", "alpha", "2.0.0"),
              installedAt: "2026-06-13T00:00:00.000Z",
              sensitiveApprovals: {},
            },
          },
          approvalsByHash: {},
        },
      },
    });

    const registry = new PluginRegistry({
      installedRoot: join(root, "installed"),
      legacyGlobalRoot: join(root, "legacy-global"),
      stateStore,
    });
    const result = await registry.list({ enabled: [], disabled: [], directories: [] });

    expect(result.plugins.find((plugin) => plugin.pluginId === "alpha")?.version).toBe("1.0.0");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("carries external review state and keeps scanning after invalid manifests", async () => {
  const root = await mkdtemp(join(tmpdir(), "lume-plugin-registry-"));
  try {
    const stateStore = new FilePluginStateStore(join(root, "state.json"));
    await writeJson(join(root, "extra", "external", "lume-plugin.json"), {
      schema: "lume-plugin/v1",
      name: "external",
      version: "local",
    });
    await writeJson(join(root, "extra", "broken", "lume-plugin.json"), {
      schema: "lume-plugin/v1",
      version: "missing-name",
    });
    const externalPluginRoot = join(root, "extra", "external");
    const externalSourceKey = `directory:${await realpath(externalPluginRoot)}`;
    await stateStore.write({
      plugins: {
        external: {
          pluginId: "external",
          versions: {},
          external: {
            [externalSourceKey]: {
              sourceKey: externalSourceKey,
              permissionsHash: "hash-1",
              sensitiveApprovals: {},
            },
          },
          approvalsByHash: {},
        },
      },
    });

    const registry = new PluginRegistry({
      installedRoot: join(root, "installed"),
      legacyGlobalRoot: join(root, "legacy-global"),
      stateStore,
    });
    const result = await registry.list({ enabled: [], disabled: [], directories: [join(root, "extra")] });

    expect(result.plugins.map((plugin) => plugin.pluginId)).toContain("external");
    expect(result.plugins.find((plugin) => plugin.pluginId === "external")?.state?.permissionsHash).toBe("hash-1");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("invalid_manifest");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("selects highest semver from versioned directory candidates without install state", async () => {
  const root = await mkdtemp(join(tmpdir(), "lume-plugin-registry-"));
  try {
    await writeJson(join(root, "extra", "versioned", "1.0.0", "lume-plugin.json"), {
      schema: "lume-plugin/v1",
      name: "versioned",
      version: "1.0.0",
    });
    await writeJson(join(root, "extra", "versioned", "2.0.0", "lume-plugin.json"), {
      schema: "lume-plugin/v1",
      name: "versioned",
      version: "2.0.0",
    });

    const registry = new PluginRegistry({
      installedRoot: join(root, "installed"),
      legacyGlobalRoot: join(root, "legacy-global"),
      stateStore: new FilePluginStateStore(join(root, "state.json")),
    });
    const result = await registry.list({ enabled: [], disabled: [], directories: [join(root, "extra")] });

    expect(result.plugins.find((plugin) => plugin.pluginId === "versioned")?.version).toBe("2.0.0");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: Run registry tests and verify failure**

Run:

```bash
rtk bun test apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.test.ts
```

Expected: FAIL because `PluginRegistry` does not exist.

- [ ] **Step 5: Implement registry scanning**

Create `plugin-registry.ts`:

```ts
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { normalizePluginManifests, type NormalizedPlugin, type PluginDiagnostic } from "@lume/agent-sdk";
import type { FilePluginStateStore, PluginStateFile } from "./plugin-state-store.js";

export interface PluginRegistryConfig {
  installedRoot: string;
  legacyGlobalRoot: string;
  workspaceRoot?: string;
  stateStore: FilePluginStateStore;
}

export interface PluginRegistryListInput {
  enabled: string[];
  disabled: string[];
  directories: string[];
}

export interface PluginRegistryListResult {
  plugins: RegisteredPlugin[];
  diagnostics: PluginDiagnostic[];
}

export interface PluginRegistryState {
  permissionsHash?: string;
  permissionsAcceptedAt?: string;
  sensitiveApprovals: Record<string, unknown>;
}

export interface RegisteredPlugin extends NormalizedPlugin {
  state?: PluginRegistryState;
}

interface Candidate {
  plugin: RegisteredPlugin;
  bucket: number;
  scanOrder: number;
}

interface ScanSource {
  root: string;
  bucket: number;
  kind: "directory" | "pluginRoot";
}

export class PluginRegistry {
  constructor(private readonly config: PluginRegistryConfig) {}

  async list(input: PluginRegistryListInput): Promise<PluginRegistryListResult> {
    const state = await this.config.stateStore.read();
    const sources: ScanSource[] = [
      ...(this.config.workspaceRoot ? [{ root: this.config.workspaceRoot, bucket: 0, kind: "directory" as const }] : []),
      ...input.directories.map((dir, index) => ({ root: resolve(dir), bucket: 10 + index, kind: "directory" as const })),
      ...installedCandidateRoots(state, this.config.installedRoot).map((root) => ({ root, bucket: 50, kind: "pluginRoot" as const })),
      { root: this.config.legacyGlobalRoot, bucket: 100, kind: "directory" as const },
    ];
    const candidates: Candidate[] = [];
    const diagnostics: PluginDiagnostic[] = [];
    let scanOrder = 0;
    for (const source of sources) {
      for (const plugin of scanSource(source, diagnostics)) {
        candidates.push({ plugin: attachState(plugin, state), bucket, scanOrder: scanOrder++ });
      }
    }
    const selected = selectEffectiveCandidates(candidates, diagnostics);
    const enabled = new Set(input.enabled);
    const disabled = new Set(input.disabled);
    const filtered = selected.filter((plugin) => {
      if (disabled.has(plugin.pluginId)) return false;
      if (enabled.size === 0) return true;
      return enabled.has(plugin.pluginId);
    });
    return { plugins: filtered, diagnostics };
  }
}
```

Add helpers in same file. `scanSource()` distinguishes a plugin root from a directory that contains plugin roots, and `scanRoot()` also supports versioned plugin folders such as `extra/plugin-id/1.0.0/lume-plugin.json`:

```ts
function scanSource(source: ScanSource, diagnostics: PluginDiagnostic[]): NormalizedPlugin[] {
  if (!existsSync(source.root)) return [];
  if (source.kind === "pluginRoot") {
    const plugin = readPlugin(source.root, diagnostics);
    return plugin ? [plugin] : [];
  }
  return scanRoot(source.root, diagnostics);
}

function scanRoot(root: string, diagnostics: PluginDiagnostic[]): NormalizedPlugin[] {
  const plugins: NormalizedPlugin[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pluginRoot = join(root, entry.name);
    const plugin = hasPluginManifest(pluginRoot) ? readPlugin(pluginRoot, diagnostics) : null;
    if (plugin) {
      plugins.push(plugin);
      continue;
    }
    plugins.push(...scanVersionedPluginDirectory(pluginRoot, diagnostics));
  }
  return plugins;
}

function hasPluginManifest(pluginRoot: string): boolean {
  return existsSync(join(pluginRoot, "lume-plugin.json")) ||
    existsSync(join(pluginRoot, ".codex-plugin", "plugin.json")) ||
    existsSync(join(pluginRoot, "plugin.json"));
}

function scanVersionedPluginDirectory(pluginRoot: string, diagnostics: PluginDiagnostic[]): NormalizedPlugin[] {
  const plugins: NormalizedPlugin[] = [];
  for (const versionEntry of readdirSync(pluginRoot, { withFileTypes: true })) {
    if (!versionEntry.isDirectory()) continue;
    const plugin = readPlugin(join(pluginRoot, versionEntry.name), diagnostics);
    if (plugin) plugins.push(plugin);
  }
  return plugins;
}

function readJsonIfExists(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

function readPlugin(pluginRoot: string, diagnostics: PluginDiagnostic[]): NormalizedPlugin | null {
  try {
    const plugin = normalizePluginManifests({
      pluginRoot,
      lumeManifest: readJsonIfExists(join(pluginRoot, "lume-plugin.json")),
      codexManifest: readJsonIfExists(join(pluginRoot, ".codex-plugin", "plugin.json")),
      legacyManifest: readJsonIfExists(join(pluginRoot, "plugin.json")),
    });
    diagnostics.push(...plugin.diagnostics);
    return plugin;
  } catch (error) {
    diagnostics.push({
      severity: "warning",
      code: "invalid_manifest",
      message: error instanceof Error ? error.message : String(error),
      path: pluginRoot,
    });
    return null;
  }
}
```

Add installed-state helpers in the same file. Use `installedRoot` as a fallback only when a state record has `activeVersion` but the version record is missing `installedRoot`; otherwise prefer the explicit `installedRoot` in the state file:

```ts
function installedCandidateRoots(state: PluginStateFile, installedRoot: string): string[] {
  const roots: string[] = [];
  for (const record of Object.values(state.plugins)) {
    if (!record.activeVersion) continue;
    const version = record.versions[record.activeVersion];
    roots.push(version?.installedRoot ?? join(installedRoot, record.pluginId, record.activeVersion));
  }
  return roots;
}

function attachState(plugin: NormalizedPlugin, state: PluginStateFile): RegisteredPlugin {
  const record = state.plugins[plugin.pluginId];
  if (!record) return plugin;
  const versionState = record.activeVersion === plugin.version ? record.versions[plugin.version] : undefined;
  const externalState = record.external?.[sourceKey("directory", plugin.root)];
  const permissionsHash = versionState?.permissionsHash ?? externalState?.permissionsHash;
  const permissionsAcceptedAt = versionState?.permissionsAcceptedAt ?? externalState?.permissionsAcceptedAt;
  const sensitiveApprovals = versionState?.sensitiveApprovals ?? externalState?.sensitiveApprovals ?? {};
  return {
    ...plugin,
    state: {
      permissionsHash,
      permissionsAcceptedAt,
      sensitiveApprovals,
    },
  };
}

function sourceKey(sourceType: "directory", pluginRoot: string): string {
  const stableRoot = realpathSync.native(pluginRoot);
  return `${sourceType}:${stableRoot}`;
}
```

Selection:

```ts
function selectEffectiveCandidates(candidates: Candidate[], diagnostics: PluginDiagnostic[]): NormalizedPlugin[] {
  const byId = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const group = byId.get(candidate.plugin.pluginId) ?? [];
    group.push(candidate);
    byId.set(candidate.plugin.pluginId, group);
  }

  const selected: NormalizedPlugin[] = [];
  for (const [pluginId, group] of byId) {
    group.sort((left, right) =>
      left.bucket - right.bucket ||
      compareVersionForSelection(right.plugin.version, left.plugin.version) ||
      left.scanOrder - right.scanOrder
    );
    const [winner, ...ignored] = group;
    if (!winner) continue;
    selected.push(winner.plugin);
    for (const item of ignored) {
      diagnostics.push({
        pluginId,
        version: item.plugin.version,
        severity: "info",
        code: "duplicate_plugin_ignored",
        message: `Ignored duplicate plugin ${pluginId} at ${item.plugin.root}; selected ${winner.plugin.root}.`,
        path: item.plugin.root,
      });
    }
  }
  return selected.sort((left, right) => left.pluginId.localeCompare(right.pluginId));
}

function compareVersionForSelection(a: string, b: string): number {
  if (a === "local" && b !== "local") return 1;
  if (b === "local" && a !== "local") return -1;
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
```

- [ ] **Step 6: Export registry**

Modify `apps/sidecar/src/services/agent-runtime/plugins/index.ts`:

```ts
export { PluginRegistry } from "./plugin-registry.js";
export { FilePluginStateStore } from "./plugin-state-store.js";
```

Keep existing exports.

- [ ] **Step 7: Run registry tests**

Run:

```bash
rtk bun test apps/sidecar/src/services/agent-runtime/plugins/plugin-state-store.test.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit registry foundation**

```bash
rtk git add apps/sidecar/src/services/agent-runtime/plugins/plugin-state-store.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-state-store.test.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.test.ts apps/sidecar/src/services/agent-runtime/plugins/index.ts
rtk git commit -m "✨ feat(sidecar): 新增插件注册表基础" \
  -m "新增 Sidecar 插件状态文件与 PluginRegistry，统一扫描 Lume/Codex/legacy manifest 并按来源优先级去重。" \
  -m "Constraint: Phase 1 只做发现与列表，不加载 runtime 能力" \
  -m "Tested: bun test apps/sidecar/src/services/agent-runtime/plugins/plugin-state-store.test.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.test.ts"
```

---

## Chunk 3: Compatibility Wrapper And LIST_PLUGINS Migration

### Task 5: Replace SidecarPluginManager internals with registry delegation

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/plugin-manager.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/plugin-manager.test.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/attempt.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/tools/tool-runtime.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/tools/tool-runtime.test.ts`

- [ ] **Step 1: Update compatibility tests**

Rewrite `plugin-manager.test.ts` to avoid writing to `homedir()` and use tmpdir roots:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SidecarPluginManager } from "./plugin-manager.js";

describe("SidecarPluginManager compatibility wrapper", () => {
  test("resolveEnabled delegates to PluginRegistry and preserves legacy shape", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-plugin-manager-"));
    try {
      await mkdir(join(root, "alpha"), { recursive: true });
      await writeFile(join(root, "alpha", "lume-plugin.json"), JSON.stringify({
        schema: "lume-plugin/v1",
        name: "alpha",
        version: "1.0.0",
        permissions: { tools: { deny: ["Bash"] } },
      }));

      const manager = new SidecarPluginManager(root, join(root, "state.json"));
      const plugins = await manager.resolveEnabled({ enabled: ["alpha"], directories: [] });

      expect(plugins[0]?.name).toBe("alpha");
      expect(plugins[0]?.manifest.permissions?.tools?.deny).toContain("Bash");

      const contexts = await manager.buildInterceptorContexts({ enabled: ["alpha"], directories: [] });
      expect(contexts[0]?.pluginName).toBe("alpha");
      expect(contexts[0]?.permissions.tools?.deny).toContain("Bash");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

Note: make `resolveEnabled()` async. Update all call sites in this task.

- [ ] **Step 2: Run compatibility test and verify failure**

Run:

```bash
rtk bun test apps/sidecar/src/services/agent-runtime/plugins/plugin-manager.test.ts
```

Expected: FAIL because constructor/signature has not changed.

- [ ] **Step 3: Implement wrapper delegation**

Modify `plugin-manager.ts`:

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import type { LumePluginManifest } from "@lume/agent-sdk/plugins/manifest.js";
import { PluginRegistry } from "./plugin-registry.js";
import { FilePluginStateStore } from "./plugin-state-store.js";

export interface ResolvedPlugin {
  name: string;
  version: string;
  root: string;
  manifestFormat: "lume" | "codex" | "legacy";
  manifest: LumePluginManifest;
  diagnostics?: unknown[];
}

export class SidecarPluginManager {
  constructor(
    private readonly pluginRoot = join(homedir(), ".lume", "plugins"),
    private readonly statePath = join(homedir(), ".lume", "plugins-state.json"),
  ) {}

  async resolveEnabled(config: { enabled: string[]; directories: string[] }): Promise<ResolvedPlugin[]> {
    const registry = new PluginRegistry({
      installedRoot: this.pluginRoot,
      legacyGlobalRoot: this.pluginRoot,
      stateStore: new FilePluginStateStore(this.statePath),
    });
    const result = await registry.list({
      enabled: config.enabled,
      disabled: [],
      directories: config.directories,
    });
    return result.plugins.map((plugin) => ({
      name: plugin.name,
      version: plugin.version,
      root: plugin.root,
      manifestFormat: plugin.manifestFormat,
      manifest: {
        schema: "lume-plugin/v1",
        name: plugin.name,
        version: plugin.version,
        description: plugin.description,
        displayName: plugin.displayName,
        skills: plugin.capabilities.skills.map((skill) => skill.root),
        hooks: plugin.capabilities.hooksConfigPath,
        mcpServers: plugin.capabilities.mcpServersConfigPath,
        commandTools: plugin.capabilities.commandTools,
        permissions: plugin.permissions,
      },
      diagnostics: plugin.diagnostics,
    }));
  }

  async buildInterceptorContexts(config: { enabled: string[]; directories: string[] }) {
    const plugins = await this.resolveEnabled(config);
    return plugins.map((p) => ({
      pluginName: p.name,
      pluginRoot: p.root,
      permissions: p.manifest.permissions ?? {},
    }));
  }
}
```

- [ ] **Step 4: Update async call sites**

Search:

```bash
rtk rg -n "resolveEnabled\\(|buildInterceptorContexts\\(" apps/sidecar/src
```

Update each call site to `await`.

Known files:

- `apps/sidecar/src/services/agent-runtime/runtime-core/attempt.ts`
- `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts`
- `apps/sidecar/src/services/agent-runtime/tools/tool-runtime.ts`
- `apps/sidecar/src/services/agent-runtime/tools/tool-runtime.test.ts`

Make these concrete changes:

- In `attempt.ts`, change `pluginManager.buildInterceptorContexts(...)` to `await pluginManager.buildInterceptorContexts(...)` inside the existing async attempt flow.
- In `tool-runtime.ts`, change `ToolRuntime.resolveCommandPluginSpecs()` to `static async resolveCommandPluginSpecs(...)` and await `manager.resolveEnabled(...)`.
- In `run.ts`, await `ToolRuntime.resolveCommandPluginSpecs(...)` before constructing the runtime/tool plan.
- In `tool-runtime.test.ts`, await `ToolRuntime.resolveCommandPluginSpecs(...)` in the command plugin test.

Do not introduce sync filesystem reads just to keep the old method synchronous; the registry and state file are async by design.

- [ ] **Step 5: Run affected sidecar plugin tests**

Run:

```bash
rtk bun test apps/sidecar/src/services/agent-runtime/plugins/plugin-manager.test.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.test.ts apps/sidecar/src/services/agent-runtime/plugins/permission-interceptor.test.ts
```

Expected: PASS.

### Task 6: Migrate LIST_PLUGINS to registry output

**Files:**
- Modify: `packages/shared/src/types/agent.ts`
- Modify: `apps/sidecar/src/rpc/agent-handlers.ts`
- Create: `apps/sidecar/src/rpc/agent-handlers.list-plugins.test.ts`
- Modify: `apps/web/src/components/agent/AgentInput.tsx`
- Modify: `apps/web/src/components/welcome/LumeWelcomeSurface.tsx`

- [ ] **Step 1: Add shared plugin list types**

Add near the existing `LIST_PLUGINS` channel types area in `packages/shared/src/types/agent.ts`:

```ts
export interface AgentPluginDiagnostic {
  pluginId?: string;
  version?: string;
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  path?: string;
}

export interface AgentPluginListItem {
  pluginId: string;
  name: string;
  version: string;
  root: string;
  manifestFormat: "lume" | "codex" | "legacy";
  description?: string;
  displayName?: string;
  skills: number;
  hooks?: string;
  mcpServers?: string;
  commandTools: number;
  diagnostics: AgentPluginDiagnostic[];
}

export interface AgentListPluginsResult {
  plugins: AgentPluginListItem[];
  diagnostics: AgentPluginDiagnostic[];
}
```

- [ ] **Step 2: Add RPC handler test**

Create `apps/sidecar/src/rpc/agent-handlers.list-plugins.test.ts` following the local `agent-handlers.*.test.ts` style. The test should exercise the `LIST_PLUGINS` handler and assert the new result shape without depending on real user home state:

```ts
import { describe, expect, test } from "bun:test";
import { AGENT_IPC_CHANNELS, type AgentListPluginsResult } from "@lume/shared";
import { createAgentHandlers } from "./agent-handlers.js";

describe("agent handlers LIST_PLUGINS", () => {
  test("returns normalized plugin list result shape", async () => {
    const handlers = createAgentHandlers({
      writeNotification: () => undefined,
      planModePhaseTracker: {
        isLikelyExecutionRequest: () => false,
        getPhase: () => "idle",
        clearSession: () => undefined,
      },
      notifyPlanModePhaseChange: () => undefined,
    });
    const result = await handlers[AGENT_IPC_CHANNELS.LIST_PLUGINS]!({}) as AgentListPluginsResult;

    expect(result).toHaveProperty("plugins");
    expect(result).toHaveProperty("diagnostics");
    expect(Array.isArray(result.plugins)).toBe(true);
    expect(Array.isArray(result.diagnostics)).toBe(true);
  });
});
```

This test intentionally asserts only the response envelope. Registry discovery details stay covered in `plugin-registry.test.ts`.

- [ ] **Step 3: Update `LIST_PLUGINS` handler**

Modify `apps/sidecar/src/rpc/agent-handlers.ts`:

```ts
import type { AgentPluginDiagnostic } from "@lume/shared";

[AGENT_IPC_CHANNELS.LIST_PLUGINS]: async () => {
  const manager = new SidecarPluginManager();
  const plugins = await manager.resolveEnabled({ enabled: [], directories: [] });
  const items = plugins.map((p) => ({
    pluginId: p.name,
    name: p.name,
    version: p.version,
    root: p.root,
    manifestFormat: p.manifestFormat,
    description: p.manifest.description,
    displayName: p.manifest.displayName,
    hooks: p.manifest.hooks,
    mcpServers: p.manifest.mcpServers,
    skills: p.manifest.skills?.length ?? 0,
    commandTools: p.manifest.commandTools?.length ?? 0,
    diagnostics: (p.diagnostics ?? []) as AgentPluginDiagnostic[],
  }));
  return {
    plugins: items,
    diagnostics: items.flatMap((item) => item.diagnostics),
  };
},
```

`manifestFormat` must come from `ResolvedPlugin`; do not hardcode `"lume"` because Phase 1 listing must distinguish Lume, Codex, and legacy manifests.

- [ ] **Step 4: Preserve current AgentInput compatibility**

Current UI casts `LIST_PLUGINS` directly to an array in two places. Adjust both minimally:

- `apps/web/src/components/agent/AgentInput.tsx`
- `apps/web/src/components/welcome/LumeWelcomeSurface.tsx`

```ts
const result = await sidecarCall(AGENT_IPC_CHANNELS.LIST_PLUGINS, {})
const plugins = Array.isArray(result)
  ? result
  : (result as { plugins?: Array<{ name: string; version: string; description?: string }> }).plugins ?? []
setInstalledPlugins(plugins)
```

Do not redesign the plugin popover in Phase 1. Preserve `plugin.name` as the plugin id/name used by `onPluginSelect`; display labels can use `displayName` in a later UI phase.

- [ ] **Step 5: Run focused tests/type checks**

Run:

```bash
rtk bun test apps/sidecar/src/services/agent-runtime/plugins/plugin-manager.test.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.test.ts apps/sidecar/src/services/agent-runtime/tools/tool-runtime.test.ts
rtk bun test apps/sidecar/src/rpc/agent-handlers.list-plugins.test.ts
```

If TypeScript signatures changed in shared/web, run:

```bash
rtk bun run --filter @lume/shared typecheck
rtk bun run --filter @lume/sidecar typecheck
rtk bun run --filter @lume/web typecheck
```

Expected: PASS. If unrelated dirty worktree files cause typecheck failures, capture the error and do not fix unrelated files in this phase.

- [ ] **Step 6: Commit compatibility migration**

```bash
rtk git add packages/shared/src/types/agent.ts apps/sidecar/src/rpc/agent-handlers.ts apps/sidecar/src/rpc/agent-handlers.list-plugins.test.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-manager.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-manager.test.ts apps/sidecar/src/services/agent-runtime/runtime-core/attempt.ts apps/sidecar/src/services/agent-runtime/runtime-core/run.ts apps/sidecar/src/services/agent-runtime/tools/tool-runtime.ts apps/sidecar/src/services/agent-runtime/tools/tool-runtime.test.ts apps/web/src/components/agent/AgentInput.tsx apps/web/src/components/welcome/LumeWelcomeSurface.tsx
rtk git commit -m "♻️ refactor(sidecar,shared,web): 插件列表改用注册表" \
  -m "LIST_PLUGINS 改由 PluginRegistry 提供 normalized diagnostics，同时保持现有插件弹窗兼容旧数组返回。" \
  -m "Constraint: 不改变 runtime tool 加载行为" \
  -m "Tested: bun test apps/sidecar/src/services/agent-runtime/plugins/plugin-manager.test.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.test.ts apps/sidecar/src/services/agent-runtime/tools/tool-runtime.test.ts apps/sidecar/src/rpc/agent-handlers.list-plugins.test.ts" \
  -m "Tested: bun run --filter @lume/shared typecheck && bun run --filter @lume/sidecar typecheck && bun run --filter @lume/web typecheck"
```

---

## Chunk 4: Phase 1 Verification And Handoff

### Task 7: Verify Phase 1 boundaries

**Files:**
- Modify only if needed: tests from previous chunks

- [ ] **Step 1: Verify no runtime loading path was changed**

Run:

```bash
rtk git diff HEAD~3..HEAD -- apps/sidecar/src/services/agent-runtime/tools/tool-runtime.ts packages/sdk/src/plugins/loader.ts packages/sdk/src/agent.ts
```

Expected: No changes, or only async compatibility if required by `SidecarPluginManager`. There must be no new MCP startup, hook registration, command tool exposure, or Agent tool pool changes.

- [ ] **Step 2: Run all plugin-focused tests**

Run:

```bash
rtk bun test packages/sdk/src/plugins/normalized.test.ts packages/sdk/src/plugins/manifest.test.ts packages/sdk/src/plugins/codex-adapter.test.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-state-store.test.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.test.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-manager.test.ts apps/sidecar/src/services/agent-runtime/plugins/permission-interceptor.test.ts
rtk bun test apps/sidecar/src/rpc/agent-handlers.list-plugins.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run targeted typecheck only if shared/RPC/web signatures changed**

Run:

```bash
rtk bun run --filter @lume/shared typecheck
rtk bun run --filter @lume/sidecar typecheck
rtk bun run --filter @lume/web typecheck
```

Expected: PASS. If it fails due to unrelated existing dirty worktree changes, record the failure and do not broaden scope.

- [ ] **Step 4: Inspect git status for unrelated changes**

Run:

```bash
rtk git status --short
```

Expected: Only files touched by this plan are staged/modified for this work. Leave existing unrelated dirty files alone.

- [ ] **Step 5: Commit verification fixes if any**

If previous verification required small fixes:

```bash
rtk git add packages/sdk/src/plugins/normalized.ts packages/sdk/src/plugins/normalized.test.ts packages/sdk/src/plugins/manifest.ts packages/sdk/src/plugins/manifest.test.ts packages/sdk/src/index.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-state-store.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-state-store.test.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.test.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-manager.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-manager.test.ts apps/sidecar/src/services/agent-runtime/plugins/index.ts apps/sidecar/src/services/agent-runtime/runtime-core/attempt.ts apps/sidecar/src/services/agent-runtime/runtime-core/run.ts apps/sidecar/src/services/agent-runtime/tools/tool-runtime.ts apps/sidecar/src/services/agent-runtime/tools/tool-runtime.test.ts packages/shared/src/types/agent.ts apps/sidecar/src/rpc/agent-handlers.ts apps/sidecar/src/rpc/agent-handlers.list-plugins.test.ts apps/web/src/components/agent/AgentInput.tsx apps/web/src/components/welcome/LumeWelcomeSurface.tsx
rtk git commit -m "✅ test(sidecar,sdk): 验证插件注册表阶段" \
  -m "补齐 Phase 1 插件 normalizer、registry 与 LIST_PLUGINS 的回归测试。" \
  -m "Tested: bun test packages/sdk/src/plugins/normalized.test.ts packages/sdk/src/plugins/manifest.test.ts packages/sdk/src/plugins/codex-adapter.test.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-state-store.test.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.test.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-manager.test.ts apps/sidecar/src/services/agent-runtime/plugins/permission-interceptor.test.ts apps/sidecar/src/rpc/agent-handlers.list-plugins.test.ts" \
  -m "Tested: bun run --filter @lume/shared typecheck && bun run --filter @lume/sidecar typecheck && bun run --filter @lume/web typecheck"
```

If no fixes are needed, do not create an empty commit.

### Task 8: Phase 1 completion report

**Files:**
- No code changes.

- [ ] **Step 1: Summarize completed Phase 1**

Final report must include:

- Changed files.
- Simplifications made.
- Remaining risks.
- Tests run.
- Explicit statement that runtime capability loading is not implemented in Phase 1.

- [ ] **Step 2: Point to next plan**

Recommend the next plan:

`docs/superpowers/plans/2026-06-14-lume-plugin-platform-phase-2-permission-foundation.md`

That plan should implement permission foundation before runtime capabilities, matching the approved spec.
