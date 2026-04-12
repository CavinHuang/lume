/**
 * WebSearch 工具结果渲染器 — 搜索结果卡片
 */
import * as React from "react";
import { Globe } from "lucide-react";
import { CollapsibleResult } from "./collapsible-result";
import { ErrorResult } from "./shared";
import type { ToolResultContentProps } from "./types";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function parseSearchPayload(text: string): { query?: string; results: SearchResult[] } | null {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (Array.isArray(record.results)) {
        return {
          query: typeof record.query === "string" ? record.query : undefined,
          results: record.results
            .filter((item: Record<string, unknown>) => item.title || item.url)
            .map((item: Record<string, unknown>) => ({
              title: String(item.title ?? ""),
              url: String(item.url ?? item.link ?? ""),
              snippet: String(item.snippet ?? item.description ?? item.content ?? ""),
            })),
        };
      }
    }
    if (Array.isArray(parsed)) {
      return {
        results: parsed
          .filter((item: Record<string, unknown>) => item.title || item.url)
          .map((item: Record<string, unknown>) => ({
            title: String(item.title ?? ""),
            url: String(item.url ?? item.link ?? ""),
            snippet: String(item.snippet ?? item.description ?? item.content ?? ""),
          })),
      };
    }
  } catch {
    // 非 JSON，尝试文本格式解析
  }

  const blocks = text.split(/\n{2,}/).filter(Boolean);
  if (blocks.length < 2) return null;

  const results: SearchResult[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter(Boolean);
    if (lines.length >= 2) {
      const urlLine = lines.find((l) => l.match(/https?:\/\//));
      const titleLine = lines.find((l) => !l.match(/https?:\/\//) && l.length > 0);
      if (urlLine && titleLine) {
        const urlMatch = urlLine.match(/(https?:\/\/\S+)/);
        results.push({
          title: titleLine.replace(/^\d+\.\s*/, "").replace(/\*\*/g, ""),
          url: urlMatch?.[1] ?? urlLine,
          snippet: lines
            .filter((l) => l !== urlLine && l !== titleLine)
            .join(" ")
            .slice(0, 200),
        });
      }
    }
  }

  return results.length > 0 ? { results } : null;
}

export function WebSearchResultRenderer({ result, isError }: ToolResultContentProps): React.ReactElement {
  if (isError) {
    return <ErrorResult result={result} />;
  }

  const searchPayload = React.useMemo(() => parseSearchPayload(result), [result]);

  if (!searchPayload) {
    return (
      <CollapsibleResult
        content={result}
        renderContent={(text) => (
          <pre className="overflow-x-auto rounded-md bg-muted/30 p-3 font-mono text-[12px] text-foreground/60 whitespace-pre-wrap break-all">
            {text}
          </pre>
        )}
      />
    );
  }

  const searchResults = searchPayload.results;
  const [expanded, setExpanded] = React.useState(false);
  const previewCount = 5;
  const needsCollapse = searchResults.length > previewCount;
  const visibleResults = !needsCollapse || expanded ? searchResults : searchResults.slice(0, previewCount);

  return (
    <div className="space-y-2">
      <div className="text-[11px] text-muted-foreground/60">
        {searchPayload.query ? `查询: ${searchPayload.query} · ` : ""}
        {searchResults.length} 条结果
      </div>
      {searchResults.length === 0 ? (
        <div className="rounded-md bg-muted/20 px-3 py-3 text-[12px] text-muted-foreground/70">
          未检索到结果
        </div>
      ) : null}
      <div className="space-y-2 transition-all duration-200 ease-out">
      {visibleResults.map((item, i) => (
        <div key={i} className="space-y-1 rounded-md bg-muted/20 p-2.5 animate-in fade-in slide-in-from-top-1 duration-200 transition-transform duration-150 hover:-translate-y-[1px]">
          <div className="flex items-center gap-1.5">
            <Globe className="size-3 shrink-0 text-muted-foreground/50" />
            <span className="truncate text-[12px] font-medium text-foreground/80">{item.title}</span>
          </div>
          {item.url && (
            <div className="truncate font-mono text-[11px] text-primary/60">{item.url}</div>
          )}
          {item.snippet && (
            <div className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground/70">
              {item.snippet}
            </div>
          )}
        </div>
      ))}
      </div>
      {needsCollapse ? (
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="inline-flex items-center gap-1 rounded-md border border-white/8 bg-white/[0.03] px-2 py-1 text-[11px] text-muted-foreground/70 transition-all duration-200 hover:border-white/15 hover:bg-white/[0.05] hover:text-foreground/85"
        >
          {expanded ? "收起" : `显示全部（${searchResults.length} 条）`}
        </button>
      ) : null}
    </div>
  );
}
