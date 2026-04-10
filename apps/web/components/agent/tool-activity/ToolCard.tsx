import * as React from "react";
import { ChevronDown, Clock, Loader2 } from "lucide-react";
import {
  Tool,
  ToolCodeBlock,
  ToolContent,
  ToolFooter,
  ToolHeader,
  ToolSection,
} from "@/components/ai-elements/tool";
import { cn } from "@/lib/utils";
import type { ToolActivity } from "@/atoms";
import { getActivityStatus, getToolIcon, resolveToolVisualMeta, StatusIcon, type ActivityStatus } from "./meta";
import {
  computeDiffStats,
  extractFilePath,
  formatElapsed,
  formatInputAsFnCall,
  getErrorSummary,
  getInputSummary,
  getResultSummary,
} from "./utils";
import { ToolResultRenderer } from "../tool-result-renderers";

const SIZE = {
  staggerLimit: 10,
} as const;

function FileBadge({ path }: { path: string }): React.ReactElement {
  const normalized = path.replace(/\\/g, "/");
  const filename = normalized.split("/").pop() ?? normalized;
  return (
    <span
      className="max-w-[220px] shrink-0 truncate rounded border border-white/12 bg-transparent py-0.5 text-[10px] leading-none text-foreground/60"
      title={path}
    >
      {filename}
    </span>
  );
}

function DiffBadges({ stats }: { stats: { additions: number; deletions: number } }): React.ReactElement {
  return (
    <span className="shrink-0 flex items-center gap-1">
      {stats.deletions > 0 ? (
        <span className="rounded border border-destructive/25 bg-transparent px-1.5 py-0.5 text-[10px] leading-none text-destructive">-{stats.deletions}</span>
      ) : null}
      {stats.additions > 0 ? (
        <span className="rounded border border-green-500/25 bg-transparent px-1.5 py-0.5 text-[10px] leading-none text-green-600 dark:text-green-400">+{stats.additions}</span>
      ) : null}
    </span>
  );
}

export function ToolCard({
  activity,
  index = 0,
  animate = false,
  expanded = false,
  onExpandedChange,
}: {
  activity: ToolActivity;
  index?: number;
  animate?: boolean;
  expanded?: boolean;
  onExpandedChange?: (open: boolean) => void;
}): React.ReactElement {
  const status = getActivityStatus(activity);
  const ToolIcon = getToolIcon(activity.toolName);
  const visual = resolveToolVisualMeta(activity.toolName);
  const filePath = extractFilePath(activity.input);
  const diffStats = computeDiffStats(activity.toolName, activity.input);
  const inputSummary = getInputSummary(activity.toolName, activity.input);
  const intent = activity.intent ?? activity.displayName;
  const delay = animate && index < SIZE.staggerLimit ? `${index * 30}ms` : "0ms";
  const hasDetails = Object.keys(activity.input).length > 0 || !!activity.result;
  const isBash = activity.toolName.toLowerCase() === "bash";
  const [transitionState, setTransitionState] = React.useState<"finish" | "error" | null>(null);
  const prevStatusRef = React.useRef<ActivityStatus>(status);

  const resultSummary = status === "completed" && activity.result
    ? getResultSummary(activity.toolName, activity.result)
    : null;
  const errorSummary = status === "error" && activity.result
    ? getErrorSummary(activity.result)
    : null;

  const summaryText = React.useMemo(() => {
    if (isBash && inputSummary) return inputSummary;
    if (intent && inputSummary) return `${intent} · ${inputSummary}`;
    return intent ?? inputSummary ?? "";
  }, [inputSummary, intent, isBash]);

  const elapsedLabel = activity.elapsedMs !== undefined && activity.elapsedMs > 0
    ? formatElapsed(activity.elapsedMs, "ms")
    : activity.elapsedSeconds !== undefined && activity.elapsedSeconds > 0
      ? formatElapsed(activity.elapsedSeconds)
      : null;

  const detailLabel = activity.isError ? "ERROR" : "RESULT";

  React.useEffect(() => {
    const previous = prevStatusRef.current;
    if ((previous === "running" || previous === "backgrounded") && status === "completed") {
      setTransitionState("finish");
      const timer = window.setTimeout(() => setTransitionState(null), 520);
      prevStatusRef.current = status;
      return () => window.clearTimeout(timer);
    }
    if ((previous === "running" || previous === "backgrounded") && status === "error") {
      setTransitionState("error");
      const timer = window.setTimeout(() => setTransitionState(null), 560);
      prevStatusRef.current = status;
      return () => window.clearTimeout(timer);
    }
    prevStatusRef.current = status;
    return undefined;
  }, [status]);

  return (
    <Tool
      open={hasDetails ? expanded : false}
      onOpenChange={hasDetails ? onExpandedChange : undefined}
      className={cn(
        animate && "animate-in fade-in slide-in-from-left-2 duration-200 fill-mode-both",
        transitionState === "finish" && "animate-tool-card-finish",
        transitionState === "error" && "animate-tool-card-error",
        status === "running" && "ring-1 ring-blue-400/20 shadow-[0_0_0_1px_rgba(96,165,250,0.10),inset_0_1px_0_rgba(255,255,255,0.03)]"
      )}
      style={animate ? { animationDelay: delay } : undefined}
    >
      <ToolHeader
        disabled={!hasDetails}
        aria-expanded={hasDetails ? expanded : undefined}
        summary={
          <div className={cn(
            "flex min-w-0 items-center gap-1.5 overflow-hidden text-[15px] font-medium leading-none text-[#cfd5df]",
            transitionState === "finish" && "animate-tool-accent-finish",
            transitionState === "error" && "animate-tool-accent-error"
          )}>
            {filePath ? <FileBadge path={filePath} /> : null}
            {summaryText ? (
              <div className={cn(
                "min-w-0 flex-1 truncate",
                isBash && "font-mono text-[10px] text-foreground/60"
              )}>
                {summaryText}
              </div>
            ) : null}

            {status === "running" ? (
              activity.progressDescription ? (
                <span className="ml-1 max-w-[45%] shrink-0 truncate text-blue-400/70">{activity.progressDescription}</span>
              ) : (
                <span className="ml-1.5 inline-flex shrink-0 items-center gap-[3px] align-middle">
                  <span className={cn("size-[3px] rounded-full animate-bounce [animation-delay:0ms]", visual.runningDotClassName)} />
                  <span className={cn("size-[3px] rounded-full animate-bounce [animation-delay:120ms]", visual.runningDotClassName)} />
                  <span className={cn("size-[3px] rounded-full animate-bounce [animation-delay:240ms]", visual.runningDotClassName)} />
                </span>
              )
            ) : null}

            {status === "backgrounded" ? (
              <span className="ml-1.5 inline-flex shrink-0 items-center gap-1 align-middle">
                <span className="size-[3px] rounded-full bg-primary/70 animate-pulse" />
                <span className="text-[10px] text-primary/70">后台</span>
              </span>
            ) : null}

            {resultSummary ? (
              <span className="ml-0.5 max-w-[35%] shrink-0 truncate rounded-full border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] font-normal leading-none text-foreground/55">
                {resultSummary}
              </span>
            ) : null}
            {errorSummary ? <span className="ml-1 max-w-[35%] shrink-0 truncate text-destructive/70">{errorSummary}</span> : null}
          </div>
        }
        icon={(
          <span className={cn(
            "flex size-5 items-center justify-center rounded-md transition-all duration-200 group-data-[state=open]/tool:border-white/15 group-data-[state=open]/tool:bg-black/20",
            visual.iconWrapClassName
          )}>
            <ToolIcon className={cn("size-3.5 transition-transform duration-200 group-hover/tool:scale-[1.06]", visual.iconClassName)} />
          </span>
        )}
        meta={(
          <>
            {diffStats ? <DiffBadges stats={diffStats} /> : null}
          </>
        )}
        status={<StatusIcon status={status} toolName={activity.toolName} />}
        trailing={(
          <>
            {elapsedLabel ? (
              <span className="flex items-center gap-1 text-[11px] tabular-nums text-[#aab3bf]">
                <Clock className="size-2.5" />
                {elapsedLabel}
              </span>
            ) : null}
            {hasDetails ? (
              <ChevronDown
                className={cn(
                  "size-3.5 text-muted-foreground/50 transition-all duration-200 ease-out",
                  expanded && "rotate-180",
                  transitionState === "finish" && "text-sky-300/80",
                  transitionState === "error" && "text-red-300/80"
                )}
              />
            ) : null}
          </>
        )}
        className={cn(
          hasDetails
            ? "cursor-pointer transition-all duration-150 hover:bg-muted/10 active:scale-[0.998]"
            : "cursor-default"
        )}
      />
      <ToolContent>
        <div className="space-y-3 border-t border-border/40 bg-background/[0.02] px-3 py-3">
          {Object.keys(activity.input).length > 0 && !isBash ? (
            <ToolSection label="ARGUMENTS">
              <ToolCodeBlock className="bg-muted/30 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
                {formatInputAsFnCall(activity.input)}
              </ToolCodeBlock>
            </ToolSection>
          ) : null}

          {activity.result ? (
            <ToolSection label={detailLabel} tone={activity.isError ? "error" : "default"}>
              <ToolResultRenderer
                toolName={activity.toolName}
                input={activity.input}
                result={activity.result}
                isError={activity.isError === true}
              />
            </ToolSection>
          ) : null}

          <ToolFooter>
            <span>Call ID: {activity.toolUseId}</span>
            {elapsedLabel ? <span>Duration: {elapsedLabel}</span> : null}
          </ToolFooter>
        </div>
      </ToolContent>
    </Tool>
  );
}
