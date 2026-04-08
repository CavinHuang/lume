import * as React from "react";
import { Bot, Loader2 } from "lucide-react";
import { useAtomValue } from "jotai";
import type { SDKMessage } from "@lume/agent-sdk";
import { userProfileAtom } from "@/atoms";
import {
  Message,
  MessageActions,
  MessageContent,
  MessageHeader,
  MessageResponse,
  UserMessageContent,
} from "@/components/ai-elements";
import { CopyButton } from "@/components/chat/CopyButton";
import { UserAvatar } from "@/components/chat/UserAvatar";
import { formatMessageTime } from "@/components/chat/ChatMessageItem";
import { getModelLogo } from "@/lib/model-logo";
import { SDKContentBlockRenderer, getAssistantContentBlocks } from "./SDKContentBlock";

type SDKAssistantMessage = Extract<SDKMessage, { type: "assistant" }>;
type SDKUserMessage = Extract<SDKMessage, { type: "user" }>;
type SDKSystemMessage = Extract<SDKMessage, { type: "system" }>;
type SDKContentBlock = Parameters<typeof SDKContentBlockRenderer>[0]["block"];
interface RenderUsage {
  inputTokens: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  contextWindow?: number;
}

export interface AssistantTurn {
  type: "assistant-turn";
  assistantMessages: SDKAssistantMessage[];
  turnMessages: SDKMessage[];
  model?: string;
  createdAt?: number;
}

export type MessageGroup =
  | { type: "user"; message: SDKUserMessage }
  | { type: "system"; message: SDKSystemMessage }
  | AssistantTurn;

function extractMeta(message: SDKMessage): { createdAt?: number } {
  const raw = message as unknown as Record<string, unknown>;
  return {
    createdAt: typeof raw._createdAt === "number" ? raw._createdAt : undefined,
  };
}

function extractUserText(message: SDKUserMessage): string | null {
  const content = message.message?.content;
  if (!Array.isArray(content)) return null;
  const texts = content
    .filter((block) => !!block && typeof block === "object" && "type" in block && (block as { type?: string }).type === "text")
    .map((block) => (block as { text?: string }).text ?? "")
    .filter((text) => text.length > 0);
  return texts.length > 0 ? texts.join("\n") : null;
}

function isUserInputMessage(message: SDKUserMessage): boolean {
  if (message.parent_tool_use_id) return false;
  const content = message.message?.content;
  if (Array.isArray(content) && content.some((block) => block.type === "tool_result")) return false;
  return extractUserText(message) !== null;
}

export function groupIntoTurns(messages: SDKMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let currentTurn: AssistantTurn | null = null;

  const flushTurn = () => {
    if (currentTurn && currentTurn.assistantMessages.length > 0) {
      groups.push(currentTurn);
    }
    currentTurn = null;
  };

  for (const msg of messages) {
    if (msg.type === "user") {
      const userMsg = msg as SDKUserMessage;
      if (isUserInputMessage(userMsg)) {
        flushTurn();
        groups.push({ type: "user", message: userMsg });
      } else if (currentTurn) {
        currentTurn.turnMessages.push(msg);
      }
      continue;
    }
    if (msg.type === "assistant") {
      const assistantMsg = msg as SDKAssistantMessage;
      if ((assistantMsg as { isReplay?: boolean }).isReplay) continue;
      if (!currentTurn) {
        const meta = extractMeta(msg);
        currentTurn = {
          type: "assistant-turn",
          assistantMessages: [assistantMsg],
          turnMessages: [msg],
          model: undefined,
          createdAt: meta.createdAt,
        };
      } else {
        currentTurn.assistantMessages.push(assistantMsg);
        currentTurn.turnMessages.push(msg);
      }
      continue;
    }
    if (msg.type === "system") {
      const systemMsg = msg as SDKSystemMessage;
      if (systemMsg.subtype === "compact_boundary") {
        flushTurn();
        groups.push({ type: "system", message: systemMsg });
      } else if (currentTurn) {
        currentTurn.turnMessages.push(msg);
      }
      continue;
    }
    if (currentTurn) {
      currentTurn.turnMessages.push(msg);
    }
  }

  flushTurn();
  return groups;
}

function AssistantLogo({ model }: { model?: string }): React.ReactElement {
  if (model) {
    return <img src={getModelLogo(model)} alt={model} className="size-[35px] rounded-[25%] object-cover" />;
  }
  return (
    <div className="flex size-[35px] items-center justify-center rounded-[25%] bg-primary/10">
      <Bot size={18} className="text-primary" />
    </div>
  );
}

function extractTurnUsage(turnMessages: SDKMessage[]): { durationMs?: number; usage?: RenderUsage } {
  for (const msg of turnMessages) {
    if (msg.type !== "result") continue;
    const resultMsg = msg as SDKMessage & {
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
      total_cost_usd?: number;
      modelUsage?: Record<string, { contextWindow?: number }>;
      duration_ms?: number;
    };
    const usage = resultMsg.usage;
    return {
      durationMs: typeof resultMsg.duration_ms === "number" ? resultMsg.duration_ms : undefined,
      usage: usage ? {
        inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_input_tokens,
        cacheCreationTokens: usage.cache_creation_input_tokens,
        costUsd: resultMsg.total_cost_usd,
        contextWindow: resultMsg.modelUsage ? Object.values(resultMsg.modelUsage)[0]?.contextWindow : undefined,
      } : undefined,
    };
  }
  return {};
}

function AssistantTurnRenderer({ turn, allMessages, isStreaming = false }: { turn: AssistantTurn; allMessages: SDKMessage[]; isStreaming?: boolean }) {
  const blocks = getAssistantContentBlocks(turn.assistantMessages);
  const hasText = blocks.some((block) => block.type === "text");
  const { durationMs } = extractTurnUsage(turn.turnMessages);
  return (
    <Message from="assistant">
      <MessageHeader
        model={turn.model}
        time={turn.createdAt ? formatMessageTime(turn.createdAt) : ""}
        logo={<AssistantLogo model={turn.model} />}
      />
      <MessageContent>
        <div className="space-y-2">
          {blocks.map((block, index) => {
            const childBlocks = block.type === "tool_use"
              ? blocks.filter((candidate) => "parentToolUseId" in candidate && (candidate as { parentToolUseId?: string }).parentToolUseId === (block as { id: string }).id)
              : undefined;
            return (
              <SDKContentBlockRenderer
                key={`${turn.createdAt ?? "turn"}-${index}`}
                block={block as SDKContentBlock}
                allMessages={allMessages}
                childBlocks={childBlocks}
                dimmed={hasText && block.type !== "text"}
              />
            );
          })}
        </div>
      </MessageContent>
      {!isStreaming ? (
        <MessageActions className="mt-0.5 pl-[46px]">
          {blocks.some((block) => block.type === "text") ? (
            <CopyButton content={blocks.filter((block): block is { type: "text"; text: string } => block.type === "text").map((block) => block.text).join("\n\n")} />
          ) : null}
          {durationMs ? <span className="text-[11px] text-muted-foreground">{Math.round(durationMs)} ms</span> : null}
        </MessageActions>
      ) : null}
    </Message>
  );
}

function UserInputMessage({ message }: { message: SDKUserMessage }) {
  const userProfile = useAtomValue(userProfileAtom);
  const text = extractUserText(message) ?? "";
  const createdAt = extractMeta(message).createdAt;
  return (
    <Message from="user">
      <div className="mb-2.5 flex items-start gap-2.5">
        <UserAvatar avatar={userProfile.avatar} size={35} />
        <div className="flex h-[35px] flex-col justify-between">
          <span className="text-sm font-semibold leading-none text-foreground/60">{userProfile.userName}</span>
          <span className="text-[10px] leading-none text-foreground/[0.38]">{createdAt ? formatMessageTime(createdAt) : ""}</span>
        </div>
      </div>
      <MessageContent>
        <UserMessageContent>{text}</UserMessageContent>
      </MessageContent>
    </Message>
  );
}

export function MessageGroupRenderer({ group, allMessages, isStreaming = false }: { group: MessageGroup; allMessages: SDKMessage[]; isStreaming?: boolean }) {
  if (group.type === "user") {
    return <UserInputMessage message={group.message} />;
  }
  if (group.type === "system") {
    if (group.message.subtype === "compact_boundary") {
      return (
        <div className="my-4 flex items-center gap-3 px-1">
          <div className="h-px flex-1 bg-border/40" />
          <span className="shrink-0 rounded-full border border-border/30 bg-muted/20 px-2 py-0.5 text-[11px] text-muted-foreground/60">
            上下文已压缩
          </span>
          <div className="h-px flex-1 bg-border/40" />
        </div>
      );
    }
    return null;
  }
  return <AssistantTurnRenderer turn={group} allMessages={allMessages} isStreaming={isStreaming} />;
}
