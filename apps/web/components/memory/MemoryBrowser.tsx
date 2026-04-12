import { useState, useCallback } from "react";
import { Search, Loader2 } from "lucide-react";
import type { MemorySearchResult } from "@lume/shared";
import { searchLayeredMemory } from "@/lib/desktop-api/agent";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface MemoryBrowserProps {
  workspaceSlug: string;
}

export function MemoryBrowser({ workspaceSlug }: MemoryBrowserProps): React.ReactElement {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MemorySearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const handleSearch = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true);
    try {
      const res = await searchLayeredMemory(workspaceSlug, query.trim(), 20);
      setResults(res);
      setSearched(true);
    } catch {
      setResults([]);
      setSearched(true);
    } finally {
      setLoading(false);
    }
  }, [workspaceSlug, query]);

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索记忆内容..."
          onKeyDown={(e) => { if (e.key === "Enter") void handleSearch(); }}
          className="flex-1"
        />
        <Button type="button" size="sm" onClick={() => void handleSearch()} disabled={loading || !query.trim()}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
        </Button>
      </div>

      {searched && results.length === 0 && (
        <div className="py-6 text-center text-sm text-muted-foreground">未找到相关记忆</div>
      )}

      {results.length > 0 && (
        <div className="space-y-2">
          {results.map((item) => (
            <div key={item.id} className="rounded-lg border border-border/60 bg-card/50 p-3 text-sm">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="truncate text-xs text-muted-foreground">{item.path}#{item.startLine}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{Math.round((item.score ?? 0) * 100)}%</span>
              </div>
              <p className="line-clamp-3 text-foreground/80">{item.snippet ?? item.path}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
