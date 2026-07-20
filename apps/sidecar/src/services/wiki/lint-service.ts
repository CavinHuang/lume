import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import type { WikiLintFinding, WikiPageRecord } from "@lume/shared";
import { extractWikiLinks, parseBlockMarkers, sha256, WikiMarkdownStore } from "./markdown-store";
import { WikiSourceStore } from "./source-store";
import { resolveWikiPath } from "./path-security";

export class WikiLintService {
  constructor(
    readonly store: WikiMarkdownStore,
    readonly sources = new WikiSourceStore(store.root),
    private readonly validWorkspaceIds?: Set<string>,
  ) {}

  run(generation = Date.now()): WikiLintFinding[] {
    const pages = this.store.listPages();
    const findings: WikiLintFinding[] = [];
    const byId = group(pages, (page) => page.id);
    const byFileKey = group(pages, (page) => page.fileKey);
    for (const [id, items] of byId) if (items.length > 1) findings.push(this.finding("duplicate-id", "error", `重复 page id: ${id}`, items[0], generation));
    for (const [key, items] of byFileKey) if (items.length > 1) findings.push(this.finding("duplicate-file-key", "error", `重复 file_key: ${key}`, items[0], generation));
    for (const page of pages) {
      try { parseBlockMarkers(page.markdown); } catch (error) { findings.push(this.finding("ownership-marker", "error", (error as Error).message, page, generation)); }
      for (const link of extractWikiLinks(page.body)) if (!byFileKey.has(link)) findings.push(this.finding("broken-link", "warning", `无法解析 Wiki link: ${link}`, page, generation));
      for (const sourceId of page.frontmatter.source_ids) if (!this.sources.readManifest(sourceId)) findings.push(this.finding("missing-source", "error", `缺少来源: ${sourceId}`, page, generation));
      for (const workspaceId of [page.frontmatter.primary_workspace_id, ...page.frontmatter.associated_workspace_ids].filter(Boolean) as string[]) {
        if (page.status !== "archived" && this.validWorkspaceIds && !this.validWorkspaceIds.has(workspaceId)) findings.push(this.finding("invalid-workspace-association", "warning", `工作区关联已失效: ${workspaceId}`, page, generation));
      }
      if (extractWikiLinks(page.body).length === 0 && !pages.some((other) => extractWikiLinks(other.body).includes(page.fileKey))) findings.push(this.finding("orphan-page", "info", "页面没有链接或反向链接", page, generation));
    }
    for (const manifest of this.sources.listManifests()) {
      if (!manifest.blob_hash || this.sources.lifecycleState(manifest.id) !== "active") continue;
      const payload = this.sources.readPayload(manifest.id);
      if (!payload || sha256(payload) !== manifest.blob_hash || manifest.content_hash !== manifest.blob_hash) {
        findings.push({ id: randomUUID(), rule: "source-hash", severity: "error", message: `来源 payload hash 不完整: ${manifest.id}`, sourceId: manifest.id, createdAt: new Date().toISOString(), generation });
      }
    }
    const operations = resolveWikiPath(this.store.root, ".lume/operations");
    if (existsSync(operations)) for (const name of readdirSync(operations).filter((item) => item.endsWith(".json"))) {
      try {
        const batch = JSON.parse(readFileSync(resolveWikiPath(this.store.root, `.lume/operations/${name}`), "utf8")) as { id?: string; state?: string; diffs?: Array<{ pageId?: string; path?: string }> };
        if (!batch.id || !batch.state || !Array.isArray(batch.diffs) || batch.diffs.some((diff) => !diff.pageId || !diff.path)) throw new Error();
      } catch {
        findings.push({ id: randomUUID(), rule: "operation-journal", severity: "error", message: `操作 journal 不完整: ${name}`, createdAt: new Date().toISOString(), generation });
      }
    }
    return findings;
  }

  private finding(rule: string, severity: WikiLintFinding["severity"], message: string, page: WikiPageRecord | undefined, generation: number): WikiLintFinding {
    return { id: randomUUID(), rule, severity, message, pageId: page?.id, createdAt: new Date().toISOString(), generation };
  }
}

function group<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  return map;
}
