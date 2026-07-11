import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesktopContextSnapshot, DesktopProactiveProposal } from "@lume/shared";
// @ts-expect-error Node strip-types requires the explicit extension for this standalone test.
import { DesktopContextStore, redactDesktopText } from "./desktop-context-store.ts";

const dirs: string[] = [];
const sqliteTest = (globalThis as { Bun?: unknown }).Bun ? test.skip : test;
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function snapshot(id: string, capturedAt: number, text: string): DesktopContextSnapshot {
  return {
    id,
    app: { id: "wechat.exe", name: "微信", processId: 42 },
    window: {
      id: "win:42",
      appId: "wechat.exe",
      title: "项目群",
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      focused: true,
    },
    capturedAt,
    eventType: "foreground_changed",
    visibleText: text,
    untrusted: true,
  };
}

function proposal(id: string, createdAt: number): DesktopProactiveProposal {
  return {
    id,
    kind: "reply",
    status: "pending",
    snapshotId: "snap-1",
    app: { id: "wechat.exe", name: "微信" },
    window: { id: "win:42", title: "敏感项目群" },
    summary: "微信中可能有一条需要回复的消息",
    createdAt,
    expiresAt: createdAt + 30 * 60 * 1_000,
  };
}

function createStore(options: { now?: () => number; retentionMs?: number; maxBytes?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lume-desktop-context-"));
  dirs.push(dir);
  const dbPath = join(dir, "context.sqlite");
  return {
    dbPath,
    store: new DesktopContextStore({
      dbPath,
      key: Buffer.alloc(32, 7),
      now: options.now,
      retentionMs: options.retentionMs,
      maxBytes: options.maxBytes,
    }),
  };
}

describe("DesktopContextStore", () => {
  sqliteTest("encrypts raw snapshots and exposes only redacted search text", () => {
    const { dbPath, store } = createStore();
    store.put(snapshot("snap-1", 100, "请回复客户，password=super-secret，验证码 123456"));

    const databaseBytes = readFileSync(dbPath).toString("utf8");
    assert.doesNotMatch(databaseBytes, /super-secret/);
    assert.doesNotMatch(databaseBytes, /123456/);
    const results = store.search("回复客户");
    assert.equal(results.length, 1);
    assert.match(results[0]?.visibleText ?? "", /\[REDACTED\]/);
    assert.match(store.get("snap-1")?.visibleText ?? "", /super-secret/);
    store.close();
  });

  sqliteTest("purges snapshots outside the retention window", () => {
    const now = 100_000;
    const { store } = createStore({ now: () => now, retentionMs: 1_000 });
    store.put(snapshot("old", now - 1_001, "旧消息"));
    store.put(snapshot("new", now, "新消息"));
    store.purge();
    assert.equal(store.get("old"), undefined);
    assert.equal(store.get("new")?.id, "new");
    store.close();
  });

  sqliteTest("evicts oldest encrypted payloads when the byte quota is exceeded", () => {
    const { store } = createStore({ maxBytes: 300, now: () => 2 });
    store.put(snapshot("first", 1, "a".repeat(200)));
    store.put(snapshot("second", 2, "b".repeat(200)));
    store.purge();
    assert.equal(store.get("first"), undefined);
    assert.equal(store.get("second")?.id, "second");
    store.close();
  });

  sqliteTest("encrypts proactive proposals and restores their status after restart", () => {
    const { dbPath, store } = createStore();
    store.putProposal(proposal("proposal-1", 100), "fingerprint-1");
    store.updateProposalStatus("proposal-1", "dismissed");
    store.close();

    assert.doesNotMatch(readFileSync(dbPath).toString("utf8"), /敏感项目群/);
    const reopened = new DesktopContextStore({ dbPath, key: Buffer.alloc(32, 7) });
    assert.deepEqual(reopened.listProposalRecords(), [{
      proposal: { ...proposal("proposal-1", 100), status: "dismissed" },
      fingerprint: "fingerprint-1",
    }]);
    reopened.close();
  });
});

test("redactDesktopText removes common credential and OTP forms", () => {
  assert.equal(
    redactDesktopText("password: abc token=xyz 验证码 654321"),
    "password: [REDACTED] token=[REDACTED] 验证码 [REDACTED]",
  );
});

sqliteTest("keeps screenshot pixels encrypted but removes them from redacted projections", () => {
  const { dbPath, store } = createStore();
  const input = {
    ...snapshot("snap-image", 200, "客户问能否今天交付"),
    screenshots: [{
      id: "shot-1",
      width: 320,
      height: 200,
      origin: { x: 10, y: 20 },
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,iVBORw0KGgo=",
    }],
  };

  store.put(input);

  const databaseText = readFileSync(dbPath).toString("utf8");
  assert.doesNotMatch(databaseText, /iVBORw0KGgo=/);
  assert.equal(store.get("snap-image")?.screenshots?.[0]?.dataUrl, "data:image/png;base64,iVBORw0KGgo=");
  const redacted = store.getRedacted("snap-image");
  assert.equal(redacted?.screenshots?.[0]?.mimeType, "image/png");
  assert.equal(redacted?.screenshots?.[0]?.dataUrl, undefined);
  store.close();
});
