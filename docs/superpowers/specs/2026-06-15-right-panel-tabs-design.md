# Right Panel Tabs Redesign

## Summary

Redesign the right panel as a thread-scoped multi-tab workspace. Each conversation thread owns its own right-panel tab set, and each supported function can appear at most once per thread: review, terminal, browser, and files.

The panel should feel like a browser-style work area, but not allow duplicate functional tabs. The `+` menu only shows functions that are not already open. Closing a function tab removes its state from the current thread; reopening it starts from that function's initial state.

## Context

The current right-panel experience has the right ingredients but a blurry interaction model:

- Empty state shows tool entries, but it feels disconnected from the tabbed experience.
- File preview has a preview area and a file tree, but the selected-file, empty-selection, and collapsed-tree states are not governed by a clear thread-level model.
- Browser controls and tab controls can visually compete with window-level controls.
- The `+` menu currently behaves like a generic launcher, but it should respect singleton function tabs.

Project context:

- Frontend is React + Jotai in `apps/web`.
- Existing tab primitives live around `apps/web/src/atoms/tab-atoms.ts` and `apps/web/src/components/tabs`.
- Older agent side-panel code still has useful file-preview patterns, but the redesigned interaction should be modeled as a thread-scoped right-panel workspace rather than the old agent-only side panel.

## Goals

- Make the right panel's mental model clear: a per-thread workspace with function tabs.
- Keep every function tab singleton within a thread.
- Preserve thread context: switching main threads restores that thread's right-panel tabs and active function.
- Keep the empty state useful by showing the tool launcher.
- Keep window-level controls separate from current-tab controls.
- Keep implementation small and reversible by adding the interaction model before broad visual polish.

## Non-Goals

- Do not redesign the main app tab system.
- Do not add new dependencies.
- Do not implement multiple browser pages inside the browser function tab.
- Do not add a command-palette-style `+` search yet.
- Do not redesign terminal or review internals beyond reserving their singleton function tabs.

## Chosen Direction

Use **Thread Workspace Tabs**.

Each thread has a right-panel workspace:

```ts
type RightPanelFunction = 'review' | 'terminal' | 'browser' | 'files'

interface ThreadRightPanelWorkspace {
  activeTab: RightPanelFunction | null
  tabs: Partial<Record<RightPanelFunction, RightPanelTabState>>
}
```

The function type is the tab identity. No random id is needed because each function can be open only once per thread.

`RightPanelTabState` is a discriminated union:

```ts
type RightPanelTabState =
  | ReviewTabState
  | TerminalTabState
  | BrowserTabState
  | FilesTabState

interface ReviewTabState {
  type: 'review'
}

interface TerminalTabState {
  type: 'terminal'
}
```

Review and terminal intentionally start with minimal state. They still participate in singleton creation, activation, close behavior, and thread restoration; their internal workflows can extend these state objects later without changing the right-panel workspace contract.

Default tab state:

```ts
const DEFAULT_RIGHT_PANEL_TAB_STATE = {
  review: { type: 'review' },
  terminal: { type: 'terminal' },
  browser: {
    type: 'browser',
    url: '',
    addressInput: '',
    zoom: 1,
    deviceToolbarVisible: false,
  },
  files: {
    type: 'files',
    selectedPath: null,
    treeVisible: true,
    searchQuery: '',
    enhancedView: true,
  },
} satisfies Record<RightPanelFunction, RightPanelTabState>
```

Rejected alternatives:

- **Fully browser-like tabs:** closer to a web browser, but it encourages duplicate file/browser tabs and weakens the tool-workspace model.
- **Minimal cleanup of the current layout:** lower risk, but it does not solve the main interaction ambiguity.

## Panel Layout

When a thread has no right-panel function tabs, show a tool launcher with:

1. Review
2. Terminal
3. Browser
4. Files

Clicking a launcher item creates that function tab for the current thread and activates it.

When at least one function tab exists:

- Show a top tab bar containing opened functions only.
- Render opened tabs in fixed function order: Review, Terminal, Browser, Files. Do not use creation order.
- Show `+` beside the opened tabs.
- `+` opens a menu containing only unopened functions.
- If all functions are open, keep `+` in place but disable it with a tooltip such as "全部功能已打开".
- Closing the active function activates the nearest remaining tab in fixed display order, preferring the next function to the right, then the nearest function to the left. If none remain, return to the launcher.

Window-level buttons stay at the far right:

- Expand / fullscreen
- Minimize / collapse
- Right-panel toggle

Current-tab actions must not be placed in the window-level control group. They belong in the active function's content toolbar.

## Ownership Boundaries

State helpers own the workspace rules. They should be pure and independently testable:

- `createDefaultRightPanelTab(type)` returns the default state for one function.
- `openRightPanelTab(workspace, type)` creates the function if missing and activates it; if it already exists, it only activates it.
- `closeRightPanelTab(workspace, type)` removes the function and chooses the next active function.
- `getAvailableRightPanelFunctions(workspace)` returns unopened functions for the `+` menu.
- `sanitizeRightPanelWorkspace(input)` normalizes persisted or legacy state.

Jotai atoms own persistence and per-thread lookup:

- Store workspaces as `Record<threadId, ThreadRightPanelWorkspace>`.
- Prefer a new `rightPanelWorkspacesAtom` in the web atoms layer, persisted under a dedicated key such as `right-panel-workspaces`.
- Keep this state separate from the main app tab system.
- Do not reuse the old `SidePanelView` as the source of truth for the redesigned workspace.

Presentation components own rendering only:

- `RightPanelWorkspace` selects the current thread's workspace and renders launcher or tab shell.
- `RightPanelTabBar` renders opened function tabs and the filtered `+` menu.
- `RightPanelLauncher` renders the empty-state tool launcher.
- `FilesRightPanelTab` owns file preview, file tree, and file toolbar.
- `BrowserRightPanelTab` owns browser address bar, browser content, and browser toolbar.
- `ReviewRightPanelTab` and `TerminalRightPanelTab` are placeholders or adapters until their internal designs are expanded.

Window-level controls remain outside the function tab components.

## Files Tab

The files tab uses a stable two-column layout:

- Left: preview area
- Right: file tree

No file selected:

- Keep the right file tree visible.
- Show an empty preview state on the left: "从右侧文件树选择文件".

File selected:

- Left side shows the file preview.
- Right file tree remains visible and highlights the selected file.
- Clicking another file in the tree updates the same files tab's `selectedPath`; it does not create another tab.

File tree collapsed:

- Preview expands to full width.
- The files tab toolbar keeps a visible file-tree button on the right side so the tree can be reopened.

Files tab state:

```ts
interface FilesTabState {
  type: 'files'
  selectedPath: string | null
  treeVisible: boolean
  searchQuery: string
  enhancedView: boolean
}
```

Files toolbar actions:

- Toggle file tree
- Open with system app
- More menu

Files more menu actions:

- Copy path
- Copy file contents
- Enable / disable enhanced view

These actions affect only the current files tab state.

## Browser Tab

The browser tab is a singleton browser for the current thread, primarily for agent operation.

Initial empty state:

- Show a local-service launcher if no URL has been set.
- Keep the address bar usable immediately.
- Local-service cards navigate the same browser tab.

Navigation:

- Entering a URL navigates the same browser tab.
- `+ -> Browser` is not available while the browser tab is already open.
- There is no "new browser page" action. The agent or user can type another URL into the same address bar when needed.

Browser toolbar:

- Back
- Forward
- Refresh
- Address bar
- Open in system browser
- More menu

Browser more menu actions:

- Force reload
- Show device toolbar
- Zoom controls
- Clear Cookie
- Clear cache

Browser tab state:

```ts
interface BrowserTabState {
  type: 'browser'
  url: string
  addressInput: string
  zoom: number
  deviceToolbarVisible: boolean
}
```

Although clearing Cookie or cache may affect the underlying webview environment, the entry point remains browser-tab scoped. Do not move these actions into a global panel menu.

## Review And Terminal Tabs

Review and terminal are also singleton function tabs.

For this design pass, they only need enough state to participate in:

- launcher creation
- tab switching
- close behavior
- `+` menu exclusion while open
- thread restoration

Their detailed internal interactions can be designed separately.

## Data Flow

Thread switch:

1. Main thread changes.
2. Right panel reads that thread's workspace state.
3. If it has tabs, render tab bar and active function.
4. If it has no tabs, render launcher.

Open function:

1. User clicks launcher or `+` menu.
2. If the function is already open, do nothing beyond activation. In the final UI this should only happen from non-menu callers because opened functions are hidden in the `+` menu.
3. If unopened, create default state for that function and activate it.

Close function:

1. Remove that function state from the current thread workspace.
2. If it was active, activate the nearest remaining function.
3. If no functions remain, set `activeTab` to `null` and show launcher.

File-tree selection:

1. User clicks a file in the files tab tree.
2. Update `files.selectedPath`.
3. Load preview into the same tab.

Browser navigation:

1. User or agent submits address.
2. Normalize URL.
3. Update browser state and navigate same browser surface.

## Migration And Invalid State

Persisted state must be treated as untrusted input and sanitized before rendering.

Sanitization rules:

- If a thread workspace is missing or malformed, replace it with `{ activeTab: null, tabs: {} }`.
- Drop any tab whose key is not one of `review`, `terminal`, `browser`, or `files`.
- Drop any tab whose stored `type` does not match its key.
- Fill missing fields with that function's default state.
- Clamp browser `zoom` to a supported range chosen during implementation; if invalid, reset to `1`.
- If `activeTab` is not one of the remaining open functions, set it to the first remaining function in display order.
- If no functions remain, set `activeTab` to `null`.

Legacy state:

- Existing `agentSidePanelViewAtom` can be used only as a migration hint. If it says a thread had files open, migration may create a files tab for that thread.
- Existing `agentFileTreeOpenAtom` can map to `files.treeVisible` when a migrated files tab is created.
- After migration, the new right-panel workspace state is the only source of truth.
- If migration is ambiguous, prefer a clean launcher over guessing and opening a tab unexpectedly.

## Error Handling

- File preview read failure shows an error in the preview area only.
- File tree load failure shows an error and retry affordance in the tree area.
- Browser navigation failure shows an error in the browser content area and preserves the address input.
- Closing a tab should never close the entire right panel unless it was the last tab; then the panel returns to launcher.
- If a thread's persisted workspace references an unsupported function, ignore that function and keep the rest of the workspace according to the sanitization rules above.

## Testing

Add focused tests for stateful interaction logic:

- Opening a function creates exactly one tab for that function.
- Already-open functions are excluded from the `+` menu.
- Closing a function makes it available in the `+` menu again.
- Closing the active function activates a nearby remaining tab.
- Closing the last function returns to launcher.
- Switching threads restores each thread's right-panel workspace independently.
- Files tab tree toggle persists in the current thread's files tab state.
- Selecting files from the file tree reuses the files tab rather than creating tabs.
- Sanitization drops unsupported or malformed tabs.
- Sanitization repairs invalid `activeTab` values.
- Legacy file-side-panel state can migrate to an initial files tab without becoming the long-term source of truth.

No full lint, typecheck, or broad visual tests are required for this design document. During implementation, run only focused tests for changed state helpers and UI contracts.

## Remaining Risks

- The current code has both older agent side-panel concepts and newer tab components. Implementation should avoid mixing the old `SidePanelView` state with the new thread workspace model unless a migration path is explicit.
- The browser tab is intended for agent operation, so user-facing browser affordances should stay practical and not become a full browser product.
- Persisted state migration needs care if existing users already have right-panel or file-tree storage keys.
