# Lume Plugin Platform Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Phase 2 of the plugin platform: a permission foundation — `permissionsHash` computation, a source-bound permission gate (hard deny / needs-review / sensitive default-block), and registry integration that surfaces effective runtime permission state — without yet wiring capabilities into the agent runtime.

**Architecture:** SDK owns the pure logic — `computePermissionsHash()` (deterministic SHA-256 over a canonical permission/capability summary) and the permission-gate decision functions (`resolveSensitiveApproval`, `isHardDeniedTool`, `computeEffectiveRuntimeState`). Sidecar owns `PluginPermissionRuntime`, which combines those SDK decisions with the file-backed plugin state store (`approvalsByHash`, `sensitiveApprovals`), and the registry, which attaches effective permission state + `needs-review` diagnostics to each listed plugin. Capability loading, MCP startup, hook registration, audit log, and permission UI remain out of scope (Phase 3 / Phase 4).

**Tech Stack:** TypeScript, Bun test, existing `@lume/agent-sdk` plugin exports (`NormalizedPlugin`, `PluginPermissions`), existing Sidecar `FilePluginStateStore` / `PluginRegistry` from Phase 1.

---

## Scope

Implements only Phase 2 from [the approved design spec](../specs/2026-06-13-lume-plugin-platform-design.md) §14.2:

- All plugin capability contributions carry `pluginId` and `version` (source-binding skeleton).
- New `PluginPermissionRuntime` source-binding skeleton.
- Hard deny, `needs-review` skip, and `permissionsHash` verification.
- Sensitive capabilities default-block (produce a diagnostic) until first-confirmation UI exists (Phase 4).

**Out of scope (deferred):**

- Runtime capability loading / `PluginCapabilityResolver` / `PluginRuntimeBridge` (Phase 3).
- First-run sensitive confirmation UI and audit log coverage (Phase 4).
- Market backend and market UI (Phase 5 / Phase 6).
- End-to-end enforcement against the live agent tool pool — Phase 2 validates the gate decision logic via unit tests; the capability resolver in Phase 3 is what calls the gate during real tool/MCP/hook loading.

**Constraints:**

- Do not start MCP servers, register hooks, or expose command tools — Phase 2 adds no runtime behavior change beyond Phase 1 (re-verify with the Phase 1 Chunk 4 boundary check).
- Do not broaden the pre-existing sidecar/web typecheck failures (office/cron/IM/routine/permission-interceptor/skill-market) into Phase 2 scope.
- Keep using the isolated worktree `codex/plugin-platform-phase1`.

## Design Decisions

1. **`permissionsHash` input (Phase 2 vs spec §16.4).** Spec §16.4 hashes "sorted resolved execution config" including the *contents* of hook/MCP config files. Phase 1's `NormalizedPlugin.capabilities` only stores `hooksConfigPath` / `mcpServersConfigPath` (paths), not resolved contents — resolution arrives with `PluginCapabilityResolver` in Phase 3. So Phase 2's hash covers everything already resolved in `NormalizedPlugin` (command tools' execution config, permissions, skill roots, hook/mcp config *paths*) and is documented as expanding in Phase 3. Command tools are fully resolved in Phase 1, so they contribute their full execution config.
2. **Gate logic location.** Pure decision functions live in SDK (`permission-gate.ts`), mirroring the existing `packages/sdk/src/plugins/permissions.ts` pattern. Sidecar's `PluginPermissionRuntime` is a thin composition layer that reads state and delegates to SDK functions.
3. **Sensitive default-block.** In Phase 2, `resolveSensitiveApproval` returns `"ask"` when there is no prior approval. The runtime treats `"ask"` as **block + emit a `permission_review_required` diagnostic** (no confirmation UI exists yet). Phase 4 replaces block-on-ask with an interactive prompt.

## File Structure

SDK (pure logic, fully unit-testable):

- Create `packages/sdk/src/plugins/permissions-hash.ts` — `computePermissionsHash(plugin)` + canonical summary helpers.
- Create `packages/sdk/src/plugins/permissions-hash.test.ts` — determinism, version-exclusion, order-independence, change-detection.
- Create `packages/sdk/src/plugins/permission-gate.ts` — `SensitiveCapabilityKey`, `SensitiveApprovalRecord`, `resolveSensitiveApproval`, `isHardDeniedTool`, `computeEffectiveRuntimeState`.
- Create `packages/sdk/src/plugins/permission-gate.test.ts` — approval resolution priority, hard-deny, effective-state table.
- Modify `packages/sdk/src/index.ts` — export the new types/functions.

Sidecar (state + composition):

- Create `apps/sidecar/src/services/agent-runtime/plugins/permission-runtime.ts` — `PluginPermissionRuntime` class combining SDK gate + `FilePluginStateStore`.
- Create `apps/sidecar/src/services/agent-runtime/plugins/permission-runtime.test.ts` — state-backed sensitive checks + runtime-state computation.
- Modify `apps/sidecar/src/services/agent-runtime/plugins/plugin-state-store.ts` — tighten `source` and `sensitiveApprovals` from `unknown` to typed shapes (`SensitiveApprovalRecord[]`).
- Modify `apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.ts` — attach effective permission state + `needs-review` diagnostics to listed plugins via the new runtime.

---

## Chunk 1: SDK permissionsHash computation

### Task 1: Add permissionsHash contract tests

**Files:**
- Create: `packages/sdk/src/plugins/permissions-hash.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/sdk/src/plugins/permissions-hash.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { computePermissionsHash } from "./permissions-hash.js";
import type { NormalizedPlugin } from "./normalized.js";

function basePlugin(overrides: Partial<NormalizedPlugin> = {}): NormalizedPlugin {
  return {
    pluginId: "acme",
    name: "acme",
    version: "1.0.0",
    root: "/plugins/acme",
    manifestFormat: "lume",
    capabilities: { skills: [], commandTools: [] },
    permissions: {},
    diagnostics: [],
    ...overrides,
  };
}

describe("computePermissionsHash", () => {
  test("is deterministic for identical plugins and is a sha256 hex", () => {
    const a = computePermissionsHash(basePlugin());
    const b = computePermissionsHash(basePlugin());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test("excludes version: a pure version bump keeps the hash", () => {
    const v1 = computePermissionsHash(basePlugin({ version: "1.0.0" }));
    const v2 = computePermissionsHash(basePlugin({ version: "2.0.0" }));
    expect(v1).toBe(v2);
  });

  test("excludes installation root and diagnostics", () => {
    const a = computePermissionsHash(basePlugin({ root: "/plugins/acme" }));
    const b = computePermissionsHash(
      basePlugin({
        root: "/elsewhere/acme",
        diagnostics: [{ severity: "info", code: "legacy_manifest", message: "x" }],
      }),
    );
    expect(a).toBe(b);
  });

  test("changes when permissions change", () => {
    const before = computePermissionsHash(basePlugin());
    const after = computePermissionsHash(
      basePlugin({ permissions: { tools: { deny: ["Bash"] } } }),
    );
    expect(before).not.toBe(after);
  });

  test("is order-independent for permission tool lists", () => {
    const denyAB = basePlugin({ permissions: { tools: { deny: ["Bash", "FileWrite"] } } });
    const denyBA = basePlugin({ permissions: { tools: { deny: ["FileWrite", "Bash"] } } });
    expect(computePermissionsHash(denyAB)).toBe(computePermissionsHash(denyBA));
  });

  test("is order-independent for skill roots and command tool names", () => {
    const orderedAB = basePlugin({
      capabilities: {
        skills: [
          { pluginId: "acme", version: "1.0.0", root: "/a" },
          { pluginId: "acme", version: "1.0.0", root: "/b" },
        ],
        commandTools: [
          { name: "zeta", command: "node" },
          { name: "alpha", command: "node" },
        ],
      },
    });
    const orderedBA = basePlugin({
      capabilities: {
        skills: [
          { pluginId: "acme", version: "1.0.0", root: "/b" },
          { pluginId: "acme", version: "1.0.0", root: "/a" },
        ],
        commandTools: [
          { name: "alpha", command: "node" },
          { name: "zeta", command: "node" },
        ],
      },
    });
    expect(computePermissionsHash(orderedAB)).toBe(computePermissionsHash(orderedBA));
  });

  test("changes when a command tool's command changes", () => {
    const before = computePermissionsHash(
      basePlugin({ capabilities: { skills: [], commandTools: [{ name: "echo", command: "node" }] } }),
    );
    const after = computePermissionsHash(
      basePlugin({ capabilities: { skills: [], commandTools: [{ name: "echo", command: "python" }] } }),
    );
    expect(before).not.toBe(after);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk bun test packages/sdk/src/plugins/permissions-hash.test.ts`
Expected: FAIL with `Cannot find module "./permissions-hash.js"`.

### Task 2: Implement computePermissionsHash

**Files:**
- Create: `packages/sdk/src/plugins/permissions-hash.ts`

- [ ] **Step 1: Write the implementation**

Create `packages/sdk/src/plugins/permissions-hash.ts`:

```ts
import { createHash } from "node:crypto";
import type { NormalizedPlugin } from "./normalized.js";

/**
 * Deterministic SHA-256 hash of a plugin's permission-relevant summary.
 *
 * Per design spec §16.4 the hash is canonical JSON of:
 *   - pluginId
 *   - manifestFormat
 *   - normalized permissions
 *   - sorted capability summary: skill roots, hook/mcp config paths,
 *     command tool names + execution config
 *
 * The hash EXCLUDES version, installation root, diagnostics, timestamps, and
 * enablement state. A pure version bump that keeps permissions/capabilities
 * unchanged may reuse a previous approval.
 *
 * Phase 2 scope: hooks/mcp contribute their config PATH only (resolved file
 * contents arrive with PluginCapabilityResolver in Phase 3, at which point the
 * summary input expands). Command tools are already fully resolved in
 * NormalizedPlugin, so they contribute their full execution config.
 */
export function computePermissionsHash(plugin: NormalizedPlugin): string {
  return createHash("sha256").update(stableStringify(canonicalSummary(plugin))).digest("hex");
}

interface PermissionSummary {
  pluginId: string;
  manifestFormat: string;
  permissions: unknown;
  capabilities: {
    skills: string[];
    hooksConfigPath: string | null;
    mcpServersConfigPath: string | null;
    commandTools: Array<Record<string, unknown>>;
  };
}

function canonicalSummary(plugin: NormalizedPlugin): PermissionSummary {
  const commandTools = [...plugin.capabilities.commandTools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((tool) => ({
      name: tool.name,
      command: tool.command,
      args: tool.args ?? null,
      cwd: tool.cwd ?? null,
      timeoutMs: tool.timeoutMs ?? null,
      envKeys: tool.env ? Object.keys(tool.env).sort() : [],
      inputSchema: tool.inputSchema ?? null,
    }));

  return {
    pluginId: plugin.pluginId,
    manifestFormat: plugin.manifestFormat,
    permissions: plugin.permissions,
    capabilities: {
      skills: [...plugin.capabilities.skills]
        .sort((a, b) => a.root.localeCompare(b.root))
        .map((skill) => skill.root),
      hooksConfigPath: plugin.capabilities.hooksConfigPath ?? null,
      mcpServersConfigPath: plugin.capabilities.mcpServersConfigPath ?? null,
      commandTools,
    },
  };
}

/**
 * Recursively canonicalize a value for stable serialization:
 *   - object keys sorted ascending
 *   - arrays of strings sorted
 *   - arrays of non-strings canonicalized element-wise, order preserved
 *     (execution-relevant arrays like command args keep their order; command
 *     tools themselves are pre-sorted by name in canonicalSummary).
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string")) {
      return [...value].sort();
    }
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** Stable JSON string: keys pre-sorted by canonicalize, output is deterministic. */
function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `rtk bun test packages/sdk/src/plugins/permissions-hash.test.ts`
Expected: PASS, 7 tests.

### Task 3: Export from SDK index and commit

**Files:**
- Modify: `packages/sdk/src/index.ts` (after the existing `normalized.js` export block around line 211)

- [ ] **Step 1: Add the export**

In `packages/sdk/src/index.ts`, add a new export block immediately after the existing `normalized.js` export block:

```ts
export {
  computePermissionsHash,
} from './plugins/permissions-hash.js'
```

- [ ] **Step 2: Verify typecheck and tests**

Run: `rtk bun run --filter @lume/agent-sdk build`
Expected: exit 0 (tsc compiles). If the SDK has no `build`-dependent typecheck, run `rtk bun test packages/sdk/src/plugins/permissions-hash.test.ts` again to confirm still green.

- [ ] **Step 3: Commit**

```bash
git add packages/sdk/src/plugins/permissions-hash.ts packages/sdk/src/plugins/permissions-hash.test.ts packages/sdk/src/index.ts
git commit -m "✨ feat(sdk): 新增插件 permissionsHash 计算" \
  -m "computePermissionsHash 基于 normalized permissions + capability summary 生成确定性 sha256，排除 version/path/diagnostics/timestamps，供 Phase 2 权限门判定 needs-review。" \
  -m "Tested: bun test permissions-hash.test.ts (7 pass)"
```

---

## Chunk 2: SDK permission-gate decision functions

### Task 4: Add permission-gate contract tests

**Files:**
- Create: `packages/sdk/src/plugins/permission-gate.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/sdk/src/plugins/permission-gate.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  computeEffectiveRuntimeState,
  isHardDeniedTool,
  resolveSensitiveApproval,
  type SensitiveApprovalRecord,
} from "./permission-gate.js";

function record(
  key: SensitiveApprovalRecord["key"],
  partial: Partial<SensitiveApprovalRecord>,
): SensitiveApprovalRecord {
  return {
    key,
    scope: "global",
    decision: "allow",
    createdAt: "2026-01-01T00:00:00Z",
    permissionsHash: "h",
    ...partial,
  };
}

describe("resolveSensitiveApproval", () => {
  const key = "commandTool:echo" as const;

  test("returns ask when no prior record exists", () => {
    expect(resolveSensitiveApproval(key, [], { workspaceSlug: "ws" })).toBe("ask");
  });

  test("workspace deny beats workspace allow", () => {
    const records = [
      record(key, { scope: "workspace", workspaceSlug: "ws", decision: "allow" }),
      record(key, { scope: "workspace", workspaceSlug: "ws", decision: "deny" }),
    ];
    expect(resolveSensitiveApproval(key, records, { workspaceSlug: "ws" })).toBe("deny");
  });

  test("workspace allow beats global deny", () => {
    const records = [
      record(key, { scope: "global", decision: "deny" }),
      record(key, { scope: "workspace", workspaceSlug: "ws", decision: "allow" }),
    ];
    expect(resolveSensitiveApproval(key, records, { workspaceSlug: "ws" })).toBe("allow");
  });

  test("global deny beats global allow", () => {
    const records = [
      record(key, { scope: "global", decision: "allow" }),
      record(key, { scope: "global", decision: "deny" }),
    ];
    expect(resolveSensitiveApproval(key, records, { workspaceSlug: "ws" })).toBe("deny");
  });

  test("workspace record for a different workspace is ignored", () => {
    const records = [record(key, { scope: "workspace", workspaceSlug: "other", decision: "deny" })];
    expect(resolveSensitiveApproval(key, records, { workspaceSlug: "ws" })).toBe("ask");
  });
});

describe("isHardDeniedTool", () => {
  test("returns true for a tool in permissions.tools.deny", () => {
    expect(isHardDeniedTool({ tools: { deny: ["Bash"] } }, "Bash")).toBe(true);
  });

  test("returns false when deny list is absent or does not contain the tool", () => {
    expect(isHardDeniedTool({}, "Bash")).toBe(false);
    expect(isHardDeniedTool({ tools: { deny: ["FileWrite"] } }, "Bash")).toBe(false);
  });
});

describe("computeEffectiveRuntimeState", () => {
  test("no review state => not-loaded", () => {
    expect(
      computeEffectiveRuntimeState({ hasReviewState: false, enabled: true, currentHash: "h" }),
    ).toEqual({ state: "not-loaded", reason: "no-review-state" });
  });

  test("reviewed but disabled => not-loaded", () => {
    expect(
      computeEffectiveRuntimeState({ hasReviewState: true, enabled: false, currentHash: "h" }),
    ).toEqual({ state: "not-loaded", reason: "disabled" });
  });

  test("enabled + accepted hash matches => loaded", () => {
    expect(
      computeEffectiveRuntimeState({
        hasReviewState: true,
        enabled: true,
        acceptedHash: "h",
        currentHash: "h",
      }),
    ).toEqual({ state: "loaded", reason: "loaded" });
  });

  test("enabled + hash mismatch => needs-review", () => {
    expect(
      computeEffectiveRuntimeState({
        hasReviewState: true,
        enabled: true,
        acceptedHash: "old",
        currentHash: "new",
      }),
    ).toEqual({ state: "needs-review", reason: "hash-mismatch" });
  });

  test("enabled + no accepted hash => needs-review", () => {
    expect(
      computeEffectiveRuntimeState({ hasReviewState: true, enabled: true, currentHash: "h" }),
    ).toEqual({ state: "needs-review", reason: "hash-mismatch" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk bun test packages/sdk/src/plugins/permission-gate.test.ts`
Expected: FAIL with `Cannot find module "./permission-gate.js"`.

### Task 5: Implement permission-gate decision functions

**Files:**
- Create: `packages/sdk/src/plugins/permission-gate.ts`

- [ ] **Step 1: Write the implementation**

Create `packages/sdk/src/plugins/permission-gate.ts`:

```ts
import type { PluginPermissions } from "./manifest.js";

/**
 * Deterministic key for a sensitive capability requiring first-run approval.
 * See design spec §16.4.
 */
export type SensitiveCapabilityKey =
  | `commandTool:${string}`
  | `mcpServer:${string}`
  | `hook:${string}:${string}`
  | `network:${string}`
  | `filesystem:write:${string}`
  | `tool:${string}`;

/**
 * A recorded approval/denial for a sensitive capability key.
 * Stored in PluginInstallRecord.sensitiveApprovals (Phase 2 tightens the store
 * type to use this shape).
 */
export interface SensitiveApprovalRecord {
  key: SensitiveCapabilityKey;
  scope: "global" | "workspace";
  workspaceSlug?: string;
  decision: "allow" | "deny";
  createdAt: string;
  permissionsHash: string;
}

export type SensitiveDecision = "allow" | "deny" | "ask";

/**
 * Resolve a sensitive capability against prior approval records per spec §16.4.
 *
 * Priority: workspace deny > workspace allow > global deny > global allow > ask.
 * Workspace records only match when workspaceSlug equals the record's workspaceSlug.
 */
export function resolveSensitiveApproval(
  key: SensitiveCapabilityKey,
  records: SensitiveApprovalRecord[],
  context: { workspaceSlug?: string },
): SensitiveDecision {
  const workspaceSlug = context.workspaceSlug;

  const workspaceDeny = records.find(
    (r) =>
      r.key === key &&
      r.scope === "workspace" &&
      r.workspaceSlug === workspaceSlug &&
      r.decision === "deny",
  );
  if (workspaceDeny) return "deny";

  const workspaceAllow = records.find(
    (r) =>
      r.key === key &&
      r.scope === "workspace" &&
      r.workspaceSlug === workspaceSlug &&
      r.decision === "allow",
  );
  if (workspaceAllow) return "allow";

  const globalDeny = records.find((r) => r.key === key && r.scope === "global" && r.decision === "deny");
  if (globalDeny) return "deny";

  const globalAllow = records.find((r) => r.key === key && r.scope === "global" && r.decision === "allow");
  if (globalAllow) return "allow";

  return "ask";
}

/**
 * Hard-deny check for manifest-declared `permissions.tools.deny`.
 * Hard deny cannot be overridden by bypassPermissions (enforced by callers,
 * spec §8.2). A tool on the deny list is blocked unconditionally.
 */
export function isHardDeniedTool(permissions: PluginPermissions, toolName: string): boolean {
  const deny = permissions.tools?.deny ?? [];
  return deny.includes(toolName);
}

export type EffectiveRuntimeState = "loaded" | "needs-review" | "not-loaded";

export interface EffectiveRuntimeStateInput {
  /** An install record or reviewed external state exists for this plugin. */
  hasReviewState: boolean;
  /** Effective config (global + workspace) enables this plugin. */
  enabled: boolean;
  /** Accepted permissions hash, if any (from approvalsByHash / version / external). */
  acceptedHash?: string;
  /** Current permissions hash of the on-disk plugin (computePermissionsHash). */
  currentHash: string;
}

/**
 * Compute the effective runtime load state per spec §16.5 table.
 * Phase 2 uses this to label each listed plugin; Phase 3's capability resolver
 * gates actual loading on `state === "loaded"`.
 */
export function computeEffectiveRuntimeState(
  input: EffectiveRuntimeStateInput,
): { state: EffectiveRuntimeState; reason: "no-review-state" | "disabled" | "loaded" | "hash-mismatch" } {
  if (!input.hasReviewState) {
    return { state: "not-loaded", reason: "no-review-state" };
  }
  if (!input.enabled) {
    return { state: "not-loaded", reason: "disabled" };
  }
  if (input.acceptedHash !== undefined && input.acceptedHash === input.currentHash) {
    return { state: "loaded", reason: "loaded" };
  }
  return { state: "needs-review", reason: "hash-mismatch" };
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `rtk bun test packages/sdk/src/plugins/permission-gate.test.ts`
Expected: PASS, 12 tests.

### Task 6: Export from SDK index and commit

**Files:**
- Modify: `packages/sdk/src/index.ts` (add after the `permissions-hash.js` export added in Task 3)

- [ ] **Step 1: Add the export**

In `packages/sdk/src/index.ts`, add after the `permissions-hash.js` export block:

```ts
export {
  resolveSensitiveApproval,
  isHardDeniedTool,
  computeEffectiveRuntimeState,
  type SensitiveCapabilityKey,
  type SensitiveApprovalRecord,
  type SensitiveDecision,
  type EffectiveRuntimeState,
  type EffectiveRuntimeStateInput,
} from './plugins/permission-gate.js'
```

- [ ] **Step 2: Verify build and tests**

Run: `rtk bun run --filter @lume/agent-sdk build`
Expected: exit 0. Then `rtk bun test packages/sdk/src/plugins/permission-gate.test.ts` → PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/sdk/src/plugins/permission-gate.ts packages/sdk/src/plugins/permission-gate.test.ts packages/sdk/src/index.ts
git commit -m "✨ feat(sdk): 新增插件权限门决策纯函数" \
  -m "resolveSensitiveApproval 按 workspace/global 优先级解析敏感能力审批；isHardDeniedTool 检查 tools.deny；computeEffectiveRuntimeState 按 §16.5 表输出 loaded/needs-review/not-loaded。" \
  -m "Tested: bun test permission-gate.test.ts (12 pass)"
```

---

## Chunk 3: Tighten state types + PluginPermissionRuntime (Sidecar)

### Task 7: Tighten sensitiveApprovals types in the state store

Phase 1 left `sensitiveApprovals` as `Record<string, unknown>`. Phase 2 needs them typed as `SensitiveApprovalRecord[]` so `PluginPermissionRuntime` can read them through the SDK gate.

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/plugin-state-store.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.ts` (the `attachState` `?? {}` fallback)

- [ ] **Step 1: Rewrite `plugin-state-store.ts` with typed approvals**

Replace the full contents of `apps/sidecar/src/services/agent-runtime/plugins/plugin-state-store.ts` with:

```ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SensitiveApprovalRecord } from "@lume/agent-sdk";

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
  sensitiveApprovals: SensitiveApprovalRecord[];
}

export interface PluginExternalState {
  sourceKey: string;
  permissionsHash?: string;
  permissionsAcceptedAt?: string;
  sensitiveApprovals: SensitiveApprovalRecord[];
}

export interface PluginApprovalBundle {
  permissionsHash: string;
  permissionsAcceptedAt?: string;
  sensitiveApprovals: SensitiveApprovalRecord[];
}

export class FilePluginStateStore {
  constructor(private readonly path: string) {}

  async read(): Promise<PluginStateFile> {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf-8")) as Partial<PluginStateFile>;
      return { plugins: raw.plugins ?? {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { plugins: {} };
      }
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

- [ ] **Step 2: Fix the `attachState` empty-approval fallback in `plugin-registry.ts`**

In `apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.ts`, inside `attachState()`, change the empty-object fallback to an empty array:

```ts
  const sensitiveApprovals = versionState?.sensitiveApprovals ?? externalState?.sensitiveApprovals ?? [];
```

- [ ] **Step 3: Find and fix any test fixtures that construct `sensitiveApprovals`**

Run: `grep -rn "sensitiveApprovals" apps/sidecar/src/services/agent-runtime/plugins`
For each hit in a `.test.ts` that assigns `sensitiveApprovals: {}` or omits it where a record is constructed, change to `sensitiveApprovals: []` (or add `sensitiveApprovals: []`).

- [ ] **Step 4: Verify existing plugin tests still pass**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/plugin-state-store.test.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.test.ts`
Expected: PASS (same count as Phase 1: 7 tests). If a fixture fails to compile, fix per Step 3.

### Task 8: Add PluginPermissionRuntime contract tests

**Files:**
- Create: `apps/sidecar/src/services/agent-runtime/plugins/permission-runtime.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/sidecar/src/services/agent-runtime/plugins/permission-runtime.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilePluginStateStore, type PluginStateFile } from "./plugin-state-store.js";
import { PluginPermissionRuntime } from "./permission-runtime.js";

async function withRuntime<T>(
  fn: (runtime: PluginPermissionRuntime, store: FilePluginStateStore) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "lume-perm-runtime-"));
  const store = new FilePluginStateStore(join(dir, "state.json"));
  const runtime = new PluginPermissionRuntime({ stateStore: store });
  try {
    return await fn(runtime, store);
  } finally {
    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
  }
}

function stateWith(
  pluginId: string,
  partial: Partial<PluginStateFile["plugins"][string]>,
): PluginStateFile {
  return {
    plugins: {
      [pluginId]: {
        pluginId,
        versions: {},
        approvalsByHash: {},
        ...partial,
      },
    },
  };
}

describe("PluginPermissionRuntime.checkSensitiveCapability", () => {
  test("returns ask when there is no install record", async () => {
    await withRuntime(async (runtime) => {
      const result = await runtime.checkSensitiveCapability({
        pluginId: "ghost",
        key: "commandTool:echo",
      });
      expect(result.decision).toBe("ask");
    });
  });

  test("returns allow when an activeVersion has an allow approval", async () => {
    await withRuntime(async (runtime, store) => {
      await store.write(
        stateWith("acme", {
          activeVersion: "1.0.0",
          versions: {
            "1.0.0": {
              pluginId: "acme",
              version: "1.0.0",
              source: { type: "local", path: "/p" },
              installedRoot: "/p",
              installedAt: "2026-01-01T00:00:00Z",
              permissionsHash: "h",
              sensitiveApprovals: [
                { key: "commandTool:echo", scope: "global", decision: "allow", createdAt: "2026-01-01T00:00:00Z", permissionsHash: "h" },
              ],
            },
          },
        }),
      );
      const result = await runtime.checkSensitiveCapability({
        pluginId: "acme",
        key: "commandTool:echo",
      });
      expect(result.decision).toBe("allow");
    });
  });
});

describe("PluginPermissionRuntime.computeRuntimeState", () => {
  test("not-loaded when no review state exists", async () => {
    await withRuntime(async (runtime) => {
      const result = await runtime.computeRuntimeState({
        pluginId: "ghost",
        enabled: true,
        currentHash: "h",
      });
      expect(result.state).toBe("not-loaded");
    });
  });

  test("loaded when activeVersion hash matches current", async () => {
    await withRuntime(async (runtime, store) => {
      await store.write(
        stateWith("acme", {
          activeVersion: "1.0.0",
          versions: {
            "1.0.0": {
              pluginId: "acme",
              version: "1.0.0",
              source: { type: "local", path: "/p" },
              installedRoot: "/p",
              installedAt: "2026-01-01T00:00:00Z",
              permissionsHash: "h-current",
              sensitiveApprovals: [],
            },
          },
        }),
      );
      const result = await runtime.computeRuntimeState({
        pluginId: "acme",
        enabled: true,
        currentHash: "h-current",
      });
      expect(result.state).toBe("loaded");
    });
  });

  test("needs-review when activeVersion hash differs from current", async () => {
    await withRuntime(async (runtime, store) => {
      await store.write(
        stateWith("acme", {
          activeVersion: "1.0.0",
          versions: {
            "1.0.0": {
              pluginId: "acme",
              version: "1.0.0",
              source: { type: "local", path: "/p" },
              installedRoot: "/p",
              installedAt: "2026-01-01T00:00:00Z",
              permissionsHash: "h-old",
              sensitiveApprovals: [],
            },
          },
        }),
      );
      const result = await runtime.computeRuntimeState({
        pluginId: "acme",
        enabled: true,
        currentHash: "h-new",
      });
      expect(result.state).toBe("needs-review");
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/permission-runtime.test.ts`
Expected: FAIL with `Cannot find module "./permission-runtime.js"`.

### Task 9: Implement PluginPermissionRuntime

**Files:**
- Create: `apps/sidecar/src/services/agent-runtime/plugins/permission-runtime.ts`

- [ ] **Step 1: Write the implementation**

Create `apps/sidecar/src/services/agent-runtime/plugins/permission-runtime.ts`:

```ts
import {
  computeEffectiveRuntimeState,
  resolveSensitiveApproval,
  type SensitiveApprovalRecord,
  type SensitiveCapabilityKey,
} from "@lume/agent-sdk";
import type {
  FilePluginStateStore,
  PluginInstallRecord,
} from "./plugin-state-store.js";

export interface PluginPermissionRuntimeInput {
  stateStore: FilePluginStateStore;
}

export interface SensitiveCheckResult {
  decision: "allow" | "deny" | "ask";
  reason: string;
}

export interface RuntimeStateResult {
  state: "loaded" | "needs-review" | "not-loaded";
  reason: string;
}

/**
 * Source-bound permission gate (design spec §8.2, §14.2 Phase 2 skeleton).
 *
 * Reads plugin approval state from FilePluginStateStore and delegates the pure
 * decision logic to the SDK gate functions. Phase 2 only exposes the decision
 * API and unit-tests it; Phase 3's capability resolver is what calls
 * checkSensitiveCapability / computeRuntimeState during real loading.
 *
 * Source binding: every method is keyed by pluginId, so a plugin's permissions
 * never affect a different plugin's or a plain builtin tool's behavior.
 */
export class PluginPermissionRuntime {
  constructor(private readonly input: PluginPermissionRuntimeInput) {}

  async checkSensitiveCapability(params: {
    pluginId: string;
    key: SensitiveCapabilityKey;
    workspaceSlug?: string;
  }): Promise<SensitiveCheckResult> {
    const record = await this.loadRecord(params.pluginId);
    if (!record) {
      return { decision: "ask", reason: "no install or reviewed external state" };
    }
    const approvals = collectSensitiveApprovals(record);
    const decision = resolveSensitiveApproval(params.key, approvals, {
      workspaceSlug: params.workspaceSlug,
    });
    return {
      decision,
      reason: decision === "ask" ? "no prior approval for this capability" : `prior ${decision}`,
    };
  }

  async computeRuntimeState(params: {
    pluginId: string;
    enabled: boolean;
    currentHash: string;
  }): Promise<RuntimeStateResult> {
    const record = await this.loadRecord(params.pluginId);
    const hasReviewState = record !== undefined && hasAnyReviewState(record);
    const acceptedHash = record ? resolveAcceptedHash(record) : undefined;
    const result = computeEffectiveRuntimeState({
      hasReviewState,
      enabled: params.enabled,
      acceptedHash,
      currentHash: params.currentHash,
    });
    return { state: result.state, reason: result.reason };
  }

  private async loadRecord(pluginId: string): Promise<PluginInstallRecord | undefined> {
    const state = await this.input.stateStore.read();
    return state.plugins[pluginId];
  }
}

function collectSensitiveApprovals(record: PluginInstallRecord): SensitiveApprovalRecord[] {
  const approvals: SensitiveApprovalRecord[] = [];
  if (record.activeVersion) {
    const version = record.versions[record.activeVersion];
    if (version) approvals.push(...version.sensitiveApprovals);
  }
  for (const external of Object.values(record.external ?? {})) {
    approvals.push(...external.sensitiveApprovals);
  }
  for (const bundle of Object.values(record.approvalsByHash)) {
    approvals.push(...bundle.sensitiveApprovals);
  }
  return approvals;
}

function hasAnyReviewState(record: PluginInstallRecord): boolean {
  if (record.activeVersion && record.versions[record.activeVersion]) return true;
  return Object.values(record.external ?? {}).some((e) => e.permissionsAcceptedAt !== undefined);
}

function resolveAcceptedHash(record: PluginInstallRecord): string | undefined {
  if (record.activeVersion) {
    const version = record.versions[record.activeVersion];
    if (version?.permissionsHash) return version.permissionsHash;
  }
  for (const external of Object.values(record.external ?? {})) {
    if (external.permissionsHash) return external.permissionsHash;
  }
  return undefined;
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/permission-runtime.test.ts`
Expected: PASS, 4 tests.

### Task 10: Export PluginPermissionRuntime and commit

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/index.ts`

- [ ] **Step 1: Add the export**

In `apps/sidecar/src/services/agent-runtime/plugins/index.ts`, add:

```ts
export { PluginPermissionRuntime } from "./permission-runtime.js";
export type { PluginPermissionRuntimeInput, SensitiveCheckResult, RuntimeStateResult } from "./permission-runtime.js";
```

- [ ] **Step 2: Verify focused tests + targeted typecheck**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/permission-runtime.test.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-state-store.test.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.test.ts`
Expected: all PASS.

Run: `rtk bun run --filter @lume/sidecar typecheck` — confirm no NEW errors in `permission-runtime.ts`, `plugin-state-store.ts`, `plugin-registry.ts` beyond the pre-existing unrelated set (office/cron/IM/routine/permission-interceptor/skill-market).

- [ ] **Step 3: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/plugins/plugin-state-store.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.ts apps/sidecar/src/services/agent-runtime/plugins/permission-runtime.ts apps/sidecar/src/services/agent-runtime/plugins/permission-runtime.test.ts apps/sidecar/src/services/agent-runtime/plugins/index.ts
git commit -m "✨ feat(sidecar): 新增 PluginPermissionRuntime 权限门骨架" \
  -m "收紧 state store 的 sensitiveApprovals 为 SensitiveApprovalRecord[]；PluginPermissionRuntime 组合 SDK gate 决策与文件状态，按 pluginId 来源绑定，提供 checkSensitiveCapability 与 computeRuntimeState。" \
  -m "Constraint: Phase 2 仅暴露决策 API 与单测，不接入 runtime capability 加载（Phase 3）" \
  -m "Tested: bun test permission-runtime.test.ts (4 pass); plugin-state-store/plugin-registry 回归通过"
```

---

## Chunk 4: Registry permission-state integration

The registry attaches an effective `permissionState` to each listed plugin and emits `needs-review` / `capability_filtered` diagnostics, so callers (and the Phase 4 UI) can see which plugins will not load.

### Task 11: Add registry permission-state tests

**Files:**
- Create: `apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.permission-state.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.permission-state.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computePermissionsHash, normalizePluginManifests } from "@lume/agent-sdk";
import { FilePluginStateStore, type PluginStateFile } from "./plugin-state-store.js";
import { PluginRegistry } from "./plugin-registry.js";

async function writePlugin(root: string, name: string): Promise<string> {
  const pluginRoot = join(root, name);
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(
    join(pluginRoot, "lume-plugin.json"),
    JSON.stringify({ schema: "lume-plugin/v1", name, version: "1.0.0" }),
  );
  return pluginRoot;
}

function currentHashFor(pluginRoot: string, name: string): string {
  const normalized = normalizePluginManifests({
    pluginRoot,
    lumeManifest: { schema: "lume-plugin/v1", name, version: "1.0.0" },
  });
  return computePermissionsHash(normalized);
}

describe("PluginRegistry permission state", () => {
  test("a discovered plugin with no review state is not-loaded with a capability_filtered diagnostic", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-reg-perm-"));
    try {
      await writePlugin(root, "fresh");

      const registry = new PluginRegistry({
        installedRoot: root,
        legacyGlobalRoot: root,
        stateStore: new FilePluginStateStore(join(root, "state.json")),
      });
      const result = await registry.list({ enabled: [], disabled: [], directories: [] });

      const fresh = result.plugins.find((p) => p.pluginId === "fresh");
      expect(fresh?.permissionState?.state).toBe("not-loaded");
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ pluginId: "fresh", code: "capability_filtered" }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a reviewed plugin whose accepted hash matches current is loaded with no permission diagnostic", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-reg-perm-"));
    try {
      const pluginRoot = await writePlugin(root, "reviewed");
      const acceptedHash = currentHashFor(pluginRoot, "reviewed");

      const stateStore = new FilePluginStateStore(join(root, "state.json"));
      const state: PluginStateFile = {
        plugins: {
          reviewed: {
            pluginId: "reviewed",
            activeVersion: "1.0.0",
            versions: {
              "1.0.0": {
                pluginId: "reviewed",
                version: "1.0.0",
                source: { type: "local", path: pluginRoot },
                installedRoot: pluginRoot,
                installedAt: "2026-01-01T00:00:00Z",
                permissionsHash: acceptedHash,
                sensitiveApprovals: [],
              },
            },
            approvalsByHash: {},
          },
        },
      };
      await stateStore.write(state);

      const registry = new PluginRegistry({
        installedRoot: root,
        legacyGlobalRoot: root,
        stateStore,
      });
      const result = await registry.list({ enabled: [], disabled: [], directories: [] });

      const reviewed = result.plugins.find((p) => p.pluginId === "reviewed");
      expect(reviewed?.permissionState?.state).toBe("loaded");
      expect(result.diagnostics.filter((d) => d.pluginId === "reviewed")).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a reviewed plugin whose accepted hash differs is needs-review with a permission_review_required diagnostic", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-reg-perm-"));
    try {
      const pluginRoot = await writePlugin(root, "drifted");
      const stateStore = new FilePluginStateStore(join(root, "state.json"));
      const state: PluginStateFile = {
        plugins: {
          drifted: {
            pluginId: "drifted",
            activeVersion: "1.0.0",
            versions: {
              "1.0.0": {
                pluginId: "drifted",
                version: "1.0.0",
                source: { type: "local", path: pluginRoot },
                installedRoot: pluginRoot,
                installedAt: "2026-01-01T00:00:00Z",
                permissionsHash: "stale-hash-that-does-not-match",
                sensitiveApprovals: [],
              },
            },
            approvalsByHash: {},
          },
        },
      };
      await stateStore.write(state);

      const registry = new PluginRegistry({
        installedRoot: root,
        legacyGlobalRoot: root,
        stateStore,
      });
      const result = await registry.list({ enabled: [], disabled: [], directories: [] });

      const drifted = result.plugins.find((p) => p.pluginId === "drifted");
      expect(drifted?.permissionState?.state).toBe("needs-review");
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ pluginId: "drifted", code: "permission_review_required" }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.permission-state.test.ts`
Expected: FAIL — `permissionState` is `undefined` on listed plugins (registry does not attach it yet).

### Task 12: Attach permissionState and diagnostics in registry.list

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.ts`

- [ ] **Step 1: Add imports**

At the top of `apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.ts`, replace the existing SDK import block:

```ts
import {
  normalizePluginManifests,
  type NormalizedPlugin,
  type PluginDiagnostic,
} from "@lume/agent-sdk";
```

with the following three import statements (the existing `./plugin-state-store.js` import already provides both `FilePluginStateStore` and `PluginStateFile` — keep both types; only add `computePermissionsHash` to the SDK import and add the new `PluginPermissionRuntime` import):

```ts
import {
  computePermissionsHash,
  normalizePluginManifests,
  type NormalizedPlugin,
  type PluginDiagnostic,
} from "@lume/agent-sdk";
import type { FilePluginStateStore, PluginStateFile } from "./plugin-state-store.js";
import { PluginPermissionRuntime } from "./permission-runtime.js";
```

- [ ] **Step 2: Add `permissionState` to `RegisteredPlugin`**

Change the `RegisteredPlugin` interface:

```ts
export interface RegisteredPlugin extends NormalizedPlugin {
  state?: PluginRegistryState;
  permissionState?: { state: "loaded" | "needs-review" | "not-loaded"; reason: string };
}
```

- [ ] **Step 3: Attach permission state at the end of `list()`**

In the `list()` method, replace the final `return { plugins: filtered, diagnostics };` with:

```ts
    await attachPermissionState(filtered, this.config.stateStore, diagnostics);
    return { plugins: filtered, diagnostics };
  }
}
```

Then add this helper function at the end of the file (after the existing helper functions):

```ts
async function attachPermissionState(
  plugins: RegisteredPlugin[],
  stateStore: FilePluginStateStore,
  diagnostics: PluginDiagnostic[],
): Promise<void> {
  const runtime = new PluginPermissionRuntime({ stateStore });
  for (const plugin of plugins) {
    const currentHash = computePermissionsHash(plugin);
    const result = await runtime.computeRuntimeState({
      pluginId: plugin.pluginId,
      enabled: true, // filtered plugins are enabled under the effective config
      currentHash,
    });
    plugin.permissionState = result;
    if (result.state !== "loaded") {
      diagnostics.push({
        pluginId: plugin.pluginId,
        version: plugin.version,
        severity: result.state === "needs-review" ? "warning" : "info",
        code: result.state === "needs-review" ? "permission_review_required" : "capability_filtered",
        message: `Plugin ${plugin.pluginId} is ${result.state} (${result.reason}); capabilities will not load until reviewed.`,
        path: plugin.root,
      });
    }
  }
}
```

- [ ] **Step 4: Run new tests and the Phase 1 registry regression**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.permission-state.test.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.test.ts`
Expected: new tests PASS (3); Phase 1 registry tests still PASS. If a Phase 1 test asserts an exact diagnostics array and now fails because of an added `capability_filtered` diagnostic, relax that assertion to check the diagnostic it cares about via `toContainEqual` instead of whole-array equality — do NOT change Phase 1 scan/duplicate behavior.

### Task 13: Commit Chunk 4

- [ ] **Step 1: Verify focused suite + targeted typecheck**

Run: `rtk bun test packages/sdk/src/plugins/permissions-hash.test.ts packages/sdk/src/plugins/permission-gate.test.ts apps/sidecar/src/services/agent-runtime/plugins/permission-runtime.test.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.permission-state.test.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.test.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-state-store.test.ts`
Expected: all PASS.

Run: `rtk bun run --filter @lume/sidecar typecheck` — confirm no NEW errors in `plugin-registry.ts` / `permission-runtime.ts` beyond the pre-existing unrelated set.

- [ ] **Step 2: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.permission-state.test.ts
git commit -m "✨ feat(sidecar): 注册表附加 effective permission state" \
  -m "PluginRegistry.list 对每个插件计算 permissionsHash 与 effective runtime state，needs-review/not-loaded 时产出 permission_review_required/capability_filtered 诊断，供调用方与 Phase 4 UI 判断哪些插件不会加载。" \
  -m "Constraint: 不接入 runtime capability 加载，仅产出状态与诊断" \
  -m "Tested: bun test plugin-registry.permission-state.test.ts (3 pass); Phase 1 registry 回归通过"
```

---

## Phase 2 Boundary Check (no runtime capability loading)

After all four chunks are committed, verify Phase 2 did not introduce runtime loading (mirrors the Phase 1 Chunk 4 check):

- [ ] **Step 1: Confirm runtime-loading files were not touched**

```bash
rtk git diff 875a4a79..HEAD --stat -- \
  apps/sidecar/src/services/agent-runtime/tools/tool-runtime.ts \
  apps/sidecar/src/services/agent-runtime/runtime-core/run.ts \
  apps/sidecar/src/services/agent-runtime/runtime-core/attempt.ts \
  packages/sdk/src/plugins/loader.ts \
  packages/sdk/src/agent.ts
```

Expected: empty (no diffs) for `loader.ts` and `agent.ts`. `tool-runtime.ts` / `run.ts` / `attempt.ts` should also be untouched in Phase 2 (they were only changed in Phase 1 for the async migration).

- [ ] **Step 2: Confirm no runtime-loading calls were introduced**

```bash
rtk git diff 875a4a79..HEAD | grep -iE "^\+.*(connectMCPServer|registerHook|createSdkMcpServer|assembleToolPool|toolPool|loadFilesystemSkills)" || echo ">>> 未引入 runtime capability loading <<<"
```

Expected: `>>> 未引入 runtime capability loading <<<`.

- [ ] **Step 3: Run the full plugin test suite**

```bash
rtk bun test \
  packages/sdk/src/plugins/normalized.test.ts \
  packages/sdk/src/plugins/manifest.test.ts \
  packages/sdk/src/plugins/codex-adapter.test.ts \
  packages/sdk/src/plugins/permissions-hash.test.ts \
  packages/sdk/src/plugins/permission-gate.test.ts \
  apps/sidecar/src/services/agent-runtime/plugins/plugin-state-store.test.ts \
  apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.test.ts \
  apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.permission-state.test.ts \
  apps/sidecar/src/services/agent-runtime/plugins/permission-runtime.test.ts \
  apps/sidecar/src/services/agent-runtime/tools/tool-runtime.test.ts \
  apps/sidecar/src/rpc/agent-handlers.list-plugins.test.ts
```

Expected: all PASS.

---

## Self-Review

**Spec coverage (§14.2 Phase 2 scope):**

| §14.2 requirement | Covered by |
|---|---|
| capability contributions carry `pluginId` and `version` | `PluginSkillContribution` already has both (Phase 1); `PluginPermissionRuntime` keys every decision by `pluginId` (source binding, Task 9). `CommandToolContribution` source-binding is finalized in Phase 3's capability resolver, which is where tools actually get tagged — Phase 2 establishes the gate that consumes `pluginId`. |
| `PluginPermissionRuntime` source-binding skeleton | Task 9 |
| hard deny | `isHardDeniedTool` (Task 5); exposed via SDK, consumed in Phase 3 |
| `needs-review` skip | `computeEffectiveRuntimeState` + registry diagnostics (Tasks 5, 12) |
| `permissionsHash` verification | `computePermissionsHash` (Task 2) + registry integration (Task 12) |
| sensitive capabilities default-block + diagnostic | `resolveSensitiveApproval` returns `"ask"` → `permission_review_required` diagnostic on `needs-review` (Tasks 5, 12); interactive confirmation is Phase 4 |

**Phase 2 acceptance (§14.2):**

| Acceptance | How verified |
|---|---|
| plain builtin tools unaffected by unrelated plugin permissions | source binding: every gate method is `pluginId`-keyed (Task 9); no builtin-tool code path is modified |
| `needs-review` plugins do not load | registry labels them `needs-review` + diagnostic (Task 12); actual load prevention is Phase 3's capability resolver, which reads this state |
| command tools / MCP / shell hooks do not run without approval | Phase 2 adds no capability loading (Boundary Check), so nothing runs yet; the gate decision logic (`resolveSensitiveApproval` = ask → block) is unit-tested (Tasks 4-5, 8-9) and is what Phase 3 calls before loading |

**Placeholder scan:** none — every step has complete code or an exact command.

**Type consistency:** `SensitiveApprovalRecord` / `SensitiveCapabilityKey` defined in Task 5, consumed in Tasks 7 & 9. `computePermissionsHash` defined in Task 2, consumed in Task 12. `permissionState` shape (`{ state, reason }`) is identical in Task 9 (`RuntimeStateResult`) and Task 12 (`RegisteredPlugin.permissionState`).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-14-lume-plugin-platform-phase-2.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
