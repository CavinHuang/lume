/**
 * Migrated from:
 * /Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/agent/TeamActivityPanel.tsx
 * Adaptation:
 * - 基于 Lume 现有 tool_start/tool_result 事件，提供 Team 头部、Task Board、Agent 卡片。
 * - 暂不包含 Proma 的 inbox 轮询与 teammate runtime 详情。
 */

"use client";

import * as React from "react";
import { Bot, CheckCircle2, ChevronRight, Circle, Clock, ListChecks, Loader2, Users, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ToolActivity } from "@/atoms/agent-atoms";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  extractTeamOverview,
  getActivityStatus,
  type TeamActivityStatus,
  type TeamAgentInfo,
  type TeamTaskItem
} from "./team-activity";

interface TeamActivityPanelProps {
  activities: ToolActivity[];
}

function formatElapsed(seconds?: number): string | null {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return null;
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function statusIcon(status: TeamActivityStatus): React.ReactElement {
  switch (status) {
    case "running":
      return <Loader2 className="size-3 animate-spin text-blue-500" />;
    case "completed":
      return <CheckCircle2 className="size-3 text-green-500" />;
    case "error":
      return <XCircle className="size-3 text-destructive" />;
    case "backgrounded":
      return <Clock className="size-3 text-amber-500" />;
    default:
      return <Circle className="size-3 text-muted-foreground" />;
  }
}

function statusLabel(status: TeamActivityStatus): string {
  switch (status) {
    case "running":
      return "运行中";
    case "completed":
      return "已完成";
    case "error":
      return "失败";
    case "backgrounded":
      return "后台";
    default:
      return "未知";
  }
}

function summarizeInput(input: Record<string, unknown>): string {
  const keys = ["subject", "description", "query", "path", "command", "prompt", "task"] as const;
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

function TaskBoard({ tasks }: { tasks: TeamTaskItem[] }): React.ReactElement | null {
  if (tasks.length === 0) return null;
  const doneCount = tasks.filter((item) => item.status === "completed").length;
  const progress = tasks.length > 0 ? (doneCount / tasks.length) * 100 : 0;

  return (
    <div className="rounded-lg bg-foreground/[0.03] px-3 py-2.5">
      <div className="mb-2 flex items-center gap-2">
        <ListChecks className="size-3 text-muted-foreground/70" />
        <span className="text-[11px] font-medium text-muted-foreground">Task Board</span>
        <span className="ml-auto text-[10px] text-muted-foreground/70">{doneCount}/{tasks.length}</span>
      </div>

      <div className="mb-2 h-1 overflow-hidden rounded-full bg-foreground/[0.08]">
        <div className="h-full rounded-full bg-green-500/70 transition-all duration-300" style={{ width: `${progress}%` }} />
      </div>

      <div className="space-y-1">
        {tasks.map((task) => {
          const done = task.status === "completed";
          return (
            <div key={task.toolUseId} className="flex items-start gap-1.5 text-[11px]">
              {done ? <CheckCircle2 className="mt-0.5 size-3 shrink-0 text-green-500" /> : <Circle className="mt-0.5 size-3 shrink-0 text-muted-foreground/60" />}
              <div className="min-w-0 flex-1">
                <div className={cn("truncate", done && "line-through text-muted-foreground/70")}>{task.activeForm || task.subject}</div>
                {task.blockedBy.length > 0 ? (
                  <div className="truncate text-[10px] text-amber-600/80">阻塞于: {task.blockedBy.join(", ")}</div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AgentCard({
  agent,
  expanded,
  onToggle
}: {
  agent: TeamAgentInfo;
  expanded: boolean;
  onToggle: () => void;
}): React.ReactElement {
  const elapsed = formatElapsed(agent.elapsedSeconds);

  return (
    <div className="rounded-lg border border-border/70 bg-background/80">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/30"
      >
        <ChevronRight className={cn("size-3 text-muted-foreground/70 transition-transform", expanded && "rotate-90")} />
        {statusIcon(agent.status)}
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{agent.name}</span>
        {agent.subagentType ? (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{agent.subagentType}</span>
        ) : null}
        {elapsed ? (
          <span className="text-[10px] tabular-nums text-muted-foreground/70">{elapsed}</span>
        ) : null}
      </button>

      {expanded ? (
        <div className="space-y-2 border-t border-border/60 px-3 py-2">
          <p className="text-[11px] leading-relaxed text-foreground/80">{agent.description}</p>

          {agent.childActivities.length > 0 ? (
            <div className="space-y-1 rounded-md bg-muted/30 px-2 py-1.5">
              {agent.childActivities.map((activity) => {
                const summary = summarizeInput(activity.input);
                const childStatus = getActivityStatus(activity);
                return (
                  <div key={activity.toolUseId} className="flex items-center gap-1.5 text-[10px]">
                    {statusIcon(childStatus)}
                    <span className="shrink-0 text-foreground/80">{activity.toolName}</span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground/80">
                      {activity.intent || summary || statusLabel(childStatus)}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-[10px] text-muted-foreground/80">暂无子工具活动</div>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function TeamActivityPanel({ activities }: TeamActivityPanelProps): React.ReactElement {
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const overview = React.useMemo(() => extractTeamOverview(activities), [activities]);

  if (!overview || (overview.tasks.length === 0 && overview.agents.length === 0 && !overview.teamName)) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <div className="flex flex-col items-center gap-2 text-muted-foreground/70">
          <Bot className="size-7" />
          <div className="text-xs">暂无 Team 活动</div>
          <div className="text-[11px]">出现 Task/Agent 工具调用后会在这里展示</div>
        </div>
      </div>
    );
  }

  const runningCount = overview.agents.filter((item) => item.status === "running" || item.status === "backgrounded").length;
  const doneCount = overview.agents.filter((item) => item.status === "completed" || item.status === "error").length;

  return (
    <div className="flex h-full flex-col">
      {overview.teamName ? (
        <div className="border-b px-3 py-2.5">
          <div className="flex items-center gap-2">
            <Users className="size-3.5 text-primary" />
            <span className="text-xs font-semibold">{overview.teamName}</span>
          </div>
          {overview.teamDescription ? (
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/80">{overview.teamDescription}</p>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center gap-2 border-b px-3 py-1.5 text-[11px] text-muted-foreground">
        <span>{overview.agents.length} 个 Agent</span>
        <span className="ml-auto inline-flex items-center gap-2">
          {runningCount > 0 ? <span className="text-blue-600">运行中 {runningCount}</span> : null}
          {doneCount > 0 ? <span className="text-green-600">完成 {doneCount}</span> : null}
        </span>
      </div>

      <ScrollArea className="flex-1">
        <div className="space-y-2 p-2">
          <TaskBoard tasks={overview.tasks} />

          {overview.agents.map((agent) => (
            <AgentCard
              key={agent.toolUseId}
              agent={agent}
              expanded={expandedId === agent.toolUseId}
              onToggle={() => setExpandedId((prev) => (prev === agent.toolUseId ? null : agent.toolUseId))}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

