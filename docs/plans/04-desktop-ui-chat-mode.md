# Task 04 - Desktop UI Chat Mode

## Goal
Ship a production-ready Chat mode UI in Next.js + Tailwind + shadcn/ui.

## In Scope
- Build layout: sidebar sessions, center conversation panel, top workspace bar.
- Implement mode switch UI (`chat`/`agent`) with `chat` fully functional.
- Hook streaming renderer and message state sync.

## Out of Scope
- Agent tool timeline and confirmation panel.

## Deliverables
1. Chat-focused UI routes/components.
2. Message streaming UX (partial token rendering).
3. Basic error and reconnect states.

## Acceptance Criteria
1. Message send/receive works from desktop UI.
2. Session switching and history rendering are stable.
3. No blocking UI during streaming.

## Dependencies
- `03-sidecar-chat-core`.

## Completion Note
- Feasible and completed on 2026-02-12.
- Reused existing Proma-migrated UI/streaming foundation in `apps/web/components/chat/*` and sidecar chat IPC contracts in `packages/shared/src/types/chat.ts`.
- Added stability fix for conversation switching race in `apps/web/components/chat/ChatView.tsx` by guarding async recent-message loads with current conversation ref checks.
- Added basic reconnect state in `apps/web/components/chat/ChatView.tsx` with explicit `重连` action and `重连中...` status for sidecar call recovery path.
- Acceptance mapping:
  1. Send/receive: implemented via `sendChatMessage` + stream events (`chat:stream:*`) in desktop UI.
  2. Session switching/history: side sidebar session switching plus guarded message hydration and history loading.
  3. Non-blocking streaming: streaming state is per-conversation, input remains responsive with stop action and partial token rendering.
