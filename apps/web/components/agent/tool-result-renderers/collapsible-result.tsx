/**
 * CollapsibleResult — 可折叠长内容包装器
 *
 * 短内容直接展示，长内容默认折叠，
 * 显示前 N 行 + 字符数/行数统计指示器。
 */
import * as React from "react";
import { Check, ChevronDown, ChevronUp, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

interface CollapsibleResultProps {
  content: string;
  threshold?: number;
  previewLines?: number;
  renderContent: (text: string) => React.ReactNode;
  className?: string;
}

export function CollapsibleResult({
  content,
  threshold = 3000,
  previewLines = 15,
  renderContent,
  className,
}: CollapsibleResultProps): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const needsCollapse = content.length > threshold;
  const lineCount = React.useMemo(() => content.split("\n").length, [content]);

  const displayContent = React.useMemo(() => {
    if (!needsCollapse || expanded) return content;
    const lines = content.split("\n");
    if (lines.length <= previewLines) return content;
    return lines.slice(0, previewLines).join("\n");
  }, [content, needsCollapse, expanded, previewLines]);

  const handleCopy = React.useCallback(() => {
    void navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }).catch(() => {});
  }, [content]);

  return (
    <div className={cn("relative", className)}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-[10px] text-muted-foreground/50">
          {content.length.toLocaleString()} 字符 · {lineCount} 行
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className={cn(
            "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-all duration-200",
            copied
              ? "border-green-500/20 bg-green-500/10 text-green-600 dark:text-green-400"
              : "border-white/8 bg-white/[0.03] text-muted-foreground/70 hover:border-white/15 hover:bg-white/[0.05] hover:text-foreground/85"
          )}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "已复制" : "复制结果"}
        </button>
      </div>
      <div
        className={cn(
          "relative transition-[opacity,transform] duration-200 ease-out",
          !expanded && needsCollapse && "after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-10 after:bg-gradient-to-t after:from-[#2b3038] after:to-transparent"
        )}
      >
        {renderContent(displayContent)}
      </div>

      {needsCollapse && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="mt-2 inline-flex items-center gap-1 rounded-md border border-white/8 bg-white/[0.03] px-2 py-1 text-[11px] text-muted-foreground/70 transition-all duration-200 hover:border-white/15 hover:bg-white/[0.05] hover:text-foreground/85"
        >
          <span className="relative flex size-3 items-center justify-center">
            <ChevronDown
              className={cn(
                "absolute size-3 transition-all duration-200 ease-out",
                expanded ? "-translate-y-0.5 rotate-180 opacity-0" : "translate-y-0 rotate-0 opacity-100"
              )}
            />
            <ChevronUp
              className={cn(
                "absolute size-3 transition-all duration-200 ease-out",
                expanded ? "translate-y-0 rotate-0 opacity-100" : "translate-y-0.5 rotate-180 opacity-0"
              )}
            />
          </span>
          {expanded ? (
            <>
              收起
            </>
          ) : (
            <>
              显示全部（{content.length.toLocaleString()} 字符，{lineCount} 行）
            </>
          )}
        </button>
      )}
    </div>
  );
}
