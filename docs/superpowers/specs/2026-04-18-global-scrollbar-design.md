# Global Scrollbar Design

## Goal

Unify scrollbar behavior across `apps/web` so application surfaces use a consistent, low-visibility scrollbar that stays mostly hidden and becomes visible during hover and active scrolling.

The intent is to stop relying on mixed native browser scrollbars and ad-hoc `scrollbar-none` usage, and instead route core app scroll regions through one shared scroll container.

## Scope

This change applies to `apps/web` application UI surfaces that currently use native overflow containers.

Initial rollout targets:

- `apps/web/src/components/agent/AgentMessages.tsx`
- `apps/web/src/components/agent/TaskProgressPanel.tsx`
- `apps/web/src/components/app-shell/LeftSidebar.tsx`
- `apps/web/src/components/file-browser/FileBrowser.tsx`
- `apps/web/src/components/tabs/TabBar.tsx`

Out of scope for this pass:

- Third-party components with their own internal scrolling model
- Code block rendering internals
- Editor-like surfaces that require custom scrolling semantics

## Design

### Shared Scroll Primitive

The existing shared scroll primitive at `apps/web/src/components/ui/scroll-area.tsx` becomes the single source of truth for app-level scrolling behavior.

It will be enhanced so that:

- scrollbar thumb is visually subtle by default
- scrollbar becomes visible when the scroll container is hovered
- scrollbar becomes visible while the user is actively scrolling
- scrollbar fades back out after scrolling stops
- both vertical and horizontal scrollbars use the same interaction model

This keeps scrollbar behavior local to the shared component instead of depending on fragile global browser scrollbar overrides.

### Visibility Model

Default state:

- track is transparent
- thumb is transparent or nearly transparent
- layout still reserves the scrollbar interaction surface through the component, not through native global hacks

Interactive states:

- on hover, thumb and track increase opacity
- on scroll activity, thumb becomes visible immediately
- after a short idle delay, opacity transitions back to the default hidden state

This gives the “mostly invisible, appears on demand” behavior without making scroll affordances disappear entirely.

### Styling Strategy

The visual rules stay centralized in the scroll component and a small set of global CSS tokens.

`apps/web/src/index.css` should only hold shared variables or minimal support styles, such as:

- thumb color
- hover thumb color
- track tint
- radius
- transition timing

It should not become the primary implementation surface for scrollbar behavior.

### Migration Strategy

Current containers using:

- `overflow-y-auto`
- `overflow-x-auto`
- `scrollbar-none`

will be migrated to use the shared scroll component.

This is the preferred direction because it removes hidden divergence between panels and makes future scroll surfaces consistent by default.

For each migrated panel:

- keep existing sizing and flex behavior intact
- move padding/content wrappers as needed so layout remains unchanged
- remove `scrollbar-none` where the shared component takes over

## Component Impact

### Agent Messages

`AgentMessages.tsx` is high-risk because it likely depends on precise scroll behavior and auto-scroll-to-bottom logic.

Requirements:

- preserve current auto-scroll behavior
- preserve message spacing and padding
- avoid introducing nested scroll containers

### Plan Panel

`TaskProgressPanel.tsx` should move cleanly to the shared scroll area with low risk.

### Left Sidebar

`LeftSidebar.tsx` should use the same primitive so the shell navigation area matches the rest of the app.

### File Browser

`FileBrowser.tsx` should inherit the same scrollbar treatment while keeping tree interactions unchanged.

### Tab Bar

`TabBar.tsx` is horizontally scrollable and needs the same behavior for horizontal bars.

Requirements:

- preserve current overflow interaction
- keep drag/wheel/touchpad behavior smooth
- avoid making the horizontal thumb visually noisy

## Risks

Primary risks:

- regressions in auto-scroll behavior for chat/message surfaces
- accidental nested scrolling after wrapper changes
- horizontal tab scrolling becoming less usable
- Radix scroll area styling not matching both light and dark themes cleanly

## Verification

Required verification after implementation:

1. Confirm each migrated surface still scrolls correctly.
2. Confirm scrollbar is low-visibility by default.
3. Confirm scrollbar becomes visible on hover.
4. Confirm scrollbar becomes visible during active scrolling and fades after idle.
5. Confirm light and dark themes both look correct.
6. Confirm chat/message panels still auto-scroll correctly.
7. Confirm horizontal tab scrolling still feels natural.

## Decision

Adopt shared-component unification rather than global native scrollbar overrides.

Reasoning:

- better consistency across app surfaces
- easier future reuse
- fewer browser-specific hacks
- clearer ownership of scrollbar behavior
