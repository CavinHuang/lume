# IM Weixin Integration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first Lume IM integration slice: multiple Weixin account records, OpenClaw Weixin text protocol support, per-conversation thread binding, and a guarded `send_im_message` runtime tool.

**Architecture:** Add a sidecar-owned IM service independent from model-provider channels. Shared types define the public RPC shape, sidecar stores encrypted Weixin account credentials and thread bindings under `~/.lume`, workers/adapters speak the Tencent OpenClaw Weixin HTTP JSON protocol, and agent runtime tools send replies only to the current thread's bound IM peer. The web Settings integrations surface lists multiple linked Weixin accounts and supports manual token configuration for Phase 1.

**Tech Stack:** TypeScript, Bun tests, existing sidecar JSON-RPC handlers, existing Lume agent runtime tool system, existing web/Tauri sidecar API helpers, no new dependencies.

---

## Chunk 1: Shared Contracts And Storage

### Task 1: Shared IM Types

**Files:**
- Create: `packages/shared/src/types/im.ts`
- Modify: `packages/shared/src/types/index.ts`
- Test: `packages/shared/src/types/im.test.ts`

- [ ] **Step 1: Write failing shared type tests**

```ts
import { IM_IPC_CHANNELS, normalizeImAccountLabel } from "./im";

test("IM IPC channel names are stable", () => {
  expect(IM_IPC_CHANNELS.LIST_ACCOUNTS).toBe("im:list-accounts");
  expect(IM_IPC_CHANNELS.CREATE_ACCOUNT).toBe("im:create-account");
});

test("normalizeImAccountLabel falls back to provider label", () => {
  expect(normalizeImAccountLabel({ provider: "weixin", label: "  " })).toBe("Weixin");
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `bun test packages/shared/src/types/im.test.ts`

Expected: FAIL because `./im` does not exist.

- [ ] **Step 3: Implement shared IM types**

Create `im.ts` with:
- `ImProvider = "weixin"`
- redacted account view `ImAccount`
- create/update input types
- account status types
- `IM_IPC_CHANNELS`
- `normalizeImAccountLabel`

Export it from `packages/shared/src/types/index.ts`.

- [ ] **Step 4: Verify GREEN**

Run: `bun test packages/shared/src/types/im.test.ts`

Expected: PASS.

### Task 2: Secret Crypto Extraction

**Files:**
- Create: `apps/sidecar/src/services/infra/secret-crypto.ts`
- Modify: `apps/sidecar/src/services/channel/channel-manager.ts`
- Test: `apps/sidecar/src/services/infra/secret-crypto.test.ts`

- [ ] **Step 1: Write failing crypto tests**

```ts
import { decryptSecret, encryptSecret } from "./secret-crypto";

test("encryptSecret round-trips without returning plaintext", () => {
  const encrypted = encryptSecret("secret-value");
  expect(encrypted).not.toBe("secret-value");
  expect(decryptSecret(encrypted)).toBe("secret-value");
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `bun test apps/sidecar/src/services/infra/secret-crypto.test.ts`

Expected: FAIL because `secret-crypto.ts` does not exist.

- [ ] **Step 3: Implement crypto helper and migrate channel manager imports**

Move the existing AES-256-GCM helper logic out of `channel-manager.ts` into `secret-crypto.ts`, then update `channel-manager.ts` to call `encryptSecret` and `decryptSecret`. Preserve the existing ciphertext format so current `channels.json` values remain compatible.

- [ ] **Step 4: Verify GREEN**

Run: `bun test apps/sidecar/src/services/infra/secret-crypto.test.ts`

Expected: PASS.

### Task 3: IM Account Config Manager

**Files:**
- Modify: `apps/sidecar/src/services/infra/config-paths.ts`
- Create: `apps/sidecar/src/services/im/im-config-manager.ts`
- Test: `apps/sidecar/src/services/im/im-config-manager.test.ts`

- [ ] **Step 1: Write failing config-manager tests**

Cover:
- creates multiple Weixin accounts in one config
- redacts tokens from listed accounts
- decrypts a stored token for runtime use
- updates one account without replacing siblings

- [ ] **Step 2: Run the tests and verify RED**

Run: `bun test apps/sidecar/src/services/im/im-config-manager.test.ts`

Expected: FAIL because the IM config manager does not exist.

- [ ] **Step 3: Implement config manager**

Use `getImConfigPath()` in `config-paths.ts`. Store `im.json` under `~/.lume`. Keep the public return shape redacted with `hasToken`.

- [ ] **Step 4: Verify GREEN**

Run: `bun test apps/sidecar/src/services/im/im-config-manager.test.ts`

Expected: PASS.

### Task 4: IM Thread Binding Store

**Files:**
- Modify: `apps/sidecar/src/services/infra/config-paths.ts`
- Create: `apps/sidecar/src/services/im/im-thread-binding-store.ts`
- Test: `apps/sidecar/src/services/im/im-thread-binding-store.test.ts`

- [ ] **Step 1: Write failing binding tests**

Cover:
- binding key uses `provider/accountId/peerKind/peerId`
- the same peer id under two accounts maps to different threads
- context token updates preserve the existing thread
- lookup by `threadId` returns the current binding

- [ ] **Step 2: Run the tests and verify RED**

Run: `bun test apps/sidecar/src/services/im/im-thread-binding-store.test.ts`

Expected: FAIL because the binding store does not exist.

- [ ] **Step 3: Implement binding store**

Use `getImThreadBindingsPath()` in `config-paths.ts`. Store `im-thread-bindings.json` under `~/.lume`.

- [ ] **Step 4: Verify GREEN**

Run: `bun test apps/sidecar/src/services/im/im-thread-binding-store.test.ts`

Expected: PASS.

---

## Chunk 2: Weixin Protocol, Router, And Runtime Tool

### Task 5: OpenClaw Weixin API Adapter

**Files:**
- Create: `apps/sidecar/src/services/im/weixin/openclaw-weixin-api.ts`
- Test: `apps/sidecar/src/services/im/weixin/openclaw-weixin-api.test.ts`

- [ ] **Step 1: Write failing API adapter tests**

Cover:
- `getUpdates` posts `get_updates_buf` and `base_info`
- headers include `AuthorizationType: ilink_bot_token`
- `sendText` posts one text `sendmessage` item with `context_token`
- AbortError during long-poll returns an empty update batch

- [ ] **Step 2: Run the tests and verify RED**

Run: `bun test apps/sidecar/src/services/im/weixin/openclaw-weixin-api.test.ts`

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement minimal adapter**

Use injected `fetch` in tests and global `fetch` in production. Do not implement media upload in this chunk.

- [ ] **Step 4: Verify GREEN**

Run: `bun test apps/sidecar/src/services/im/weixin/openclaw-weixin-api.test.ts`

Expected: PASS.

### Task 6: Message Router

**Files:**
- Create: `apps/sidecar/src/services/im/im-message-router.ts`
- Test: `apps/sidecar/src/services/im/im-message-router.test.ts`

- [ ] **Step 1: Write failing router tests**

Cover:
- creates a thread for a first message
- reuses a thread for later messages from the same account and peer
- creates a distinct thread for the same peer under another account
- sends `chatType`, `threadType`, `messageMetadata.im`, and an IM-limited tool policy

- [ ] **Step 2: Run the tests and verify RED**

Run: `bun test apps/sidecar/src/services/im/im-message-router.test.ts`

Expected: FAIL because the router does not exist.

- [ ] **Step 3: Implement router with dependency injection**

Accept `createThread` and `sendMessage` dependencies so tests do not start the real runtime.

- [ ] **Step 4: Verify GREEN**

Run: `bun test apps/sidecar/src/services/im/im-message-router.test.ts`

Expected: PASS.

### Task 7: Send IM Runtime Tool

**Files:**
- Create: `apps/sidecar/src/services/agent-runtime/tools/im/create-im-tools.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/tools/create-lume-tools.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/tools/tool-metadata.ts`
- Test: `apps/sidecar/src/services/agent-runtime/tools/im/create-im-tools.test.ts`

- [ ] **Step 1: Write failing tool tests**

Cover:
- rejects unbound threads
- sends only to the bound peer
- includes a delivered warning in the result

- [ ] **Step 2: Run the tests and verify RED**

Run: `bun test apps/sidecar/src/services/agent-runtime/tools/im/create-im-tools.test.ts`

Expected: FAIL because the IM tool does not exist.

- [ ] **Step 3: Implement `send_im_message`**

Inject a sender in tests; use `sendBoundImTextMessage` in production. Add the tool to `createLumeRuntimeTools`.

- [ ] **Step 4: Verify GREEN**

Run: `bun test apps/sidecar/src/services/agent-runtime/tools/im/create-im-tools.test.ts`

Expected: PASS.

### Task 8: Weixin Worker And Runtime Manager

**Files:**
- Create: `apps/sidecar/src/services/im/weixin/openclaw-weixin-worker.ts`
- Create: `apps/sidecar/src/services/im/im-runtime-manager.ts`
- Test: `apps/sidecar/src/services/im/weixin/openclaw-weixin-worker.test.ts`
- Test: `apps/sidecar/src/services/im/im-runtime-manager.test.ts`

- [ ] **Step 1: Write failing worker/manager tests**

Cover:
- one worker per enabled account
- one account failure does not stop sibling accounts
- worker saves the latest cursor/context through injected callbacks

- [ ] **Step 2: Run the tests and verify RED**

Run: `bun test apps/sidecar/src/services/im/weixin/openclaw-weixin-worker.test.ts apps/sidecar/src/services/im/im-runtime-manager.test.ts`

Expected: FAIL because worker and runtime manager do not exist.

- [ ] **Step 3: Implement minimal worker and manager**

Keep the loop small: start, stop, process one batch, retry on normal long-poll timeouts, mark auth-like errors.

- [ ] **Step 4: Verify GREEN**

Run: `bun test apps/sidecar/src/services/im/weixin/openclaw-weixin-worker.test.ts apps/sidecar/src/services/im/im-runtime-manager.test.ts`

Expected: PASS.

---

## Chunk 3: RPC And Settings Surface

### Task 9: IM RPC Handlers

**Files:**
- Create: `apps/sidecar/src/rpc/im-handlers.ts`
- Modify: `apps/sidecar/src/rpc/create-rpc-handlers.ts`
- Modify: `apps/sidecar/src/rpc/schemas.ts`
- Modify: `apps/sidecar/src/index.ts`
- Test: `apps/sidecar/src/rpc/im-handlers.test.ts`

- [ ] **Step 1: Write failing RPC tests**

Cover:
- list/create/update/delete account handlers
- start/stop account handlers
- `createRpcHandlers` includes IM methods

- [ ] **Step 2: Run the tests and verify RED**

Run: `bun test apps/sidecar/src/rpc/im-handlers.test.ts apps/sidecar/src/rpc/create-rpc-handlers.test.ts`

Expected: FAIL before handlers exist.

- [ ] **Step 3: Implement RPC handlers and sidecar lifecycle hooks**

Register handlers from `createRpcHandlers`. Start enabled IM accounts on sidecar boot and stop them during shutdown.

- [ ] **Step 4: Verify GREEN**

Run: `bun test apps/sidecar/src/rpc/im-handlers.test.ts apps/sidecar/src/rpc/create-rpc-handlers.test.ts`

Expected: PASS.

### Task 10: Web Settings Integration

**Files:**
- Create: `apps/web/src/lib/desktop-api/im.ts`
- Modify: `apps/web/src/lib/desktop-api/index.ts`
- Create: `apps/web/src/components/settings/im-settings-state.ts`
- Create: `apps/web/src/components/settings/ImSettings.tsx`
- Modify: `apps/web/src/components/settings/SettingsView.tsx`
- Test: `apps/web/src/components/settings/im-settings-state.test.ts`

- [ ] **Step 1: Write failing web state tests**

Cover:
- empty account list copy
- status badge label mapping
- draft normalization trims base URL and token

- [ ] **Step 2: Run the tests and verify RED**

Run: `bun test apps/web/src/components/settings/im-settings-state.test.ts`

Expected: FAIL because the web state helper does not exist.

- [ ] **Step 3: Implement API helper, state helper, and compact settings panel**

Place the IM panel above MCP in the existing `integrations` settings page. Keep the UI dense and operational: account list, add form, token/base URL fields, status, enabled toggle, start/stop/delete.

- [ ] **Step 4: Verify GREEN**

Run: `bun test apps/web/src/components/settings/im-settings-state.test.ts`

Expected: PASS.

---

## Final Verification

- [ ] Run sidecar IM-related tests:

```bash
bun test \
  packages/shared/src/types/im.test.ts \
  apps/sidecar/src/services/infra/secret-crypto.test.ts \
  apps/sidecar/src/services/im/im-config-manager.test.ts \
  apps/sidecar/src/services/im/im-thread-binding-store.test.ts \
  apps/sidecar/src/services/im/weixin/openclaw-weixin-api.test.ts \
  apps/sidecar/src/services/im/weixin/openclaw-weixin-worker.test.ts \
  apps/sidecar/src/services/im/im-message-router.test.ts \
  apps/sidecar/src/services/im/im-runtime-manager.test.ts \
  apps/sidecar/src/services/agent-runtime/tools/im/create-im-tools.test.ts \
  apps/sidecar/src/rpc/im-handlers.test.ts
```

- [ ] Run web IM-related tests:

```bash
bun test apps/web/src/components/settings/im-settings-state.test.ts
```

- [ ] Run targeted typechecks only if exported shared contracts or RPC wiring produce TypeScript uncertainty:

```bash
bun run --filter @lume/shared typecheck
bun run --filter @lume/sidecar typecheck
bun run --filter @lume/web typecheck
```

- [ ] Commit implementation with Lore protocol.
