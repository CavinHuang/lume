import * as React from "react";
import { Brain, ChevronDown, ChevronRight, Loader2, MessageSquareText, XCircle } from "lucide-react";
import type { SDKMessage } from "@lume/shared";
import { MessageResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import { getToolActivePhrase, getToolDonePhrase } from "./tool-phrase";
import { ToolResultRenderer } from "./tool-result-renderers";
import { getToolIcon } from "./tool-utils";

type SDKTextBlock = { type: "text"; text: string };
type SDKThinkingBlock = { type: "thinking"; thinking: string };
type SDKToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
type SDKToolResultBlock = { type: "tool_result"; tool_use_id: string; content?: unknown; is_error?: boolean };

export type SDKContentBlock =
  | SDKTextBlock
  | SDKThinkingBlock
  | SDKToolUseBlock
  | { type: string; [key: string]: unknown };

type SDKAssistantMessage = Extract<SDKMessage, { type: "assistant" }>;
type SDKUserMessage = Extract<SDKMessage, { type: "user" }>;

interface ToolResultData {
  result?: string;
  isError?: boolean;
}

function stringifyToolResultContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((item): item is { type: string; text?: string } => !!item && typeof item === "object")
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text ?? "")
      .join("\n");
  }
  if (content === undefined || content === null) return undefined;
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

function useToolResult(toolUseId: string, allMessages: SDKMessage[]): ToolResultData | null {
  return React.useMemo(() => {
    for (const message of allMessages) {
      if (message.type === "tool_result") {
        if (message.result.tool_use_id === toolUseId) {
          return {
            result: stringifyToolResultContent(message.result.output),
            isError: false,
          };
        }
        continue;
      }

      if (message.type !== "user") continue;
      const userMessage = message as SDKUserMessage;
      const contentBlocks = userMessage.message?.content;
      if (!Array.isArray(contentBlocks)) continue;
      for (const block of contentBlocks) {
        if (block.type !== "tool_result") continue;
        const resultBlock = block as SDKToolResultBlock;
        if (resultBlock.tool_use_id !== toolUseId) continue;
        return {
          result: stringifyToolResultContent(resultBlock.content),
          isError: resultBlock.is_error === true,
        };
      }
    }
    return null;
  }, [allMessages, toolUseId]);
}

function PromptRow({ prompt, dimmed = false }: { prompt: string; dimmed?: boolean }): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false);
  const preview = prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt;

  return (
    <div>
      <button
        type="button"
        className="group flex items-center gap-2 py-0.5 text-left transition-opacity hover:opacity-70"
        onClick={() => setExpanded((value) => !value)}
      >
        <MessageSquareText className={cn("size-3.5 shrink-0", dimmed ? "text-muted-foreground/70" : "text-muted-foreground")} />
        <span className={cn("shrink-0 text-[14px]", dimmed ? "text-muted-foreground/70" : "text-muted-foreground")}>提示词</span>
        <span className={cn("truncate text-[14px]", dimmed ? "text-muted-foreground/50" : "text-muted-foreground/60")}>{preview}</span>
        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-muted-foreground/40 opacity-0 transition-all duration-150 group-hover:opacity-100",
            expanded && "rotate-90 opacity-100"
          )}
        />
      </button>

      {expanded ? (
        <div className="mb-2 ml-5.5 mt-1 animate-in fade-in slide-in-from-top-1 border-l-2 border-border/30 pl-3 duration-150">
          <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground/70">{prompt}</p>
        </div>
      ) : null}
    </div>
  );
}

function ThinkingBlock({ block, dimmed = false }: { block: SDKThinkingBlock; dimmed?: boolean }): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false);

  return (
    <div className={cn("rounded-md border border-border/30 bg-muted/5", dimmed && "opacity-85")}>
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/20"
        onClick={() => setExpanded((value) => !value)}
      >
        <Brain className="size-3.5 shrink-0 text-purple-400/70" />
        <span className="flex-1 text-xs font-medium text-foreground/70">思考过程</span>
        {expanded ? (
          <ChevronDown className="size-3 text-muted-foreground/50" />
        ) : (
          <ChevronRight className="size-3 text-muted-foreground/50" />
        )}
      </button>

      {expanded ? (
        <div className="border-t border-border/20 px-3 py-2">
          <pre className="whitespace-pre-wrap text-[12px] leading-relaxed text-foreground/60">{block.thinking}</pre>
        </div>
      ) : null}
    </div>
  );
}

function ToolUseBlock({
  block,
  allMessages,
  childBlocks,
  dimmed = false,
  animate = false,
  index = 0,
  isStreaming = false,
}: {
  block: SDKToolUseBlock;
  allMessages: SDKMessage[];
  childBlocks?: SDKContentBlock[];
  dimmed?: boolean;
  animate?: boolean;
  index?: number;
  isStreaming?: boolean;
}): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false);
  const [childrenExpanded, setChildrenExpanded] = React.useState(false);
  const toolResult = useToolResult(block.id, allMessages);
  const ToolIcon = getToolIcon(block.name);
  const isCompleted = toolResult !== null;
  const isError = toolResult?.isError === true;
  const isAgentTool = block.name === "Agent" || block.name === "Task";
  const displayLabel = isCompleted || !isStreaming
    ? getToolDonePhrase(block.name, block.input)
    : getToolActivePhrase(block.name, block.input);
  const delay = animate && index < 10 ? `${index * 30}ms` : "0ms";
  const childToolCount = childBlocks?.filter((item) => item.type === "tool_use").length ?? 0;
  const agentPrompt = isAgentTool && typeof block.input.prompt === "string" ? block.input.prompt : undefined;

  if (isAgentTool) {
    return (
      <div
        className={cn(animate && "animate-in fade-in slide-in-from-left-1 duration-150 fill-mode-both")}
        style={animate ? { animationDelay: delay } : undefined}
      >
        <button
          type="button"
          className="group flex w-full items-center gap-2 py-0.5 text-left transition-opacity hover:opacity-70"
          onClick={() => setChildrenExpanded((value) => !value)}
        >
          <ChevronRight
            className={cn(
              "size-3 shrink-0 text-muted-foreground/50 transition-transform duration-150",
              childrenExpanded && "rotate-90"
            )}
          />

          {!isCompleted && isStreaming ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-primary/50" />
          ) : isError ? (
            <XCircle className="size-3.5 shrink-0 text-destructive/70" />
          ) : null}

          <ToolIcon className={cn("size-3.5 shrink-0", dimmed ? "text-muted-foreground/70" : "text-muted-foreground")} />
          <span className={cn("truncate text-[14px]", dimmed ? "text-muted-foreground/70" : "text-muted-foreground")}>
            {displayLabel}
          </span>

          {childToolCount > 0 && !childrenExpanded ? (
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/50">{childToolCount} 项工具调用</span>
          ) : null}
        </button>

        {childrenExpanded ? (
          <div className="ml-[5px] mt-1.5 space-y-2 animate-in fade-in slide-in-from-top-1 border-l-2 border-primary/20 pl-5 duration-150">
            {agentPrompt ? <PromptRow prompt={agentPrompt} dimmed={dimmed} /> : null}
            {childBlocks?.map((childBlock, childIndex) => (
              <SDKContentBlockRenderer
                key={`${block.id}-child-${childIndex}`}
                block={childBlock}
                allMessages={allMessages}
                dimmed
                animate
                index={childIndex}
                isStreaming={isStreaming}
              />
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={cn(
        animate && "animate-in fade-in slide-in-from-left-1 duration-150 fill-mode-both",
        dimmed && "opacity-80"
      )}
      style={animate ? { animationDelay: delay } : undefined}
    >
      <button
        type="button"
        className="group flex w-full items-center gap-2 py-0.5 text-left transition-opacity hover:opacity-70"
        onClick={() => setExpanded((value) => !value)}
      >
        {!isCompleted && isStreaming ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-primary/50" />
        ) : isError ? (
          <XCircle className="size-3.5 shrink-0 text-destructive/70" />
        ) : null}
        <ToolIcon className={cn("size-3.5 shrink-0", dimmed ? "text-muted-foreground/70" : "text-muted-foreground")} />
        <span className={cn("truncate text-[14px]", dimmed ? "text-muted-foreground/70" : "text-muted-foreground")}>
          {displayLabel}
        </span>
        {(toolResult?.result || Object.keys(block.input ?? {}).length > 0) ? (
          <ChevronRight
            className={cn(
              "size-3 shrink-0 text-muted-foreground/40 opacity-0 transition-all duration-150 group-hover:opacity-100",
              expanded && "rotate-90 opacity-100"
            )}
          />
        ) : null}
      </button>

      {expanded && toolResult?.result ? (
        <div className="ml-[5px] mt-1.5 animate-in fade-in slide-in-from-top-1 border-l-2 border-border/30 pl-5 duration-150">
          <ToolResultRenderer
            toolName={block.name}
            input={block.input ?? {}}
            result={toolResult.result}
            isError={toolResult.isError === true}
          />
        </div>
      ) : null}
    </div>
  );
}

export function SDKContentBlockRenderer({
  block,
  allMessages,
  dimmed = false,
  childBlocks,
  animate = false,
  index = 0,
  isStreaming = false,
}: {
  block: SDKContentBlock;
  allMessages: SDKMessage[];
  dimmed?: boolean;
  childBlocks?: SDKContentBlock[];
  animate?: boolean;
  index?: number;
  isStreaming?: boolean;
  }): React.ReactElement | null {
  if (block.type === "text") {
    return block.text ? <MessageResponse>{String(block.text)}</MessageResponse> : null;
  }

  if (block.type === "thinking") {
    return block.thinking ? <ThinkingBlock block={block as SDKThinkingBlock} dimmed={dimmed} /> : null;
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
        isStreaming={isStreaming}
      />
    );
  }

  return null;
}

export function getAssistantContentBlocks(messages: SDKAssistantMessage[]): SDKContentBlock[] {
  return messages.flatMap((message) => message.message?.content ?? []);
}
