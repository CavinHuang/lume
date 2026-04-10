/**
 * Glob 工具结果渲染器 — 紧凑文件列表
 */
import * as React from "react";
import { FileTypeIcon } from "@/components/file-browser";
import { CollapsibleResult } from "./collapsible-result";
import { ErrorResult } from "./shared";
import type { ToolResultContentProps } from "./types";

export function GlobResultRenderer({ result, isError }: ToolResultContentProps): React.ReactElement {
  if (isError) {
    return <ErrorResult result={result} />;
  }

  const files = React.useMemo(() => result.split("\n").filter(Boolean), [result]);

  const renderList = React.useCallback(
    (text: string): React.ReactNode => {
      const visibleFiles = text.split("\n").filter(Boolean);
      return (
        <div className="space-y-1">
          <div className="sticky top-0 z-10 -mx-1 border-b border-border/20 bg-[#2b3038]/95 px-1 py-1 text-[11px] text-muted-foreground/60 backdrop-blur-sm">
            {files.length} 个文件
          </div>
          <div className="space-y-0.5 rounded-md bg-muted/20 p-2">
            {visibleFiles.map((file, i) => (
              <div key={i} className="flex items-center gap-1.5 py-0.5 font-mono text-[12px] text-foreground/70 transition-colors duration-150 hover:text-foreground">
                <FileTypeIcon
                  name={file.replace(/\\/g, "/").split("/").pop() || file}
                  isDirectory={false}
                  size={12}
                  className="shrink-0 text-muted-foreground"
                />
                <span className="truncate">{file}</span>
              </div>
            ))}
          </div>
        </div>
      );
    },
    [files.length],
  );

  return <CollapsibleResult content={result} previewLines={20} renderContent={renderList} />;
}
