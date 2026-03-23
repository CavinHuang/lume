"use client";

import * as React from "react";
import type { GitHubRelease } from "@lume/shared";
import { ChevronDown, ChevronUp, Loader2, RefreshCw } from "lucide-react";
import { listGitHubReleases } from "@/lib/desktop-api";
import { SettingsCard } from "./primitives";
import { ReleaseNotesViewer } from "./ReleaseNotesViewer";

export function VersionHistory(): React.ReactElement {
  const [releases, setReleases] = React.useState<GitHubRelease[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [expandedIds, setExpandedIds] = React.useState<Set<number>>(new Set());

  const loadReleases = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listGitHubReleases({
        perPage: 5,
        includePrerelease: false
      });
      setReleases(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载版本历史失败");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadReleases();
  }, [loadReleases]);

  return (
    <SettingsCard divided={false}>
      <div className="border-b p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">版本历史</h3>
          <button
            type="button"
            onClick={() => void loadReleases()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-md bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground transition-colors hover:bg-secondary/80 disabled:opacity-50"
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            刷新
          </button>
        </div>
        {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
      </div>

      <div className="divide-y">
        {loading && releases.length === 0 ? (
          <div className="p-8 text-center">
            <Loader2 className="mx-auto h-6 w-6 animate-spin text-muted-foreground" />
            <p className="mt-2 text-sm text-muted-foreground">加载中...</p>
          </div>
        ) : null}

        {!loading && releases.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-sm text-muted-foreground">暂无版本历史</p>
          </div>
        ) : null}

        {releases.map((release, index) => {
          const isExpanded = expandedIds.has(release.id);
          const isLatest = index === 0;
          return (
            <div key={release.id} className="p-4">
              <button
                type="button"
                onClick={() => {
                  setExpandedIds((previous) => {
                    const next = new Set(previous);
                    if (next.has(release.id)) {
                      next.delete(release.id);
                    } else {
                      next.add(release.id);
                    }
                    return next;
                  });
                }}
                className="-m-4 flex w-full items-center justify-between rounded-lg p-4 text-left transition-colors hover:bg-accent/50"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-mono text-sm font-medium">{release.tag_name}</span>
                      {isLatest ? <span className="text-xs font-medium text-primary">最新</span> : null}
                    </div>
                    {release.name && release.name !== release.tag_name ? (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">{release.name}</p>
                    ) : null}
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {new Date(release.published_at).toLocaleDateString("zh-CN")}
                  </span>
                </div>
                {isExpanded ? (
                  <ChevronUp className="ml-2 h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronDown className="ml-2 h-4 w-4 shrink-0 text-muted-foreground" />
                )}
              </button>

              {isExpanded ? (
                <div className="mt-4 border-t pt-4">
                  <ReleaseNotesViewer release={release} showHeader={false} compact />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </SettingsCard>
  );
}
