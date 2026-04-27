import { Database } from "bun:sqlite";
import { initializeStructuredMemoryDb } from "./memory-db";

export function initializeGlobalMemoryDb(db: Database): void {
  initializeStructuredMemoryDb(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS global_memory_candidates (
      id TEXT PRIMARY KEY,
      workspace_slug TEXT NOT NULL,
      memory_ids TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT,
      content TEXT NOT NULL,
      reason TEXT NOT NULL,
      confidence REAL NOT NULL,
      importance INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_global_memory_candidates_status
      ON global_memory_candidates(status, updated_at);

    CREATE INDEX IF NOT EXISTS idx_global_memory_candidates_workspace
      ON global_memory_candidates(workspace_slug);
  `);
}
