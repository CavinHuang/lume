# IM Weixin Integration

Date: 2026-05-24
Status: Approved for implementation planning
Scope: Sidecar-managed IM integration, starting with Tencent OpenClaw Weixin protocol compatibility

## Summary

Add a first-party IM integration layer to Lume. The first supported channel is Weixin, implemented as a protocol-compatible adapter for the public Tencent `openclaw-weixin` plugin backend contract.

The goal is to let messages from Weixin enter a Lume agent thread and let the agent reply through the same Weixin conversation without embedding the OpenClaw runtime as a dependency. Lume should reuse OpenClaw Weixin's mature protocol shape, but keep ownership of runtime orchestration, thread mapping, safety policy, settings, and UI.

Phase 1 focuses on text messages and multi-account isolation. Media upload, Feishu, Telegram, and richer directory features are designed as follow-on adapters behind the same IM service boundary.

## References

- Tencent OpenClaw Weixin plugin: `https://github.com/Tencent/openclaw-weixin`
- Tencent plugin README: `https://github.com/Tencent/openclaw-weixin/blob/main/README.md`
- Tencent plugin API implementation: `https://github.com/Tencent/openclaw-weixin/blob/main/src/api/api.ts`
- Tencent plugin text send implementation: `https://github.com/Tencent/openclaw-weixin/blob/main/src/messaging/send.ts`
- Community proxy plugin used as a comparison point: `https://github.com/freestylefly/openclaw-wechat`
- Alice static analysis confirmed the same broad iLink shape: token auth, long-poll updates, `context_token`, and `sendmessage`.

## Goals

- Support Weixin inbound text messages through the Tencent OpenClaw Weixin backend protocol.
- Support Weixin text replies from Lume agent threads.
- Keep IM accounts, model-provider channels, and MCP servers as separate concepts.
- Reuse existing agent thread, runtime tool, RPC, settings, and workspace patterns.
- Store IM credentials locally with the same encryption posture used for provider API keys.
- Keep the first implementation small enough to review safely.

## Non-Goals

- Do not embed OpenClaw as a runtime dependency.
- Do not implement the full OpenClaw plugin SDK.
- Do not support Weixin media upload in Phase 1.
- Do not add new dependencies unless a later implementation review proves one is unavoidable.
- Do not build Feishu or Telegram in the first implementation chunk.
- Do not expose arbitrary outbound IM sending from unrelated agent threads.

## Chosen Approach

Build a native Lume IM service with an OpenClaw Weixin protocol adapter.

The service owns local config, account lifecycle, long-poll workers, deduplication, thread binding, and agent dispatch. The Weixin adapter owns the HTTP JSON protocol:

- `ilink/bot/getupdates`
- `ilink/bot/sendmessage`
- `ilink/bot/getuploadurl` later
- `ilink/bot/getconfig` later
- `ilink/bot/sendtyping` later

This avoids coupling Lume to OpenClaw internals while still following the official plugin's mature backend contract.

## Alternatives Considered

### Embed OpenClaw Runtime

This would maximize compatibility with OpenClaw plugins, but it would introduce a second agent runtime, config model, gateway lifecycle, and plugin host inside Lume. That is too large for the first integration.

### Reimplement Alice iLink Behavior Directly

This is close to the desired UX, but Alice was inspected from bundled, minified output. The Tencent plugin now documents the relevant backend protocol, so Lume should target the documented contract instead of reverse-engineered internals.

### MCP-Only Bridge

An MCP bridge could expose send/list tools, but inbound IM message delivery and automatic thread dispatch are not a natural fit for MCP tools alone. MCP can remain useful for external integrations, but Lume needs a sidecar service for live IM receiving.

## Architecture

Add an IM service group under sidecar:

- `apps/sidecar/src/services/im/im-config-manager.ts`
- `apps/sidecar/src/services/im/im-thread-binding-store.ts`
- `apps/sidecar/src/services/im/im-runtime-manager.ts`
- `apps/sidecar/src/services/im/im-message-router.ts`
- `apps/sidecar/src/services/im/weixin/openclaw-weixin-api.ts`
- `apps/sidecar/src/services/im/weixin/openclaw-weixin-worker.ts`
- `apps/sidecar/src/services/agent-runtime/tools/im/create-im-tools.ts`

Shared contracts live in:

- `packages/shared/src/types/im.ts`
- `packages/shared/src/types/index.ts`

RPC handlers live in:

- `apps/sidecar/src/rpc/im-handlers.ts`
- `apps/sidecar/src/rpc/create-rpc-handlers.ts`
- `apps/sidecar/src/rpc/schemas.ts`

The web UI adds an IM settings surface:

- `apps/web/src/lib/desktop-api/im.ts`
- `apps/web/src/components/settings/ImSettings.tsx`
- `apps/web/src/components/settings/general-settings-state.ts`

If credential encryption helpers are still private to `channel-manager`, extract them to a small shared infra module:

- `apps/sidecar/src/services/infra/secret-crypto.ts`
- Update `apps/sidecar/src/services/channel/channel-manager.ts` to use the helper without changing stored channel config compatibility.

## Data Model

Store IM config separately from model channels:

```ts
interface ImIntegrationConfig {
  version: 1
  accounts: ImAccount[]
}

interface ImAccount {
  id: string
  provider: "weixin"
  label: string
  enabled: boolean
  baseUrl: string
  encryptedToken?: string
  botAgent?: string
  accountKey?: string
  status?: {
    lastStartedAt?: number
    lastStoppedAt?: number
    lastError?: string
  }
  createdAt: number
  updatedAt: number
}
```

Store thread bindings separately:

```ts
interface ImThreadBinding {
  provider: "weixin"
  accountId: string
  peerKind: "direct" | "group"
  peerId: string
  threadId: string
  contextToken?: string
  lastMessageId?: string
  updatedAt: number
}
```

The binding key is `provider/accountId/peerKind/peerId`. This matches OpenClaw's multi-account isolation guidance and prevents two logged-in Weixin accounts from sharing one direct-message session by accident.

## Weixin Adapter

The adapter exposes a small internal interface:

```ts
interface WeixinAdapter {
  getUpdates(input: { cursor?: string; signal?: AbortSignal }): Promise<WeixinUpdateBatch>
  sendText(input: { toUserId: string; contextToken?: string; text: string }): Promise<{ messageId: string }>
}
```

Requests follow the Tencent plugin protocol:

- POST JSON requests.
- Headers include `Content-Type: application/json`.
- Headers include `AuthorizationType: ilink_bot_token`.
- Headers include `Authorization: Bearer <token>`.
- Headers include `X-WECHAT-UIN`.
- Bodies include `base_info` with `channel_version` and `bot_agent`.

For Phase 1, `sendText` constructs a `sendmessage` payload with one text item:

```json
{
  "msg": {
    "from_user_id": "",
    "to_user_id": "<peer id>",
    "client_id": "<generated id>",
    "message_type": 2,
    "message_state": 2,
    "context_token": "<latest context token>",
    "item_list": [
      { "type": 1, "text_item": { "text": "..." } }
    ]
  }
}
```

## Login And Account Setup

Phase 1 should expose the account setup shape in UI and RPC, but the implementation plan may split login into a separate chunk if the Tencent QR login endpoint needs more source verification.

Required account fields:

- `baseUrl`
- `token` after login
- optional `botAgent`
- `enabled`
- user-facing label

If QR login is implemented in the first chunk, Lume should mirror OpenClaw's flow:

1. Start login.
2. Return QR code data to the web UI.
3. Poll login status.
4. Persist token/account metadata after confirmation.
5. Start the account worker.

If QR login details are not fully stable at implementation time, ship manual token import first, but keep the UI and service interface compatible with QR login.

## Inbound Flow

1. On sidecar boot, `im-runtime-manager` loads enabled accounts.
2. Each account starts one `openclaw-weixin-worker`.
3. The worker long-polls `getupdates` with the stored cursor.
4. Each message is normalized into a Lume IM envelope.
5. Deduplication drops already-seen message IDs.
6. `im-thread-binding-store` resolves or creates the target agent thread.
7. The latest `context_token` is stored on the binding.
8. The message is sent to the agent with:
   - `chatType: "direct"` or `"group"`
   - `threadType: "channel"`
   - `messageMetadata.im` describing provider, account, peer, message id, and context token
   - a restricted tool policy for IM-originated runs

The user-facing message body should include speaker attribution for group messages and minimal channel context for direct messages.

## Outbound Flow

Add a Lume runtime tool named `send_im_message`.

Phase 1 tool behavior:

- Sends text only.
- Only sends to the current thread's bound IM peer.
- Does not accept arbitrary target IDs.
- Returns a structured success result with provider, account id, peer id, and message id.
- Returns an error if the current thread has no active IM binding.

This keeps external side effects narrow. A future `send_im_message_to` tool can support explicit targets with stronger approval rules.

The IM-originated prompt should instruct the agent to use `send_im_message` for final replies. The tool result should warn that the message has already been delivered and must not be sent again.

## Runtime Safety

External IM users should not get unrestricted local-machine access through an agent thread.

For IM-originated runs, the router should provide a default tool policy that:

- Allows `send_im_message`.
- Allows low-risk read/context tools as appropriate.
- Denies write, edit, shell, subagent, automation mutation, and arbitrary MCP tools by default.
- Keeps the policy configurable later per account or workspace.

This should be implemented through existing `messageMetadata.toolPolicy` merging rather than creating a second permission system.

## Error Handling

The runtime should handle:

- Account disabled: worker does not start.
- Missing token: account status is `auth_needed`.
- HTTP 401/403 or auth-like error: stop worker and mark account `auth_needed`.
- Weixin session timeout codes such as `errcode: -14`: mark account `auth_needed`.
- Long-poll timeout: treat as normal and retry.
- Network failure: retry with bounded backoff and record last error.
- Duplicate messages: drop by `(accountId, messageId)` with a bounded cache.
- Missing `context_token`: allow inbound thread creation, but warn on outbound send.
- Unsupported media message: append a short unsupported-media notice to the thread in Phase 1 instead of failing the worker.

## UI

Add an `IM` or `Integrations` tab under Settings.

Phase 1 fields:

- Provider: Weixin
- Account label
- Base URL
- Token or QR login action
- Bot agent string
- Enabled toggle
- Status: stopped, running, auth needed, error
- Start/stop/reconnect actions

The UI should not present this as a model channel. It is an external messaging account.

## Tests

Use focused tests only for the touched logic:

- `openclaw-weixin-api.test.ts`
  - builds required headers
  - sends `getupdates` with cursor and `base_info`
  - sends text `sendmessage` with `context_token`
  - maps long-poll abort to empty updates
- `im-thread-binding-store.test.ts`
  - isolates by provider/account/peer
  - updates `contextToken`
  - reuses existing thread binding
- `im-message-router.test.ts`
  - maps direct/group Weixin messages to `AgentSendInput`
  - applies IM tool policy
  - drops duplicates
- `send-im-message-tool.test.ts`
  - rejects unbound threads
  - sends to the bound peer only
  - returns already-delivered warning
- `im-config-manager.test.ts`
  - encrypts token at rest
  - preserves existing config while updating status

Do not run full repository lint or full test suites for this feature unless the implementation touches public shared contracts broadly enough to justify it. Run the targeted tests for modified modules.

## Rollout Plan

Phase 1:

- Weixin config storage.
- Manual token import or QR login if endpoint details are confirmed.
- Worker long-poll text receive.
- Thread binding.
- `send_im_message` text reply tool.
- Settings status surface.

Phase 2:

- QR login if deferred.
- Typing indicator via `getconfig` and `sendtyping`.
- Image/file receive notices upgraded to attachments.
- Media send through `getuploadurl` and CDN upload.

Phase 3:

- Feishu adapter.
- Telegram adapter.
- Per-account routing policy and allowlist.
- Explicit outbound target tool with approval.

## Open Questions

- Which QR login endpoints and persisted token shape should Lume mirror from the Tencent plugin? This needs one more source pass during implementation planning.
- Should Lume expose a public callback URL option for future webhook-style adapters, or keep Phase 1 Weixin as long-poll only?
- What default model/workspace should new IM threads use when multiple workspaces exist?

## Approval

The user approved the direction:

- Use option C.
- Reuse the OpenClaw Weixin link/plugin approach.
- Implement Lume natively against the protocol instead of embedding OpenClaw runtime.
