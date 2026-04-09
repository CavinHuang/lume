# Agent Proma Full Alignment Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish aligning Lume Agent end-to-end with Proma’s architecture so raw SDK messages are the canonical source across sidecar persistence, RPC, and web rendering, while shrinking legacy compatibility layers to pure fallback paths.

**Architecture:** Keep the current Tauri + sidecar structure, but make Agent behavior follow Proma’s shape: raw SDK transcript persisted independently, thread operations rebuild that transcript consistently, frontend renders from `persistedSDKMessages + liveMessages`, and only old sessions or old UI affordances use `AgentMessage[]` as compatibility output.

**Tech Stack:** Bun, TypeScript, Tauri sidecar, React + Jotai, `@lume/agent-sdk`, local JSON/JSONL persistence

---

## Chunk 1: Backend Canonical Source Completion

### Task 1: Finish raw SDK transcript parity in thread manager

**Files:**
- Modify: `apps/sidecar/src/services/agent/agent-thread-manager.ts`
- Test: `apps/sidecar/src/services/agent/agent-thread-manager.test.ts`
- Test: `apps/sidecar/src/services/agent/agent-thread-manager.merge-turns.test.ts`

- [x] Keep raw SDK transcript in a single `${threadId}.jsonl` file as the canonical thread history source.
- [x] Ensure `append / replace / truncate / fork / migrate / delete` all keep raw SDK transcript, runtime-core transcript, and version store in sync.
- [x] Keep transcript re-projection only as a fallback for threads without raw SDK transcript.
- [x] Add or update tests for append, fork, truncate, migrate, and fallback read behavior.

### Task 2: Complete send pipeline parity with Proma

**Files:**
- Modify: `apps/sidecar/src/services/agent/agent-service.ts`
- Test: `apps/sidecar/src/services/agent/agent-service.test.ts`

- [x] Persist user SDK messages before execution starts.
- [x] Persist assistant/result/tool_result/system SDK messages at turn completion and on error paths.
- [x] Keep title generation, runtime status, and memory flush behavior working off thread terminology and canonical history.
- [x] Add tests for thread send lifecycle where raw SDK transcript and visible assistant version are both updated.

## Chunk 2: RPC and Contract Completion

### Task 3: Complete RPC contract alignment

**Files:**
- Modify: `packages/shared/src/types/agent.ts`
- Modify: `apps/sidecar/src/rpc/agent-handlers.ts`
- Modify: `apps/web/lib/desktop-api/agent.ts`
- Test: `apps/web/lib/desktop-api.agent-runtime-status.test.ts`

- [x] Expose the remaining thread-level SDK transcript reads and append notifications cleanly through RPC.
- [x] Remove stale session-oriented naming from active thread RPC paths where compatibility is no longer needed.
- [x] Keep compatibility aliases only when a live caller still depends on them.
- [x] Verify desktop API wrappers expose the final Agent thread contract surface.

## Chunk 3: Frontend Rendering Cutover

### Task 4: Make SDK messages the primary render source

**Files:**
- Modify: `apps/web/atoms/agent-atoms.ts`
- Modify: `apps/web/components/agent/AgentView.tsx`
- Modify: `apps/web/components/agent/AgentMessages.tsx`
- Modify: `apps/web/components/agent/hooks/useAgentSessionLifecycle.ts`
- Modify: `apps/web/components/agent/hooks/useAgentStreamSubscriptions.ts`
- Modify: `apps/web/lib/agent-streaming.ts`

- [x] Keep `persistedSDKMessages` and `liveMessages` as independent sources like Proma.
- [x] Render persisted groups first, then live groups, with fallback placeholder bubbles only when live assistant content is absent.
- [x] Stop using `AgentMessage.sdkMessages` as the primary source when full persisted/live SDK transcripts are available.
- [x] Preserve layout stability at stream completion without forcing whole-thread reloads.

### Task 5: Reduce `AgentMessage[]` to compatibility/fallback

**Files:**
- Modify: `apps/web/components/agent/AgentMessages.tsx`
- Modify: `apps/web/lib/agent-message-merge.ts`
- Modify: `apps/web/lib/agent-tool-activity.ts`

- [x] Keep version navigation, inline edit, and delete actions working for legacy/message-version flows.
- [x] Use `AgentMessage[]` mainly for user-visible versioned thread records and legacy fallback, not for primary SDK rendering.
- [x] Ensure tool activity reconstruction prefers full SDK transcripts when present.

## Chunk 4: Tooling Surface Alignment

### Task 6: Continue shrinking non-Proma tool wrappers

**Files:**
- Modify: `apps/sidecar/src/services/pi-agent/tools/session/create-session-tools.ts`
- Modify: `apps/sidecar/src/services/pi-agent/tools/create-lume-tools.ts`
- Modify: `apps/sidecar/src/services/pi-agent/tools/permissions/tool-metadata.ts`
- Modify: `apps/sidecar/src/services/pi-agent/tools/permissions/tool-policy.ts`
- Test: `apps/sidecar/src/services/pi-agent/tools/session/create-session-tools.test.ts`

- [x] Keep SDK-native tool names (`Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `WebSearch`, `WebFetch`, `AskUserQuestion`) as the runtime truth.
- [x] Audit `sessions_* / subagents_* / cron_* / memory_*` and identify which ones are true product tools versus wrappers around SDK-native behavior.
- [x] Where possible, move toward Proma’s preference for native `Agent / Task* / TaskOutput` semantics and compatibility normalization instead of redundant wrappers.

## Chunk 5: Final Verification and Cleanup

### Task 7: Full Agent regression pass

**Files:**
- Test: `apps/sidecar/src/services/agent/agent-thread-manager.test.ts`
- Test: `apps/sidecar/src/services/agent/agent-thread-manager.merge-turns.test.ts`
- Test: `apps/sidecar/src/services/pi-agent/runtime-core/run.test.ts`
- Test: `apps/sidecar/src/services/pi-agent/tools/session/create-session-tools.test.ts`
- Test: `apps/web/lib/desktop-api.agent-runtime-status.test.ts`
- Test: `apps/web/lib/agent-message-appended.test.ts`

- [x] Run `bun run --filter @lume/sidecar typecheck`
- [x] Run `bun run --filter @lume/web typecheck`
- [x] Run targeted Agent sidecar tests
- [x] Run targeted Agent web tests
- [x] Record any still-unaligned Proma differences that are intentional or blocked by SDK limitations

## Current Status Snapshot

- [x] Base SDK tool names aligned to Proma-style native names
- [x] `AskUserQuestion` switched to native SDK tool + interception flow
- [x] Raw SDK transcript persistence introduced on sidecar
- [x] Frontend `persistedSDKMessages + liveMessages` state model introduced
- [x] Frontend render path fully centered on SDK transcript groups
- [x] Thread operations and RPC surface fully normalized around the canonical raw SDK transcript
- [x] Legacy compatibility paths reduced to explicit fallback-only behavior

## Remaining Notes

- `AgentMessage[]` 仍保留给版本导航、inline edit、delete 与旧 transcript fallback 使用；主渲染、Todo 提取、工具活动恢复已优先使用完整 SDK transcript。
- 子任务能力仍保留 `subagents_*` 作为产品语义层；线程管理工具已统一切换为 `threads_*`。
