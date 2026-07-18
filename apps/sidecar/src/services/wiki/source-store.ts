import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import type { WikiSourceLifecycleState, WikiSourceManifest, WikiSourceRef } from "@lume/shared";
import { ensureWikiDirectory, resolveWikiPath } from "./path-security";
import { sha256 } from "./markdown-store";

interface LifecycleEvent {
  id: string;
  sourceId: string;
  action: "trash" | "restore" | "purge";
  createdAt: string;
  actor: string;
}

const MANIFEST_PREFIX = "---\n";

export function sanitizeCapturedUrl(raw: string): string {
  const url = new URL(raw);
  url.username = "";
  url.password = "";
  const sensitive = /^(token|access_token|key|api_key|auth|authorization|signature|sig|password|code)$/i;
  for (const key of [...url.searchParams.keys()]) if (sensitive.test(key)) url.searchParams.delete(key);
  return url.toString();
}

export class WikiSourceStore {
  constructor(readonly root: string) {}

  private recordsDir(): string { return ensureWikiDirectory(this.root, ".lume/sources/records"); }
  private lifecyclePath(): string { return resolveWikiPath(this.root, ".lume/sources/lifecycle.jsonl"); }
  private tombstonesPath(): string { return resolveWikiPath(this.root, ".lume/sources/purge-tombstones.jsonl"); }

  manifestPath(sourceId: string): string {
    return resolveWikiPath(this.root, join(".lume/sources/records", `${sourceId}.md`));
  }

  blobPath(hash: string): string {
    return resolveWikiPath(this.root, join(".lume/sources/blobs", hash, "payload"));
  }

  createManifest(input: Omit<WikiSourceManifest, "id" | "schema_version" | "content_hash" | "byte_size" | "captured_at"> & {
    payload: Uint8Array;
    id?: string;
  }): { manifest: WikiSourceManifest; payload: Uint8Array } {
    const contentHash = sha256(input.payload);
    return {
      manifest: {
        schema_version: 1,
        id: input.id ?? randomUUID(),
        kind: input.kind,
        title: input.title,
        capture_mode: input.capture_mode,
        capture_scope_snapshot: input.capture_scope_snapshot,
        locator: input.locator.url ? { ...input.locator, url: sanitizeCapturedUrl(input.locator.url) } : input.locator,
        ...(input.capture_mode === "snapshotted" ? { blob_hash: contentHash } : {}),
        content_hash: contentHash,
        byte_size: input.payload.byteLength,
        media_type: input.media_type,
        captured_at: new Date().toISOString(),
        warnings: input.warnings
      },
      payload: input.payload
    };
  }

  commit(manifest: WikiSourceManifest, payload?: Uint8Array): void {
    this.recordsDir();
    const manifestPath = this.manifestPath(manifest.id);
    if (existsSync(manifestPath)) {
      const existing = this.readManifest(manifest.id);
      if (!existing || !isDeepStrictEqual(existing, manifest)) throw new Error("provenance manifest 不可覆盖");
      if (manifest.blob_hash && !existsSync(this.blobPath(manifest.blob_hash))) throw new Error("已提交 provenance 的 payload 缺失");
      return;
    }
    if (this.isPurged(manifest.id)) throw new Error("已 purge 的 provenance 不可复活");
    if (manifest.blob_hash) {
      if (!payload || sha256(payload) !== manifest.blob_hash) throw new Error("source payload hash 不匹配");
      const blob = this.blobPath(manifest.blob_hash);
      ensureWikiDirectory(this.root, relative(this.root, dirname(blob)));
      if (!existsSync(blob)) {
        const temp = `${blob}.${randomUUID()}.tmp`;
        writeFileSync(temp, payload, { flag: "wx" });
        renameSync(temp, blob);
      }
    }
    const markdown = `${MANIFEST_PREFIX}${YAML.stringify(manifest, { lineWidth: 0 }).trimEnd()}\n---\n`;
    writeFileSync(manifestPath, markdown, { encoding: "utf8", flag: "wx" });
  }

  readManifest(sourceId: string): WikiSourceManifest | undefined {
    const path = this.manifestPath(sourceId);
    if (!existsSync(path) || this.lifecycleState(sourceId) === "purged") return undefined;
    const text = readFileSync(path, "utf8");
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) throw new Error("source manifest 无法解析");
    return YAML.parse(match[1]!) as WikiSourceManifest;
  }

  listManifests(): WikiSourceManifest[] {
    const dir = this.recordsDir();
    return readdirSync(dir).filter((name) => name.endsWith(".md")).map((name) => this.readManifest(name.slice(0, -3))).filter(Boolean) as WikiSourceManifest[];
  }

  readPayload(sourceId: string): Uint8Array | undefined {
    const manifest = this.readManifest(sourceId);
    if (!manifest?.blob_hash || this.lifecycleState(sourceId) !== "active") return undefined;
    const path = this.blobPath(manifest.blob_hash);
    return existsSync(path) ? readFileSync(path) : undefined;
  }

  appendLifecycle(sourceId: string, action: LifecycleEvent["action"], actor: string): void {
    if (action !== "purge" && this.isPurged(sourceId)) throw new Error("已 purge 的 source 不可恢复");
    ensureWikiDirectory(this.root, ".lume/sources");
    appendFileSync(this.lifecyclePath(), `${JSON.stringify({ id: randomUUID(), sourceId, action, actor, createdAt: new Date().toISOString() })}\n`, "utf8");
  }

  lifecycleState(sourceId: string): WikiSourceLifecycleState {
    if (this.isPurged(sourceId)) return "purged";
    const events = this.readLifecycle().filter((event) => event.sourceId === sourceId);
    const last = events.at(-1);
    return last?.action === "trash" ? "trashed" : last?.action === "purge" ? "purged" : "active";
  }

  purge(sourceId: string, actor: string): void {
    const manifest = this.readManifest(sourceId);
    if (!manifest) return;
    this.appendLifecycle(sourceId, "purge", actor);
    appendFileSync(this.tombstonesPath(), `${JSON.stringify({ sourceId, action: "purged", createdAt: new Date().toISOString() })}\n`, "utf8");
    rmSync(this.manifestPath(sourceId), { force: true });
    if (manifest.blob_hash && this.referencesForBlob(manifest.blob_hash).length === 0) rmSync(this.blobPath(manifest.blob_hash), { force: true });
  }

  referencesForBlob(hash: string): string[] {
    return this.listManifests().filter((manifest) => manifest.blob_hash === hash && this.lifecycleState(manifest.id) !== "purged").map((manifest) => manifest.id);
  }

  toRef(sourceId: string): WikiSourceRef | undefined {
    const manifest = this.readManifest(sourceId);
    if (!manifest) return undefined;
    return {
      id: manifest.id,
      kind: manifest.kind,
      title: manifest.title,
      captureMode: manifest.capture_mode,
      lifecycleState: this.lifecycleState(sourceId),
      blobHash: manifest.blob_hash,
      warning: manifest.warnings[0]
    };
  }

  private readLifecycle(): LifecycleEvent[] {
    const path = this.lifecyclePath();
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as LifecycleEvent);
  }

  private isPurged(sourceId: string): boolean {
    const path = this.tombstonesPath();
    if (!existsSync(path)) return false;
    return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).some((line) => (JSON.parse(line) as { sourceId: string }).sourceId === sourceId);
  }
}
