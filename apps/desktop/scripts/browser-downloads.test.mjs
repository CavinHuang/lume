import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AgentDownloadQuota, BrowserDownloadHistory, prepareDownload, safeDownloadFilename } from "../src/browser-downloads.ts";

test("download names reject traversal, device names and duplicate overwrite", () => {
  const root = join(process.cwd(), ".tmp-browser-download-test");
  mkdirSync(root, { recursive: true });
  try {
    assert.equal(safeDownloadFilename("../../CON"), "download");
    writeFileSync(join(root, "report.txt"), "existing");
    const prepared = prepareDownload(root, "../report.txt");
    assert.equal(prepared.filename, "report (1).txt");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("download destinations reject linked directories", () => {
  const id = randomUUID();
  const root = join(process.cwd(), `.tmp-browser-download-link-test-${id}`);
  const target = join(process.cwd(), `.tmp-browser-download-link-target-${id}`);
  mkdirSync(target, { recursive: true });
  symlinkSync(target, root, "junction");
  try { assert.throws(() => prepareDownload(root, "file.txt"), /download_link_rejected/); }
  finally { unlinkSync(root); rmSync(target, { recursive: true, force: true }); }
});

test("agent download quotas enforce concurrent, file and aggregate byte limits", () => {
  const quota = new AgentDownloadQuota();
  const ids = [quota.begin("session", 1), quota.begin("session", 1), quota.begin("session", 1)];
  assert.ok(ids.every(Boolean));
  assert.equal(quota.begin("session", 1), null);
  assert.equal(quota.update("session", ids[0], 101 * 1024 * 1024), false);
  quota.finish("session", ids[0], false);
  assert.ok(quota.begin("session", 1));
});

test("download history contains metadata but no filesystem path", () => {
  const root = join(process.cwd(), ".tmp-browser-download-history-test");
  const history = new BrowserDownloadHistory(() => root);
  history.record({ id: "ref", filename: "safe.txt", actor: "agent", state: "completed", receivedBytes: 10, createdAt: new Date(0).toISOString() });
  assert.equal(history.list()[0].filename, "safe.txt");
  assert.equal("path" in history.list()[0], false);
  history.clear();
  rmSync(root, { recursive: true, force: true });
});
