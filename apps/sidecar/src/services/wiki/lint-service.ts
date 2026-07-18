import { randomUUID } from "node:crypto";
import type { WikiLintFinding, WikiPageRecord } from "@lume/shared";
import { extractWikiLinks, parseBlockMarkers, WikiMarkdownStore } from "./markdown-store";
import { WikiSourceStore } from "./source-store";

export class WikiLintService {
  constructor(readonly store: WikiMarkdownStore, readonly sources = new WikiSourceStore(store.root)) {}

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
      if (extractWikiLinks(page.body).length === 0 && !pages.some((other) => extractWikiLinks(other.body).includes(page.fileKey))) findings.push(this.finding("orphan-page", "info", "页面没有链接或反向链接", page, generation));
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
