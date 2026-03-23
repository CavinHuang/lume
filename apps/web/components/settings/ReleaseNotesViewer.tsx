"use client";

import * as React from "react";
import type { GitHubRelease } from "@lume/shared";
import { ExternalLink } from "lucide-react";
import { CodeBlock } from "@lume/ui";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { openExternalUrl } from "@/lib/desktop-api";

interface ReleaseNotesViewerProps {
  release: GitHubRelease;
  showHeader?: boolean;
  compact?: boolean;
}

function openReleaseLink(url: string): void {
  void openExternalUrl(url).catch(() => {
    if (typeof window !== "undefined") {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  });
}

function formatReleaseDate(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "今天发布";
  if (diffDays === 1) return "昨天发布";
  if (diffDays < 7) return `${diffDays} 天前发布`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} 周前发布`;

  return date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });
}

export function ReleaseNotesViewer({
  release,
  showHeader = true,
  compact = false
}: ReleaseNotesViewerProps): React.ReactElement {
  const releaseName = release.name || release.tag_name;
  return (
    <div className="space-y-3">
      {showHeader ? (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-sm font-semibold">{releaseName}</h3>
              {release.prerelease ? (
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  预发布
                </span>
              ) : null}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">{formatReleaseDate(release.published_at)}</p>
          </div>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
            onClick={() => {
              openReleaseLink(release.html_url);
            }}
          >
            <ExternalLink className="h-3 w-3" />
            GitHub
          </button>
        </div>
      ) : null}

      <div
        className={cn(
          "prose dark:prose-invert max-w-none",
          compact ? "prose-sm text-xs" : "text-sm",
          "prose-p:my-1.5 prose-p:leading-[1.6] prose-li:leading-[1.6]",
          "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
        )}
      >
        {release.body ? (
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              pre: ({ children: preChildren }) => <CodeBlock>{preChildren as React.ReactNode}</CodeBlock>,
              a: ({ href, children: linkChildren, ...linkProps }) => (
                <a
                  {...linkProps}
                  href={href}
                  onClick={(event) => {
                    event.preventDefault();
                    if (!href) return;
                    if (href.startsWith("http://") || href.startsWith("https://")) {
                      openReleaseLink(href);
                    }
                  }}
                  title={href}
                >
                  {linkChildren}
                </a>
              )
            }}
          >
            {release.body}
          </Markdown>
        ) : (
          <p className="italic text-muted-foreground">暂无发布说明</p>
        )}
      </div>
    </div>
  );
}
