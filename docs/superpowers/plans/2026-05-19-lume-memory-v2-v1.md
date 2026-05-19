# Lume Memory V2 V1 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Memory V2 V1 Contract from `docs/superpowers/specs/2026-05-18-lume-memory-v2-design.md`.

**Architecture:** Memory V2 is Markdown-first: `MEMORY.md`, `entries/*.md`, `daily/*.md`, `runs/*.jsonl`, and `pending/*` are the source of truth. Runtime recall is injected as an Alice-style hidden user-message prefix, while UI and archives keep the visible user text clean. SQLite/vector work stays out of V1 except for compatibility with the existing old memory modules.

**Tech Stack:** TypeScript, Bun tests, existing `yaml` dependency in `apps/sidecar`, existing runtime event and React projection surfaces.

---

## File Structure

- Create `apps/sidecar/src/services/memory-v2/types.ts`: V2 schema, recall item, and smartAdd result.
- Create `apps/sidecar/src/services/memory-v2/paths.ts`: global/workspace V2 memory root helpers.
- Create `apps/sidecar/src/services/memory-v2/markdown-store.ts`: read/write frontmatter entries, daily notes, pending files, run archive JSONL.
- Create `apps/sidecar/src/services/memory-v2/smart-add.ts`: duplicate/conflict/stale/low-confidence/new classification.
- Create `apps/sidecar/src/services/memory-v2/extraction.ts`: LLM memory intent extraction with explicit-rule fallback for automatic micro-capture.
- Create `apps/sidecar/src/services/memory-v2/retrieval.ts`: FTS-like keyword/path search plus rule-based rerank.
- Create `apps/sidecar/src/services/memory-v2/user-message-prefix.ts`: build and strip `<lume_memory_context>`.
- Modify `apps/sidecar/src/services/agent-runtime/context/context-assembler.ts`: return Memory V2 recall context instead of appending old memory into the system prompt.
- Modify `apps/sidecar/src/services/agent-runtime/runner/lume-runner.ts`: send prefixed user message to the model, emit memory-used event, and archive visible run evidence.
- Modify `apps/sidecar/src/services/agent-runtime/runner/run-observer.ts`: strip injected memory prefixes from SDK user messages before user-facing run items.
- Modify `apps/sidecar/src/services/memory/memory-tools.ts`: keep the tool surface small and route `memory.search`, `memory.read`, and `memory.remember` directly to Memory V2.
- Modify `apps/sidecar/src/services/memory/memory-policy.ts`: expose the V1 semantic tool set by default.
- Modify `packages/shared/src/types/runtime-event.ts`: add `memory.context.used`.
- Modify `apps/web/src/components/agent/runtime-event-message-projection.ts` and related tests: render a compact bottom memory citation notice when enabled.
- Reuse the existing memory citation setting; do not add a second V2 settings wrapper.

## Success Criteria

- Memory V2 writes human-readable Markdown files and can rebuild recall from those files.
- SmartAdd handles duplicate, conflict, stale, low-confidence, and new candidates.
- Runtime sends the model an Alice-style memory prefix but never shows that prefix in the UI.
- Runtime captures memory intent automatically on run completion using the configured extraction LLM when available.
- Runtime strips the prefix before archive/reflection-facing transcript handling.
- `memory.context.used` events include selected memory ids and citations.
- Web renders a compact memory-citation notice and respects the existing citation display setting.
- Existing old memory code remains available only for legacy maintenance/global tools; the new V1 search/read/write path does not bridge through it.

## Tasks

### Task 1: Storage And Schema

**Files:**
- Create: `apps/sidecar/src/services/memory-v2/types.ts`
- Create: `apps/sidecar/src/services/memory-v2/paths.ts`
- Create: `apps/sidecar/src/services/memory-v2/markdown-store.ts`
- Test: `apps/sidecar/src/services/memory-v2/markdown-store.test.ts`

- [ ] Define V2 entry, pending, recall, and run archive types.
- [ ] Implement global/workspace memory roots using existing config path helpers.
- [ ] Implement Markdown frontmatter parse/stringify with the existing `yaml` dependency.
- [ ] Implement atomic-ish entry creation, status updates, daily append, and run archive append.
- [ ] Add tests for frontmatter round trip, active-only recall, pending exclusion, daily append, and archive redaction marker behavior.
- [ ] Run `rtk bun test apps/sidecar/src/services/memory-v2/markdown-store.test.ts`.

### Task 2: SmartAdd And Retrieval

**Files:**
- Create: `apps/sidecar/src/services/memory-v2/smart-add.ts`
- Create: `apps/sidecar/src/services/memory-v2/extraction.ts`
- Create: `apps/sidecar/src/services/memory-v2/retrieval.ts`
- Test: `apps/sidecar/src/services/memory-v2/smart-add.test.ts`
- Test: `apps/sidecar/src/services/memory-v2/extraction.test.ts`
- Test: `apps/sidecar/src/services/memory-v2/retrieval.test.ts`

- [ ] Implement LLM extraction using `memory.extraction.modelRef`, with Alice-style gatekeeping and explicit-intent fallback for provider failures.
- [ ] Add tests for LLM gate decisions, source-text verification, model-ref config resolution, and non-blocking fallback.
- [ ] Implement deterministic duplicate detection by normalized statement.
- [ ] Implement conflict and stale heuristics for same-kind/same-entity candidates.
- [ ] Implement low-confidence routing to pending.
- [ ] Implement rule-based recall scoring with pinned, scope, kind, recency, confidence, relation, and stale handling.
- [ ] Add tests for duplicate skip, conflict pending, stale review, low-confidence pending, intent scoring, and suspected-stale exclusion unless strongly relevant.
- [ ] Run focused tests for `smart-add` and `retrieval`.

### Task 3: Runtime Injection And Events

**Files:**
- Create: `apps/sidecar/src/services/memory-v2/user-message-prefix.ts`
- Test: `apps/sidecar/src/services/memory-v2/user-message-prefix.test.ts`
- Modify: `packages/shared/src/types/runtime-event.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/context/context-assembler.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/runner/lume-runner.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/runner/run-observer.ts`
- Update tests near those files.

- [ ] Implement `buildMemoryUserMessagePrefix` and `stripMemoryUserMessagePrefix`.
- [ ] Add `memory.context.used` runtime event type.
- [ ] Change context assembly to produce memory prefix metadata instead of system-prompt memory text.
- [ ] Send prefixed user text only to the model call.
- [ ] On run completion, append daily/archive evidence and commit explicit-intent candidates through smartAdd.
- [ ] Strip prefixed text from user-facing run items and archive/reflection paths.
- [ ] Emit `memory.context.used` when recall items were injected.
- [ ] Run focused context assembler, runner, observer, and prefix tests.

### Task 4: Agent Tools And Policy

**Files:**
- Modify: `apps/sidecar/src/services/memory/memory-tools.ts`
- Modify: `apps/sidecar/src/services/memory/memory-policy.ts`
- Update tests: `apps/sidecar/src/services/memory/memory-tools.test.ts`, `apps/sidecar/src/services/memory/memory-policy.test.ts`

- [ ] Route `memory.search` directly to Memory V2 retrieval without old-system fallback.
- [ ] Route `memory.read` directly to Memory V2 entry/path reads.
- [ ] Route `memory.remember` to Memory V2 smartAdd and Markdown commit.
- [ ] Keep maintenance/global legacy tools outside the default V1 tool group.
- [ ] Ensure "do not remember this" style input suppresses durable candidate writes.
- [ ] Run focused memory tool and policy tests.

### Task 5: Web Citation Notice And Settings

**Files:**
- Modify: `apps/web/src/components/agent/runtime-event-message-projection.ts`
- Modify: `apps/web/src/components/agent/runtime-state-projections.ts` if needed.
- Reuse existing memory runtime citations mode; do not add a new settings model.
- Update tests next to modified web files.

- [ ] Project `memory.context.used` into a compact bottom notice.
- [ ] Show memory ids/citations lightly without adding a blocking banner.
- [ ] Respect existing citation display setting; default to enabled.
- [ ] Run focused web projection tests.

### Task 6: Final Verification And Commit

**Files:**
- All changed files.

- [ ] Run `rtk git diff --check`.
- [ ] Run all focused sidecar/web tests touched by this plan.
- [ ] Review `rtk git status --short`.
- [ ] Commit with Lore protocol.
