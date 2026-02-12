"use client";

import { Bot, FileImage, FileText } from "lucide-react";
import { useSmoothStream } from "@lume/ui";
import type { AgentMessage } from "@lume/shared";
import { useAtomValue } from "jotai";
import {
  agentModelIdAtom,
  agentStreamingAtom,
  agentStreamingContentAtom,
  agentToolActivitiesAtom,
  currentAgentMessagesAtom,
  type ToolActivity,
  userProfileAtom
} from "@/atoms";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  Message,
  MessageContent,
  MessageHeader,
  MessageLoading,
  MessageResponse,
  StreamingIndicator,
  UserMessageContent,
} from "@/components/ai-elements";
import { formatMessageTime } from "@/components/chat/ChatMessageItem";
import { UserAvatar } from "@/components/chat/UserAvatar";
import { getModelLogo } from "@/lib/model-logo";
import { ToolActivityList } from "./ToolActivityItem";

function EmptyState(): React.ReactElement {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Bot size={24} className="text-muted-foreground/60" />
        </div>
        <p className="text-sm">在下方输入框开始使用 Agent</p>
      </div>
    </div>
  );
}

function AssistantLogo({ model }: { model?: string }): React.ReactElement {
  if (model) return <img src={getModelLogo(model)} alt={model} className="size-[35px] rounded-[25%] object-cover" />;
  return (
    <div className="size-[35px] rounded-[25%] bg-primary/10 flex items-center justify-center">
      <Bot size={18} className="text-primary" />
    </div>
  );
}

function extractToolActivities(events: AgentMessage["events"]): ToolActivity[] {
  if (!events) return [];

  const activities: ToolActivity[] = [];
  for (const event of events) {
    if (event.type === "tool_start") {
      const existingIdx = activities.findIndex((item) => item.toolUseId === event.toolUseId);
      if (existingIdx >= 0) {
        const current = activities[existingIdx]!;
        activities[existingIdx] = {
          ...current,
          input: event.input,
          intent: event.intent || current.intent,
          displayName: event.displayName || current.displayName,
          parentToolUseId: event.parentToolUseId || current.parentToolUseId,
          done: false,
        };
      } else {
        activities.push({
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          input: event.input,
          intent: event.intent,
          displayName: event.displayName,
          parentToolUseId: event.parentToolUseId,
          done: false,
        });
      }
    } else if (event.type === "tool_result") {
      const idx = activities.findIndex((item) => item.toolUseId === event.toolUseId);
      if (idx >= 0) {
        const current = activities[idx]!;
        activities[idx] = {
          ...current,
          result: event.result,
          isError: event.isError,
          done: true,
        };
      }
    } else if (event.type === "task_backgrounded") {
      const idx = activities.findIndex((item) => item.toolUseId === event.toolUseId);
      if (idx >= 0) {
        const current = activities[idx]!;
        activities[idx] = { ...current, isBackground: true, taskId: event.taskId };
      }
    } else if (event.type === "task_progress") {
      const idx = activities.findIndex((item) => item.toolUseId === event.toolUseId);
      if (idx >= 0) {
        const current = activities[idx]!;
        activities[idx] = { ...current, elapsedSeconds: event.elapsedSeconds };
      }
    } else if (event.type === "shell_backgrounded") {
      const idx = activities.findIndex((item) => item.toolUseId === event.toolUseId);
      if (idx >= 0) {
        const current = activities[idx]!;
        activities[idx] = { ...current, isBackground: true, shellId: event.shellId };
      }
    }
  }

  return activities;
}

interface AttachedFileRef {
  filename: string;
  path: string;
}

function parseAttachedFiles(content: string): { files: AttachedFileRef[]; text: string } {
  const regex = /<attached_files>\n?([\s\S]*?)\n?<\/attached_files>\n*/;
  const match = content.match(regex);
  if (!match) return { files: [], text: content };

  const files: AttachedFileRef[] = [];
  const block = match[1] ?? "";
  for (const line of block.split("\n")) {
    const lineMatch = line.match(/^-\s+(.+?):\s+(.+)$/);
    if (lineMatch && lineMatch.length >= 3) {
      const [, filename = "", path = ""] = lineMatch;
      files.push({ filename: filename.trim(), path: path.trim() });
    }
  }

  const text = content.replace(regex, "").trim();
  return { files, text };
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

function AgentMessageItem({ message }: { message: AgentMessage }): React.ReactElement | null {
  const userProfile = useAtomValue(userProfileAtom);

  if (message.role === "user") {
    const { files: attachedFiles, text: messageText } = parseAttachedFiles(message.content);

    return (
      <Message from="user">
        <div className="mb-2.5 flex items-start gap-2.5">
          <UserAvatar avatar={userProfile.avatar} size={35} />
          <div className="flex h-[35px] flex-col justify-between">
            <span className="text-sm font-semibold leading-none text-foreground/60">{userProfile.userName}</span>
            <span className="text-[10px] leading-none text-foreground/[0.38]">{formatMessageTime(message.createdAt)}</span>
          </div>
        </div>

        <MessageContent>
          {attachedFiles.length > 0 ? (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {attachedFiles.map((file) => (
                <AttachedFileChip key={file.path} file={file} />
              ))}
            </div>
          ) : null}
          {messageText ? <UserMessageContent>{messageText}</UserMessageContent> : null}
        </MessageContent>
      </Message>
    );
  }

  if (message.role === "assistant") {
    const toolActivities = extractToolActivities(message.events);
    return (
      <Message from="assistant">
        <MessageHeader
          model={message.model}
          time={formatMessageTime(message.createdAt)}
          logo={<AssistantLogo model={message.model} />}
        />

        <MessageContent>
          {toolActivities.length > 0 ? (
            <div className="mb-3">
              <ToolActivityList activities={toolActivities} />
            </div>
          ) : null}
          {message.content ? <MessageResponse>{message.content}</MessageResponse> : null}
        </MessageContent>
      </Message>
    );
  }

  return null;
}

export function AgentMessages(): React.ReactElement {
  const messages = useAtomValue(currentAgentMessagesAtom);
  const streaming = useAtomValue(agentStreamingAtom);
  const streamingContent = useAtomValue(agentStreamingContentAtom);
  const toolActivities = useAtomValue(agentToolActivitiesAtom);
  const agentModelId = useAtomValue(agentModelIdAtom);

  const { displayedContent: smoothContent } = useSmoothStream({
    content: streamingContent,
    isStreaming: streaming
  });

  return (
    <Conversation>
      <ConversationContent>
        {messages.length === 0 && !streaming ? (
          <EmptyState />
        ) : (
          <>
            {messages.map((message) => (
              <AgentMessageItem key={message.id} message={message} />
            ))}

            {(streaming || smoothContent || toolActivities.length > 0) ? (
              <Message from="assistant">
                <MessageHeader
                  model={agentModelId ?? undefined}
                  time={formatMessageTime(Date.now())}
                  logo={<AssistantLogo model={agentModelId ?? undefined} />}
                />
                <MessageContent>
                  {toolActivities.length > 0 ? (
                    <div className="mb-3">
                      <ToolActivityList activities={toolActivities} animate />
                    </div>
                  ) : null}

                  {smoothContent ? (
                    <>
                      <MessageResponse>{smoothContent}</MessageResponse>
                      {streaming ? <StreamingIndicator /> : null}
                    </>
                  ) : (
                    streaming && toolActivities.length === 0 ? <MessageLoading /> : null
                  )}
                </MessageContent>
              </Message>
            ) : null}
          </>
        )}
      </ConversationContent>

      <ConversationScrollButton />
    </Conversation>
  );
}
