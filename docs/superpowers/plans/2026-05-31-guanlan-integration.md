# Guanlan Integration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add guanlan as a first-class optional WebSearch provider in Lume, with sidecar-managed Python/Guanlan bootstrap and safe fallback to existing providers.

**Architecture:** Configuration lives in `lume-config.webSearch`. The sidecar normalizes provider enablement/order, probes or downloads Python, installs guanlan, and exposes search-backend testing. The SDK WebSearch tool consumes sidecar-injected env vars for provider order and runs guanlan as a read-only provider without owning Python installation.

**Tech Stack:** TypeScript, Bun, Node child_process, existing `@lume/shared`, `@lume/sidecar`, `@lume/agent-sdk`, React settings UI.

---

Spec: `docs/superpowers/specs/2026-05-31-guanlan-integration-design.md`

## File Structure

- Modify `packages/shared/src/types/general-settings.ts`
  - Add `guanlan` to `WebSearchProvider`.
- Modify `packages/shared/src/types/lume-config.ts`
  - Add disabled guanlan default.
- Modify `apps/sidecar/src/services/system/lume-config-service.ts`
  - Normalize `guanlan`.
  - Sync enabled provider order and guanlan env vars.
- Create `apps/sidecar/src/services/infra/guanlan-runtime-service.ts`
  - Probe Python.
  - Download python-build-standalone when Python is missing.
  - Check/install guanlan.
  - Execute guanlan search for runtime/test paths.
- Modify `apps/sidecar/src/services/infra/search-test-service.ts`
  - Add guanlan test case.
- Modify `packages/sdk/src/tools/web-search.ts`
  - Respect enabled provider env.
  - Add guanlan provider attempt.
- Modify `apps/web/src/components/settings/WebSearchSettings.tsx`
  - Add Guanlan provider card.
- Add/modify focused tests near the touched modules.

## Chunk 1: Shared Config and Sidecar Env

### Task 1: Add guanlan to shared provider types

**Files:**
- Modify: `packages/shared/src/types/general-settings.ts`
- Modify: `packages/shared/src/types/lume-config.ts`

- [ ] **Step 1: Update provider union**

Change:

```ts
export type WebSearchProvider = "exa" | "tavily" | "brave" | "duckduckgo" | "pipellm" | "zhipu" | "bing"
```

To:

```ts
export type WebSearchProvider =
  | "guanlan"
  | "exa"
  | "tavily"
  | "brave"
  | "duckduckgo"
  | "pipellm"
  | "zhipu"
  | "bing"
```

- [ ] **Step 2: Add disabled default**

In `DEFAULT_LUME_WEB_SEARCH`, add:

```ts
guanlan: { enabled: false },
```

before `duckduckgo`.

- [ ] **Step 3: Run shared typecheck**

Run:

```bash
rtk bun run --filter @lume/shared typecheck
```

Expected: PASS.

### Task 2: Normalize and sync enabled provider order

**Files:**
- Modify: `apps/sidecar/src/services/system/lume-config-service.ts`
- Test: `apps/sidecar/src/services/system/lume-config-service.test.ts`

- [ ] **Step 1: Write focused tests**

Add tests that prove:

- `guanlan` survives normalization.
- `syncWebSearchEnvVars` writes `LUME_WEB_SEARCH_PROVIDERS` with only enabled providers.
- disabled guanlan does not set `LUME_GUANLAN_ENABLED`.

Suggested assertions:

```ts
expect(process.env.LUME_WEB_SEARCH_PROVIDERS).toBe("guanlan,bing")
expect(process.env.LUME_GUANLAN_ENABLED).toBe("1")
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
rtk bun test apps/sidecar/src/services/system/lume-config-service.test.ts
```

Expected: FAIL because guanlan is not normalized/synced yet.

- [ ] **Step 3: Implement normalization**

Update:

```ts
const WEB_SEARCH_PROVIDER_KEYS: WebSearchProvider[] = [...]
```

to include `guanlan` first.

- [ ] **Step 4: Implement env sync**

In `syncWebSearchEnvVars`, compute enabled providers in `WEB_SEARCH_PROVIDER_KEYS` order:

```ts
const enabledProviders = WEB_SEARCH_PROVIDER_KEYS.filter((provider) =>
  providers[provider]?.enabled === true
);
process.env.LUME_WEB_SEARCH_PROVIDERS = enabledProviders.join(",");
process.env.LUME_GUANLAN_ENABLED = enabledProviders.includes("guanlan") ? "1" : "";
```

Keep existing API key env sync unchanged.

- [ ] **Step 5: Run focused test**

Run:

```bash
rtk bun test apps/sidecar/src/services/system/lume-config-service.test.ts
```

Expected: PASS.

## Chunk 2: Guanlan Runtime Service

### Task 3: Add sidecar guanlan runtime service

**Files:**
- Create: `apps/sidecar/src/services/infra/guanlan-runtime-service.ts`
- Test: `apps/sidecar/src/services/infra/guanlan-runtime-service.test.ts`

- [ ] **Step 1: Write tests around injectable command runner**

Design the service with an internal runner dependency so tests do not require Python:

```ts
type CommandRunner = (command: string, args: string[], options: RunOptions) => Promise<RunResult>
```

Test cases:

- Finds `LUME_PYTHON`.
- Reports missing Python when all candidates fail.
- Attempts managed Python download from `ensureReady` when no Python exists.
- Attempts `python -m pip install --upgrade guanlan` when guanlan check fails.
- Parses JSON array search output into `{ title, url, snippet }`.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
rtk bun test apps/sidecar/src/services/infra/guanlan-runtime-service.test.ts
```

Expected: FAIL because service does not exist.

- [ ] **Step 3: Implement command runner**

Use `node:child_process` `spawn`, collect stdout/stderr, enforce timeout with `setTimeout`, and kill the process on timeout.

Keep helper constants:

```ts
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_STDERR_CHARS = 2_000;
const MAX_STDOUT_CHARS = 200_000;
```

- [ ] **Step 4: Implement Python candidate resolution**

Candidate order:

1. `process.env.LUME_PYTHON`
2. `join(getConfigDir(), "runtime", "python", "bin", "python3")`
3. `join(getConfigDir(), "runtime", "python", "python.exe")`
4. `"python3"`
5. `"python"`

Return the first candidate whose `--version` command exits with code 0.

- [ ] **Step 5: Implement guanlan status/install/search**

Export:

```ts
export async function getGuanlanRuntimeStatus(): Promise<GuanlanRuntimeStatus>
export async function ensureGuanlanReady(): Promise<GuanlanRuntimeStatus>
export async function runGuanlanSearch(input: GuanlanSearchInput): Promise<GuanlanSearchResult[]>
```

Use:

```bash
python -m guanlan --version
python -m pip install --upgrade guanlan
python -m guanlan search <query> --profile china --limit <limit> --json
```

If `--json` is unsupported, keep a fallback parser that accepts a JSON array/object and otherwise returns a single text result only if a URL can be extracted.

- [ ] **Step 6: Run focused test**

Run:

```bash
rtk bun test apps/sidecar/src/services/infra/guanlan-runtime-service.test.ts
```

Expected: PASS.

### Task 4: Wire search-backend test

**Files:**
- Modify: `apps/sidecar/src/services/infra/search-test-service.ts`
- Test: `apps/sidecar/src/services/infra/search-test-service.test.ts`

- [ ] **Step 1: Add or update tests**

Mock `getGuanlanRuntimeStatus` if the test framework pattern supports module mocks. If not, export a small injectable helper from `search-test-service.ts` for tests.

Assert:

```ts
expect(await testSearchBackend({ provider: "guanlan" })).toEqual({
  ok: true,
  provider: "guanlan"
})
```

and failure includes `error`.

- [ ] **Step 2: Implement guanlan switch case**

Add:

```ts
case "guanlan":
  return await testGuanlan();
```

- [ ] **Step 3: Run focused test**

Run:

```bash
rtk bun test apps/sidecar/src/services/infra/search-test-service.test.ts
```

Expected: PASS.

## Chunk 3: SDK WebSearch Provider Chain

### Task 5: Respect enabled provider order

**Files:**
- Modify: `packages/sdk/src/tools/web-search.ts`
- Test: create or modify `packages/sdk/src/tools/web-search.test.ts`

- [ ] **Step 1: Write provider-order tests**

Test a pure helper:

```ts
resolveEnabledWebSearchProviders(envValue)
```

Cases:

- `undefined` returns current default order.
- `"guanlan,bing"` returns `["guanlan", "bing"]`.
- unknown providers are ignored.
- empty string returns default order or no configured providers; choose default for SDK compatibility.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
rtk bun test packages/sdk/src/tools/web-search.test.ts
```

Expected: FAIL because helper does not exist.

- [ ] **Step 3: Implement helper and apply chain**

Create a provider attempt map:

```ts
const providerAttempts = {
  guanlan: () => searchWithGuanlan(query, numResults, context.sandbox),
  exa: () => searchWithExa(...),
  ...
}
```

Build attempts from `resolveEnabledWebSearchProviders(process.env.LUME_WEB_SEARCH_PROVIDERS)`.

- [ ] **Step 4: Run provider-order tests**

Run:

```bash
rtk bun test packages/sdk/src/tools/web-search.test.ts
```

Expected: PASS.

### Task 6: Add guanlan SDK provider attempt

**Files:**
- Modify: `packages/sdk/src/tools/web-search.ts`
- Test: `packages/sdk/src/tools/web-search.test.ts`

- [ ] **Step 1: Write guanlan attempt tests**

Keep command execution injectable by exporting a small helper or by factoring runner logic into pure functions. Test:

- disabled env returns `null`.
- command failure falls through as provider failure.
- JSON output maps to `SearchResult[]`.
- limit clamps to 1-10.

- [ ] **Step 2: Implement `searchWithGuanlan`**

Use `child_process.spawn` or dynamic import to avoid adding dependencies.

Candidate command:

```ts
const python = process.env.LUME_GUANLAN_PYTHON || "python3";
const args = ["-m", "guanlan", "search", query, "--profile", "china", "--limit", String(limit), "--json"];
```

If `python3` fails due command not found and no explicit `LUME_GUANLAN_PYTHON`, retry `python`.

- [ ] **Step 3: Run SDK focused tests**

Run:

```bash
rtk bun test packages/sdk/src/tools/web-search.test.ts
```

Expected: PASS.

## Chunk 4: Web Settings UI

### Task 7: Add Guanlan card

**Files:**
- Modify: `apps/web/src/components/settings/WebSearchSettings.tsx`

- [ ] **Step 1: Add provider meta**

Add before Exa:

```ts
{
  id: 'guanlan',
  label: 'Guanlan',
  description: '本地搜索能力，适合中文/国内信息场景，无需 API Key',
  needsApiKey: false,
  link: 'https://pypi.org/project/guanlan/',
  linkLabel: 'pypi.org →',
  badge: '本地',
}
```

- [ ] **Step 2: Check initial draft behavior**

`buildInitialDrafts` currently enables no-key providers by default. For guanlan, override initial enabled default to false so adding it does not change existing behavior.

Implementation hint:

```ts
const enabledByDefault = meta.id === 'guanlan' ? false : !meta.needsApiKey
```

- [ ] **Step 3: Run web typecheck only if TypeScript changes require it**

Run:

```bash
rtk bun run --filter @lume/web typecheck
```

Expected: PASS.

## Chunk 5: Final Verification

### Task 8: Run focused verification

**Files:**
- All touched files.

- [ ] **Step 1: Run shared typecheck**

Run:

```bash
rtk bun run --filter @lume/shared typecheck
```

Expected: PASS.

- [ ] **Step 2: Run sidecar focused tests**

Run:

```bash
rtk bun test apps/sidecar/src/services/system/lume-config-service.test.ts apps/sidecar/src/services/infra/guanlan-runtime-service.test.ts apps/sidecar/src/services/infra/search-test-service.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run SDK focused tests**

Run:

```bash
rtk bun test packages/sdk/src/tools/web-search.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run web typecheck if UI changed**

Run:

```bash
rtk bun run --filter @lume/web typecheck
```

Expected: PASS.

- [ ] **Step 5: Manual runtime check when Python is available**

Run:

```bash
rtk LUME_WEB_SEARCH_PROVIDERS=guanlan LUME_GUANLAN_ENABLED=1 bun test packages/sdk/src/tools/web-search.test.ts
```

Expected: tests still pass without requiring real guanlan. If a local Python/guanlan integration smoke is added, mark it optional because CI/client machines may lack Python.

## Commit Guidance

Use Lore protocol:

```bash
git add <changed files>
git commit -m "✨ feat(web,sdk,sidecar,shared): 接入 guanlan 搜索能力" -m "将 guanlan 接入现有 WebSearch provider 链路，由 sidecar 负责 Python/Guanlan 探测与状态测试，SDK 只消费启用 provider 顺序并执行只读搜索调用。" -m "Constraint: 不新增 npm 依赖" -m "Constraint: 客户端无 Python 时必须可解释失败并保留现有搜索回退" -m "Tested: <focused test commands>"
```
