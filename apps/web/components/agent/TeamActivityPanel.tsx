import * as React from "react";
import * as Collapsible from "@radix-ui/react-collapsible";
import { Bell, Bot, CheckCircle2, ChevronRight, Circle, Clock, ExternalLink, ListChecks, Loader2, Users, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ToolActivity } from "@/atoms/agent-atoms";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  buildAgentTree,
  extractTeamOverview,
  getActivityStatus,
  type AgentTreeNode,
  type TeamActivityStatus,
  type TeamAgentInfo,
  type TeamInboxItem,
  type TeamTaskItem
} from "./team-activity";

interface TeamActivityPanelProps {
  activities: ToolActivity[];
  inboxItems: TeamInboxItem[];
  onOpenSession?: (sessionId: string) => void;
  onLoadChildSession?: (childSessionId: string) => Promise<ToolActivity[]>;
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

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function InboxTimeline({
  items,
  onOpenSession,
}: {
  items: TeamInboxItem[];
  onOpenSession?: (sessionId: string) => void;
}): React.ReactElement | null {
  if (items.length === 0) return null;
  return (
    <div className="rounded-lg bg-foreground/[0.03] px-3 py-2.5">
      <div className="mb-2 flex items-center gap-2">
        <Bell className="size-3 text-muted-foreground/70" />
        <span className="text-[11px] font-medium text-muted-foreground">Inbox</span>
        <span className="ml-auto text-[10px] text-muted-foreground/70">{items.length}</span>
      </div>
      <div className="space-y-1.5">
        {items.slice(0, 12).map((item) => {
          const clickable = !!(item.childSessionKey && onOpenSession);
          return (
            <div
              key={item.messageId}
              onClick={() => clickable && onOpenSession!(item.childSessionKey!)}
              className={cn(
                "rounded-md border border-border/60 bg-background/70 px-2 py-1.5 transition-colors",
                clickable && "cursor-pointer hover:border-primary/40 hover:bg-muted/40"
              )}
            >
              <div className="flex items-center gap-1.5 text-[10px]">
                {item.isError ? (
                  <XCircle className="size-3 shrink-0 text-destructive" />
                ) : (
                  <CheckCircle2 className="size-3 shrink-0 text-green-500" />
                )}
                <span className="truncate text-foreground/90">{item.label ?? item.summary}</span>
                <span className="ml-auto shrink-0 text-muted-foreground/70">{formatTime(item.createdAt)}</span>
              </div>
              {item.outputText ? (
                <p className="mt-1 line-clamp-2 text-[10px] text-foreground/60">{item.outputText}</p>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
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
  onToggle,
  onOpenSession,
  onLoadChildSession
}: {
  agent: TeamAgentInfo;
  expanded: boolean;
  onToggle: () => void;
  onOpenSession?: (sessionId: string) => void;
  onLoadChildSession?: (childSessionId: string) => Promise<ToolActivity[]>;
}): React.ReactElement {
  const elapsed = formatElapsed(agent.elapsedSeconds);
  const shortRunId = agent.runId ? agent.runId.slice(0, 8) : null;

  // 子 session 懒加载
  const [childSessionActivities, setChildSessionActivities] = React.useState<ToolActivity[] | null>(null);
  const [childSessionLoading, setChildSessionLoading] = React.useState(false);
  const hasLoadedRef = React.useRef(false);

  React.useEffect(() => {
    if (!expanded || !agent.childSessionKey || !onLoadChildSession || hasLoadedRef.current) return;
    hasLoadedRef.current = true;
    setChildSessionLoading(true);
    onLoadChildSession(agent.childSessionKey)
      .then((activities) => { setChildSessionActivities(activities); })
      .catch(() => { setChildSessionActivities([]); })
      .finally(() => { setChildSessionLoading(false); });
  }, [expanded, agent.childSessionKey, onLoadChildSession]);

  // 完成瞬间高亮
  const prevStatusRef = React.useRef(agent.status);
  const [justCompleted, setJustCompleted] = React.useState(false);
  React.useEffect(() => {
    if (prevStatusRef.current === "running" && agent.status === "completed") {
      setJustCompleted(true);
      const timer = setTimeout(() => setJustCompleted(false), 2000);
      return () => clearTimeout(timer);
    }
    prevStatusRef.current = agent.status;
  }, [agent.status]);

  return (
    <Collapsible.Root open={expanded} onOpenChange={onToggle}>
      <div
        className={cn(
          "rounded-lg border bg-background/80 transition-colors duration-500",
          justCompleted
            ? "border-green-500/60 animate-pulse-border"
            : "border-border/70"
        )}
      >
        {/* 折叠/展开触发器 */}
        <Collapsible.Trigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/30"
          >
            <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground/70 transition-transform duration-200", expanded && "rotate-90")} />
            {statusIcon(agent.status)}
            <span className="min-w-0 flex-1 truncate text-xs font-medium">{agent.name}</span>
            {/* 折叠状态显示当前执行工具 */}
            {!expanded && agent.status === "running" && agent.currentToolName ? (
              <span className="flex shrink-0 items-center gap-1 text-[10px] text-blue-500/90">
                <span className="size-1.5 rounded-full bg-blue-500 animate-pulse" />
                {agent.currentToolName}
              </span>
            ) : null}
            {agent.subagentType && !(!expanded && agent.status === "running" && agent.currentToolName) ? (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{agent.subagentType}</span>
            ) : null}
            {elapsed ? (
              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">{elapsed}</span>
            ) : null}
          </button>
        </Collapsible.Trigger>

        {/* 折叠状态下的描述预览 */}
        {!expanded && agent.description ? (
          <p className="truncate px-8 pb-2 text-[10px] leading-none text-muted-foreground/60">
            {agent.description}
          </p>
        ) : null}

        {/* 展开内容（带动画） */}
        <Collapsible.Content className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up">
          <div className="space-y-2 border-t border-border/60 px-3 py-2">
            <p className="text-[11px] leading-relaxed text-foreground/80">{agent.description}</p>

            {agent.currentToolName && agent.status === "running" ? (
              <div className="flex items-center gap-1.5 text-[10px]">
                <span className="relative flex size-2">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-blue-400 opacity-75" />
                  <span className="relative inline-flex size-2 rounded-full bg-blue-500" />
                </span>
                <span className="text-blue-600">{agent.currentToolName}</span>
                {agent.progressDescription ? (
                  <span className="truncate text-muted-foreground/80">{agent.progressDescription}</span>
                ) : null}
              </div>
            ) : null}

            {agent.toolHistory && agent.toolHistory.length > 0 ? (
              <div className="flex flex-wrap gap-1 text-[10px]">
                {agent.toolHistory.slice(-6).map((tool, i) => (
                  <span key={`${tool}-${i}`} className="rounded bg-muted px-1 py-0.5 text-muted-foreground/70">
                    {tool}
                  </span>
                ))}
              </div>
            ) : null}

            {(agent.durationMs || agent.toolCallCount || agent.tokenUsage) ? (
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground/70">
                {agent.durationMs ? <span>{Math.floor(agent.durationMs / 1000)}s</span> : null}
                {agent.toolCallCount ? <span>{agent.toolCallCount} calls</span> : null}
                {agent.tokenUsage ? <span>{agent.tokenUsage} tokens</span> : null}
              </div>
            ) : null}

            {(shortRunId || agent.errorCode) ? (
              <div className="flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground/80">
                {shortRunId ? <span className="rounded bg-muted px-1.5 py-0.5">run {shortRunId}</span> : null}
                {agent.errorCode ? (
                  <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-destructive">{agent.errorCode}</span>
                ) : null}
              </div>
            ) : null}

            {agent.outputResult ? (
              <div className="rounded-md bg-muted/20 px-2.5 py-2">
                <div className="mb-1 text-[10px] font-medium text-muted-foreground">输出结果</div>
                <p className="line-clamp-5 text-[11px] leading-relaxed text-foreground/80">{agent.outputResult}</p>
              </div>
            ) : null}

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
            ) : null}

            {/* 子 session 工具历史懒加载 */}
            {agent.childSessionKey && onLoadChildSession ? (
              <div className="rounded-md bg-muted/20 px-2 py-1.5">
                <div className="mb-1 text-[10px] font-medium text-muted-foreground">子任务工具历史</div>
                {childSessionLoading ? (
                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                    <Loader2 className="size-3 animate-spin" />
                    <span>加载中...</span>
                  </div>
                ) : childSessionActivities && childSessionActivities.length > 0 ? (
                  <div className="space-y-1">
                    {childSessionActivities.slice(0, 10).map((activity) => {
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
                    {childSessionActivities.length > 10 ? (
                      <div className="text-[10px] text-muted-foreground/70">+{childSessionActivities.length - 10} 条更多</div>
                    ) : null}
                  </div>
                ) : childSessionActivities ? (
                  <div className="text-[10px] text-muted-foreground/70">暂无工具调用记录</div>
                ) : null}
              </div>
            ) : null}

            {/* 查看完整对话按钮 */}
            {agent.childSessionKey && onOpenSession ? (
              <button
                type="button"
                onClick={() => onOpenSession(agent.childSessionKey!)}
                className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
              >
                <ExternalLink className="size-3" />
                查看完整对话
              </button>
            ) : null}
          </div>
        </Collapsible.Content>
      </div>
    </Collapsible.Root>
  );
}

function AgentTreeView({
  nodes,
  depth = 0,
  expandedId,
  onToggle,
  onOpenSession,
  onLoadChildSession
}: {
  nodes: AgentTreeNode[];
  depth?: number;
  expandedId: string | null;
  onToggle: (id: string) => void;
  onOpenSession?: (sessionId: string) => void;
  onLoadChildSession?: (childSessionId: string) => Promise<ToolActivity[]>;
}): React.ReactElement | null {
  if (nodes.length === 0) return null;
  return (
    <div className={depth > 0 ? "ml-3 border-l border-border/40 pl-3" : "space-y-2"}>
      {nodes.map((node) => (
        <React.Fragment key={node.activity.toolUseId}>
          <AgentCard
            agent={node.activity}
            expanded={expandedId === node.activity.toolUseId}
            onToggle={() => onToggle(node.activity.toolUseId)}
            onOpenSession={onOpenSession}
            onLoadChildSession={onLoadChildSession}
          />
          {node.children.length > 0 ? (
            <AgentTreeView
              nodes={node.children}
              depth={depth + 1}
              expandedId={expandedId}
              onToggle={onToggle}
              onOpenSession={onOpenSession}
              onLoadChildSession={onLoadChildSession}
            />
          ) : null}
        </React.Fragment>
      ))}
    </div>
  );
}

export function TeamActivityPanel({ activities, inboxItems, onOpenSession, onLoadChildSession }: TeamActivityPanelProps): React.ReactElement {
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const overview = React.useMemo(() => extractTeamOverview(activities), [activities]);
  const hasOverviewData = !!overview && (
    overview.tasks.length > 0
    || overview.agents.length > 0
    || !!overview.teamName
  );

  if (!hasOverviewData && inboxItems.length === 0) {
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

  const runningCount = (overview?.agents ?? []).filter((item) => item.status === "running" || item.status === "backgrounded").length;
  const doneCount = (overview?.agents ?? []).filter((item) => item.status === "completed" || item.status === "error").length;

  return (
    <div className="flex h-full flex-col">
      {overview?.teamName ? (
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
        <span>{overview?.agents.length ?? 0} 个 Agent</span>
        <span className="ml-auto inline-flex items-center gap-2">
          {runningCount > 0 ? <span className="text-blue-600">运行中 {runningCount}</span> : null}
          {doneCount > 0 ? <span className="text-green-600">完成 {doneCount}</span> : null}
        </span>
      </div>

      <ScrollArea className="flex-1">
        <div className="space-y-2 p-2">
          <InboxTimeline items={inboxItems} onOpenSession={onOpenSession} />
          <TaskBoard tasks={overview?.tasks ?? []} />

          <AgentTreeView
            nodes={buildAgentTree(overview?.agents ?? [])}
            expandedId={expandedId}
            onToggle={(id) => setExpandedId((prev) => (prev === id ? null : id))}
            onOpenSession={onOpenSession}
            onLoadChildSession={onLoadChildSession}
          />
        </div>
      </ScrollArea>
    </div>
  );
}
