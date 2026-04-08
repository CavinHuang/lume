import * as React from "react";
import {
  Brain,
  ChevronRight,
  Loader2,
  MessageSquareText,
  XCircle,
} from "lucide-react";
import type { SDKMessage } from "@lume/agent-sdk";
import { MessageResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import { getToolIcon } from "./tool-utils";
import { getToolActivePhrase, getToolDonePhrase } from "./tool-phrase";

type SDKTextBlock = { type: "text"; text: string };
type SDKThinkingBlock = { type: "thinking"; thinking: string };
type SDKToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
type SDKToolResultBlock = { type: "tool_result"; tool_use_id: string; content?: unknown; is_error?: boolean };
export type SDKContentBlock = SDKTextBlock | SDKThinkingBlock | SDKToolUseBlock | { type: string; [key: string]: unknown };
type SDKAssistantMessage = Extract<SDKMessage, { type: "assistant" }>;
type SDKUserMessage = Extract<SDKMessage, { type: "user" }>;

function useToolResult(toolUseId: string, allMessages: SDKMessage[]) {
  return React.useMemo(() => {
    for (const msg of allMessages) {
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

function PromptRow({ prompt, dimmed = false }: { prompt: string; dimmed?: boolean }) {
  const [expanded, setExpanded] = React.useState(false);
  const preview = prompt.length > 60 ? `${prompt.slice(0, 60)}...` : prompt;
  return (
    <div>
      <button
        type="button"
        className="flex items-center gap-2 py-0.5 text-left transition-opacity hover:opacity-70 group"
        onClick={() => setExpanded((value) => !value)}
      >
        <MessageSquareText className={cn("size-3.5 shrink-0", dimmed ? "text-muted-foreground/70" : "text-muted-foreground")} />
        <span className={cn("shrink-0 text-[14px]", dimmed ? "text-muted-foreground/70" : "text-muted-foreground")}>提示词</span>
        <span className={cn("truncate text-[14px]", dimmed ? "text-muted-foreground/50" : "text-muted-foreground/60")}>{preview}</span>
        <ChevronRight className={cn("shrink-0 size-3 text-muted-foreground/40 opacity-0 transition-all duration-150 group-hover:opacity-100", expanded && "rotate-90 opacity-100")} />
      </button>
      {expanded ? (
        <div className="ml-5.5 mt-1 mb-2 border-l-2 border-border/30 pl-3">
          <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground/70">{prompt}</p>
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
}: {
  block: SDKToolUseBlock;
  allMessages: SDKMessage[];
  childBlocks?: SDKContentBlock[];
  dimmed?: boolean;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const toolResult = useToolResult(block.id, allMessages);
  const ToolIcon = getToolIcon(block.name);
  const isCompleted = toolResult !== null;
  const isError = toolResult?.isError === true;
  const isAgentTool = block.name === "Agent" || block.name === "Task";
  const prompt = isAgentTool && typeof block.input.prompt === "string" ? block.input.prompt : undefined;
  const label = isCompleted ? getToolDonePhrase(block.name, block.input) : getToolActivePhrase(block.name, block.input);
  return (
    <div>
      <button
        type="button"
        className="flex items-center gap-2 py-0.5 text-left transition-opacity hover:opacity-70 group"
        onClick={() => setExpanded((value) => !value)}
      >
        {!isCompleted ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-primary/50" />
        ) : isError ? (
          <XCircle className="size-3.5 shrink-0 text-destructive/70" />
        ) : null}
        <ToolIcon className={cn("size-3.5 shrink-0", dimmed ? "text-muted-foreground/70" : "text-muted-foreground")} />
        <span className={cn("truncate text-[14px]", dimmed ? "text-muted-foreground/70" : "text-muted-foreground")}>{label}</span>
        <ChevronRight className={cn("shrink-0 size-3 text-muted-foreground/40 opacity-0 transition-all duration-150 group-hover:opacity-100", expanded && "rotate-90 opacity-100")} />
      </button>
      {expanded ? (
        <div className="ml-5.5 mt-1 mb-2 border-l-2 border-border/30 pl-3">
          {prompt ? <PromptRow prompt={prompt} dimmed={dimmed} /> : null}
          {toolResult?.result ? (
            <pre className="whitespace-pre-wrap break-words rounded-md bg-muted/30 p-2 text-[12px] leading-relaxed text-foreground/70">
              {toolResult.result}
            </pre>
          ) : null}
          {isAgentTool && childBlocks && childBlocks.length > 0 ? (
            <div className="mt-2 space-y-2 border-l-2 border-primary/20 pl-4">
              {childBlocks.map((childBlock, index) => (
                <SDKContentBlockRenderer
                  key={`${block.id}-child-${index}`}
                  block={childBlock}
                  allMessages={allMessages}
                  dimmed
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ThinkingBlock({ block, dimmed = false }: { block: SDKThinkingBlock; dimmed?: boolean }) {
  return (
    <div className="relative mb-3">
      <div className="mb-1.5 flex items-center gap-1.5">
        <Brain className={cn("size-3.5", dimmed ? "text-muted-foreground/70" : "text-muted-foreground")} />
        <span className={cn("text-[14px] uppercase tracking-wider", dimmed ? "text-muted-foreground/70" : "text-muted-foreground")}>
          Thinking
        </span>
      </div>
      <div className={cn("rounded-lg px-3.5 py-2.5", dimmed ? "bg-muted/30" : "bg-muted/50")}>
        <div className={cn("whitespace-pre-wrap text-[14px] leading-relaxed", dimmed ? "text-muted-foreground" : "text-foreground/90")}>
          {block.thinking}
        </div>
      </div>
    </div>
  );
}

export function SDKContentBlockRenderer({
  block,
  allMessages,
  dimmed = false,
  childBlocks,
}: {
  block: SDKContentBlock;
  allMessages: SDKMessage[];
  dimmed?: boolean;
  childBlocks?: SDKContentBlock[];
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
    return <ToolUseBlock block={block as SDKToolUseBlock} allMessages={allMessages} childBlocks={childBlocks} dimmed={dimmed} />;
  }
  return null;
}

export function getAssistantContentBlocks(messages: SDKAssistantMessage[]): SDKContentBlock[] {
  return messages.flatMap((message) => message.message?.content ?? []);
}
