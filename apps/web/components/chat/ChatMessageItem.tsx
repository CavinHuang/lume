import { useCallback, useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import { Bot, Loader2, Pencil, RotateCcw, Trash2 } from "lucide-react";
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
  MessageStopped,
  StreamingIndicator,
  UserMessageContent,
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements";
import { getModelLogo } from "@/lib/model-logo";
import { CopyButton } from "./CopyButton";
import { DeleteMessageDialog } from "./DeleteMessageDialog";
import type { InlineEditSubmitPayload } from "./InlineEditForm";
import { InlineEditForm } from "./InlineEditForm";
import { AgentModeRecommendationBanner } from "./AgentModeRecommendationBanner";
import { ChatToolActivityIndicator } from "./ChatToolActivityIndicator";
import { UserAvatar } from "./UserAvatar";
import { extractAgentModeRecommendation } from "./agent-mode-recommendation";
import { useMigrateChatToAgent } from "./use-migrate-chat-to-agent";

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
  allMessages?: ChatMessage[];
  messageIndex?: number;
  onDeleteMessage?: (messageId: string) => Promise<void>;
  onResendMessage?: (message: ChatMessage) => Promise<void>;
  onStartInlineEdit?: (message: ChatMessage) => void;
  onSubmitInlineEdit?: (message: ChatMessage, payload: InlineEditSubmitPayload) => Promise<void>;
  onCancelInlineEdit?: () => void;
  isInlineEditing?: boolean;
  isParallelMode?: boolean;
};

export type { InlineEditSubmitPayload } from "./InlineEditForm";

export function ChatMessageItem({
  message,
  isStreaming = false,
  isLastAssistant = false,
  onDeleteMessage,
  onResendMessage,
  onStartInlineEdit,
  onSubmitInlineEdit,
  onCancelInlineEdit,
  isInlineEditing = false,
  isParallelMode = false
}: ChatMessageItemProps): React.ReactElement {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const userProfile = useAtomValue(userProfileAtom);
  const { busy: migrateBusy, migrate } = useMigrateChatToAgent();
  const recommendation = useMemo(
    () => extractAgentModeRecommendation(message.toolActivities),
    [message.toolActivities]
  );

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

  const handleInlineEditSubmit = useCallback(
    (payload: InlineEditSubmitPayload): void => {
      if (!onSubmitInlineEdit) return;
      void onSubmitInlineEdit(message, payload);
    },
    [message, onSubmitInlineEdit]
  );

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
              {message.toolActivities && message.toolActivities.length > 0 ? (
                <ChatToolActivityIndicator activities={message.toolActivities} />
              ) : null}
              {recommendation ? <AgentModeRecommendationBanner recommendation={recommendation} /> : null}

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
              {message.attachments && message.attachments.length > 0 ? (
                <MessageAttachments attachments={message.attachments} />
              ) : null}

              {message.stopped && !message.content ? <MessageStopped /> : null}
            </>
          ) : (
            <>
              {!isInlineEditing && message.attachments && message.attachments.length > 0 ? (
                <MessageAttachments attachments={message.attachments} />
              ) : null}
              {isInlineEditing ? (
                <InlineEditForm
                  message={message}
                  onSubmit={handleInlineEditSubmit}
                  onCancel={() => onCancelInlineEdit?.()}
                />
              ) : message.content ? (
                <UserMessageContent>{message.content}</UserMessageContent>
              ) : null}
            </>
          )}
        </MessageContent>

        {(message.content || (message.attachments && message.attachments.length > 0)) && !isStreaming && !isInlineEditing ? (
          <MessageActions className="mt-0.5 pl-[46px]">
            <CopyButton content={message.content} />
            {message.role === "user" && onResendMessage ? (
              <MessageAction tooltip="重新发送" onClick={() => void onResendMessage(message)}>
                <RotateCcw className="size-3.5" />
              </MessageAction>
            ) : null}
            {message.role === "user" && onStartInlineEdit ? (
              <MessageAction tooltip="编辑后重发" onClick={() => onStartInlineEdit(message)}>
                <Pencil className="size-3.5" />
              </MessageAction>
            ) : null}
            {message.role === "assistant" ? (
              <MessageAction
                tooltip={migrateBusy ? "迁移中..." : "迁移到 Agent"}
                disabled={migrateBusy}
                onClick={() => { void migrate(); }}
              >
                {migrateBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Bot className="size-3.5" />}
              </MessageAction>
            ) : null}
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
        onOpenChange={setDeleteDialogOpen}
        onConfirm={() => { void handleDeleteConfirm(); }}
        isDeleting={isDeleting}
      />
    </>
  );
}
