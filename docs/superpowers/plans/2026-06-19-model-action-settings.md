# Model Action Settings Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a model settings tab that lets users configure models for existing runtime actions.

**Architecture:** Reuse existing model option utilities and config update IPC. Add only `models.routine.defaultModelRef` for schedule planning; all other rows use existing config/runtime paths.

**Tech Stack:** TypeScript, React, zod, existing Lume config IPC.

---

## Chunk 1: Config And Runtime

**Files:**
- Modify: `packages/shared/src/types/lume-config.ts`
- Modify: `apps/sidecar/src/rpc/schemas.ts`
- Modify: `apps/sidecar/src/services/system/lume-config-service.ts`
- Modify: `apps/web/src/lib/desktop-api/lume-config.ts`
- Modify: `apps/sidecar/src/services/routine/routine-llm-adapter.ts`

- [x] Add `models.routine.defaultModelRef` to shared types, update schema, and normalize it.
- [x] Add a desktop API helper for saving the routine model.
- [x] Make routine planning prefer `models.routine.defaultModelRef`, then fall back to existing defaults.
- [x] Run the smallest relevant schema/runtime tests.

## Chunk 2: Settings UI

**Files:**
- Modify: `apps/web/src/components/settings/AgentSettings.tsx`

- [x] Add top tabs: `模型供应商`, `模型设置`.
- [x] Keep current provider UI under `模型供应商`.
- [x] Add compact grouped rows for Agent, sub Agent, routine, memory extraction, rerank, and Embedding.
- [x] Reuse existing update helpers and native `<select>`.
- [x] Run typecheck or the smallest targeted web test if logic breaks type safety.
