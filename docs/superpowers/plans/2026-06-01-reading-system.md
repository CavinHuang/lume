# Reading System Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Lume's first-class Reading system: global bookshelf, WeRead/Gutenberg/poetry sources, autonomous Lume notes, manual share cards, chat handoff, Alice-like Reading UI, and focused settings.

**Architecture:** Add a global Reading domain beside Memory and IM. Shared types define the IPC contract; sidecar owns durable `~/.lume/reading/` storage, source adapters, note generation workflow, and agent tools; web renders the Alice-like Reading surface and settings using existing tab/sidebar patterns.

**Tech Stack:** TypeScript, Bun tests, sidecar RPC, existing agent runtime/tool framework, React + Jotai + Tailwind + lucide-react. No new dependencies.

---

## Constraints And Decisions

- Keep Reading global and single-user; do not scope it to workspaces.
- Preserve source boundaries. Real quotes must come from WeRead/Gutenberg/poetry source text; summaries cannot masquerade as quotes.
- Use WeRead API Key in V1, matching Alice's connection shape.
- User sees Lume's recent reading, notes, and thoughts. Nothing is auto-sent; share cards are manually generated.
- Background runs are quiet. The sidebar may show a small unread dot, but no notification spam.
- Default cadence is weekly/few-times, with max one deep note per week.
- UI should match Alice's reading layout: narrow left book rail, note cards in a centered main column, right hover navigation that fades after 3 seconds.
- Current worktree is dirty with unrelated changes. Do not commit or revert unrelated files unless the user asks.

## File Map

Shared:
- Create `packages/shared/src/types/reading.ts`: Reading domain types, IPC channel names, normalizers.
- Modify `packages/shared/src/types/index.ts`: export Reading types.
- Test `packages/shared/src/types/reading.test.ts`: stable channel names and normalization.

Sidecar storage and services:
- Modify `apps/sidecar/src/services/infra/config-paths.ts`: add Reading path helpers.
- Create `apps/sidecar/src/services/reading/reading-store.ts`: JSON/Markdown persistence.
- Create `apps/sidecar/src/services/reading/note-markdown.ts`: frontmatter serialize/parse.
- Create `apps/sidecar/src/services/reading/quote-evidence.ts`: quote validation helpers.
- Create `apps/sidecar/src/services/reading/book-selection.ts`: deterministic next-book selection.
- Create `apps/sidecar/src/services/reading/reading-task-runner.ts`: bounded seed/deep note workflow and task statuses.
- Create `apps/sidecar/src/services/reading/sources/*.ts`: WeRead, Gutendex/Gutenberg, poetry adapters and shared source types.
- Create `apps/sidecar/src/services/reading/share-card-service.ts`: SVG/PNG-ish share card artifact generation without new deps.
- Test focused helpers under `apps/sidecar/src/services/reading/*.test.ts`.

Sidecar RPC:
- Modify `apps/sidecar/src/rpc/schemas.ts`: Reading schemas.
- Create `apps/sidecar/src/rpc/reading-handlers.ts`: Reading RPC handlers.
- Modify `apps/sidecar/src/rpc/create-rpc-handlers.ts`: register Reading handlers.
- Test `apps/sidecar/src/rpc/reading-handlers.test.ts` and extend `create-rpc-handlers.test.ts`.

Agent tools:
- Create `apps/sidecar/src/services/agent-runtime/tools/reading/create-reading-tools.ts`.
- Modify `apps/sidecar/src/services/agent-runtime/tools/create-lume-tools.ts`.
- Modify `apps/sidecar/src/services/agent-runtime/tools/tool-metadata.ts`.
- Test `apps/sidecar/src/services/agent-runtime/tools/reading/create-reading-tools.test.ts` and metadata coverage.

Web API:
- Create `apps/web/src/lib/desktop-api/reading.ts`.
- Modify `apps/web/src/lib/desktop-api/index.ts`: export Reading API.

Web navigation and UI:
- Modify `apps/web/src/atoms/tab-atoms.ts`: add `reading` tab type.
- Modify `apps/web/src/components/app-shell/lume-sidebar-view-model.ts`: add Reading top action.
- Modify `apps/web/src/components/app-shell/LeftSidebar.tsx`: open `__reading__` tab.
- Modify `apps/web/src/components/app-shell/LumeSidebar.tsx`: add BookOpen icon rendering.
- Modify `apps/web/src/components/tabs/TabContent.tsx`: render Reading view.
- Create `apps/web/src/components/reading/reading-view-state.ts`: pure UI formatting/filtering/navigation helpers.
- Create `apps/web/src/components/reading/ReadingView.tsx`: Alice-like Reading page.
- Test `apps/web/src/components/reading/reading-view-state.test.ts` and sidebar view-model changes.

Web settings:
- Modify `apps/web/src/components/settings/settings-view-state.ts`: add Reading settings nav item.
- Modify `apps/web/src/components/settings/SettingsView.tsx`: render Reading settings.
- Create `apps/web/src/components/settings/ReadingSettings.tsx`.
- Create `apps/web/src/components/settings/reading-settings-state.ts`.
- Test `apps/web/src/components/settings/reading-settings-state.test.ts` and settings nav ordering.

## Chunk 1: Shared Reading Contract

### Task 1: Define Reading IPC Types

**Files:**
- Create `packages/shared/src/types/reading.ts`
- Modify `packages/shared/src/types/index.ts`
- Test `packages/shared/src/types/reading.test.ts`

- [x] **Step 1: Write failing shared tests**

Cover:
- `READING_IPC_CHANNELS` contains list/update settings, list books, list notes, hide/delete note, run task, connect WeRead, search WeRead, generate share card, mark seen.
- `normalizeReadingSettings` defaults to weekly cadence, Chinese notes, inherited text model, separate image model unset.
- `normalizeReadingBook` preserves source provenance.

Run:

```bash
rtk bun test packages/shared/src/types/reading.test.ts
```

Expected: fail because files do not exist.

- [x] **Step 2: Add shared contract**

Include these stable shapes:
- `ReadingSourceKind = "weread" | "gutenberg" | "poetry" | "manual" | "generated"`
- `ReadingBookTrack = "lume" | "co_read" | "recommended"`
- `ReadingNoteDepth = "seed" | "deep"`
- `ReadingTaskStatus = "completed" | "partial" | "skipped" | "failed"`
- `ReadingLibrarySnapshot` with `books`, `notes`, `stats`, `settings`, `wereadConnection`.
- Inputs for `ReadingListNotesInput`, `ReadingUpdateSettingsInput`, `ReadingGenerateShareCardInput`, `ReadingRunTaskInput`.

- [x] **Step 3: Export and verify**

Run:

```bash
rtk bun test packages/shared/src/types/reading.test.ts
```

Expected: pass.

## Chunk 2: Sidecar Storage Core

### Task 2: Persist Library, Settings, Notes, Assets

**Files:**
- Modify `apps/sidecar/src/services/infra/config-paths.ts`
- Create `apps/sidecar/src/services/reading/reading-store.ts`
- Create `apps/sidecar/src/services/reading/note-markdown.ts`
- Create `apps/sidecar/src/services/reading/quote-evidence.ts`
- Test `apps/sidecar/src/services/reading/reading-store.test.ts`
- Test `apps/sidecar/src/services/reading/note-markdown.test.ts`
- Test `apps/sidecar/src/services/reading/quote-evidence.test.ts`

- [x] **Step 1: Write failing tests**

Cover:
- Store initializes `reading/library.json`, `reading/settings.json`, `reading/notes`, `reading/assets/covers`, `reading/assets/share-cards`, `reading/runs`.
- Markdown notes round-trip frontmatter plus body.
- Quote validation rejects a claimed quote missing from the saved excerpt.
- Hidden/deleted notes disappear from normal list results but remain auditable when needed.

Run:

```bash
rtk bun test apps/sidecar/src/services/reading/reading-store.test.ts apps/sidecar/src/services/reading/note-markdown.test.ts apps/sidecar/src/services/reading/quote-evidence.test.ts
```

Expected: fail because files do not exist.

- [x] **Step 2: Implement path helpers**

Add:
- `getReadingDir()`
- `getReadingLibraryPath()`
- `getReadingSettingsPath()`
- `getReadingNotesDir()`
- `getReadingAssetsDir()`
- `getReadingCoversDir()`
- `getReadingShareCardsDir()`
- `getReadingRunsDir()`

- [x] **Step 3: Implement store**

Keep the store small:
- Synchronous JSON reads/writes like nearby config managers.
- Defensive defaults when files are missing or malformed.
- Stable IDs using existing `crypto.randomUUID()`.
- No database in V1.

- [x] **Step 4: Verify**

Run the focused Bun tests above. Expected: pass.

## Chunk 3: Reading RPC

### Task 3: Expose Reading To Web

**Files:**
- Modify `apps/sidecar/src/rpc/schemas.ts`
- Create `apps/sidecar/src/rpc/reading-handlers.ts`
- Modify `apps/sidecar/src/rpc/create-rpc-handlers.ts`
- Create `apps/web/src/lib/desktop-api/reading.ts`
- Modify `apps/web/src/lib/desktop-api/index.ts`
- Test `apps/sidecar/src/rpc/reading-handlers.test.ts`
- Modify `apps/sidecar/src/rpc/create-rpc-handlers.test.ts`

- [x] **Step 1: Write failing RPC tests**

Cover:
- `reading:get-snapshot` returns defaults.
- `reading:update-settings` trims WeRead API Key but never echoes secrets in plain UI summaries.
- `reading:add-book` creates a Lume book and returns updated snapshot.
- `reading:hide-note` and `reading:delete-note` update note visibility.
- `rpc:list-methods` includes Reading methods.

Run:

```bash
rtk bun test apps/sidecar/src/rpc/reading-handlers.test.ts apps/sidecar/src/rpc/create-rpc-handlers.test.ts
```

Expected: fail because handlers are missing.

- [x] **Step 2: Add schemas and handlers**

RPC methods:
- `reading:get-snapshot`
- `reading:update-settings`
- `reading:list-books`
- `reading:list-notes`
- `reading:add-book`
- `reading:update-book`
- `reading:hide-note`
- `reading:delete-note`
- `reading:mark-seen`
- `reading:run-task`
- `reading:connect-weread`
- `reading:disconnect-weread`
- `reading:search-weread`
- `reading:generate-share-card`

- [x] **Step 3: Add web desktop API**

Thin wrappers only; no local caching in the API module.

- [x] **Step 4: Verify**

Run the focused RPC tests. Expected: pass.

## Chunk 4: Source Adapters

### Task 4: Implement WeRead, Gutenberg, Poetry Source Layer

**Files:**
- Create `apps/sidecar/src/services/reading/sources/types.ts`
- Create `apps/sidecar/src/services/reading/sources/weread-client.ts`
- Create `apps/sidecar/src/services/reading/sources/gutenberg-client.ts`
- Create `apps/sidecar/src/services/reading/sources/poetry-client.ts`
- Create `apps/sidecar/src/services/reading/sources/book-data-service.ts`
- Test `apps/sidecar/src/services/reading/sources/book-data-service.test.ts`

- [x] **Step 1: Write failing source tests**

Use mocked `fetch`/dependency injection:
- WeRead methods preserve API Key boundary and map shelf/bookmarks/reviews/read data/search.
- Gutenberg search maps public book metadata and excerpts.
- Poetry fetch returns poem/title/dynasty/author with provenance.
- Source failures return typed partial errors instead of throwing through the whole Reading task.

Run:

```bash
rtk bun test apps/sidecar/src/services/reading/sources/book-data-service.test.ts
```

Expected: fail.

- [x] **Step 2: Implement adapters**

Keep each adapter fetch-only and side-effect free. Store only:
- Source kind
- External ID or URL
- Original title/author
- Original excerpt when permitted
- WeRead API Key reference through settings, never in book/note payloads.

- [x] **Step 3: Verify**

Run the source tests. Expected: pass.

## Chunk 5: Reading Task Runner

### Task 5: Bounded Background Reading Workflow

**Files:**
- Create `apps/sidecar/src/services/reading/book-selection.ts`
- Create `apps/sidecar/src/services/reading/reading-prompts.ts`
- Create `apps/sidecar/src/services/reading/reading-task-runner.ts`
- Test `apps/sidecar/src/services/reading/book-selection.test.ts`
- Test `apps/sidecar/src/services/reading/reading-task-runner.test.ts`

- [x] **Step 1: Write failing tests**

Cover:
- Selection prefers user co-reading context when authorized, otherwise Lume public sources.
- Weekly max deep note gate.
- Every run ends `completed`, `partial`, `skipped`, or `failed`.
- Repeated source/model failure saves a seed fallback note when source evidence exists.
- Generated deep notes include `nextPlan`.
- Skeleton gate rejects notes without book, source, excerpt evidence, body, and tags.

Run:

```bash
rtk bun test apps/sidecar/src/services/reading/book-selection.test.ts apps/sidecar/src/services/reading/reading-task-runner.test.ts
```

Expected: fail.

- [x] **Step 2: Implement deterministic seed path**

Seed note may be generated without a live model using the source excerpt and Lume persona template. This makes Reading usable offline and gives the deep path a durable seed.

- [x] **Step 3: Implement deep note boundary**

Use a service seam that can later call the full agent runtime, but in V1 code keep a deterministic fallback:
- Input: seed note, source evidence, recent user reading context.
- Output: 500-900 Chinese char deep note when model output exists; otherwise a clearly marked seed/deep partial note.
- Preserve AI-generated disclaimer metadata for UI.

- [x] **Step 4: Verify**

Run focused Reading task tests. Expected: pass.

## Chunk 6: Agent Tools

### Task 6: Add Reading Tools To Lume Runtime

**Files:**
- Create `apps/sidecar/src/services/agent-runtime/tools/reading/create-reading-tools.ts`
- Modify `apps/sidecar/src/services/agent-runtime/tools/create-lume-tools.ts`
- Modify `apps/sidecar/src/services/agent-runtime/tools/tool-metadata.ts`
- Test `apps/sidecar/src/services/agent-runtime/tools/reading/create-reading-tools.test.ts`
- Modify `apps/sidecar/src/services/agent-runtime/tools/tool-metadata.test.ts`

- [x] **Step 1: Write failing tool tests**

Tools:
- `lume_reading_snapshot`
- `lume_add_book`
- `lume_write_reading_note`
- `lume_hide_reading_note`
- `lume_generate_share_card`
- `weread_shelf`
- `weread_bookmarks`
- `weread_reviews`
- `weread_readdata`
- `weread_search`

Run:

```bash
rtk bun test apps/sidecar/src/services/agent-runtime/tools/reading/create-reading-tools.test.ts apps/sidecar/src/services/agent-runtime/tools/tool-metadata.test.ts
```

Expected: fail.

- [x] **Step 2: Implement tools**

Use existing TypeBox tool schema style. Tools must:
- Never expose raw WeRead API Key.
- Enforce quote evidence for note writes.
- Return compact Chinese summaries for agent context.
- Mark write/delete/share actions as side-effecting in metadata.

- [x] **Step 3: Register tools**

Add Reading tools to `createLumeRuntimeTools` and available names.

- [x] **Step 4: Verify**

Run focused tool tests. Expected: pass.

## Chunk 7: Web Reading Page

### Task 7: Add Alice-like Reading Surface

**Files:**
- Modify `apps/web/src/atoms/tab-atoms.ts`
- Modify `apps/web/src/components/app-shell/lume-sidebar-view-model.ts`
- Modify `apps/web/src/components/app-shell/LeftSidebar.tsx`
- Modify `apps/web/src/components/app-shell/LumeSidebar.tsx`
- Modify `apps/web/src/components/tabs/TabContent.tsx`
- Create `apps/web/src/components/reading/reading-view-state.ts`
- Create `apps/web/src/components/reading/ReadingView.tsx`
- Test `apps/web/src/components/reading/reading-view-state.test.ts`
- Modify `apps/web/src/components/app-shell/lume-sidebar-view-model.test.ts`
- Modify `apps/web/src/components/app-shell/LeftSidebar.test.tsx` if tab-open behavior needs coverage.

- [x] **Step 1: Write failing UI-state tests**

Cover:
- Reading sidebar action order and active state.
- Note navigation computes previous/next/top/bottom targets.
- Hover nav state stays visible for 3 seconds after card hover.
- Books are grouped vertically with compact rail metadata.
- WeRead connection prompt is included when disconnected.

Run:

```bash
rtk bun test apps/web/src/components/reading/reading-view-state.test.ts apps/web/src/components/app-shell/lume-sidebar-view-model.test.ts
```

Expected: fail.

- [x] **Step 2: Implement navigation**

Add a top action:
- id `reading`
- label `一起读书`
- icon `book-open`
- active when `activeTabId === "__reading__"`

- [x] **Step 3: Implement ReadingView**

Layout:
- Background matches app surface, not a landing page.
- Left rail width about 220-260px on desktop, vertical books, compact covers, `全部笔记`, `诗词札记`, WeRead prompt.
- Main column max width about Alice screenshot proportions.
- Stats band: in reading, notes, read.
- Note cards stacked vertically.
- Each note has title, author/progress/date, excerpt, body, tags, evidence row, AI disclaimer, `聊一聊`, `存为图片`.
- Right floating nav appears on note-card hover, remains for 3 seconds, and controls top/previous/next/bottom.
- Mobile collapses book rail above notes.

- [x] **Step 4: Wire actions**

Actions:
- Load snapshot through `getReadingSnapshot`.
- Search WeRead through RPC when connected.
- Connect API Key through inline prompt.
- Hide/delete notes via overflow or subtle row actions.
- Generate share card manually.
- `聊一聊` creates/opens a chat with a lightweight note context message.

- [x] **Step 5: Verify focused UI tests**

Run the UI-state/sidebar tests. Expected: pass.

## Chunk 8: Reading Settings

### Task 8: Add Reading Settings Panel

**Files:**
- Modify `apps/web/src/components/settings/settings-view-state.ts`
- Modify `apps/web/src/components/settings/SettingsView.tsx`
- Create `apps/web/src/components/settings/reading-settings-state.ts`
- Create `apps/web/src/components/settings/ReadingSettings.tsx`
- Test `apps/web/src/components/settings/reading-settings-state.test.ts`
- Modify `apps/web/src/components/settings/settings-view-state.test.ts`

- [x] **Step 1: Write failing tests**

Cover:
- Reading settings appears near Memory/Agents, not under IM.
- Cadence draft normalizes to weekly/few-times.
- Model draft supports inherit-current-chat and explicit text/image model refs.
- Advanced stages include selection/seed/deep/companion.

Run:

```bash
rtk bun test apps/web/src/components/settings/reading-settings-state.test.ts apps/web/src/components/settings/settings-view-state.test.ts
```

Expected: fail.

- [x] **Step 2: Implement panel**

Include:
- WeRead API Key connection status.
- Cadence and quiet background controls.
- Text model and image model controls.
- Advanced stage defaults, collapsed by default.
- No i18n scaffolding.

- [x] **Step 3: Verify**

Run focused settings tests. Expected: pass.

## Chunk 9: Share Cards And Covers

### Task 9: Generate Manual Share Artifacts

**Files:**
- Create `apps/sidecar/src/services/reading/share-card-service.ts`
- Extend `apps/sidecar/src/services/reading/reading-store.ts`
- Extend `apps/sidecar/src/rpc/reading-handlers.ts`
- Extend `apps/web/src/components/reading/ReadingView.tsx`
- Test `apps/sidecar/src/services/reading/share-card-service.test.ts`

- [x] **Step 1: Write failing share tests**

Cover:
- Share card generated from note summary/body and book metadata.
- Card file path lives under `reading/assets/share-cards`.
- Missing cover uses generated placeholder; real source cover wins.
- Card metadata records `sourceNoteId` and generation time.

Run:

```bash
rtk bun test apps/sidecar/src/services/reading/share-card-service.test.ts
```

Expected: fail.

- [x] **Step 2: Implement SVG share card**

No new image dependency. Generate an SVG card file with:
- Book title
- Short note summary
- Tags
- Date
- Lume Reading mark
- AI-generated disclaimer

- [x] **Step 3: Wire UI**

`存为图片` calls `reading:generate-share-card`, shows the saved path, and offers open/show action only if existing file-open helpers can be reused without new platform code.

- [x] **Step 4: Verify**

Run share tests. Expected: pass.

## Chunk 10: Focused End Verification

### Task 10: Verify The Full Slice

**Files:**
- No new files unless tests reveal gaps.

- [x] **Step 1: Run relevant focused tests**

Run:

```bash
rtk bun test packages/shared/src/types/reading.test.ts apps/sidecar/src/services/reading apps/sidecar/src/rpc/reading-handlers.test.ts apps/sidecar/src/services/agent-runtime/tools/reading/create-reading-tools.test.ts apps/web/src/components/reading/reading-view-state.test.ts apps/web/src/components/settings/reading-settings-state.test.ts
```

Expected: pass.

- [x] **Step 2: Start web app if needed**

If a dev server is not already running:

```bash
rtk bun run --filter @lume/web dev
```

Expected: localhost URL is available.

- [ ] **Step 3: Browser visual check**

Attempted with the in-app Browser on `http://localhost:61872/`. The browser surface returned `net::ERR_BLOCKED_BY_CLIENT` for `localhost` and `ERR_CONNECTION_REFUSED` for `127.0.0.1`, so visual verification remains a manual follow-up.

Use in-app Browser to verify:
- Reading tab opens from sidebar.
- Left book rail is compact and vertical.
- Main note cards match Alice-like layout.
- Hovering a note shows right nav and it fades after 3 seconds.
- WeRead prompt is present when disconnected.
- Share card generation reports a saved artifact.

- [x] **Step 4: Final risk check**

Report:
- Changed files.
- Simplifications made.
- Remaining risks, especially live WeRead endpoint assumptions and live model/image generation limitations.
