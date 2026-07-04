# Plugin Detail README and Setup Tabs Design

- Date: 2026-07-04
- Repo: `D:\workspace\projects\ai-projects\lume`
- Status: approved for planning

## Goal

Make the plugin detail dialog useful for installation decisions and post-install setup by showing the plugin README and moving setup, permissions, and diagnostics into horizontal content tabs.

Chrome and Obsidian plugins both need a clearer user path:

- Chrome needs bridge setup, native host checks, extension status, and runtime `browserAuth` for page credentials.
- Obsidian needs bridge pairing, token storage, Vault binding, and runtime confirmation for protected writes.

The detail dialog should explain the plugin first, then expose setup and risk details without making users scan a dense permission-only panel.

## Scope

In scope:

- Add README data to plugin detail results.
- Render plugin detail content with horizontal tabs in the main content area.
- Keep install, update, and uninstall actions fixed in the dialog footer.
- Preserve the existing permission summary and diagnostics content by moving them into tabs.
- Add a Setup tab as the stable home for install-time connection and authorization flows.

Out of scope:

- Building the full Chrome or Obsidian setup wizard.
- Changing plugin install permissions semantics.
- Adding README content to the marketplace catalog list response.
- Creating a separate plugin detail page.
- Rendering arbitrary remote HTML.

## Design

The plugin detail dialog keeps its current modal shell. The content area gets a horizontal tab row:

1. `README`
2. `Setup`
3. `权限`
4. `诊断`

`README` is the default tab. If no README exists or it fails to load, the tab stays selected and shows an empty state with a short explanation. The dialog should not auto-jump to another tab, because silent tab switching makes the detail view feel inconsistent.

`Setup` explains and later hosts install-time actions that make the plugin usable:

- Chrome: extension installation status, native host detection or repair, browser bridge connection.
- Obsidian: pairing code input, token save, Vault binding confirmation, reconnect or repair entry.

For the first implementation, Setup is an informational checklist backed by available plugin metadata and diagnostics. It does not mutate settings or store secrets yet. Interactive repair, pairing, and credential storage are a follow-up that should add explicit setup descriptors rather than infer actions from README text.

`权限` contains the existing permission audit section: risk labels, permission rows, and permission hash.

`诊断` contains existing plugin diagnostics and future connection/setup errors.

The footer remains outside the tab panel. Install, update, and uninstall controls stay visible regardless of active tab.

## Data Flow

The marketplace catalog remains lightweight and keeps using manifest/index fields only.

When the user opens a plugin detail dialog:

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

## Rendering

The Web side should render markdown safely as markdown, not raw HTML. The first implementation can use an existing markdown renderer if one is already present. If there is no existing safe renderer, use a conservative markdown preview that supports common text structure and code fences without adding a new dependency.

The tab controls should use the existing global UI primitives in `apps/web/src/components/ui`, especially the shadcn/global `Tabs` component already present in the repo.

## Error Handling

- Missing `README.md`: show an empty README state.
- README too large: truncate after 256 KiB and show a truncation note.
- Remote README fetch failure: keep the dialog open, show README empty state, and add a diagnostic if the error is actionable.
- Plugin inspection failure: keep existing detail error behavior.

## Testing

Only test the behavior-bearing pieces:

- Sidecar detail API returns README for local plugin sources.
- Sidecar detail API tolerates missing README.
- Web state/rendering routes plugin detail tabs without hiding footer actions.
- Existing permission rows still render in the `权限` tab.

Pure styling changes do not need broad test runs.

## Implementation Defaults

- README size limit: 256 KiB.
- Setup tab source: first version uses inspected plugin metadata, known capability summaries, and diagnostics only.
- Manifest schema: no new `lume-plugin.json` setup field in this first implementation.
- Secret storage: out of scope for this change; Obsidian tokens and similar credentials must not be added until a dedicated setup wizard design chooses the storage path.
