import * as React from "react";
import { useSmoothStream } from "@lume/ui";
import type { AgentMessage } from "@lume/shared";
import { useAtom, useAtomValue } from "jotai";
import { Bot, CalendarClock, ChevronLeft, ChevronRight, FileImage, FileText, Home, Loader2, Pencil, RotateCcw, Trash2, Wrench } from "lucide-react";
import {
  agentIsCompactingAtom,
  agentMessageVersionsByGroupAtom,
  agentModelIdAtom,
  agentSelectedVersionIndexByGroupAtom,
  agentStatusLineAtom,
  agentStreamingAtom,
  agentStreamingContentAtom,
  agentToolActivitiesAtom,
  agentStreamingReasoningAtom,
  agentStreamingTimelineEventsAtom,
  agentThinkingSecondsAtom,
  currentAgentMessagesAtom,
  currentAgentSessionIdAtom,
  currentAgentStreamStateAtom,
  extractTimelineEvents,
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
  UserMessageContent,
} from "@/components/ai-elements";
import { formatMessageTime } from "@/components/chat/ChatMessageItem";
import { CopyButton } from "@/components/chat/CopyButton";
import { DeleteMessageDialog } from "@/components/chat/DeleteMessageDialog";
import { UserAvatar } from "@/components/chat/UserAvatar";
import {
  canMoveToNextVersion,
  canMoveToPreviousVersion,
  getDisplayedAgentMessage,
  getLatestVersionIndex,
  getVersionLabel
} from "@/lib/agent-message-versions";
import { extractToolActivitiesFromMessages } from "@/lib/agent-tool-activity";
import { getAgentMessageVersions } from "@/lib/desktop-api/agent";
import { getModelLogo } from "@/lib/model-logo";
import { cn } from "@/lib/utils";
import { AgentRunningIndicator } from "./AgentRunningIndicator";
import { AgentStatusLine } from "./AgentStatusLine";
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
  onSaveAsTask?: (message: AgentMessage) => void;
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

function isAgentRenderDebugEnabled(): boolean {
  try {
    return window.localStorage.getItem("lume.debug.agent") === "1";
  } catch {
    return false;
  }
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

function VersionNavigator({
  label,
  canGoPrev,
  canGoNext,
  onPrev,
  onNext,
  loading
}: {
  label: string;
  canGoPrev: boolean;
  canGoNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  loading: boolean;
}): React.ReactElement {
  return (
    <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
      <button
        type="button"
        disabled={!canGoPrev || loading}
        onClick={onPrev}
        className="inline-flex size-6 items-center justify-center rounded-md border border-border/60 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <ChevronLeft className="size-3.5" />
      </button>
      <div className="min-w-[44px] text-center tabular-nums">{label}</div>
      <button
        type="button"
        disabled={!canGoNext || loading}
        onClick={onNext}
        className="inline-flex size-6 items-center justify-center rounded-md border border-border/60 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {loading ? <Loader2 className="size-3.5 animate-spin" /> : <ChevronRight className="size-3.5" />}
      </button>
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

  const finalToolUses = toolUses;
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
  displayedMessage,
  isInlineEditing,
  versionLabel,
  canGoPrevVersion,
  canGoNextVersion,
  onPrevVersion,
  onNextVersion,
  versionLoading,
  onDeleteMessage,
  onResendMessage,
  onSaveAsTask,
  onStartInlineEdit,
  onSubmitInlineEdit,
  onCancelInlineEdit,
  onOpenSession
}: {
  message: AgentMessage;
  displayedMessage: AgentMessage;
  isInlineEditing: boolean;
  versionLabel?: string | null;
  canGoPrevVersion: boolean;
  canGoNextVersion: boolean;
  onPrevVersion?: () => void;
  onNextVersion?: () => void;
  versionLoading: boolean;
  onDeleteMessage?: (message: AgentMessage) => Promise<void>;
  onResendMessage?: (message: AgentMessage) => Promise<void>;
  onSaveAsTask?: (message: AgentMessage) => void;
  onStartInlineEdit?: (message: AgentMessage) => void;
  onSubmitInlineEdit?: (message: AgentMessage, payload: AgentInlineEditSubmitPayload) => Promise<void>;
  onCancelInlineEdit?: () => void;
  onOpenSession?: (sessionId: string) => void;
}): React.ReactElement | null {
  const [deleteDialogOpen, setDeleteDialogOpen] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const userProfile = useAtomValue(userProfileAtom);
  const debugEnabled = isAgentRenderDebugEnabled();
  const previousDebugRef = React.useRef<{
    messageId: string;
    displayedMessageId: string;
    versionLabel?: string | null;
    isInlineEditing: boolean;
    versionLoading: boolean;
  } | null>(null);

  React.useEffect(() => {
    if (!debugEnabled) return;
    const previous = previousDebugRef.current;
    const nextState = {
      messageId: message.id,
      displayedMessageId: displayedMessage.id,
      versionLabel,
      isInlineEditing,
      versionLoading
    };
    if (previous) {
      const changedKeys = Object.entries(nextState)
        .filter(([key, value]) => previous[key as keyof typeof nextState] !== value)
        .map(([key]) => key);
      if (changedKeys.length > 0) {
        console.info("[AgentRenderDebug] message item rerender", {
          messageId: message.id,
          changedKeys,
          previous,
          next: nextState
        });
      }
    }
    previousDebugRef.current = nextState;
  }, [debugEnabled, displayedMessage.id, isInlineEditing, message.id, versionLabel, versionLoading]);

  const timelineEvents = React.useMemo(
    () => displayedMessage.role === "assistant" ? extractTimelineEvents(displayedMessage) : [],
    [displayedMessage]
  );
  const messageToolActivities = React.useMemo(
    () => {
      if (displayedMessage.role !== "assistant") return [];
      const metadata = displayedMessage.metadata as Record<string, unknown> | undefined;
      const snapshot = metadata?.toolActivitiesSnapshot;
      if (Array.isArray(snapshot)) {
        return snapshot as ReturnType<typeof extractToolActivitiesFromMessages>;
      }
      return extractToolActivitiesFromMessages([displayedMessage]);
    },
    [displayedMessage]
  );

  const { attachedFiles, messageText } = React.useMemo(() => {
    if (displayedMessage.role !== "user") return { attachedFiles: [] as AttachedFileRef[], messageText: "" };
    const sanitized = stripPlanExecutionMarker(displayedMessage.content);
    const { files, text } = splitAttachedFiles(sanitized);
    return { attachedFiles: files, messageText: text };
  }, [displayedMessage.role, displayedMessage.content]);

  const userRoutingHint = React.useMemo(() => {
    if (displayedMessage.role !== "user") return null;
    const metadata = displayedMessage.metadata as Record<string, unknown> | undefined;
    const preferred = typeof metadata?.preferredCapabilityRoute === "string"
      ? metadata.preferredCapabilityRoute
      : undefined;
    const reason = typeof metadata?.capabilityRoutingReason === "string"
      ? metadata.capabilityRoutingReason
      : undefined;
    const toolPolicy = metadata?.toolPolicy;
    const allow = Array.isArray((toolPolicy as Record<string, unknown> | undefined)?.allow)
      ? ((toolPolicy as Record<string, unknown>).allow as unknown[])
      : [];
    const deny = Array.isArray((toolPolicy as Record<string, unknown> | undefined)?.deny)
      ? ((toolPolicy as Record<string, unknown>).deny as unknown[])
      : [];
    const softPolicyActive = !!toolPolicy
      && typeof toolPolicy === "object"
      && (allow.length > 0 || deny.length > 0);
    if (!preferred) return null;
    return { preferred, reason, softPolicyActive };
  }, [displayedMessage]);

  if (displayedMessage.role === "user") {

    return (
      <Message from="user">
        <div className="mb-2.5 flex items-start gap-2.5">
          <UserAvatar avatar={userProfile.avatar} size={35} />
          <div className="flex h-[35px] flex-col justify-between">
            <span className="text-sm font-semibold leading-none text-foreground/60">{userProfile.userName}</span>
            <span className="text-[10px] leading-none text-foreground/[0.38]">{formatMessageTime(displayedMessage.createdAt)}</span>
          </div>
        </div>

        <MessageContent>
          {userRoutingHint ? (
            <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground/75">
              <span className="rounded-full border border-border/60 bg-muted/40 px-2 py-0.5">
                route: {userRoutingHint.preferred}
              </span>
              {userRoutingHint.softPolicyActive ? (
                <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-amber-700 dark:text-amber-300">
                  soft policy active
                </span>
              ) : null}
              {userRoutingHint.reason ? (
                <span className="truncate">{userRoutingHint.reason}</span>
              ) : null}
            </div>
          ) : null}
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
                void onSubmitInlineEdit(displayedMessage, payload);
              }}
              onCancel={() => onCancelInlineEdit?.()}
            />
          ) : messageText ? (
            <UserMessageContent>{messageText}</UserMessageContent>
          ) : null}
        </MessageContent>

        {!isInlineEditing ? (
          <MessageActions
            className="mt-0.5 pl-[46px] transition-none group-data-[actions-disabled=true]/agentlist:pointer-events-none group-data-[actions-disabled=true]/agentlist:opacity-0"
          >
            <CopyButton content={messageText || displayedMessage.content} />
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

        {versionLabel && onPrevVersion && onNextVersion ? (
          <div className="pl-[46px]">
            <VersionNavigator
              label={versionLabel}
              canGoPrev={canGoPrevVersion}
              canGoNext={canGoNextVersion}
              onPrev={onPrevVersion}
              onNext={onNextVersion}
              loading={versionLoading}
            />
          </div>
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

  if (displayedMessage.role === "assistant") {
    if ((displayedMessage.metadata as Record<string, unknown>)?.subagentAnnounce === true) {
      return <SubagentAnnounceMessage message={displayedMessage} onOpenSession={onOpenSession} />;
    }

    return (
      <Message from="assistant">
        <MessageHeader
          model={displayedMessage.model}
          time={formatMessageTime(displayedMessage.createdAt)}
          logo={<AssistantLogo model={displayedMessage.model} />}
        />

        <MessageContent>
          {displayedMessage.reasoning ? (
            <Reasoning
              defaultOpen={Boolean((displayedMessage.metadata as Record<string, unknown>)?.reasoningExpanded)}
              duration={typeof (displayedMessage.metadata as Record<string, unknown>)?.thinkingDuration === "number"
                ? ((displayedMessage.metadata as Record<string, unknown>).thinkingDuration as number)
                : undefined}
            >
              <ReasoningTrigger />
              <ReasoningContent>{displayedMessage.reasoning}</ReasoningContent>
            </Reasoning>
          ) : null}
          {timelineEvents.length > 0 ? (
            <div className="mb-2">
              <EventTimeline events={timelineEvents} activities={messageToolActivities} />
            </div>
          ) : null}
          {/* 安全网：当 timeline 中没有文本段时，直接展示 message.content */}
          {displayedMessage.content && !timelineEvents.some((e) => e.type === "text") ? (
            <MessageResponse>{displayedMessage.content}</MessageResponse>
          ) : null}
        </MessageContent>
        {(displayedMessage.content ?? "").trim().length > 0 ? (
          <MessageActions
            className="mt-0.5 pl-[46px] transition-none group-data-[actions-disabled=true]/agentlist:pointer-events-none group-data-[actions-disabled=true]/agentlist:opacity-0"
          >
            <CopyButton content={displayedMessage.content} />
            {onSaveAsTask ? (
              <MessageAction tooltip="保存为任务" onClick={() => void onSaveAsTask(displayedMessage)}>
                <CalendarClock className="size-3.5" />
              </MessageAction>
            ) : null}
          </MessageActions>
        ) : null}
        {versionLabel && onPrevVersion && onNextVersion ? (
          <div className="pl-[46px]">
            <VersionNavigator
              label={versionLabel}
              canGoPrev={canGoPrevVersion}
              canGoNext={canGoNextVersion}
              onPrev={onPrevVersion}
              onNext={onNextVersion}
              loading={versionLoading}
            />
          </div>
        ) : null}
      </Message>
    );
  }

  return null;
}, (prev, next) =>
  prev.message === next.message &&
  prev.displayedMessage === next.displayedMessage &&
  prev.isInlineEditing === next.isInlineEditing &&
  prev.versionLabel === next.versionLabel &&
  prev.canGoPrevVersion === next.canGoPrevVersion &&
  prev.canGoNextVersion === next.canGoNextVersion &&
  prev.versionLoading === next.versionLoading &&
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
  const [messageVersionsByGroup, setMessageVersionsByGroup] = useAtom(agentMessageVersionsByGroupAtom);
  const [selectedVersionIndexByGroup, setSelectedVersionIndexByGroup] = useAtom(agentSelectedVersionIndexByGroupAtom);
  const streaming = useAtomValue(agentStreamingAtom);
  const streamingContent = useAtomValue(agentStreamingContentAtom);
  const streamingReasoning = useAtomValue(agentStreamingReasoningAtom);
  const streamingTimelineEvents = useAtomValue(agentStreamingTimelineEventsAtom);
  const streamingToolActivities = useAtomValue(agentToolActivitiesAtom);
  const agentModelId = useAtomValue(agentModelIdAtom);
  const isCompacting = useAtomValue(agentIsCompactingAtom);
  const thinkingSeconds = useAtomValue(agentThinkingSecondsAtom);
  const statusLine = useAtomValue(agentStatusLineAtom);
  const streamState = useAtomValue(currentAgentStreamStateAtom);
  const streamStartedAt = streamState?.streamStartedAt;

  const { displayedContent: smoothContent } = useSmoothStream({
    content: streamingContent,
    isStreaming: streaming
  });

  const actionsDisabled = isStreaming || streaming;
  const shouldShowStreamingMessage = streaming;

  // 当 streaming timeline 中已有文本段时，文字由 EventTimeline 渲染，不需要 smoothContent 单独展示
  const hasTextInStreamingTimeline = streamingTimelineEvents.some((e) => e.type === "text");
  // 需要独立展示 smoothContent 的条件：有内容 且 timeline 中尚无文本段
  const showSmoothContent = Boolean(smoothContent) && !hasTextInStreamingTimeline;
  // reasoning 是否还在活跃输出（用于控制 Reasoning 组件的 streaming 状态和 auto-close）
  // 当有正式内容输出或工具调用开始时，reasoning 阶段视为结束
  const reasoningStillActive = streaming && !streamingContent && streamingTimelineEvents.length === 0;
  // 等待第一个 token 时显示状态行（reasoning/子Agent卡片已有内容时不显示）
  const showLoadingDots = streaming && !smoothContent && !streamingReasoning && streamingTimelineEvents.length === 0;
  const [loadingGroupIds, setLoadingGroupIds] = React.useState<Record<string, boolean>>({});

  // --- 流式 → 持久化切换的高度锁定，防止列表抖动 ---
  // 流式消息结束时，DOM 子树整体替换（不同 key → unmount/remount），
  // 新旧子树高度可能短暂不同，触发 StickToBottom 的 ResizeObserver → 滚动跳变。
  // 解决方案：持续追踪流式消息块高度，当 streaming 从 true → false 时，
  // 将末尾过渡占位元素的 min-height 设为最后已知高度，在下一帧释放。
  const streamingBlockRef = React.useRef<HTMLDivElement>(null);
  const lastStreamingHeightRef = React.useRef(0);
  const transitionAnchorRef = React.useRef<HTMLDivElement>(null);
  const prevStreamingRef = React.useRef(streaming);

  // 流式进行中：每帧追踪高度（useLayoutEffect 在 DOM 更新后同步执行）
  React.useLayoutEffect(() => {
    if (streaming && streamingBlockRef.current) {
      lastStreamingHeightRef.current = streamingBlockRef.current.offsetHeight;
    }
  });

  // 检测 streaming true → false：锁定高度 → 下一帧释放
  React.useLayoutEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = streaming;

    if (wasStreaming && !streaming && transitionAnchorRef.current && lastStreamingHeightRef.current > 0) {
      const anchor = transitionAnchorRef.current;
      anchor.style.minHeight = `${lastStreamingHeightRef.current}px`;

      // 两帧后释放：第一帧让持久化消息完成首次布局，第二帧确认高度稳定
      const id = requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          anchor.style.minHeight = "";
          lastStreamingHeightRef.current = 0;
        });
      });
      return () => {
        cancelAnimationFrame(id);
        anchor.style.minHeight = "";
      };
    }
  });

  const renderedMessages = React.useMemo(() => {
    return messages.map((message) => {
      const displayedMessage = getDisplayedAgentMessage(
        message,
        messageVersionsByGroup,
        selectedVersionIndexByGroup
      );
      return {
        message,
        displayedMessage,
        versionLabel: getVersionLabel(message, displayedMessage, messageVersionsByGroup),
        canGoPrevVersion: canMoveToPreviousVersion(message, displayedMessage, messageVersionsByGroup),
        canGoNextVersion: canMoveToNextVersion(message, displayedMessage, messageVersionsByGroup),
        versionLoading: Boolean(message.versionGroupId && loadingGroupIds[message.versionGroupId])
      };
    });
  }, [messages, messageVersionsByGroup, selectedVersionIndexByGroup, loadingGroupIds]);

  const streamingMessage = React.useMemo<AgentMessage | null>(() => {
    if (!shouldShowStreamingMessage) {
      return null;
    }
    return {
      id: "streaming-assistant",
      role: "assistant",
      content: showSmoothContent ? smoothContent : "",
      reasoning: streamingReasoning || undefined,
      createdAt: Date.now(),
      model: agentModelId ?? undefined,
      metadata: {
        ...(streamingToolActivities.length > 0 ? { toolActivitiesSnapshot: streamingToolActivities } : {}),
        ...(streamingReasoning ? { reasoningExpanded: true } : {})
      },
      // 传入完整流式事件，让 EventTimeline 按事件顺序统一渲染文本和工具
      events: streamState?.events
    };
  }, [
    agentModelId,
    shouldShowStreamingMessage,
    showSmoothContent,
    smoothContent,
    streamingReasoning,
    streamState?.events,
    streamingToolActivities
  ]);

  const ensureVersionsLoaded = React.useCallback(async (message: AgentMessage): Promise<AgentMessage[] | null> => {
    const groupId = message.versionGroupId;
    if (!sessionId || !groupId || (message.versionCount ?? 1) <= 1) {
      return null;
    }
    const cached = messageVersionsByGroup[groupId];
    if (cached && cached.length > 0) {
      return cached;
    }
    setLoadingGroupIds((prev) => ({ ...prev, [groupId]: true }));
    try {
      const versions = await getAgentMessageVersions(sessionId, groupId);
      setMessageVersionsByGroup((prev) => ({ ...prev, [groupId]: versions }));
      setSelectedVersionIndexByGroup((prev) => ({
        ...prev,
        [groupId]: getLatestVersionIndex(versions)
      }));
      return versions;
    } finally {
      setLoadingGroupIds((prev) => {
        const next = { ...prev };
        delete next[groupId];
        return next;
      });
    }
  }, [messageVersionsByGroup, sessionId, setMessageVersionsByGroup, setSelectedVersionIndexByGroup]);

  const moveVersion = React.useCallback(async (message: AgentMessage, delta: -1 | 1): Promise<void> => {
    const groupId = message.versionGroupId;
    if (!groupId) {
      return;
    }
    const versions = await ensureVersionsLoaded(message);
    if (!versions || versions.length <= 1) {
      return;
    }
    const displayedMessage = getDisplayedAgentMessage(message, messageVersionsByGroup, selectedVersionIndexByGroup);
    const currentIndex = versions.findIndex((item) => item.id === displayedMessage.id);
    const fallbackIndex = getLatestVersionIndex(versions);
    const baseIndex = currentIndex === -1 ? fallbackIndex : currentIndex;
    const nextIndex = Math.max(0, Math.min(versions.length - 1, baseIndex + delta));
    setSelectedVersionIndexByGroup((prev) => ({
      ...prev,
      [groupId]: nextIndex
    }));
  }, [ensureVersionsLoaded, messageVersionsByGroup, selectedVersionIndexByGroup, setSelectedVersionIndexByGroup]);

  return (
    <Conversation initial={false} resize="instant" key={sessionId ?? ""}>
      <ConversationContent className="group/agentlist" data-actions-disabled={actionsDisabled}>
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
            {renderedMessages.map((item) => {
              return (
                <div key={item.message.id} data-message-id={item.message.id}>
                  <AgentMessageItem
                    message={item.message}
                    displayedMessage={item.displayedMessage}
                    isInlineEditing={inlineEditingMessageId === item.message.id || inlineEditingMessageId === item.displayedMessage.id}
                    versionLabel={item.versionLabel}
                    canGoPrevVersion={item.canGoPrevVersion}
                    canGoNextVersion={item.canGoNextVersion}
                    onPrevVersion={() => { void moveVersion(item.message, -1); }}
                    onNextVersion={() => { void moveVersion(item.message, 1); }}
                    versionLoading={item.versionLoading}
                    onDeleteMessage={onDeleteMessage}
                    onResendMessage={onResendMessage}
                    onSaveAsTask={onSaveAsTask}
                    onStartInlineEdit={onStartInlineEdit}
                    onSubmitInlineEdit={onSubmitInlineEdit}
                    onCancelInlineEdit={onCancelInlineEdit}
                    onOpenSession={onOpenSession}
                  />
                </div>
              );
            })}
            {streamingMessage ? (
              <div data-message-id="streaming-assistant" ref={streamingBlockRef}>
                <AgentMessageItem
                  message={streamingMessage}
                  displayedMessage={streamingMessage}
                  isInlineEditing={false}
                  versionLabel={null}
                  canGoPrevVersion={false}
                  canGoNextVersion={false}
                  versionLoading={false}
                />
                {isCompacting ? (
                  <div className="pl-[46px]">
                    <div className="mb-2 flex items-center gap-2 rounded-md bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground/60">
                      <Loader2 className="size-3 animate-spin shrink-0" />
                      上下文压缩中...
                    </div>
                  </div>
                ) : null}
                {!showSmoothContent && showLoadingDots ? (
                  <div className="pl-[46px]">
                    <AgentStatusLine text={statusLine ?? "正在处理..."} />
                  </div>
                ) : null}
                {!showSmoothContent && !showLoadingDots && streaming && statusLine ? (
                  <div className="pl-[46px]">
                    <AgentStatusLine text={statusLine} />
                  </div>
                ) : null}
                {showSmoothContent && streaming ? (
                  <div className="pl-[46px]">
                    <AgentRunningIndicator startedAt={streamStartedAt} />
                  </div>
                ) : null}
                {/* 兜底：流式进行中但没有其他指示器时，始终显示运行指示 */}
                {streaming && !showSmoothContent && !showLoadingDots && !statusLine ? (
                  <div className="pl-[46px]">
                    <AgentRunningIndicator startedAt={streamStartedAt} />
                  </div>
                ) : null}
              </div>
            ) : null}
            {/* 过渡锚点：流式结束瞬间，通过 min-height 补偿流式消息块被移除导致的高度缩减，
                防止 StickToBottom 的 ResizeObserver 检测到负向 resize 而引起滚动跳变 */}
            <div ref={transitionAnchorRef} aria-hidden />
          </>
        )}
      </ConversationContent>

      <ConversationScrollButton />
    </Conversation>
  );
}
