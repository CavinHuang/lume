/**
 * SDKContentBlock — 单个 SDK 内容块渲染
 *
 * 支持：
 * - text: 通过 MessageResponse 渲染 Markdown
 * - tool_use: 语义化短语行 + 可展开结构化结果（专属渲染器）
 * - thinking: 默认折叠，左上角 "Thinking" 标签
 *
 * 新增：
 * - 工具结果专属渲染器（Bash 终端/Read 代码/Edit Diff/Grep 分组等）
 * - 入场动画（交错 fade-in + slide-in）
 */
import * as React from "react";
import {
  ChevronRight,
  Loader2,
  MessageSquareText,
  XCircle,
} from "lucide-react";
import type { SDKMessage } from "@lume/agent-sdk";
import { MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { cn } from "@/lib/utils";
import { getToolIcon } from "./tool-utils";
import { getToolActivePhrase, getToolDonePhrase } from "./tool-phrase";
import { ToolResultRenderer } from "./tool-result-renderers";

type SDKTextBlock = { type: "text"; text: string };
type SDKThinkingBlock = { type: "thinking"; thinking: string };
type SDKToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
type SDKToolResultBlock = { type: "tool_result"; tool_use_id: string; content?: unknown; is_error?: boolean };
export type SDKContentBlock = SDKTextBlock | SDKThinkingBlock | SDKToolUseBlock | { type: string; [key: string]: unknown };
type SDKAssistantMessage = Extract<SDKMessage, { type: "assistant" }>;
type SDKUserMessage = Extract<SDKMessage, { type: "user" }>;

// ─── useToolResult hook ───

function useToolResult(toolUseId: string, allMessages: SDKMessage[]) {
  return React.useMemo(() => {
    for (const msg of allMessages) {
      if (msg.type === "tool_result") {
        const toolResultMessage = msg as Extract<SDKMessage, { type: "tool_result" }>;
        if (toolResultMessage.result.tool_use_id !== toolUseId) continue;
        return {
          result: typeof toolResultMessage.result.output === "string"
            ? toolResultMessage.result.output
            : JSON.stringify(toolResultMessage.result.output, null, 2),
          isError: false,
        };
      }
      if (msg.type !== "user") continue;
      const userMsg = msg as SDKUserMessage;
      const blocks = userMsg.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        if (block.type !== "tool_result") continue;
        const toolResult = block as SDKToolResultBlock;
        if (toolResult.tool_use_id !== toolUseId) continue;
        let result = "";
        if (typeof toolResult.content === "string") {
          result = toolResult.content;
        } else if (Array.isArray(toolResult.content)) {
          result = toolResult.content
            .filter((item): item is { type: string; text?: string } => !!item && typeof item === "object")
            .filter((item) => item.type === "text" && typeof item.text === "string")
            .map((item) => item.text ?? "")
            .join("\n");
        }
        return { result, isError: toolResult.is_error === true };
      }
    }
    return null;
  }, [allMessages, toolUseId]);
}

// ─── PromptRow ───

function PromptRow({ prompt, dimmed = false }: { prompt: string; dimmed?: boolean }) {
  const [expanded, setExpanded] = React.useState(false);
  const preview = prompt.length > 60 ? `${prompt.slice(0, 60)}...` : prompt;
  return (
    <div>
      <button
        type="button"
        className="group flex items-center gap-2 py-0.5 text-left transition-opacity hover:opacity-70"
        onClick={() => setExpanded((v) => !v)}
      >
        <MessageSquareText
          className={cn("size-3.5 shrink-0", dimmed ? "text-muted-foreground/70" : "text-muted-foreground")}
        />
        <span className={cn("shrink-0 text-[14px]", dimmed ? "text-muted-foreground/70" : "text-muted-foreground")}>
          提示词
        </span>
        <span className={cn("truncate text-[14px]", dimmed ? "text-muted-foreground/50" : "text-muted-foreground/60")}>
          {preview}
        </span>
        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-muted-foreground/40 opacity-0 transition-all duration-150 group-hover:opacity-100",
            expanded && "rotate-90 opacity-100",
          )}
        />
      </button>
      {expanded ? (
        <div className="mb-2 ml-5.5 mt-1 border-l-2 border-border/30 pl-3 animate-in fade-in slide-in-from-top-1 duration-150">
          <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground/70">{prompt}</p>
        </div>
      ) : null}
    </div>
  );
}

// ─── ToolUseBlock ───

function ToolUseBlock({
  block,
  allMessages,
  childBlocks,
  dimmed = false,
  animate = false,
  index = 0,
}: {
  block: SDKToolUseBlock;
  allMessages: SDKMessage[];
  childBlocks?: SDKContentBlock[];
  dimmed?: boolean;
  animate?: boolean;
  index?: number;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const [childrenExpanded, setChildrenExpanded] = React.useState(false);
  const toolResult = useToolResult(block.id, allMessages);
  const ToolIcon = getToolIcon(block.name);
  const isCompleted = toolResult !== null;
  const isError = toolResult?.isError === true;
  const isAgentTool = block.name === "Agent" || block.name === "Task";
  const prompt = isAgentTool && typeof block.input.prompt === "string" ? block.input.prompt : undefined;
  const label = isCompleted ? getToolDonePhrase(block.name, block.input) : getToolActivePhrase(block.name, block.input);
  const childToolCount = childBlocks?.filter((b) => b.type === "tool_use").length ?? 0;

  const animDelay = animate && index < 10 ? `${index * 30}ms` : "0ms";

  // Agent/Task 工具：特殊渲染（可展开子代理活动）
  if (isAgentTool) {
    return (
      <div
        className={cn(animate && "animate-in fade-in slide-in-from-left-1 duration-150 fill-mode-both")}
        style={animate ? { animationDelay: animDelay } : undefined}
      >
        <button
          type="button"
          className="group w-full flex items-center gap-2 py-0.5 text-left transition-opacity hover:opacity-70"
          onClick={() => setChildrenExpanded((v) => !v)}
        >
          <ChevronRight
            className={cn(
              "size-3 shrink-0 text-muted-foreground/50 transition-transform duration-150",
              childrenExpanded && "rotate-90",
            )}
          />
          {!isCompleted ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-primary/50" />
          ) : isError ? (
            <XCircle className="size-3.5 shrink-0 text-destructive/70" />
          ) : null}
          <ToolIcon className={cn("size-3.5 shrink-0", dimmed ? "text-muted-foreground/70" : "text-muted-foreground")} />
          <span className={cn("truncate text-[14px]", dimmed ? "text-muted-foreground/70" : "text-muted-foreground")}>
            {label}
          </span>
          {childToolCount > 0 && !childrenExpanded && (
            <span className="shrink-0 text-[11px] text-muted-foreground/50 tabular-nums">
              {childToolCount} 项工具调用
            </span>
          )}
        </button>

        {childrenExpanded && (
          <div className="ml-[5px] mt-1.5 space-y-2 border-l-2 border-primary/20 pl-5 animate-in fade-in slide-in-from-top-1 duration-150">
            {prompt && <PromptRow prompt={prompt} dimmed={dimmed} />}
            {childBlocks && childBlocks.length > 0 && childBlocks.map((childBlock, ci) => (
              <SDKContentBlockRenderer
                key={`${block.id}-child-${ci}`}
                block={childBlock}
                allMessages={allMessages}
                dimmed
                animate
                index={ci}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  // 普通工具：语义化短语 + 专属结果渲染
  return (
    <div
      className={cn(animate && "animate-in fade-in slide-in-from-left-1 duration-150 fill-mode-both")}
      style={animate ? { animationDelay: animDelay } : undefined}
    >
      <button
        type="button"
        className="group flex items-center gap-2 py-0.5 text-left transition-opacity hover:opacity-70"
        onClick={() => setExpanded((v) => !v)}
      >
        {!isCompleted ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-primary/50" />
        ) : isError ? (
          <XCircle className="size-3.5 shrink-0 text-destructive/70" />
        ) : null}
        <ToolIcon className={cn("size-3.5 shrink-0", dimmed ? "text-muted-foreground/70" : "text-muted-foreground")} />
        <span className={cn("truncate text-[14px]", dimmed ? "text-muted-foreground/70" : "text-muted-foreground")}>
          {label}
        </span>
        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-muted-foreground/40 opacity-0 transition-all duration-150 group-hover:opacity-100",
            expanded && "rotate-90 opacity-100",
          )}
        />
      </button>

      {expanded && toolResult?.result && (
        <div className="mb-2 ml-5.5 mt-1 border-l-2 border-border/30 pl-3 animate-in fade-in slide-in-from-top-1 duration-150">
          <ToolResultRenderer
            toolName={block.name}
            input={block.input}
            result={toolResult.result}
            isError={isError}
          />
        </div>
      )}
    </div>
  );
}

// ─── ThinkingBlock ───

function ThinkingBlock({ block, dimmed = false }: { block: SDKThinkingBlock; dimmed?: boolean }) {
  return (
    <Reasoning className={cn("mb-3", dimmed && "opacity-85")} defaultOpen={false}>
      <ReasoningTrigger />
      <ReasoningContent>{block.thinking}</ReasoningContent>
    </Reasoning>
  );
}

// ─── SDKContentBlockRenderer ───

export function SDKContentBlockRenderer({
  block,
  allMessages,
  dimmed = false,
  childBlocks,
  animate = false,
  index = 0,
}: {
  block: SDKContentBlock;
  allMessages: SDKMessage[];
  dimmed?: boolean;
  childBlocks?: SDKContentBlock[];
  animate?: boolean;
  index?: number;
}): React.ReactElement | null {
  if (block.type === "text") {
    if (!block.text) return null;
    return <MessageResponse>{String(block.text)}</MessageResponse>;
  }
  if (block.type === "thinking") {
    if (!block.thinking) return null;
    return <ThinkingBlock block={block as SDKThinkingBlock} dimmed={dimmed} />;
  }
  if (block.type === "tool_use") {
    return (
      <ToolUseBlock
        block={block as SDKToolUseBlock}
        allMessages={allMessages}
        childBlocks={childBlocks}
        dimmed={dimmed}
        animate={animate}
        index={index}
      />
    );
  }
  return null;
}

// ─── getAssistantContentBlocks ───

export function getAssistantContentBlocks(messages: SDKAssistantMessage[]): SDKContentBlock[] {
  return messages.flatMap((message) => message.message?.content ?? []);
}
