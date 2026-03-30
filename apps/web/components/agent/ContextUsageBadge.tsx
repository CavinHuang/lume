import { Loader2 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const COMPACT_THRESHOLD_RATIO = 0.775;
const WARNING_RATIO = 0.8;
const MEMORY_FLUSH_RATIO = 0.7; // Memory Flush 提示阈值

interface ContextUsageBadgeProps {
  totalTokens?: number;
  contextWindow?: number;
  isCompacting: boolean;
  isProcessing: boolean;
  onCompact: () => void;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${tokens}`;
}

export function ContextUsageBadge({
  totalTokens,
  contextWindow,
  isCompacting,
  isProcessing,
  onCompact
}: ContextUsageBadgeProps): React.ReactElement | null {
  if (isCompacting) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-0.5 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        <span>压缩中...</span>
      </div>
    );
  }

  if (!totalTokens || totalTokens <= 0) return null;

  const compactThreshold = contextWindow ? Math.floor(contextWindow * COMPACT_THRESHOLD_RATIO) : undefined;
  const usageRatio = compactThreshold ? totalTokens / compactThreshold : undefined;
  const isWarning = usageRatio !== undefined && usageRatio >= WARNING_RATIO;
  const isFlushHint = usageRatio !== undefined && usageRatio >= MEMORY_FLUSH_RATIO && !isWarning;
  // 主显示：当前 token / 压缩阈值（如 1.2k/155k）
  const displayText = compactThreshold
    ? `${formatTokens(totalTokens)}/${formatTokens(compactThreshold)}`
    : formatTokens(totalTokens);
  const tooltipText = contextWindow
    ? `上下文: ${totalTokens.toLocaleString()} / ${compactThreshold?.toLocaleString()} tokens\n模型窗口: ${contextWindow.toLocaleString()} tokens${isWarning ? "\n点击手动压缩" : isFlushHint ? "\n上下文即将达到上限" : ""}`
    : `上下文: ${totalTokens.toLocaleString()} tokens`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs transition-colors",
            isWarning
              ? "cursor-pointer text-amber-600 hover:bg-amber-500/10 dark:text-amber-400"
              : isFlushHint
              ? "cursor-default text-blue-500 dark:text-blue-400"
              : "cursor-default text-muted-foreground"
          )}
          onClick={isWarning && !isProcessing ? onCompact : undefined}
          disabled={!isWarning || isProcessing}
        >
          <span>{displayText}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p className="whitespace-pre-line">{tooltipText}</p>
      </TooltipContent>
    </Tooltip>
  );
}
