import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  countChunksBySource,
  countChunksForWorkspace,
  countFilesBySource,
  countFilesForWorkspace
} from "./status-ops";

describe("status-ops", () => {
  test("应统计 workspace 与 source 维度的文件和 chunk 数", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE files (
        path TEXT PRIMARY KEY,
        workspace_slug TEXT NOT NULL,
        source TEXT NOT NULL
      );
      CREATE TABLE chunks (
        id TEXT PRIMARY KEY,
        workspace_slug TEXT NOT NULL,
        source TEXT NOT NULL
      );
    `);

    db.query("INSERT INTO files (path, workspace_slug, source) VALUES (?1, ?2, ?3)").run("MEMORY.md", "ws", "memory");
    db.query("INSERT INTO files (path, workspace_slug, source) VALUES (?1, ?2, ?3)").run("sessions/a.jsonl", "ws", "session");
    db.query("INSERT INTO chunks (id, workspace_slug, source) VALUES (?1, ?2, ?3)").run("c1", "ws", "memory");
    db.query("INSERT INTO chunks (id, workspace_slug, source) VALUES (?1, ?2, ?3)").run("c2", "ws", "memory");
    db.query("INSERT INTO chunks (id, workspace_slug, source) VALUES (?1, ?2, ?3)").run("c3", "ws", "session");

    expect(countFilesForWorkspace({ db, workspaceSlug: "ws" })).toBe(2);
    expect(countChunksForWorkspace({ db, workspaceSlug: "ws" })).toBe(3);
    expect(countFilesBySource({ db, workspaceSlug: "ws", dbSource: "memory" })).toBe(1);
    expect(countFilesBySource({ db, workspaceSlug: "ws", dbSource: "session" })).toBe(1);
    expect(countChunksBySource({ db, workspaceSlug: "ws", dbSource: "memory" })).toBe(2);
    expect(countChunksBySource({ db, workspaceSlug: "ws", dbSource: "session" })).toBe(1);

    db.close();
  });
});
