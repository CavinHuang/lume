# Lume Reading System Design

Date: 2026-06-01
Status: Draft, awaiting user review
Scope: Full Alice-like Reading system for Lume, redesigned for Lume architecture

## Summary

Add a first-class Reading system to Lume. Reading is not a workspace tool, not a Memory V2 sub-feature, and not a generic document ingestion path. It is Lume's global reading life: Lume has its own bookshelf, reading progress, reading notes, cover images, share cards, background reading rhythm, and a concrete reading persona. When the user connects WeRead, Lume also becomes the user's reading companion.

The design intentionally follows the Alice reading experience: autonomous book selection, scheduled reading, two-stage note generation, WeRead companion mode, note cards, hover navigation, generated covers, and manually generated share cards. Lume keeps Alice's product feeling, but places it behind Lume's sidecar, runtime, automation, RPC, and settings boundaries.

## Goals

- Make Reading a main sidebar entry with an Alice-like daily-use surface.
- Maintain a global single-user Reading Library outside workspaces.
- Let Lume autonomously select books, read, and write personal reading notes.
- Support WeRead, Gutenberg, and Chinese poetry source routing.
- Let WeRead connection unlock the user's bookshelf, highlights, reviews, reading data, and companion behavior.
- Generate seed notes first, then deeper notes through a dedicated reading run with a 30-turn cap.
- Preserve source and quote boundaries so Lume does not fabricate quotations, spoil future content, or overuse user-authorized WeRead content.
- Keep Reading notes in Reading Library; Memory V2 only receives stable preferences or user-requested memories.
- Keep background reading stable: no stuck tasks, no infinite retries, and graceful partial results.
- Support generated cover images and manual share-card generation.

## Non-Goals

- Do not turn Reading into a generic PDF/EPUB/document reader in V1.
- Do not build multi-user or workspace-scoped reading libraries in V1.
- Do not implement QR login or cookie import for WeRead in V1.
- Do not cache full modern copyrighted books or full WeRead chapters.
- Do not automatically post, send, or push Reading notes.
- Do not create a global "thoughts" or social feed outside Reading in V1.
- Do not automatically write every Reading note into Memory V2.
- Do not build explicit like/dislike/rating controls for Lume's notes.

## Chosen Approach

Build an Alice-like Reading system as its own Lume product domain.

Alternatives rejected:

- A generic research/document reader would be easier to reuse, but would miss the Alice-like "Lume is reading" experience.
- A Memory V2 external-source extension would make Reading feel like ingestion, not a living bookshelf.
- A workspace resource reader would bind reading to projects, but Reading should be Lume's global life state.

## System Boundary

Reading owns:

- Global bookshelf and reading queue.
- Lume's current reading state and reading profile.
- Reading progress and `nextPlan`.
- Reading notes and source evidence.
- Generated covers and share cards.
- Reading background task state.
- WeRead reading-companion configuration.

Reading collaborates with:

- Automation/cron for wakeups only.
- Agent Runtime for dedicated deep reading runs.
- Memory V2 for optional stable long-term preferences or user-requested memories.
- Chat for lightweight Reading note links and natural trigger tools.
- Settings for API keys, schedule, source switches, models, persona, and share style.

## Storage

Reading is global and single-user. It stores data under the Lume user data directory, not inside any workspace.

```text
~/.lume/reading/
  library.json
  settings.json
  notes/
    note_<id>.md
  assets/
    covers/
    share-cards/
  runs/
    reading-run_<id>.jsonl
```

### library.json

`library.json` stores structured state for product behavior.

```ts
interface ReadingLibrary {
  version: 1
  profile: LumeReadingProfile
  books: ReadingBook[]
  collections: ReadingCollection[]
  tasks: ReadingTaskState
  updatedAt: number
}

interface ReadingBook {
  id: string
  title: string
  author?: string
  source: "weread" | "gutenberg" | "poetry"
  sourceRef: string
  status: "reading" | "queued" | "finished" | "paused" | "abandoned"
  track: "lume" | "co_read" | "recommended"
  progress?: {
    percent?: number
    label?: string
    lastPosition?: string
    updatedAt: number
  }
  cover?: {
    kind: "source" | "generated" | "placeholder"
    path?: string
    url?: string
  }
  lastNoteId?: string
  nextPlan?: string
  createdAt: number
  updatedAt: number
}
```

`ReadingCollection` supports aggregate items that are not ordinary books, such as `poetry_notes`.

### notes/*.md

Notes are Markdown with frontmatter. The body is the source of the card content and share-card summary.

```yaml
---
id: note_20260601_abcd
bookId: book_123
kind: deep
source: weread
track: lume
status: complete
progressLabel: "41%"
quote:
  text: "..."
  sourceRef: "weread://book/123/chapter/4"
  position: "chapter-4:para-17"
evidence:
  sourceKind: "weread_public_chapter"
  excerptPolicy: "quote_only"
tags: [自我追寻, 慢下来]
nextPlan: "下次避免继续写顿悟，转向倾听和时间感。"
createdAt: 2026-06-01T12:00:00Z
---

## 不是顿悟，是慢慢变清楚

...
```

Storage rules:

- Do not cache full modern books or full WeRead chapters.
- Save enough evidence to prove quotes.
- Gutenberg and poetry may store public short excerpts.
- WeRead stores only the actual quote, position, source reference, fetch time, and authorization boundary.
- A summary is never treated as original quotation text.

### settings.json

```ts
interface ReadingSettings {
  enabled: boolean
  schedule: {
    mode: "weekly"
    cron?: string
    maxDeepNotesPerWeek: number
  }
  weread?: {
    apiKey?: string
    enabled: boolean
    lastConnectedAt?: number
    lastError?: string
  }
  sources: {
    weread: boolean
    gutenberg: boolean
    poetry: boolean
  }
  models: {
    readingTextModelRef?: string
    imageModelRef?: string
    advanced?: {
      selectionModelRef?: string
      seedNoteModelRef?: string
      deepNoteModelRef?: string
      companionModelRef?: string
    }
  }
  persona: LumeReadingProfile
  shareCardStyle: "lume-default"
}
```

## Data Sources And Permissions

Reading uses an Alice-style `BookDataService` router.

```text
Chinese classical poetry -> ChineseLiteratureClient
Western public-domain classics -> GutenbergClient
Modern Chinese books and user reading data -> WeReadClient
```

### WeRead

WeRead has two permission layers.

Public layer:

- Search books.
- Fetch public book info.
- Fetch public chapters when available.
- Fetch best/highlighted public passages.
- This layer supports Lume's autonomous reading.

User-connected layer:

- Enabled only after the user enters a WeRead API Key.
- Exposes shelf, bookmarks, reviews, reading data, and discovery.
- Enables reading companion mode.

Rules:

- Lume does not treat the user's WeRead account as Lume's own reading account.
- User-authorized data enters Lume's notes only for co-reading or relevant companion context.
- User highlights are strong attention signals, but notes must not become line-by-line commentary.
- Modern Chinese books are discussed only within the actually read passages.

### Gutenberg

Gutenberg is the main autonomous long-reading source for public-domain Western classics.

- Lume may select Gutenberg books automatically.
- Public text can be saved as bounded evidence excerpts.
- English book notes are written in Chinese; quotations remain in English.
- Gutenberg entries can have progress, notes, `nextPlan`, and generated covers.

### Chinese Poetry

Poetry is a short-reading source.

- Poetry appears in the left rail as `诗词札记`, not as many individual books.
- Poetry can be triggered by Lume's state for short reading.
- Poetry notes are Reading notes marked as short reads.

### Quote Evidence

Quotation policy is strict:

- Quotes must come from a current read passage or a saved original excerpt.
- If only a summary exists, the note may say "这段大意让我想到...", but must not quote it.
- Network search and model knowledge may inform background, but must not supply quote text.
- Each note displays a short source boundary and an AI-generated notice.

## Reading Persona

Lume gets a new concrete reading persona. It does not reuse Alice's identity.

Default direction:

- Clear, reflective, and judgment-oriented.
- Restrained rather than sentimental.
- Interested in technology and humanities, social observation, philosophy, and controlled literary writing.
- Uses Chinese by default.
- Writes notes with medium user association: first make the note independently valuable, then naturally add one or two relevant user-conversation hooks.
- Treats recent user topics as weak signals, not as instructions to follow every trend.

Learning signals:

- User book recommendations.
- Co-reading choices.
- Natural chat feedback.
- Hidden or deleted notes.
- Repeated user themes.

The Reading profile is semi-visible:

- Show a short "最近阅读倾向 / 写作倾向 / 用户影响" summary.
- Do not expose weights, scores, embeddings, or internal ranking data.

## Background Reading

Reading scheduling is a hybrid:

```text
Automation/cron wakes Reading.
Reading service decides what to read, whether to write, and how to recover.
```

Default behavior:

- Read a few times per week.
- Do not generate a note on every run.
- Strong resonance can produce a short note.
- At most one deeper note per week by default.
- Do not notify the user; new notes appear naturally on the Reading page.

Task flow:

```text
1. Load settings and library.
2. Skip if Reading is paused or quota is exhausted.
3. Estimate Lume's current reading state.
4. Pick reading object.
5. Read a bounded passage from the source.
6. Validate permissions and quote evidence.
7. Generate seed note.
8. If quality or progress threshold passes, start deep reading run.
9. Save note markdown.
10. Update book progress, nextPlan, and task state.
```

Task outcomes:

```ts
type ReadingTaskResult =
  | "completed"
  | "partial"
  | "skipped"
  | "failed"
```

Stability rules:

- Every run must end in one of those states.
- Source failures can retry a bounded number of times.
- Deep-note failure saves the seed note as `partial`.
- A 30-turn timeout saves the last usable version or falls back to the seed note.
- Failures must not block the next scheduled run.
- Only repeated failures appear on the Reading page.
- The system must not repeatedly generate the same note.

## Book Selection

Lume has two reading tracks:

- Lume's own reading plan.
- Co-reading or user-recommended books.

Selection inputs:

- Lume's concrete persona and current state.
- Current bookshelf and progress.
- Past books and notes.
- User-recommended books.
- Recent user topics as weak signals.
- WeRead public signals and Gutenberg availability.

Rules:

- Currently-reading books must not be duplicated.
- Classics may be reread when there is a new angle.
- User recommendation intent determines track:
  - "你可以读读《X》" -> Lume queue.
  - "我们一起读《X》" -> co-reading.
  - Ambiguous recommendations may be clarified in natural chat.
- Selected books must be verified against source data before entering the library.

## Note Generation

Reading notes follow Alice's two-stage design.

### Seed Note

Seed note:

- Generated immediately after a meaningful reading passage.
- About 200 Chinese characters.
- Stored as fallback if deep generation fails.
- Must cite only real source text.

### Deep Note

Deep note:

- 500-900 Chinese characters by default.
- Generated by a dedicated reading run.
- Has a 30-turn cap.
- Uses the full tool chain.
- Produces `nextPlan`.

Allowed tools:

- Read current book passage.
- Search Reading Library.
- Search recent conversation or Memory V2 for user context.
- Read user WeRead highlights/reviews when connected and relevant.
- Search public web background when helpful.

Quality constraints:

- Knowledge gain first; user association second.
- Skeleton test is mandatory: remove user-related sentences and the note must still be valuable.
- Avoid spoilers beyond progress.
- Do not write a whole-book review for modern Chinese books when only public fragments were read.
- `nextPlan` must prevent repeated angles in later notes.

## UI

Reading is a main sidebar entry.

The Reading home follows the approved Alice-like layout:

```text
Left rail:
  - 全部笔记
  - vertical list of books Lume is reading
  - 诗词札记 collection
  - WeRead connection prompt

Main column:
  - 一起读书
  - 搜索书籍
  - light "Lume 在读" stats
  - optional WeRead connection card
  - 读书笔记 divider
  - large Reading note cards

Right hover navigation:
  - appears on note-card hover
  - fades after 3 seconds
  - navigates previous/next/top/bottom note in current filter
```

Note card content:

- Book title, author, progress, date.
- Quote.
- 500-900 character note.
- Tags.
- Source boundary.
- AI-generated notice.
- Actions: `聊一聊`, `生成分享卡片`.

Interactions:

- `聊一聊` opens the current main Chat with the note context.
- Chat messages show only a lightweight Reading note link.
- `生成分享卡片` creates an image from the current note summary.
- Users may hide/delete Lume notes, but not edit their body.
- No explicit rating buttons.

## Chat And Tools

Core Lume-style Alice tools are always available in normal Chat:

- `lume_add_book`
- `lume_book_lookup`
- `lume_write_reading_note`

`lume_add_book`:

- Detects user book recommendations.
- Adds to Lume queue or co-reading based on expression.
- Replies naturally with thanks and expectation.

`lume_book_lookup`:

- Modes: `search`, `highlights`, `my_notes`, `current_reading`.
- Searches book info, Lume's Reading notes, or public highlights.

`lume_write_reading_note`:

- Triggered when chat naturally relates to a current book or the user asks about Lume's reading.
- Saves to Reading Library.
- Does not default-write to Memory V2.

When WeRead is connected, these tools are also available:

- `weread_shelf`
- `weread_bookmarks`
- `weread_reviews`
- `weread_readdata`
- `weread_search`

WeRead companion rules:

- Related conversations can search the user's shelf, highlights, and thoughts.
- Build connections rather than summarize raw text.
- Use user highlights naturally, not as a checklist.
- User writing tasks may use highlights as material.
- `reviews` and `best_highlights` can summarize other readers' perspectives.
- Relevant book recommendations should look at the user's shelf preferences first.

Tool injection:

- Core `lume_*` tools are always injected.
- `weread_*` tools are injected only when WeRead is configured.
- Heavy tools such as cover/share generation are Reading page or background task tools, not normal Chat tools.

## Settings

Reading Settings includes:

- Enable / pause Reading.
- WeRead API Key.
- Reading frequency.
- Source switches.
- Lume reading persona.
- Model settings.
- Share-card style.
- Diagnostics.

Model settings:

- Default basic controls: reading text model and image generation model.
- Advanced controls: selection, seed note, deep note, companion model.
- Inheritance: advanced task model -> reading text model -> default chat model.

WeRead connection:

- V1 uses API Key only.
- Show connection status, last sync, and failure reason.
- No QR login or cookie import in V1.

## Images

V1 supports two image paths:

- Book cover generation when a source cover is missing.
- Manual share-card generation from a note.

Cover generation:

- Real source cover wins.
- Missing covers are generated automatically.
- Lume style: no text, 3:4 vertical, restrained, cool, abstract, technology-humanities mood.
- Failure falls back to a stable placeholder.

Share card:

- Manual only.
- Uses note title, short excerpt, Lume's "想说的话", book title, author, and date.
- No complex editor in V1.

## Error Handling

| Scenario | Handling |
| --- | --- |
| Source search fails | Return empty results for that source; keep other sources alive |
| Source read fails | Retry within limit; mark run failed/skipped if no evidence |
| WeRead API invalid | Disable user-connected tools and surface setting error |
| Book selection hallucination | Verify via source search before adding |
| Quote lacks source evidence | Drop quote or reread source; never fabricate |
| Deep run fails | Save seed note as partial |
| 30-turn deep run does not converge | Save last usable note or seed fallback |
| Cover generation fails | Use placeholder cover |
| Share card generation fails | Show readable error; keep note intact |
| Repeated background failures | Show lightweight Reading page prompt |

## Implementation Phases

### Phase 1: Reading Data And Page Skeleton

- Shared Reading types.
- Sidecar Reading store.
- Global user-data storage.
- Web main sidebar entry.
- Alice-like Reading page skeleton.
- Note Markdown load and display.

### Phase 2: Data Sources And Bookshelf

- WeRead public client.
- Gutenberg/Gutendex client.
- Chinese poetry client.
- `BookDataService`.
- Search books, add books, progress state.

### Phase 3: Background Scheduling And Seed Notes

- Reading task state.
- Automation/cron wakeup.
- Book selection prompt.
- Bounded passage read.
- Seed note save.
- Failure status and repeated-failure prompt.

### Phase 4: Deep Reading Run

- Dedicated reading run.
- 30-turn cap.
- Tool chain.
- Skeleton test.
- `nextPlan`.
- Quote evidence validation.

### Phase 5: Chat Tools And WeRead Companion

- `lume_add_book`.
- `lume_book_lookup`.
- `lume_write_reading_note`.
- `weread_shelf`.
- `weread_bookmarks`.
- `weread_reviews`.
- `weread_readdata`.
- `weread_search`.
- Chat Reading note lightweight links.

### Phase 6: Covers And Share Cards

- Missing-cover generation.
- Share-card generation.
- Asset persistence.
- Placeholder and error fallback.

### Phase 7: Settings And Models

- Reading Settings.
- WeRead API Key.
- Frequency, sources, persona, models, share style.
- Semi-visible Reading profile.

## Testing

Focused tests should cover behavior that can regress product guarantees:

- Reading store initializes, reads, and writes global JSON/Markdown files.
- Note frontmatter preserves source evidence, `nextPlan`, status, and progress.
- Quote validation rejects quotes not present in source evidence.
- Book selection verifies source existence before adding.
- Modern Chinese books cannot create full-book notes from partial public fragments.
- Task runner always resolves to `completed`, `partial`, `skipped`, or `failed`.
- Deep-note failure saves seed note as partial.
- Repeated failures produce a Reading page status, single failures do not.
- WeRead tools only inject when configured.
- WeRead authorized content is marked in note source boundaries.
- Chat Reading link rendering does not inline full notes.
- Hover navigation appears only in Reading page UI and navigates note cards.

External HTTP and model calls must be mocked in unit tests.

## Acceptance Criteria

- Reading exists as a main sidebar entry.
- A global Reading Library can store books, progress, notes, covers, and settings outside workspace files.
- The Reading page shows Lume's books, note stream, WeRead connection prompt, and Alice-like note cards.
- Weekly background Reading can advance progress without user interaction.
- Every background run has a terminal status.
- Seed and deep notes exist as separate states.
- Deep notes support 30-turn generation with fallback.
- `nextPlan` is saved and reused.
- WeRead, Gutenberg, and poetry source boundaries exist.
- WeRead API Key unlocks the five companion tools.
- Quotes cannot be fabricated.
- Modern Chinese notes stay within read fragments.
- Chat can link to a Reading note without inlining it.
- Manual share-card and missing-cover generation are available with fallbacks.
- Each note displays source boundary and AI-generated notice.
