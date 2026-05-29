# Cache Usage Fields Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve provider cache usage fields from SDK adapters through runtime events, persistence metadata, and agent footer display.

**Architecture:** Provider adapters normalize vendor cache fields into SDK `cacheReadInputTokens` and `cacheCreationInputTokens`. Shared runtime usage carries both split fields plus the existing `cachedTokens` summary, while sidecar and web consume the richer shape without introducing vendor-specific branches outside adapters.

**Tech Stack:** Bun tests, TypeScript, Lume SDK providers, sidecar runtime event projection, web agent message projection.

---

## Chunk 1: Provider Adapter Cache Fields

**Files:**
- Modify: `packages/sdk/src/providers/openai.ts`
- Modify: `packages/sdk/src/providers/openai.test.ts`
- Modify: `packages/sdk/src/providers/deepseek.test.ts`

- [x] Add failing tests for OpenAI `prompt_tokens_details.cached_tokens` in non-streaming and streaming usage.
- [x] Add failing test for DeepSeek `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`.
- [x] Normalize OpenAI-compatible usage into `input_tokens`, `output_tokens`, `cache_read_input_tokens`.
- [x] Verify targeted provider tests pass.

## Chunk 2: Runtime Split Cache Fields

**Files:**
- Modify: `packages/shared/src/types/runtime-event.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/runner/run-item-events.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/runner/run-observer.ts`
- Modify: `apps/sidecar/src/services/agent/agent-service.ts`
- Modify tests under the same sidecar/web areas.

- [x] Add failing tests that runtime `usage.updated` and persisted `tokenUsage` expose cache read/write split fields.
- [x] Carry split cache fields alongside `cachedTokens`.
- [x] Verify sidecar targeted tests pass.

## Chunk 3: Web Display Management

**Files:**
- Modify: `apps/web/src/components/agent/runtime-message-view.ts`
- Modify: `apps/web/src/components/agent/runtime-event-message-projection.ts`
- Modify: `apps/web/src/components/agent/agent-message-state.ts`
- Modify: `apps/web/src/components/agent/RuntimeEventContentBlock.tsx`
- Modify web tests for projection and footer rendering.

- [x] Add failing tests that live and persisted token usage preserve cache read/write.
- [x] Add footer tooltip/cache metric support without adding vendor-specific logic.
- [x] Verify targeted web tests and `@lume/web` typecheck pass.
