import * as React from "react";
import {
  Bot,
  CheckCircle2,
  Loader2,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { TeammateState } from "@/atoms/agent-atoms";

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s > 0 ? `${m}m${s}s` : `${m}m`;
}

function ToolPulse({ toolName }: { toolName: string }): React.ReactElement {
  return (
    <span className="flex items-center gap-1 text-[10px] text-primary/70">
      <span className="size-1.5 rounded-full bg-primary/60 animate-pulse shrink-0" />
      {toolName}
    </span>
  );
}

function ToolHistoryBadges({ history }: { history: string[] }): React.ReactElement | null {
  if (history.length === 0) return null;
  // 只显示最近 5 个不重复的工具，从右往左截取
  const unique = Array.from(new Set([...history].reverse())).slice(0, 5).reverse();
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {unique.map((name) => (
        <span
          key={name}
          className="rounded bg-muted px-1.5 py-0.5 text-[9px] leading-none text-muted-foreground/70"
        >
          {name}
        </span>
      ))}
    </div>
  );
}

interface SubagentLiveCardProps {
  teammate: TeammateState;
}

export const SubagentLiveCard = React.memo(function SubagentLiveCard({
  teammate,
}: SubagentLiveCardProps): React.ReactElement {
  const isRunning = teammate.status === "running";
  const isError = teammate.status === "failed" || teammate.status === "stopped";
  const isDone = !isRunning;

  const elapsed = teammate.startedAt
    ? Math.floor(((teammate.endedAt ?? Date.now()) - teammate.startedAt) / 1000)
    : (teammate.currentToolElapsedSeconds ?? 0);

  const toolUses = teammate.usage?.toolUses;

  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2.5 space-y-1.5 transition-all duration-300",
        isRunning && "border-primary/25 bg-primary/[0.04]",
        isError && "border-destructive/30 bg-destructive/[0.03]",
        isDone && !isError && "border-border/50 bg-muted/10 opacity-70",
      )}
    >
      {/* 顶部行：状态图标 + 名称 + 耗时 */}
      <div className="flex items-center gap-2">
        {isRunning ? (
          <Loader2 className="size-3 shrink-0 animate-spin text-primary" />
        ) : isError ? (
          <XCircle className="size-3 shrink-0 text-destructive" />
        ) : (
          <CheckCircle2 className="size-3 shrink-0 text-green-500" />
        )}

        <Bot className="size-3 shrink-0 text-muted-foreground/50" />
        <span className="flex-1 truncate text-xs font-medium text-foreground/80">
          {teammate.agentName ?? "Subagent"}
        </span>

        <div className="flex items-center gap-2 shrink-0">
          {toolUses !== undefined && toolUses > 0 ? (
            <span className="text-[10px] tabular-nums text-muted-foreground/50">
              {toolUses} 次
            </span>
          ) : null}
          {elapsed > 0 ? (
            <span className="text-[10px] tabular-nums text-muted-foreground/50">
              {formatElapsed(elapsed)}
            </span>
          ) : null}
        </div>
      </div>

      {/* 任务描述 */}
      <p className="truncate pl-[22px] text-[11px] text-foreground/45">
        {teammate.description}
      </p>

      {/* 正在执行的工具 */}
      {isRunning && teammate.currentToolName ? (
        <div className="pl-[22px]">
          <ToolPulse toolName={teammate.currentToolName} />
        </div>
      ) : null}

      {/* 工具历史（最近使用的，仅运行中或完成态展示） */}
      {teammate.toolHistory.length > 0 ? (
        <div className="pl-[22px]">
          <ToolHistoryBadges history={teammate.toolHistory} />
        </div>
      ) : null}

    </div>
  );
});

interface SubagentLiveCardsProps {
  teammates: TeammateState[];
}

export function SubagentLiveCards({
  teammates,
}: SubagentLiveCardsProps): React.ReactElement | null {
  // 展示所有活跃（非 completed）的 teammate，completed 的淡出后由 SubagentAnnounceMessage 接管
  const visible = React.useMemo(
    () => teammates.filter((t) => t.status !== "completed"),
    [teammates],
  );

  if (visible.length === 0) return null;

  return (
    <div className="space-y-2">
      {visible.map((teammate) => (
        <SubagentLiveCard
          key={teammate.taskId}
          teammate={teammate}
        />
      ))}
    </div>
  );
}
