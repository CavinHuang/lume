import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { LinkOAuthSession } from "@lume/shared";
import { PersistentOAuthSessions } from "./persistent-oauth-sessions";

const baseSession = (overrides: Partial<LinkOAuthSession & { startedAt: number }> = {}): LinkOAuthSession & { startedAt: number } => ({
  state: "state-1",
  service: "github",
  connectionName: "work",
  authorizationUrl: "https://example.test/authorize",
  status: "pending",
  startedAt: Date.now(),
  ...overrides,
});

describe("PersistentOAuthSessions", () => {
  test("recovers sessions across instances (sidecar restart)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-oauth-"));
    try {
      new PersistentOAuthSessions(dir).set("state-1", baseSession());
      const reloaded = new PersistentOAuthSessions(dir);
      expect(reloaded.get("state-1")).toMatchObject({ state: "state-1", service: "github", status: "pending" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("expires pending sessions older than 5min on load", () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-oauth-"));
    try {
      new PersistentOAuthSessions(dir).set("state-old", baseSession({ state: "state-old", startedAt: Date.now() - 6 * 60_000 }));
      expect(new PersistentOAuthSessions(dir).get("state-old")?.status).toBe("timed_out");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("falls back to in-memory when configDir is undefined", () => {
    const sessions = new PersistentOAuthSessions(undefined);
    sessions.set("state-1", baseSession());
    expect(sessions.get("state-1")).toMatchObject({ state: "state-1" });
    expect([...sessions.values()]).toEqual([expect.objectContaining({ state: "state-1" })]);
  });

  test("persists atomically (single JSON file on disk after set)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-oauth-"));
    try {
      new PersistentOAuthSessions(dir).set("state-1", baseSession());
      const entries = JSON.parse(readFileSync(join(dir, "link-oauth-sessions.json"), "utf8")) as Array<[string, unknown]>;
      expect(entries).toHaveLength(1);
      expect(entries[0]?.[0]).toBe("state-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("delete removes from memory and disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-oauth-"));
    try {
      const sessions = new PersistentOAuthSessions(dir);
      sessions.set("state-1", baseSession());
      sessions.delete("state-1");
      expect(new PersistentOAuthSessions(dir).get("state-1")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
