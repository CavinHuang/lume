"use client";

import * as React from "react";
import { useSmoothStream } from "@lume/ui";
import type { AgentMessage } from "@lume/shared";
import { useAtomValue } from "jotai";
import { Bot, CalendarClock, ChevronRight, FileImage, FileText, Home, Loader2, Pencil, RotateCcw, Trash2, Wrench } from "lucide-react";
import {
  agentIsCompactingAtom,
  agentModelIdAtom,
  agentStatusLineAtom,
  agentStreamingAtom,
  agentStreamingContentAtom,
  agentToolActivitiesAtom,
  agentStreamingReasoningAtom,
  agentStreamingTimelineEventsAtom,
  agentThinkingSecondsAtom,
  cachedTeammateStatesAtom,
  currentAgentMessagesAtom,
  currentAgentSessionIdAtom,
  extractTimelineEvents,
  teammateStatesAtom,
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
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
  StreamingIndicator,
  UserMessageContent,
} from "@/components/ai-elements";
import { formatMessageTime } from "@/components/chat/ChatMessageItem";
import { CopyButton } from "@/components/chat/CopyButton";
import { DeleteMessageDialog } from "@/components/chat/DeleteMessageDialog";
import { UserAvatar } from "@/components/chat/UserAvatar";
import { extractToolActivitiesFromMessages } from "@/lib/agent-tool-activity";
import { getModelLogo } from "@/lib/model-logo";
import { AgentStatusLine } from "./AgentStatusLine";
import { EventTimeline } from "./EventTimeline";
import { SubagentLiveCards } from "./SubagentLiveCard";

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
  onOpenSession?: (sessionId: string) => void;
}

interface AnnounceInfo {
  label: string;
  status: string;
  outputText?: string;
  errorText?: string;
}

function parseAnnounceContent(content: string): AnnounceInfo {
  const normalized = content.trim();
  const firstLine = normalized.split("\n")[0]?.trim() ?? "";
  // 格式: "子任务完成通知: {label} ({status})"
  const headerMatch = firstLine.match(/^子任务完成通知:\s*(.+?)\s*\(([^)]+)\)\s*$/);
  const label = headerMatch?.[1]?.trim() ?? firstLine;
  const status = headerMatch?.[2]?.trim() ?? "";

  const outputIdx = normalized.indexOf("输出摘要:");
  let outputText: string | undefined;
  if (outputIdx !== -1) {
    const afterOutput = normalized.slice(outputIdx + "输出摘要:".length).trim();
    const errorIdx = afterOutput.indexOf("\n错误:");
    outputText = (errorIdx !== -1 ? afterOutput.slice(0, errorIdx).trim() : afterOutput.trim()) || undefined;
  }

  const errorIdx = normalized.indexOf("\n错误:");
  let errorText: string | undefined;
  if (errorIdx !== -1) {
    errorText = normalized.slice(errorIdx + "\n错误:".length).trim() || undefined;
  }

  return { label, status, outputText, errorText };
}

function ThinkingTimeIndicator({ seconds }: { seconds: number }): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false);
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-muted/40"
      >
        <Loader2 className="size-3 shrink-0 text-muted-foreground/50 animate-spin" />
        <span className="text-foreground/60">思考了 {seconds.toFixed(1)} 秒</span>
        <ChevronRight className={`size-3 shrink-0 text-muted-foreground/50 transition-transform ${expanded ? "rotate-90" : ""}`} />
      </button>
      {expanded ? (
        <div className="mt-1 px-2 py-1 text-[11px] text-muted-foreground/50">
          模型推理阶段
        </div>
      ) : null}
    </div>
  );
}

function SubagentAnnounceMessage({
  message,
  onOpenSession
}: {
  message: AgentMessage;
  onOpenSession?: (sessionId: string) => void;
}): React.ReactElement {
  const { label, status, outputText, errorText } = React.useMemo(
    () => parseAnnounceContent(message.content),
    [message.content]
  );
  const [expanded, setExpanded] = React.useState(false);
  const metadata = message.metadata as Record<string, unknown>;
  const childSessionId = typeof metadata?.childSessionId === "string" ? metadata.childSessionId : undefined;
  const isCompleted = status === "completed";
  const isFailed = status === "failed" || status === "stopped";

  // 尝试从 metadata 获取工具计数
  const toolUses = typeof metadata?.toolUses === "number" ? metadata.toolUses : undefined;
  // 如果没有，尝试从 cachedTeammateStates 查找
  const currentSessionId = useAtomValue(currentAgentSessionIdAtom);
  const cachedTeammates = useAtomValue(cachedTeammateStatesAtom);
  const cachedToolUses = React.useMemo(() => {
    if (toolUses !== undefined || !currentSessionId || !childSessionId) return undefined;
    const teammates = cachedTeammates.get(currentSessionId);
    const teammate = teammates?.find(t => t.taskId === childSessionId);
    return teammate?.usage?.toolUses ?? teammate?.toolHistory.length;
  }, [toolUses, currentSessionId, childSessionId, cachedTeammates]);

  const finalToolUses = toolUses ?? cachedToolUses;
  const taskId = childSessionId?.slice(0, 8) ?? "unknown";

  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 overflow-hidden">
      {/* 折叠行 */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/30"
      >
        <Home className="size-3 shrink-0 text-muted-foreground/50" />
        <span className="text-xs font-medium text-foreground/70">TaskOutput {taskId}</span>
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
            isCompleted
              ? "bg-green-500/10 text-green-600"
              : "bg-destructive/10 text-destructive"
          }`}
        >
          {isCompleted ? "Completed" : "Failed"}
        </span>
        {finalToolUses !== undefined ? (
          <span className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            <Wrench className="size-2.5" />
            {finalToolUses} tools
          </span>
        ) : null}
        <div className="flex-1" />
        <ChevronRight className={`size-3 shrink-0 text-muted-foreground/50 transition-transform ${expanded ? "rotate-90" : ""}`} />
      </button>

      {/* 展开详情 */}
      {expanded ? (
        <div className="border-t border-border/40 px-3 py-2.5 space-y-2">
          <div className="flex items-center gap-2">
            <Bot className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="text-xs font-medium flex-1 truncate">{label}</span>
          </div>

          {outputText ? (
            <div className="rounded-md bg-muted/30 px-2.5 py-2">
              <div className="text-[11px] leading-relaxed text-foreground/80">
                <MessageResponse>{outputText}</MessageResponse>
              </div>
            </div>
          ) : null}

          {errorText ? (
            <div className="rounded-md bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
              <span className="font-medium">错误: </span>{errorText}
            </div>
          ) : null}

          {childSessionId && onOpenSession ? (
            <button
              type="button"
              onClick={() => onOpenSession(childSessionId)}
              className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            >
              查看子任务对话 →
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
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
  actionsDisabled,
  isInlineEditing,
  onDeleteMessage,
  onResendMessage,
  onSaveAsTask,
  onStartInlineEdit,
  onSubmitInlineEdit,
  onCancelInlineEdit,
  onOpenSession
}: {
  message: AgentMessage;
  actionsDisabled: boolean;
  isInlineEditing: boolean;
  onDeleteMessage?: (message: AgentMessage) => Promise<void>;
  onResendMessage?: (message: AgentMessage) => Promise<void>;
  onSaveAsTask?: (message: AgentMessage) => Promise<void>;
  onStartInlineEdit?: (message: AgentMessage) => void;
  onSubmitInlineEdit?: (message: AgentMessage, payload: AgentInlineEditSubmitPayload) => Promise<void>;
  onCancelInlineEdit?: () => void;
  onOpenSession?: (sessionId: string) => void;
}): React.ReactElement | null {
  const [deleteDialogOpen, setDeleteDialogOpen] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const userProfile = useAtomValue(userProfileAtom);

  const timelineEvents = React.useMemo(
    () => message.role === "assistant" ? extractTimelineEvents(message) : [],
    [message]
  );
  const messageToolActivities = React.useMemo(
    () => {
      if (message.role !== "assistant") return [];
      const metadata = message.metadata as Record<string, unknown> | undefined;
      const snapshot = metadata?.toolActivitiesSnapshot;
      if (Array.isArray(snapshot)) {
        return snapshot as ReturnType<typeof extractToolActivitiesFromMessages>;
      }
      return extractToolActivitiesFromMessages([message]);
    },
    [message]
  );

  const { attachedFiles, messageText } = React.useMemo(() => {
    if (message.role !== "user") return { attachedFiles: [] as AttachedFileRef[], messageText: "" };
    const sanitized = stripPlanExecutionMarker(message.content);
    const { files, text } = splitAttachedFiles(sanitized);
    return { attachedFiles: files, messageText: text };
  }, [message.role, message.content]);

  if (message.role === "user") {

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

        {!isInlineEditing && !actionsDisabled ? (
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
    if ((message.metadata as Record<string, unknown>)?.subagentAnnounce === true) {
      return <SubagentAnnounceMessage message={message} onOpenSession={onOpenSession} />;
    }

    return (
      <Message from="assistant">
        <MessageHeader
          model={message.model}
          time={formatMessageTime(message.createdAt)}
          logo={<AssistantLogo model={message.model} />}
        />

        <MessageContent>
          {message.reasoning ? (
            <Reasoning
              defaultOpen={false}
              duration={typeof (message.metadata as Record<string, unknown>)?.thinkingDuration === "number"
                ? ((message.metadata as Record<string, unknown>).thinkingDuration as number)
                : undefined}
            >
              <ReasoningTrigger />
              <ReasoningContent>{message.reasoning}</ReasoningContent>
            </Reasoning>
          ) : null}
          {timelineEvents.length > 0 ? (
            <div className="mb-2">
              <EventTimeline events={timelineEvents} activities={messageToolActivities} />
            </div>
          ) : null}
          {/* 安全网：当 timeline 中没有文本段时，直接展示 message.content */}
          {message.content && !timelineEvents.some((e) => e.type === "text") ? (
            <MessageResponse>{message.content}</MessageResponse>
          ) : null}
        </MessageContent>
        {!actionsDisabled && (message.content ?? "").trim().length > 0 ? (
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
}, (prev, next) =>
  prev.message === next.message &&
  prev.actionsDisabled === next.actionsDisabled &&
  prev.isInlineEditing === next.isInlineEditing &&
  prev.onOpenSession === next.onOpenSession
)

export function AgentMessages({
  isStreaming = false,
  isSwitching = false,
  inlineEditingMessageId = null,
  onDeleteMessage,
  onResendMessage,
  onSaveAsTask,
  onStartInlineEdit,
  onSubmitInlineEdit,
  onCancelInlineEdit,
  onOpenSession
}: AgentMessagesProps): React.ReactElement {
  const messages = useAtomValue(currentAgentMessagesAtom);
  const sessionId = useAtomValue(currentAgentSessionIdAtom);
  const streaming = useAtomValue(agentStreamingAtom);
  const streamingContent = useAtomValue(agentStreamingContentAtom);
  const streamingReasoning = useAtomValue(agentStreamingReasoningAtom);
  const streamingTimelineEvents = useAtomValue(agentStreamingTimelineEventsAtom);
  const streamingToolActivities = useAtomValue(agentToolActivitiesAtom);
  const agentModelId = useAtomValue(agentModelIdAtom);
  const teammateStates = useAtomValue(teammateStatesAtom);
  const isCompacting = useAtomValue(agentIsCompactingAtom);
  const thinkingSeconds = useAtomValue(agentThinkingSecondsAtom);
  const statusLine = useAtomValue(agentStatusLineAtom);

  const { displayedContent: smoothContent } = useSmoothStream({
    content: streamingContent,
    isStreaming: streaming
  });

  const actionsDisabled = isStreaming || streaming;
  const shouldShowStreamingMessage = streaming || Boolean(smoothContent);

  // 当 streaming timeline 中已有文本段时，文字由 EventTimeline 渲染，不需要 smoothContent 单独展示
  const hasTextInStreamingTimeline = streamingTimelineEvents.some((e) => e.type === "text");
  // 需要独立展示 smoothContent 的条件：有内容 且 timeline 中尚无文本段
  const showSmoothContent = Boolean(smoothContent) && !hasTextInStreamingTimeline;
  // reasoning 是否还在活跃输出（用于控制 Reasoning 组件的 streaming 状态和 auto-close）
  // 当有正式内容输出或工具调用开始时，reasoning 阶段视为结束
  const reasoningStillActive = streaming && !streamingContent && streamingTimelineEvents.length === 0;
  // 等待第一个 token 时显示状态行（reasoning/子Agent卡片已有内容时不显示）
  const showLoadingDots = streaming && !smoothContent && !streamingReasoning && streamingTimelineEvents.length === 0 && teammateStates.length === 0;

  return (
    <Conversation className={!streaming ? "cv-ready" : undefined} key={sessionId ?? ""}>
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
                  actionsDisabled={actionsDisabled}
                  isInlineEditing={inlineEditingMessageId === message.id}
                  onDeleteMessage={onDeleteMessage}
                  onResendMessage={onResendMessage}
                  onSaveAsTask={onSaveAsTask}
                  onStartInlineEdit={onStartInlineEdit}
                  onSubmitInlineEdit={onSubmitInlineEdit}
                  onCancelInlineEdit={onCancelInlineEdit}
                  onOpenSession={onOpenSession}
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
                  {streamingReasoning ? (
                    <Reasoning isStreaming={reasoningStillActive} defaultOpen>
                      <ReasoningTrigger />
                      <ReasoningContent>{streamingReasoning}</ReasoningContent>
                    </Reasoning>
                  ) : null}
                  {streamingTimelineEvents.length > 0 ? (
                    <div className="mb-2">
                      <EventTimeline
                        events={streamingTimelineEvents}
                        activities={streamingToolActivities}
                        isStreaming={streaming}
                      />
                    </div>
                  ) : null}

                  {isCompacting ? (
                    <div className="mb-2 flex items-center gap-2 rounded-md bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground/60">
                      <Loader2 className="size-3 animate-spin shrink-0" />
                      上下文压缩中...
                    </div>
                  ) : null}

                  {teammateStates.length > 0 ? (
                    <div className="mb-2">
                      <SubagentLiveCards teammates={teammateStates} />
                    </div>
                  ) : null}

                  {showSmoothContent ? (
                    <>
                      <MessageResponse>{smoothContent}</MessageResponse>
                      {streaming ? <StreamingIndicator /> : null}
                    </>
                  ) : showLoadingDots ? (
                    <AgentStatusLine text={statusLine ?? "正在处理..."} />
                  ) : streaming && streamingTimelineEvents.length > 0 && statusLine ? (
                    // 工具执行中或等待工具后的文字 token → 状态行描述
                    <AgentStatusLine text={statusLine} />
                  ) : null}
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
