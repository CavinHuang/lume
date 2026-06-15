# Lume Plugin Platform Phase 3b — PluginRuntimeBridge (Data Wiring) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Phase 3b of the plugin platform — the `PluginRuntimeBridge` data-wiring layer that consumes the Phase 3a `PluginCapabilityResolver` output and feeds **command tools** and **skills** into the live agent runtime inside `createRuntimeCoreSession`, replacing the current SDK-`loadPlugins` + manual-`registerSkill` path with a single registry→resolver→bridge pipeline. No sensitive gating (Phase 3c), no plugin hooks (Phase 3d), no MCP merge (separate plan).

**Architecture:** A pure sidecar function `assemblePluginRuntime(plugins: RegisteredPlugin[])` runs `resolvePluginCapabilities` (Phase 3a) over the registry's `RegisteredPlugin[]`, then builds (a) `ToolDefinition[]` for each `ResolvedCommandTool` via a newly-exported SDK helper `buildCommandToolDefinition(contribution, pluginRoot)`, and (b) the namespaced `SkillDefinition[]` to register. `createRuntimeCoreSession` (`run.ts`) calls `SidecarPluginManager.listRegistered` (new, returns the full `RegisteredPlugin[]` without the current downgrade mapping) → `assemblePluginRuntime` → injects command-tool `ToolDefinition`s as a new `buildRuntimeCoreTools` group and registers the skills, and **stops passing `plugins` to `createAgent`** so the SDK's internal `loadPlugins` no longer competes. Command-tool exec / MCP / hook **permission gating stays in Phase 3c** — 3b only moves WHERE the data comes from, not whether it is gated.

**Tech Stack:** TypeScript, Bun test, existing `@lume/agent-sdk` plugin exports (`CommandToolContribution`, `ToolDefinition`, `SkillDefinition`, `loadFilesystemSkills`), Phase 3a `resolvePluginCapabilities` + result types, existing Sidecar `PluginRegistry` / `SidecarPluginManager` / `RegisteredPlugin`, existing `buildRuntimeCoreTools` / `createAgent` plumbing in `run.ts`.

---

## Scope

Implements the **data-wiring** slice of [the approved design spec](../specs/2026-06-13-lume-plugin-platform-design.md) §6.4 (`PluginRuntimeBridge`) + §14.3 (Phase 3 acceptance, command-tools/skills portion):

- New `PluginRuntimeBridge` assembly function consuming Phase 3a resolver output (§6.4).
- Command tools: `ResolvedCommandTool` → `ToolDefinition` (§6.3/§6.4; the deferred conversion from Phase 3a Design Decision 1).
- Skills: `ResolvedSkill` → registered via `registerSkill`, replacing the manual `run.ts:899-943` path (§6.4).
- Stop passing `agentOptions.plugins` to `createAgent` — the SDK's internal `loadPlugins` no longer handles plugin command tools / skills; the bridge owns that now (§6.4 "取代 'command-only plugin spec' 作为 runtime 接入点").
- Converge the scan path: `createRuntimeCoreSession` reads `RegisteredPlugin[]` directly (with Phase 2 `permissionState`), not the downgraded `ResolvedPlugin[]`.

**Out of scope (deferred):**

- **Plugin MCP server merge** — spec §16.7 requires plugin MCP servers be managed by the existing `WorkspaceMcpManager` (child-process / network lifecycle, stop on disable/reload/session-shutdown). That is a per-session overlay onto a per-workspace singleton and needs its own lifecycle design — separate plan. In 3b, `ResolvedMcpServer[]` is produced by the resolver but **not yet wired** (the bridge ignores it; a `capability_filtered`-style note is not needed since the resolver already gated on `permissions.mcpServers.register`).
- **Sensitive capability gating** (`PluginPermissionRuntime.checkSensitiveCapability`, `ask`→block) — Phase 3c. 3b's command-tool `ToolDefinition`s carry no gate; the existing `canUseTool` chain is unchanged.
- **Plugin hooks** — Phase 3d. Cutting `agentOptions.plugins` means the SDK no longer injects plugin hooks (it did via `loadPlugins` → `resolveHooksConfig` → `resetHookRegistry`). That is intentional and acceptable for 3b: plugin hooks were never surfaced to users yet, and 3d rebuilds hook registration through a sidecar-owned `HookRegistry`. **Call out in Task 5's boundary check** that plugin hooks are now inert until 3d.
- **`/reload-plugins`** RPC + tool-pool hot-swap — Phase 3d.
- Migrating `attempt.ts`'s `SidecarPluginManager.buildInterceptorContexts` (Phase 1 permission-interceptor path) — that is rewritten in Phase 3c with the sensitive gate.

**Constraints:**

- **Runtime behavior must stay correct for the non-plugin path.** Built-in tools, workspace MCP (non-plugin), and filesystem skills are untouched. The Phase 1+2+3a test baseline (74 passing) must stay green.
- **Touch surface:** `run.ts` (the plugin-wiring section ~893-1080), `buildRuntimeCoreTools` signature (add one optional group), `SidecarPluginManager` (add one method), SDK `loader.ts` (extract one export) + `index.ts` (re-export). Do NOT touch `attempt.ts`, `permission-interceptor.ts`, `permission-runtime.ts`, `workspace-mcp-manager.ts`, `agent.ts`, or `hooks.ts`.
- Legacy `plugin.json` command-only plugins must still work (their command tools flow through the normalizer → resolver → bridge identically to Lume-native plugins).
- Match Phase 1/2/3a style: 2-space indent, double quotes in sidecar / single quotes in SDK, no `any`, `bun:test`, `mkdtemp` fixtures.

## Design Decisions

1. **Cut `agentOptions.plugins`; the bridge owns command tools + skills.** Today `run.ts:1048` passes `pluginResolution.specs` to `createAgent`, and the SDK's `loadPlugins` reads each `plugin.json` to build command-tool `ToolDefinition`s, register plugin skills (`registerPluginSkills`), and register plugin hooks (`resetHookRegistry`). 3b removes that `plugins` argument and has the sidecar build command tools + register skills itself from resolver output. Net effect: one source of truth (registry → resolver → bridge), no double-loading. The side effect is that plugin hooks go inert until Phase 3d rebuilds registration — acceptable and called out.

2. **Export `buildCommandToolDefinition(contribution, pluginRoot)` from the SDK.** `packages/sdk/src/plugins/loader.ts:80` `commandToolFromManifest` is private and builds a `ToolDefinition` with an `execFile` handler from a `CommandToolManifest`. 3b extracts this as a public `buildCommandToolDefinition(contribution: CommandToolContribution, pluginRoot: string)` so the bridge does NOT duplicate the ~50-line `execFile`/timeout/cwd/env logic. Differences from `commandToolFromManifest`: (a) input is the normalized `CommandToolContribution` (which carries `env`, absent from the legacy `CommandToolManifest`), so the exec `env` merges `contribution.env`; (b) `pluginRoot` is absolute (the resolver already resolved paths). The legacy `commandToolFromManifest` is left in place for the SDK's own `loadPlugins` path (not removed — surgical change).

3. **`assemblePluginRuntime` is a pure function of `RegisteredPlugin[]`.** It takes the registry's plugins (with `permissionState` + `root`) and returns `{ commandToolDefinitions: ToolDefinition[]; skills: SkillDefinition[]; diagnostics: PluginDiagnostic[] }`. It calls `resolvePluginCapabilities` (3a), then maps `ResolvedCommandTool` → `buildCommandToolDefinition` (using a `pluginId → root` lookup, since `ResolvedCommandTool` carries `pluginId` + `contribution` but not `root`) and collects `ResolvedSkill.definition`. Pure + unit-testable with hand-built `RegisteredPlugin[]` fixtures (no real registry needed).

4. **`SidecarPluginManager.listRegistered(config)` returns the full `RegisteredPlugin[]`.** The current `resolveEnabled` downgrades `RegisteredPlugin[]` → `ResolvedPlugin[]` (drops `permissionState` and flattens capabilities into a `LumePluginManifest` view, `plugin-manager.ts:36-56`). The resolver needs `RegisteredPlugin` (with `permissionState` + `capabilities` + `root`). 3b adds `listRegistered` that returns `registry.list(...).plugins` directly (no downgrade). `resolveEnabled` / `buildInterceptorContexts` are left untouched (Phase 3c rewrites the interceptor path).

5. **Command-tool `pluginId` is carried via the `ToolDefinition.name`.** The bridge namespaces each command tool's name as `${pluginId}:${contribution.name}` (mirroring the skill namespace convention) so Phase 3c's `canUseTool` gate can recover the source `pluginId` from the tool name and call `checkSensitiveCapability` with `commandTool:${name}`. (If `contribution.name` already includes a namespace, this is a no-op — but normalizer output does not.) This is the only forward-looking hook for 3c; 3b itself does no gating.

6. **No MCP wiring in 3b.** `assemblePluginRuntime` ignores `ResolvedMcpServer[]`. Documented as deferred per §16.7. Plugin MCP servers are NOT started in 3b.

## File Structure

SDK (one extracted export):

- Modify `packages/sdk/src/plugins/loader.ts` — add `export function buildCommandToolDefinition(contribution: CommandToolContribution, pluginRoot: string): ToolDefinition` (extracted from `commandToolFromManifest`, with `env` support).
- Modify `packages/sdk/src/plugins/loader.test.ts` (or create if absent) — test `buildCommandToolDefinition` shape + env merge.
- Modify `packages/sdk/src/index.ts` — re-export `buildCommandToolDefinition`.

Sidecar (the bridge + plumbing):

- Create `apps/sidecar/src/services/agent-runtime/plugins/runtime-bridge.ts` — `assemblePluginRuntime(plugins)` + `PluginRuntimeAssembly` type.
- Create `apps/sidecar/src/services/agent-runtime/plugins/runtime-bridge.test.ts` — unit tests over hand-built `RegisteredPlugin[]`.
- Modify `apps/sidecar/src/services/agent-runtime/plugins/plugin-manager.ts` — add `listRegistered(config): Promise<RegisteredPlugin[]>`.
- Modify `apps/sidecar/src/services/agent-runtime/plugins/plugin-manager.test.ts` — test `listRegistered` returns `RegisteredPlugin[]` with `permissionState`.
- Modify `apps/sidecar/src/services/agent-runtime/plugins/index.ts` — export `assemblePluginRuntime` + `PluginRuntimeAssembly`.
- Modify `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts` — call `listRegistered` → `assemblePluginRuntime`; inject `commandToolDefinitions` into `buildRuntimeCoreTools` (new `pluginCommandTools` group); register `assembly.skills`; remove `plugins:` from `agentOptions`; delete the manual `run.ts:899-943` skill-loading loop.

---

## Chunk 1: SDK — export `buildCommandToolDefinition`

Extract the command-tool `ToolDefinition` builder from the private `commandToolFromManifest` so the bridge can reuse it without duplicating `execFile` logic. Independent, shippable on its own.

### Task 1: Extract and export `buildCommandToolDefinition`

**Files:**
- Modify: `packages/sdk/src/plugins/loader.ts`
- Modify: `packages/sdk/src/plugins/loader.test.ts` (create if it does not exist)
- Modify: `packages/sdk/src/index.ts`

- [ ] **Step 1: Write the failing test**

`packages/sdk/src/plugins/loader.test.ts` already exists — append to its top level (it uses `bun:test`). The test:

```ts
import { describe, expect, test } from "bun:test";
import { buildCommandToolDefinition } from "./loader.js";
import type { CommandToolContribution } from "./normalized.js";

const contribution: CommandToolContribution = {
  name: "echo",
  command: "node",
  args: ["./tools/echo.mjs"],
  cwd: "./",
  timeoutMs: 5000,
  env: { ECHO_MODE: "plain" },
  inputSchema: { type: "object", properties: { msg: { type: "string" } } },
};

describe("buildCommandToolDefinition", () => {
  test("builds a ToolDefinition with namespaced-agnostic name, schema, and flags", () => {
    const def = buildCommandToolDefinition(contribution, "/plugins/acme");
    expect(def.name).toBe("echo");
    expect(def.description).toBe("echo");
    expect(def.inputSchema).toEqual(contribution.inputSchema);
    expect(def.isReadOnly?.()).toBe(false);
    expect(def.isConcurrencySafe?.()).toBe(false);
    expect(typeof def.call).toBe("function");
  });

  test("uses a default object schema when inputSchema is absent", () => {
    const def = buildCommandToolDefinition(
      { name: "ct", command: "echo" },
      "/plugins/acme",
    );
    expect(def.inputSchema).toEqual({ type: "object", properties: {} });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `rtk bun test packages/sdk/src/plugins/loader.test.ts`
Expected: FAIL — `buildCommandToolDefinition is not exported` (or module missing).

- [ ] **Step 3: Implement `buildCommandToolDefinition`**

In `packages/sdk/src/plugins/loader.ts`, add `CommandToolContribution` to the local types it can see. It already imports types from `../types.js`; add an import of `CommandToolContribution` from `./normalized.js`:

```ts
import type { CommandToolContribution } from "./normalized.js";
```

Then add this exported function (place it just above the existing private `commandToolFromManifest`, around line 80). It mirrors `commandToolFromManifest` but reads from `CommandToolContribution` and merges `contribution.env` into the child-process env:

```ts
/**
 * Build a ToolDefinition for a plugin command tool (spec §6.3/§16.3).
 *
 * Extracted from the private commandToolFromManifest so the sidecar
 * PluginRuntimeBridge can build command-tool definitions from normalized
 * CommandToolContribution values without going through SDK loadPlugins.
 * `pluginRoot` MUST be absolute (the resolver/normalizer resolve relative
 * paths against the plugin root).
 */
export function buildCommandToolDefinition(
  contribution: CommandToolContribution,
  pluginRoot: string,
): ToolDefinition {
  return {
    name: contribution.name,
    description: contribution.description || contribution.name,
    inputSchema: contribution.inputSchema || { type: "object", properties: {} },
    isReadOnly: () => contribution.metadata?.isReadOnly === true,
    isConcurrencySafe: () => contribution.metadata?.isConcurrencySafe === true,
    async call(input, context) {
      const payload = JSON.stringify(input ?? {});
      const timeout = Math.max(1, contribution.timeoutMs ?? 30_000);
      const cwd = contribution.cwd ? resolve(pluginRoot, contribution.cwd) : pluginRoot;
      const args = [...(contribution.args ?? []), payload];
      return await new Promise((resolveResult) => {
        const child = execFile(contribution.command, args, {
          cwd,
          timeout,
          maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            PLUGIN_INPUT: payload,
            ...(contribution.env ?? {}),
            ...(context.toolConfig?.env && typeof context.toolConfig.env === "object"
              ? (context.toolConfig.env as Record<string, string>)
              : {}),
          },
        }, (error, stdout, stderr) => {
          if (error) {
            const output = [error.message, stderr && `stderr: ${stderr}`, stdout && `stdout: ${stdout}`]
              .filter(Boolean)
              .join("\n");
            resolveResult({
              type: "tool_result",
              tool_use_id: context.toolUseId ?? "",
              content: output,
              is_error: true,
            });
            return;
          }
          resolveResult({
            type: "tool_result",
            tool_use_id: context.toolUseId ?? "",
            content: stdout || stderr || "(no output)",
          });
        });
        if (context.abortSignal) {
          context.abortSignal.addEventListener("abort", () => child.kill(), { once: true });
        }
      });
    },
    runtimeMetadata: {
      ...(contribution.metadata ?? {}),
      source: "plugin",
    },
  };
}
```

(Leave the existing private `commandToolFromManifest` and `normalizeManifestTools` untouched — the legacy `loadPlugins` path still uses them. Do not refactor them to call `buildCommandToolDefinition`; that is out of 3b's surgical scope.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `rtk bun test packages/sdk/src/plugins/loader.test.ts`
Expected: PASS — both new tests pass.

- [ ] **Step 5: Re-export from the SDK barrel**

In `packages/sdk/src/index.ts`, find the existing plugin-exports block (it re-exports `computePermissionsHash`, `resolveSensitiveApproval`, `NormalizedPlugin`, etc. from `./plugins/...js`). Add `buildCommandToolDefinition` to the `loader.js` re-export. If there is no existing `loader.js` re-export, add one:

```ts
export { buildCommandToolDefinition } from "./plugins/loader.js";
```

(Place it near the other `./plugins/...` re-exports around line 205-230.)

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/plugins/loader.ts packages/sdk/src/plugins/loader.test.ts packages/sdk/src/index.ts
git commit -m "✨ feat(sdk): 导出 buildCommandToolDefinition 供 bridge 复用"
```

---

## Chunk 2: `SidecarPluginManager.listRegistered` (return full `RegisteredPlugin[]`)

The resolver needs `RegisteredPlugin` (with `permissionState` + `capabilities` + `root`), but the current `resolveEnabled` downgrades to `ResolvedPlugin`. Add a non-downgrading accessor.

### Task 2: Add `listRegistered`

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/plugin-manager.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/plugin-manager.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/sidecar/src/services/agent-runtime/plugins/plugin-manager.test.ts` (inside its top-level `describe`):

```ts
  test("listRegistered returns RegisteredPlugin[] with permissionState and capabilities", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-plugins-"));
    try {
      await writeJson(join(root, "acme", "lume-plugin.json"), {
        schema: "lume-plugin/v1",
        name: "acme",
        version: "1.0.0",
        commandTools: [{ name: "echo", command: "node" }],
      });
      const manager = new SidecarPluginManager(root, join(root, "state.json"));
      const plugins = await manager.listRegistered({ enabled: [], directories: [] });

      expect(plugins).toHaveLength(1);
      const plugin = plugins[0];
      expect(plugin?.pluginId).toBe("acme");
      expect(plugin?.root).toBe(join(root, "acme"));
      expect(plugin?.capabilities.commandTools.map((t) => t.name)).toEqual(["echo"]);
      expect(plugin?.permissionState).toBeDefined();
      const state = plugin?.permissionState?.state;
      if (state) {
        expect(["loaded", "needs-review", "not-loaded"]).toContain(state);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
```

(`plugin-manager.test.ts` already exists. Ensure its imports include `mkdtemp`, `rm`, `tmpdir`, `join`, and a `writeJson` helper — if `writeJson` is not defined there, add it mirroring `plugin-registry.test.ts:8-11`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/plugin-manager.test.ts -t "listRegistered"`
Expected: FAIL — `manager.listRegistered is not a function`.

- [ ] **Step 3: Implement `listRegistered`**

In `apps/sidecar/src/services/agent-runtime/plugins/plugin-manager.ts`, add `RegisteredPlugin` to the imports from `./plugin-registry.js` and add the method. The import line currently is `import { PluginRegistry } from "./plugin-registry.js";` — change to:

```ts
import { PluginRegistry, type RegisteredPlugin } from "./plugin-registry.js";
```

Then add this method to the `SidecarPluginManager` class (after `resolveEnabled`, before `buildInterceptorContexts`):

```ts
  /**
   * Return the full RegisteredPlugin[] (with Phase 2 permissionState + capabilities),
   * WITHOUT the downgrade mapping that resolveEnabled applies. Used by the Phase 3b
   * PluginRuntimeBridge → PluginCapabilityResolver pipeline.
   */
  async listRegistered(config: {
    enabled: string[];
    directories: string[];
  }): Promise<RegisteredPlugin[]> {
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
    return result.plugins;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/plugin-manager.test.ts`
Expected: PASS — the new test passes; existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/plugins/plugin-manager.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-manager.test.ts
git commit -m "✨ feat(sidecar): SidecarPluginManager 暴露 listRegistered 保留 RegisteredPlugin[]"
```

---

## Chunk 3: `PluginRuntimeBridge.assemblePluginRuntime` (pure function)

The core of the bridge: take `RegisteredPlugin[]`, run the Phase 3a resolver, build command-tool `ToolDefinition[]` (namespaced) and collect skills, surface diagnostics. Pure, fully unit-testable.

### Task 3: Implement `assemblePluginRuntime` — command tools + skills + diagnostics

**Files:**
- Create: `apps/sidecar/src/services/agent-runtime/plugins/runtime-bridge.ts`
- Create: `apps/sidecar/src/services/agent-runtime/plugins/runtime-bridge.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/sidecar/src/services/agent-runtime/plugins/runtime-bridge.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { assemblePluginRuntime } from "./runtime-bridge.js";
import type { RegisteredPlugin } from "./plugin-registry.js";

function makePlugin(root: string, overrides: Partial<RegisteredPlugin> = {}): RegisteredPlugin {
  return {
    pluginId: "acme",
    name: "acme",
    version: "1.0.0",
    root,
    manifestFormat: "lume",
    capabilities: { skills: [], commandTools: [] },
    permissions: {},
    diagnostics: [],
    permissionState: { state: "loaded", reason: "loaded" },
    ...overrides,
  };
}

describe("assemblePluginRuntime", () => {
  test("builds namespaced command-tool ToolDefinitions from resolver output", async () => {
    const plugin = makePlugin("/plugins/acme", {
      capabilities: {
        skills: [],
        commandTools: [{ name: "echo", command: "node", args: ["./echo.mjs"] }],
      },
    });

    const assembly = await assemblePluginRuntime([plugin]);

    expect(assembly.commandToolDefinitions).toHaveLength(1);
    const def = assembly.commandToolDefinitions[0];
    expect(def?.name).toBe("acme:echo");
    expect(def?.description).toBe("echo");
    expect(typeof def?.call).toBe("function");
    expect((def as { runtimeMetadata?: { source?: string } }).runtimeMetadata?.source).toBe("plugin");
  });

  test("collects namespaced skill definitions from resolver output", async () => {
    // The resolver namespaces skill.name as `${pluginId}:${originalName}`. We just
    // collect the (already-namespaced) definitions the resolver produced.
    const plugin = makePlugin("/plugins/acme", {
      capabilities: {
        skills: [{ pluginId: "acme", version: "1.0.0", root: "./skills" }],
        commandTools: [],
      },
    });
    // NOTE: this test does not read skills from disk; the resolver would return []
    // for a non-existent root. We assert the assembly surfaces whatever the resolver
    // produced (empty here) without error.
    const assembly = await assemblePluginRuntime([plugin]);
    expect(Array.isArray(assembly.skills)).toBe(true);
  });

  test("silently omits non-loaded plugins (resolver gate) and surfaces their diagnostics via resolver", async () => {
    const loaded = makePlugin("/plugins/loaded", {
      pluginId: "loaded",
      capabilities: { skills: [], commandTools: [{ name: "ct", command: "echo" }] },
    });
    const needsReview = makePlugin("/plugins/nr", {
      pluginId: "nr",
      permissionState: { state: "needs-review", reason: "hash-mismatch" },
      capabilities: { skills: [], commandTools: [{ name: "nrct", command: "echo" }] },
    });

    const assembly = await assemblePluginRuntime([loaded, needsReview]);

    expect(assembly.commandToolDefinitions.map((d) => d.name)).toEqual(["loaded:ct"]);
    // The resolver silently skips non-loaded plugins (registry already emitted
    // diagnostics), so no bridge-level diagnostic for nr.
    expect(assembly.diagnostics).toEqual([]);
  });

  test("returns empty assembly for an empty plugin list", async () => {
    const assembly = await assemblePluginRuntime([]);
    expect(assembly.commandToolDefinitions).toEqual([]);
    expect(assembly.skills).toEqual([]);
    expect(assembly.diagnostics).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/runtime-bridge.test.ts`
Expected: FAIL — `Cannot find module "./runtime-bridge.js"`.

- [ ] **Step 3: Implement `assemblePluginRuntime`**

Create `apps/sidecar/src/services/agent-runtime/plugins/runtime-bridge.ts`:

```ts
import {
  buildCommandToolDefinition,
  type PluginDiagnostic,
  type SkillDefinition,
  type ToolDefinition,
} from "@lume/agent-sdk";
import { resolvePluginCapabilities } from "./capability-resolver.js";
import type { RegisteredPlugin } from "./plugin-registry.js";

export interface PluginRuntimeAssembly {
  /** Plugin command-tool ToolDefinitions, each name namespaced `${pluginId}:${name}`. */
  commandToolDefinitions: ToolDefinition[];
  /** Namespaced skill definitions (resolver already rewrote skill.name). */
  skills: SkillDefinition[];
  /** Cross-plugin diagnostics from the resolver. */
  diagnostics: PluginDiagnostic[];
}

/**
 * Phase 3b PluginRuntimeBridge (design spec §6.4): turn RegisteredPlugin[] into
 * runtime-ready command-tool ToolDefinitions + skills, via the Phase 3a resolver.
 *
 * Pure function of `plugins` — no registry, no filesystem beyond what the resolver
 * already does. MCP servers and hooks are intentionally NOT wired here (MCP: §16.7
 * lifecycle, separate plan; hooks: Phase 3d).
 *
 * Sensitive-use gating is Phase 3c — the ToolDefinitions built here carry a
 * `${pluginId}:` namespaced name so 3c's canUseTool gate can recover the source.
 */
export async function assemblePluginRuntime(
  plugins: RegisteredPlugin[],
): Promise<PluginRuntimeAssembly> {
  const rootById = new Map(plugins.map((plugin) => [plugin.pluginId, plugin.root]));
  const resolved = await resolvePluginCapabilities(plugins);

  const commandToolDefinitions: ToolDefinition[] = [];
  const skills: SkillDefinition[] = [];

  for (const capability of resolved.capabilities) {
    const pluginRoot = rootById.get(capability.pluginId);
    for (const tool of capability.commandTools) {
      if (!pluginRoot) continue;
      const definition = buildCommandToolDefinition(tool.contribution, pluginRoot);
      // Namespace so Phase 3c can recover the source pluginId from the tool name.
      definition.name = `${capability.pluginId}:${definition.name}`;
      commandToolDefinitions.push(definition);
    }
    for (const skill of capability.skills) {
      skills.push(skill.definition);
    }
  }

  return { commandToolDefinitions, skills, diagnostics: resolved.diagnostics };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/runtime-bridge.test.ts`
Expected: PASS — all four tests pass.

- [ ] **Step 5: Export from the barrel**

In `apps/sidecar/src/services/agent-runtime/plugins/index.ts`, add:

```ts
export { assemblePluginRuntime } from "./runtime-bridge.js";
export type { PluginRuntimeAssembly } from "./runtime-bridge.js";
```

- [ ] **Step 6: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/plugins/runtime-bridge.ts apps/sidecar/src/services/agent-runtime/plugins/runtime-bridge.test.ts apps/sidecar/src/services/agent-runtime/plugins/index.ts
git commit -m "✨ feat(sidecar): 新增 PluginRuntimeBridge assemblePluginRuntime"
```

---

## Chunk 4: Wire the bridge into `createRuntimeCoreSession`

The high-risk integration. Replace the manual skill-loading loop + `plugins:` argument with `listRegistered` → `assemblePluginRuntime` → inject command-tool `ToolDefinition`s as a `buildRuntimeCoreTools` group + register skills.

### Task 4: Inject `pluginCommandTools` into `buildRuntimeCoreTools`

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts`

- [ ] **Step 1: Add the `pluginCommandTools` group parameter**

In `buildRuntimeCoreTools` (`run.ts:594`), add an optional field to the input type (after `mcpDiagnostics?: ToolRuntimeDiagnostic[];`, around line 613):

```ts
  pluginDiagnostics?: ToolRuntimeDiagnostic[];
  mcpTools?: ToolDefinition[];
  mcpDiagnostics?: ToolRuntimeDiagnostic[];
  /** Plugin command-tool ToolDefinitions built by PluginRuntimeBridge (Phase 3b). */
  pluginCommandTools?: ToolDefinition[];
}): RuntimeCoreToolset {
```

Then find the `groups` array construction (around `run.ts:783-789`, where base/lume/mcp tools are pushed into `groups`). Add the plugin command tools as an additional group, BEFORE the MCP group (so plugin tools appear alongside other runtime tools):

```ts
  const groups: Array<{ source: string; tools: ToolDefinition[] }> = [
    // ... existing groups ...
  ];
  if (input.pluginCommandTools && input.pluginCommandTools.length > 0) {
    // `source` must be a valid LumeToolSource (see ./tool-types). Read the existing
    // groups above to see the literal form used for the base/lume/mcp groups, and use
    // a plugin-appropriate value — "plugin" is the conventional choice. If the
    // LumeToolSource union does not include "plugin", add that literal to tool-types.
    groups.push({ source: "plugin", tools: input.pluginCommandTools });
  }
```

(Read the actual `groups` construction at `run.ts:783-789` to match its exact shape — it may use a different literal form. Insert the plugin group conditionally, mirroring how the MCP group is added.)

- [ ] **Step 2: Verify the change typechecks in isolation**

Run: `cd apps/sidecar && bun x tsc --noEmit 2>&1 | grep -E "run\.ts|buildRuntimeCoreTools" | head`
Expected: no new errors in `run.ts` from this change (pre-existing unrelated sidecar typecheck failures are out of scope).

- [ ] **Step 3: Commit (incremental — group plumbing only)**

```bash
git add apps/sidecar/src/services/agent-runtime/runtime-core/run.ts
git commit -m "✨ feat(sidecar): buildRuntimeCoreTools 接受 pluginCommandTools 组"
```

### Task 5: Replace the plugin-wiring section in `createRuntimeCoreSession`

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts`

- [ ] **Step 1: Read the current plugin-wiring section**

Read `run.ts:893-953` (the `ToolRuntime.resolveCommandPluginSpecs` call + the manual skill-loading loop `:899-943` + the MCP runtime `:944-953`) and `run.ts:1036-1080` (the `agentOptions` literal with `plugins: pluginResolution.specs` at `:1048`). Confirm the exact text before editing.

- [ ] **Step 2: Replace the plugin-wiring block**

Replace the block from `const pluginResolution = await ToolRuntime.resolveCommandPluginSpecs(...)` (`:893`) through the end of the manual skill-loading loop (`:943`, just before `log.info("Plugin skill registration complete", ...)` at `:939` — actually through the closing of that loop) with a bridge-driven block. The new block:

```ts
  // Phase 3b: registry → resolver → bridge. Command tools + skills come from the
  // PluginRuntimeBridge now; the SDK's loadPlugins path is no longer used (no
  // agentOptions.plugins). Plugin hooks are inert until Phase 3d.
  const pluginConfig = getEffectiveLumeConfig(input.workspaceSlug).plugins;
  const pluginManager = new SidecarPluginManager();
  const registeredPlugins = await pluginManager.listRegistered({
    enabled: pluginConfig?.enabled ?? [],
    // Mirror tool-runtime.ts:116-127 exactly: cwd-local root + configured extras
    // passed as directories; the global ~/.lume/plugins root is covered by
    // SidecarPluginManager's default pluginRoot. (join is already imported at run.ts:41.)
    directories: [join(input.cwd, ".lume", "plugins"), ...(pluginConfig?.directories ?? [])],
  });
  const pluginAssembly = await assemblePluginRuntime(registeredPlugins);

  // Register plugin skills (resolver already namespaced skill.name as `${pluginId}:${original}`).
  const registeredPluginSkillNames = new Set<string>();
  for (const skill of pluginAssembly.skills) {
    if (hasSkill(skill.name)) {
      log.warn(`[plugin] skill "${skill.name}" already registered, skipping duplicate`);
      continue;
    }
    registerSkill(skill);
    registeredPluginSkillNames.add(skill.name);
  }
  log.info("Plugin skill registration complete", {
    sessionId: input.lumeSessionId,
    totalRegistered: registeredPluginSkillNames.size,
    skills: Array.from(registeredPluginSkillNames),
  });
```

Notes:
- `getEffectiveLumeConfig` is ALREADY imported at `run.ts:57` (`from "../../system/lume-config-service"`) and used at `:190`/`:839`; reuse it directly. `join` is at `run.ts:41`; `registerSkill`/`hasSkill` at `run.ts:15-18`.
- `SidecarPluginManager` is NOT a direct import in `run.ts` today (only used transitively through `ToolRuntime`). You MUST add two imports at the top of `run.ts`: `import { SidecarPluginManager } from "../plugins/plugin-manager.js";` and `import { assemblePluginRuntime } from "../plugins/runtime-bridge.js";`.
- The old `pluginResolution.diagnostics` flowed into `buildRuntimeCoreTools({ pluginDiagnostics: pluginResolution.diagnostics })`. Replace with a map from `PluginDiagnostic` → `ToolRuntimeDiagnostic`. The shapes are: `ToolRuntimeDiagnostic` (`tool-runtime.ts:23-28`) = `{ pluginName?; path?; severity: "info"|"warning"|"error"; reason }`; `PluginDiagnostic.severity` is the same union. So the map is direct:
  ```ts
  pluginDiagnostics: pluginAssembly.diagnostics.map((d) => ({
    pluginName: d.pluginId,
    severity: d.severity,
    reason: d.message,
    ...(d.path ? { path: d.path } : {}),
  })),
  ```

- [ ] **Step 3: Pass `pluginCommandTools` into `buildRuntimeCoreTools`**

In the `buildRuntimeCoreTools({...})` call (`run.ts:954-974`), add `pluginCommandTools: pluginAssembly.commandToolDefinitions,` and replace `pluginDiagnostics: pluginResolution.diagnostics,` with the mapped `pluginAssembly.diagnostics` from Step 2.

- [ ] **Step 4: Remove `plugins:` from `agentOptions`**

In the `agentOptions` literal (`run.ts:1036-1080`), DELETE the line `plugins: pluginResolution.specs,` (`:1048`). The SDK's `createAgent` will no longer run `loadPlugins`. (If `AgentOptions` requires `plugins`, it is optional — confirm by reading `packages/sdk/src/types.ts:1300`.)

- [ ] **Step 5: Verify the full file typechecks + run the regression suite**

Run:
```bash
cd apps/sidecar && bun x tsc --noEmit 2>&1 | grep "run\.ts" | head
rtk bun test apps/sidecar/src/services/agent-runtime/plugins/ apps/sidecar/src/services/agent-runtime/tools/tool-runtime.test.ts apps/sidecar/src/rpc/agent-handlers.list-plugins.test.ts packages/sdk/src/plugins/
```
Expected: no new `run.ts` typecheck errors; all plugin/tool-runtime/list-plugins tests pass. (If `pluginResolution` is now unused and triggers a lint/unused error, remove the now-dead `ToolRuntime.resolveCommandPluginSpecs` import usage ONLY if it becomes fully unused — but `ToolRuntime` is still used elsewhere in `run.ts` via `ToolRuntime.build` / `ToolRuntime.resolveDynamicTools`, so only the specific call site is removed.)

- [ ] **Step 6: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/runtime-core/run.ts
git commit -m "✨ feat(sidecar): createRuntimeCoreSession 接入 PluginRuntimeBridge 并切断 agentOptions.plugins"
```

---

## Chunk 5: Regression + boundary verification

Confirm the runtime still works end-to-end with the bridge-driven path, that legacy command plugins still run, and that the Phase 1+2+3a baseline is green.

### Task 6: Full regression + boundary

**Files:** none (verification only)

- [ ] **Step 1: Run the Phase 1+2+3a+3b plugin suite**

Run:
```bash
rtk bun test packages/sdk/src/plugins/ apps/sidecar/src/services/agent-runtime/plugins/ apps/sidecar/src/services/agent-runtime/tools/tool-runtime.test.ts apps/sidecar/src/rpc/agent-handlers.list-plugins.test.ts
```
Expected: ALL PASS, 0 FAIL. Baseline was 74 (Phase 1+2+3a); 3b adds ~6 (loader.test.ts ×2, plugin-manager listRegistered ×1, runtime-bridge ×4). Any Phase 1/2/3a test failing = regression → STOP and report.

- [ ] **Step 2: Confirm the bridge path is live (static check)**

Run:
```bash
grep -n "assemblePluginRuntime\|pluginAssembly\|plugins: pluginResolution" apps/sidecar/src/services/agent-runtime/runtime-core/run.ts
```
Expected: `assemblePluginRuntime` and `pluginAssembly` appear; `plugins: pluginResolution` does NOT appear (the old SDK-loadPlugins path is cut).

- [ ] **Step 3: Boundary — confirm what 3b did NOT touch**

Run:
```bash
git diff --name-only <3b-base>..HEAD -- apps/sidecar/src/services/agent-runtime/runtime-core/attempt.ts apps/sidecar/src/services/agent-runtime/plugins/permission-interceptor.ts apps/sidecar/src/services/agent-runtime/plugins/permission-runtime.ts apps/sidecar/src/services/mcp/workspace-mcp-manager.ts packages/sdk/src/agent.ts packages/sdk/src/hooks.ts
```
(where `<3b-base>` is the Phase 3a final commit `5ba16cb1`). Expected: EMPTY — 3b did not touch the gate, interceptor, MCP manager, agent, or hooks. (Plugin hooks being inert is the known consequence of cutting `agentOptions.plugins`, called out in Design Decision 1.)

Then confirm 3b's actual change set:
```bash
git diff --name-only 5ba16cb1..HEAD
```
Expected: exactly `loader.ts`, `loader.test.ts`, `sdk/index.ts`, `runtime-bridge.ts`, `runtime-bridge.test.ts`, `plugin-manager.ts`, `plugin-manager.test.ts`, `plugins/index.ts`, `run.ts`.

- [ ] **Step 4: Commit final state (only if something is unstaged)**

If the worktree is clean except the untracked `docs/superpowers/handoffs/`, skip. Otherwise:
```bash
git add -A && git commit -m "✅ test(sidecar): Phase 3b bridge 回归与边界校验"
```

---

## Execution Adjustments (made during implementation)

The plan's original Task 3 namespaced command-tool `definition.name` as `${pluginId}:${name}`. During Task 5 this was **revised** (commit `35e770d5`) — two adjustments, both reviewed and approved by the final reviewer:

1. **Dropped namespace → `runtimeMetadata.pluginId`.** `CanUseToolFn` receives the full `ToolDefinition` (`packages/sdk/src/types.ts:842`), so Phase 3c's gate reads `tool.runtimeMetadata.pluginId` directly. Namespacing was unnecessary AND broke tool-name stability (`demo_echo` → `demo:demo_echo` would break existing callers/models). `assemblePluginRuntime` now sets `definition.runtimeMetadata.pluginId` (the `source: "plugin"` set by `buildCommandToolDefinition` is preserved). Verified: `runtimeMetadata` survives tool wrapping (`apps/sidecar/src/services/agent-runtime/tools/tool-runtime-wrapper.ts:22-38` spreads it through). The runtime-bridge test asserts both `runtimeMetadata.source === "plugin"` and `runtimeMetadata.pluginId === "acme"`.

2. **Legacy plugins default to `permissionState: loaded`.** Task 5 revealed legacy `plugin.json` plugins (no install record) compute `not-loaded` → the resolver's only-loaded gate skips them → they don't load, violating spec §14.3 ("legacy command plugin 仍可运行"). Fixed by fast-pathing `manifestFormat === "legacy"` in `attachPermissionState` (`plugin-registry.ts`) to `{ state: "loaded", reason: "legacy-plugin" }` (skipping `computeRuntimeState`). This is NOT a security regression — legacy plugins loaded unconditionally before 3b too; the fast-path preserves that status quo. Legacy plugins still hit the first-use sensitive gate in Phase 3c (§8.1). Test: `plugin-registry.permission-state.test.ts` "a legacy plugin.json command plugin is loaded by default with no install record (spec §14.3)".

## Notes for Phase 3c (sensitive gate)

Carry these into the Phase 3c plan (from the 3b final review):

1. **Legacy first-use gate.** Legacy plugins bypass install-time permission review (the `loaded` fast-path above) but MUST still hit the first-use sensitive gate — §8.1 treats command tools / shell hooks / local MCP as "unmediated subprocess". 3c's `canUseTool` reads `tool.runtimeMetadata.pluginId` to key `checkSensitiveCapability`.

2. **`/reload-plugins` path (Phase 3d).** SDK `Agent.reloadPlugins()` (`packages/sdk/src/agent.ts:1474`) reruns `loadPlugins` on `cfg.plugins` (now empty after 3b) then `rebuildToolPool()`. The `resolveRuntimeTools` callback → `ToolRuntime.resolveDynamicTools` rebuilds only the `"sdk"` group, so plugin command tools would vanish after `/reload-plugins`. 3d must own the reload path (re-inject via `resolveDynamicTools`, or a fully sidecar-governed reload).

3. **Source-binding mechanism for the gate.** 3c recovers `pluginId` from `tool.runtimeMetadata.pluginId` (NOT a namespaced tool name). `buildCommandToolDefinition` sets `runtimeMetadata.source = "plugin"`; the bridge adds `pluginId`. Both survive `tool-runtime-wrapper`. Non-plugin tools have no `runtimeMetadata.pluginId` → the gate passes them through untouched (§8.2 source binding: builtin tools are unaffected by plugin permissions).

4. **Cleanup opportunities (non-blocking).** `SidecarPluginManager.listRegistered` and `resolveEnabled` duplicate the `PluginRegistry` + `FilePluginStateStore` construction — consider a shared `_scan(config)` helper when 3c rewrites the interceptor path. `ToolRuntime.resolveCommandPluginSpecs` is `@deprecated` dead code (only `tool-runtime.test.ts` calls it) — migrate the test and remove in a Phase 3 cleanup.

5. **`ToolRuntimeDiagnostic.code`** is populated end-to-end (resolver → bridge → run.ts map) but has no consumer yet — wire it into the Phase 4 diagnostics UI.

## Notes for the executing agent

- **Run every command from the worktree root** `/Users/cavinhuang/.config/superpowers/worktrees/Lume/codex-plugin-platform-phase1`. Do not `cd` elsewhere.
- **`run.ts` is large and central.** Task 5 is the highest-risk step. Before editing, READ the exact current text of `run.ts:893-1080` (do not trust this plan's line numbers blindly — they drift). Match surrounding style exactly. If the `groups` literal in `buildRuntimeCoreTools` or the `agentOptions` literal differs from what this plan describes, adapt to the actual shape and note the deviation in your report.
- **`getEffectiveLumeConfig` / `SidecarPluginManager` imports.** Confirm they are importable at the top of `run.ts` (they are used transitively today). If `SidecarPluginManager` is not a direct import in `run.ts`, add `import { SidecarPluginManager } from "../plugins/plugin-manager.js";`.
- **`ToolRuntimeDiagnostic` shape.** `buildRuntimeCoreTools` takes `pluginDiagnostics?: ToolRuntimeDiagnostic[]`. Read its shape at `apps/sidecar/src/services/agent-runtime/tools/tool-runtime.ts` and map `PluginDiagnostic` → `ToolRuntimeDiagnostic` accordingly in Task 5 Step 2/3.
- **Plugin hooks are intentionally inert after 3b.** This is by design (Design Decision 1). Do NOT try to preserve hook registration via `agentOptions.plugins` — that would re-introduce double-loading. Phase 3d restores hooks through a sidecar `HookRegistry`.
- **Do not "improve" adjacent code.** Per `CLAUDE.md` §3, only touch the files this plan names.
- **RTK prefix.** `rtk bun test ...` / `rtk bun x tsc ...`; if unavailable, plain `bun` works.
