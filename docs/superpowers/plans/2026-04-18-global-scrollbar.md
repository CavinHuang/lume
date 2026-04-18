# Global Scrollbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify `apps/web` scroll behavior behind the shared `ScrollArea` primitive so scrollbars stay low-visibility by default and appear on hover or active scrolling.

**Architecture:** Enhance the shared `ScrollArea` component to own scrollbar visibility and interaction state, then migrate the main app scroll surfaces from native `overflow-* + scrollbar-none` containers to the shared primitive. Keep global CSS minimal and use it only for shared tokens and fallback support.

**Tech Stack:** React, TypeScript, Tailwind CSS, `@base-ui/react/scroll-area`, Bun

---

## File Structure

### Shared primitive and global style

- Modify: `apps/web/src/components/ui/scroll-area.tsx`
  - Centralize hover/scroll-active visual behavior for vertical and horizontal scrollbars.
- Modify: `apps/web/src/index.css`
  - Remove obsolete scrollbar hiding assumptions from migrated surfaces and add only shared scrollbar tokens/fallback styles.

### Application surfaces to migrate

- Modify: `apps/web/src/components/agent/AgentMessages.tsx`
  - Replace the native scroll container while preserving chat auto-scroll and scroll memory.
- Modify: `apps/web/src/components/agent/PlanPanel.tsx`
  - Use the shared scroll primitive for the plan step list.
- Modify: `apps/web/src/components/app-shell/LeftSidebar.tsx`
  - Use the shared scroll primitive for the thread list area.
- Modify: `apps/web/src/components/file-browser/FileBrowser.tsx`
  - Use the shared scroll primitive for the file tree pane.
- Modify: `apps/web/src/components/tabs/TabBar.tsx`
  - Use the shared scroll primitive for horizontal tab overflow.

### Verification

- Reuse existing project verification:
  - `bun run --filter @lume/web build`
- Manual verification in the app:
  - hover reveal
  - active scrolling reveal/fade
  - chat auto-scroll
  - horizontal tab scrolling
  - light/dark theme

---

### Task 1: Upgrade The Shared Scroll Primitive

**Files:**
- Modify: `apps/web/src/components/ui/scroll-area.tsx`
- Modify: `apps/web/src/index.css`

- [ ] **Step 1: Inspect the current shared scroll primitive and note missing behavior**

Read:

```tsx
// apps/web/src/components/ui/scroll-area.tsx
<ScrollAreaPrimitive.Root className="relative">
  <ScrollAreaPrimitive.Viewport className="size-full rounded-[inherit] ..." />
  <ScrollBar />
</ScrollAreaPrimitive.Root>
```

Confirm the current version:

- always renders a visible thumb
- does not track active scrolling state
- does not distinguish app-level styling from fallback global CSS

- [ ] **Step 2: Add local scroll-activity state to the shared primitive**

Implement minimal behavior in `apps/web/src/components/ui/scroll-area.tsx`:

```tsx
const [scrolling, setScrolling] = React.useState(false)
const idleTimerRef = React.useRef<number | null>(null)

const markScrolling = React.useCallback(() => {
  setScrolling(true)
  if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current)
  idleTimerRef.current = window.setTimeout(() => {
    setScrolling(false)
    idleTimerRef.current = null
  }, 480)
}, [])
```

Thread this state onto the root element with a data attribute:

```tsx
<ScrollAreaPrimitive.Root
  data-slot="scroll-area"
  data-scrolling={scrolling ? "true" : "false"}
  className={cn("group/scrollarea relative", className)}
>
```

- [ ] **Step 3: Attach the activity state to viewport scroll events**

Update the viewport in `apps/web/src/components/ui/scroll-area.tsx`:

```tsx
<ScrollAreaPrimitive.Viewport
  data-slot="scroll-area-viewport"
  onScroll={() => {
    markScrolling()
    props.onScroll?.()
  }}
  className="size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1"
>
```

If `onScroll` is already part of the forwarded props, preserve it instead of replacing it.

- [ ] **Step 4: Restyle the shared scrollbar for hidden-by-default behavior**

Update `ScrollBar` and `Thumb` classes in `apps/web/src/components/ui/scroll-area.tsx` so the scrollbar is mostly invisible until hover or active scroll:

```tsx
className={cn(
  "flex touch-none select-none p-px transition-[opacity,background-color] duration-200",
  "opacity-0 group-hover/scrollarea:opacity-100 group-data-[scrolling=true]/scrollarea:opacity-100",
  "data-horizontal:h-2.5 data-horizontal:flex-col",
  "data-vertical:h-full data-vertical:w-2.5",
  className
)}
```

```tsx
className={cn(
  "relative flex-1 rounded-full bg-border/25 transition-colors duration-200",
  "group-hover/scrollarea:bg-border/70 group-data-[scrolling=true]/scrollarea:bg-border/80"
)}
```

Keep the values aligned with the existing monochrome visual system. Do not introduce a new color family.

- [ ] **Step 5: Add only minimal global scrollbar support styles**

In `apps/web/src/index.css`, add shared scrollbar tokens and fallback rules only. Keep them small:

```css
:root {
  --app-scrollbar-thumb: color-mix(in oklab, var(--border) 78%, transparent);
  --app-scrollbar-thumb-active: color-mix(in oklab, var(--foreground) 22%, var(--border));
  --app-scrollbar-track: transparent;
}
```

Avoid global `::-webkit-scrollbar` behavior as the primary implementation. Use it only for fallback if absolutely needed.

- [ ] **Step 6: Build the web package to catch typing or import regressions**

Run:

```bash
bun run --filter @lume/web build
```

Expected: build succeeds with no TypeScript or import errors from `scroll-area.tsx` or `index.css`.

- [ ] **Step 7: Commit the shared primitive update**

```bash
git add apps/web/src/components/ui/scroll-area.tsx apps/web/src/index.css
git commit -m "feat: unify shared scrollbar behavior"
```

---

### Task 2: Migrate Vertical Scroll Surfaces

**Files:**
- Modify: `apps/web/src/components/agent/AgentMessages.tsx`
- Modify: `apps/web/src/components/agent/PlanPanel.tsx`
- Modify: `apps/web/src/components/app-shell/LeftSidebar.tsx`
- Modify: `apps/web/src/components/file-browser/FileBrowser.tsx`

- [ ] **Step 1: Migrate `AgentMessages` to the shared `ScrollArea`**

Replace the outer native scroll container in `apps/web/src/components/agent/AgentMessages.tsx`:

```tsx
return (
  <ScrollArea className="flex-1">
    <div ref={containerRef} className="px-4 py-4 space-y-2">
      {items}
      <div ref={bottomRef} />
    </div>
  </ScrollArea>
)
```

Preserve:

- `containerRef` access for scroll memory and near-bottom checks
- `bottomRef` auto-scroll target
- existing spacing and padding

Do not leave both the old native scroll container and the new `ScrollArea` in place.

- [ ] **Step 2: Adapt `AgentMessages` scroll helpers to the new DOM structure**

If `containerRef` can no longer point at the actual scrollable node after the migration, update it so the helper logic still references the viewport element.

Use a wrapper ref shape like:

```tsx
const viewportRef = useRef<HTMLDivElement>(null)
```

and wire `save`, `restore`, `scrollTop`, and `scrollHeight` calculations to the actual scrolling element.

Run through the existing logic and make sure these still target the scrollable element:

```tsx
save(prevThreadIdRef.current, viewportRef.current)
restore(threadId, viewportRef.current)
el.scrollHeight - el.scrollTop - el.clientHeight < 100
```

- [ ] **Step 3: Migrate `PlanPanel` to the shared `ScrollArea`**

Update `apps/web/src/components/agent/PlanPanel.tsx`:

```tsx
<ScrollArea className="flex-1">
  <div className="px-3 py-2 space-y-1">
    {plan.steps.map(...)}
  </div>
</ScrollArea>
```

Keep the active-step `scrollIntoView` target inside the scrollable viewport.

- [ ] **Step 4: Migrate `LeftSidebar` thread list to the shared `ScrollArea`**

Update `apps/web/src/components/app-shell/LeftSidebar.tsx`:

```tsx
<ScrollArea className="flex-1">
  <div className="px-3 pt-2 pb-3">
    {groups.map(...)}
  </div>
</ScrollArea>
```

Do not move the header, workspace selector, new-thread button, or footer settings button into the scrollable area.

- [ ] **Step 5: Migrate `FileBrowser` to the shared `ScrollArea`**

Update `apps/web/src/components/file-browser/FileBrowser.tsx`:

```tsx
<ScrollArea className="flex-1">
  <div className="px-2 py-2">
    {entries.map(...)}
  </div>
</ScrollArea>
```

Preserve refresh behavior and nested tree expansion behavior exactly as-is.

- [ ] **Step 6: Build the web package after vertical-panel migration**

Run:

```bash
bun run --filter @lume/web build
```

Expected: build succeeds and the migrated panels compile cleanly.

- [ ] **Step 7: Manually verify the vertical panels in the running app**

Check:

```text
1. Agent message list still auto-scrolls near the bottom while streaming
2. Switching threads still restores previous scroll position
3. Plan panel scrolls and auto-focuses the active step
4. Sidebar thread list scrolls with hidden-by-default scrollbar
5. File browser tree scrolls without nested scroll glitches
```

Expected: all five behaviors work and the scrollbar is only obvious on hover or active scroll.

- [ ] **Step 8: Commit the vertical-panel migration**

```bash
git add apps/web/src/components/agent/AgentMessages.tsx apps/web/src/components/agent/PlanPanel.tsx apps/web/src/components/app-shell/LeftSidebar.tsx apps/web/src/components/file-browser/FileBrowser.tsx
git commit -m "feat: migrate app panels to shared scroll area"
```

---

### Task 3: Migrate Horizontal Tab Overflow

**Files:**
- Modify: `apps/web/src/components/tabs/TabBar.tsx`

- [ ] **Step 1: Replace native horizontal overflow in `TabBar`**

Update `apps/web/src/components/tabs/TabBar.tsx`:

```tsx
<ScrollArea className="w-full" orientation="horizontal">
  <div className="flex items-center gap-1 px-2 pt-2 w-max min-w-full">
    {tabs.map(...)}
  </div>
</ScrollArea>
```

If the current primitive API needs a horizontal scrollbar rendered explicitly, wire that through the shared component instead of reintroducing native overflow.

- [ ] **Step 2: Make sure the tab strip keeps its current layout contract**

Preserve these behaviors:

```text
- tabs remain on one line
- the active tab styling does not change
- the strip expands naturally with tab count
- close buttons remain clickable
```

Do not wrap tabs onto multiple lines.

- [ ] **Step 3: Build the web package after tab migration**

Run:

```bash
bun run --filter @lume/web build
```

Expected: build succeeds and `TabBar.tsx` compiles with the shared scroll primitive.

- [ ] **Step 4: Manually verify horizontal scrolling**

Check:

```text
1. Long tab sets are horizontally scrollable
2. Hovering the tab strip reveals a subtle horizontal scrollbar
3. Scrolling the strip reveals the scrollbar and then fades it
4. Clicking a tab or close button still works normally
```

Expected: all four checks pass with no layout jump or clipped controls.

- [ ] **Step 5: Commit the tab-bar migration**

```bash
git add apps/web/src/components/tabs/TabBar.tsx
git commit -m "feat: migrate tab overflow to shared scroll area"
```

---

### Task 4: Cleanup And Final Verification

**Files:**
- Modify: `apps/web/src/index.css`
- Modify: `apps/web/src/components/agent/AgentMessages.tsx`
- Modify: `apps/web/src/components/agent/PlanPanel.tsx`
- Modify: `apps/web/src/components/app-shell/LeftSidebar.tsx`
- Modify: `apps/web/src/components/file-browser/FileBrowser.tsx`
- Modify: `apps/web/src/components/tabs/TabBar.tsx`

- [ ] **Step 1: Remove obsolete `scrollbar-none` usage from migrated surfaces**

Delete the old class usage from the migrated app surfaces:

```tsx
className="... scrollbar-none"
```

Only keep `scrollbar-none` in places that are intentionally still using native overflow outside the new shared primitive rollout.

- [ ] **Step 2: Keep global CSS aligned with the shared-component design**

Confirm `apps/web/src/index.css` no longer implies that app-level scrollbars should be globally hidden.

The resulting global CSS should:

- keep shared tokens
- keep any harmless fallback utility
- avoid fighting the shared `ScrollArea` component

- [ ] **Step 3: Run final web build**

Run:

```bash
bun run --filter @lume/web build
```

Expected: build succeeds.

- [ ] **Step 4: Run final manual regression pass**

Check the app in both themes:

```text
1. Scrollbars are low-visibility by default
2. Hover reveals scrollbar in every migrated surface
3. Active scrolling reveals scrollbar and fades after idle
4. Agent message streaming still auto-scrolls correctly
5. Thread switching still restores message scroll position
6. Sidebar, plan panel, file browser, and tab strip all scroll correctly
7. Light and dark theme contrast both look intentional
```

Expected: all seven checks pass.

- [ ] **Step 5: Commit the cleanup pass**

```bash
git add apps/web/src/index.css apps/web/src/components/agent/AgentMessages.tsx apps/web/src/components/agent/PlanPanel.tsx apps/web/src/components/app-shell/LeftSidebar.tsx apps/web/src/components/file-browser/FileBrowser.tsx apps/web/src/components/tabs/TabBar.tsx apps/web/src/components/ui/scroll-area.tsx
git commit -m "chore: clean up global scrollbar styling"
```

---

## Self-Review

### Spec coverage

- Shared primitive unification: covered by Task 1
- Vertical panel migration: covered by Task 2
- Horizontal tab migration: covered by Task 3
- Minimal global CSS and cleanup: covered by Task 4
- Verification requirements from the spec: covered by Tasks 2, 3, and 4

No uncovered spec requirements remain.

### Placeholder scan

- No `TODO`, `TBD`, or “similar to above” placeholders remain
- Every task includes exact file paths
- Every verification step includes specific commands or explicit manual checks

### Type consistency

- Shared primitive referenced consistently as `ScrollArea`
- Migrated surfaces consistently reference the shared primitive instead of mixed native overflow containers
- Verification command consistently uses `bun run --filter @lume/web build`

