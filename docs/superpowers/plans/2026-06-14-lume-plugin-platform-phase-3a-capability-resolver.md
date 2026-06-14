# Lume Plugin Platform Phase 3a — PluginCapabilityResolver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Phase 3a of the plugin platform — a pure, fully unit-testable `PluginCapabilityResolver` that turns `RegisteredPlugin[]` (from the Phase 1 registry, carrying Phase 2 `permissionState`) into resolved runtime capabilities (namespaced skills, permission-filtered hooks, register-gated MCP servers, tagged command tools) plus diagnostics — with **no change to the live agent runtime** (runtime wiring is Plan 3b).

**Architecture:** A single sidecar module `capability-resolver.ts` exposes `resolvePluginCapabilities(plugins)`. It loops each plugin, silently skips any whose `permissionState.state !== "loaded"` (the registry already emitted their diagnostics), and otherwise resolves four capability kinds. Skills come from the SDK's `loadFilesystemSkills` namespaced as `${pluginId}:${skillName}`. Hooks are read from `hooksConfigPath` (Codex `{hooks:{Event:[...]}}` or flat, `type` stripped) then filtered to `permissions.hooks.events` (whitelist; dropped events emit `capability_filtered`). MCP servers are read from `mcpServersConfigPath` via `@lume/shared`'s `parseMcpImportPayload`, skipped wholesale when `permissions.mcpServers.register === false`. Command tools pass through as tagged `CommandToolContribution` (the `ToolDefinition`/exec-handler conversion is deferred to the 3b bridge so this plan stays pure). One small SDK prerequisite: `NormalizedPlugin` must carry `lume.hooksOnly` (currently dropped by the Phase 1 normalizer) so the resolver can honor spec §16.3.

**Tech Stack:** TypeScript, Bun test (`bun:test` + `mkdtemp`/`writeFile` fixtures, matching Phase 1/2 style), existing `@lume/agent-sdk` plugin exports (`NormalizedPlugin`, `CommandToolContribution`, `PluginDiagnostic`, `loadFilesystemSkills`, hook + skill types), existing `@lume/shared` MCP exports (`parseMcpImportPayload`, `McpServerEntry`), existing Sidecar `RegisteredPlugin` from Phase 1.

---

## Scope

Implements only the **`PluginCapabilityResolver`** slice of [the approved design spec](../specs/2026-06-13-lume-plugin-platform-design.md) §14.3 / §6.3 / §13.3:

- Resolve plugin skills → namespaced skill references (§13.3, §6.3).
- Resolve hooks file → permission-filtered `HookConfig` (§6.3, §13.3).
- Resolve MCP config → register-gated server list (§6.3, §13.3).
- Resolve command tools → `pluginId`-tagged contributions (§6.3, §13.3).
- Inject source binding (`pluginId`) on every resolved capability (§6.3).
- Skip capability resolution for plugins whose `permissionState.state !== "loaded"` (§14.2 gating; §6.3).
- Honor `lume.hooksOnly` (skip skills/MCP/tools) per §16.3.
- Invalid contributions produce diagnostics and never crash the whole resolve (§13.3).

**Out of scope (deferred to Plan 3b `PluginRuntimeBridge` and later):**

- Wiring resolved capabilities into `createRuntimeCoreSession` (`run.ts`) — skills→`registerSkill`, hooks→`HookRegistry.registerFromConfig`, MCP→workspace merge, tools→`ToolRuntime.build()`.
- Converting `ResolvedCommandTool` → `ToolDefinition` with the `execFile` handler (needs runtime; stays in 3b).
- Enforcing the Phase 2 sensitive-use gate (`PluginPermissionRuntime.checkSensitiveCapability`) on actual command-tool exec / MCP call / hook fire — resolver only produces data + diagnostics.
- `/reload-plugins` sidecar RPC + live tool-pool hot-swap (Plan 3c).
- Migrating `run.ts`'s manual plugin-skill path and `SidecarPluginManager` direct-scan call sites onto the registry/resolver (Plan 3b).

**Constraints:**

- **No runtime behavior change.** Do not touch `run.ts`, `createRuntimeCoreSession`, `ToolRuntime`, `HookRegistry` instances, `WorkspaceMcpManager`, or the agent tool pool. Phase 3a only adds a pure resolver + its tests + one small SDK field. Re-verify with the boundary check in Task 12.
- Do not broaden the pre-existing sidecar/web typecheck failures (office/cron/IM/routine/permission-interceptor/skill-market) into Phase 3a scope.
- Keep working in the isolated worktree `codex/plugin-platform-phase1`.
- Match Phase 1/2 code style: 2-space indent, double quotes in sidecar / single quotes in SDK, no `any`, `bun:test`, `mkdtemp` fixtures with `finally { rm }`.

## Design Decisions

1. **command tools: pass-through `CommandToolContribution`, not `ToolDefinition` (diverges from spec §6.3 / §16.3 wording).** Spec §6.3 / §16.3 say the resolver "converts command tools into `ToolDefinition`". But `ToolDefinition` carries an `execFile` handler closure (`packages/sdk/src/plugins/loader.ts:104`) — that is runtime behavior, not pure data, and cannot live in a "fully unit-testable, NO runtime change" resolver. So Plan 3a emits `ResolvedCommandTool = { pluginId; contribution: CommandToolContribution }` (already validated by the Phase 1 normalizer, so no re-validation here). The 3b bridge converts these tagged contributions into real `ToolDefinition`s with handlers. This keeps 3a pure and avoids importing `ToolDefinition` exec machinery into the resolver.

2. **`permissions.hooks.events` is a whitelist; undefined means empty.** Spec §6.3 "按 `permissions.hooks.events` 过滤" is implemented as: an event survives only if it appears in `permissions.hooks.events`; every other declared event is dropped with a `capability_filtered` diagnostic. Consequences: Codex plugins are unaffected (`adaptCodexPlugin` always fills `permissions.hooks.events` with `CODEX_EVENT_MAP`'s 10 events — `packages/sdk/src/plugins/codex-adapter.ts:86`); a Lume plugin that declares a hooks file but omits `permissions.hooks.events` gets **all** its hooks filtered (conservative, matches §4.2 "声明式保守平台"; the plugin author must opt events in explicitly). The resolver does **not** additionally filter against SDK `HOOK_EVENTS` — that is `HookRegistry.registerFromConfig`'s job in 3b.

3. **`lume.hooksOnly` requires a new SDK field (prerequisite Chunk 1).** Spec §16.3 maps `lume.hooksOnly` → "capability resolver skips skills/MCP/tools when true". But `NormalizedPlugin` (Phase 1) drops `manifest.lume` entirely (`normalizeLumeManifest` never copies it — `packages/sdk/src/plugins/normalized.ts:124-155`). Chunk 1 adds `lume?: { hooksOnly?: boolean }` to `NormalizedPlugin` and fills it. The field is optional and excluded from `computePermissionsHash` (the hash's `canonicalSummary` does not read `lume` — `packages/sdk/src/plugins/permissions-hash.ts:39`), so Phase 2 hashes are unchanged.

4. **only-loaded gating is silent.** `PluginRegistry.list` already pushes a `permission_review_required` (needs-review) or `capability_filtered` (not-loaded) diagnostic per non-loaded plugin (`plugin-registry.ts:263-272`). The resolver therefore **silently** omits non-loaded plugins from `result.capabilities` instead of emitting a duplicate diagnostic. A plugin with `permissionState.state === "loaded"` (or no `permissionState` at all, e.g. a hand-built fixture) is resolved.

5. **Hooks parsing is re-implemented in the resolver, not re-exported from the SDK.** `resolveHooksConfig` (`packages/sdk/src/plugins/loader.ts:142`) is not exported and does not apply the `permissions.hooks.events` filter. Re-implementing the ~15-line parse (read file → unwrap `raw.hooks` → strip `type` → filter by events) inside the resolver keeps the SDK loader's export surface untouched and lets us fold in the event filter in one place. File read / JSON parse failure emits `invalid_manifest` (warning) and returns an empty `HookConfig` — the plugin keeps loading its other capabilities.

6. **Diagnostic code reuse.** No new `PluginDiagnostic.code` values are added (avoids touching the SDK union in `normalized.ts:16-27`). Event filtering and `mcpServers.register === false` use the existing `capability_filtered` code (info severity). Hooks/MCP config file read or JSON parse failure uses `invalid_manifest` (warning).

7. **`runtimeMetadata.source = "plugin"` is expressed via the `pluginId` field on each resolved item.** `SkillDefinition`, `HookDefinition`, and `McpServerEntry` have no `runtimeMetadata` slot. Plan 3a therefore tags every resolved capability with a `pluginId` field (and skills additionally get the `${pluginId}:` namespaced name). The 3b bridge sets `runtimeMetadata.source = "plugin"` when it builds runtime objects (`ToolDefinition`, registered skills, hook registry entries). This satisfies spec §6.3's intent ("注入 `runtimeMetadata.source = "plugin"` 和 `pluginId`") at the data layer 3a owns.

## File Structure

SDK (one small prerequisite field):

- Modify `packages/sdk/src/plugins/normalized.ts` — add `lume?: { hooksOnly?: boolean }` to `NormalizedPlugin`; fill it in `normalizeLumeManifest`.
- Modify `packages/sdk/src/plugins/normalized.test.ts` — assert the field is carried (and absent when unset).

Sidecar (the resolver; pure + async file reads only):

- Create `apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.ts` — types + `resolvePluginCapabilities` entry + per-plugin `resolveOne` + four resolvers (`resolveSkills`, `resolveHooks`, `resolveMcpServers`, `resolveCommandTools`).
- Create `apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.test.ts` — `bun:test`, `mkdtemp` fixtures, one test group per capability kind + gating + hooksOnly + diagnostics.
- Modify `apps/sidecar/src/services/agent-runtime/plugins/index.ts` — export `resolvePluginCapabilities` and its result types.

No other files are touched.

---

## Chunk 1: SDK prerequisite — `NormalizedPlugin.lume.hooksOnly`

Spec §16.3 requires the resolver to honor `lume.hooksOnly`; Phase 1's normalizer currently drops `manifest.lume`. This chunk adds the field with TDD. It is independent of the resolver and shippable on its own.

### Task 1: Carry `lume.hooksOnly` through normalization

**Files:**
- Modify: `packages/sdk/src/plugins/normalized.test.ts`
- Modify: `packages/sdk/src/plugins/normalized.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/sdk/src/plugins/normalized.test.ts` (inside the existing top-level `describe("normalizePluginManifests", ...)` block, after the last `test`):

```ts
  test("carries lume.hooksOnly=true onto NormalizedPlugin", () => {
    const result = normalizePluginManifests({
      pluginRoot: "/plugins/hook-only",
      lumeManifest: {
        schema: "lume-plugin/v1",
        name: "hook-only",
        version: "1.0.0",
        hooks: "./hooks/hooks.json",
        lume: { hooksOnly: true },
      },
    });

    expect(result.lume).toEqual({ hooksOnly: true });
  });

  test("omits lume when hooksOnly is not set", () => {
    const result = normalizePluginManifests({
      pluginRoot: "/plugins/acme",
      lumeManifest: {
        schema: "lume-plugin/v1",
        name: "acme",
        version: "1.0.0",
      },
    });

    expect(result.lume).toBeUndefined();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `rtk bun test packages/sdk/src/plugins/normalized.test.ts -t "hooksOnly"`
Expected: FAIL — `result.lume` is `undefined` for both cases (`Expected: {"hooksOnly": true}` / `Expected: undefined, Received: undefined` is a pass for the second, so only the first fails; the first failure confirms the field is missing).

- [ ] **Step 3: Add the field and fill it**

In `packages/sdk/src/plugins/normalized.ts`, extend the `NormalizedPlugin` interface (after the `diagnostics: PluginDiagnostic[];` line, around line 67):

```ts
  capabilities: PluginManifestCapabilities;
  permissions: PluginPermissions;
  diagnostics: PluginDiagnostic[];
  /** Carries Lume-specific flags consumed by the capability resolver (spec §16.3). */
  lume?: { hooksOnly?: boolean };
}
```

Then in `normalizeLumeManifest`, add the field to the returned object (after `diagnostics,` in the return literal, around line 153):

```ts
    permissions: manifest.permissions ?? {},
    diagnostics,
    ...(manifest.lume?.hooksOnly ? { lume: { hooksOnly: true } } : {}),
  };
}
```

(The legacy path `normalizeLegacyCommandManifest` returns no `lume` — legacy command-only plugins are never hooks-only — so it is left untouched.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `rtk bun test packages/sdk/src/plugins/normalized.test.ts`
Expected: PASS — all existing tests plus the two new ones.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/plugins/normalized.ts packages/sdk/src/plugins/normalized.test.ts
git commit -m "✨ feat(sdk): NormalizedPlugin 携带 lume.hooksOnly 字段"
```

---

## Chunk 2: Resolver skeleton, types, and only-loaded gating

Create the resolver module with all types, the `resolvePluginCapabilities` entry, per-plugin `resolveOne`, and four **stub** resolvers that return empty results. The only behavior this chunk locks in is the silent only-loaded gate. Later chunks fill the stubs.

### Task 2: Resolver skeleton with only-loaded gating

**Files:**
- Create: `apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.ts`
- Create: `apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePluginCapabilities } from "./capability-resolver.js";
import type { RegisteredPlugin } from "./plugin-registry.js";

/** Build a RegisteredPlugin fixture rooted at `root` with optional overrides. */
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

describe("resolvePluginCapabilities — gating", () => {
  test("silently skips needs-review and not-loaded plugins", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-resolver-"));
    try {
      const loaded = makePlugin(join(root, "loaded"), { pluginId: "loaded" });
      const needsReview = makePlugin(join(root, "needs-review"), {
        pluginId: "needs-review",
        permissionState: { state: "needs-review", reason: "hash-mismatch" },
      });
      const notLoaded = makePlugin(join(root, "not-loaded"), {
        pluginId: "not-loaded",
        permissionState: { state: "not-loaded", reason: "no-review-state" },
      });

      const result = await resolvePluginCapabilities([loaded, needsReview, notLoaded]);

      expect(result.capabilities.map((c) => c.pluginId)).toEqual(["loaded"]);
      // Gating is silent: no diagnostics duplicated from the registry.
      expect(result.diagnostics).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("resolves a loaded plugin with no declared capabilities to an empty capability set", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-resolver-"));
    try {
      const result = await resolvePluginCapabilities([makePlugin(join(root, "acme"))]);

      expect(result.capabilities).toHaveLength(1);
      expect(result.capabilities[0]).toEqual({
        pluginId: "acme",
        skills: [],
        hooks: {},
        mcpServers: [],
        commandTools: [],
        diagnostics: [],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.test.ts`
Expected: FAIL — `Cannot find module "./capability-resolver.js"`.

- [ ] **Step 3: Write the skeleton implementation**

Create `apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.ts`:

```ts
import { resolve } from "node:path";
import type {
  CommandToolContribution,
  HookConfig,
  PluginDiagnostic,
  SkillDefinition,
} from "@lume/agent-sdk";
import type { McpServerEntry } from "@lume/shared";
import type { RegisteredPlugin } from "./plugin-registry.js";

export interface ResolvedSkill {
  pluginId: string;
  /** Namespaced name: `${pluginId}:${originalName}`. */
  name: string;
  originalName: string;
  sourcePath: string;
  definition: SkillDefinition;
}

export interface ResolvedMcpServer {
  pluginId: string;
  serverId: string;
  entry: McpServerEntry;
}

export interface ResolvedCommandTool {
  pluginId: string;
  contribution: CommandToolContribution;
}

export interface ResolvedPluginCapability {
  pluginId: string;
  skills: ResolvedSkill[];
  hooks: HookConfig;
  mcpServers: ResolvedMcpServer[];
  commandTools: ResolvedCommandTool[];
  diagnostics: PluginDiagnostic[];
}

export interface ResolvedPluginCapabilitiesResult {
  capabilities: ResolvedPluginCapability[];
  diagnostics: PluginDiagnostic[];
}

/**
 * Resolve runtime capabilities for a set of registered plugins (design spec §6.3).
 *
 * Plugins whose `permissionState.state` is not "loaded" are silently omitted —
 * `PluginRegistry.list` already emitted their `permission_review_required` /
 * `capability_filtered` diagnostics. Loaded plugins are resolved skill-by-skill,
 * hook-by-hook, etc.; per-capability failures become diagnostics, never crashes.
 */
export async function resolvePluginCapabilities(
  plugins: RegisteredPlugin[],
): Promise<ResolvedPluginCapabilitiesResult> {
  const capabilities: ResolvedPluginCapability[] = [];
  const diagnostics: PluginDiagnostic[] = [];

  for (const plugin of plugins) {
    if (plugin.permissionState?.state !== "loaded") {
      continue;
    }
    const resolved = await resolveOne(plugin);
    capabilities.push(resolved);
    diagnostics.push(...resolved.diagnostics);
  }

  return { capabilities, diagnostics };
}

async function resolveOne(plugin: RegisteredPlugin): Promise<ResolvedPluginCapability> {
  const diagnostics: PluginDiagnostic[] = [];
  const skills = await resolveSkills(plugin, diagnostics);
  const hooks = await resolveHooks(plugin, diagnostics);
  const mcpServers = await resolveMcpServers(plugin, diagnostics);
  const commandTools = resolveCommandTools(plugin);
  return { pluginId: plugin.pluginId, skills, hooks, mcpServers, commandTools, diagnostics };
}

// Stubs — filled in by Chunks 3–6.
async function resolveSkills(
  _plugin: RegisteredPlugin,
  _diagnostics: PluginDiagnostic[],
): Promise<ResolvedSkill[]> {
  return [];
}

async function resolveHooks(
  _plugin: RegisteredPlugin,
  _diagnostics: PluginDiagnostic[],
): Promise<HookConfig> {
  return {};
}

async function resolveMcpServers(
  _plugin: RegisteredPlugin,
  _diagnostics: PluginDiagnostic[],
): Promise<ResolvedMcpServer[]> {
  return [];
}

function resolveCommandTools(_plugin: RegisteredPlugin): ResolvedCommandTool[] {
  return [];
}
```

(`McpServerEntry` comes from `@lume/shared`, not `@lume/agent-sdk` — verified at `packages/shared/src/types/mcp.ts:5`, re-exported through `@lume/shared` → `./types` → `./mcp`. `parseMcpImportPayload` joins it in Chunk 5.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.test.ts`
Expected: PASS — both gating tests pass (skipped plugins omitted; empty capability set for a bare loaded plugin).

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.ts apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.test.ts
git commit -m "✨ feat(sidecar): 新增 PluginCapabilityResolver 骨架与 only-loaded 门"
```

---

## Chunk 3: Resolve plugin skills

Fill `resolveSkills`: for each `capabilities.skills[].root` (a relative path like `./skills`), resolve it under `plugin.root`, run `loadFilesystemSkills`, and namespace each result as `${pluginId}:${skillName}`. The `SkillDefinition` carried on `ResolvedSkill.definition` has its `name` rewritten to the namespaced form; `originalName` preserves the on-disk name (the directory name, per `fs-loader.ts:141`).

### Task 3: Implement `resolveSkills`

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `capability-resolver.test.ts` (new top-level import first — add `mkdir`, `writeFile` to the `node:fs/promises` import, and `dirname` to `node:path`):

```ts
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
```

Then append this `describe` block:

```ts
async function writeSkill(pluginRoot: string, relativeRoot: string, skillName: string) {
  const skillFile = join(pluginRoot, relativeRoot, skillName, "SKILL.md");
  await mkdir(dirname(skillFile), { recursive: true });
  await writeFile(
    skillFile,
    "---\nname: frontmatter-name\ndescription: Greet the user\n---\nGreet body\n",
    "utf-8",
  );
}

describe("resolvePluginCapabilities — skills", () => {
  test("namespaces plugin skills as ${pluginId}:${skillName} and binds pluginId", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-resolver-"));
    try {
      const pluginRoot = join(root, "acme");
      await writeSkill(pluginRoot, "./skills", "greet");
      const plugin = makePlugin(pluginRoot, {
        capabilities: {
          skills: [{ pluginId: "acme", version: "1.0.0", root: "./skills" }],
          commandTools: [],
        },
      });

      const result = await resolvePluginCapabilities([plugin]);

      expect(result.capabilities[0]?.skills).toEqual([
        {
          pluginId: "acme",
          name: "acme:greet",
          originalName: "greet",
          sourcePath: join(pluginRoot, "skills", "greet", "SKILL.md"),
          definition: expect.objectContaining({
            name: "acme:greet",
            description: "Greet the user",
          }),
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.test.ts -t "skills"`
Expected: FAIL — `result.capabilities[0].skills` is `[]` (stub returns empty).

- [ ] **Step 3: Implement `resolveSkills`**

Add `loadFilesystemSkills` to the `@lume/agent-sdk` import in `capability-resolver.ts`:

```ts
import {
  loadFilesystemSkills,
  type CommandToolContribution,
  type HookConfig,
  type PluginDiagnostic,
  type SkillDefinition,
} from "@lume/agent-sdk";
```

Replace the `resolveSkills` stub with:

```ts
async function resolveSkills(
  plugin: RegisteredPlugin,
  diagnostics: PluginDiagnostic[],
): Promise<ResolvedSkill[]> {
  const resolved: ResolvedSkill[] = [];
  for (const contribution of plugin.capabilities.skills) {
    const skillsRoot = resolve(plugin.root, contribution.root);
    let skills: SkillDefinition[];
    try {
      skills = await loadFilesystemSkills({ roots: [skillsRoot], cwd: skillsRoot });
    } catch (error) {
      diagnostics.push({
        pluginId: plugin.pluginId,
        version: plugin.version,
        severity: "warning",
        code: "invalid_manifest",
        message: `Failed to read skills from ${contribution.root}: ${error instanceof Error ? error.message : String(error)}`,
        path: contribution.root,
      });
      continue;
    }
    for (const skill of skills) {
      const namespaced = `${plugin.pluginId}:${skill.name}`;
      resolved.push({
        pluginId: plugin.pluginId,
        name: namespaced,
        originalName: skill.name,
        sourcePath: skill.sourcePath ?? skillsRoot,
        definition: { ...skill, name: namespaced },
      });
    }
  }
  return resolved;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.test.ts`
Expected: PASS — the skills test resolves `acme:greet` with the namespaced name and bound `pluginId`; earlier gating tests still pass.

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.ts apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.test.ts
git commit -m "✨ feat(sidecar): resolver 解析插件 skills 并命名空间化"
```

---

## Chunk 4: Resolve hooks with `permissions.hooks.events` filtering

Fill `resolveHooks`: read `hooksConfigPath` (relative → resolved under `plugin.root`), unwrap Codex `{ hooks: { Event: [...] } }` or accept a flat object, strip the Codex `type` field from each definition, then keep only events present in `permissions.hooks.events` (emitting `capability_filtered` for the rest). File read / JSON parse failure emits `invalid_manifest` and yields an empty `HookConfig`.

### Task 4: Implement `resolveHooks`

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.test.ts`

- [ ] **Step 1: Write the failing tests**

Add `writeJson` helper and a `describe("resolvePluginCapabilities — hooks", ...)` block to the test file (after the skills block):

```ts
async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value), "utf-8");
}

describe("resolvePluginCapabilities — hooks", () => {
  test("keeps events listed in permissions.hooks.events and strips Codex type", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-resolver-"));
    try {
      const pluginRoot = join(root, "acme");
      await writeJson(join(pluginRoot, "hooks", "hooks.json"), {
        hooks: {
          PreToolUse: [{ type: "command", command: "echo pre", matcher: "Bash" }],
          PostToolUse: [{ type: "command", command: "echo post" }],
        },
      });
      const plugin = makePlugin(pluginRoot, {
        capabilities: {
          skills: [],
          hooksConfigPath: "./hooks/hooks.json",
          commandTools: [],
        },
        permissions: { hooks: { events: ["PreToolUse"] } },
      });

      const result = await resolvePluginCapabilities([plugin]);

      expect(result.capabilities[0]?.hooks).toEqual({
        PreToolUse: [{ command: "echo pre", matcher: "Bash" }],
      });
      expect(result.diagnostics.map((d) => d.code)).toContain("capability_filtered");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("filters all hooks when permissions.hooks.events is unset", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-resolver-"));
    try {
      const pluginRoot = join(root, "no-events");
      await writeJson(join(pluginRoot, "hooks.json"), {
        Stop: [{ command: "echo stop" }],
      });
      const plugin = makePlugin(pluginRoot, {
        capabilities: {
          skills: [],
          hooksConfigPath: "./hooks.json",
          commandTools: [],
        },
        permissions: {}, // no hooks.events declared
      });

      const result = await resolvePluginCapabilities([plugin]);

      expect(result.capabilities[0]?.hooks).toEqual({});
      expect(result.diagnostics.filter((d) => d.code === "capability_filtered")).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("emits invalid_manifest when the hooks file cannot be parsed", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-resolver-"));
    try {
      const pluginRoot = join(root, "broken");
      await mkdir(join(pluginRoot, "hooks"), { recursive: true });
      await writeFile(join(pluginRoot, "hooks", "hooks.json"), "{ not json", "utf-8");
      const plugin = makePlugin(pluginRoot, {
        capabilities: {
          skills: [],
          hooksConfigPath: "./hooks/hooks.json",
          commandTools: [],
        },
        permissions: { hooks: { events: ["Stop"] } },
      });

      const result = await resolvePluginCapabilities([plugin]);

      expect(result.capabilities[0]?.hooks).toEqual({});
      expect(result.diagnostics.map((d) => d.code)).toContain("invalid_manifest");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.test.ts -t "hooks"`
Expected: FAIL — `result.capabilities[0].hooks` is `{}` for the first test (stub returns empty), so the `PreToolUse` assertion fails.

- [ ] **Step 3: Implement `resolveHooks`**

At the top of `capability-resolver.ts`, add a single new line importing `readFile` from `node:fs/promises` above the existing `import { resolve } from "node:path";` line (do not duplicate the `resolve` import — it is already present):

```ts
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
```

Add `HookDefinition` to the `@lume/agent-sdk` import:

```ts
import {
  loadFilesystemSkills,
  type CommandToolContribution,
  type HookConfig,
  type HookDefinition,
  type PluginDiagnostic,
  type SkillDefinition,
} from "@lume/agent-sdk";
```

Replace the `resolveHooks` stub with:

```ts
async function resolveHooks(
  plugin: RegisteredPlugin,
  diagnostics: PluginDiagnostic[],
): Promise<HookConfig> {
  if (!plugin.capabilities.hooksConfigPath) return {};

  const hooksFile = resolve(plugin.root, plugin.capabilities.hooksConfigPath);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await readFile(hooksFile, "utf-8")) as Record<string, unknown>;
  } catch (error) {
    diagnostics.push({
      pluginId: plugin.pluginId,
      version: plugin.version,
      severity: "warning",
      code: "invalid_manifest",
      message: `Failed to read hooks config ${plugin.capabilities.hooksConfigPath}: ${error instanceof Error ? error.message : String(error)}`,
      path: plugin.capabilities.hooksConfigPath,
    });
    return {};
  }

  // Codex wraps as { hooks: { Event: [...] } }; a flat object is also accepted.
  const configRoot =
    raw.hooks && typeof raw.hooks === "object" && !Array.isArray(raw.hooks)
      ? (raw.hooks as Record<string, unknown>)
      : raw;

  const allowed = new Set(plugin.permissions.hooks?.events ?? []);
  const result: HookConfig = {};
  for (const [event, definitions] of Object.entries(configRoot)) {
    if (!Array.isArray(definitions)) continue;
    if (!allowed.has(event)) {
      diagnostics.push({
        pluginId: plugin.pluginId,
        version: plugin.version,
        severity: "info",
        code: "capability_filtered",
        message: `Hook event ${event} is not declared in permissions.hooks.events; filtered.`,
        path: plugin.capabilities.hooksConfigPath,
      });
      continue;
    }
    result[event] = definitions.map((def) => {
      if (!def || typeof def !== "object" || Array.isArray(def)) {
        return def as HookDefinition;
      }
      const { type: _type, ...rest } = def as Record<string, unknown>;
      return rest as HookDefinition;
    });
  }
  return result;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.test.ts`
Expected: PASS — all three hooks tests pass; earlier gating/skills tests still pass.

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.ts apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.test.ts
git commit -m "✨ feat(sidecar): resolver 解析 hooks 并按权限事件过滤"
```

---

## Chunk 5: Resolve MCP servers with `mcpServers.register` gate

Fill `resolveMcpServers`: if `permissions.mcpServers.register === false`, skip entirely with a `capability_filtered` diagnostic; otherwise read `mcpServersConfigPath`, parse via `@lume/shared`'s `parseMcpImportPayload`, and emit one `ResolvedMcpServer` per parsed server tagged with `pluginId`. File read / parse failure emits `invalid_manifest` and yields an empty list.

### Task 5: Implement `resolveMcpServers`

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.test.ts`

- [ ] **Step 1: Write the failing tests**

Append a `describe("resolvePluginCapabilities — mcp", ...)` block:

```ts
describe("resolvePluginCapabilities — mcp", () => {
  test("parses MCP servers and binds pluginId", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-resolver-"));
    try {
      const pluginRoot = join(root, "acme");
      await writeJson(join(pluginRoot, "mcp.json"), {
        mcpServers: {
          "acme-api": { command: "node", args: ["server.js"], env: { KEY: "v" } },
        },
      });
      const plugin = makePlugin(pluginRoot, {
        capabilities: {
          skills: [],
          mcpServersConfigPath: "./mcp.json",
          commandTools: [],
        },
        permissions: { mcpServers: { register: true } },
      });

      const result = await resolvePluginCapabilities([plugin]);

      expect(result.capabilities[0]?.mcpServers).toEqual([
        {
          pluginId: "acme",
          serverId: "acme-api",
          entry: expect.objectContaining({
            enabled: true,
            transport: "stdio",
            command: "node",
            args: ["server.js"],
          }),
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("skips MCP entirely when permissions.mcpServers.register is false", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-resolver-"));
    try {
      const pluginRoot = join(root, "no-register");
      await writeJson(join(pluginRoot, "mcp.json"), {
        mcpServers: { "acme-api": { command: "node" } },
      });
      const plugin = makePlugin(pluginRoot, {
        capabilities: {
          skills: [],
          mcpServersConfigPath: "./mcp.json",
          commandTools: [],
        },
        permissions: { mcpServers: { register: false } },
      });

      const result = await resolvePluginCapabilities([plugin]);

      expect(result.capabilities[0]?.mcpServers).toEqual([]);
      expect(result.diagnostics.map((d) => d.code)).toContain("capability_filtered");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("emits invalid_manifest when the MCP config cannot be parsed", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-resolver-"));
    try {
      const pluginRoot = join(root, "broken");
      await mkdir(pluginRoot, { recursive: true });
      await writeFile(join(pluginRoot, "mcp.json"), "{ broken", "utf-8");
      const plugin = makePlugin(pluginRoot, {
        capabilities: {
          skills: [],
          mcpServersConfigPath: "./mcp.json",
          commandTools: [],
        },
        permissions: { mcpServers: { register: true } },
      });

      const result = await resolvePluginCapabilities([plugin]);

      expect(result.capabilities[0]?.mcpServers).toEqual([]);
      expect(result.diagnostics.map((d) => d.code)).toContain("invalid_manifest");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.test.ts -t "mcp"`
Expected: FAIL — `result.capabilities[0].mcpServers` is `[]` (stub) for the first test; the `acme-api` server assertion fails.

- [ ] **Step 3: Implement `resolveMcpServers`**

Add `parseMcpImportPayload` to the `@lume/shared` import (which already brings `McpServerEntry`):

```ts
import { parseMcpImportPayload, type McpServerEntry } from "@lume/shared";
```

Replace the `resolveMcpServers` stub with:

```ts
async function resolveMcpServers(
  plugin: RegisteredPlugin,
  diagnostics: PluginDiagnostic[],
): Promise<ResolvedMcpServer[]> {
  if (!plugin.capabilities.mcpServersConfigPath) return [];

  if (plugin.permissions.mcpServers?.register === false) {
    diagnostics.push({
      pluginId: plugin.pluginId,
      version: plugin.version,
      severity: "info",
      code: "capability_filtered",
      message: "MCP servers skipped because permissions.mcpServers.register is false.",
      path: plugin.capabilities.mcpServersConfigPath,
    });
    return [];
  }

  const mcpFile = resolve(plugin.root, plugin.capabilities.mcpServersConfigPath);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(mcpFile, "utf-8"));
  } catch (error) {
    diagnostics.push({
      pluginId: plugin.pluginId,
      version: plugin.version,
      severity: "warning",
      code: "invalid_manifest",
      message: `Failed to read MCP config ${plugin.capabilities.mcpServersConfigPath}: ${error instanceof Error ? error.message : String(error)}`,
      path: plugin.capabilities.mcpServersConfigPath,
    });
    return [];
  }

  const config = parseMcpImportPayload(raw);
  return Object.entries(config.servers).map(([serverId, entry]) => ({
    pluginId: plugin.pluginId,
    serverId,
    entry,
  }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.test.ts`
Expected: PASS — all three MCP tests pass; all earlier tests still pass.

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.ts apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.test.ts
git commit -m "✨ feat(sidecar): resolver 解析 MCP 并按 register 权限门控"
```

---

## Chunk 6: Resolve command tools, honor `hooksOnly`, export, and verify boundary

Fill `resolveCommandTools` (tag-and-passthrough), teach `resolveOne` to honor `lume.hooksOnly` (skip skills/MCP/tools), export the resolver from `plugins/index.ts`, then run the full Phase 1+2+3a regression and confirm no runtime file changed.

### Task 6: Implement `resolveCommandTools`

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.test.ts`

- [ ] **Step 1: Write the failing test**

Append a `describe("resolvePluginCapabilities — commandTools", ...)` block:

```ts
describe("resolvePluginCapabilities — commandTools", () => {
  test("passes validated command tools through tagged with pluginId", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-resolver-"));
    try {
      const plugin = makePlugin(join(root, "acme"), {
        capabilities: {
          skills: [],
          commandTools: [
            {
              name: "acme_echo",
              command: "node",
              args: ["./tools/echo.mjs"],
              cwd: "./",
              timeoutMs: 5000,
            },
          ],
        },
      });

      const result = await resolvePluginCapabilities([plugin]);

      expect(result.capabilities[0]?.commandTools).toEqual([
        {
          pluginId: "acme",
          contribution: {
            name: "acme_echo",
            command: "node",
            args: ["./tools/echo.mjs"],
            cwd: "./",
            timeoutMs: 5000,
          },
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.test.ts -t "commandTools"`
Expected: FAIL — `result.capabilities[0].commandTools` is `[]` (stub).

- [ ] **Step 3: Implement `resolveCommandTools`**

Replace the `resolveCommandTools` stub with:

```ts
function resolveCommandTools(plugin: RegisteredPlugin): ResolvedCommandTool[] {
  // Command tools were already validated by the Phase 1 normalizer, so the
  // resolver only tags them with their source pluginId. The bridge (Plan 3b)
  // converts each into a ToolDefinition with an execFile handler.
  return plugin.capabilities.commandTools.map((contribution) => ({
    pluginId: plugin.pluginId,
    contribution,
  }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.test.ts`
Expected: PASS — the commandTools test passes; all earlier tests still pass.

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.ts apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.test.ts
git commit -m "✨ feat(sidecar): resolver 透传 command tools 并绑定 pluginId"
```

### Task 7: Honor `lume.hooksOnly`

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.test.ts`

- [ ] **Step 1: Write the failing test**

Append a `describe("resolvePluginCapabilities — hooksOnly", ...)` block. It declares skills + MCP + a command tool **plus** a hooks file, sets `lume.hooksOnly: true`, and asserts only hooks survive:

```ts
describe("resolvePluginCapabilities — hooksOnly", () => {
  test("skips skills, MCP, and command tools when lume.hooksOnly is true", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-resolver-"));
    try {
      const pluginRoot = join(root, "hook-only");
      await writeSkill(pluginRoot, "./skills", "greet");
      await writeJson(join(pluginRoot, "hooks.json"), {
        Stop: [{ command: "echo stop" }],
      });
      await writeJson(join(pluginRoot, "mcp.json"), {
        mcpServers: { "acme-api": { command: "node" } },
      });
      const plugin = makePlugin(pluginRoot, {
        capabilities: {
          skills: [{ pluginId: "hook-only", version: "1.0.0", root: "./skills" }],
          hooksConfigPath: "./hooks.json",
          mcpServersConfigPath: "./mcp.json",
          commandTools: [{ name: "ct", command: "echo" }],
        },
        permissions: { hooks: { events: ["Stop"] }, mcpServers: { register: true } },
        lume: { hooksOnly: true },
      });

      const result = await resolvePluginCapabilities([plugin]);
      const cap = result.capabilities[0];

      expect(cap?.skills).toEqual([]);
      expect(cap?.mcpServers).toEqual([]);
      expect(cap?.commandTools).toEqual([]);
      expect(cap?.hooks).toEqual({ Stop: [{ command: "echo stop" }] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.test.ts -t "hooksOnly"`
Expected: FAIL — `cap.skills`, `cap.mcpServers`, `cap.commandTools` are non-empty because `resolveOne` currently resolves everything regardless of `lume.hooksOnly`.

- [ ] **Step 3: Apply `hooksOnly` in `resolveOne`**

Replace the `resolveOne` function body in `capability-resolver.ts`:

```ts
async function resolveOne(plugin: RegisteredPlugin): Promise<ResolvedPluginCapability> {
  const diagnostics: PluginDiagnostic[] = [];
  const hooksOnly = plugin.lume?.hooksOnly === true;
  // hooksOnly (spec §16.3): the plugin contributes only hooks.
  const skills = hooksOnly ? [] : await resolveSkills(plugin, diagnostics);
  const mcpServers = hooksOnly ? [] : await resolveMcpServers(plugin, diagnostics);
  const commandTools = hooksOnly ? [] : resolveCommandTools(plugin);
  const hooks = await resolveHooks(plugin, diagnostics);
  return { pluginId: plugin.pluginId, skills, hooks, mcpServers, commandTools, diagnostics };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.test.ts`
Expected: PASS — the hooksOnly test passes (only hooks survive); all earlier tests still pass.

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.ts apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.test.ts
git commit -m "✨ feat(sidecar): resolver 支持 lume.hooksOnly 仅加载 hooks"
```

### Task 8: Export the resolver from the plugins barrel

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/index.ts`

- [ ] **Step 1: Add the exports**

In `apps/sidecar/src/services/agent-runtime/plugins/index.ts`, after the existing `export { PluginPermissionRuntime } ...` line, add:

```ts
export { resolvePluginCapabilities } from "./capability-resolver.js";
export type {
  ResolvedPluginCapability,
  ResolvedPluginCapabilitiesResult,
  ResolvedSkill,
  ResolvedMcpServer,
  ResolvedCommandTool,
} from "./capability-resolver.js";
```

- [ ] **Step 2: Verify the barrel still typechecks against the resolver module**

Run: `rtk bun tsc --noEmit -p apps/sidecar/tsconfig.json 2>&1 | grep -i "capability-resolver" || echo "no capability-resolver errors"`
Expected: `no capability-resolver errors` (pre-existing unrelated sidecar typecheck failures may print for other files — that is out of scope).

- [ ] **Step 3: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/plugins/index.ts
git commit -m "✨ feat(sidecar): 从 plugins barrel 导出 PluginCapabilityResolver"
```

### Task 9: Full regression + runtime-unchanged boundary check

**Files:** none (verification only)

- [ ] **Step 1: Run the Phase 1+2+3a plugin test suite**

Run (the handoff baseline command, plus the new resolver test):

```bash
rtk bun test packages/sdk/src/plugins/normalized.test.ts packages/sdk/src/plugins/manifest.test.ts packages/sdk/src/plugins/codex-adapter.test.ts packages/sdk/src/plugins/permissions-hash.test.ts packages/sdk/src/plugins/permission-gate.test.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-state-store.test.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.test.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.permission-state.test.ts apps/sidecar/src/services/agent-runtime/plugins/permission-runtime.test.ts apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.test.ts apps/sidecar/src/services/agent-runtime/tools/tool-runtime.test.ts apps/sidecar/src/rpc/agent-handlers.list-plugins.test.ts
```

Expected: all PASS. Baseline was 61 passing before 3a; after 3a the normalized suite gains 2 tests and the new capability-resolver suite gains ~10, with 0 failures. If any Phase 1/2 test now fails, that is a regression — fix before continuing.

- [ ] **Step 2: Confirm no runtime file changed (Phase 3a boundary)**

Run:

```bash
git diff --name-only main...HEAD -- apps/sidecar/src/services/agent-runtime/runtime-core/run.ts apps/sidecar/src/services/agent-runtime/tools/ apps/sidecar/src/services/mcp/workspace-mcp-manager.ts packages/sdk/src/agent.ts packages/sdk/src/hooks.ts
```

Expected: empty (no diff on those runtime paths attributable to this plan). Note: `main...HEAD` includes earlier Phase 1/2 commits which may have touched some of these files; if output is non-empty, verify each listed file's diff is from Phase 1/2, not from Phase 3a, by checking `git log --oneline <file>` — Phase 3a commits must not appear on runtime-core/tools/mcp/agent/hooks paths.

Then confirm the 3a-specific change set is exactly the resolver + its test + the barrel + the SDK field:

```bash
git diff --name-only main...HEAD -- apps/sidecar/src/services/agent-runtime/plugins/ packages/sdk/src/plugins/normalized.ts packages/sdk/src/plugins/normalized.test.ts
```

Expected: lists exactly `capability-resolver.ts`, `capability-resolver.test.ts`, `index.ts`, `normalized.ts`, `normalized.test.ts` (plus Phase 1/2 plugin files already on the branch).

- [ ] **Step 3: Commit final state (if any unstaged docs/notes remain)**

No code changes in this task. If the worktree is clean after Step 2, skip the commit. Otherwise:

```bash
git add -A
git commit -m "✅ test(sidecar): Phase 3a resolver 回归与边界校验"
```

---

## Notes for the executing agent

- **Run every command from the worktree root** `/Users/cavinhuang/.config/superpowers/worktrees/Lume/codex-plugin-platform-phase1`. Do not `cd` into the original repo.
- **RTK prefix.** The project's hook rewrites shell commands through `rtk`; the `rtk bun test ...` / `rtk bun tsc ...` forms above match Phase 1/2 usage. If `rtk` is unavailable in the worktree shell, fall back to plain `bun test` / `bun tsc`.
- **Import path style.** Sidecar modules use the `.js` extension in relative imports (`./capability-resolver.js`) even though the source is `.ts` — this matches every existing file in `apps/sidecar/src/services/agent-runtime/plugins/`. SDK/shared imports use the package names `@lume/agent-sdk` and `@lume/shared`.
- **`McpServerEntry` import source.** It comes from `@lume/shared`, **not** `@lume/agent-sdk` (verified: `packages/shared/src/types/mcp.ts:5`, re-exported through `@lume/shared` → `./types` → `./mcp`). Chunk 2's skeleton already imports it from `@lume/shared`.
- **Why the resolver never imports `ToolDefinition`.** Per Design Decision 1, command tools stay as tagged `CommandToolContribution` here. If a reviewer expects a `ToolDefinition`, point them at Plan 3b.
- **Do not "improve" adjacent code.** Per project `CLAUDE.md` §3, only touch the files this plan names. If you spot dead code or style nits elsewhere, mention them in the PR description rather than editing.
