# Runtime Kernel Boundary Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the final-state Lume runtime architecture where Agent Runtime Kernel owns product truth, Tool Runtime owns AI-visible capability governance, Service Runtime owns background jobs, and hosts/adapters do not own business state.

**Architecture:** Build this as a sequence of behavior-preserving, testable boundary extractions. Each phase must create a real protocol or ownership move, not a pass-through bridge or cosmetic wrapper. Existing behavior stays available while consumers migrate to the new Kernel/Runtime contracts.

**Tech Stack:** Bun, TypeScript, `@lume/shared`, sidecar services under `apps/sidecar/src/services/agent-runtime`, targeted `bun test` and package typecheck.

---

## Cleanup Rules

- Prefer deletion over addition once a new boundary owns behavior.
- Do not add dependencies.
- Do not introduce files whose only job is to rename old calls.
- Keep old APIs only as temporary compatibility surfaces with a named removal target.
- Every testable behavior change starts with a failing test.
- Do not touch unrelated dirty files unless the boundary move requires it.

## Target Boundaries

- `packages/shared/src/types/agent-loop.ts`: shared Kernel input/result contract.
- `packages/shared/src/types/runtime-event.ts`: shared product event protocol.
- `apps/sidecar/src/services/agent-runtime/runner/run-item-events.ts`: projector from Kernel facts to product events.
- `apps/sidecar/src/services/agent-runtime/tools/`: Tool Runtime ownership for descriptors, resolution, approval, payload policy.
- `apps/sidecar/src/services/agent-runtime/runtime-orchestrator.ts`: Host facade that calls Kernel API without owning run truth.
- `apps/sidecar/src/services/agent-runtime/service-runtime/`: Service Runtime jobs scheduled outside the main agent response path.

## Phase 1: Kernel Protocol

- [x] Add failing tests for `projectRunStateToRuntimeEvents`.
- [x] Add shared `AgentLoopInput`, `AgentLoopResult`, and `LumeRuntimeEvent` types.
- [x] Export the shared types.
- [x] Implement RuntimeEvent projection from existing `LumeRunState` / `LumeRunItem`.
- [x] Verify targeted runner tests and shared typecheck.

## Phase 2: Tool Runtime Ownership

- [x] Add failing tests for `ToolRegistry` descriptor registration and fail-closed metadata.
- [x] Move tool metadata shape into `agent-runtime/tools/tool-types.ts`.
- [x] Implement resolver that consumes existing source tools and policies without duplicating policy decisions.
- [x] Replace `buildRuntimeCoreTools` direct policy filtering with Tool Runtime resolver ownership.
- [x] Verify tool policy and runtime-core tests.

## Phase 3: Execution Gateway

- [x] Add failing tests for approval/guardrail decision order.
- [x] Move `createCanUseToolHandler` decision logic behind a Tool Runtime gateway.
- [x] Keep AskUserQuestion and approval interruption behavior intact.
- [x] Delete duplicated approval/risk inference once the gateway owns it.
- [x] Verify approval bridge, guardrail, and attempt tests.

## Phase 4: Host Facade And Kernel API

- [x] Add failing tests showing runtime dispatch state belongs to Kernel.
- [x] Introduce `AgentRuntimeKernel` API for per-thread dispatch queue ownership.
- [x] Thin `agent-service.ts` by deleting local active/queued dispatch state.
- [x] Move run dispatch queue out of agent-service.
- [x] Verify agent-service, rpc run-events, and runtime-state tests.

## Phase 5: Service Runtime

- [x] Add failing tests for service job scheduling outside the final response path.
- [x] Move title generation and memory flush scheduling into Service Runtime.
- [x] Ensure failed background jobs only emit service/trace events and do not change run completion.
- [x] Verify agent-service and memory flush related tests.

## Phase 6: Cutover And Deletion

- [ ] Remove obsolete compatibility surfaces once consumers use RuntimeEvent.
- [x] Add live `agent:runtime-event` notifications from runner through sidecar RPC.
- [x] Cut `AgentMessages` history hydration and default live rendering to RuntimeEvent projection.
- [x] Rename/delete agent-runtime bridge terminology for interactive sessions.
- [x] Run targeted sidecar typecheck.
- [x] Update architecture docs with the actual implemented file map.
