/**
 * ContentBlock — Turn 内的内容块渲染
 *
 * 包含两个核心子组件：
 * - ToolUseBlock: 工具调用块（使用语义化短语 + 图标）
 * - ThinkingBlock: 推理/思考块（可折叠）
 *
 * 设计目标：替代 EventTimeline 中直接渲染 ToolActivityList 的模式，
 * 提供更结构化、更语义化的内容块展示。
 */
import * as React from "react";
import {
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ToolActivity } from "@/atoms";
import { getToolActivePhrase, getToolDonePhrase } from "./tool-phrase";
import {
  basename,
  computeDiffStats,
  extractFilePath,
  formatElapsed,
  getToolIcon,
} from "./tool-utils";

// ─── Types ───

export type ContentBlockType = "tool_use" | "thinking" | "text";

export interface ContentBlockItem {
  type: ContentBlockType;
  /** 工具调用块 */
  activity?: ToolActivity;
  /** 思考块内容 */
  thinking?: string;
  /** 文本块内容 */
  text?: string;
}

// ─── ToolUseBlock ───

interface ToolUseBlockProps {
  activity: ToolActivity;
  animate?: boolean;
  index?: number;
}

function getActivityStatus(activity: ToolActivity): "pending" | "running" | "backgrounded" | "completed" | "error" {
  if (activity.isError) return "error";
  if (activity.done) return "completed";
  if (activity.isBackground) return "backgrounded";
  if (activity.result || Object.keys(activity.input).length > 0) return "running";
  return "pending";
}

export const ToolUseBlock = React.memo(function ToolUseBlock({
  activity,
  animate = false,
  index = 0,
}: ToolUseBlockProps): React.ReactElement {
  const status = getActivityStatus(activity);
  const ToolIcon = getToolIcon(activity.toolName);
  const filePath = extractFilePath(activity.input);
  const diffStats = computeDiffStats(activity.toolName, activity.input);
  const fileName = filePath ? basename(filePath) : null;

  const phrase = status === "completed" || status === "error"
    ? getToolDonePhrase(activity.toolName, activity.input)
    : getToolActivePhrase(activity.toolName, activity.input);

  const elapsedLabel = activity.elapsedMs !== undefined && activity.elapsedMs > 0
    ? formatElapsed(activity.elapsedMs, "ms")
    : activity.elapsedSeconds !== undefined && activity.elapsedSeconds > 0
      ? formatElapsed(activity.elapsedSeconds)
      : null;

  const delay = animate && index < 10 ? `${index * 30}ms` : "0ms";

  return (
    <div
      className={cn(
        "group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
        "hover:bg-muted/30",
        animate && "animate-in fade-in slide-in-from-left-2 duration-200 fill-mode-both",
      )}
      style={animate ? { animationDelay: delay } : undefined}
    >
      {/* 状态指示 */}
      <span className="flex size-5 shrink-0 items-center justify-center rounded-md border border-white/10 bg-black/10">
        {status === "running" || status === "backgrounded" ? (
          <Loader2 className={cn("size-3 animate-spin", status === "backgrounded" ? "text-primary" : "text-blue-500")} />
        ) : status === "error" ? (
          <XCircle className="size-3 text-destructive" />
        ) : status === "completed" ? (
          <ToolIcon className="size-3 text-primary" />
        ) : (
          <ToolIcon className="size-3 text-muted-foreground/50" />
        )}
      </span>

      {/* 语义短语 */}
      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/80">
        {phrase}

        {/* 运行中动画点 */}
        {status === "running" ? (
          activity.progressDescription ? (
            <span className="ml-1.5 text-blue-400/70 truncate">{activity.progressDescription}</span>
          ) : (
            <span className="ml-2 inline-flex items-center gap-[3px] align-middle">
              <span className="size-[3px] rounded-full bg-blue-400/80 animate-bounce [animation-delay:0ms]" />
              <span className="size-[3px] rounded-full bg-blue-400/80 animate-bounce [animation-delay:120ms]" />
              <span className="size-[3px] rounded-full bg-blue-400/80 animate-bounce [animation-delay:240ms]" />
            </span>
          )
        ) : null}
      </span>

      {/* 文件名 badge */}
      {fileName ? (
        <span className="shrink-0 rounded bg-background px-1.5 py-0.5 text-[10px] leading-none text-foreground/70 shadow-sm">
          {fileName}
        </span>
      ) : null}

      {/* Diff 统计 */}
      {diffStats ? (
        <span className="shrink-0 flex items-center gap-1">
          {diffStats.deletions > 0 ? (
            <span className="rounded bg-destructive/5 px-1.5 py-0.5 text-[10px] leading-none text-destructive shadow-sm">
              -{diffStats.deletions}
            </span>
          ) : null}
          {diffStats.additions > 0 ? (
            <span className="rounded bg-green-500/5 px-1.5 py-0.5 text-[10px] leading-none text-green-600 shadow-sm dark:text-green-400">
              +{diffStats.additions}
            </span>
          ) : null}
        </span>
      ) : null}

      {/* 完成标记 */}
      {status === "completed" ? (
        <CheckCircle2 className="size-3 shrink-0 text-green-500" />
      ) : null}

      {/* 耗时 */}
      {elapsedLabel ? (
        <span className="shrink-0 flex items-center gap-1 text-[11px] tabular-nums text-muted-foreground/50">
          <Clock className="size-2.5" />
          {elapsedLabel}
        </span>
      ) : null}
    </div>
  );
});

// ─── ThinkingBlock ───

interface ThinkingBlockProps {
  thinking: string;
  /** 思考耗时（毫秒） */
  durationMs?: number;
  /** 是否还在思考中 */
  isStreaming?: boolean;
}

export const ThinkingBlock = React.memo(function ThinkingBlock({
  thinking,
  durationMs,
  isStreaming = false,
}: ThinkingBlockProps): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false);
  const lines = thinking.split("\n").length;
  const preview = thinking.length > 200 ? `${thinking.slice(0, 200)}…` : thinking;

  const durationLabel = durationMs
    ? formatElapsed(durationMs, "ms")
    : null;

  return (
    <div className="rounded-md border border-border/30 bg-muted/5">
      {/* 头部 */}
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/20"
        onClick={() => setExpanded(!expanded)}
      >
        <Brain className={cn(
          "size-3.5 shrink-0",
          isStreaming ? "text-purple-400 animate-pulse" : "text-purple-400/60",
        )} />
        <span className="flex-1 text-xs font-medium text-foreground/70">
          {isStreaming ? "正在思考…" : "思考过程"}
        </span>
        {durationLabel ? (
          <span className="text-[10px] tabular-nums text-muted-foreground/50">{durationLabel}</span>
        ) : null}
        {expanded ? (
          <ChevronDown className="size-3 text-muted-foreground/50" />
        ) : (
          <ChevronRight className="size-3 text-muted-foreground/50" />
        )}
      </button>

      {/* 展开内容 */}
      {expanded ? (
        <div className="border-t border-border/20 px-3 py-2">
          <pre className="whitespace-pre-wrap text-[12px] leading-relaxed text-foreground/60">
            {thinking}
          </pre>
          <div className="mt-1 text-[10px] text-muted-foreground/40">{lines} 行</div>
        </div>
      ) : (
        !isStreaming && thinking.length > 0 ? (
          <div className="px-3 pb-2">
            <p className="truncate text-[11px] text-foreground/40">{preview}</p>
          </div>
        ) : null
      )}
    </div>
  );
});

// ─── ContentBlockList ───

interface ContentBlockListProps {
  blocks: ContentBlockItem[];
  animate?: boolean;
}

/**
 * 渲染一组 ContentBlock
 */
export function ContentBlockList({
  blocks,
  animate = false,
}: ContentBlockListProps): React.ReactElement | null {
  if (blocks.length === 0) return null;

  return (
    <div className="space-y-1">
      {blocks.map((block, index) => {
        if (block.type === "tool_use" && block.activity) {
          return (
            <ToolUseBlock
              key={block.activity.toolUseId}
              activity={block.activity}
              animate={animate}
              index={index}
            />
          );
        }
        if (block.type === "thinking" && block.thinking) {
          return (
            <ThinkingBlock
              key={`thinking-${index}`}
              thinking={block.thinking}
            />
          );
        }
        return null;
      })}
    </div>
  );
}
