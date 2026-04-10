import * as React from "react";
import { Check, ChevronDown, ChevronUp, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

export const COLLAPSIBLE_RESULT_STYLES = {
  copyButtonBase:
    "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-all",
  copyButtonCopied:
    "border-green-500/20 bg-green-500/10 text-green-600 dark:text-green-400",
  copyButtonIdle:
    "border-white/8 bg-white/[0.03] text-muted-foreground/70 hover:border-white/15 hover:bg-white/[0.05] hover:text-foreground/85",
  toggleButton:
    "mt-2 inline-flex items-center gap-1 rounded-md border border-white/8 bg-white/[0.03] px-2 py-1 text-[11px] text-muted-foreground/70 transition-all hover:border-white/15 hover:bg-white/[0.05] hover:text-foreground/85",
} as const;

export function ResultMeta({
  contentLength,
  lineCount,
}: {
  contentLength: number;
  lineCount: number;
}): React.ReactElement {
  return (
    <div className="text-[10px] text-muted-foreground/50">
      {contentLength.toLocaleString()} 字符 · {lineCount} 行
    </div>
  );
}

export function CopyResultButton({
  copied,
  durationMs,
  onCopy,
}: {
  copied: boolean;
  durationMs: number;
  onCopy: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onCopy}
      className={cn(
        COLLAPSIBLE_RESULT_STYLES.copyButtonBase,
        copied ? COLLAPSIBLE_RESULT_STYLES.copyButtonCopied : COLLAPSIBLE_RESULT_STYLES.copyButtonIdle
      )}
      style={{ transitionDuration: `${durationMs}ms` }}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      {copied ? "已复制" : "复制结果"}
    </button>
  );
}

export function ExpandToggleButton({
  expanded,
  contentLength,
  lineCount,
  durationMs,
  onToggle,
}: {
  expanded: boolean;
  contentLength: number;
  lineCount: number;
  durationMs: number;
  onToggle: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={COLLAPSIBLE_RESULT_STYLES.toggleButton}
      style={{ transitionDuration: `${durationMs}ms` }}
    >
      <span className="relative flex size-3 items-center justify-center">
        <ChevronDown
          className={cn(
            "absolute size-3 transition-all ease-out",
            expanded ? "-translate-y-0.5 rotate-180 opacity-0" : "translate-y-0 rotate-0 opacity-100"
          )}
          style={{ transitionDuration: `${durationMs}ms` }}
        />
        <ChevronUp
          className={cn(
            "absolute size-3 transition-all ease-out",
            expanded ? "translate-y-0 rotate-0 opacity-100" : "translate-y-0.5 rotate-180 opacity-0"
          )}
          style={{ transitionDuration: `${durationMs}ms` }}
        />
      </span>
      {expanded ? (
        <>收起</>
      ) : (
        <>显示全部（{contentLength.toLocaleString()} 字符，{lineCount} 行）</>
      )}
    </button>
  );
}

