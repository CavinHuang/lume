/**
 * Grep 工具结果渲染器 — 按文件分组的搜索结果，匹配词高亮
 */
import * as React from "react";
import { cn } from "@/lib/utils";
import { FileTypeIcon } from "@/components/file-browser";
import { CollapsibleResult } from "./collapsible-result";
import { ErrorResult } from "./shared";
import type { ToolResultContentProps } from "./types";

interface GrepMatch {
  file: string;
  line: number;
  content: string;
}

interface GrepFileGroup {
  file: string;
  matches: GrepMatch[];
}

function parseGrepOutput(text: string): GrepFileGroup[] | null {
  const lines = text.split("\n").filter(Boolean);
  if (lines.length === 0) return null;

  const matches: GrepMatch[] = [];
  for (const line of lines) {
    const match = line.match(/^(.+?):(\d+)[:-](.*)$/);
    if (match && match[1] && match[2] && match[3] !== undefined) {
      matches.push({ file: match[1], line: parseInt(match[2], 10), content: match[3] });
    }
  }

  if (matches.length === 0) return null;

  const groups = new Map<string, GrepMatch[]>();
  for (const m of matches) {
    const existing = groups.get(m.file);
    if (existing) {
      existing.push(m);
    } else {
      groups.set(m.file, [m]);
    }
  }

  return Array.from(groups.entries()).map(([file, fileMatches]) => ({ file, matches: fileMatches }));
}

function highlightPattern(text: string, pattern: string): React.ReactNode {
  if (!pattern) return text;
  try {
    const regex = new RegExp(`(${pattern})`, "gi");
    const parts = text.split(regex);
    return parts.map((part, i) =>
      regex.test(part) ? (
        <mark key={i} className="rounded-sm bg-yellow-300/30 px-0.5 text-yellow-200">
          {part}
        </mark>
      ) : (
        part
      ),
    );
  } catch {
    return text;
  }
}

export function GrepResultRenderer({ result, isError, input }: ToolResultContentProps): React.ReactElement {
  const pattern = typeof input.pattern === "string" ? input.pattern : "";

  if (isError) {
    return <ErrorResult result={result} />;
  }

  const groups = React.useMemo(() => parseGrepOutput(result), [result]);

  if (!groups) {
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

  const totalMatches = groups.reduce((sum, g) => sum + g.matches.length, 0);

  const renderGroups = React.useCallback(
    (text: string): React.ReactNode => {
      return (
        <div className="space-y-2">
          <div className="sticky top-0 z-10 -mx-1 border-b border-border/20 bg-[#2b3038]/95 px-1 py-1 text-[11px] text-muted-foreground/60 backdrop-blur-sm">
            {totalMatches} 个匹配，{groups.length} 个文件
          </div>
          {groups.map((group) => (
            <div key={group.file} className="overflow-hidden rounded-md bg-zinc-900 dark:bg-zinc-950">
              <div className="flex items-center gap-1.5 bg-zinc-800/50 px-3 py-1.5 text-[11px]">
                <FileTypeIcon
                  name={group.file.split("/").pop() || group.file}
                  isDirectory={false}
                  size={12}
                  className="text-zinc-400"
                />
                <span className="font-mono text-zinc-300">{group.file}</span>
                <span className="text-zinc-500">({group.matches.length})</span>
              </div>
              <div className="font-mono text-[12px]">
                {group.matches.map((m, i) => (
                  <div key={i} className="flex px-3 py-0.5 hover:bg-zinc-800/30">
                    <span className="w-10 shrink-0 select-none pr-3 text-right text-[11px] text-zinc-500">
                      {m.line}
                    </span>
                    <span className={cn("flex-1 whitespace-pre-wrap break-all text-zinc-200")}>
                      {highlightPattern(m.content, pattern)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      );
    },
    [groups, pattern, totalMatches],
  );

  return <CollapsibleResult content={result} renderContent={renderGroups} />;
}
