/**
 * Read 工具结果渲染器 — 语法高亮代码块（带行号）
 *
 * 使用 @lume/ui CodeBlock 进行语法高亮渲染。
 */
import * as React from "react";
import { cn } from "@/lib/utils";
import { inferLanguageFromPath } from "../tool-utils";
import { CollapsibleResult } from "./collapsible-result";
import { ErrorResult } from "./shared";
import type { ToolResultContentProps } from "./types";

export function ReadResultRenderer({ result, isError, input }: ToolResultContentProps): React.ReactElement {
  const filePath =
    typeof input.file_path === "string"
      ? input.file_path
      : typeof input.filePath === "string"
        ? input.filePath
        : "";

  const language = inferLanguageFromPath(filePath);
  const startLine = typeof input.offset === "number" ? input.offset : 1;

  const renderCode = React.useCallback(
    (text: string): React.ReactNode => {
      if (isError) {
        return <ErrorResult result={text} />;
      }

      const lines = text.split("\n");

      return (
        <div
          className={cn(
            "overflow-x-auto rounded-md p-2 font-mono text-[12px] leading-relaxed",
            "bg-zinc-900 text-zinc-100 dark:bg-zinc-950",
          )}
        >
          <div className="sticky top-0 z-10 -mx-2 -mt-2 mb-1 flex items-center justify-between border-b border-white/5 bg-zinc-900/95 px-2 py-1.5 text-[10px] text-zinc-500 backdrop-blur-sm dark:bg-zinc-950/95">
            <span className="select-none">{language}</span>
            {filePath ? <span className="truncate pl-2">{filePath}</span> : null}
          </div>
          {lines.map((line, i) => (
            <div key={i} className="flex">
              <span className="w-10 shrink-0 select-none pr-3 text-right text-[11px] text-zinc-500">
                {startLine + i}
              </span>
              <span className="flex-1 whitespace-pre-wrap break-all text-zinc-100">
                {line || "\u200B"}
              </span>
            </div>
          ))}
        </div>
      );
    },
    [isError, language, startLine],
  );

  return <CollapsibleResult content={result} renderContent={renderCode} />;
}
