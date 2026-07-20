# Plan Review Log: 完善插件市场缓存、界面、配套安装包与 Logo
Act 1 (grill) complete — plan locked with the user. MAX_ROUNDS=5.

## Act 1 — Locked decisions

- Scope: redesign the unified plugin/skill market shell; plugin-only capabilities remain scoped to plugin views.
- Cache: persistent 30-minute TTL, stale-while-revalidate on page entry, force refresh from the sync action, stale fallback on refresh failure.
- Snapshot: resolve remote branches/tags to a concrete Git commit so catalog, permissions, Logo, Lume install and companion packages use identical content.
- UI: discovery-first desktop app-store layout; source management moves out of the permanent sidebar; existing theme and shadcn/global atoms only.
- Package semantics: Lume plugin install and companion-package acquisition are independent; downloading a Chrome/Obsidian package must not install the Lume plugin first.
- Package sources: package-relative file or directory artifacts and HTTPS prebuilt files; directories remain directories rather than being forced into ZIP.
- Save flow: native file/folder confirmation, explicit collision handling, and reveal-in-folder after success.
- Integrity: configured SHA-256 is mandatory to pass; official external packages require a hash; non-official unhashed packages require an explicit unverified warning.
- Build/target apps: no automatic build commands and no automatic writes into Chrome or Obsidian.
- Logo: package-relative configured Logo only; remote assets are resolved from the pinned source and cached; cards, details, plugins and plugin-provided skills in the input selector reuse the same Logo with a common fallback.
- Visual style: compact, low-decoration desktop store that supports light/dark themes; no new visual dependency.

## Round 1 — Codex

1. **Main-only finalize is not actually isolated:** all sidecar RPCs are currently reachable through renderer `sidecar_call`, so registering finalize in `agent-handlers.ts` would let compromised renderer code submit arbitrary destination paths.  
   **Fix:** expose finalize through a dedicated authenticated main↔sidecar channel unavailable to `sidecar_call`, and bind the token to the requesting `webContents`/session.

2. **SSRF protection is incomplete:** HTTPS-only plus redirect protocol checks still permits loopback, RFC1918, link-local, cloud metadata, IPv6-local, and DNS-rebinding targets declared by third-party manifests.  
   **Fix:** resolve and reject non-public addresses before every connection and redirect, pin the resolved address for the request, and add SSRF regression tests.

3. **“Official market” has no trustworthy definition:** source IDs, names, and URLs are configuration data and can potentially be imitated, making the mandatory-hash policy spoofable or inconsistently applied.  
   **Fix:** derive official status exclusively from immutable built-in source provenance or a canonical allowlist, persist it in snapshot metadata, and never infer it from user-controlled identifiers.

4. **The commit-pinning promise conflicts with existing generic remote JSON sources:** `readRemoteMarketIndex` accepts arbitrary `.json` URLs, which cannot necessarily be resolved to a Git commit, yet the plan claims every remote snapshot is commit-fixed.  
   **Fix:** explicitly define non-GitHub snapshot semantics—cache the index bytes and independently pin every GitHub item—or reject unsupported mutable item sources with diagnostics.

5. **Remote skills remain mutable:** existing `skill-github` references are URLs, while the plan only specifies pinned manifests, README, assets, installation, and packages for plugins; a listed skill can change before installation.  
   **Fix:** add pinned skill source refs and require skill detail/install to consume the same snapshot commit, or explicitly exclude skills from snapshot caching.

6. **Source refresh can resurrect removed or edited sources:** invalidating a snapshot does not stop an already-running refresh from publishing after source deletion or identity change.  
   **Fix:** attach a source generation/identity token to every refresh and revalidate it immediately before publishing the snapshot.

7. **Snapshot publication is underspecified on Windows:** replacing an existing file with `rename` is not uniformly atomic there, so “temporary file + atomic rename” can fail or require a delete-created visibility gap.  
   **Fix:** use immutable versioned snapshot files plus an atomically replaced small pointer/index, retaining the previous valid generation until publication succeeds.

8. **Cache ownership and cleanup lack cross-process coordination:** process-local promise merging does not protect against two sidecars/app instances writing or pruning the same persistent cache.  
   **Fix:** use immutable generations with a cross-process lock or compare-and-swap pointer, and ensure cleanup never removes generations referenced by active operations.

9. **Directory extraction is not implementable as described without a concrete safe mechanism:** Node has no built-in tar extractor, the plan forbids dependencies, and existing code shells out to `tar`; selective extraction can still permit symlink/hardlink and archive-bomb attacks.  
   **Fix:** specify the existing system-tar workflow and validate the complete archive listing, entry count, expanded size, link types, and normalized paths before extracting into a fresh root.

10. **Directory overwrite semantics are unsafe and ambiguous:** copying into an existing destination can merge stale files, while an existence check followed by copy has a symlink/TOCTOU window.  
    **Fix:** define overwrite as whole-directory replacement, stage beside the destination, revalidate target identity/no-follow state, and atomically swap or fail safely.

11. **Manifest-controlled filenames are not constrained:** `download.filename`, setup titles, plugin versions, and artifact basenames can contain separators, reserved device names, control characters, or misleading extensions.  
    **Fix:** derive a basename only, normalize to a cross-platform safe allowlist, reject reserved names, cap length, and keep the validated name in token metadata.

12. **One-time token state is race-prone:** “consume once” is stated, but no atomic state transition prevents two simultaneous save commands from finalizing the same token.  
    **Fix:** implement an atomic `ready → consuming → consumed` transition, reject concurrent consumers, and define whether failed/cancelled consumption is retryable.

13. **Cancellation cleanup has no explicit protocol:** Electron learns about dialog cancellation, but the plan does not define how it tells sidecar to invalidate and delete the prepared package immediately.  
    **Fix:** add a main-only cancel/revoke operation and make cleanup idempotent across cancel, timeout, failure, and shutdown.

14. **Preparation has progress but no cancellation or resource admission control:** multiple large tarball/download operations can exhaust disk, sockets, and temporary storage even with per-file limits.  
    **Fix:** add global/per-source concurrency and temporary-byte quotas, preflight `Content-Length` where available, abortable operations, and quota diagnostics.

15. **Logo delivery remains undefined and potentially unsafe:** “URL/data URL” does not specify CSP compatibility, access control, MIME sniffing, SVG external references, or memory amplification from embedding assets in every catalog response.  
    **Fix:** serve cached assets through a constrained custom protocol keyed by opaque asset IDs, verify magic bytes, disallow or sanitize remote SVG, and return URLs rather than repeated data URLs.

16. **Snapshot lookup identity is too weak for duplicate entries:** current catalog deduplicates plugins by `pluginId`, while the plan alternates between `source/item` and `itemId`; identical plugin IDs from multiple sources can resolve details/install to the wrong snapshot.  
    **Fix:** make `(source identity, item kind, item ID, snapshot generation)` the canonical key throughout catalog, detail, permission review, install, Logo, and package preparation.

17. **Stale fallback can violate explicit synchronization expectations:** the plan says a failed manual force-refresh returns stale data, but does not define whether the RPC is success, partial success, or failure, making UI and automation unable to distinguish “sync completed” from “old data retained.”  
    **Fix:** return per-source terminal outcomes and an aggregate `fresh | partial | failed-with-stale` status, and log operation ID, source, generation, duration, bytes, and failure category.

18. **The unverified-download confirmation is not bound to immutable content:** a URL can return different bytes between warning/metadata and actual preparation, especially across redirects.  
    **Fix:** download once into quarantine before confirmation, return its computed SHA-256/size/final origin, and have confirmation authorize that exact tokenized byte sequence.

19. **External package redirects can escape the declared publisher:** even public HTTPS redirects may silently move downloads to an unrelated host, weakening the meaning of the displayed source.  
    **Fix:** surface the final origin before confirmation and require an additional confirmation for cross-origin redirects, with an optional source allowlist.

20. **The test plan misses the highest-risk boundaries:** it does not explicitly cover renderer attempts to call finalize directly, SSRF/DNS rebinding, cross-process snapshot writers, refresh-after-source-removal, unsafe filenames, or concurrent token consumption.  
    **Fix:** add targeted tests for each of those boundaries before implementation is considered complete.

VERDICT: REVISE

### Primary agent's response

Accepted and revised:

- Package prepare/finalize/revoke are now private main↔sidecar operations behind dedicated desktop commands; generic `sidecar_call` denies them, and tokens bind to the originating webContents/session generation.
- External downloads now use a built-in HTTPS downloader with public-address validation and DNS pinning on every hop, immutable official-source provenance, quarantine-first hashing, exact-byte confirmation and cross-origin disclosure.
- Generic remote JSON snapshots pin their raw index bytes and each supported GitHub item independently; remote local/legacy entries are rejected. Remote skills are pinned to commits as part of the same unified snapshot promise.
- Refresh publication revalidates source identity, uses immutable complete generations plus a cross-process mutation lock, leases active generations, and reports explicit per-source/aggregate outcomes with structured operation diagnostics.
- System-tar extraction, archive/path/link/size checks, safe whole-directory replacement, filename normalization, token atomic states, cancellation, concurrency and temporary-space quotas are now specified.
- Logo assets now use opaque IDs and a scoped Electron protocol instead of repeated data URLs; MIME/magic validation, conservative SVG active-content rejection, CSP and scope revocation are explicit.
- Catalog identity is now source/item/generation based, so duplicate plugin IDs cannot silently redirect details, permissions, Logo or packages.
- The targeted test list now includes every high-risk boundary identified in the review.

Rejected/adjusted:

- Rather than depend on an atomically replaced pointer on Windows, the plan makes immutable generation data plus a final complete marker authoritative; the pointer is optional, and readers can recover by scanning valid generations. This avoids making correctness depend on overwrite-rename semantics.

## Round 2 — Codex

Most prior findings are now addressed: SSRF for package downloads, immutable cache generations, source-refresh races, pinned skills, duplicate plugin IDs, token atomicity/ownership, archive validation, safe overwrite, cancellation, quotas, unsafe filenames, and observability all have concrete treatments.

Remaining material issues:

1. **Remote market-index fetching still has an SSRF hole:** arbitrary `.json` source URLs are fetched through the existing unrestricted `fetchText`, while DNS/IP validation is only specified for `download.url`.  
   **Fix:** apply the same public-address DNS pinning, redirect, protocol, timeout, and size policy to remote indexes and every remote resource fetch.

2. **The private-RPC boundary relies on a fragile denylist:** `sidecar_call` currently accepts arbitrary method names, so one omitted alias or future private method reopens destination-path access.  
   **Fix:** change renderer `sidecar_call` validation to an explicit public-method allowlist; keep package finalize/revoke absent from that list and test unknown/private methods fail closed.

3. **`catalogItemKey` lifetime is undefined:** it is bound to a snapshot generation, but the plan does not say how mappings survive sidecar restart or what happens when a background refresh/cleanup retires a generation while stale UI still holds its key.  
   **Fix:** persist the opaque key in its generation, retain a catalog-view lease while exposed to a live renderer, and return a typed `snapshot_expired` response that triggers catalog reload.

4. **Market-driven update identity remains ambiguous:** the plan says update consumes the same snapshot, but existing `UpdatePluginInput` accepts `pluginId` and optional mutable `source`, not `catalogItemKey`; duplicate-source conflicts can therefore return on update.  
   **Fix:** require `catalogItemKey + acceptedPermissionsHash` for market-driven updates and reserve the existing installed-source update path for an explicitly separate operation.

5. **Remote SVG sanitization is too vague for a security boundary:** a home-grown “conservative reject” must handle XML namespaces, CSS `url()`, encoded entities, nested data URLs, animation, and parser differentials; the listed checks are not a defensible complete policy.  
   **Fix:** because dependencies and rasterization are excluded, reject remote SVG entirely and retain SVG only for trusted local package assets, or define a proven parser-based sanitizer.

6. **Cache crash consistency lacks durability requirements:** a complete marker written last is insufficient if generation contents and parent directory were not flushed before the marker becomes durable.  
   **Fix:** require file and directory `fsync` ordering before publishing the complete marker and add a simulated partial-write/restart test.

7. **The plan’s risk section is stale:** it still discusses “SVG Logo及 data URL” even though the approach replaced catalog data URLs with scoped protocol URLs, obscuring the actual remaining SVG/protocol risks.  
   **Fix:** update the risk to cover scoped-protocol isolation, SVG handling, scope revocation, and cache-generation leases.

VERDICT: REVISE

### Primary agent's response

Accepted and revised:

- One SSRF-safe remote reader now covers indexes, GitHub API/raw/tarballs, README, Logo and package URLs, with resource-specific limits.
- Renderer `sidecar_call` is now fail-closed behind a central public-method allowlist instead of a private-method denylist.
- Catalog keys persist in their generation and use renewable/releasable catalog-view leases; stale keys produce a typed reload path.
- Market-driven updates require the source-specific catalog key, while installed-record updates remain a separate API.
- Remote SVG is rejected because the no-new-dependency constraint leaves no defensible sanitizer; trusted local SVG remains supported.
- Snapshot publication now specifies content and marker flush/fsync ordering, hash validation and partial-write restart tests.
- The stale data-URL risk text was replaced with the actual scoped-protocol, scope-revocation and generation-lease risks.

## Round 3 — Codex

The prior findings are substantially addressed: remote SSRF controls now cover all resources, renderer RPC is allowlisted, catalog leases survive restart/refresh, market updates use snapshot identity, remote SVG is rejected, and cache publication includes durability ordering and crash tests.

One material ambiguity remains:

1. **`catalogItemKey` has no defined storage/lifetime model for local and installed-only entries:** the plan says every key is persisted inside a snapshot generation, but local market sources and installed plugins explicitly do not use snapshot generations; nevertheless detail, Logo, installation, and local artifact export still need canonical keys.  
   **Fix:** define a separate local-key scheme or registry binding `(source identity, kind, entry ID, current local revision/fingerprint)`, including restart persistence, invalidation on path/manifest change, and typed expiry behavior; add local-key tests alongside snapshot-key tests.

VERDICT: REVISE

### Primary agent's response

Accepted and revised:

- Remote catalog keys remain generation-backed and leased.
- Local market and installed-only entries now use a deterministic SHA-256 key over canonical source identity plus a current local fingerprint, so no absolute path is exposed and restart persistence needs no separate path map.
- The fingerprint includes realpath identity, relevant manifest content hashes and installed active version. A local path, manifest or active-version change makes the old key return typed `local_item_changed`, which reloads the catalog.
- Tests now cover local/installed key stability across restart and invalidation on each fingerprint input.

## Round 4 — Codex

The revision resolves the remaining issue. Local market entries and installed-only plugins now have deterministic restart-stable keys, explicit fingerprints and invalidation behavior, typed stale-key recovery, and targeted regression coverage.

The plan is sufficiently specific on security boundaries, snapshot consistency, concurrency, cleanup, identity, observability, and compatibility to proceed with implementation.

VERDICT: APPROVED
