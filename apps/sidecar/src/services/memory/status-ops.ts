/**
 * Migrated style from OpenClaw memory manager status shape.
 * Adaptation:
 * - Keep query helpers for Lume built-in sqlite manager.
 */

import { Database } from "bun:sqlite";

export function countFilesForWorkspace(params: {
  db: Database;
  workspaceSlug: string;
}): number {
  const row = params.db
    .query(
      `SELECT COUNT(*) AS count
       FROM files
       WHERE workspace_slug = ?1`
    )
    .get(params.workspaceSlug) as { count?: number } | null;
  return row?.count ?? 0;
}

export function countChunksForWorkspace(params: {
  db: Database;
  workspaceSlug: string;
}): number {
  const row = params.db
    .query(
      `SELECT COUNT(*) AS count
       FROM chunks
       WHERE workspace_slug = ?1`
    )
    .get(params.workspaceSlug) as { count?: number } | null;
  return row?.count ?? 0;
}

export function countFilesBySource(params: {
  db: Database;
  workspaceSlug: string;
  dbSource: "memory" | "session";
}): number {
  const row = params.db
    .query(
      `SELECT COUNT(*) AS count
       FROM files
       WHERE workspace_slug = ?1 AND source = ?2`
    )
    .get(params.workspaceSlug, params.dbSource) as { count?: number } | null;
  return row?.count ?? 0;
}

export function countChunksBySource(params: {
  db: Database;
  workspaceSlug: string;
  dbSource: "memory" | "session";
}): number {
  const row = params.db
    .query(
      `SELECT COUNT(*) AS count
       FROM chunks
       WHERE workspace_slug = ?1 AND source = ?2`
    )
    .get(params.workspaceSlug, params.dbSource) as { count?: number } | null;
  return row?.count ?? 0;
}
