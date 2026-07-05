# Plugin Marketplace Metadata Design

## Goal

Make plugin detail pages use explicit marketplace metadata instead of inferring all setup and visual behavior from permissions. The first consumers are `lume-chrome` and `obsidian-bridge`, which need richer detail pages for screenshots/thumbnails and guided authorization or pairing.

This design extends the plugin manifest contract, carries the metadata through the existing SDK/shared/sidecar/web detail chain, and updates the two local plugins in `D:\workspace\projects\ai-projects\lume-plugins`.

## Scope

In scope:
- Add optional manifest metadata for marketplace presentation.
- Surface icon/thumbnail/hero-style assets and setup steps on `PluginMarketItem`.
- Prefer explicit setup steps in `PluginDetailPage`, with the current permission-based fallback kept for older plugins.
- Improve `lume-chrome` and `obsidian-bridge` manifests and README/setup content.
- Support local package-relative asset paths only in the first version.

Out of scope:
- Remote image downloading, caching, resizing, or proxying.
- Screenshot carousel UI.
- A full install wizard state machine.
- Runtime pairing implementation changes for Obsidian or browser auth implementation changes for Chrome.

## Manifest Contract

Add an optional top-level `marketplace` object to `lume-plugin.json`:

```json
{
  "marketplace": {
    "icon": "./assets/icon.png",
    "thumbnail": "./assets/thumbnail.png",
    "hero": "./assets/hero.png",
    "website": "https://example.com",
    "docs": "./README.md",
    "setup": [
      {
        "id": "install-extension",
        "title": "安装 Chrome 扩展",
        "description": "安装扩展并确认 Native Host 已连接。",
        "kind": "browser-auth"
      }
    ]
  }
}
```

Field rules:
- `icon`, `thumbnail`, `hero`, and `docs` must be relative plugin paths beginning with `./`.
- `website` is an optional external URL string. It is displayed as a link only; it is not fetched during detail loading.
- `setup` is an ordered array. Each item needs stable `id`, `title`, and `description`.
- `setup.kind` is optional and limited to presentation hints: `install`, `enable`, `browser-auth`, `pairing-code`, `local-service`, `mcp`, or `custom`.
- Unknown executable or runtime fields remain unsupported and should still produce diagnostics; `marketplace` itself is a recognized non-executable metadata field.

The SDK should parse this field into a typed `PluginMarketplaceMetadata` shape and preserve it on `NormalizedPlugin`. It should not influence permission hashes or runtime capability registration.

## Shared API

Add shared types:

```ts
interface PluginMarketplaceAsset {
  path: string
  url?: string
}

interface PluginSetupStep {
  id: string
  title: string
  description: string
  kind?: "install" | "enable" | "browser-auth" | "pairing-code" | "local-service" | "mcp" | "custom"
}

interface PluginMarketplaceMetadata {
  icon?: PluginMarketplaceAsset
  thumbnail?: PluginMarketplaceAsset
  hero?: PluginMarketplaceAsset
  website?: string
  docs?: string
  setup?: PluginSetupStep[]
}
```

`PluginMarketItem` gains optional `marketplace?: PluginMarketplaceMetadata`.
`InspectPluginResult.normalized` may include enough metadata for detail responses, or the sidecar can copy it from the normalized plugin before returning `PluginMarketItem`.

Asset `url` is optional because the source differs by plugin source:
- Local and subscribed-local plugin sources can expose a filesystem-backed app URL or sidecar asset URL only if such helper already exists.
- If no safe display URL exists in the current codebase, the first implementation can carry `path` only and display a non-image fallback. The field still establishes the manifest contract for plugin authors.

## Sidecar Data Flow

`PluginMarketService` already resolves marketplace items through `inspectPluginSource` and `toMarketItem`.

Changes:
1. `parseManifest` accepts and validates `marketplace`.
2. `normalizePluginManifests` preserves `marketplace` on `NormalizedPlugin`.
3. `toMarketItem` copies `plugin.marketplace` into `PluginMarketItem`.
4. `getMarketDetail` returns the same metadata for details.
5. Existing README preview loading remains separate. `marketplace.docs` is a hint for authors and future UI; the current README lookup still reads `README.md`/`readme.md`.

Validation should stay conservative:
- Bad relative paths are rejected by the manifest parser, using the existing path validation style.
- Bad setup items are ignored or produce diagnostics instead of crashing the entire market catalog if the surrounding code already prefers resilient catalog loading.

## Web UI

`PluginDetailPage` should use metadata in these places:
- Header visual: prefer `marketplace.icon` when renderable; otherwise keep the existing `Puzzle` icon.
- Media band: prefer `marketplace.hero`, then `marketplace.thumbnail`; otherwise keep the current plain layout or generated color panel.
- Setup tab: if `marketplace.setup` exists and is non-empty, render those steps. Otherwise call `buildPluginSetupItems`.
- Overview tab: show website/docs links only when present and safe to display.

Setup step statuses remain derived from install/enable state only at the generic level:
- The install and enable steps can be marked done based on existing state.
- Custom metadata steps are shown as `attention` until Lume has runtime state for them.

The UI should not run commands, open URLs, install native hosts, or submit pairing codes from these metadata fields in this phase.

## Plugin Updates

### `lume-chrome`

Manifest additions:
- `marketplace.icon`: reuse `./extension/icons/icon128.png`.
- `marketplace.thumbnail`: add a small package asset if no suitable one exists.
- `marketplace.docs`: `./README.md`.
- `marketplace.setup`:
  - Install Chrome extension.
  - Install or verify Native Host.
  - Open Chrome and keep Lume running.
  - Confirm browser authorization prompts for sensitive actions.

README updates:
- Add a short "Setup in Lume" section that mirrors the setup steps.
- Keep existing technical details, but place user-facing installation requirements earlier.

### `obsidian-bridge`

Manifest additions:
- `marketplace.icon` and `marketplace.thumbnail`: add simple local assets under `./assets/`.
- `marketplace.docs`: `./README.md`.
- `marketplace.setup`:
  - Build/install the Obsidian community plugin files.
  - Enable the plugin inside Obsidian.
  - Copy the generated pairing code from Obsidian settings.
  - Complete pairing from Lume when prompted.

README updates:
- Clarify the two-sided install flow: Obsidian side first, then Lume side.
- Keep the local-only network and token/pairing security model visible.

## Testing

Core repo:
- SDK manifest parsing test for valid `marketplace`.
- SDK test for rejecting invalid relative asset paths.
- Shared/sidecar plugin market service test that `marketplace.setup` and asset paths appear in `getMarketDetail`.
- Web helper test that explicit setup steps override inferred setup.
- `PluginDetailPage` render test for explicit setup and metadata links.
- Existing plugin detail tests should continue to pass for plugins without `marketplace`.

Plugin repo:
- JSON validation or existing packaging tests should include the updated manifests.
- If no manifest validation test exists in `lume-plugins`, run the nearest package tests for `lume-chrome` and `obsidian-bridge` that do not require external Chrome/Obsidian runtime.

## Risks

- Asset display may need an existing sidecar file URL helper. If none exists, the first implementation should still carry metadata and defer image rendering rather than adding a new asset server.
- `setup.kind` is a display hint, not a workflow engine. Users may expect it to perform actions; UI copy should stay clear that these are steps.
- The `lume-plugins` repository may have its own formatting or release workflow. Keep plugin changes small and avoid rebuilding generated `dist` unless tests or packaging require it.
