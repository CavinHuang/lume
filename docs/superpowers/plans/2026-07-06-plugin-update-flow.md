# Plugin Update Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Implement manual plugin updates with semver-based update detection, permission-hash review, retained rollback version, and detail-page update/rollback actions.

**Architecture:** Keep plugin update state inside the existing `PluginMarketService` and `plugins-state.json` model. Add small pure helpers for semver/version UI decisions, then thread update intent through the existing shared IPC types and web detail page. Rollback should reuse active-version switching and avoid changing plugin enablement.

**Tech Stack:** Bun/TypeScript, existing sidecar plugin-market tests, existing web state/render tests, no new dependencies.

---

### Task 1: Semver Update Detection

**Files:**
- Modify: `apps/sidecar/src/services/plugins/plugin-market-service.test.ts`
- Modify: `apps/sidecar/src/services/plugins/plugin-market-service.ts`

- [x] **Step 1: Write failing service tests for semver-only updates**

Add tests that install `demo@1.2.0`, then point the same market item at `1.3.0`, `1.2.0`, and `1.1.9`.

```ts
test("marks plugin update only when market semver is higher than active version", async () => {
  const sourceRoot = join(root, "source", "semver-plugin");
  const indexPath = join(root, "market.json");
  await writeJson(join(sourceRoot, "lume-plugin.json"), {
    schema: "lume-plugin/v1",
    name: "semver-plugin",
    version: "1.2.0"
  });
  await writeJson(indexPath, {
    items: [{ kind: "plugin", id: "semver-plugin", name: "Semver Plugin", source: { type: "local", path: sourceRoot } }]
  });
  writeFileSync(getLumeConfigYamlPath(), YAML.stringify({
    version: 1,
    plugins: {
      marketSources: [DISABLED_OFFICIAL_MARKET_SOURCE, { id: "local-market", name: "Local", kind: "local-index", path: indexPath, enabled: true }]
    }
  }), "utf-8");

  const service = makeService(root);
  const installed = await service.getMarketDetail({ workspaceSlug: "default", kind: "plugin", itemId: "local-market:semver-plugin" });
  const hash = installed.inspect?.kind === "plugin" ? installed.inspect.permissionsHash : "";
  await service.installMarketItem({
    workspaceSlug: "default",
    kind: "plugin",
    itemId: "local-market:semver-plugin",
    acceptedPermissionsHash: hash,
    enableScope: "workspace"
  });

  await writeJson(join(sourceRoot, "lume-plugin.json"), { schema: "lume-plugin/v1", name: "semver-plugin", version: "1.3.0" });
  const newer = await service.getMarketDetail({ workspaceSlug: "default", kind: "plugin", itemId: "local-market:semver-plugin" });
  expect(newer.inspect?.kind === "plugin" ? newer.inspect.installState : "").toBe("update-available");

  await writeJson(join(sourceRoot, "lume-plugin.json"), { schema: "lume-plugin/v1", name: "semver-plugin", version: "1.1.9" });
  const lower = await service.getMarketDetail({ workspaceSlug: "default", kind: "plugin", itemId: "local-market:semver-plugin" });
  expect(lower.inspect?.kind === "plugin" ? lower.inspect.installState : "").toBe("installed");
});
```

- [x] **Step 2: Verify RED**

Run:

```powershell
bun test apps/sidecar/src/services/plugins/plugin-market-service.test.ts -t "marks plugin update only when market semver is higher than active version"
```

Expected: fail because lower versions are currently treated as `update-available`.

- [x] **Step 3: Implement minimal semver compare**

Add private helpers near `resolveInstallState()`:

```ts
function compareSemverVersions(left: string, right: string): -1 | 0 | 1 | undefined {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return left === right ? 0 : undefined;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] < b[index]) return -1;
    if (a[index] > b[index]) return 1;
  }
  return 0;
}

function parseSemver(version: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
```

Change `resolveInstallState(plugin)` so only `compareSemverVersions(plugin.version, record.activeVersion) === 1` returns `update-available`; equal, lower, or incomparable versions return `installed` when an active version exists.

- [x] **Step 4: Verify GREEN**

Run the focused test from Step 2. Expected: PASS.

### Task 2: Service Update And Rollback Semantics

**Files:**
- Modify: `packages/shared/src/types/plugin-market.ts`
- Modify: `apps/sidecar/src/rpc/schemas.ts`
- Modify: `apps/sidecar/src/rpc/schemas.plugin-market.test.ts`
- Modify: `apps/sidecar/src/services/plugins/plugin-market-service.test.ts`
- Modify: `apps/sidecar/src/services/plugins/plugin-market-service.ts`

- [x] **Step 1: Write failing schema test for workspaceSlug**

Import `updatePluginInputSchema` and assert it requires `workspaceSlug`:

```ts
test("updatePluginInputSchema requires workspace slug", () => {
  expect(() => updatePluginInputSchema.parse({ pluginId: "demo" })).toThrow();
  expect(updatePluginInputSchema.parse({
    workspaceSlug: "default",
    pluginId: "demo",
    acceptedPermissionsHash: "abc123"
  }).workspaceSlug).toBe("default");
});
```

- [x] **Step 2: Write failing update service tests**

Add tests that prove:

1. Updating to `1.1.0` preserves workspace enablement and keeps `1.0.0`.
2. Updating to `1.2.0` prunes `1.0.0` and keeps `1.1.0`.
3. A permissions-hash change without `acceptedPermissionsHash` throws `permission_review_required`.
4. Rolling back switches `activeVersion` to the retained version.

Use local source directory rewrites and inspect hashes before calling update.

- [x] **Step 3: Verify RED**

Run:

```powershell
bun test apps/sidecar/src/rpc/schemas.plugin-market.test.ts -t "updatePluginInputSchema requires workspace slug"
bun test apps/sidecar/src/services/plugins/plugin-market-service.test.ts -t "updates plugin versions"
```

Expected: schema test fails because `workspaceSlug` is optional/missing; service test fails because update currently uses default workspace and lacks retention behavior.

- [x] **Step 4: Update shared and schema types**

Change `UpdatePluginInput`:

```ts
export interface UpdatePluginInput {
  workspaceSlug: string
  pluginId: string
  source?: PluginSourceRef
  targetVersion?: string
  acceptedPermissionsHash?: string
  force?: boolean
}
```

Change `UpdatePluginResult`:

```ts
export interface UpdatePluginResult {
  pluginId: string
  installedVersion: string
  activeVersion: string
  previousActiveVersion?: string
  retainedVersions: string[]
  activated: boolean
  needsReview: boolean
  diagnostics?: AgentPluginDiagnostic[]
}
```

Update `updatePluginInputSchema` to require `workspaceSlug: idSchema` and remove `activate`.

- [x] **Step 5: Implement update semantics**

Replace `updatePlugin()` logic with:

```ts
async updatePlugin(input: UpdatePluginInput): Promise<UpdatePluginResult> {
  const state = await this.stateStore().read();
  const record = state.plugins[input.pluginId];
  const previousActiveVersion = record?.activeVersion;
  const activeInstalled = previousActiveVersion ? record?.versions[previousActiveVersion] : undefined;
  const source = input.source ?? activeInstalled?.source as PluginSourceRef | undefined;
  if (!record || !previousActiveVersion || !activeInstalled) throw new PluginMarketError("not_installed", "插件未安装");
  if (!source) throw new PluginMarketError("source_not_found", "找不到插件来源");

  const inspected = await this.inspectPluginSource(input.workspaceSlug, source);
  if (inspected.normalized.pluginId !== input.pluginId) throw new PluginMarketError("invalid_manifest", "插件来源与已安装插件不匹配", inspected.diagnostics);
  if (!input.force && compareSemverVersions(inspected.normalized.version, previousActiveVersion) !== 1) {
    throw new PluginMarketError("already_installed", "目标版本不是更高版本", inspected.diagnostics);
  }
  if (activeInstalled.permissionsHash !== inspected.permissionsHash && input.acceptedPermissionsHash !== inspected.permissionsHash) {
    throw new PluginMarketError("permission_review_required", "插件权限已变化,需要确认后更新", inspected.diagnostics);
  }

  const installed = await this.installMarketItem({
    workspaceSlug: input.workspaceSlug,
    kind: "plugin",
    source,
    acceptedPermissionsHash: inspected.permissionsHash,
    enableScope: "none",
    overwrite: true,
  });
  const retainedVersions = await this.prunePluginVersions(input.pluginId, previousActiveVersion);
  return {
    pluginId: input.pluginId,
    installedVersion: installed.version ?? "",
    activeVersion: installed.version ?? "",
    previousActiveVersion,
    retainedVersions,
    activated: false,
    needsReview: false,
    diagnostics: installed.diagnostics,
  };
}
```

Add `prunePluginVersions(pluginId, previousActiveVersion)` that reloads state after install, keeps active and previous versions, deletes older version directories, writes state, and returns retained version keys sorted by installedAt descending.

- [x] **Step 6: Implement rollback using active-version switching**

Keep `setPluginActiveVersion()` as the rollback service. Add a test that calls it with the retained old version and asserts activeVersion changes. Do not add a new IPC unless the UI needs different semantics.

- [x] **Step 7: Verify GREEN**

Run the schema and service focused tests from Step 3. Expected: PASS.

### Task 3: Web Detail State And Update Action

**Files:**
- Modify: `apps/web/src/components/skills/plugin-detail-state.ts`
- Modify: `apps/web/src/components/skills/plugin-detail-state.test.ts`
- Modify: `apps/web/src/components/skills/PluginDetailPage.tsx`
- Modify: `apps/web/src/components/skills/PluginDetailPage.test.tsx`
- Modify: `apps/web/src/components/skills/SkillsMarketView.tsx`

- [x] **Step 1: Write failing pure state tests**

Add tests for update action label and rollback visibility:

```ts
expect(buildPluginUpdateAction({ updateAvailable: true, permissionChanged: false, version: "1.1.0" }).label).toBe("更新到 v1.1.0");
expect(buildPluginUpdateAction({ updateAvailable: true, permissionChanged: true, version: "1.1.0" }).label).toBe("确认权限并更新");
```

- [x] **Step 2: Write failing render test**

Update `PluginDetailPage.test.tsx` so updateable plugins render current/update labels and rollback action when provided.

- [x] **Step 3: Verify RED**

Run:

```powershell
bun test apps/web/src/components/skills/plugin-detail-state.test.ts -t "plugin update"
bun test apps/web/src/components/skills/PluginDetailPage.test.tsx -t "keeps installed management actions visible for updateable plugins"
```

Expected: fail because helper and rollback UI do not exist.

- [x] **Step 4: Implement pure helpers and props**

Add:

```ts
export function buildPluginUpdateAction(input: {
  updateAvailable: boolean
  permissionChanged: boolean
  version: string
}): { label: string; requiresPermissionReview: boolean } {
  if (!input.updateAvailable) return { label: "确认权限并安装", requiresPermissionReview: false };
  return input.permissionChanged
    ? { label: "确认权限并更新", requiresPermissionReview: true }
    : { label: `更新到 v${input.version}`, requiresPermissionReview: false };
}
```

Extend `PluginDetailPageProps` with optional `rollbackVersion?: string` and `onRollback?: () => void`.

- [x] **Step 5: Wire SkillsMarketView update path**

Import and call `updatePlugin()` for updateable detail items:

```ts
if (installState === "update-available") {
  await updatePlugin({
    workspaceSlug,
    pluginId: marketItem.pluginId,
    source: pluginDetail.inspectSource,
    acceptedPermissionsHash: pluginDetail.inspect.permissionsHash,
  });
} else {
  await installMarketItem(...);
}
```

Use the existing item/source path available from `itemId`; if no direct source is present, pass only `workspaceSlug`, `pluginId`, and `acceptedPermissionsHash` so the service uses the installed source.

- [x] **Step 6: Wire rollback path**

Use `setPluginActiveVersion({ pluginId, version: rollbackVersion })`, refresh detail/catalog, and keep the detail page open.

- [x] **Step 7: Verify GREEN**

Run focused web tests from Step 3. Expected: PASS.

### Task 4: Final Verification And Commit

**Files:**
- All files above.

- [x] **Step 1: Run focused sidecar tests**

```powershell
bun test apps/sidecar/src/rpc/schemas.plugin-market.test.ts
bun test apps/sidecar/src/services/plugins/plugin-market-service.test.ts -t "plugin"
```

- [x] **Step 2: Run focused web tests**

```powershell
bun test apps/web/src/components/skills/plugin-detail-state.test.ts
bun test apps/web/src/components/skills/PluginDetailPage.test.tsx
```

- [x] **Step 3: Typecheck changed packages when relevant**

Run:

```powershell
bun run --filter @lume/web typecheck
bun run --filter @lume/sidecar typecheck
```

If sidecar typecheck still fails only on pre-existing `AgentStreamEmitter.onBrowserAuthRequest` test stubs, record it as not-passing with evidence.

- [x] **Step 4: Diff checks**

```powershell
git diff --check
git status --short
```

- [x] **Step 5: Commit with Lore protocol**

```text
✨ feat(sidecar,web): 支持插件手动更新回滚

Constraint: 手动更新,不做后台自动更新
Constraint: 权限 hash 变化才要求重新确认
Tested: focused plugin market and detail tests
```
