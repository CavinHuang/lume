"use client";

import { useState } from "react";
import { useAtomValue } from "jotai";
import { Trash2 } from "lucide-react";
import type { ChatMessage } from "@lume/shared";
import { userProfileAtom } from "@/atoms";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageAttachments,
  MessageContent,
  MessageHeader,
  MessageResponse,
  StreamingIndicator,
  UserMessageContent,
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements";
import { getModelLogo } from "@/lib/model-logo";
import { CopyButton } from "./CopyButton";
import { DeleteMessageDialog } from "./DeleteMessageDialog";
import { UserAvatar } from "./UserAvatar";

export function formatMessageTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const time = `${hh}:${mm}`;
  if (date.getFullYear() === now.getFullYear()) return `${month}/${day} ${time}`;
  return `${date.getFullYear()}/${month}/${day} ${time}`;
}

type ChatMessageItemProps = {
  message: ChatMessage;
  isStreaming?: boolean;
  isLastAssistant?: boolean;
  onDeleteMessage?: (messageId: string) => Promise<void>;
  isParallelMode?: boolean;
};

export function ChatMessageItem({
  message,
  isStreaming = false,
  isLastAssistant = false,
  onDeleteMessage,
  isParallelMode = false
}: ChatMessageItemProps): React.ReactElement {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const userProfile = useAtomValue(userProfileAtom);

  const handleDeleteConfirm = async (): Promise<void> => {
    if (!onDeleteMessage) return;
    setIsDeleting(true);
    try {
      await onDeleteMessage(message.id);
    } finally {
      setIsDeleting(false);
      setDeleteDialogOpen(false);
    }
  };

  const messageFrom = isParallelMode ? "assistant" : message.role;

  return (
    <>
      <Message from={messageFrom}>
        {message.role === "assistant" ? (
          <MessageHeader
            model={message.model}
            time={formatMessageTime(message.createdAt)}
            logo={
              <img
                src={getModelLogo(message.model ?? "")}
                alt={message.model ?? "AI"}
                className="size-[35px] rounded-[25%] object-cover"
              />
            }
          />
        ) : null}

        {message.role === "user" ? (
          <div className="mb-2.5 flex items-start gap-2.5">
            <UserAvatar avatar={userProfile.avatar} size={35} />
            <div className="flex h-[35px] flex-col justify-between">
              <span className="text-sm font-semibold leading-none text-foreground/60">{userProfile.userName}</span>
              <span className="text-[10px] leading-none text-foreground/[0.38]">{formatMessageTime(message.createdAt)}</span>
            </div>
          </div>
        ) : null}

        <MessageContent>
          {message.role === "assistant" ? (
            <>
              {message.reasoning ? (
                <Reasoning isStreaming={isStreaming && !message.content} defaultOpen={isStreaming && !message.content}>
                  <ReasoningTrigger />
                  <ReasoningContent>{message.reasoning}</ReasoningContent>
                </Reasoning>
              ) : null}

              {message.content ? (
                <>
                  <MessageResponse>{message.content}</MessageResponse>
                  {isStreaming && isLastAssistant && !message.stopped ? <StreamingIndicator /> : null}
                </>
              ) : null}

              {message.stopped && !message.content ? (
                <div className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
                  <span className="size-2 rounded-full bg-muted-foreground/40" />
                  <span>已停止生成</span>
                </div>
              ) : null}
            </>
          ) : (
            <>
              {message.attachments && message.attachments.length > 0 ? (
                <MessageAttachments attachments={message.attachments} />
              ) : null}
              {message.content ? <UserMessageContent>{message.content}</UserMessageContent> : null}
            </>
          )}
        </MessageContent>

        {(message.content || (message.attachments && message.attachments.length > 0)) && !isStreaming ? (
          <MessageActions className="pl-[46px]">
            <CopyButton content={message.content} />
            {onDeleteMessage ? (
              <MessageAction tooltip="删除" onClick={() => setDeleteDialogOpen(true)}>
                <Trash2 className="size-3.5" />
              </MessageAction>
            ) : null}
            {message.role === "assistant" && message.stopped ? (
              <span className="ml-1 text-[11px] text-foreground/40">（已中止）</span>
            ) : null}
          </MessageActions>
        ) : null}
      </Message>

      <DeleteMessageDialog
        open={deleteDialogOpen}
        title={isDeleting ? "正在删除..." : "确认删除该消息？"}
        onCancel={() => {
          if (!isDeleting) setDeleteDialogOpen(false);
        }}
        onConfirm={() => {
          if (!isDeleting) {
            void handleDeleteConfirm();
          }
        }}
      />
    </>
  );
}
