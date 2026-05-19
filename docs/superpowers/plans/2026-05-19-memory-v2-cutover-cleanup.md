# Memory V2 Cutover Cleanup

## Goal

Cut the memory system over to Memory V2 as the only implementation path. Remove the old database, embedding, global-promotion, indexing, flush, and distillation implementation instead of keeping bridge wrappers.

## Scope

1. Tool surface
   - Keep only `memory.search`, `memory.read`, and `memory.remember`.
   - Remove maintenance/global/episode/index tools from policy groups, runtime tool creation, metadata, and shared tool-name types.

2. Runtime and sidecar startup
   - Stop starting the old memory sync watcher.
   - Keep user-message memory injection and V2 capture as the runtime path.
   - Remove compaction memory flush jobs tied to the old service runtime.

3. RPC and settings
   - Replace old memory RPC channels with V2 search/read/remember handlers.
   - Simplify the settings memory surface so it no longer depends on indexing, distillation, provider status, or global candidates.

4. Source deletion
   - Delete old `apps/sidecar/src/services/memory/*` implementation files and obsolete tests.
   - Keep only a small V2 tool/policy boundary if existing imports need the `services/memory` path.

## Verification

- Focused tests for memory tools, tool policy expansion, memory settings state, and runtime memory injection.
- Sidecar and web typecheck if public/shared types change.
