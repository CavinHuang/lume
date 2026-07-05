# Plugin Marketplace Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox format and include exact files, commands, and acceptance checks.

## Goal

Complete first-class marketplace metadata for Lume plugins so `lume-plugin.json` can describe plugin detail assets, external links, and explicit setup steps. Use that metadata on the plugin detail page, then update the current `lume-chrome` and `obsidian-bridge` plugins with concrete setup guidance and thumbnails.

## Architecture

The metadata remains descriptive and non-runtime:

- SDK parses and normalizes `marketplace` from `lume-plugin.json`.
- Sidecar copies normalized metadata into `PluginMarketItem` and resolves small local image assets to data URLs for display.
- Web detail state prefers explicit `marketplace.setup` over inferred setup hints and renders marketplace media/links when present.
- Plugin packages own their README, thumbnail, icon, and setup copy.

No permission hash or runtime capability behavior changes.

## Tech Stack

- TypeScript in `packages/sdk`, `packages/shared`, `apps/sidecar`, and `apps/web`.
- Bun tests for SDK, sidecar, and web components.
- Existing shadcn/global UI primitives only.
- SVG/PNG package assets only; no new dependencies.

## Tasks

### 1. SDK manifest metadata parsing

- [x] Add failing tests in `packages/sdk/src/plugins/manifest.test.ts`:
  - valid `marketplace.icon`, `marketplace.thumbnail`, `marketplace.hero`, `marketplace.docs`, `marketplace.website`, and `marketplace.setup` are preserved;
  - invalid package-relative marketplace paths throw with the matching field name.
- [x] Add failing test in `packages/sdk/src/plugins/normalized.test.ts`:
  - normalized Lume manifests carry `marketplace` metadata.
- [x] Update `packages/sdk/src/plugins/manifest.ts`:
  - add manifest-level marketplace types;
  - reuse `validatePluginPath` for local asset/docs paths;
  - keep setup steps only when `id`, `title`, and `description` are strings;
  - allow setup `kind` only from `install`, `enable`, `browser-auth`, `pairing-code`, `local-service`, `mcp`, and `custom`.
- [x] Update `packages/sdk/src/plugins/normalized.ts`:
  - add `marketplace?: PluginMarketplaceManifest` to `NormalizedPlugin`;
  - copy `manifest.marketplace` for Lume and adapted Codex manifests.
- [x] Verify:

```powershell
rtk bun test packages/sdk/src/plugins/manifest.test.ts packages/sdk/src/plugins/normalized.test.ts
```

### 2. Shared and sidecar market item output

- [x] Add marketplace result types to `packages/shared/src/types/plugin-market.ts`:
  - `PluginMarketplaceAsset`;
  - `PluginSetupStep`;
  - `PluginMarketplaceMetadata`;
  - optional `marketplace` on `PluginMarketItem`;
  - `InspectPluginResult.normalized` remains unchanged because `PluginMarketItem` carries detail metadata.
- [x] Add failing test in `apps/sidecar/src/services/plugins/plugin-market-service.test.ts`:
  - local plugin detail returns setup metadata and resolves a small SVG thumbnail to `data:image/svg+xml;base64,...`.
- [x] Update `apps/sidecar/src/services/plugins/plugin-market-service.ts`:
  - map normalized marketplace metadata in `toMarketItem`;
  - resolve local package-relative image assets under `plugin.root`;
  - cap inline asset size and return only `{ path }` when the file is missing, too large, or not a supported image type;
  - leave GitHub asset hydration for a later explicit step.
- [x] Verify:

```powershell
rtk bun test apps/sidecar/src/services/plugins/plugin-market-service.test.ts
```

### 3. Web detail page consumption

- [x] Add failing tests in `apps/web/src/components/skills/plugin-detail-state.test.ts`:
  - explicit `marketplace.setup` overrides inferred setup hints;
  - setup kind maps installed/enabled steps to `done` when applicable and interactive steps to `attention`.
- [x] Add failing test in `apps/web/src/components/skills/PluginDetailPage.test.tsx`:
  - plugin detail renders marketplace thumbnail/icon/link metadata and explicit setup copy.
- [x] Update `apps/web/src/components/skills/plugin-detail-state.ts`:
  - prefer explicit setup steps;
  - retain existing inferred fallback for plugins without metadata.
- [x] Update `apps/web/src/components/skills/PluginDetailPage.tsx`:
  - use `marketplace.icon.url` in the header icon when available;
  - render `marketplace.hero` or `marketplace.thumbnail` in the overview area;
  - render safe website/docs links when present;
  - avoid nested cards and keep the horizontal tab layout.
- [x] Verify:

```powershell
rtk bun test apps/web/src/components/skills/plugin-detail-state.test.ts apps/web/src/components/skills/PluginDetailPage.test.tsx
```

### 4. Current plugin packages

- [x] Update `D:\workspace\projects\ai-projects\lume-plugins\plugins\lume-chrome\lume-plugin.json`:
  - add `marketplace.icon`;
  - add `marketplace.thumbnail`;
  - add `marketplace.docs`;
  - add setup steps for Chrome extension install, Native Host install, Chrome availability, and browser authorization.
- [x] Add `D:\workspace\projects\ai-projects\lume-plugins\plugins\lume-chrome\assets\thumbnail.svg`.
- [x] Update `D:\workspace\projects\ai-projects\lume-plugins\plugins\lume-chrome\README.md` with the same user-facing setup flow.
- [x] Update `D:\workspace\projects\ai-projects\lume-plugins\plugins\obsidian-bridge\lume-plugin.json`:
  - add `marketplace.icon`;
  - add `marketplace.thumbnail`;
  - add `marketplace.docs`;
  - add setup steps for Obsidian plugin install, local bridge enablement, pairing code copy, and Lume pairing.
- [x] Add `D:\workspace\projects\ai-projects\lume-plugins\plugins\obsidian-bridge\assets\icon.svg`.
- [x] Add `D:\workspace\projects\ai-projects\lume-plugins\plugins\obsidian-bridge\assets\thumbnail.svg`.
- [x] Update `D:\workspace\projects\ai-projects\lume-plugins\plugins\obsidian-bridge\README.md` with the same setup flow.
- [x] Verify:

```powershell
Push-Location D:\workspace\projects\ai-projects\lume-plugins
node -e "const fs=require('fs'); for (const p of ['plugins/lume-chrome/lume-plugin.json','plugins/obsidian-bridge/lume-plugin.json']) JSON.parse(fs.readFileSync(p,'utf8')); console.log('plugin manifests ok')"
node -e "const fs=require('fs'); for (const p of ['plugins/lume-chrome/assets/thumbnail.svg','plugins/lume-chrome/extension/icons/icon128.png','plugins/obsidian-bridge/assets/icon.svg','plugins/obsidian-bridge/assets/thumbnail.svg']) { if (!fs.existsSync(p)) throw new Error(p); } console.log('plugin assets ok')"
Pop-Location
```

### 5. Final verification and commits

- [x] Run all focused verification commands from steps 1 to 4 after implementation.
- [x] Run a targeted type check only if TypeScript shape changes are not covered by the focused tests.
  - `@lume/shared`, `@lume/agent-sdk`, and `@lume/web` passed.
  - `@lume/sidecar` still reports existing test fixture errors where `AgentStreamEmitter` mocks lack `onBrowserAuthRequest`.
- [x] Inspect diffs in both repositories:

```powershell
git diff --stat
git diff -- D:\workspace\projects\ai-projects\lume-plugins
```

- [ ] Commit Lume core changes with a Lore-style commit message.
- [ ] Commit `lume-plugins` changes with a Lore-style commit message.
