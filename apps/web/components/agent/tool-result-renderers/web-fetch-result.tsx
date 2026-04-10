/**
 * WebFetch 工具结果渲染器 — Markdown 渲染
 */
import * as React from "react";
import { MessageResponse } from "@/components/ai-elements/message";
import { CollapsibleResult } from "./collapsible-result";
import { ErrorResult } from "./shared";
import type { ToolResultContentProps } from "./types";

export function WebFetchResultRenderer({ result, isError }: ToolResultContentProps): React.ReactElement {
  if (isError) {
    return <ErrorResult result={result} />;
  }

  return (
    <CollapsibleResult
      content={result}
      threshold={5000}
      previewLines={30}
      renderContent={(text) => (
        <div className="overflow-x-auto rounded-md bg-muted/20 text-[13px]">
          <div className="sticky top-0 z-10 border-b border-border/20 bg-[#2b3038]/95 px-3 py-1.5 text-[11px] text-muted-foreground/60 backdrop-blur-sm">
            网页内容预览
          </div>
          <div className="p-3">
          <MessageResponse>{text}</MessageResponse>
          </div>
        </div>
      )}
    />
  );
}
