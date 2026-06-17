# Lume Plugin Platform Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear the accumulated Minor items from Phases 3a–MCP-B — 5 independent cleanup points (dead code, stale docstrings, type-literal extraction, pluginId-index construction dedup, state-path constant). All are pure refactors / docs / dead-code removal: **zero behavior change**, verified by existing tests + typecheck.

**Architecture:** 5 cleanup points, each its own task + commit, ordered lowest-risk-first. Points 1/2/4/5 touch no protected files; point 3 (state-path) touches `attempt.ts` + `plugin-manager.ts` (previously "off-limits" per-phase) but is a mechanical literal→constant substitution with byte-identical runtime value, so the per-phase restriction is intentionally relaxed here with isolated commit + full regression. Each task's "test" is "existing tests still pass + typecheck clean" — there is no new behavior to TDD.

**Tech Stack:** TypeScript, Bun test, existing plugin-platform tests as the regression net.

---

## Scope

Cleans the Minor items flagged by the MCP-A/MCP-B final reviews + the Phase 3b `@deprecated` follow-up:

1. **Dead code** — `ToolRuntime.resolveCommandPluginSpecs` + `ResolveCommandPluginSpecsResult` (retained only for its own test since Phase 3b; 0 production callers).
2. **Stale docstrings** — `assemblePluginRuntime` ("MCP/hooks NOT wired here" — now false, MCP-A/B + 3d wired them); `sensitive-gate` ("hooks deferred" — Phase 3d landed).
3. **Type-literal extraction** — `{ decision: "allow" | "block"; reason?: string }` repeated 4× → named `McpGateDecision`.
4. **pluginId-index construction dedup** — `pluginMcpServerIndex` (run.ts) + `pluginIdByServerId` (plugin-mcp-bridge.ts) both build `${pluginId}:${serverId}` → pluginId; extract a shared `buildPluginIdIndex`.
5. **State-path constant** — `join(homedir(), ".lume", "plugins-state.json")` repeated 4× → `DEFAULT_PLUGIN_STATE_PATH`.

**Out of scope:**

- Anything that changes runtime behavior (this is a pure-cleanup slice).
- 3d-reload (`/reload-plugins` RPC) — separate plan (后续 2).
- Phase 4 (permission UI + PluginAuditLog) — separate plan (后续 3).

**Constraints:**

- **Behavior unchanged.** Every task's verification is "existing tests pass + typecheck clean." If any test regresses, STOP.
- **State-path task (Task 5) relaxes the per-phase "do not touch attempt.ts/plugin-manager.ts" rule** — but ONLY for the mechanical literal→constant substitution. No other changes to those files.
- **Touch surface (per task):** see each task's Files list. Do NOT cascade edits beyond the named cleanup.
- Match existing style: 2-space indent, double quotes in sidecar, no `any`, `bun:test`, `rtk` prefix.

## Design Decisions

1. **Cleanup, not features.** Every change is provably behavior-preserving (literal→constant, inline-type→named-type, dead-code removal, comment text). The regression net is the existing 280+ plugin-platform tests.
2. **`McpGateDecision` defined in `workspace-mcp-manager.ts`.** It is the dependency root (both `plugin-mcp-bridge.ts` and the mcp layer depend downward into it; `sensitive-gate.ts`'s `SensitiveGateResult` is structurally identical). Defining it at the root avoids a circular `mcp → plugins` import. `SensitiveGateResult` becomes a type alias to preserve its existing export name.
3. **`buildPluginIdIndex` exported from `plugin-mcp-bridge.ts`.** Dedups the *construction logic* (the `servers.map(s => [\`${pluginId}:${serverId}\`, pluginId])`). Two Map *instances* remain (one in the bridge closure for `authorizeConnect`, one in run.ts for `toolMetadataProvider`) — they cannot be shared without breaking the bridge's encapsulation, and final review accepted this. The win is single-source construction logic + the namespacing literal lives in one place.
4. **`DEFAULT_PLUGIN_STATE_PATH` in `plugin-state-store.ts`.** It is the leaf node (only imports `node:fs`/`node:path`/SDK types) where `FilePluginStateStore` lives; all 4 consumers already import from there.
5. **Order = risk-ascending.** Dead code → docstrings → type → index dedup → state-path. The state-path task (only one touching protected files) is last, isolated commit, full regression.

## File Structure

- Modify `apps/sidecar/src/services/agent-runtime/tools/tool-runtime.ts` + `.test.ts` — dead-code removal.
- Modify `apps/sidecar/src/services/agent-runtime/plugins/runtime-bridge.ts` + `sensitive-gate.ts` + `runtime-core/run.ts` — stale docstrings.
- Modify `apps/sidecar/src/services/mcp/workspace-mcp-manager.ts` + `plugins/plugin-mcp-bridge.ts` + `plugins/sensitive-gate.ts` — type extraction.
- Modify `apps/sidecar/src/services/agent-runtime/plugins/plugin-mcp-bridge.ts` + `runtime-core/run.ts` — index dedup.
- Modify `apps/sidecar/src/services/agent-runtime/plugins/plugin-state-store.ts` + `plugins/plugin-manager.ts` + `runtime-core/run.ts` + `runtime-core/attempt.ts` — state-path constant.

---

## Task 1: Remove dead `resolveCommandPluginSpecs`

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/tools/tool-runtime.ts` (remove method L109-157 + interface L56-59 + now-unused imports)
- Modify: `apps/sidecar/src/services/agent-runtime/tools/tool-runtime.test.ts` (remove the test case L39-79)

- [ ] **Step 1: READ the current code**

Read `tool-runtime.ts` around L56-59 (`ResolveCommandPluginSpecsResult`) and L109-157 (`resolveCommandPluginSpecs`). Read the imports at the top of the file. Read `tool-runtime.test.ts` L39-79 (the test that exercises it).

Confirm: the method's docstring says "retained only for tool-runtime.test.ts; remove it (and its test) in a Phase 3 cleanup". Grep the repo for `resolveCommandPluginSpecs` and `ResolveCommandPluginSpecsResult` to confirm **0 production callers** (only the definition + its own test).

- [ ] **Step 2: Capture the baseline**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/tools/tool-runtime.test.ts`
Expected: PASS (note the count — it includes the soon-to-be-removed test).

- [ ] **Step 3: Remove the method + interface + its test**

In `tool-runtime.ts`:
- Delete the `ResolveCommandPluginSpecsResult` interface (L56-59).
- Delete the `static async resolveCommandPluginSpecs(...)` method + its `@deprecated` docstring (L109-157).
- After deletion, check the file's imports: if `homedir` (from `node:os`), `SidecarPluginManager`, `getEffectiveLumeConfig`, or any other import was used **only** by the deleted method, remove that import too. (Verify by reading the rest of the file — `resolveCommandPluginSpecs` was likely the sole consumer of plugin-manager/config loading inside this file. Do NOT remove imports still used elsewhere in the file.)

In `tool-runtime.test.ts`:
- Delete the `test("resolveCommandPluginSpecs only accepts command manifests", ...)` case (L39-79) and any helper it alone used.

- [ ] **Step 4: Verify typecheck + tests**

```bash
cd apps/sidecar && bun x tsc --noEmit 2>&1 | grep "tool-runtime" | head
rtk bun test apps/sidecar/src/services/agent-runtime/tools/tool-runtime.test.ts
```
Expected: no tool-runtime typecheck errors (unused-import removal keeps it clean); tests PASS with the count reduced by exactly the removed test. **CRITICAL:** no OTHER test in the file broke (the deletion must not have touched shared fixtures).

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/tools/tool-runtime.ts apps/sidecar/src/services/agent-runtime/tools/tool-runtime.test.ts
git commit -m "🔥 chore(sidecar): 移除死代码 resolveCommandPluginSpecs（Phase 3b @deprecated 跟进）"
```

---

## Task 2: Fix stale docstrings

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/runtime-bridge.ts` (L24-35 function docstring)
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/sensitive-gate.ts` (L16-31 docstring — hooks line)
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts` (L913-915 comment — "(Phase 3d)" tag)

- [ ] **Step 1: Fix `assemblePluginRuntime` docstring (runtime-bridge.ts)**

The current docstring (L24-35) claims "MCP servers and hooks are intentionally NOT wired here". That is now false — `assemblePluginRuntime` returns `mcpServers` + `hooks` in the assembly, consumed by `buildPluginMcpManager` (MCP-A/B) + `buildPluginAgentHooks` (3d). Replace the middle paragraph so it describes current behavior. Find:

```ts
 * Pure function of `plugins` — no registry, no filesystem beyond what the resolver
 * already does. MCP servers and hooks are intentionally NOT wired here (MCP: §16.7
 * lifecycle, separate plan; hooks: Phase 3d).
```

Replace with:

```ts
 * Pure function of `plugins` — no registry, no filesystem beyond what the resolver
 * already does. Emits four capability buckets: commandToolDefinitions, skills, hooks,
 * mcpServers. Wiring of each is the caller's job (run.ts): MCP via buildPluginMcpManager
 * (§16.7 lifecycle + §8.1 authorizeConnect start gate), hooks via buildPluginAgentHooks
 * (Phase 3d). Sensitive-use gating (§8.1) reads runtimeMetadata.pluginId stamped on each
 * command-tool / MCP-tool definition downstream.
```

- [ ] **Step 2: Fix `sensitive-gate` docstring hooks line**

In `sensitive-gate.ts` L16-31, the last docstring paragraph says hooks/network/fs-write are "deferred". Hooks are NOT deferred (Phase 3d's `plugin-hooks-bridge.ts` implements the `hook:${event}:${matcher}` gate). Find:

```ts
 * Covers command tools (commandTool:${name}) and plugin-MCP tools (mcpServer:${serverId},
 * §8.1) — both source-bound via runtimeMetadata.pluginId. hooks (`hook:`), network, and
 * filesystem-write keys remain deferred (hooks: Phase 3d gate; fs/net: later extension).
```

Replace with:

```ts
 * Covers command tools (commandTool:${name}) and plugin-MCP tools (mcpServer:${serverId},
 * §8.1) — both source-bound via runtimeMetadata.pluginId. Plugin hooks are gated by
 * plugin-hooks-bridge.ts (hook:${event}:${matcher} key). network and filesystem-write keys
 * remain a later extension.
```

- [ ] **Step 3: Fix run.ts Phase 3d tag**

In `run.ts` ~L913-915, the comment tags "(Phase 3d)" as if in-progress. Phase 3d landed. Find:

```ts
  // Phase 3b: registry → resolver → bridge. Command tools + skills come from the
  // PluginRuntimeBridge now; the SDK's loadPlugins path is no longer used (no
  // agentOptions.plugins). Plugin hooks are wired below (Phase 3d).
```

Replace the last sentence:

```ts
  // Phase 3b: registry → resolver → bridge. Command tools + skills come from the
  // PluginRuntimeBridge now; the SDK's loadPlugins path is no longer used (no
  // agentOptions.plugins). Plugin hooks are wired below (Phase 3d, buildPluginAgentHooks).
```

(Only the parenthetical changes — "(Phase 3d)" → "(Phase 3d, buildPluginAgentHooks)". If the exact wording differs from what's in the file, match the file's current text for the find/replace and apply the same intent: make clear 3d is landed + name the function.)

- [ ] **Step 4: Verify typecheck (docstrings only, no logic change)**

```bash
cd apps/sidecar && bun x tsc --noEmit 2>&1 | grep -E "runtime-bridge|sensitive-gate|run.ts" | head
```
Expected: no new errors (comments don't affect compilation).

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/plugins/runtime-bridge.ts apps/sidecar/src/services/agent-runtime/plugins/sensitive-gate.ts apps/sidecar/src/services/agent-runtime/runtime-core/run.ts
git commit -m "📝 docs(sidecar): 修正插件平台过时注释（assemblePluginRuntime MCP/hooks、sensitive-gate hooks、run.ts 3d 标记）"
```

---

## Task 3: Extract `McpGateDecision` type

**Files:**
- Modify: `apps/sidecar/src/services/mcp/workspace-mcp-manager.ts` (define + export `McpGateDecision`; use it in 3 spots)
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/plugin-mcp-bridge.ts` (use `McpGateDecision` in the closure return type)
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/sensitive-gate.ts` (`SensitiveGateResult` → type alias of `McpGateDecision`)

- [ ] **Step 1: Define + export `McpGateDecision` in workspace-mcp-manager.ts**

Near the `WorkspaceMcpManagerOptions` interface (~L49), add:

```ts
/** Decision returned by an MCP pre-connect authorization gate (§8.1) or the sensitive-gate. */
export interface McpGateDecision {
  decision: "allow" | "block";
  reason?: string;
}
```

Then replace the inline literal in these 3 spots in the same file:
- `WorkspaceMcpManagerOptions.authorizeConnect` (~L54): `Promise<{ decision: "allow" | "block"; reason?: string }>` → `Promise<McpGateDecision>`
- the private field (~L262): same replacement
- `syncWorkspace` local `let gate` (~L298): `let gate: { decision: "allow" | "block"; reason?: string }` → `let gate: McpGateDecision`

- [ ] **Step 2: Use it in plugin-mcp-bridge.ts**

Add to the import from `../../mcp/workspace-mcp-manager.js`:
```ts
import {
  WorkspaceMcpManager,
  type McpGateDecision,
  type WorkspaceSdkMcpManager,
} from "../../mcp/workspace-mcp-manager.js";
```
Replace the closure return type (~L46): `Promise<{ decision: "allow" | "block"; reason?: string }>` → `Promise<McpGateDecision>`.

- [ ] **Step 3: Alias `SensitiveGateResult` in sensitive-gate.ts**

Add the import + make `SensitiveGateResult` an alias (preserves its existing export name + all existing usages):
```ts
import type { McpGateDecision } from "../../mcp/workspace-mcp-manager.js";
```
Replace:
```ts
export interface SensitiveGateResult {
  decision: "allow" | "block";
  reason?: string;
}
```
with:
```ts
export type SensitiveGateResult = McpGateDecision;
```
(Confirm no import cycle: `workspace-mcp-manager.ts` does NOT import from `plugins/`, so `sensitive-gate.ts → mcp/workspace-mcp-manager.ts` adds no cycle. `plugin-mcp-bridge.ts` already imports from `workspace-mcp-manager.ts`.)

- [ ] **Step 4: Verify typecheck + tests**

```bash
cd apps/sidecar && bun x tsc --noEmit 2>&1 | grep -E "workspace-mcp-manager|plugin-mcp-bridge|sensitive-gate" | head
rtk bun test apps/sidecar/src/services/mcp/workspace-mcp-manager.test.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-mcp-bridge.test.ts apps/sidecar/src/services/agent-runtime/plugins/sensitive-gate.test.ts
```
Expected: no new typecheck errors; all tests PASS (pure type refactor, runtime unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/mcp/workspace-mcp-manager.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-mcp-bridge.ts apps/sidecar/src/services/agent-runtime/plugins/sensitive-gate.ts
git commit -m "♻️ refactor(sidecar): 提取 McpGateDecision 类型（消除 4 处字面量重复）"
```

---

## Task 4: Dedup pluginId-index construction (`buildPluginIdIndex`)

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/plugin-mcp-bridge.ts` (export `buildPluginIdIndex`; use it internally)
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts` (use `buildPluginIdIndex` instead of inline Map)

- [ ] **Step 1: Export + use `buildPluginIdIndex` in plugin-mcp-bridge.ts**

Add the exported helper (above `buildPluginMcpManager`):
```ts
/** Build a `${pluginId}:${serverId}` → pluginId index (shared by the start gate + tool stamping). */
export function buildPluginIdIndex(servers: ResolvedMcpServer[]): Map<string, string> {
  return new Map(servers.map((server) => [`${server.pluginId}:${server.serverId}`, server.pluginId]));
}
```

In `buildPluginMcpManager`, replace the inline Map construction. Find:
```ts
  const pluginIdByServerId = new Map<string, string>();
  const namespaced: WorkspaceMcpConfig = { servers: {} };
  for (const server of servers) {
    const id = `${server.pluginId}:${server.serverId}`;
    namespaced.servers[id] = server.entry as McpServerEntry;
    pluginIdByServerId.set(id, server.pluginId);
  }
```
Replace with:
```ts
  const pluginIdByServerId = buildPluginIdIndex(servers);
  const namespaced: WorkspaceMcpConfig = { servers: {} };
  for (const server of servers) {
    const id = `${server.pluginId}:${server.serverId}`;
    namespaced.servers[id] = server.entry as McpServerEntry;
  }
```
(The `namespaced` loop stays — it must also copy `entry`. Only the index Map construction is deduped.)

- [ ] **Step 2: Use `buildPluginIdIndex` in run.ts**

Add `buildPluginIdIndex` to the existing import from `../plugins/plugin-mcp-bridge.js`:
```ts
import {
  buildPluginMcpManager,
  buildPluginIdIndex,
  PLUGIN_MCP_WORKSPACE_SLUG,
} from "../plugins/plugin-mcp-bridge.js";
```
Find (~L962-964):
```ts
  const pluginMcpServerIndex = new Map(
    pluginAssembly.mcpServers.map((server) => [`${server.pluginId}:${server.serverId}`, server.pluginId]),
  );
```
Replace with:
```ts
  const pluginMcpServerIndex = buildPluginIdIndex(pluginAssembly.mcpServers);
```

- [ ] **Step 3: Verify typecheck + tests**

```bash
cd apps/sidecar && bun x tsc --noEmit 2>&1 | grep -E "plugin-mcp-bridge|run.ts" | head
rtk bun test apps/sidecar/src/services/agent-runtime/plugins/plugin-mcp-bridge.test.ts apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts
```
Expected: no new typecheck errors; tests PASS. **CRITICAL:** the `应从 Lume plugin 目录加载命令型插件工具` test still passes — `buildPluginIdIndex([])` returns an empty Map, identical to the old inline construction.

- [ ] **Step 4: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/plugins/plugin-mcp-bridge.ts apps/sidecar/src/services/agent-runtime/runtime-core/run.ts
git commit -m "♻️ refactor(sidecar): 提取 buildPluginIdIndex（去重 pluginMcpServerIndex/pluginIdByServerId 构造逻辑）"
```

---

## Task 5: Extract `DEFAULT_PLUGIN_STATE_PATH` constant

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/plugin-state-store.ts` (define + export constant)
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/plugin-manager.ts` (L19 default param)
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts` (L930 + L960)
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/attempt.ts` (L679) — **previously off-limits; relax for this literal→constant substitution only**

- [ ] **Step 1: Define `DEFAULT_PLUGIN_STATE_PATH` in plugin-state-store.ts**

Read the top of `plugin-state-store.ts` — confirm its current imports (it imports `dirname` from `node:path` per the survey). Add `homedir` + `join` if not present, then add the constant near the top (after imports, before the store class):

```ts
import { homedir } from "node:os";
import { dirname, join } from "node:path";
// ... existing imports ...

/** Shared plugin sensitive-approval state file (read by the start gate, call gate, hook gate). */
export const DEFAULT_PLUGIN_STATE_PATH = join(homedir(), ".lume", "plugins-state.json");
```

(If `homedir`/`join` are already imported, do not duplicate. The literal MUST be byte-identical to the existing `join(homedir(), ".lume", "plugins-state.json")`.)

- [ ] **Step 2: Replace the 4 call sites**

Each site currently reads `join(homedir(), ".lume", "plugins-state.json")` (or, in plugin-manager.ts, `statePath = join(homedir(), ".lume", "plugins-state.json")` as a default param). Replace with `DEFAULT_PLUGIN_STATE_PATH`, importing it from `./plugin-state-store.js` (or the appropriate relative path):

- **plugin-manager.ts L19**: `statePath = join(homedir(), ".lume", "plugins-state.json")` → `statePath = DEFAULT_PLUGIN_STATE_PATH`. Add the import. If `homedir`/`join` become unused in this file after the replacement, remove those imports (check the rest of the file first).
- **run.ts L930** (`hookPermissionRuntime`'s `new FilePluginStateStore(...)`) and **L960** (`pluginMcpPermissionRuntime`'s): replace the literal. Add `DEFAULT_PLUGIN_STATE_PATH` to the existing `plugin-state-store.js` import.
- **attempt.ts L679** (`pluginPermissionRuntime`'s): replace the literal. Add `DEFAULT_PLUGIN_STATE_PATH` to the existing `plugin-state-store.js` import.

(For each file, the `FilePluginStateStore` import already exists — only add `DEFAULT_PLUGIN_STATE_PATH` to that same import statement.)

- [ ] **Step 3: Verify typecheck + full plugin-platform regression**

```bash
cd apps/sidecar && bun x tsc --noEmit 2>&1 | grep -E "plugin-state-store|plugin-manager|run.ts|attempt.ts" | head
rtk bun test apps/sidecar/src/services/agent-runtime/plugins/ apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts
```
Expected: no new typecheck errors; tests PASS. **CRITICAL:** the three gates (start/call/hook) all read the SAME file — the constant substitution must not change the path string. The plugin-manager + sensitive-gate + hook tests confirm state is still read/written correctly.

- [ ] **Step 4: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/plugins/plugin-state-store.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-manager.ts apps/sidecar/src/services/agent-runtime/runtime-core/run.ts apps/sidecar/src/services/agent-runtime/runtime-core/attempt.ts
git commit -m "♻️ refactor(sidecar): 提取 DEFAULT_PLUGIN_STATE_PATH 常量（消除 4 处路径字面量重复）"
```

---

## Task 6: Full regression + boundary

**Files:** none (verification only)

- [ ] **Step 1: Full regression**

```bash
rtk bun test packages/sdk/src/plugins/ apps/sidecar/src/services/agent-runtime/plugins/ apps/sidecar/src/services/agent-runtime/tools/ apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts apps/sidecar/src/services/mcp/workspace-mcp-manager.test.ts apps/sidecar/src/rpc/agent-handlers.list-plugins.test.ts
```
Expected: ALL PASS, 0 new FAIL. Pre-existing office fails (office_validate/unpack/pack, 5 tests) are unchanged (they fail identically on the cleanup base commit). The cleanup must not change any pass/fail count outside those 5.

- [ ] **Step 2: Boundary — cleanup change set**

Cleanup base = `cc956736` (MCP-B HEAD before this plan). The change set should be exactly the files named in Tasks 1-5:
```bash
git diff --name-only cc956736..HEAD
```
Expected: `tool-runtime.ts`, `tool-runtime.test.ts`, `runtime-bridge.ts`, `sensitive-gate.ts`, `run.ts`, `workspace-mcp-manager.ts`, `plugin-mcp-bridge.ts`, `plugin-state-store.ts`, `plugin-manager.ts`, `attempt.ts`, + this plan doc. **No other files.**

- [ ] **Step 3: Confirm attempt.ts change is ONLY the literal→constant**

```bash
git diff cc956736..HEAD -- apps/sidecar/src/services/agent-runtime/runtime-core/attempt.ts
```
Expected: exactly one hunk — the import line (add `DEFAULT_PLUGIN_STATE_PATH`) + the one literal replaced. **No other attempt.ts changes.** Same check for `plugin-manager.ts`.

- [ ] **Step 4: Commit final state (only if unstaged)**

If only `docs/superpowers/handoffs/`/`__pycache__` untracked, skip. Otherwise `✅ test(sidecar): 插件平台清理回归与边界校验`.

---

## Notes for the executing agent

- **Run every command from the worktree root** `/Users/cavinhuang/.config/superpowers/worktrees/Lume/codex-plugin-platform-phase1`.
- **This is a cleanup slice — behavior must NOT change.** Every task's verification is "existing tests pass + typecheck clean". If any previously-passing test now fails, STOP and report — a cleanup broke something.
- **Office test fails are pre-existing.** The 5 `office_validate`/`unpack`/`pack` fails exist on the cleanup base (`cc956736`) and are unrelated. Do not try to fix them.
- **Task 5 relaxes the per-phase "do not touch attempt.ts / plugin-manager.ts" rule** — but ONLY for the literal→constant substitution. Task 6 Step 3 explicitly verifies attempt.ts has exactly one hunk. Any other change to those files is out of scope.
- **Unused-import cleanup is part of Task 1 + Task 5.** After deleting `resolveCommandPluginSpecs` (Task 1) or replacing the state-path literal (Task 5), check whether `homedir`/`join`/`SidecarPluginManager`/`getEffectiveLumeConfig` imports became unused in that file. Remove only those that YOUR change orphaned (CLAUDE.md §3: clean up your own mess). Do NOT remove pre-existing unused imports unrelated to your change.
- **No new tests needed** (cleanup is verified by existing tests), EXCEPT: if a deletion accidentally removes a shared fixture, the existing tests will catch it — that's the safety net.
- **`buildPluginIdIndex` + `McpGateDecision` + `DEFAULT_PLUGIN_STATE_PATH`** are the only new exports. Each is defined at the dependency-root file for its consumers (no cycles).
- **Do not "improve" adjacent code.** Per CLAUDE.md §3, only the named cleanup. Stale-docstring task edits only the named comment text.
- **RTK prefix.** `rtk bun test ...` / `bun x tsc ...`.
