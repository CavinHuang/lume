import { mkdtemp, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { appendPluginAuditEntry, readPluginAuditEntries } from "./plugin-audit-store.js";

describe("plugin-audit-store", () => {
  test("append then read round-trips, filtered by pluginId + limited", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lume-plugin-audit-"));
    const path = join(dir, "plugins-audit.jsonl");
    await appendPluginAuditEntry(path, {
      id: "1",
      pluginId: "acme",
      type: "sensitive_approval",
      createdAt: "t1",
      summary: "ok",
    });
    await appendPluginAuditEntry(path, {
      id: "2",
      pluginId: "beta",
      type: "sensitive_denial",
      createdAt: "t2",
      summary: "no",
    });
    await appendPluginAuditEntry(path, {
      id: "3",
      pluginId: "acme",
      type: "capability_blocked",
      createdAt: "t3",
      summary: "blocked",
    });

    const acme = await readPluginAuditEntries(path, { pluginId: "acme" });
    expect(acme).toHaveLength(2);
    expect(acme.map((e) => e.id)).toEqual(["1", "3"]);

    const limited = await readPluginAuditEntries(path, { pluginId: "acme", limit: 1 });
    expect(limited).toHaveLength(1);
    // limit tails the most recent (chronological append order)
    expect(limited[0]?.id).toBe("3");
  });

  test("read filters by workspaceSlug within the same pluginId", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lume-plugin-audit-ws-"));
    const path = join(dir, "plugins-audit.jsonl");
    await appendPluginAuditEntry(path, {
      id: "1",
      pluginId: "acme",
      workspaceSlug: "ws-a",
      type: "sensitive_approval",
      createdAt: "t1",
      summary: "ok",
    });
    await appendPluginAuditEntry(path, {
      id: "2",
      pluginId: "acme",
      workspaceSlug: "ws-b",
      type: "sensitive_denial",
      createdAt: "t2",
      summary: "no",
    });
    await appendPluginAuditEntry(path, {
      id: "3",
      pluginId: "acme",
      workspaceSlug: "ws-a",
      type: "capability_blocked",
      createdAt: "t3",
      summary: "blocked",
    });

    const wsA = await readPluginAuditEntries(path, { pluginId: "acme", workspaceSlug: "ws-a" });
    expect(wsA).toHaveLength(2);
    expect(wsA.map((e) => e.id)).toEqual(["1", "3"]);
    expect(wsA.every((e) => e.workspaceSlug === "ws-a")).toBe(true);

    const wsB = await readPluginAuditEntries(path, { pluginId: "acme", workspaceSlug: "ws-b" });
    expect(wsB).toHaveLength(1);
    expect(wsB[0]?.id).toBe("2");

    // no workspaceSlug → all acme events (both workspaces) returned
    const all = await readPluginAuditEntries(path, { pluginId: "acme" });
    expect(all).toHaveLength(3);
  });

  test("read returns [] for missing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lume-plugin-audit-missing-"));
    const events = await readPluginAuditEntries(join(dir, "nope.jsonl"), {});
    expect(events).toEqual([]);
  });

  test("read skips malformed lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lume-plugin-audit-bad-"));
    const path = join(dir, "plugins-audit.jsonl");
    await appendPluginAuditEntry(path, {
      id: "1",
      pluginId: "acme",
      type: "needs_review",
      createdAt: "t",
      summary: "x",
    });
    // corrupt the file with a bad line
    await appendFile(path, "this is not json\n", "utf-8");
    const events = await readPluginAuditEntries(path, {});
    expect(events).toHaveLength(1);
  });
});
