"use client";

import * as React from "react";
import { useSmoothStream } from "@lume/ui";
import type { AgentMessage } from "@lume/shared";
import { useAtomValue } from "jotai";
import { Bot, CalendarClock, FileImage, FileText, Pencil, RotateCcw, Trash2 } from "lucide-react";
import {
  agentModelIdAtom,
  agentStreamingAtom,
  agentStreamingContentAtom,
  agentStreamingTimelineEventsAtom,
  currentAgentMessagesAtom,
  extractTimelineEvents,
  type ToolActivity,
  userProfileAtom
} from "@/atoms";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageHeader,
  MessageLoading,
  MessageResponse,
  StreamingIndicator,
  UserMessageContent,
} from "@/components/ai-elements";
import { formatMessageTime } from "@/components/chat/ChatMessageItem";
import { CopyButton } from "@/components/chat/CopyButton";
import { DeleteMessageDialog } from "@/components/chat/DeleteMessageDialog";
import { UserAvatar } from "@/components/chat/UserAvatar";
import { getModelLogo } from "@/lib/model-logo";
import { EventTimeline } from "./EventTimeline";

export interface AgentInlineEditSubmitPayload {
  content: string;
}

interface AgentMessagesProps {
  isStreaming?: boolean;
  isSwitching?: boolean;
  inlineEditingMessageId?: string | null;
  onDeleteMessage?: (message: AgentMessage) => Promise<void>;
  onResendMessage?: (message: AgentMessage) => Promise<void>;
  onSaveAsTask?: (message: AgentMessage) => Promise<void>;
  onStartInlineEdit?: (message: AgentMessage) => void;
  onSubmitInlineEdit?: (message: AgentMessage, payload: AgentInlineEditSubmitPayload) => Promise<void>;
  onCancelInlineEdit?: () => void;
}

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

function splitAttachedFiles(content: string): { block: string | null; files: AttachedFileRef[]; text: string } {
  const regex = /<attached_files>\n?([\s\S]*?)\n?<\/attached_files>\n*/;
  const match = content.match(regex);
  if (!match) return { block: null, files: [], text: content };

  const files: AttachedFileRef[] = [];
  const blockBody = match[1] ?? "";
  for (const line of blockBody.split("\n")) {
    const lineMatch = line.match(/^-\s+(.+?):\s+(.+)$/);
    if (lineMatch && lineMatch.length >= 3) {
      const [, filename = "", path = ""] = lineMatch;
      files.push({ filename: filename.trim(), path: path.trim() });
    }
  }

  const block = `<attached_files>\n${blockBody}\n</attached_files>`;
  const text = content.replace(regex, "").trim();
  return { block, files, text };
}

function stripPlanExecutionMarker(content: string): string {
  return content.replace(/\n?<lume_plan_execution key=\"[^\"]+\" \/>/g, "").trim();
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

function InlineEditForm({
  initialValue,
  onSubmit,
  onCancel
}: {
  initialValue: string;
  onSubmit: (payload: AgentInlineEditSubmitPayload) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [value, setValue] = React.useState(initialValue);

  return (
    <div className="space-y-2">
      <textarea
        value={value}
        onChange={(event) => setValue(event.target.value)}
        className="min-h-[84px] w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
        placeholder="编辑消息..."
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onSubmit({ content: value })}
          className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        >
          保存并重发
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex h-8 items-center rounded-md border border-border px-3 text-xs text-muted-foreground hover:bg-muted"
        >
          取消
        </button>
      </div>
    </div>
  );
}

const AgentMessageItem = React.memo(function AgentMessageItem({
  message,
  isStreaming,
  isInlineEditing,
  onDeleteMessage,
  onResendMessage,
  onSaveAsTask,
  onStartInlineEdit,
  onSubmitInlineEdit,
  onCancelInlineEdit
}: {
  message: AgentMessage;
  isStreaming: boolean;
  isInlineEditing: boolean;
  onDeleteMessage?: (message: AgentMessage) => Promise<void>;
  onResendMessage?: (message: AgentMessage) => Promise<void>;
  onSaveAsTask?: (message: AgentMessage) => Promise<void>;
  onStartInlineEdit?: (message: AgentMessage) => void;
  onSubmitInlineEdit?: (message: AgentMessage, payload: AgentInlineEditSubmitPayload) => Promise<void>;
  onCancelInlineEdit?: () => void;
}): React.ReactElement | null {
  const [deleteDialogOpen, setDeleteDialogOpen] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const userProfile = useAtomValue(userProfileAtom);

  const timelineEvents = React.useMemo(
    () => message.role === "assistant" ? extractTimelineEvents(message) : [],
    [message]
  );
  const toolActivities = React.useMemo(
    () => message.role === "assistant" ? extractToolActivities(message.events) : [],
    [message]
  );

  if (message.role === "user") {
    const sanitizedContent = stripPlanExecutionMarker(message.content);
    const { files: attachedFiles, text: messageText } = splitAttachedFiles(sanitizedContent);

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
          {isInlineEditing ? (
            <InlineEditForm
              initialValue={messageText}
              onSubmit={(payload) => {
                if (!onSubmitInlineEdit) return;
                void onSubmitInlineEdit(message, payload);
              }}
              onCancel={() => onCancelInlineEdit?.()}
            />
          ) : messageText ? (
            <UserMessageContent>{messageText}</UserMessageContent>
          ) : null}
        </MessageContent>

        {!isInlineEditing && !isStreaming ? (
          <MessageActions className="mt-0.5 pl-[46px]">
            <CopyButton content={messageText || message.content} />
            {onResendMessage ? (
              <MessageAction tooltip="重新发送" onClick={() => void onResendMessage(message)}>
                <RotateCcw className="size-3.5" />
              </MessageAction>
            ) : null}
            {onStartInlineEdit ? (
              <MessageAction tooltip="编辑后重发" onClick={() => onStartInlineEdit(message)}>
                <Pencil className="size-3.5" />
              </MessageAction>
            ) : null}
            {onDeleteMessage ? (
              <MessageAction tooltip="删除" onClick={() => setDeleteDialogOpen(true)}>
                <Trash2 className="size-3.5" />
              </MessageAction>
            ) : null}
          </MessageActions>
        ) : null}

        <DeleteMessageDialog
          open={deleteDialogOpen}
          onOpenChange={setDeleteDialogOpen}
          onConfirm={() => {
            if (!onDeleteMessage) return;
            setIsDeleting(true);
            void onDeleteMessage(message).finally(() => {
              setIsDeleting(false);
              setDeleteDialogOpen(false);
            });
          }}
          isDeleting={isDeleting}
        />
      </Message>
    );
  }

  if (message.role === "assistant") {
    return (
      <Message from="assistant">
        <MessageHeader
          model={message.model}
          time={formatMessageTime(message.createdAt)}
          logo={<AssistantLogo model={message.model} />}
        />

        <MessageContent>
          {timelineEvents.length > 0 ? (
            <div className="mb-3">
              <EventTimeline events={timelineEvents} />
            </div>
          ) : null}
          {message.content && timelineEvents.length === 0 && toolActivities.length === 0 ? (
            <MessageResponse>{message.content}</MessageResponse>
          ) : null}
        </MessageContent>
        {!isStreaming && (message.content ?? "").trim().length > 0 ? (
          <MessageActions className="mt-0.5 pl-[46px]">
            <CopyButton content={message.content} />
            {onSaveAsTask ? (
              <MessageAction tooltip="保存为任务" onClick={() => void onSaveAsTask(message)}>
                <CalendarClock className="size-3.5" />
              </MessageAction>
            ) : null}
          </MessageActions>
        ) : null}
      </Message>
    );
  }

  return null;
})

export function AgentMessages({
  isStreaming = false,
  isSwitching = false,
  inlineEditingMessageId = null,
  onDeleteMessage,
  onResendMessage,
  onSaveAsTask,
  onStartInlineEdit,
  onSubmitInlineEdit,
  onCancelInlineEdit
}: AgentMessagesProps): React.ReactElement {
  const messages = useAtomValue(currentAgentMessagesAtom);
  const streaming = useAtomValue(agentStreamingAtom);
  const streamingContent = useAtomValue(agentStreamingContentAtom);
  const streamingTimelineEvents = useAtomValue(agentStreamingTimelineEventsAtom);
  const agentModelId = useAtomValue(agentModelIdAtom);

  const { displayedContent: smoothContent } = useSmoothStream({
    content: streamingContent,
    isStreaming: streaming
  });

  const actionsDisabled = isStreaming || streaming;
  const shouldShowStreamingMessage =
    (streaming || Boolean(smoothContent));

  const stableOnDelete = actionsDisabled ? undefined : onDeleteMessage;
  const stableOnResend = actionsDisabled ? undefined : onResendMessage;
  const stableOnSaveAsTask = actionsDisabled ? undefined : onSaveAsTask;
  const stableOnStartInlineEdit = actionsDisabled ? undefined : onStartInlineEdit;

  return (
    <Conversation className={!streaming ? "cv-ready" : undefined}>
      <ConversationContent>
        {isSwitching ? (
          <div className="flex h-full items-center justify-center">
            <div className="flex flex-col items-center gap-3 text-muted-foreground">
              <div className="size-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
            </div>
          </div>
        ) : messages.length === 0 && !streaming ? (
          <EmptyState />
        ) : (
          <>
            {messages.map((message) => (
              <div key={message.id} data-message-id={message.id}>
                <AgentMessageItem
                  message={message}
                  isStreaming={actionsDisabled}
                  isInlineEditing={inlineEditingMessageId === message.id}
                  onDeleteMessage={stableOnDelete}
                  onResendMessage={stableOnResend}
                  onSaveAsTask={stableOnSaveAsTask}
                  onStartInlineEdit={stableOnStartInlineEdit}
                  onSubmitInlineEdit={onSubmitInlineEdit}
                  onCancelInlineEdit={onCancelInlineEdit}
                />
              </div>
            ))}
            {shouldShowStreamingMessage ? (
              <Message from="assistant">
                <MessageHeader
                  model={agentModelId ?? undefined}
                  time={formatMessageTime(Date.now())}
                  logo={<AssistantLogo model={agentModelId ?? undefined} />}
                />
                <MessageContent>
                  {streamingTimelineEvents.length > 0 ? (
                    <div className="mb-3">
                      <EventTimeline events={streamingTimelineEvents} isStreaming={streaming} />
                    </div>
                  ) : null}

                  {smoothContent && streamingTimelineEvents.length === 0 ? (
                    <>
                      <MessageResponse>{smoothContent}</MessageResponse>
                      {streaming ? <StreamingIndicator /> : null}
                    </>
                  ) : (
                    streaming && streamingTimelineEvents.length === 0
                      ? <MessageLoading />
                      : null
                  )}
                  {streaming && streamingTimelineEvents.length > 0 && !smoothContent ? <StreamingIndicator /> : null}
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
