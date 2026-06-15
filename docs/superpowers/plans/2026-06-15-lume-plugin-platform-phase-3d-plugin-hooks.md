# Lume Plugin Platform Phase 3d — Plugin Hooks Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Phase 3d (hooks slice) of the plugin platform — wire plugin hooks (from the Phase 3a resolver's `HookConfig`) into the agent runtime via `agentOptions.hooks`, restoring the plugin-hook execution path that Phase 3b cut (it stopped passing `agentOptions.plugins`, so SDK `loadPlugins` no longer injects plugin hooks), AND adding a sensitive-capability gate on **shell-command hook fire** (`hook:${event}:${matcher}` key) per spec §8.1.

**Architecture:** The SDK exposes an always-available host-hooks injection path: `agentOptions.hooks` (`Record<event, Array<{matcher?; hooks: handler[]; timeout?}>>`) — `resetHookRegistry` (agent.ts:372-389) auto-expands it into the internal `HookRegistry`. Phase 3b populated everything EXCEPT hooks. 3d extends `assemblePluginRuntime` to carry the resolver's per-plugin `HookConfig`, then a new pure function `buildPluginAgentHooks` converts each `HookConfig` → the `agentOptions.hooks` shape. Shell-command hooks (the §8.1 sensitive case) cannot pass through the SDK's private `executeShellHook` (which spawns with no gate), so each is rewritten into a gate-aware handler that closes over `pluginId + event + matcher`, calls `PluginPermissionRuntime.checkSensitiveCapability`, and only spawns (via a sidecar `defaultShellHookSpawner` replicating `executeShellHook`) when `allow`-ed; `ask`/`deny` → no spawn + warn-log. `createRuntimeCoreSession` constructs a `PluginPermissionRuntime` and sets `agentOptions.hooks = buildPluginAgentHooks(...)`.

**Tech Stack:** TypeScript, Bun test, existing `@lume/agent-sdk` exports (`HookInput`, `HookOutput`, `HookConfig`, `HookDefinition`, `SensitiveCapabilityKey`, `AbortSignal`), Phase 2 `PluginPermissionRuntime` + `FilePluginStateStore`, Phase 3a resolver's `ResolvedPluginCapability.hooks`, Phase 3b `assemblePluginRuntime` + `PluginRuntimeAssembly`.

---

## Scope

Implements the **plugin hooks wiring** slice of [the approved design spec](../specs/2026-06-13-lume-plugin-platform-design.md) §6.4 (`PluginRuntimeBridge`: "将插件 hooks 注册进现有 hook registry") + §8.1 (shell command hooks = sensitive, first-use confirmation) + §8.2 (hooks carry `pluginId`):

- Extend `PluginRuntimeAssembly` to carry resolved plugin hooks (`{ pluginId; hooks: HookConfig }[]`).
- New `buildPluginAgentHooks({ capabilities, runtime, workspaceSlug, spawner })` pure function: converts resolver `HookConfig` → `agentOptions.hooks`, wrapping shell-command hooks in a gate-aware handler.
- New `defaultShellHookSpawner` (sidecar): replicates SDK `executeShellHook` (spawn bash, stdin JSON, stdout → `HookOutput`), since the SDK's is private.
- Wire `agentOptions.hooks` in `createRuntimeCoreSession` (`run.ts`), constructing a `PluginPermissionRuntime` (same state path as `attempt.ts`).

**Out of scope (deferred):**

- **`/reload-plugins` RPC** + `/reload-plugins` slash command interception + `CAPABILITIES_CHANGED` notification — separate plan (3d-reload). Note: sidecar agents are per-attempt (per-message), so reload needs no live tool-pool hot-swap — it's just RPC + notification + next-attempt-picks-up-new-config.
- **MCP gating/merge** — separate plan (§16.7 lifecycle).
- **handler-type plugin hooks** (rare — plugin JSON hooks are shell commands): 3d passes them through wrapped (no gate), but the test focus is shell-command hooks.
- **`PluginAuditLog`** (§8.3) — Phase 4. 3d uses `console.warn`/logger for gate blocks.
- **Migrating the Phase 1 `createPluginPermissionInterceptor`** — unchanged.

**Constraints:**

- **No SDK changes.** `executeShellHook` stays private; 3d replicates spawn in sidecar. `HookOutput`/`HookInput`/`HookConfig`/`HookDefinition` are already exported.
- **Touch surface:** `runtime-bridge.ts` (extend assembly), new `plugin-hooks-bridge.ts` + test, `run.ts` (construct runtime + set `agentOptions.hooks`). Do NOT touch `attempt.ts`, `sensitive-gate.ts`, `permission-runtime.ts`, `permission-interceptor.ts`, `hooks.ts`, `agent.ts`.
- Shell-command hook gate: `ask` AND `deny` both → no spawn + warn-log (Phase 2 ask→block convention; the hook simply doesn't fire). `allow` → spawn. Non-shell (handler-type) hooks pass through ungated (rare; spec §8.1 sensitive list is "shell command hooks").
- `pluginId` is bound via closure at conversion time (`capability.pluginId` from the resolver) — do NOT modify `HookDefinition`/`HookInput` to add fields (SDK ignores them).
- Match Phase 1-3c style: 2-space indent, double quotes in sidecar, no `any` (cast through `unknown` where needed), `bun:test`.

## Design Decisions

1. **Inject via `agentOptions.hooks`, NOT a sidecar `HookRegistry` instance.** The SDK's `resetHookRegistry` (agent.ts:372-389) auto-expands `agentOptions.hooks` into its internal `HookRegistry` on `setup()`. So sidecar does NOT need to own a `HookRegistry`; it just constructs the `agentOptions.hooks` object in the right shape. This is the lowest-touch path (no SDK change, no sidecar registry plumbing) and reuses the host-hooks path that was always available but unused.

2. **"Conversion-time wrapping" for shell hooks (no SDK hook-fire interception point).** The SDK's `HookRegistry.executeDetailed` → `executeShellHook` (hooks.ts:319 spawn) has no external gate hook (unlike `canUseTool` for tools). So 3d does NOT pass shell-command `command` strings through (the SDK would spawn them ungated). Instead, each shell hook is rewritten into a `handler` function that closes over `pluginId + event + matcher`, runs `checkSensitiveCapability` first, and spawns (sidecar-side) only on `allow`. This keeps the gate entirely in sidecar code.

3. **Sidecar replicates `executeShellHook` (`defaultShellHookSpawner`).** The SDK's `executeShellHook` (hooks.ts:307-377) is private. 3d replicates its ~50-line spawn logic (spawn `bash -c`, JSON on stdin, `HOOK_*` env vars, stdout → `HookOutput` parse with non-JSON fallback to `{message}`). The spawner is injected into `buildPluginAgentHooks` so tests can mock it.

4. **Gate key: `hook:${event}:${matcher || '*'}`.** Matches the `SensitiveCapabilityKey` variant (`permission-gate.ts:10`). `matcher` defaults to `'*'` when absent (a hook with no matcher matches all tools, so the key still uniquely identifies the capability).

5. **`ask`/`deny` → no spawn + warn-log (not `HookOutput.block`).** The gate's purpose is "this shell command must not execute." Returning `{block: true}` would only affect PreToolUse tool-blocking semantics (engine.ts:1484-1497), not prevent the spawn. So on gate-block the handler simply does NOT spawn and returns `undefined` (hook produces no output), plus a `console.warn`/log for diagnosability. This is the §8.1 "block + diagnostic" applied to hooks.

6. **`PluginPermissionRuntime` constructed in `run.ts` too.** Phase 3c constructed one in `attempt.ts` (per-attempt, for the tool gate). 3d constructs one in `createRuntimeCoreSession` (per-session-build, for hook gate construction). Both use the same state path `~/.lume/plugins-state.json`. Stateless runtime, so two instances are fine. (Future cleanup: share one — out of 3d scope.)

7. **handler-type hooks pass through ungated.** Plugin JSON hooks are virtually always shell commands. If a hook has `handler` (function) instead of `command`, 3d wraps it to match the `(input, toolUseId, {signal})` signature and registers it WITHOUT a gate (it's not a shell subprocess). Documented; tests focus on shell-command hooks.

## File Structure

Sidecar (the hooks bridge + wiring):

- Modify `apps/sidecar/src/services/agent-runtime/plugins/runtime-bridge.ts` — extend `PluginRuntimeAssembly` with `hooks: Array<{ pluginId; hooks: HookConfig }>`; collect `capability.hooks` (with `capability.pluginId`) in `assemblePluginRuntime`.
- Modify `apps/sidecar/src/services/agent-runtime/plugins/runtime-bridge.test.ts` — assert the new `hooks` field is collected.
- Create `apps/sidecar/src/services/agent-runtime/plugins/plugin-hooks-bridge.ts` — `ShellHookSpawner` type, `defaultShellHookSpawner` (replicates `executeShellHook`), `buildPluginAgentHooks(...)` (conversion + gate-aware wrapping), exported types.
- Create `apps/sidecar/src/services/agent-runtime/plugins/plugin-hooks-bridge.test.ts` — unit tests with mock runtime + mock spawner.
- Modify `apps/sidecar/src/services/agent-runtime/plugins/index.ts` — export `buildPluginAgentHooks`, `defaultShellHookSpawner`, `ShellHookSpawner`.
- Modify `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts` — construct `PluginPermissionRuntime`; call `buildPluginAgentHooks`; set `agentOptions.hooks`.

No SDK changes. No changes to `attempt.ts`, `sensitive-gate.ts`, `permission-runtime.ts`, `hooks.ts`, `agent.ts`.

---

## Chunk 1: Extend `PluginRuntimeAssembly` with hooks

Carry the resolver's per-plugin `HookConfig` (already filtered by `permissions.hooks.events` in Phase 3a) through the bridge so `buildPluginAgentHooks` can consume it.

### Task 1: Carry hooks in `PluginRuntimeAssembly`

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/runtime-bridge.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/runtime-bridge.test.ts`

- [ ] **Step 1: Write the failing test**

In `runtime-bridge.test.ts`, add a test asserting `assembly.hooks` carries the resolver's per-plugin hook configs:

```ts
  test("carries resolved plugin hooks (with pluginId) in assembly.hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-bridge-hooks-"));
    try {
      const pluginRoot = join(root, "acme");
      await mkdir(pluginRoot, { recursive: true });
      await writeFile(
        join(pluginRoot, "hooks.json"),
        JSON.stringify({ Stop: [{ command: "echo stop" }] }),
        "utf-8",
      );
      const plugin = makePlugin(pluginRoot, {
        capabilities: {
          skills: [],
          commandTools: [],
          hooksConfigPath: "./hooks.json",
        },
        permissions: { hooks: { events: ["Stop"] } },
      });

      const assembly = await assemblePluginRuntime([plugin]);

      expect(assembly.hooks).toEqual([
        { pluginId: "acme", hooks: { Stop: [{ command: "echo stop" }] } },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
```

(Ensure the test file imports `mkdtemp`, `mkdir`, `writeFile`, `rm` from `node:fs/promises` and `tmpdir` from `node:os`, `join` from `node:path`. If `runtime-bridge.test.ts` doesn't already import these, add them — mirror the `capability-resolver.test.ts` fixture pattern.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/runtime-bridge.test.ts -t "hooks"`
Expected: FAIL — `assembly.hooks` is `undefined` (the assembly has no `hooks` field yet).

- [ ] **Step 3: Extend `PluginRuntimeAssembly` + collect hooks**

In `runtime-bridge.ts`:

(a) Add `HookConfig` to the `@lume/agent-sdk` import (it's already exported):
```ts
import {
  buildCommandToolDefinition,
  type HookConfig,
  type PluginDiagnostic,
  type SkillDefinition,
  type ToolDefinition,
} from "@lume/agent-sdk";
```

(b) Add a `hooks` field to `PluginRuntimeAssembly`:
```ts
export interface PluginRuntimeAssembly {
  commandToolDefinitions: ToolDefinition[];
  skills: SkillDefinition[];
  /** Per-plugin resolved hook configs (resolver already filtered to permissions.hooks.events). */
  hooks: Array<{ pluginId: string; hooks: HookConfig }>;
  diagnostics: PluginDiagnostic[];
}
```

(c) In `assemblePluginRuntime`, collect hooks alongside command tools / skills. After the `for (const capability of resolved.capabilities)` loop's existing body, add hooks collection (or inside the loop). The cleanest: inside the loop, push `{ pluginId: capability.pluginId, hooks: capability.hooks }`:
```ts
  for (const capability of resolved.capabilities) {
    // ... existing commandTools + skills collection ...
    hooks.push({ pluginId: capability.pluginId, hooks: capability.hooks });
  }

  return { commandToolDefinitions, skills, hooks, diagnostics: resolved.diagnostics };
```
(Initialize `const hooks: Array<{ pluginId: string; hooks: HookConfig }> = [];` at the top of the function with the other accumulators. Update the JSDoc to note hooks are now carried — Phase 3d wires them into `agentOptions.hooks`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/runtime-bridge.test.ts`
Expected: PASS — the new hooks test passes; existing tests still pass (they don't assert `hooks`, so adding the field is non-breaking — BUT if any existing test uses `toEqual` on the whole assembly, update it to include `hooks`).

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/plugins/runtime-bridge.ts apps/sidecar/src/services/agent-runtime/plugins/runtime-bridge.test.ts
git commit -m "✨ feat(sidecar): PluginRuntimeAssembly 携带 resolved plugin hooks"
```

---

## Chunk 2: `plugin-hooks-bridge.ts` — conversion + gate-aware shell hooks

The core: convert resolver `HookConfig` → `agentOptions.hooks`, wrapping shell-command hooks in a gate-aware handler that only spawns on `allow`. Pure + unit-testable via injected spawner + fake runtime.

### Task 2: Implement `buildPluginAgentHooks` + `defaultShellHookSpawner`

**Files:**
- Create: `apps/sidecar/src/services/agent-runtime/plugins/plugin-hooks-bridge.ts`
- Create: `apps/sidecar/src/services/agent-runtime/plugins/plugin-hooks-bridge.test.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/index.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/sidecar/src/services/agent-runtime/plugins/plugin-hooks-bridge.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildPluginAgentHooks } from "./plugin-hooks-bridge.js";
import type { HookInput, HookOutput } from "@lume/agent-sdk";
import type { PluginPermissionRuntime, SensitiveCheckResult } from "./permission-runtime.js";

function fakeRuntime(decision: SensitiveCheckResult["decision"]): PluginPermissionRuntime {
  return {
    async checkSensitiveCapability(): Promise<SensitiveCheckResult> {
      return { decision, reason: decision === "allow" ? "prior allow" : "no prior approval" };
    },
  } as unknown as PluginPermissionRuntime;
}

/** A fake spawner that records calls + returns a canned HookOutput. */
function recordingSpawner(calls: Array<{ command: string; event: string }>) {
  return async (command: string, input: HookInput): Promise<HookOutput | undefined> => {
    calls.push({ command, event: input.event });
    return { message: `spawned: ${command}` };
  };
}

describe("buildPluginAgentHooks", () => {
  test("produces no hooks for an empty capability list", () => {
    const result = buildPluginAgentHooks({
      capabilities: [],
      runtime: fakeRuntime("allow"),
      workspaceSlug: "ws",
      spawner: recordingSpawner([]),
    });
    expect(result).toEqual({});
  });

  test("converts a shell-command hook into a gate-aware handler entry", async () => {
    const calls: Array<{ command: string; event: string }> = [];
    const result = buildPluginAgentHooks({
      capabilities: [
        { pluginId: "acme", hooks: { Stop: [{ command: "echo stop", matcher: "Bash" }] } },
      ],
      runtime: fakeRuntime("allow"),
      workspaceSlug: "ws",
      spawner: recordingSpawner(calls),
    });

    expect(Object.keys(result)).toEqual(["Stop"]);
    expect(result.Stop).toHaveLength(1);
    expect(result.Stop[0]?.matcher).toBe("Bash");
    expect(result.Stop[0]?.hooks).toHaveLength(1);

    // Fire the handler — allow → spawner called with the command + event.
    const hookInput: HookInput = { event: "Stop", sessionId: "s1" };
    const out = await result.Stop[0]!.hooks[0]!(hookInput, "", { signal: new AbortController().signal });
    expect(out).toEqual({ message: "spawned: echo stop" });
    expect(calls).toEqual([{ command: "echo stop", event: "Stop" }]);
  });

  test("gate deny → handler does NOT spawn and returns undefined", async () => {
    const calls: Array<{ command: string; event: string }> = [];
    const result = buildPluginAgentHooks({
      capabilities: [
        { pluginId: "acme", hooks: { PreToolUse: [{ command: "echo pre" }] } },
      ],
      runtime: fakeRuntime("deny"),
      workspaceSlug: "ws",
      spawner: recordingSpawner(calls),
    });

    const out = await result.PreToolUse[0]!.hooks[0]!(
      { event: "PreToolUse", toolName: "Bash" },
      "",
      { signal: new AbortController().signal },
    );
    expect(out).toBeUndefined();
    expect(calls).toEqual([]); // spawner never called
  });

  test("gate ask → handler does NOT spawn (Phase 2 ask→block for hooks)", async () => {
    const calls: Array<{ command: string; event: string }> = [];
    const result = buildPluginAgentHooks({
      capabilities: [
        { pluginId: "acme", hooks: { Stop: [{ command: "echo stop" }] } },
      ],
      runtime: fakeRuntime("ask"),
      workspaceSlug: "ws",
      spawner: recordingSpawner(calls),
    });

    const out = await result.Stop[0]!.hooks[0]!(
      { event: "Stop" },
      "",
      { signal: new AbortController().signal },
    );
    expect(out).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("gate key uses '*' when matcher is absent", async () => {
    const calls: Array<{ command: string; event: string }> = [];
    let observedKey = "";
    const runtime = {
      async checkSensitiveCapability(params: { key: string }): Promise<SensitiveCheckResult> {
        observedKey = params.key;
        return { decision: "allow", reason: "ok" };
      },
    } as unknown as PluginPermissionRuntime;
    const result = buildPluginAgentHooks({
      capabilities: [{ pluginId: "acme", hooks: { Stop: [{ command: "echo stop" }] } }],
      runtime,
      workspaceSlug: "ws",
      spawner: recordingSpawner(calls),
    });
    await result.Stop[0]!.hooks[0]!({ event: "Stop" }, "", { signal: new AbortController().signal });
    expect(observedKey).toBe("hook:Stop:*");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/plugin-hooks-bridge.test.ts`
Expected: FAIL — `Cannot find module "./plugin-hooks-bridge.js"`.

- [ ] **Step 3: Implement `plugin-hooks-bridge.ts`**

Create `apps/sidecar/src/services/agent-runtime/plugins/plugin-hooks-bridge.ts`:

```ts
import { spawn } from "node:child_process";
import type {
  HookConfig,
  HookDefinition,
  HookInput,
  HookOutput,
  SensitiveCapabilityKey,
} from "@lume/agent-sdk";
import type { PluginPermissionRuntime } from "./permission-runtime.js";

/** A capability's resolved hooks paired with its source pluginId. */
export interface PluginHookCapability {
  pluginId: string;
  hooks: HookConfig;
}

/** Shape required by AgentOptions.hooks entries. */
type AgentHookEntry = {
  matcher?: string;
  hooks: Array<(input: HookInput, toolUseId: string, context: { signal: AbortSignal }) => Promise<unknown>>;
  timeout?: number;
};

/** Spawns a shell-command hook. Replicates SDK executeShellHook (which is private). */
export type ShellHookSpawner = (
  command: string,
  input: HookInput,
  timeout: number,
  signal: AbortSignal,
) => Promise<HookOutput | undefined>;

/**
 * Default shell-hook spawner: spawn `bash -c <command>`, JSON on stdin, HOOK_* env vars,
 * parse stdout as HookOutput (non-JSON → {message}). Mirrors packages/sdk/src/hooks.ts:307-377.
 */
export const defaultShellHookSpawner: ShellHookSpawner = (command, input, timeout, signal) => {
  return new Promise((resolve) => {
    const proc = spawn("bash", ["-c", command], {
      timeout,
      env: {
        ...process.env,
        HOOK_EVENT: input.event,
        HOOK_TOOL_NAME: input.toolName || "",
        HOOK_SESSION_ID: input.sessionId || "",
        HOOK_CWD: input.cwd || "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    proc.stdin?.write(JSON.stringify(input));
    proc.stdin?.end();

    const chunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    proc.stdout?.on("data", (d: Buffer) => chunks.push(d));
    proc.stderr?.on("data", (d: Buffer) => stderrChunks.push(d));

    const onAbort = () => proc.kill();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    proc.on("close", () => {
      if (signal) signal.removeEventListener("abort", onAbort);
      const stdout = Buffer.concat(chunks).toString("utf-8").trim();
      const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();
      const renderedOutput = [stdout, stderr].filter(Boolean).join("\n").trim();
      try {
        resolve(stdout ? (JSON.parse(stdout) as HookOutput) : undefined);
      } catch {
        resolve(renderedOutput ? { message: renderedOutput } : undefined);
      }
    });
    proc.on("error", () => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(undefined);
    });
  });
};

export interface BuildPluginAgentHooksInput {
  capabilities: PluginHookCapability[];
  runtime: PluginPermissionRuntime;
  workspaceSlug?: string;
  spawner?: ShellHookSpawner;
}

/**
 * Convert resolved plugin HookConfigs → AgentOptions.hooks shape (design spec §6.4).
 *
 * Shell-command hooks (the §8.1 sensitive case) are wrapped in a gate-aware handler
 * that closes over pluginId + event + matcher, calls checkSensitiveCapability with
 * `hook:${event}:${matcher||'*'}`, and only spawns (via `spawner`, default
 * defaultShellHookSpawner) when allow-ed. ask/deny → no spawn + warn-log (Phase 2
 * ask→block; the hook simply does not fire). handler-type hooks pass through wrapped
 * to the (input, toolUseId, {signal}) signature, ungated (rare; not shell subprocesses).
 *
 * Pure given the runtime + spawner (both injectable for tests).
 */
export function buildPluginAgentHooks(input: BuildPluginAgentHooksInput): Record<string, AgentHookEntry[]> {
  const spawner = input.spawner ?? defaultShellHookSpawner;
  const result: Record<string, AgentHookEntry[]> = {};

  for (const capability of input.capabilities) {
    for (const [event, definitions] of Object.entries(capability.hooks)) {
      if (!Array.isArray(definitions)) continue;
      for (const def of definitions) {
        const entry = convertHookDefinition({
          def,
          event,
          pluginId: capability.pluginId,
          runtime: input.runtime,
          workspaceSlug: input.workspaceSlug,
          spawner,
        });
        if (!entry) continue;
        (result[event] ??= []).push(entry);
      }
    }
  }

  return result;
}

function convertHookDefinition(args: {
  def: HookDefinition;
  event: string;
  pluginId: string;
  runtime: PluginPermissionRuntime;
  workspaceSlug?: string;
  spawner: ShellHookSpawner;
}): AgentHookEntry | null {
  const { def, event, pluginId, runtime, workspaceSlug, spawner } = args;

  if (def.handler) {
    // handler-type hook: wrap to the (input, toolUseId, {signal}) signature, ungated.
    const handler = def.handler;
    return {
      ...(def.matcher !== undefined ? { matcher: def.matcher } : {}),
      ...(def.timeout !== undefined ? { timeout: def.timeout } : {}),
      hooks: [async (hookInput) => handler(hookInput)],
    };
  }

  if (def.command) {
    const command = def.command;
    const matcher = def.matcher;
    const key = `hook:${event}:${matcher || "*"}` as SensitiveCapabilityKey;
    const timeout = def.timeout ?? 30_000;
    return {
      ...(matcher !== undefined ? { matcher } : {}),
      ...(def.timeout !== undefined ? { timeout: def.timeout } : {}),
      hooks: [
        async (hookInput, _toolUseId, ctx) => {
          const decision = await runtime.checkSensitiveCapability({ pluginId, key, workspaceSlug });
          if (decision.decision !== "allow") {
            // §8.1/§8.2: shell command hook gated (ask→block per Phase 2). Do NOT spawn.
            console.warn(
              `[plugin:hooks] Plugin ${pluginId} hook ${key} not fired (sensitive, ${decision.decision}): ${decision.reason}`,
            );
            return undefined;
          }
          return spawner(command, hookInput, timeout, ctx.signal);
        },
      ],
    };
  }

  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/plugin-hooks-bridge.test.ts`
Expected: PASS — all 5 tests pass.

- [ ] **Step 5: Export from the barrel**

In `apps/sidecar/src/services/agent-runtime/plugins/index.ts`, add:

```ts
export { buildPluginAgentHooks, defaultShellHookSpawner } from "./plugin-hooks-bridge.js";
export type { PluginHookCapability, ShellHookSpawner, BuildPluginAgentHooksInput } from "./plugin-hooks-bridge.js";
```

- [ ] **Step 6: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/plugins/plugin-hooks-bridge.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-hooks-bridge.test.ts apps/sidecar/src/services/agent-runtime/plugins/index.ts
git commit -m "✨ feat(sidecar): 新增 buildPluginAgentHooks（hook 转换 + shell hook sensitive gate）"
```

---

## Chunk 3: Wire `agentOptions.hooks` in `createRuntimeCoreSession`

Construct a `PluginPermissionRuntime`, call `buildPluginAgentHooks`, set `agentOptions.hooks`. Plugin hooks now reach the SDK's `HookRegistry` via the host-hooks path.

### Task 3: Set `agentOptions.hooks` in `run.ts`

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts`

- [ ] **Step 1: READ the current code**

Read `run.ts` top imports, the `assemblePluginRuntime` call site (~line 912), the `agentOptions` literal (~line 1028-1071). Confirm exact text. Note: `PluginPermissionRuntime` + `FilePluginStateStore` + `buildPluginAgentHooks` need importing; `homedir`/`join` are already imported (Phase 3b/3c use them).

- [ ] **Step 2: Add imports**

At the top of `run.ts`, add (near the existing `../plugins/...` imports — `SidecarPluginManager`/`assemblePluginRuntime` are already imported there):

```ts
import { PluginPermissionRuntime } from "../plugins/permission-runtime.js";
import { FilePluginStateStore } from "../plugins/plugin-state-store.js";
import { buildPluginAgentHooks } from "../plugins/plugin-hooks-bridge.js";
```

(If the existing imports use the barrel `../plugins/index.js`, prefer that path for consistency.)

- [ ] **Step 3: Construct the runtime + build hooks; set `agentOptions.hooks`**

After the existing `const pluginAssembly = await assemblePluginRuntime(registeredPlugins);` (~line 912), add:

```ts
  // Phase 3d: build agentOptions.hooks from resolved plugin hooks. Shell-command hooks
  // are gate-aware (§8.1): checkSensitiveCapability(hook:event:matcher) before spawn.
  const hookPermissionRuntime = new PluginPermissionRuntime({
    stateStore: new FilePluginStateStore(join(homedir(), ".lume", "plugins-state.json")),
  });
  const pluginAgentHooks = buildPluginAgentHooks({
    capabilities: pluginAssembly.hooks,
    runtime: hookPermissionRuntime,
    workspaceSlug: input.workspaceSlug,
  });
```

Then in the `agentOptions` literal (~line 1028-1071), add a `hooks` field (set only when non-empty, to avoid overriding SDK defaults):

```ts
    ...(Object.keys(pluginAgentHooks).length > 0 ? { hooks: pluginAgentHooks } : {}),
```

(Place it among the other `agentOptions` fields. Read the actual literal to match formatting. `Object.keys(...).length > 0` guards against passing an empty object — though an empty `hooks: {}` is harmless, the guard keeps the agentOptions clean when no plugin declares hooks.)

- [ ] **Step 4: Verify typecheck + regression**

Run:
```bash
cd apps/sidecar && bun x tsc --noEmit 2>&1 | grep "run.ts" | head
```
Expected: no NEW `run.ts` errors.

Then run:
```bash
rtk bun test apps/sidecar/src/services/agent-runtime/plugins/ apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts apps/sidecar/src/services/agent-runtime/tools/tool-runtime.test.ts apps/sidecar/src/rpc/agent-handlers.list-plugins.test.ts
```
Expected: ALL PASS, 0 FAIL. **The existing `应从 Lume plugin 目录加载命令型插件工具` test (run.test.ts:502) still passes** (it declares no hooks). **The Phase 3c sensitive-gate integration test still passes** (gate unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/runtime-core/run.ts
git commit -m "✨ feat(sidecar): createRuntimeCoreSession 注入 agentOptions.hooks（plugin hooks 接入）"
```

---

## Chunk 4: Integration test + regression + boundary

Prove a plugin shell hook actually fires (when allow-ed) and is gated (when denied), then full regression + boundary.

### Task 4: Integration test — plugin shell hook fires when allow-ed, gated when not

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/plugin-hooks-bridge.test.ts`

- [ ] **Step 1: Write the integration test**

Append to `plugin-hooks-bridge.test.ts` (this one uses the REAL `defaultShellHookSpawner` against an `echo` command, proving the spawn path works end-to-end):

```ts
import { defaultShellHookSpawner } from "./plugin-hooks-bridge.js";

describe("buildPluginAgentHooks — real spawner integration", () => {
  test("allow-ed shell hook spawns and returns parsed output", async () => {
    const result = buildPluginAgentHooks({
      capabilities: [
        { pluginId: "acme", hooks: { Stop: [{ command: "echo '{\"message\":\"hook ran\"}'" }] } },
      ],
      runtime: fakeRuntime("allow"),
      workspaceSlug: "ws",
      spawner: defaultShellHookSpawner,
    });

    const out = await result.Stop[0]!.hooks[0]!(
      { event: "Stop" },
      "",
      { signal: new AbortController().signal },
    ) as HookOutput | undefined;
    expect(out?.message).toBe("hook ran");
  });

  test("allow-ed shell hook with non-JSON output returns {message}", async () => {
    const result = buildPluginAgentHooks({
      capabilities: [
        { pluginId: "acme", hooks: { Stop: [{ command: "echo plain text" }] } },
      ],
      runtime: fakeRuntime("allow"),
      workspaceSlug: "ws",
      spawner: defaultShellHookSpawner,
    });

    const out = await result.Stop[0]!.hooks[0]!(
      { event: "Stop" },
      "",
      { signal: new AbortController().signal },
    ) as HookOutput | undefined;
    expect(out?.message).toBe("plain text");
  });
});
```

- [ ] **Step 2: Run + commit**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/plugin-hooks-bridge.test.ts`
Expected: PASS (all 7 tests).

```bash
git add apps/sidecar/src/services/agent-runtime/plugins/plugin-hooks-bridge.test.ts
git commit -m "✅ test(sidecar): 集成测试验证 plugin shell hook spawn + gate"
```

### Task 5: Full regression + boundary

**Files:** none (verification only)

- [ ] **Step 1: Full Phase 1+2+3a+3b+3c+3d-hooks regression**

```bash
rtk bun test packages/sdk/src/plugins/ apps/sidecar/src/services/agent-runtime/plugins/ apps/sidecar/src/services/agent-runtime/tools/tool-runtime.test.ts apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts apps/sidecar/src/rpc/agent-handlers.list-plugins.test.ts
```
Expected: ALL PASS, 0 FAIL. Pre-3d-hooks baseline was 150; 3d-hooks adds ~7 (plugin-hooks-bridge ×7). Any prior-phase failure = regression → STOP.

- [ ] **Step 2: Boundary**

Phase 3d-hooks base = the commit before Task 1. 3d-hooks must NOT touch `attempt.ts`, `sensitive-gate.ts`, `permission-runtime.ts`, `permission-interceptor.ts`, `plugin-registry.ts`, `workspace-mcp-manager.ts`, `agent.ts`, `hooks.ts`:

```bash
git diff --name-only <3d-hooks-base>..HEAD -- apps/sidecar/src/services/agent-runtime/runtime-core/attempt.ts apps/sidecar/src/services/agent-runtime/plugins/sensitive-gate.ts apps/sidecar/src/services/agent-runtime/plugins/permission-runtime.ts apps/sidecar/src/services/agent-runtime/plugins/permission-interceptor.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.ts apps/sidecar/src/services/mcp/workspace-mcp-manager.ts packages/sdk/src/agent.ts packages/sdk/src/hooks.ts
```
Expected: EMPTY.

Then the 3d-hooks change set:
```bash
git diff --name-only <3d-hooks-base>..HEAD
```
Expected: `runtime-bridge.ts`, `runtime-bridge.test.ts`, `plugin-hooks-bridge.ts` (new), `plugin-hooks-bridge.test.ts` (new), `plugins/index.ts`, `run.ts`, + this plan doc.

- [ ] **Step 3: Commit final state (only if unstaged)**

If only `docs/superpowers/handoffs/`/`__pycache__` untracked, skip. Otherwise `✅ test(sidecar): Phase 3d-hooks 回归与边界校验`.

---

## Notes for the executing agent

- **Run every command from the worktree root** `/Users/cavinhuang/.config/superpowers/worktrees/Lume/codex-plugin-platform-phase1`.
- **Task 1 test fixture**: if writing to `/plugins/acme` is problematic in the test env, use `mkdtemp` for the plugin root and put `hooks.json` there (match the pattern `runtime-bridge.test.ts` already uses for plugin roots — read it first).
- **`run.ts` is central.** Task 3 is the risky step. READ the actual `agentOptions` literal before editing. The `hooks` field must be added as a spread-conditional to avoid passing an empty object (harmless but clean).
- **`defaultShellHookSpawner` replicates SDK private `executeShellHook`.** Match its spawn/stdin/stdout/HookOutput-parse behavior (hooks.ts:307-377). Do NOT import the SDK's private function.
- **Gate-block returns `undefined`** (hook doesn't fire) + `console.warn` — NOT `HookOutput.block` (that's for PreToolUse tool-blocking, not spawn prevention).
- **Do not "improve" adjacent code.** Per `CLAUDE.md` §3, only touch the named files. `attempt.ts`/`sensitive-gate.ts`/`hooks.ts`/`agent.ts` stay untouched.
- **RTK prefix.** `rtk bun test ...` / `bun x tsc ...`; plain `bun` as fallback.
