/**
 * Bash 工具结果渲染器 — 终端风格
 *
 * 深色背景、等宽字体、stderr 红色高亮、命令回显
 */
import * as React from "react";
import { cn } from "@/lib/utils";
import { CollapsibleResult } from "./collapsible-result";

interface BashResultRendererProps {
  result: string;
  isError: boolean;
  input: Record<string, unknown>;
}

function classifyLine(line: string): "stderr" | "normal" {
  const lower = line.toLowerCase();
  if (
    lower.startsWith("error:") ||
    lower.startsWith("error ") ||
    lower.startsWith("fatal:") ||
    lower.startsWith("warning:") ||
    lower.includes("traceback") ||
    lower.includes("exception") ||
    lower.startsWith("stderr:")
  ) {
    return "stderr";
  }
  return "normal";
}

export function BashResultRenderer({ result, isError, input }: BashResultRendererProps): React.ReactElement {
  const command = typeof input.command === "string" ? input.command : undefined;

  const renderTerminal = React.useCallback(
    (text: string): React.ReactNode => {
      const lines = text.split("\n");
      return (
        <div
          className={cn(
            "overflow-x-auto rounded-md p-3 font-mono text-[12px] leading-relaxed",
            "bg-zinc-900 text-zinc-100 dark:bg-zinc-950",
          )}
        >
          {command && (
            <div className="sticky top-0 z-10 mb-2 -mx-3 -mt-3 border-b border-white/5 bg-zinc-900/95 px-3 py-2 text-zinc-500 backdrop-blur-sm dark:bg-zinc-950/95">
              <span className="text-green-400">$</span> {command}
            </div>
          )}
          {lines.map((line, i) => {
            const type = isError ? "stderr" : classifyLine(line);
            return (
              <div
                key={i}
                className={cn(
                  "min-h-[1.25em] whitespace-pre-wrap break-all",
                  type === "stderr" && "text-red-400",
                )}
              >
                {line || "\u200B"}
              </div>
            );
          })}
        </div>
      );
    },
    [command, isError],
  );

  return <CollapsibleResult content={result} renderContent={renderTerminal} />;
}
