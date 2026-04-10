/**
 * 默认工具结果渲染器 — Key-Value 表格 / 纯文本
 *
 * 用于未匹配到专属渲染器的工具（包括 MCP 工具）
 */
import * as React from "react";
import { CollapsibleResult } from "./collapsible-result";
import { ErrorResult } from "./shared";
import type { ToolResultContentProps } from "./types";

function KeyValueResult({
  items,
}: {
  items: Array<{ key: string; value: string }>;
}): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false);
  const previewRows = 10;
  const needsCollapse = items.length > previewRows;
  const visibleItems = !needsCollapse || expanded ? items : items.slice(0, previewRows);

  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-md bg-muted/20 transition-all duration-200 ease-out">
        <table className="w-full text-[12px]">
          <tbody>
            {visibleItems.map(({ key, value }, i) => (
              <tr key={`${key}-${i}`} className="border-b border-border/20 last:border-b-0">
                <td className="whitespace-nowrap px-3 py-1.5 align-top font-mono text-muted-foreground/60">
                  {key}
                </td>
                <td className="whitespace-pre-wrap break-all px-3 py-1.5 font-mono text-foreground/70">
                  {value}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {needsCollapse ? (
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="inline-flex items-center gap-1 rounded-md border border-white/8 bg-white/[0.03] px-2 py-1 text-[11px] text-muted-foreground/70 transition-all duration-200 hover:border-white/15 hover:bg-white/[0.05] hover:text-foreground/85"
        >
          {expanded ? "收起" : `显示全部（${items.length} 项）`}
        </button>
      ) : null}
    </div>
  );
}

function tryParseKeyValue(text: string): Array<{ key: string; value: string }> | null {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return Object.entries(parsed as Record<string, unknown>).map(([key, value]) => ({
        key,
        value: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      }));
    }
  } catch {
    // 非 JSON
  }
  return null;
}

export function DefaultResultRenderer({ result, isError }: ToolResultContentProps): React.ReactElement {
  if (isError) {
    return <ErrorResult result={result} />;
  }

  const keyValues = React.useMemo(() => tryParseKeyValue(result), [result]);

  if (keyValues && keyValues.length > 0) {
    return <KeyValueResult items={keyValues} />;
  }

  return (
    <CollapsibleResult
      content={result}
      renderContent={(text) => (
        <pre className="max-h-[400px] overflow-y-auto overflow-x-auto rounded-md bg-muted/30 p-3 font-mono text-[12px] text-foreground/60 whitespace-pre-wrap break-all">
          {text}
        </pre>
      )}
    />
  );
}
