# Lume Plugin Platform 3d-reload — `/reload-plugins` RPC + CAPABILITIES_CHANGED + Slash Interception Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/reload-plugins` slash command that, when typed in the agent input, asks the sidecar to re-scan the plugin directories and refresh the client's plugin/skill list — WITHOUT invalidating any running session (the next message's attempt picks up the new plugins automatically, because the sidecar plugin system is stateless and per-attempt).

**Architecture:** The sidecar plugin system has no cache to invalidate — every `createRuntimeCoreSession` does `new SidecarPluginManager()` → `listRegistered()` → fresh `PluginRegistry` → re-scans disk + re-reads `plugins-state.json`. So reload reduces to: (1) a new `RELOAD_PLUGINS` RPC in the sidecar that re-runs the LIST_PLUGINS scan and emits `CAPABILITIES_CHANGED`; (2) a `RELOAD_PLUGINS` channel in `@lume/shared`; (3) a slash-command interception in the web `AgentInput.handleSend` that detects `/reload-plugins`, calls the RPC, refreshes the local plugin list, and does NOT send the message to the agent. The SDK's `agent.reloadPlugins()` / `QueryController.reloadPlugins()` are NOT used (the sidecar agent has no `plugins:` option, so they are no-ops).

**Tech Stack:** TypeScript, Bun test (sidecar), React (web), existing `AGENT_IPC_CHANNELS` + `sidecarCall` + `createAgentHandlers` patterns.

---

## Scope

Implements the **`/reload-plugins` UX slice** of the plugin platform (spec §6.5 capability reload):

- `RELOAD_PLUGINS` channel in `@lume/shared` (mirrors `LIST_PLUGINS`).
- `RELOAD_PLUGINS` RPC handler in the sidecar: re-scan + return `{ plugins, diagnostics }` (same shape as `LIST_PLUGINS`) + emit `CAPABILITIES_CHANGED`.
- Slash interception in web `AgentInput`: `/reload-plugins` → call RPC → refresh `installedPlugins` → toast → do NOT `agentSend`.

**Out of scope:**

- **Auto-reload via filesystem watcher** (extending `workspace-watcher.ts` to also watch `/plugins/` paths) — optional follow-up; the RPC path covers manual reload.
- **Web subscription to `CAPABILITIES_CHANGED`** (so watcher-emitted notifications also refresh the UI) — optional; the RPC response already carries the fresh list for the manual path.
- **SDK `reloadPlugins()`** — explicitly NOT used (no-op in sidecar).
- **Permission-state editing UI** — Phase 4.

**Constraints:**

- **Do NOT invalidate running sessions.** Reload only affects the NEXT attempt. The current attempt keeps its already-built session (no hot-swap mid-run — this is desired).
- **Do NOT add caching to `SidecarPluginManager` / `PluginRegistry`.** The stateless per-attempt design is what makes reload trivial; don't break it.
- **Web part has no component-test harness** — verify via `tsc` + manual behavior description. Sidecar handler has a unit test (mirrors `agent-handlers.list-plugins.test.ts`).
- Match existing style: 2-space indent, double quotes in sidecar, single quotes in web (`apps/web` uses single quotes per `AgentInput.tsx`), no `any`, `bun:test`.

## Design Decisions

1. **Reload = re-scan + notify, nothing more.** Because `SidecarPluginManager` / `PluginRegistry` / `FilePluginStateStore` are all stateless (re-read disk every call), there is no cache to clear and no registry to rebuild. The `RELOAD_PLUGINS` handler is literally "run the LIST_PLUGINS scan again + emit CAPABILITIES_CHANGED". The next attempt's `createRuntimeCoreSession` naturally reads the new disk state.

2. **Extract a shared `buildAgentPluginList()` helper.** `LIST_PLUGINS` and `RELOAD_PLUGINS` both need "scan + map to `AgentPluginListItem[]`". Extracting this keeps them DRY (the mapping logic at `agent-handlers.ts:959-981` is non-trivial). `LIST_PLUGINS` is refactored to call the helper; `RELOAD_PLUGINS` calls it + emits.

3. **`RELOAD_PLUGINS` returns the same shape as `LIST_PLUGINS`** (`{ plugins, diagnostics }`). The web client already has `normalizeListPluginsResult` to consume this shape, so the interception refreshes `installedPlugins` with zero new normalization code.

4. **Slash interception in `handleSend`, not in a global command registry.** The web app has no slash-command interception layer today (only `/compact` is intercepted, and that's in the SDK engine, not the web). Adding a single `if (rawText === '/reload-plugins')` branch in `handleSend` (mirroring how `/compact` is a literal-trim match) is the minimal, consistent approach. A fuller command registry is a later UX task.

5. **Emit `CAPABILITIES_CHANGED` from the handler, not the watcher.** The handler has `context.writeNotification`. Emitting there keeps the reload self-contained (no watcher dependency). The (optional) watcher extension is separate.

6. **Toast feedback.** Reload is a user-initiated action; a success/error toast confirms it ran (the plugin list popover also visually updates, but a toast is clearer for "command consumed").

## File Structure

- Modify `packages/shared/src/types/agent.ts` — add `RELOAD_PLUGINS` channel.
- Modify `apps/sidecar/src/rpc/agent-handlers.ts` — extract `buildAgentPluginList()` helper; `LIST_PLUGINS` uses it; add `RELOAD_PLUGINS` handler (helper + emit).
- Create `apps/sidecar/src/rpc/agent-handlers.reload-plugins.test.ts` — unit test the new handler (mirrors `agent-handlers.list-plugins.test.ts`).
- Modify `apps/web/src/components/agent/AgentInput.tsx` — slash interception in `handleSend`.

No changes to `plugin-manager.ts`, `plugin-registry.ts`, `plugin-state-store.ts`, `run.ts`, `attempt.ts`, SDK.

---

## Task 1: Add `RELOAD_PLUGINS` channel

**Files:**
- Modify: `packages/shared/src/types/agent.ts` (add channel near `LIST_PLUGINS` ~L1348)

- [ ] **Step 1: Add the channel**

In `packages/shared/src/types/agent.ts`, find the `LIST_PLUGINS: 'agent:list-plugins',` line (in `AGENT_IPC_CHANNELS`). Add immediately after it:

```ts
    LIST_PLUGINS: 'agent:list-plugins',
    /** Re-scan plugin directories and refresh capability list (sidecar → emits CAPABILITIES_CHANGED). */
    RELOAD_PLUGINS: 'agent:reload-plugins',
```

(Use the exact indentation/style of the surrounding channel entries. `RELOAD_PLUGINS` reuses `AgentListPluginsResult` as its return type — no new result type needed.)

- [ ] **Step 2: Verify typecheck**

Run: `cd packages/shared && bun x tsc --noEmit 2>&1 | grep agent.ts | head`
Expected: no new errors (adding a string-literal key to an `as const` object is safe).

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/types/agent.ts
git commit -m "✨ feat(shared): 新增 RELOAD_PLUGINS IPC channel"
```

---

## Task 2: Sidecar `RELOAD_PLUGINS` handler + `buildAgentPluginList` helper

**Files:**
- Modify: `apps/sidecar/src/rpc/agent-handlers.ts` (extract helper ~L959-981; add handler)
- Create: `apps/sidecar/src/rpc/agent-handlers.reload-plugins.test.ts`

- [ ] **Step 1: READ the current LIST_PLUGINS handler + context**

Read `apps/sidecar/src/rpc/agent-handlers.ts`:
- The `AgentHandlersContext` interface (~L231-240) — confirm `writeNotification: NotificationWriter` is present (RELOAD_PLUGINS uses it).
- The `LIST_PLUGINS` handler (~L959-981) — the scan + mapping logic to extract.
- The imports at the top — confirm `AGENT_IPC_CHANNELS` and `SidecarPluginManager` are imported.

Read `apps/sidecar/src/rpc/agent-handlers.list-plugins.test.ts` — the test pattern to mirror (how it constructs the handler context, fakes/real plugin dirs, asserts the result shape).

- [ ] **Step 2: Write the failing test**

Create `apps/sidecar/src/rpc/agent-handlers.reload-plugins.test.ts`. Mirror `agent-handlers.list-plugins.test.ts`'s setup (same context construction, same plugin-dir fixture approach). Two assertions: (a) the handler returns `{ plugins, diagnostics }` with the scanned plugins; (b) it emitted `CAPABILITIES_CHANGED` via `writeNotification`.

```ts
import { describe, expect, test } from "bun:test";
import { AGENT_IPC_CHANNELS } from "@lume/shared";
import { createAgentHandlers } from "./agent-handlers";
// Mirror whatever imports/fixtures agent-handlers.list-plugins.test.ts uses for
// constructing AgentHandlersContext + a temporary plugin directory.

describe("RELOAD_PLUGINS handler", () => {
  test("re-scans plugins and emits CAPABILITIES_CHANGED", async () => {
    const notifications: Array<{ method: string; params: unknown }> = [];
    const context = {
      writeNotification: (method: string, params: unknown) => {
        notifications.push({ method, params });
      },
      // ...mirror the rest of AgentHandlersContext from list-plugins.test.ts...
    };
    const handlers = createAgentHandlers(context as never);

    const result = await (handlers[AGENT_IPC_CHANNELS.RELOAD_PLUGINS] as () => Promise<unknown>)();

    expect(result).toHaveProperty("plugins");
    expect(notifications.some((n) => n.method === AGENT_IPC_CHANNELS.CAPABILITIES_CHANGED)).toBe(true);
  });
});
```

(Adapt the context fixture to match `agent-handlers.list-plugins.test.ts` exactly — reuse its helper if it has one for building a temp plugin dir + context. The key new assertion is the `CAPABILITIES_CHANGED` notification.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `rtk bun test apps/sidecar/src/rpc/agent-handlers.reload-plugins.test.ts`
Expected: FAIL — `handlers[AGENT_IPC_CHANNELS.RELOAD_PLUGINS]` is `undefined` (handler not registered).

- [ ] **Step 4: Extract `buildAgentPluginList` helper + add the handler**

In `agent-handlers.ts`:

(a) Extract the scan+map logic from `LIST_PLUGINS` into a module-level helper (place it above `createAgentHandlers` or near the other module helpers):

```ts
async function buildAgentPluginList(): Promise<{
  plugins: AgentPluginListItem[];
  diagnostics: AgentPluginDiagnostic[];
}> {
  const manager = new SidecarPluginManager();
  const plugins = await manager.resolveEnabled({ enabled: [], directories: [] });
  const items: AgentPluginListItem[] = plugins.map((p) => ({
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
  return { plugins: items, diagnostics: items.flatMap((item) => item.diagnostics) };
}
```

(Confirm `AgentPluginListItem` + `AgentPluginDiagnostic` are imported — they're used by the existing LIST_PLUGINS handler, so the types are available. If `agent-handlers.ts` infers them rather than naming them, add the import from `@lume/shared`.)

(b) Refactor `LIST_PLUGINS` to use it:
```ts
    [AGENT_IPC_CHANNELS.LIST_PLUGINS]: async () => {
      const result = await buildAgentPluginList();
      log.info("LIST_PLUGINS request", { count: result.plugins.length, names: result.plugins.map((p) => p.name) });
      return result;
    },
```

(c) Add the `RELOAD_PLUGINS` handler right after `LIST_PLUGINS`:
```ts
    [AGENT_IPC_CHANNELS.RELOAD_PLUGINS]: async () => {
      const result = await buildAgentPluginList();
      log.info("RELOAD_PLUGINS request", { count: result.plugins.length, names: result.plugins.map((p) => p.name) });
      // Notify the client to refresh capability UIs. The next agent attempt reads the
      // fresh disk state automatically (stateless per-attempt plugin loading).
      writeNotification(AGENT_IPC_CHANNELS.CAPABILITIES_CHANGED, {});
      return result;
    },
```

(Confirm `writeNotification` is in scope inside `createAgentHandlers` — it's destructured from `AgentHandlersContext` or accessed via `context.writeNotification`. Match how the existing handlers reference it; if none currently emit, use `context.writeNotification` or the destructured name. `AGENT_IPC_CHANNELS` is already imported.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `rtk bun test apps/sidecar/src/rpc/agent-handlers.reload-plugins.test.ts apps/sidecar/src/rpc/agent-handlers.list-plugins.test.ts`
Expected: PASS — the new test passes (handler returns plugins + emits CAPABILITIES_CHANGED); the existing `list-plugins` test still passes (LIST_PLUGINS behavior unchanged after the helper extraction).

- [ ] **Step 6: Verify typecheck**

Run: `cd apps/sidecar && bun x tsc --noEmit 2>&1 | grep "agent-handlers" | head`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add apps/sidecar/src/rpc/agent-handlers.ts apps/sidecar/src/rpc/agent-handlers.reload-plugins.test.ts
git commit -m "✨ feat(sidecar): 新增 RELOAD_PLUGINS RPC（复用 LIST_PLUGINS 扫描 + emit CAPABILITIES_CHANGED）"
```

---

## Task 3: Web slash interception in `handleSend`

**Files:**
- Modify: `apps/web/src/components/agent/AgentInput.tsx` (handleSend ~L447-453)

- [ ] **Step 1: READ the current handleSend + plugin-list state**

Read `apps/web/src/components/agent/AgentInput.tsx`:
- `handleSend` (~L447-453): `rawText = applyAgentRoleMentions(editor.getText()).trim()` (L449), the empty check (L450), `setLocalSending(true)` (L452), `text = rawText || '请解读这些附件。'` (L453).
- The `handleOpenPlugins` handler (~L649-658): how it calls `sidecarCall(AGENT_IPC_CHANNELS.LIST_PLUGINS, {})` + `setInstalledPlugins(normalizeListPluginsResult(result))` + `setPluginsPopoverOpen`. This is the exact refresh pattern to reuse.
- Confirm imports: `AGENT_IPC_CHANNELS`, `sidecarCall`, `normalizeListPluginsResult`, `setInstalledPlugins`, `toast` are all in scope (used by `handleOpenPlugins`).

- [ ] **Step 2: Add the interception**

In `handleSend`, immediately after the `rawText` empty check (L450) and BEFORE `setLocalSending(true)` (L452), add a slash-command branch. The branch: clear the editor, call the RPC, refresh the plugin list, toast, and return (do NOT fall through to `agentSend`):

```ts
    const rawText = applyAgentRoleMentions(editor.getText()).trim()
    if (!rawText && pendingAttachments.length === 0) return

    // 3d-reload: intercept the /reload-plugins slash command. Re-scan plugins on the
    // sidecar, refresh the local list, and consume the command (do NOT send to the agent).
    // The next agent attempt picks up the fresh disk state automatically.
    if (rawText === '/reload-plugins') {
      editor.commands.clearContent()
      setEditorText('')
      try {
        const result = await sidecarCall(AGENT_IPC_CHANNELS.RELOAD_PLUGINS, {})
        setInstalledPlugins(normalizeListPluginsResult(result))
        toast.success('插件已重新加载')
      } catch (error) {
        console.error('[AgentInput] 重载插件失败:', error)
        toast.error('重载插件失败')
      }
      return
    }

    setLocalSending(true)
```

(Confirm the exact names match the file: `setInstalledPlugins`, `normalizeListPluginsResult`, `setEditorText`, `toast`, `sidecarCall`, `AGENT_IPC_CHANNELS`. If `handleOpenPlugins` uses slightly different names, match those. The `editor.commands.clearContent()` + `setEditorText('')` mirror L483-484 so the input is consumed just like a normal send.)

- [ ] **Step 3: Verify typecheck (web)**

Run: `cd apps/web && bun x tsc --noEmit 2>&1 | grep "AgentInput" | head`
Expected: no new errors. (If `apps/web` has no tsc script / uses a different check, run whatever the web package uses for typecheck — check `apps/web/package.json` scripts. The goal: no type errors introduced by the new branch.)

- [ ] **Step 4: Manual behavior note**

There is no component-test harness for `AgentInput`. Document the expected behavior for manual verification: typing `/reload-plugins` (exact, trimmed) + Enter → input clears, a success toast appears, the plugin popover (if opened) shows the refreshed list, and NO message is sent to the agent. (If the team has a web test runner, a smoke test can be added later — out of scope here.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/agent/AgentInput.tsx
git commit -m "✨ feat(web): AgentInput 拦截 /reload-plugins 斜杠命令（调 RPC + 刷新插件列表）"
```

---

## Task 4: Regression + boundary

**Files:** none (verification only)

- [ ] **Step 1: Full regression**

```bash
rtk bun test packages/shared/src/ packages/sdk/src/plugins/ apps/sidecar/src/rpc/ apps/sidecar/src/services/agent-runtime/plugins/ apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts
```
Expected: ALL PASS, 0 new FAIL. Pre-existing office fails (if the `tools/` suite is included) are unchanged — they are unrelated to this plan. The new `agent-handlers.reload-plugins.test.ts` passes; `agent-handlers.list-plugins.test.ts` still passes after the helper extraction.

- [ ] **Step 2: Boundary — 3d-reload change set**

3d-reload base = the cleanup plan's HEAD (the commit before Task 1 of this plan). The change set should be exactly:
```bash
git diff --name-only <3d-reload-base>..HEAD
```
Expected: `packages/shared/src/types/agent.ts`, `apps/sidecar/src/rpc/agent-handlers.ts`, `apps/sidecar/src/rpc/agent-handlers.reload-plugins.test.ts` (new), `apps/web/src/components/agent/AgentInput.tsx`, + this plan doc. **No other files** — in particular NOT `plugin-manager.ts`, `plugin-registry.ts`, `plugin-state-store.ts`, `run.ts`, `attempt.ts`, SDK `agent.ts`/`query-controller.ts`.

- [ ] **Step 3: Commit final state (only if unstaged)**

If only `docs/superpowers/handoffs/`/`__pycache__` untracked, skip. Otherwise `✅ test: 3d-reload 回归与边界校验`.

---

## Notes for the executing agent

- **Run every command from the worktree root** `/Users/cavinhuang/.config/superpowers/worktrees/Lume/codex-plugin-platform-phase1`.
- **Reload is trivial by design.** The sidecar plugin system is stateless + per-attempt — DO NOT add caching, DO NOT invalidate sessions, DO NOT call SDK `reloadPlugins()`. The whole feature is: a re-scan RPC + a client interception.
- **The `buildAgentPluginList` helper extraction (Task 2) is the one refactor.** It changes `LIST_PLUGINS` internals but not its output — the `list-plugins` test is the regression guard. If that test fails after extraction, the helper's mapping diverged from the original inline mapping — fix the helper, don't change the test.
- **`writeNotification` scope.** If no existing handler in `createAgentHandlers` emits a notification, check how `AgentHandlersContext.writeNotification` is accessed (destructured param vs `context.writeNotification`). Match the established pattern; if unclear, it's a property on the context object passed to `createAgentHandlers`.
- **Web style is single quotes** (`apps/web` uses `'...'`), sidecar is double quotes. Match each file's convention.
- **Web has no component-test harness.** Task 3 verifies via typecheck only; the behavior is described for manual QA. Do not invent a test framework.
- **Do not "improve" adjacent code.** Per CLAUDE.md §3, only the named files. The `handleOpenPlugins` refresh pattern is the template — reuse it, don't refactor it.
- **RTK prefix** for sidecar tests: `rtk bun test ...`. Web typecheck: `bun x tsc` (no rtk).
