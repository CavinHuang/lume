import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendDaily,
  appendRunArchive,
  listEntries,
  readEntryFile,
  redactArchiveRecord,
  writeEntry
} from "./markdown-store";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lume-memory-v2-"));
  process.env.LUME_CONFIG_DIR = root;
});

afterEach(() => {
  delete process.env.LUME_CONFIG_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe("memory-v2 markdown store", () => {
  test("round trips entry frontmatter and filters active entries", () => {
    const entry = writeEntry({
      kind: "decision",
      targetScope: "workspace",
      statement: "Memory V2 stores one claim per entry file.",
      confidence: "high",
      appliesWhen: { workspaceSlug: "demo" }
    });

    expect(existsSync(entry.path)).toBe(true);
    expect(readEntryFile(entry.path).frontmatter.id).toBe(entry.frontmatter.id);
    expect(listEntries({ workspaceSlug: "demo", includeStatuses: ["active"] })).toHaveLength(1);
  });

  test("appends daily notes and redacted run archive records", () => {
    const dailyPath = appendDaily({
      scope: "workspace",
      workspaceSlug: "demo",
      date: new Date("2026-05-19T00:00:00Z"),
      heading: "Run completed",
      body: "Implemented memory V2 storage."
    });
    expect(readFileSync(dailyPath, "utf-8")).toContain("Implemented memory V2 storage.");

    const archivePath = appendRunArchive({
      workspaceSlug: "demo",
      runId: "run-1",
      record: {
        type: "tool.result",
        apiKey: "sk-1234567890abcdefghijkl"
      }
    });
    const archive = readFileSync(archivePath, "utf-8");
    expect(archive).toContain("[REDACTED]");
    expect(archive).not.toContain("sk-1234567890abcdefghijkl");
  });

  test("redaction marks records that contained secrets", () => {
    expect(redactArchiveRecord({ token: "secret" })).toMatchObject({
      token: "[REDACTED]",
      redacted: true
    });
  });
});
