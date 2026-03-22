"use client";

import { useMemo } from "react";
import { useAtomValue } from "jotai";
import { Brain, CheckCircle2, ChevronRight, Globe, ImagePlus, Loader2, Sparkles, Wrench, XCircle } from "lucide-react";
import type { ChatToolActivity } from "@lume/shared";
import type { ReactElement } from "react";
import { chatToolsAtom } from "@/atoms";
import { MessageResponse } from "@/components/ai-elements";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

const TOOL_LABELS: Record<string, { running: string; done: string }> = {
  memory_search: { running: "正在检索记忆...", done: "记忆检索完成" },
  recall_memory: { running: "正在回忆...", done: "回忆完成" },
  add_memory: { running: "正在记住...", done: "已记住" },
  web_search: { running: "正在搜索...", done: "搜索完成" },
  suggest_agent_mode: { running: "正在分析任务适配性...", done: "已推荐 Agent 模式" },
  nano_banana: { running: "正在生成图片...", done: "图片生成完成" }
};

function getToolIcon(toolName: string): ReactElement {
  if (toolName === "memory_search" || toolName === "recall_memory" || toolName === "add_memory") {
    return <Brain className="size-3" />;
  }
  if (toolName === "web_search") {
    return <Globe className="size-3" />;
  }
  if (toolName === "suggest_agent_mode") {
    return <Sparkles className="size-3" />;
  }
  if (toolName === "nano_banana") {
    return <ImagePlus className="size-3" />;
  }
  return <Wrench className="size-3" />;
}

interface MergedToolActivity {
  toolName: string;
  done: boolean;
  isError?: boolean;
  result?: string;
}

function ToolActivityCollapsible({
  item,
  label
}: {
  item: MergedToolActivity;
  label: { running: string; done: string };
}): ReactElement {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground">
        {item.isError ? (
          <XCircle className="size-3 shrink-0 text-destructive" />
        ) : (
          <CheckCircle2 className="size-3 shrink-0 text-green-500" />
        )}
        {getToolIcon(item.toolName)}
        <span>{item.isError ? `${label.done}（失败）` : label.done}</span>
        <ChevronRight className="ml-auto size-3 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 ml-5 max-h-60 overflow-y-auto rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
          <MessageResponse>{item.result ?? ""}</MessageResponse>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ChatToolActivityIndicator({
  activities
}: {
  activities: ChatToolActivity[];
}): ReactElement | null {
  const toolInfos = useAtomValue(chatToolsAtom);
  const toolNameMap = useMemo(
    () => new Map(toolInfos.map((item) => [item.meta.id, item.meta.name] as const)),
    [toolInfos]
  );

  if (activities.length === 0) return null;

  const merged = new Map<string, MergedToolActivity>();
  for (const activity of activities) {
    const existing = merged.get(activity.toolCallId);
    if (activity.type === "start") {
      merged.set(activity.toolCallId, { toolName: activity.toolName, done: false });
      continue;
    }
    merged.set(activity.toolCallId, {
      toolName: existing?.toolName ?? activity.toolName,
      done: true,
      isError: activity.isError,
      result: activity.result
    });
  }

  const items = Array.from(merged.entries());
  if (items.length === 0) return null;

  return (
    <div className="mb-2 space-y-1">
      {items.map(([callId, item]) => {
        const displayName = toolNameMap.get(item.toolName) ?? item.toolName;
        const label = TOOL_LABELS[item.toolName] ?? {
          running: `正在执行 ${displayName}...`,
          done: `${displayName} 完成`
        };
        const hasResult = item.done && item.result;

        if (hasResult) {
          return <ToolActivityCollapsible key={callId} item={item} label={label} />;
        }

        return (
          <div
            key={callId}
            className={cn(
              "flex items-center gap-1.5 text-xs text-muted-foreground",
              "animate-in slide-in-from-left-2 fade-in duration-200"
            )}
          >
            {!item.done ? (
              <Loader2 className="size-3 animate-spin text-primary" />
            ) : item.isError ? (
              <XCircle className="size-3 text-destructive" />
            ) : (
              <CheckCircle2 className="size-3 text-green-500" />
            )}
            {getToolIcon(item.toolName)}
            <span>{item.done ? (item.isError ? `${label.done}（失败）` : label.done) : label.running}</span>
          </div>
        );
      })}
    </div>
  );
}
