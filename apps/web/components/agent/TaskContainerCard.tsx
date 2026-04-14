import * as React from "react";
import { CheckCircle2, ChevronRight, Loader2, XCircle } from "lucide-react";
import type { ToolActivity } from "@/atoms";
import type { TaskGroup } from "@/lib/agent-tool-activity";
import type { AgentStreamState } from "@/lib/agent-streaming";
import { cn } from "@/lib/utils";
import { normalizeSubagentResultText } from "@/lib/subagent-rendering";
import { getActivityStatus, getToolIcon } from "./tool-activity/meta";
import { formatElapsed } from "./tool-activity/utils";
import {
  MessageResponse,
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements";
import { ToolActivityTree } from "./ToolActivityItem";

function SubActivityRow({ activity }: { activity: ToolActivity }) {
  const status = getActivityStatus(activity);
  const Icon = getToolIcon(activity.toolName);
  const label = activity.displayName ?? activity.intent ?? activity.toolName;
  return (
    <div className="flex items-center gap-2 py-[3px] text-[12px] text-muted-foreground">
      <Icon className="size-3 shrink-0 opacity-60" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {status === "running" ? <Loader2 className="size-2.5 animate-spin text-blue-500" /> : null}
      {status === "completed" ? <CheckCircle2 className="size-2.5 text-green-500" /> : null}
      {status === "error" ? <XCircle className="size-2.5 text-destructive" /> : null}
    </div>
  );
}

export function TaskContainerCard({
  group,
  subagentStream,
  defaultExpanded = false,
}: {
  group: TaskGroup;
  subagentStream?: AgentStreamState;
  defaultExpanded?: boolean;
}) {
  const { parent, children } = group;
  const [expanded, setExpanded] = React.useState(defaultExpanded);
  const isDone = parent.done;
  const isError = parent.isError;
  const label = parent.displayName ?? parent.intent ?? parent.toolName;
  const elapsed = parent.elapsedSeconds != null ? formatElapsed(parent.elapsedSeconds) : null;

  React.useEffect(() => {
    if (!isDone) setExpanded(true);
  }, [isDone]);

  const normalizedParentResult = normalizeSubagentResultText(parent.result);
  const hasSubagentReasoning = Boolean((subagentStream?.reasoning ?? "").trim());
  const normalizedSubagentContent = normalizeSubagentResultText(subagentStream?.content);
  const hasSubagentContent = Boolean(normalizedSubagentContent);
  const hasSubagentActivities = (subagentStream?.toolActivities?.length ?? 0) > 0;
  const hasContent = children.length > 0 || !!normalizedParentResult || hasSubagentReasoning || hasSubagentContent || hasSubagentActivities;

  return (
    <div className="my-1.5 max-w-[630px] rounded-lg border border-border/60 bg-muted/25">
      <button
        type="button"
        onClick={() => hasContent && setExpanded(v => !v)}
        className={cn("flex w-full items-center gap-2 px-3.5 py-2.5 text-left", !hasContent && "cursor-default")}
      >
        <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground/50 transition-transform", expanded && "rotate-90")} />
        {!isDone ? <Loader2 className="size-3.5 shrink-0 animate-spin text-blue-500" /> : null}
        {isDone && !isError ? <CheckCircle2 className="size-3.5 shrink-0 text-green-500" /> : null}
        {isDone && isError ? <XCircle className="size-3.5 shrink-0 text-destructive" /> : null}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground/80">{label}</span>
        {elapsed ? <span className="shrink-0 text-[11px] text-muted-foreground/50">{elapsed}</span> : null}
        <span className="shrink-0 text-[11px] text-muted-foreground/40">{children.length} 步</span>
      </button>
      {expanded && hasContent ? (
        <div className="border-t border-border/40 px-3.5 py-2">
          {children.map(child => <SubActivityRow key={child.toolUseId} activity={child} />)}
          {hasSubagentActivities ? (
            <div className="mt-2">
              <div className="mb-1 text-[11px] font-medium text-muted-foreground/70">子 Agent 工具过程</div>
              <ToolActivityTree activities={subagentStream?.toolActivities ?? []} />
            </div>
          ) : null}
          {hasSubagentReasoning ? (
            <div className="mt-2">
              <Reasoning defaultOpen={false}>
                <ReasoningTrigger />
                <ReasoningContent>{subagentStream?.reasoning ?? ""}</ReasoningContent>
              </Reasoning>
            </div>
          ) : null}
          {hasSubagentContent ? (
            <div className="mt-2">
              <div className="mb-1 text-[11px] font-medium text-muted-foreground/70">子 Agent 输出</div>
              <MessageResponse>{normalizedSubagentContent ?? ""}</MessageResponse>
            </div>
          ) : null}
          {children.length === 0 && normalizedParentResult ? (
            <p className="mt-2 text-[12px] text-muted-foreground whitespace-pre-wrap break-words">{normalizedParentResult}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
