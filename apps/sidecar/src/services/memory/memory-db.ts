import { Database } from "bun:sqlite";

export function initializeStructuredMemoryDb(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_items (
      id TEXT PRIMARY KEY,
      workspace_slug TEXT NOT NULL,
      scope TEXT NOT NULL,
      kind TEXT NOT NULL,
      source TEXT NOT NULL,

      title TEXT,
      content TEXT NOT NULL,
      summary TEXT,

      source_path TEXT,
      source_session_id TEXT,
      source_message_ids TEXT,
      source_tool_call_id TEXT,

      tags TEXT,
      entities TEXT,
      topics TEXT,

      importance INTEGER NOT NULL DEFAULT 3,
      confidence REAL NOT NULL DEFAULT 1,

      valid_from INTEGER,
      valid_to INTEGER,
      supersedes TEXT,
      superseded_by TEXT,
      promoted_from TEXT,

      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  try {
    db.exec("ALTER TABLE memory_items ADD COLUMN promoted_from TEXT;");
  } catch {
    // Column already exists on upgraded databases.
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_items_workspace
      ON memory_items(workspace_slug);

    CREATE INDEX IF NOT EXISTS idx_memory_items_kind
      ON memory_items(workspace_slug, kind);

    CREATE INDEX IF NOT EXISTS idx_memory_items_scope
      ON memory_items(workspace_slug, scope);

    CREATE INDEX IF NOT EXISTS idx_memory_items_source_session
      ON memory_items(workspace_slug, source_session_id);

    CREATE TABLE IF NOT EXISTS memory_audit_log (
      id TEXT PRIMARY KEY,
      workspace_slug TEXT NOT NULL,
      operation TEXT NOT NULL,
      memory_id TEXT,
      actor TEXT,
      reason TEXT,
      before_json TEXT,
      after_json TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_items_valid
      ON memory_items(workspace_slug, valid_to);
  `);

  try {
    db.exec("ALTER TABLE memory_audit_log ADD COLUMN reason TEXT;");
  } catch {
    // Column already exists on upgraded databases.
  }

  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_fts
      USING fts5(
        id UNINDEXED,
        workspace_slug UNINDEXED,
        title,
        content,
        summary,
        tags,
        topics
      );
    `);
  } catch (error) {
    console.warn("[结构化记忆] FTS5 不可用，将使用 LIKE 搜索:", error);
  }
}
