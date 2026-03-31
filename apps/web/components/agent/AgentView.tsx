import { useCallback, useEffect, useMemo, useRef, useState, startTransition } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { AlertCircle, Bot, CheckCircle2, ChevronDown, ChevronRight, Circle, CornerDownLeft, FolderPlus, Lightbulb, Loader2, Paperclip, Settings, Square, X } from "lucide-react";
import type {
  AgentAskUserQuestionRequest,
  AgentToolPermissionRequest,
  AgentMessage,
  AgentSavedFile,
  ModelOption
} from "@lume/shared";
import {
  activeViewAtom,
  agentContextStatusAtom,
  agentSessionsAtom,
  agentChannelIdAtom,
  agentModelIdAtom,
  agentThinkingLevelAtom,
  agentPendingFilesAtom,
  agentPendingPromptAtom,
  agentPermissionModeAtom,
  agentAskUserQuestionRequestsAtom,
  agentRuntimeStatusesAtom,
  agentStreamingAtom,
  agentStreamErrorsAtom,
  agentToolPermissionRequestsAtom,
  agentToolActivitiesAtom,
  agentStreamingStatesAtom,
  agentSessionContextCacheAtom,
  agentWorkspacesAtom,
  applyAgentEvent,
  currentAgentErrorAtom,
  currentAgentAskUserQuestionRequestAtom,
  currentAgentMessagesAtom,
  currentAgentRuntimeStatusAtom,
  currentAgentSessionAtom,
  currentAgentSessionIdAtom,
  currentAgentToolPermissionRequestAtom,
  currentAgentWorkspaceIdAtom
} from "@/atoms";
import {
  planStateAtom
} from "@/atoms/plan-atoms";
import {
  getAgentSessionMessages,
  saveFilesToAgentSession,
  sendAgentMessage,
  updateAgentSessionModelSelection,
} from "@/lib/desktop-api/agent";
import { createAutomationJob } from "@/lib/desktop-api/system";
import { cn } from "@/lib/utils";
import {
  formatAgentRuntimeStatusHint,
  isAgentRuntimeAwaitingInput,
  isAgentRuntimeStatusActive,
  resolveAgentBusyState
} from "@/lib/agent-runtime-status";
import { AgentHeader } from "./AgentHeader";
import { AgentMessages } from "./AgentMessages";
import { AskUserQuestionPanel } from "./AskUserQuestionPanel";
import { ContextUsageBadge } from "./ContextUsageBadge";
import { PermissionModePopover } from "./PermissionModePopover";
import { AttachmentPreviewItem } from "@/components/chat/AttachmentPreviewItem";
import { ModelSelector } from "@/components/chat/ModelSelector";
import { ThinkingLevelPopoverContent } from "@/components/chat/ThinkingLevelPopoverContent";
import { THINKING_LEVEL_OPTIONS } from "@/components/chat/thinking-level";
import { RichTextInput } from "@/components/ai-elements/rich-text-input";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AgentSidePanel } from "./AgentSidePanel";
import { extractLatestAssistantText } from "./agent-session-lifecycle";
import { fileToBase64 } from "./agent-composer";
import { findLatestTodoItems, resolveTodoPanelExpanded, type TodoItem } from "./agent-team-activity";
import { useAgentInteractiveRequests } from "./hooks/useAgentInteractiveRequests";
import { useAgentPlanFlow } from "./hooks/useAgentPlanFlow";
import { useAgentComposer } from "./hooks/useAgentComposer";
import { useAgentRuntimeGuard } from "./hooks/useAgentRuntimeGuard";
import { useAgentSidePanelState } from "./hooks/useAgentSidePanelState";
import { useAgentStreamSubscriptions } from "./hooks/useAgentStreamSubscriptions";
import { useAgentSessionLifecycle } from "./hooks/useAgentSessionLifecycle";
import { SaveAsTaskDialog, type SaveAsTaskDialogData } from "./SaveAsTaskDialog";

function readDirectoryRecursive(
  dirEntry: FileSystemDirectoryEntry,
  basePath: string
): Promise<Array<{ relativePath: string; file: File }>> {
  return new Promise((resolve, reject) => {
    const results: Array<{ relativePath: string; file: File }> = [];
    const reader = dirEntry.createReader();

    const readBatch = (): void => {
      reader.readEntries(
        async (entries) => {
          if (entries.length === 0) {
            resolve(results);
            return;
          }

          for (const entry of entries) {
            if (entry.isFile) {
              const fileEntry = entry as FileSystemFileEntry;
              const file = await new Promise<File>((res, rej) => {
                fileEntry.file(res, rej);
              });
              results.push({ relativePath: `${basePath}/${entry.name}`, file });
            } else if (entry.isDirectory) {
              const subResults = await readDirectoryRecursive(
                entry as FileSystemDirectoryEntry,
                `${basePath}/${entry.name}`
              );
              results.push(...subResults);
            }
          }

          readBatch();
        },
        (error) => reject(error)
      );
    };

    readBatch();
  });
}

const ASK_USER_OTHER_OPTION = "__other__";

function isAgentDebugEnabled(): boolean {
  try {
    return window.localStorage.getItem("lume.debug.agent") === "1";
  } catch {
    return false;
  }
}

export function AgentView(): React.ReactElement {
  const [sessionId, setCurrentSessionId] = useAtom(currentAgentSessionIdAtom);
  const session = useAtomValue(currentAgentSessionAtom);
  const [workspaceId] = useAtom(currentAgentWorkspaceIdAtom);
  const [workspaces] = useAtom(agentWorkspacesAtom);
  const [messages, setMessages] = useAtom(currentAgentMessagesAtom);
  const setStreamingStates = useSetAtom(agentStreamingStatesAtom);
  const setRuntimeStatuses = useSetAtom(agentRuntimeStatusesAtom);
  const setAskUserQuestionRequests = useSetAtom(agentAskUserQuestionRequestsAtom);
  const setToolPermissionRequests = useSetAtom(agentToolPermissionRequestsAtom);
  const streamingStates = useAtomValue(agentStreamingStatesAtom);
  const setContextCache = useSetAtom(agentSessionContextCacheAtom);
  const streaming = useAtomValue(agentStreamingAtom);
  const toolActivities = useAtomValue(agentToolActivitiesAtom);
  const contextStatus = useAtomValue(agentContextStatusAtom);
  const [agentError] = useAtom(currentAgentErrorAtom);
  const currentRuntimeStatus = useAtomValue(currentAgentRuntimeStatusAtom);
  const askUserQuestionRequest = useAtomValue(currentAgentAskUserQuestionRequestAtom);
  const toolPermissionRequest = useAtomValue(currentAgentToolPermissionRequestAtom);
  const setActiveView = useSetAtom(activeViewAtom);
  const setSessions = useSetAtom(agentSessionsAtom);
  const setStreamErrors = useSetAtom(agentStreamErrorsAtom);

  const [agentChannelId, setAgentChannelId] = useAtom(agentChannelIdAtom);
  const [agentModelId, setAgentModelId] = useAtom(agentModelIdAtom);
  const [agentPermissionMode, setAgentPermissionMode] = useAtom(agentPermissionModeAtom);
  const [agentThinkingLevel, setAgentThinkingLevel] = useAtom(agentThinkingLevelAtom);
  const [pendingFiles, setPendingFiles] = useAtom(agentPendingFilesAtom);
  const [pendingPrompt, setPendingPrompt] = useAtom(agentPendingPromptAtom);
  const [inputContent, setInputContent] = useState("");
  const [isDragOver, setIsDragOver] = useState(false);
  const [pendingFolderRefs, setPendingFolderRefs] = useState<AgentSavedFile[]>([]);
  const [inlineEditingMessageId, setInlineEditingMessageId] = useState<string | null>(null);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [saveTaskDialogData, setSaveTaskDialogData] = useState<SaveAsTaskDialogData | null>(null);

  const [, setPlanState] = useAtom(planStateAtom);
  const {
    modeNotice,
    planSessionActive,
    enterPlan,
    appendPlanDraft,
    updatePlanDraft,
    exitPlan,
    applyPlanStateChanged,
    planStreamCaptureRef,
    currentSessionIdRef,
    lastNonPlanPermissionModeRef,
    currentPermissionModeRef,
    showModeNotice
  } = useAgentPlanFlow(sessionId, agentPermissionMode);
  const {
    currentWorkspace,
    sessionRootPath,
    sessionSwitching
  } = useAgentSessionLifecycle({
    setPendingFolderRefs,
    setInlineEditingMessageId,
    setInputContent
  });
  const hasSharedRuntimeStatus = currentRuntimeStatus !== null;
  const isAwaitingInteractiveInput = isAgentRuntimeAwaitingInput(currentRuntimeStatus);
  const isRuntimeActivePhase = isAgentRuntimeStatusActive(currentRuntimeStatus);
  const isAgentBusy = resolveAgentBusyState(currentRuntimeStatus, streaming);
  const runtimeStatusHint = useMemo(() => {
    if (toolPermissionRequest || askUserQuestionRequest) {
      return null;
    }
    return formatAgentRuntimeStatusHint(currentRuntimeStatus);
  }, [askUserQuestionRequest, currentRuntimeStatus, toolPermissionRequest]);

  const {
    currentSidePanelOpen,
    fileBrowserOpen,
    setCurrentSidePanelOpen,
    handleToggleFileBrowser
  } = useAgentSidePanelState(sessionId);

  // --- Todo 面板逻辑 ---
  const [todoPanelExpanded, setTodoPanelExpanded] = useState(true);
  const prevTodoItemsRef = useRef<TodoItem[] | null>(null);
  const latestTodoItems = useMemo(
    () => findLatestTodoItems(toolActivities, messages),
    [messages, toolActivities]
  );
  const todoProgressText = useMemo(() => {
    if (!latestTodoItems || latestTodoItems.length === 0) return null;
    const completed = latestTodoItems.filter((todo) => todo.status === "completed").length;
    return `${completed}/${latestTodoItems.length}`;
  }, [latestTodoItems]);
  useEffect(() => {
    if (!latestTodoItems || latestTodoItems.length === 0) return;
    const nextExpanded = resolveTodoPanelExpanded(prevTodoItemsRef.current, latestTodoItems);
    if (typeof nextExpanded === "boolean") {
      setTodoPanelExpanded(nextExpanded);
    }
    prevTodoItemsRef.current = latestTodoItems;
  }, [latestTodoItems]);

  const handleOpenSession = useCallback((targetSessionId: string): void => {
    startTransition(() => {
      setCurrentSessionId(targetSessionId);
    });
  }, [setCurrentSessionId]);

  const backendReady = agentChannelId !== null;
  const outgoingModelId = useMemo(() => {
    const trimmed = agentModelId?.trim();
    if (trimmed) return trimmed;
    return undefined;
  }, [agentModelId]);
  const lastAgentEventAtRef = useRef<Map<string, number>>(new Map());
  const pendingTitleRef = useRef(new Map<string, { userMessage: string; channelId: string; modelId: string }>());
  const {
    askUserAnswers,
    askUserError,
    askUserSubmitting,
    toolPermissionSubmitting,
    toolPermissionError,
    updateAskAnswerOption,
    updateAskOtherText,
    submitAskUserQuestion,
    cancelAskUserQuestion,
    submitToolPermissionDecision,
    setAskUserError,
    setToolPermissionError
  } = useAgentInteractiveRequests({
    sessionId,
    currentRuntimeStatus,
    askUserQuestionRequest,
    toolPermissionRequest,
    setAskUserQuestionRequests,
    setToolPermissionRequests
  });

  useAgentStreamSubscriptions({
    sessionId,
    agentPermissionMode,
    planSessionActive,
    streamingStates,
    currentSessionIdRef,
    lastNonPlanPermissionModeRef,
    currentPermissionModeRef,
    lastAgentEventAtRef,
    pendingTitleRef,
    planStreamCaptureRef,
    setMessages,
    setAskUserQuestionRequests,
    setRuntimeStatuses,
    setSessions,
    setPlanState,
    setStreamErrors,
    setStreamingStates,
    setToolPermissionRequests,
    setContextCache,
    setAgentPermissionMode,
    setAskUserError,
    setToolPermissionError,
    appendPlanDraft,
    updatePlanDraft,
    enterPlan,
    exitPlan,
    applyPlanStateChanged,
    showModeNotice
  });

  useAgentRuntimeGuard({
    sessionId,
    isAgentBusy,
    isAwaitingInteractiveInput,
    toolActivities,
    lastAgentEventAtRef,
    setMessages,
    setStreamErrors,
    setStreamingStates
  });

  const {
    addFilesAsAttachments,
    handleOpenFileDialog,
    handleOpenFolderDialog,
    handleRemoveFile,
    handleCompact,
    handleStop,
    handleSend,
    handleResendMessage,
    handleDeleteMessage,
    handleSubmitInlineEdit
  } = useAgentComposer({
    sessionId,
    sessionTitle: session?.title ?? "",
    currentWorkspaceSlug: currentWorkspace?.slug ?? null,
    currentWorkspaceId: currentWorkspace?.id ?? null,
    workspaceId,
    workspaces,
    backendReady,
    isAgentBusy,
    pendingPrompt,
    setPendingPrompt,
    inputContent,
    setInputContent,
    pendingFiles,
    setPendingFiles,
    pendingFolderRefs,
    setPendingFolderRefs,
    setMessages,
    setStreamErrors,
    setStreamingStates,
    setInlineEditingMessageId,
    enterPlan,
    agentChannelId,
    outgoingModelId,
    agentPermissionMode,
    agentThinkingLevel,
    planStreamCaptureRef,
    pendingTitleRef
  });

  const handleStartInlineEdit = useCallback((message: AgentMessage): void => {
    if (isAgentBusy) return;
    setInlineEditingMessageId(message.id);
  }, [isAgentBusy]);

  const handleCancelInlineEdit = useCallback((): void => {
    setInlineEditingMessageId(null);
  }, []);

  const handleSaveAsTask = useCallback((message: AgentMessage): void => {
    const prompt = (message.content ?? "").trim();
    if (!prompt) return;
    const defaultName = `Agent任务-${new Date().toLocaleDateString()}`;
    setSaveTaskDialogData({ prompt, defaultName });
  }, []);

  const handleSaveTaskConfirm = useCallback(async (name: string, cronExpr: string): Promise<void> => {
    if (!saveTaskDialogData) return;
    await createAutomationJob({
      name,
      workspaceId: currentWorkspace?.id ?? session?.workspaceId,
      schedule: {
        type: "cron",
        cronExpr
      },
      prompt: saveTaskDialogData.prompt
    });
    setSaveTaskDialogData(null);
  }, [saveTaskDialogData, currentWorkspace?.id, session?.workspaceId]);

  const handleModelSelect = useCallback((option: ModelOption): void => {
    setAgentChannelId(option.channelId);
    setAgentModelId(option.modelId);
    if (sessionId) {
      void updateAgentSessionModelSelection(sessionId, option.modelId, option.channelId)
        .then((updated) => {
          setSessions((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
        })
        .catch((error) => {
          console.error("[AgentView] update model selection failed", error);
        });
    }
  }, [sessionId, setAgentChannelId, setAgentModelId, setSessions]);

  const externalSelectedModel = useMemo(() => {
    if (!agentChannelId) return null;
    if (!agentModelId) return { channelId: agentChannelId, modelId: "" };
    return { channelId: agentChannelId, modelId: agentModelId };
  }, [agentChannelId, agentModelId]);

  const canSend = !!agentChannelId
    && !!outgoingModelId
    && (inputContent.trim().length > 0 || pendingFiles.length > 0 || pendingFolderRefs.length > 0)
    && backendReady
    && !isAgentBusy;

  if (!sessionId) {
    return (
      <div className="mx-auto flex h-full w-full max-w-[min(72rem,100%)] flex-col items-center justify-center gap-4 text-muted-foreground" style={{ zoom: 1.1 }}>
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
          <Bot size={32} className="text-muted-foreground/60" />
        </div>
        <div className="space-y-2 text-center">
          <h2 className="text-lg font-medium text-foreground">Agent 模式</h2>
          <p className="max-w-[300px] text-sm">从左侧点击“新会话”按钮创建一个 Agent 会话</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full">
      <div className="flex h-full overflow-hidden">
        <div className="mx-auto flex h-full min-w-0 max-w-[min(72rem,100%)] flex-1 flex-col">
          <AgentHeader
            onToggleFileBrowser={handleToggleFileBrowser}
            fileBrowserOpen={fileBrowserOpen}
            onOpenSession={handleOpenSession}
          />

          <AgentMessages
            isStreaming={isAgentBusy}
            isSwitching={sessionSwitching}
            inlineEditingMessageId={inlineEditingMessageId}
            onDeleteMessage={handleDeleteMessage}
            onResendMessage={handleResendMessage}
            onSaveAsTask={handleSaveAsTask}
            onStartInlineEdit={handleStartInlineEdit}
            onSubmitInlineEdit={handleSubmitInlineEdit}
            onCancelInlineEdit={handleCancelInlineEdit}
            onOpenSession={handleOpenSession}
          />

          {latestTodoItems && latestTodoItems.length > 0 ? (
            <div className="mb-2 ml-[72px] mr-4 inline-flex max-w-[calc(100%-5.5rem)] flex-col rounded-md border border-border/60 bg-muted/20 px-3 py-2">
              <button
                type="button"
                onClick={() => setTodoPanelExpanded((prev) => !prev)}
                className="inline-flex items-center gap-2 text-left"
              >
                {todoPanelExpanded ? (
                  <ChevronDown className="size-3.5 text-muted-foreground/70" />
                ) : (
                  <ChevronRight className="size-3.5 text-muted-foreground/70" />
                )}
                <span className="text-xs font-medium text-foreground/70">当前 Todo</span>
                {todoProgressText ? (
                  <span className="ml-2 text-[11px] tabular-nums text-foreground/50">{todoProgressText}</span>
                ) : null}
              </button>
              {todoPanelExpanded ? (
                <div className="mt-2 space-y-1">
                  {latestTodoItems.map((todo, index) => (
                    <div
                      key={`${todo.content}-${index}`}
                      className={cn(
                        "flex items-center gap-2 text-[13px]",
                        todo.status === "completed" && "opacity-60"
                      )}
                    >
                      {todo.status === "pending" ? <Circle className="size-3 text-muted-foreground/60" /> : null}
                      {todo.status === "in_progress" ? <Loader2 className="size-3 animate-spin text-blue-500" /> : null}
                      {todo.status === "completed" ? <CheckCircle2 className="size-3 text-green-500" /> : null}
                      <span className={cn("break-words", todo.status === "completed" && "line-through")}>
                        {todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.content}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

        {modeNotice ? (
          <div className="mx-4 mb-2 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-foreground/80">
            {modeNotice}
          </div>
        ) : null}

        {runtimeStatusHint ? (
          <div className="mx-4 mb-2 rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-xs text-foreground/75">
            {runtimeStatusHint}
          </div>
        ) : null}

        {agentError ? (
          <div className="mx-4 mb-2 flex items-center gap-2 rounded-lg bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
            <AlertCircle className="size-4 shrink-0" />
            <span className="flex-1 break-all">{agentError}</span>
            <button
              type="button"
              className="shrink-0 rounded p-0.5 transition-colors hover:bg-destructive/10"
              onClick={() => {
                setStreamErrors((prev) => {
                  const map = new Map(prev);
                  map.delete(sessionId);
                  return map;
                });
              }}
            >
              <X className="size-3.5" />
            </button>
          </div>
        ) : null}

        <div className="px-2.5 pb-2.5 pt-2 md:px-[18px] md:pb-[18px]">
          <div
            className={cn(
              "rounded-[17px] border-[0.5px] border-border bg-background/70 pt-2 backdrop-blur-sm transition-all duration-200",
              isDragOver && "border-[2px] border-dashed border-[#2ecc71] bg-[#2ecc71]/[0.03]"
            )}
            onDragOver={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setIsDragOver(true);
            }}
            onDragLeave={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setIsDragOver(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setIsDragOver(false);
              const items = Array.from(event.dataTransfer.items ?? []);
              const regularFiles: File[] = [];
              const folderEntries: FileSystemDirectoryEntry[] = [];

              for (const item of items) {
                if (item.kind !== "file") continue;
                const entry = item.webkitGetAsEntry?.();
                if (entry?.isDirectory) {
                  folderEntries.push(entry as FileSystemDirectoryEntry);
                } else {
                  const file = item.getAsFile();
                  if (file) regularFiles.push(file);
                }
              }

              if (regularFiles.length > 0) {
                void addFilesAsAttachments(regularFiles);
              }

              if (folderEntries.length > 0 && sessionId && workspaceId) {
                const workspace = workspaces.find((item) => item.id === workspaceId);
                if (!workspace) return;

                for (const dirEntry of folderEntries) {
                  void (async () => {
                    try {
                      const files = await readDirectoryRecursive(dirEntry, dirEntry.name);
                      if (files.length === 0) return;

                      const payload = await Promise.all(
                        files.map(async ({ relativePath, file }) => ({
                          filename: relativePath,
                          data: await fileToBase64(file)
                        }))
                      );

                      const saved = await saveFilesToAgentSession({
                        workspaceSlug: workspace.slug,
                        sessionId,
                        files: payload
                      });
                      setPendingFolderRefs((prev) => [...prev, ...saved]);
                    } catch (error) {
                      console.error("[AgentView] drop folder failed", error);
                    }
                  })();
                }
              }
            }}
          >
            {!agentChannelId ? (
              <div className="flex items-center gap-2 px-4 py-2 text-sm text-amber-600 dark:text-amber-400">
                <Settings size={14} />
                <span>请在设置中选择 Agent 供应商</span>
                <button
                  type="button"
                  className="text-xs underline underline-offset-2 transition-colors hover:text-foreground"
                  onClick={() => setActiveView("settings")}
                >
                  前往设置
                </button>
              </div>
            ) : null}

            {pendingFiles.length > 0 ? (
              <div className="flex flex-wrap gap-2 px-3 pb-1.5">
                {pendingFiles.map((file) => (
                  <AttachmentPreviewItem
                    key={file.id}
                    filename={file.filename}
                    mediaType={file.mediaType}
                    previewUrl={file.previewUrl}
                    onRemove={() => handleRemoveFile(file.id)}
                  />
                ))}
              </div>
            ) : null}

            {pendingFolderRefs.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 px-3 pb-1.5">
                <div className="flex items-center gap-1.5 rounded-md bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                  <FolderPlus className="size-3.5" />
                  <span>已附加 {pendingFolderRefs.length} 个文件</span>
                  <button
                    type="button"
                    className="ml-1 text-muted-foreground/60 transition-colors hover:text-foreground"
                    onClick={() => setPendingFolderRefs([])}
                  >
                    ×
                  </button>
                </div>
              </div>
            ) : null}

            <RichTextInput
              value={inputContent}
              onChange={setInputContent}
              onSubmit={() => { void handleSend(); }}
              onPasteFiles={(files) => { void addFilesAsAttachments(files); }}
              placeholder={backendReady ? "输入消息... (Enter 发送，Shift+Enter 换行)" : "请先在设置中选择 Agent 供应商"}
              disabled={!backendReady}
            />

            <div className="flex h-[40px] items-center justify-between gap-4 px-2 py-[5px]">
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                {backendReady ? (
                  <>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-[30px] rounded-full text-foreground/60 hover:text-foreground"
                          onClick={() => { void handleOpenFileDialog(); }}
                        >
                          <Paperclip className="size-5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top"><p>添加附件</p></TooltipContent>
                    </Tooltip>

                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-[30px] rounded-full text-foreground/60 hover:text-foreground"
                          onClick={() => { void handleOpenFolderDialog(); }}
                        >
                          <FolderPlus className="size-5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top"><p>添加文件夹</p></TooltipContent>
                    </Tooltip>
                  </>
                ) : null}

                {backendReady ? (
            <ModelSelector
              externalSelectedModel={externalSelectedModel}
              onModelSelect={handleModelSelect}
            />
                ) : null}

                {backendReady ? (
                  <PermissionModePopover />
                ) : null}

                {backendReady ? (
                  <Popover open={thinkingOpen} onOpenChange={setThinkingOpen}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <PopoverTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className={cn(
                              "size-[30px] rounded-full",
                              agentThinkingLevel !== "off"
                                ? "text-sky-500"
                                : "text-foreground/60 hover:text-foreground"
                            )}
                          >
                            <Lightbulb className="size-5" />
                          </Button>
                        </PopoverTrigger>
                      </TooltipTrigger>
                      <TooltipContent side="top"><p>思考等级</p></TooltipContent>
                    </Tooltip>

                    <PopoverContent
                      align="start"
                      side="top"
                      sideOffset={12}
                      className="w-auto border-none bg-transparent p-0 shadow-none"
                    >
                      <ThinkingLevelPopoverContent
                        value={agentThinkingLevel}
                        options={THINKING_LEVEL_OPTIONS}
                        onSelect={(value) => {
                          setAgentThinkingLevel(value);
                          setThinkingOpen(false);
                        }}
                      />
                    </PopoverContent>
                  </Popover>
                ) : null}

                {backendReady ? (
                  <ContextUsageBadge
                    totalTokens={contextStatus.totalTokens}
                    contextWindow={contextStatus.contextWindow}
                    isCompacting={contextStatus.isCompacting}
                    isProcessing={isAgentBusy}
                    onCompact={handleCompact}
                  />
                ) : null}
              </div>

              <div className="flex items-center gap-1.5">
                {isAgentBusy ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-[30px] rounded-full text-destructive hover:bg-destructive/10"
                    onClick={handleStop}
                  >
                    <Square className="size-[22px]" />
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={cn(
                      "size-[30px] rounded-full",
                      canSend ? "text-primary hover:bg-primary/10" : "cursor-not-allowed text-foreground/30"
                    )}
                    onClick={() => { void handleSend(); }}
                    disabled={!canSend}
                  >
                    <CornerDownLeft className="size-[22px]" />
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

          <AgentSidePanel
            sessionId={sessionId}
            sessionPath={sessionRootPath}
            workspaceSlug={currentWorkspace?.slug ?? null}
            open={currentSidePanelOpen}
            onOpenChange={setCurrentSidePanelOpen}
          />
        </div>
      {askUserQuestionRequest ? (
        <AskUserQuestionPanel
          request={askUserQuestionRequest}
          answers={askUserAnswers}
          error={askUserError}
          submitting={askUserSubmitting}
          onUpdateAnswerOption={updateAskAnswerOption}
          onUpdateOtherText={updateAskOtherText}
          onSubmit={() => { void submitAskUserQuestion(); }}
          onCancel={() => { void cancelAskUserQuestion(); }}
        />
      ) : null}
      {toolPermissionRequest ? (
        <div className="absolute inset-x-0 bottom-0 z-40 p-3 md:p-4">
          <div className="mx-auto max-w-2xl rounded-xl border border-border/80 bg-background shadow-2xl">
            <div className="border-b border-border/60 px-4 py-3">
              <div className="text-sm font-medium text-foreground">工具权限确认</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {toolPermissionRequest.reason}
              </div>
            </div>
            <div className="space-y-2 px-4 py-3">
              <div className="text-xs text-muted-foreground">工具：{toolPermissionRequest.toolName}</div>
              {toolPermissionRequest.originSessionId || toolPermissionRequest.subagentRunId ? (
                <div className="text-xs text-muted-foreground">
                  {toolPermissionRequest.originSessionId ? `来源会话: ${toolPermissionRequest.originSessionId}` : ""}
                  {toolPermissionRequest.originSessionId && toolPermissionRequest.subagentRunId ? " · " : ""}
                  {toolPermissionRequest.subagentRunId ? `Run: ${toolPermissionRequest.subagentRunId}` : ""}
                </div>
              ) : null}
              <pre className="max-h-40 overflow-auto rounded-md bg-muted/40 p-2 text-xs text-foreground">
                {JSON.stringify(toolPermissionRequest.input, null, 2)}
              </pre>
              {toolPermissionError ? (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1 text-xs text-destructive">
                  {toolPermissionError}
                </div>
              ) : null}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-border/60 px-4 py-3">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={toolPermissionSubmitting}
                onClick={() => { void submitToolPermissionDecision("deny"); }}
              >
                拒绝
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={toolPermissionSubmitting}
                onClick={() => { void submitToolPermissionDecision("allow_once"); }}
              >
                允许一次
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={toolPermissionSubmitting}
                onClick={() => { void submitToolPermissionDecision("allow_always"); }}
              >
                总是允许
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <SaveAsTaskDialog
        data={saveTaskDialogData}
        onClose={() => setSaveTaskDialogData(null)}
        onConfirm={handleSaveTaskConfirm}
      />
    </div>
  );
}
