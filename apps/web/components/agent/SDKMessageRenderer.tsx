import * as React from "react";
import { AlertTriangle, Bot, FileImage, FileText, Loader2 } from "lucide-react";
import { useAtomValue } from "jotai";
import type { SDKMessage } from "@lume/shared";
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
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatMessageTime } from "@/components/chat/ChatMessageItem";
import { getModelLogo } from "@/lib/model-logo";
import { cn } from "@/lib/utils";
import { SDKContentBlockRenderer, getAssistantContentBlocks, type SDKContentBlock } from "./SDKContentBlock";

type SDKAssistantMessage = Extract<SDKMessage, { type: "assistant" }>;
type SDKUserMessage = Extract<SDKMessage, { type: "user" }>;
type SDKSystemMessage = Extract<SDKMessage, { type: "system" }>;
type SDKResultMessage = Extract<SDKMessage, { type: "result" }>;
type AssistantTextBlock = Extract<SDKContentBlock, { type: "text" }>;

function getSystemSubtype(message: SDKSystemMessage): string | undefined {
  const record = message as SDKSystemMessage & { subtype?: unknown };
  return typeof record.subtype === "string" ? record.subtype : undefined;
}

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

interface AttachedFileRef {
  filename: string;
  path: string;
}

const groupIdCache = new WeakMap<MessageGroup, string>();
let fallbackGroupIdCounter = 0;

function CompactBoundaryDivider(): React.ReactElement {
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

function CompactingIndicator(): React.ReactElement {
  return (
    <div className="my-2 flex items-center gap-2 px-1 text-[12px] text-muted-foreground/70">
      <Loader2 className="size-3 animate-spin" />
      <span>正在压缩上下文...</span>
    </div>
  );
}

function extractMeta(message: SDKMessage): { createdAt?: number } {
  const record = message as SDKMessage & { _createdAt?: unknown };
  return {
    createdAt: typeof record._createdAt === "number" ? record._createdAt : undefined,
  };
}

function extractAssistantModel(message: SDKAssistantMessage): string | undefined {
  const raw = message.message as { model?: unknown };
  return typeof raw.model === "string" && raw.model.trim().length > 0 ? raw.model : undefined;
}

function extractTurnUsage(turnMessages: SDKMessage[]): { durationMs?: number; usage?: RenderUsage } {
  for (const message of turnMessages) {
    if (message.type !== "result") continue;
    const resultMessage = message as SDKResultMessage & { _durationMs?: unknown };
    const durationMs = typeof resultMessage._durationMs === "number"
      ? resultMessage._durationMs
      : typeof resultMessage.duration_ms === "number"
        ? resultMessage.duration_ms
        : undefined;
    const usage = resultMessage.usage;
    if (!usage) return { durationMs };
    return {
      durationMs,
      usage: {
        inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_input_tokens,
        cacheCreationTokens: usage.cache_creation_input_tokens,
        costUsd: resultMessage.total_cost_usd,
        contextWindow: resultMessage.modelUsage ? Object.values(resultMessage.modelUsage)[0]?.contextWindow : undefined,
      },
    };
  }
  return {};
}

function extractUserText(message: SDKUserMessage): string | null {
  const content = message.message?.content;
  if (!Array.isArray(content)) return null;

  const texts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && "text" in block) {
      texts.push((block as { text: string }).text);
    }
  }

  return texts.length > 0 ? texts.join("\n") : null;
}

function isUserInputMessage(message: SDKUserMessage): boolean {
  if (message.parent_tool_use_id) return false;
  const content = message.message?.content;
  if (Array.isArray(content) && content.some((block) => block.type === "tool_result")) return false;
  return extractUserText(message) !== null;
}

function parseAttachedFiles(content: string): { files: AttachedFileRef[]; text: string } {
  const regex = /<attached_files>\n?([\s\S]*?)\n?<\/attached_files>\n*/;
  const match = content.match(regex);
  if (!match) return { files: [], text: content };

  const files: AttachedFileRef[] = [];
  for (const line of match[1]!.split("\n")) {
    const lineMatch = line.match(/^-\s+(.+?):\s+(.+)$/);
    if (lineMatch) {
      files.push({
        filename: lineMatch[1]!.trim(),
        path: lineMatch[2]!.trim(),
      });
    }
  }

  return {
    files,
    text: content.replace(regex, "").trim(),
  };
}

function isImageFile(filename: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(filename);
}

function AttachedFileChip({ file }: { file: AttachedFileRef }): React.ReactElement {
  const Icon = isImageFile(file.filename) ? FileImage : FileText;
  return (
    <div className="inline-flex items-center gap-1.5 rounded-md bg-muted/60 px-2.5 py-1 text-[12px] text-muted-foreground">
      <Icon className="size-3.5 shrink-0" />
      <span className="max-w-[200px] truncate">{file.filename}</span>
    </div>
  );
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = seconds % 60;
  return `${minutes}m ${remainSeconds.toFixed(0)}s`;
}

function buildUsageTooltip(durationMs: number, usage?: RenderUsage): string {
  const lines: string[] = [`耗时: ${formatDuration(durationMs)}`];
  if (usage) {
    const pureInput = usage.inputTokens - (usage.cacheReadTokens ?? 0) - (usage.cacheCreationTokens ?? 0);
    if (pureInput > 0) lines.push(`输入: ${pureInput.toLocaleString()}`);
    if (usage.outputTokens) lines.push(`输出: ${usage.outputTokens.toLocaleString()}`);
    if (usage.cacheCreationTokens) lines.push(`缓存写入: ${usage.cacheCreationTokens.toLocaleString()}`);
    if (usage.cacheReadTokens) lines.push(`缓存读取: ${usage.cacheReadTokens.toLocaleString()}`);
  }
  return lines.join("\n");
}

export function DurationBadge({
  durationMs,
  usage,
}: {
  durationMs: number;
  usage?: RenderUsage;
}): React.ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-default text-[15px] font-light tabular-nums">
          {formatDuration(durationMs)}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p className="whitespace-pre-line text-left">{buildUsageTooltip(durationMs, usage)}</p>
      </TooltipContent>
    </Tooltip>
  );
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

function ErrorMessage({ message }: { message: SDKAssistantMessage }): React.ReactElement {
  const meta = extractMeta(message as SDKMessage);
  const contentText = message.message?.content
    ?.filter((block) => block.type === "text" && "text" in block)
    .map((block) => (block as { text: string }).text)
    .join("\n")
    || "未知错误";

  return (
    <Message from="assistant">
      <MessageHeader
        time={meta.createdAt ? formatMessageTime(meta.createdAt) : undefined}
        logo={(
          <div className="flex size-[35px] items-center justify-center rounded-[25%] bg-destructive/10">
            <AlertTriangle size={18} className="text-destructive" />
          </div>
        )}
      />
      <MessageContent>
        <div className="text-destructive">
          <MessageResponse>{contentText}</MessageResponse>
        </div>
      </MessageContent>
      <MessageActions className="mt-0.5 pl-[46px]">
        <CopyButton content={contentText} />
      </MessageActions>
    </Message>
  );
}

function UserInputMessage({ message }: { message: SDKUserMessage }): React.ReactElement {
  const userProfile = useAtomValue(userProfileAtom);
  const rawText = extractUserText(message) ?? "";
  const { files, text } = parseAttachedFiles(rawText);
  const meta = extractMeta(message as SDKMessage);

  return (
    <Message from="user">
      <div className="mb-2.5 flex items-start gap-2.5">
        <UserAvatar avatar={userProfile.avatar} size={35} />
        <div className="flex h-[35px] flex-col justify-between">
          <span className="text-sm font-semibold leading-none text-foreground/60">{userProfile.userName}</span>
          {meta.createdAt ? (
            <span className="text-[10px] leading-none text-foreground/[0.38]">{formatMessageTime(meta.createdAt)}</span>
          ) : null}
        </div>
      </div>
      <MessageContent>
        {files.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {files.map((file) => (
              <AttachedFileChip key={`${file.path}-${file.filename}`} file={file} />
            ))}
          </div>
        ) : null}
        {text ? <UserMessageContent>{text}</UserMessageContent> : null}
      </MessageContent>
      {text ? (
        <MessageActions className="mt-0.5 pl-[46px]">
          <CopyButton content={text} />
        </MessageActions>
      ) : null}
    </Message>
  );
}

function mergeAdjacentSameModelTurns(groups: MessageGroup[]): MessageGroup[] {
  if (groups.length <= 1) return groups;

  const merged: MessageGroup[] = [];
  for (const group of groups) {
    if (group.type !== "assistant-turn") {
      merged.push(group);
      continue;
    }

    let mergeTargetIndex = -1;
    for (let index = merged.length - 1; index >= 0; index -= 1) {
      const previous = merged[index]!;
      if (previous.type === "user") break;
      if (previous.type === "assistant-turn") {
        if (previous.model === group.model) mergeTargetIndex = index;
        break;
      }
    }

    if (mergeTargetIndex >= 0) {
      const target = merged[mergeTargetIndex] as AssistantTurn;
      target.assistantMessages.push(...group.assistantMessages);
      target.turnMessages.push(...group.turnMessages);
    } else {
      merged.push(group);
    }
  }

  return merged;
}

export function groupIntoTurns(messages: SDKMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let currentTurn: AssistantTurn | null = null;

  const flushTurn = (): void => {
    if (currentTurn && currentTurn.assistantMessages.length > 0) {
      groups.push(currentTurn);
    }
    currentTurn = null;
  };

  for (const message of messages) {
    if (message.type === "user") {
      const userMessage = message as SDKUserMessage;
      if (isUserInputMessage(userMessage)) {
        flushTurn();
        groups.push({ type: "user", message: userMessage });
      } else if (currentTurn) {
        currentTurn.turnMessages.push(message);
      }
      continue;
    }

    if (message.type === "assistant") {
      const assistantMessage = message as SDKAssistantMessage & { isReplay?: boolean };
      if (assistantMessage.isReplay) continue;

      if (!currentTurn) {
        const meta = extractMeta(message);
        currentTurn = {
          type: "assistant-turn",
          assistantMessages: [assistantMessage],
          turnMessages: [message],
          model: extractAssistantModel(assistantMessage),
          createdAt: meta.createdAt,
        };
      } else {
        currentTurn.assistantMessages.push(assistantMessage);
        currentTurn.turnMessages.push(message);
      }
      continue;
    }

    if (message.type === "system") {
      const systemMessage = message as SDKSystemMessage;
      const subtype = getSystemSubtype(systemMessage);
      if (subtype === "compact_boundary" || subtype === "compacting") {
        flushTurn();
        groups.push({ type: "system", message: systemMessage });
      } else if (currentTurn) {
        currentTurn.turnMessages.push(message);
      }
      continue;
    }

    if (currentTurn) {
      currentTurn.turnMessages.push(message);
    }
  }

  flushTurn();
  return mergeAdjacentSameModelTurns(groups);
}

export function getGroupId(group: MessageGroup): string {
  if (group.type === "user") {
    if (group.message.uuid) return group.message.uuid;
    if (!groupIdCache.has(group)) {
      groupIdCache.set(group, `user-${++fallbackGroupIdCounter}`);
    }
    return groupIdCache.get(group)!;
  }

  if (group.type === "system") {
    return `system-${group.message.subtype ?? "unknown"}`;
  }

  const firstAssistant = group.assistantMessages[0];
  if (firstAssistant?.uuid) return firstAssistant.uuid;
  if (!groupIdCache.has(group)) {
    groupIdCache.set(group, `turn-${++fallbackGroupIdCounter}`);
  }
  return groupIdCache.get(group)!;
}

export function getGroupPreview(group: MessageGroup): string {
  if (group.type === "user") {
    return (extractUserText(group.message) ?? "")
      .replace(/<attached_files>[\s\S]*?<\/attached_files>\n*/, "")
      .slice(0, 200);
  }

  if (group.type === "system") {
    const subtype = getSystemSubtype(group.message);
    if (subtype === "compact_boundary") return "上下文已压缩";
    if (subtype === "compacting") return "正在压缩上下文...";
    return "";
  }

  const texts: string[] = [];
  for (const message of group.assistantMessages) {
    const blocks = message.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block.type === "text" && "text" in block) {
        texts.push((block as { text: string }).text);
      }
    }
  }
  return texts.join(" ").slice(0, 200);
}

function AssistantTurnRenderer({
  turn,
  allMessages,
  isStreaming = false,
  stoppedByUser,
}: {
  turn: AssistantTurn;
  allMessages: SDKMessage[];
  isStreaming?: boolean;
  stoppedByUser?: boolean;
}): React.ReactElement | null {
  interface EnrichedBlock {
    block: SDKContentBlock;
    parentToolUseId?: string | null;
  }

  const enrichedBlocks: EnrichedBlock[] = [];
  let hasError = false;
  let errorMessage: SDKAssistantMessage | null = null;

  for (const assistantMessage of turn.assistantMessages) {
    if (assistantMessage.error) {
      hasError = true;
      errorMessage = assistantMessage;
      continue;
    }

    const blocks = assistantMessage.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      enrichedBlocks.push({ block, parentToolUseId: assistantMessage.parent_tool_use_id });
    }
  }

  if (enrichedBlocks.length === 0 && hasError && errorMessage) {
    return <ErrorMessage message={errorMessage} />;
  }

  if (enrichedBlocks.length === 0) return null;

  const { durationMs, usage } = extractTurnUsage(turn.turnMessages);
  const agentToolIds = new Set<string>();
  for (const item of enrichedBlocks) {
    if (item.block.type === "tool_use") {
      const toolBlock = item.block as { id: string; name: string };
      if (toolBlock.name === "Agent" || toolBlock.name === "Task") {
        agentToolIds.add(toolBlock.id);
      }
    }
  }

  const childBlocksMap = new Map<string, SDKContentBlock[]>();
  const topLevelBlocks: SDKContentBlock[] = [];
  for (const item of enrichedBlocks) {
    if (item.parentToolUseId && agentToolIds.has(item.parentToolUseId)) {
      const children = childBlocksMap.get(item.parentToolUseId) ?? [];
      children.push(item.block);
      childBlocksMap.set(item.parentToolUseId, children);
    } else {
      topLevelBlocks.push(item.block);
    }
  }

  const hasTextContent = topLevelBlocks.some((block) => block.type === "text" && "text" in block && !!(block as { text?: string }).text);
  const textContent = topLevelBlocks
    .filter((block): block is AssistantTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");

  return (
    <Message from="assistant">
      <MessageHeader
        model={turn.model}
        time={turn.createdAt ? formatMessageTime(turn.createdAt) : undefined}
        logo={<AssistantLogo model={turn.model} />}
      />
      <MessageContent>
        <div className="space-y-2">
          {topLevelBlocks.map((block, index) => {
            const isAgentTool = block.type === "tool_use"
              && ((((block as { name?: string }).name) === "Agent") || (((block as { name?: string }).name) === "Task"));
            const childBlocks = isAgentTool ? childBlocksMap.get((block as { id: string }).id) : undefined;

            return (
              <SDKContentBlockRenderer
                key={`${turn.createdAt ?? "turn"}-${index}`}
                block={block}
                allMessages={allMessages}
                childBlocks={childBlocks}
                dimmed={hasTextContent && block.type !== "text"}
                animate
                index={index}
                isStreaming={isStreaming}
              />
            );
          })}
        </div>
        {hasError && errorMessage && topLevelBlocks.length > 0 ? (
          <div className="mt-3 text-sm text-destructive">执行过程出现错误</div>
        ) : null}
      </MessageContent>
      {!isStreaming && (durationMs != null || textContent || stoppedByUser) ? (
        <MessageActions className="mt-0.5 min-h-[28px] justify-start pl-[46px] animate-in fade-in duration-200">
          {durationMs != null ? <DurationBadge durationMs={durationMs} usage={usage} /> : null}
          {textContent ? <CopyButton content={textContent} /> : null}
          {stoppedByUser ? (
            <Badge variant="outline" className="shrink-0 border-muted-foreground/30 text-xs text-muted-foreground/70">
              已被用户中断
            </Badge>
          ) : null}
        </MessageActions>
      ) : null}
    </Message>
  );
}

export function MessageGroupRenderer({
  group,
  allMessages,
  isStreaming = false,
  stoppedByUser,
}: {
  group: MessageGroup;
  allMessages: SDKMessage[];
  isStreaming?: boolean;
  stoppedByUser?: boolean;
}): React.ReactElement | null {
  const groupId = getGroupId(group);

  if (group.type === "user") {
    return (
      <div data-message-id={groupId}>
        <UserInputMessage message={group.message} />
      </div>
    );
  }

  if (group.type === "system") {
    const subtype = getSystemSubtype(group.message);
    if (subtype === "compact_boundary") {
      return (
        <div data-message-id={groupId}>
          <CompactBoundaryDivider />
        </div>
      );
    }
    if (subtype === "compacting") {
      return (
        <div data-message-id={groupId}>
          <CompactingIndicator />
        </div>
      );
    }
    return null;
  }

  return (
    <div data-message-id={groupId}>
      <AssistantTurnRenderer
        turn={group}
        allMessages={allMessages}
        isStreaming={isStreaming}
        stoppedByUser={stoppedByUser}
      />
    </div>
  );
}

export function SDKMessageRenderer({
  message,
  allMessages,
  showHeader = true,
}: {
  message: SDKMessage;
  allMessages: SDKMessage[];
  showHeader?: boolean;
}): React.ReactElement | null {
  if (message.type === "assistant") {
    const assistantMessage = message as SDKAssistantMessage & { isReplay?: boolean };
    if (assistantMessage.isReplay) return null;
    if (assistantMessage.error) return <ErrorMessage message={assistantMessage} />;
    const blocks = assistantMessage.message?.content;
    if (!Array.isArray(blocks) || blocks.length === 0) return null;

    const model = extractAssistantModel(assistantMessage);
    const meta = extractMeta(message);
    const hasTextContent = blocks.some((block) => block.type === "text" && "text" in block && !!(block as { text?: string }).text);

    return (
      <Message from="assistant">
        {showHeader ? (
          <MessageHeader
            model={model}
            time={meta.createdAt ? formatMessageTime(meta.createdAt) : undefined}
            logo={<AssistantLogo model={model} />}
          />
        ) : null}
        <MessageContent>
          <div className="space-y-2">
            {blocks.map((block, index) => (
              <SDKContentBlockRenderer
                key={`${assistantMessage.uuid ?? "assistant"}-${index}`}
                block={block as SDKContentBlock}
                allMessages={allMessages}
                animate
                index={index}
                dimmed={hasTextContent && block.type !== "text"}
                isStreaming
              />
            ))}
          </div>
        </MessageContent>
      </Message>
    );
  }

  if (message.type === "user") {
    const userMessage = message as SDKUserMessage;
    return isUserInputMessage(userMessage) ? <UserInputMessage message={userMessage} /> : null;
  }

  if (message.type === "system") {
    const systemMessage = message as SDKSystemMessage;
    const subtype = getSystemSubtype(systemMessage);
    if (subtype === "compact_boundary") return <CompactBoundaryDivider />;
    if (subtype === "compacting") return <CompactingIndicator />;
  }

  return null;
}
