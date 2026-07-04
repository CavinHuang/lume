# Plugin Detail Page README and Setup Tabs Design

- Date: 2026-07-04
- Repo: `D:\workspace\projects\ai-projects\lume`
- Status: approved for planning

## Goal

Make the plugin detail page useful for installation decisions and post-install setup by showing the plugin README and moving setup, permissions, and diagnostics into horizontal content tabs.

Chrome and Obsidian plugins both need a clearer user path:

- Chrome needs bridge setup, native host checks, extension status, and runtime `browserAuth` for page credentials.
- Obsidian needs bridge pairing, token storage, Vault binding, and runtime confirmation for protected writes.

The detail page should explain the plugin first, then expose setup and risk details without making users scan a dense permission-only panel.

## Scope

In scope:

- Add README data to plugin detail results.
- Replace the plugin detail dialog with an independent plugin detail page.
- Render plugin detail page content with horizontal tabs in the main content area.
- Keep install, update, uninstall, enable, and "try in chat" actions in the page header.
- Preserve the existing permission summary and diagnostics content by moving them into tabs.
- Add a Setup tab as the stable home for install-time connection and authorization flows.

Out of scope:

- Building the full Chrome or Obsidian setup wizard.
- Changing plugin install permissions semantics.
- Adding README content to the marketplace catalog list response.
- Rendering arbitrary remote HTML.

## Design

The plugin detail surface becomes a dedicated page instead of a modal. Market cards and installed-plugin entries navigate to the page, for example `插件 > Browser`.

The low-fidelity layout reference is `docs/superpowers/specs/2026-07-04-plugin-detail-page-wireframe.svg`.

The page uses a centered content column, roughly matching the reference width rather than a full-width dashboard layout. The top area contains:

- Breadcrumb: `插件 > {plugin name}`.
- Plugin icon, name, short description, and version/source badges.
- Primary action button: installed/enabled plugins can show `在对话中试用`; not-installed plugins show install/update actions.
- Secondary menu for less common actions, such as uninstall, disable, copy plugin id, or open source.
- Optional hero/banner block. If the plugin has no hero asset, use a restrained generated placeholder from plugin metadata rather than requiring new manifest fields.

The content area gets a horizontal tab row:

1. `README`
2. `Setup`
3. `权限`
4. `诊断`

`README` is the default tab. If no README exists or it fails to load, the tab stays selected and shows an empty state with a short explanation. The page should not auto-jump to another tab, because silent tab switching makes the detail view feel inconsistent.

`Setup` explains and later hosts install-time actions that make the plugin usable:

- Chrome: extension installation status, native host detection or repair, browser bridge connection.
- Obsidian: pairing code input, token save, Vault binding confirmation, reconnect or repair entry.

For the first implementation, Setup is an informational checklist backed by available plugin metadata and diagnostics. It does not mutate settings or store secrets yet. Interactive repair, pairing, and credential storage are a follow-up that should add explicit setup descriptors rather than infer actions from README text.

`权限` contains the existing permission audit section: risk labels, permission rows, and permission hash.

`诊断` contains existing plugin diagnostics and future connection/setup errors.

There is no sidebar. The tabs are horizontal and live in the content column. Header actions stay visible above the tab panel and do not depend on the active tab.

## Data Flow

The marketplace catalog remains lightweight and keeps using manifest/index fields only.

When the user opens a plugin detail page:

1. Web calls `GET_MARKET_DETAIL`.
2. Sidecar resolves and inspects the plugin source.
3. Sidecar attempts to read `README.md` from the plugin root.
4. The response includes:

```ts
readme?: {
  markdown: string
  path?: string
}
```

For local sources, `path` is the local README path. For GitHub or subscribed-market sources, `path` can be the source-relative path or omitted if not cheaply available.

README read failures should not fail the whole detail request. They should become a missing README state or a non-blocking diagnostic.

Navigation should preserve enough state to return to the previous plugin list/filter when possible, but the detail page must also work from a direct route or deep link.

## Rendering

The Web side should render markdown safely as markdown, not raw HTML. The first implementation can use an existing markdown renderer if one is already present. If there is no existing safe renderer, use a conservative markdown preview that supports common text structure and code fences without adding a new dependency.

The tab controls should use the existing global UI primitives in `apps/web/src/components/ui`, especially the shadcn/global `Tabs` component already present in the repo.

## Error Handling

- Missing `README.md`: show an empty README state.
- README too large: truncate after 256 KiB and show a truncation note.
- Remote README fetch failure: keep the page open, show README empty state, and add a diagnostic if the error is actionable.
- Plugin inspection failure: keep existing detail error behavior.

## Testing

Only test the behavior-bearing pieces:

- Sidecar detail API returns README for local plugin sources.
- Sidecar detail API tolerates missing README.
- Web navigation opens a plugin detail page from a market item.
- Web state/rendering routes plugin detail tabs without hiding header actions.
- Existing permission rows still render in the `权限` tab.

Pure styling changes do not need broad test runs.

## Implementation Defaults

- README size limit: 256 KiB.
- Setup tab source: first version uses inspected plugin metadata, known capability summaries, and diagnostics only.
- Manifest schema: no new `lume-plugin.json` setup field in this first implementation.
- Layout: independent detail page, centered content column, no sidebar, horizontal tabs in the content area.
- Secret storage: out of scope for this change; Obsidian tokens and similar credentials must not be added until a dedicated setup wizard design chooses the storage path.
