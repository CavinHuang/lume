# Skills Marketplace

Date: 2026-04-21
Status: Draft
Scope: Settings-based skills marketplace for a local-first desktop app with no remote API

## Summary

Add a `Skills` entry to Settings and present skills as a marketplace, not a raw file manager. Phase 1 is local-first: it surfaces built-in skills, locally discovered skills, and GitHub/repository installs. The design must support future multi-source growth without requiring a Lume-hosted backend.

The marketplace optimizes for ordinary desktop users. The two primary product goals are:

- Increase successful skill installation
- Reduce installation mistakes and trust confusion

To do that, the UI must emphasize source identity, trust level, and risk summary before installation.

## Product Constraints

- Lume is a local desktop application
- Phase 1 does not rely on a Lume remote API
- The primary entry point is Settings
- The initial audience is ordinary users, not package-manager power users
- Phase 1 must support:
  - built-in skills
  - locally discovered skills
  - install from GitHub or repository URL
- The system must leave room for future subscribed market sources
- Trust policy is strict by default

## Goals

- Add a dedicated `Skills` surface under Settings
- Make discovery, preview, and installation understandable to non-expert users
- Unify multiple skill origins behind one marketplace mental model
- Allow GitHub install without making arbitrary third-party sources feel casually safe
- Keep the architecture extensible for future official, team, and community market sources

## Non-Goals

- Open community publishing in Phase 1
- Ratings, reviews, download counts, or social discovery
- A Lume-hosted backend or remote API
- Full package-manager style source control in the main browse flow
- Automatic trust escalation for third-party sources

## Recommended Product Shape

Use a `marketplace shell + local-first core` approach.

This means:

- The user-facing product is called a marketplace
- The underlying system is a local catalog plus installer
- Different origins are modeled as sources, not special-case screens
- GitHub install is supported in Phase 1
- Generic subscribed third-party market sources are blocked by default until explicitly enabled in a trust setting

## Information Architecture

### Primary navigation

Add a `Skills` tab to Settings alongside the existing settings categories.

### Skills page sections

Phase 1 should expose these top-level sections within the Skills area:

- `Discover`
- `Installed`
- `Updates`
- `Trust & Security`

`Discover` is the default landing view.

### Main page layout

Use a two-pane layout:

- Left pane: search, filters, and skill list
- Right pane: selected skill detail, trust summary, and install actions

Keep the top bar focused on two global actions:

- `Install from GitHub`
- `Manage Sources`

This keeps Phase 1 usable today while reserving clear space for future multi-source management.

## Existing System Leverage

The design should reuse current repository primitives instead of introducing a parallel marketplace stack.

Relevant existing pieces already present in the codebase:

- sidecar global discovery for marketplace/plugin/skill scanning
- workspace skill listing and import flows
- Settings shell and tab structure in the web app
- shared IPC contracts for global discovery, marketplace detail, and skill import

Phase 1 should build on these capabilities where possible:

- use current workspace skill state as the starting point for `Installed`
- reuse local/global discovery mechanisms for built-in and local sources
- extend current Settings navigation instead of creating a disconnected feature surface
- treat GitHub install as the major new source acquisition flow rather than rebuilding all source plumbing from scratch

## Phase 1 Core Surfaces

Keep Phase 1 to four concrete user-facing surfaces:

### 1. Discover

Purpose:

- Browse trusted and recommended skills
- Search and filter by source and category
- Open a detail view before installing

Behavior:

- Default sort favors built-in and trusted items
- Show clear source badges such as `Built-in`, `Local`, or `GitHub`
- Avoid dense table views as the default presentation

### 2. Skill Detail

Purpose:

- Explain what the skill does
- Build enough trust for the user to install it

Content should include:

- description
- example prompts or usage
- source identity
- trust level
- risk summary
- files/source preview entry points
- install action scoped to a workspace

### 3. GitHub Install Sheet

Purpose:

- Turn raw repository installation into a guided, reviewable workflow

Behavior:

- Accept a GitHub or repository URL
- Validate and inspect repository structure locally
- Detect skill folders and `SKILL.md` files
- Generate a review sheet before installation
- Require explicit confirmation before installing into a workspace

### 4. Installed

Purpose:

- Separate “things I use/manage” from “things I may browse/install”

Behavior:

- Show enabled state
- Show workspace scope
- Show source and trust status
- Show update availability if detectable
- Allow disable, remove, inspect source, and review-update actions

## Source Model

All listed items should be normalized through a unified source model.

Phase 1 source types:

- `built-in`
- `local`
- `github`
- `subscribed-market`

Even if `subscribed-market` is mostly future-facing in Phase 1, it should exist in the model from the start so the product can grow into official, team, and community catalogs without redesigning the core abstractions.

## Trust Model

Trust is a first-class concept, not a side note.

Recommended trust levels:

- `trusted`
- `review-required`
- `blocked-by-default`

Recommended default policy:

- Built-in skills: `trusted`
- Local skills already on disk: trusted enough to import, but still show source context
- GitHub installs: `review-required`
- Generic subscribed third-party markets: `blocked-by-default` until explicitly enabled

This preserves the desired strict trust posture while still allowing GitHub installation in Phase 1.

## Catalog Model

The marketplace should normalize all sources into a common catalog item shape.

Suggested logical fields:

- `id`
- `name`
- `slug`
- `description`
- `sourceType`
- `sourceId`
- `trustLevel`
- `authorOrMaintainer`
- `version`
- `installState`
- `workspaceBindings`
- `riskSummary`
- `capabilitiesSummary`
- `previewPaths`
- `lastUpdated`

The exact TypeScript shape can evolve during planning, but the key requirement is that UI layers must consume one unified item model rather than source-specific data structures.

## Architecture

Split the feature into four layers.

### 1. Source layer

Responsibilities:

- enumerate built-in, local, GitHub, and future subscribed sources
- validate source identity
- convert source-specific payloads into raw source records

This is where future official/team/community source adapters will plug in.

### 2. Catalog layer

Responsibilities:

- normalize source records into a unified catalog item list
- apply trust classification
- merge install state and workspace state
- sort and filter items for the UI

### 3. Install layer

Responsibilities:

- inspect install candidate contents
- create review/risk summary
- install into a selected workspace
- handle overwrite/conflict policy
- persist install/update state

### 4. Presentation layer

Responsibilities:

- render Discover, Detail, GitHub Install Sheet, Installed, and Trust & Security
- surface status using plain language
- keep browsing and management as separate user modes

## Core Data Flows

### Discover flow

1. User opens `Settings > Skills`
2. App loads and aggregates catalog items from local-first sources
3. Discover defaults to trusted and built-in items first
4. User selects a skill
5. Detail view explains value, source, and risk
6. User installs to a target workspace
7. Installed state refreshes in both Discover and Installed views

### GitHub install flow

1. User clicks `Install from GitHub`
2. User pastes a repository URL
3. App validates and inspects repository contents locally
4. App detects candidate skills, scripts, and structural issues
5. App generates a review sheet with source and risk summary
6. User selects install target workspace
7. App installs and updates local state

Implementation note: GitHub install should be treated internally as a source-backed install candidate, not a one-off special path outside the source/catalog system.

## Error Handling

Error copy should translate technical failures into ordinary-user language.

Required scenarios:

- Source unreachable
  - Explain that the source could not be read
  - Offer retry and detail actions
- Invalid repository structure
  - Explain that no valid skill folders or `SKILL.md` files were found
- Risky contents detected
  - Move the item into `review-required`
  - Do not treat this as a generic error
- Source not trusted
  - Explain that third-party sources are blocked by default
  - Link to `Trust & Security`
- Workspace install failure
  - Explain whether failure came from copy, permission, or conflict policy

## UI Principles

- Discovery and management are separate mental modes
- Trust information must appear before installation, not after
- Risk summaries should use plain language rather than internal jargon
- Install actions should always make workspace scope explicit
- Source management should not overwhelm the main browse experience

## Testing Strategy

Phase 1 should lock behavior around the critical trust and install paths.

### Source adapter tests

- each source type can be normalized into the shared catalog shape
- invalid or partial source data fails safely

### Trust policy tests

- built-in, local, GitHub, and subscribed-market defaults are classified correctly
- blocked sources do not appear installable without explicit enablement

### Install flow tests

- install into workspace succeeds
- duplicate install and overwrite/conflict behavior is deterministic
- review-required update paths behave correctly

### UI state tests

- Discover, Detail, Installed, and GitHub sheet render the expected states
- trust badges and install actions change correctly based on trust level and install state

### Offline/local-first regression tests

- built-in and local marketplace flows work without network access
- failure modes remain understandable when remote repository reads fail

## Rollout Recommendation

Phase 1 should ship as:

- a Settings-based Skills marketplace
- four primary surfaces
- local-first catalog aggregation
- GitHub install with review-required flow
- strict default source trust posture

Future iterations can add:

- subscribed official/team/community catalogs
- better update detection
- richer example prompts and previews
- source subscriptions UI depth

## Final Design Decision

The feature should be built as a `local-first, multi-source-ready skills marketplace` with a strict trust model.

It is not a publishing platform in Phase 1.
It is not a backend-dependent marketplace.
It is a catalog, trust, and installation experience designed for ordinary users in a desktop app.
