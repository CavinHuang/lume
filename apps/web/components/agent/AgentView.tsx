"use client";

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { AlertCircle, Bot, CheckCircle2, ChevronDown, ChevronRight, Circle, CornerDownLeft, FolderPlus, Loader2, Paperclip, Settings, Square, X } from "lucide-react";
import type {
  AgentAskUserQuestionRequest,
  AgentToolPermissionRequest,
  AgentMessage,
  AgentPendingFile,
  AgentSavedFile,
  Channel,
  ModelOption
} from "@lume/shared";
import {
  activeViewAtom,
  agentContextStatusAtom,
  agentSessionsAtom,
  agentChannelIdAtom,
  agentModelIdAtom,
  agentPendingFilesAtom,
  agentPendingPromptAtom,
  agentPermissionModeAtom,
  agentStreamingAtom,
  agentStreamErrorsAtom,
  agentToolActivitiesAtom,
  agentStreamingStatesAtom,
  agentSessionContextCacheAtom,
  agentWorkspacesAtom,
  applyAgentEvent,
  currentAgentErrorAtom,
  currentAgentMessagesAtom,
  currentAgentSessionAtom,
  currentAgentSessionIdAtom,
  currentAgentWorkspaceIdAtom
} from "@/atoms";
import {
  planStateAtom,
  enterPlanModeAtom,
  updatePlanDraftAtom,
  appendPlanDraftAtom,
  exitPlanModeAtom,
  applyPlanStateChangedAtom,
  resetPlanStateAtom
} from "@/atoms/plan-atoms";
import {
  createAutomationJob,
  getAgentSessionMessages,
  getAgentSessionPath,
  listAgentSessions,
  listChannels,
  onAgentStreamComplete,
  onAgentStreamError,
  onAgentStreamEvent,
  onAgentMessageAppended,
  onAgentAskUserQuestion,
  onAgentPlanStateChanged,
  onAgentToolPermissionRequest,
  onAgentTitleUpdated,
  openFolderDialog,
  openChatFileDialog,
  copyFolderToAgentSession,
  saveFilesToAgentSession,
  sendAgentMessage,
  truncateAgentMessagesFrom,
  submitAgentAskUserQuestionAnswers,
  submitAgentToolPermission,
  stopAgentRun
} from "@/lib/desktop-api";
import { cn } from "@/lib/utils";
import { AgentHeader } from "./AgentHeader";
import { AgentMessages } from "./AgentMessages";
import type { AgentInlineEditSubmitPayload } from "./AgentMessages";
import { AskUserQuestionPanel } from "./AskUserQuestionPanel";
import { ContextUsageBadge } from "./ContextUsageBadge";
import { AttachmentPreviewItem } from "@/components/chat/AttachmentPreviewItem";
import { ModelSelector } from "@/components/chat/ModelSelector";
import { RichTextInput } from "@/components/ai-elements/rich-text-input";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AgentSidePanel, type AgentSidePanelTab } from "./AgentSidePanel";
import { buildTeamActivitiesFromSession } from "./team-activity";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.includes(",") ? result.split(",")[1] ?? "" : "");
    };
    reader.onerror = () => reject(reader.error ?? new Error("read file failed"));
    reader.readAsDataURL(file);
  });
}

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

function splitAttachedFiles(content: string): { block: string | null; text: string } {
  const regex = /<attached_files>\n?([\s\S]*?)\n?<\/attached_files>\n*/;
  const match = content.match(regex);
  if (!match) return { block: null, text: content };
  const blockBody = match[1] ?? "";
  const block = `<attached_files>\n${blockBody}\n</attached_files>`;
  const text = content.replace(regex, "").trim();
  return { block, text };
}

function isAgentDebugEnabled(): boolean {
  try {
    return window.localStorage.getItem("lume.debug.agent") === "1";
  } catch {
    return false;
  }
}

function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseExitPlanResult(result: string): {
  planPath: string | null;
  slug?: string;
  metadata?: {
    summary?: string;
    estimatedFiles?: number;
    estimatedLines?: number;
  };
} {
  const findPlanPayload = (value: unknown): Record<string, unknown> | null => {
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (typeof record.planPath === "string" && record.planPath.trim().length > 0) {
      return record;
    }
    if (record.details && typeof record.details === "object") {
      const nested = findPlanPayload(record.details);
      if (nested) return nested;
    }
    if (Array.isArray(record.content)) {
      for (const item of record.content) {
        if (!item || typeof item !== "object") continue;
        const text = (item as { text?: unknown }).text;
        if (typeof text !== "string") continue;
        const parsed = tryParseJson(text);
        const nested = findPlanPayload(parsed);
        if (nested) return nested;
      }
    }
    return null;
  };

  const parsed = tryParseJson(result);
  const payload = parsed ? findPlanPayload(parsed) : null;
  if (!payload) {
    return { planPath: null };
  }

  const planPath = typeof payload.planPath === "string" ? payload.planPath.trim() : "";
  const slug = typeof payload.slug === "string" ? payload.slug.trim() : "";
  const summary = typeof payload.summary === "string" ? payload.summary.trim() : "";
  const estimatedFiles = typeof payload.estimatedFiles === "number" ? payload.estimatedFiles : undefined;
  const estimatedLines = typeof payload.estimatedLines === "number" ? payload.estimatedLines : undefined;

  return {
    planPath: planPath || null,
    slug: slug || undefined,
    metadata: summary || estimatedFiles !== undefined || estimatedLines !== undefined
      ? {
        ...(summary ? { summary } : {}),
        ...(estimatedFiles !== undefined ? { estimatedFiles } : {}),
        ...(estimatedLines !== undefined ? { estimatedLines } : {})
      }
      : undefined
  };
}

function extractLatestAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== "assistant") continue;
    const text = (message.content ?? "").trim();
    if (text.length > 0) return text;
  }
  return "";
}

function recoverPlanFromMessages(messages: AgentMessage[]): {
  planPath: string | null;
  draft: string;
} {
  let hasPlanSignal = false;
  let latestAssistantText = "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === "assistant" && latestAssistantText.length === 0) {
      const text = (message.content ?? "").trim();
      if (text.length > 0) {
        latestAssistantText = text;
      }
    }
    if (!message || !message.events) continue;
    for (let j = message.events.length - 1; j >= 0; j -= 1) {
      const event = message.events[j];
      if (!event) continue;
      if (event.type === "tool_start" && event.toolName === "EnterPlanMode") {
        hasPlanSignal = true;
        continue;
      }
      if (event.type === "tool_result" && event.toolName === "ExitPlanMode" && !event.isError) {
        hasPlanSignal = true;
      }
      if (event.type !== "tool_result" || event.isError || event.toolName !== "ExitPlanMode") {
        continue;
      }
      const parsed = parseExitPlanResult(event.result);
      const messageText = (message.content ?? "").trim();
      if (messageText.length > 0) {
        return { planPath: parsed.planPath, draft: messageText };
      }
      for (let k = i - 1; k >= 0; k -= 1) {
        const prev = messages[k];
        if (!prev || prev.role !== "assistant") continue;
        const prevText = (prev.content ?? "").trim();
        if (prevText.length > 0) {
          return { planPath: parsed.planPath, draft: prevText };
        }
      }
      return { planPath: parsed.planPath, draft: "" };
    }
  }
  if (hasPlanSignal && latestAssistantText.length > 0) {
    return { planPath: null, draft: latestAssistantText };
  }
  return { planPath: null, draft: "" };
}

export function AgentView(): React.ReactElement {
  const [sessionId] = useAtom(currentAgentSessionIdAtom);
  const session = useAtomValue(currentAgentSessionAtom);
  const [workspaceId] = useAtom(currentAgentWorkspaceIdAtom);
  const [workspaces] = useAtom(agentWorkspacesAtom);
  const [messages, setMessages] = useAtom(currentAgentMessagesAtom);
  const setStreamingStates = useSetAtom(agentStreamingStatesAtom);
  const setContextCache = useSetAtom(agentSessionContextCacheAtom);
  const streaming = useAtomValue(agentStreamingAtom);
  const toolActivities = useAtomValue(agentToolActivitiesAtom);
  const contextStatus = useAtomValue(agentContextStatusAtom);
  const [agentError] = useAtom(currentAgentErrorAtom);
  const setActiveView = useSetAtom(activeViewAtom);
  const setSessions = useSetAtom(agentSessionsAtom);
  const setStreamErrors = useSetAtom(agentStreamErrorsAtom);

  const [channels, setChannels] = useState<Channel[]>([]);
  const [agentChannelId, setAgentChannelId] = useAtom(agentChannelIdAtom);
  const [agentModelId, setAgentModelId] = useAtom(agentModelIdAtom);
  const [agentPermissionMode, setAgentPermissionMode] = useAtom(agentPermissionModeAtom);
  const [pendingFiles, setPendingFiles] = useAtom(agentPendingFilesAtom);
  const [pendingPrompt, setPendingPrompt] = useAtom(agentPendingPromptAtom);
  const [inputContent, setInputContent] = useState("");
  const [sessionRootPath, setSessionRootPath] = useState<string | null>(null);
  const [sidePanelOpenMap, setSidePanelOpenMap] = useState<Map<string, boolean>>(new Map());
  const [sidePanelTabMap, setSidePanelTabMap] = useState<Map<string, AgentSidePanelTab>>(new Map());
  const [isDragOver, setIsDragOver] = useState(false);
  const [pendingFolderRefs, setPendingFolderRefs] = useState<AgentSavedFile[]>([]);
  const [inlineEditingMessageId, setInlineEditingMessageId] = useState<string | null>(null);
  const [modeNotice, setModeNotice] = useState<string | null>(null);
  const [askUserQuestionRequest, setAskUserQuestionRequest] = useState<AgentAskUserQuestionRequest | null>(null);
  const [askUserAnswers, setAskUserAnswers] = useState<Record<string, { selected: string[]; otherText: string }>>({});
  const [askUserError, setAskUserError] = useState<string | null>(null);
  const [askUserSubmitting, setAskUserSubmitting] = useState(false);
  const [toolPermissionRequest, setToolPermissionRequest] = useState<AgentToolPermissionRequest | null>(null);
  const [toolPermissionSubmitting, setToolPermissionSubmitting] = useState(false);
  const [toolPermissionError, setToolPermissionError] = useState<string | null>(null);

  // Plan 状态 - 使用统一的 plan-atoms
  const [planState, setPlanState] = useAtom(planStateAtom);

  // 派生状态（提前提取，避免循环依赖）
  const planSessionActive = planState.sessionActive;

  const enterPlan = useSetAtom(enterPlanModeAtom);
  const appendPlanDraft = useSetAtom(appendPlanDraftAtom);
  const updatePlanDraft = useSetAtom(updatePlanDraftAtom);
  const exitPlan = useSetAtom(exitPlanModeAtom);
  const applyPlanStateChanged = useSetAtom(applyPlanStateChangedAtom);
  const resetPlan = useSetAtom(resetPlanStateAtom);

  const planStreamCaptureRef = useRef(false);
  const currentWorkspace = useMemo(() => {
    const preferredWorkspaceId = workspaceId ?? session?.workspaceId ?? null;
    if (preferredWorkspaceId) {
      const hit = workspaces.find((item) => item.id === preferredWorkspaceId);
      if (hit) return hit;
    }
    if (session?.workspaceId) {
      const fromSession = workspaces.find((item) => item.id === session.workspaceId);
      if (fromSession) return fromSession;
    }
    return null;
  }, [workspaceId, session?.workspaceId, workspaces]);

  type TodoItem = {
    content: string;
    status: "pending" | "in_progress" | "completed";
    activeForm?: string;
  };

  const [todoPanelExpanded, setTodoPanelExpanded] = useState(true);
  const prevTodoItemsRef = useRef<TodoItem[] | null>(null);

  const parseTodoItemsFromInput = useCallback((input: Record<string, unknown>): TodoItem[] | null => {
    if (!Array.isArray(input.todos)) return null;
    const todos = (input.todos as Array<Record<string, unknown>>).map((todo) => ({
      content: String(todo.subject ?? todo.content ?? ""),
      status: (todo.status as TodoItem["status"]) ?? "pending",
      activeForm: typeof todo.activeForm === "string" ? todo.activeForm : undefined
    })).filter((todo) => todo.content.trim().length > 0);
    return todos.length > 0 ? todos : null;
  }, []);

  const latestTodoItems = useMemo(() => {
    for (let i = toolActivities.length - 1; i >= 0; i--) {
      const activity = toolActivities[i];
      if (!activity) continue;
      if (activity.toolName !== "TodoWrite" && activity.toolName !== "TaskCreate") continue;
      const todos = parseTodoItemsFromInput(activity.input);
      if (todos) return todos;
    }

    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (!message || message.role !== "assistant" || !message.events) continue;
      for (let j = message.events.length - 1; j >= 0; j--) {
        const event = message.events[j];
        if (!event || event.type !== "tool_start") continue;
        if (event.toolName !== "TodoWrite" && event.toolName !== "TaskCreate") continue;
        const todos = parseTodoItemsFromInput(event.input);
        if (todos) return todos;
      }
    }

    return null;
  }, [messages, parseTodoItemsFromInput, toolActivities]);

  const teamActivities = useMemo(
    () => buildTeamActivitiesFromSession(messages, toolActivities),
    [messages, toolActivities]
  );

  const todoProgressText = useMemo(() => {
    if (!latestTodoItems || latestTodoItems.length === 0) return null;
    const completed = latestTodoItems.filter((todo) => todo.status === "completed").length;
    return `${completed}/${latestTodoItems.length}`;
  }, [latestTodoItems]);

  const currentSidePanelOpen = sessionId ? sidePanelOpenMap.get(sessionId) ?? false : false;
  const currentSidePanelTab = sessionId ? sidePanelTabMap.get(sessionId) ?? "team" : "team";
  const fileBrowserOpen = currentSidePanelOpen && currentSidePanelTab === "files";

  const setCurrentSidePanelOpen = useCallback((open: boolean): void => {
    if (!sessionId) return;
    setSidePanelOpenMap((prev) => {
      const map = new Map(prev);
      map.set(sessionId, open);
      return map;
    });
  }, [sessionId]);

  const setCurrentSidePanelTab = useCallback((tab: AgentSidePanelTab): void => {
    if (!sessionId) return;
    setSidePanelTabMap((prev) => {
      const map = new Map(prev);
      map.set(sessionId, tab);
      return map;
    });
  }, [sessionId]);

  const handleToggleFileBrowser = useCallback((): void => {
    if (!sessionId) return;
    if (currentSidePanelOpen && currentSidePanelTab === "files") {
      setCurrentSidePanelOpen(false);
      return;
    }
    setCurrentSidePanelTab("files");
    setCurrentSidePanelOpen(true);
  }, [
    currentSidePanelOpen,
    currentSidePanelTab,
    sessionId,
    setCurrentSidePanelOpen,
    setCurrentSidePanelTab
  ]);

  // 自动展开/收起 todo 面板
  useEffect(() => {
    if (!latestTodoItems || latestTodoItems.length === 0) return;

    const allCompleted = latestTodoItems.every((todo) => todo.status === "completed");
    const prevItems = prevTodoItemsRef.current;
    const isInitialLoad = prevItems === null;

    if (isInitialLoad) {
      // 首次加载：全部完成则收起，否则展开
      setTodoPanelExpanded(!allCompleted);
    } else {
      // 后续更新：检测状态变化
      // 检查是否是新的 todo 写入（内容不同）
      const isNewTodo = prevItems.length !== latestTodoItems.length ||
        prevItems.some((prev, idx) => prev.content !== latestTodoItems[idx]?.content);

      // 检查是否从非完成状态变为完成状态
      const wasNotAllCompleted = !prevItems.every((todo) => todo.status === "completed");

      if (isNewTodo && !allCompleted) {
        // 新的 todo 写入，展开面板
        setTodoPanelExpanded(true);
      } else if (wasNotAllCompleted && allCompleted) {
        // 所有 todo 完成，收起面板
        setTodoPanelExpanded(false);
      }
    }

    prevTodoItemsRef.current = latestTodoItems;
  }, [latestTodoItems]);
  const backendReady = agentChannelId !== null;
  const outgoingModelId = useMemo(() => {
    const trimmed = agentModelId?.trim();
    if (trimmed) return trimmed;
    return undefined;
  }, [agentModelId]);

  const currentSessionIdRef = useRef<string | null>(sessionId);
  const lastNonPlanPermissionModeRef = useRef(agentPermissionMode);
  const currentPermissionModeRef = useRef(agentPermissionMode);
  const modeNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAgentEventAtRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    currentSessionIdRef.current = sessionId;
  }, [sessionId]);
  useEffect(() => {
    if (agentPermissionMode !== "plan") {
      lastNonPlanPermissionModeRef.current = agentPermissionMode;
    }
    currentPermissionModeRef.current = agentPermissionMode;
  }, [agentPermissionMode]);
  const showModeNotice = useCallback((text: string): void => {
    setModeNotice(text);
    if (modeNoticeTimerRef.current) {
      clearTimeout(modeNoticeTimerRef.current);
    }
    modeNoticeTimerRef.current = setTimeout(() => {
      setModeNotice(null);
      modeNoticeTimerRef.current = null;
    }, 2600);
  }, []);
  useEffect(() => () => {
    if (modeNoticeTimerRef.current) {
      clearTimeout(modeNoticeTimerRef.current);
    }
  }, []);
  useEffect(() => {
    if (!askUserQuestionRequest) return;
    const initial: Record<string, { selected: string[]; otherText: string }> = {};
    for (const question of askUserQuestionRequest.questions) {
      initial[question.header] = { selected: [], otherText: "" };
    }
    setAskUserAnswers(initial);
    setAskUserError(null);
    setAskUserSubmitting(false);
  }, [askUserQuestionRequest]);

  const updateAskAnswerOption = useCallback((header: string, label: string, checked: boolean, multiSelect: boolean): void => {
    setAskUserAnswers((prev) => {
      const current = prev[header] ?? { selected: [], otherText: "" };
      let nextSelected: string[];
      if (multiSelect) {
        nextSelected = checked
          ? [...new Set([...current.selected, label])]
          : current.selected.filter((item) => item !== label);
      } else {
        nextSelected = checked ? [label] : [];
      }
      return {
        ...prev,
        [header]: {
          ...current,
          selected: nextSelected
        }
      };
    });
  }, []);

  const updateAskOtherText = useCallback((header: string, text: string): void => {
    setAskUserAnswers((prev) => {
      const current = prev[header] ?? { selected: [], otherText: "" };
      return {
        ...prev,
        [header]: {
          ...current,
          otherText: text
        }
      };
    });
  }, []);

  const submitAskUserQuestion = useCallback(async (): Promise<void> => {
    if (!askUserQuestionRequest) return;
    const answers: Record<string, string> = {};
    for (const question of askUserQuestionRequest.questions) {
      const value = askUserAnswers[question.header] ?? { selected: [], otherText: "" };
      const selectedLabels = value.selected.filter((item) => item !== ASK_USER_OTHER_OPTION);
      const otherText = value.otherText.trim();
      let answerText = "";
      if (question.multiSelect) {
        const merged = [...selectedLabels];
        if (value.selected.includes(ASK_USER_OTHER_OPTION) && otherText) {
          merged.push(otherText);
        }
        answerText = merged.join(", ").trim();
      } else {
        const first = value.selected[0];
        answerText = first === ASK_USER_OTHER_OPTION ? otherText : (first ?? "");
      }
      if (!answerText) {
        setAskUserError(`请先回答「${question.header}」`);
        return;
      }
      answers[question.header] = answerText;
    }

    setAskUserSubmitting(true);
    setAskUserError(null);
    try {
      await submitAgentAskUserQuestionAnswers({
        sessionId: askUserQuestionRequest.sessionId,
        toolUseId: askUserQuestionRequest.toolUseId,
        answers
      });
      setAskUserQuestionRequest(null);
      setAskUserAnswers({});
    } catch (error) {
      setAskUserError(error instanceof Error ? error.message : "提交回答失败");
    } finally {
      setAskUserSubmitting(false);
    }
  }, [askUserQuestionRequest, askUserAnswers]);

  const cancelAskUserQuestion = useCallback(async (): Promise<void> => {
    if (!askUserQuestionRequest || askUserSubmitting) return;
    setAskUserSubmitting(true);
    setAskUserError(null);
    try {
      await submitAgentAskUserQuestionAnswers({
        sessionId: askUserQuestionRequest.sessionId,
        toolUseId: askUserQuestionRequest.toolUseId,
        canceled: true
      });
      setAskUserQuestionRequest(null);
      setAskUserAnswers({});
    } catch (error) {
      setAskUserError(error instanceof Error ? error.message : "取消提问失败");
    } finally {
      setAskUserSubmitting(false);
    }
  }, [askUserQuestionRequest, askUserSubmitting]);

  const submitToolPermissionDecision = useCallback(async (decision: "allow_once" | "allow_always" | "deny"): Promise<void> => {
    if (!toolPermissionRequest || toolPermissionSubmitting) return;
    setToolPermissionSubmitting(true);
    setToolPermissionError(null);
    try {
      await submitAgentToolPermission({
        sessionId: toolPermissionRequest.sessionId,
        requestId: toolPermissionRequest.requestId,
        decision
      });
      setToolPermissionRequest(null);
    } catch (error) {
      setToolPermissionError(error instanceof Error ? error.message : "提交工具权限失败");
    } finally {
      setToolPermissionSubmitting(false);
    }
  }, [toolPermissionRequest, toolPermissionSubmitting]);

  useEffect(() => {
    void listChannels().then((next) => setChannels(next));
  }, [setPendingFiles]);

  useEffect(() => {
    if (agentChannelId) return;
    const enabled = channels.filter((item) => item.enabled);
    const sessionChannel = session?.channelId ? enabled.find((item) => item.id === session.channelId) : undefined;
    const target = sessionChannel ?? enabled[0];
    if (!target) return;
    setAgentChannelId(target.id);
    const firstModel = target.models.find((model) => model.enabled);
    setAgentModelId(firstModel?.id ?? null);
  }, [agentChannelId, channels, session?.channelId]);

  useEffect(() => {
    if (channels.length === 0) return;
    if (!agentChannelId) {
      setAgentModelId(null);
      return;
    }
    const channel = channels.find((item) => item.id === agentChannelId && item.enabled);
    if (!channel) {
      setAgentModelId(null);
      return;
    }
    const modelValid = !!agentModelId && channel.models.some((model) => model.enabled && model.id === agentModelId);
    if (!modelValid) {
      setAgentModelId(channel.models.find((model) => model.enabled)?.id ?? null);
    }
  }, [agentChannelId, agentModelId, channels, setAgentModelId]);

  const [sessionSwitching, setSessionSwitching] = useState(false);

  useEffect(() => {
    if (!sessionId) {
      setMessages([]);
      setSessionRootPath(null);
      setToolPermissionRequest(null);
      resetPlan();
      setSessionSwitching(false);
      return;
    }

    // 标记切换中，保留旧消息避免闪白
    setSessionSwitching(true);
    setPendingFiles([]);
    setPendingFolderRefs([]);
    setInlineEditingMessageId(null);
    setInputContent("");
    setToolPermissionRequest(null);
    resetPlan();

    let cancelled = false;
    void getAgentSessionMessages(sessionId)
      .then((next) => {
        if (cancelled) return;
        // startTransition: 将消息列表渲染标记为可中断的低优先级更新，
        // 保持 spinner 可见直到 React 完成渲染，避免主线程长时间阻塞。
        startTransition(() => {
          setMessages(next);
          const recovered = recoverPlanFromMessages(next);
          if (recovered.planPath || recovered.draft) {
            setPlanState((prev) => ({
              ...prev,
              phase: "review",
              sessionActive: false,
              reviewOpen: false,
              file: recovered.planPath
                ? {
                  ...prev.file,
                  path: recovered.planPath,
                  savedAt: prev.file.savedAt ?? Date.now()
                }
                : prev.file,
              draft: recovered.draft
                ? {
                  content: recovered.draft,
                  updatedAt: Date.now()
                }
                : prev.draft
            }));
          }
          setSessionSwitching(false);
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setMessages([]);
        setSessionSwitching(false);
        const message = error instanceof Error ? error.message : String(error);
        setStreamErrors((prev) => {
          const map = new Map(prev);
          map.set(sessionId, `读取会话消息失败: ${message}`);
          return map;
        });
      });

    return () => { cancelled = true; };
  }, [resetPlan, sessionId, setMessages, setPlanState, setStreamErrors]);

  useEffect(() => {
    if (!sessionId || !workspaceId) {
      setSessionRootPath(null);
      return;
    }
    const workspace = currentWorkspace;
    if (!workspace) {
      setSessionRootPath(null);
      return;
    }
    void getAgentSessionPath(workspace.slug, sessionId)
      .then(setSessionRootPath)
      .catch(() => setSessionRootPath(null));
  }, [currentWorkspace, sessionId, workspaceId, workspaces]);

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    let disposed = false;
    if (isAgentDebugEnabled()) {
      console.info("[AgentDebug] subscribe stream listeners");
    }

    const trackUnlisten = (promise: Promise<() => void>): void => {
      void promise.then((fn) => {
        if (disposed) {
          void fn();
          return;
        }
        unsubs.push(fn);
      }).catch((error) => {
        console.error("[AgentView] subscribe stream failed:", error);
        if (isAgentDebugEnabled()) {
          console.error("[AgentDebug] subscribe failed", error);
        }
      });
    };

    const removeState = (targetSessionId: string): void => {
      lastAgentEventAtRef.current.delete(targetSessionId);
      setStreamingStates((prev) => {
        const map = new Map(prev);
        map.delete(targetSessionId);
        return map;
      });
    };

    const markStreamCompleted = (targetSessionId: string): void => {
      setStreamingStates((prev) => {
        const current = prev.get(targetSessionId);
        if (!current) return prev;
        const map = new Map(prev);
        map.set(targetSessionId, { ...current, running: false });
        return map;
      });
    };

    trackUnlisten(onAgentStreamEvent((payload) => {
      lastAgentEventAtRef.current.set(payload.sessionId, Date.now());
      if (isAgentDebugEnabled()) {
        console.info("[AgentDebug] stream:event", {
          sessionId: payload.sessionId,
          type: payload.event.type,
          event: payload.event
        });
      }
      // Plan Mode 工具事件触发权限模式切换：Enter -> plan，Exit(success) -> 恢复编辑模式
      if (payload.sessionId === currentSessionIdRef.current) {
        const event = payload.event;
        if (event.type === "tool_result" && !event.isError && event.toolName === "ExitPlanMode") {
          planStreamCaptureRef.current = false;
          const parsed = parseExitPlanResult(event.result);
          if (parsed.planPath || parsed.slug || parsed.metadata) {
            exitPlan({
              ...(parsed.planPath ? { planPath: parsed.planPath } : {}),
              ...(parsed.slug ? { slug: parsed.slug } : {}),
              ...(parsed.metadata ? { metadata: parsed.metadata } : {})
            });
          }
        } else if (event.type === "tool_start" && event.toolName === "EnterPlanMode") {
          planStreamCaptureRef.current = true;
        } else if ((event.type === "text_delta" || event.type === "text_complete") && !planStreamCaptureRef.current) {
          if (currentPermissionModeRef.current === "plan") {
            planStreamCaptureRef.current = true;
          }
        }
        if (event.type === "text_delta" && planStreamCaptureRef.current) {
          setPlanState((prev) => (
            prev.phase === "planning" && prev.sessionActive
              ? prev
              : {
                ...prev,
                phase: "planning",
                sessionActive: true,
                reviewOpen: false
              }
          ));
          // 使用新的 Atom 追加计划内容
          appendPlanDraft(event.text);
        } else if (event.type === "text_complete" && planStreamCaptureRef.current) {
          setPlanState((prev) => (
            prev.phase === "planning" && prev.sessionActive
              ? prev
              : {
                ...prev,
                phase: "planning",
                sessionActive: true,
                reviewOpen: false
              }
          ));
          updatePlanDraft(event.text);
        }
      }

    setStreamingStates((prev) => {
      const map = new Map(prev);
      const current = map.get(payload.sessionId) ?? {
          running: true,
          content: "",
          toolActivities: [],
          events: []
        };
        map.set(payload.sessionId, applyAgentEvent(current, payload.event));
        return map;
      });

      // 持久化 usage 到缓存，确保非流式状态下也能显示上下文用量
      if (payload.event.type === "usage_update") {
        const usageEvent = payload.event;
        setContextCache((prev) => {
          const map = new Map(prev);
          map.set(payload.sessionId, {
            inputTokens: usageEvent.usage.inputTokens,
            contextWindow: usageEvent.usage.contextWindow ?? prev.get(payload.sessionId)?.contextWindow
          });
          return map;
        });
      }
    }));

    trackUnlisten(onAgentStreamComplete((payload) => {
      lastAgentEventAtRef.current.set(payload.sessionId, Date.now());
      if (isAgentDebugEnabled()) {
        console.info("[AgentDebug] stream:complete", { sessionId: payload.sessionId });
      }
      markStreamCompleted(payload.sessionId);
      const finalize = (): void => {
        if (payload.sessionId === currentSessionIdRef.current) {
          setAskUserQuestionRequest(null);
          setToolPermissionRequest(null);
        }
        removeState(payload.sessionId);
        void listAgentSessions().then(setSessions);
      };

      if (payload.sessionId === currentSessionIdRef.current) {
        void getAgentSessionMessages(payload.sessionId)
          .then((next) => {
            startTransition(() => {
              if (planStreamCaptureRef.current) {
                const fallbackText = extractLatestAssistantText(next);
                if (fallbackText) {
                  setPlanState((prev) => (
                    prev.draft.content.trim().length > 0
                      ? prev
                      : {
                        ...prev,
                        draft: {
                          content: fallbackText,
                          updatedAt: Date.now()
                        }
                      }
                  ));
                }
              }
              // 去重：移除与新消息 ID 冲突的旧消息
              setMessages((prev) => {
                const nextIds = new Set(next.map(m => m.id));
                // 先过滤掉临时消息，再过滤重复的正式消息
                const filteredPrev = prev.filter(m => !m.id.startsWith('temp-'));
                return [...filteredPrev.filter(m => !nextIds.has(m.id)), ...next];
              });
              finalize();
            });
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            setStreamErrors((prev) => {
              const map = new Map(prev);
              map.set(payload.sessionId, `流结束后读取消息失败: ${message}`);
              return map;
            });
            finalize();
          });
      } else {
        finalize();
      }
    }));

    trackUnlisten(onAgentStreamError((payload) => {
      lastAgentEventAtRef.current.set(payload.sessionId, Date.now());
      if (isAgentDebugEnabled()) {
        console.info("[AgentDebug] stream:error", payload);
      }
      setStreamErrors((prev) => {
        const map = new Map(prev);
        map.set(payload.sessionId, payload.error);
        return map;
      });
      const finalize = (): void => {
        if (payload.sessionId === currentSessionIdRef.current) {
          setAskUserQuestionRequest(null);
          setToolPermissionRequest(null);
        }
        removeState(payload.sessionId);
      };

      if (payload.sessionId === currentSessionIdRef.current) {
        void getAgentSessionMessages(payload.sessionId)
          .then((next) => {
            startTransition(() => {
              setMessages(next);
              finalize();
            });
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            setStreamErrors((prev) => {
              const map = new Map(prev);
              map.set(payload.sessionId, `流错误后读取消息失败: ${message}`);
              return map;
            });
            finalize();
          });
      } else {
        finalize();
      }
    }));

    trackUnlisten(onAgentMessageAppended((payload) => {
      void listAgentSessions().then(setSessions);
      if (payload.sessionId !== currentSessionIdRef.current) {
        return;
      }
      startTransition(() => {
        setMessages((prev) => {
          if (prev.some((item) => item.id === payload.message.id)) {
            return prev;
          }
          return [...prev, payload.message];
        });
      });
    }));

    trackUnlisten(onAgentTitleUpdated((payload) => {
      setSessions((prev) => prev.map((item) => (
        item.id === payload.sessionId
          ? { ...item, title: payload.title, updatedAt: Date.now() }
          : item
      )));
      void listAgentSessions().then(setSessions).catch((error) => {
        console.warn("[AgentView] 刷新会话标题失败", error);
      });
    }));
    trackUnlisten(onAgentPlanStateChanged((payload) => {
      if (payload.sessionId !== currentSessionIdRef.current) return;
      if (payload.phase === "planning") {
        planStreamCaptureRef.current = true;
        enterPlan();
        setAgentPermissionMode("plan");
        applyPlanStateChanged(payload);
        showModeNotice("已进入 Plan Mode");
        return;
      }
      if (payload.phase === "review") {
        planStreamCaptureRef.current = false;
        const parsedPath = typeof payload.planPath === "string" ? payload.planPath : null;
        const fromPlanningStage = agentPermissionMode === "plan" || planSessionActive;
        if (fromPlanningStage) {
          exitPlan(parsedPath ? { planPath: parsedPath } : undefined);
        } else {
          applyPlanStateChanged(payload);
        }
        if (fromPlanningStage) {
          const fallbackMode = lastNonPlanPermissionModeRef.current === "plan"
            ? "default"
            : lastNonPlanPermissionModeRef.current;
          setAgentPermissionMode(fallbackMode);
          showModeNotice("计划已完成，进入执行阶段");
        } else {
          showModeNotice("计划执行已暂停，已回到待确认阶段。");
        }
        return;
      }
      if (payload.phase === "executing" || payload.phase === "executed") {
        if (payload.phase === "executed") {
          planStreamCaptureRef.current = false;
        }
        applyPlanStateChanged(payload);
      }
    }));

    trackUnlisten(onAgentAskUserQuestion((payload) => {
      if (payload.sessionId !== currentSessionIdRef.current) {
        return;
      }
      setAskUserError(null);
      setAskUserQuestionRequest(payload);
    }));
    trackUnlisten(onAgentToolPermissionRequest((payload) => {
      if (payload.sessionId !== currentSessionIdRef.current) {
        return;
      }
      setToolPermissionError(null);
      setToolPermissionRequest(payload);
    }));

    return () => {
      disposed = true;
      for (const fn of unsubs) fn();
    };
  }, [
    setMessages,
    setSessions,
    setPlanState,
    setStreamErrors,
    setStreamingStates,
    setAgentPermissionMode,
    showModeNotice,
    applyPlanStateChanged,
    planSessionActive,
    agentPermissionMode
  ]);

  useEffect(() => {
    if (!pendingPrompt) return;
    if (!sessionId || pendingPrompt.sessionId !== sessionId) return;
    if (!backendReady || streaming) return;

    const prompt = pendingPrompt;
    setPendingPrompt(null);

    const timer = setTimeout(() => {
      setStreamingStates((prev) => {
        const map = new Map(prev);
        map.set(sessionId, { running: true, content: "", toolActivities: [], events: [] });
        return map;
      });

      const tempUserMessage: AgentMessage = {
        id: `temp-${Date.now()}`,
        role: "user",
        content: prompt.message,
        createdAt: Date.now()
      };
      setMessages((prev) => [...prev, tempUserMessage]);
      planStreamCaptureRef.current = agentPermissionMode === "plan";
      if (agentPermissionMode === "plan") {
        enterPlan();
      }

      void sendAgentMessage({
        sessionId,
        userMessage: prompt.message,
        channelId: agentChannelId ?? undefined,
        modelId: agentModelId ?? undefined,
        workspaceId: workspaceId ?? undefined,
        sessionType: "main",
        chatType: "direct",
        permissionMode: agentPermissionMode
      }).catch((error) => {
        console.error("[AgentView] send pending prompt failed", error);
        setStreamingStates((prev) => {
          const map = new Map(prev);
          map.delete(sessionId);
          return map;
        });
      });
    }, 150);

    return () => clearTimeout(timer);
  }, [
    pendingPrompt,
    enterPlan,
    sessionId,
    backendReady,
    agentChannelId,
    agentModelId,
    agentPermissionMode,
    workspaceId,
    streaming,
    setPendingPrompt,
    setStreamingStates,
    setMessages
  ]);

  const addFilesAsAttachments = useCallback(async (files: File[]): Promise<void> => {
    for (const file of files) {
      try {
        const base64 = await fileToBase64(file);
        const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
        const pending: AgentPendingFile = {
          id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          filename: file.name,
          mediaType: file.type || "application/octet-stream",
          size: file.size,
          previewUrl
        };

        if (!window.__pendingAgentFileData) {
          window.__pendingAgentFileData = new Map<string, string>();
        }
        window.__pendingAgentFileData.set(pending.id, base64);
        setPendingFiles((prev) => [...prev, pending]);
      } catch (error) {
        console.error("[AgentView] add attachment failed", error);
      }
    }
  }, [setPendingFiles]);

  const handleOpenFileDialog = useCallback(async (): Promise<void> => {
    try {
      const result = await openChatFileDialog();
      if (result.files.length === 0) return;

      const next: AgentPendingFile[] = [];
      if (!window.__pendingAgentFileData) {
        window.__pendingAgentFileData = new Map<string, string>();
      }
      for (const fileInfo of result.files) {
        const id = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const previewUrl = fileInfo.mediaType.startsWith("image/")
          ? `data:${fileInfo.mediaType};base64,${fileInfo.data}`
          : undefined;
        next.push({
          id,
          filename: fileInfo.filename,
          mediaType: fileInfo.mediaType,
          size: fileInfo.size,
          previewUrl
        });
        window.__pendingAgentFileData.set(id, fileInfo.data);
      }
      setPendingFiles((prev) => [...prev, ...next]);
    } catch (error) {
      console.error("[AgentView] open file dialog failed", error);
    }
  }, [setPendingFiles]);

  const handleOpenFolderDialog = useCallback(async (): Promise<void> => {
    if (!sessionId || !workspaceId) return;
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (!workspace) return;

    try {
      const result = await openFolderDialog();
      if (!result.path) return;
      const saved = await copyFolderToAgentSession({
        sourcePath: result.path,
        workspaceSlug: workspace.slug,
        sessionId
      });
      setPendingFolderRefs((prev) => [...prev, ...saved]);
      return;
    } catch (error) {
      console.error("[AgentView] open native folder dialog failed", error);
    }
  }, [sessionId, workspaceId, workspaces]);

  const handleRemoveFile = useCallback((id: string): void => {
    setPendingFiles((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target?.previewUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(target.previewUrl);
      }
      window.__pendingAgentFileData?.delete(id);
      return prev.filter((item) => item.id !== id);
    });
  }, []);

  const handleCompact = useCallback((): void => {
    if (!sessionId || !agentChannelId || streaming) return;

    setStreamingStates((prev) => {
      const map = new Map(prev);
      map.set(sessionId, { running: true, content: "", toolActivities: [], events: [] });
      return map;
    });

    void sendAgentMessage({
      sessionId,
      userMessage: "/compact",
      channelId: agentChannelId,
      modelId: outgoingModelId,
      workspaceId: workspaceId ?? undefined,
      sessionType: "main",
      chatType: "direct",
      permissionMode: agentPermissionMode
    });
  }, [sessionId, agentChannelId, outgoingModelId, agentPermissionMode, workspaceId, streaming, setStreamingStates]);

  const handleStop = useCallback((): void => {
    if (!sessionId) return;

    setStreamingStates((prev) => {
      const current = prev.get(sessionId);
      if (!current) return prev;
      const map = new Map(prev);
      map.set(sessionId, { ...current, running: false });
      return map;
    });

    void stopAgentRun(sessionId);
  }, [sessionId, setStreamingStates]);

  const handleSend = useCallback(async (): Promise<void> => {
    const text = inputContent.trim();
    if ((!text && pendingFiles.length === 0 && pendingFolderRefs.length === 0) || !sessionId || !backendReady || streaming) {
      return;
    }

    setStreamErrors((prev) => {
      const map = new Map(prev);
      map.delete(sessionId);
      return map;
    });

    let fileReferences = "";
    const workspace = workspaces.find((item) => item.id === workspaceId);

    if (pendingFiles.length > 0 && workspace) {
      try {
        const files = pendingFiles.map((file) => ({
          filename: file.filename,
          data: window.__pendingAgentFileData?.get(file.id) || ""
        }));
        const saved = await saveFilesToAgentSession({
          workspaceSlug: workspace.slug,
          sessionId,
          files
        });
        const refs = saved.map((file) => `- ${file.filename}: ${file.targetPath}`).join("\n");
        fileReferences += `<attached_files>\n${refs}\n</attached_files>\n\n`;
      } catch (error) {
        console.error("[AgentView] save pending files failed", error);
      }

      for (const file of pendingFiles) {
        if (file.previewUrl?.startsWith("blob:")) {
          URL.revokeObjectURL(file.previewUrl);
        }
        window.__pendingAgentFileData?.delete(file.id);
      }
      setPendingFiles([]);
    }

    if (pendingFolderRefs.length > 0) {
      const refs = pendingFolderRefs.map((file) => `- ${file.filename}: ${file.targetPath}`).join("\n");
      fileReferences += `<attached_files>\n${refs}\n</attached_files>\n\n`;
      setPendingFolderRefs([]);
    }

    const finalMessage = `${fileReferences}${text}`;
    planStreamCaptureRef.current = agentPermissionMode === "plan";
    if (agentPermissionMode === "plan") {
      enterPlan();
    }

    setStreamingStates((prev) => {
      const map = new Map(prev);
      map.set(sessionId, {
        running: true,
        content: "",
        toolActivities: [],
        events: [],
        model: outgoingModelId
      });
      return map;
    });

    const tempMessage: AgentMessage = {
      id: `temp-${Date.now()}`,
      role: "user",
      content: finalMessage,
      createdAt: Date.now()
    };
    setMessages((prev) => [...prev, tempMessage]);
    setInputContent("");

    void sendAgentMessage({
      sessionId,
      userMessage: finalMessage,
      channelId: agentChannelId ?? undefined,
      modelId: outgoingModelId,
      workspaceId: workspaceId ?? undefined,
      sessionType: "main",
      chatType: "direct",
      permissionMode: agentPermissionMode
    }).catch((error) => {
      console.error("[AgentView] send failed", error);
      const message = error instanceof Error ? error.message : String(error);
      setStreamErrors((prev) => {
        const map = new Map(prev);
        map.set(sessionId, `发送失败: ${message}`);
        return map;
      });
      setStreamingStates((prev) => {
        if (!prev.has(sessionId)) return prev;
        const map = new Map(prev);
        map.delete(sessionId);
        return map;
      });
    });
  }, [
    enterPlan,
    inputContent,
    pendingFiles,
    pendingFolderRefs,
    sessionId,
    backendReady,
    agentChannelId,
    outgoingModelId,
    agentPermissionMode,
    workspaceId,
    workspaces,
    streaming,
    setStreamErrors,
    setStreamingStates,
    setMessages
  ]);

  const sendFromMessageContent = useCallback((content: string, messageMetadata?: Record<string, unknown>): void => {
    if (!sessionId || !backendReady || streaming) return;
    planStreamCaptureRef.current = agentPermissionMode === "plan";
    if (agentPermissionMode === "plan") {
      enterPlan();
    }

    setStreamErrors((prev) => {
      const map = new Map(prev);
      map.delete(sessionId);
      return map;
    });
    setStreamingStates((prev) => {
      const map = new Map(prev);
      map.set(sessionId, {
        running: true,
        content: "",
        toolActivities: [],
        events: [],
        model: outgoingModelId
      });
      return map;
    });

    const tempMessage: AgentMessage = {
      id: `temp-${Date.now()}`,
      role: "user",
      content,
      createdAt: Date.now(),
      metadata: messageMetadata
    };
    setMessages((prev) => [...prev, tempMessage]);

    void sendAgentMessage({
      sessionId,
      userMessage: content,
      messageMetadata,
      channelId: agentChannelId ?? undefined,
      modelId: outgoingModelId,
      workspaceId: workspaceId ?? undefined,
      sessionType: "main",
      chatType: "direct",
      permissionMode: agentPermissionMode
    }).catch((error) => {
      console.error("[AgentView] resend failed", error);
      const message = error instanceof Error ? error.message : String(error);
      setStreamErrors((prev) => {
        const map = new Map(prev);
        map.set(sessionId, `重发失败: ${message}`);
        return map;
      });
      setStreamingStates((prev) => {
        if (!prev.has(sessionId)) return prev;
        const map = new Map(prev);
        map.delete(sessionId);
        return map;
      });
    });
  }, [
    enterPlan,
    sessionId,
    backendReady,
    streaming,
    agentChannelId,
    outgoingModelId,
    workspaceId,
    agentPermissionMode,
    setStreamErrors,
    setStreamingStates,
    setMessages
  ]);

  useEffect(() => {
    if (!sessionId || !streaming) return;

    let disposed = false;
    let pending = false;
    const streamStartedAt = Date.now();

    const timer = setInterval(() => {
      if (disposed || pending) return;
      const lastEventAt = lastAgentEventAtRef.current.get(sessionId) ?? 0;
      const lastActiveAt = lastEventAt > 0 ? lastEventAt : streamStartedAt;
      const activeTools = toolActivities.filter((item) => !item.done);
      const hasRunningWebSearch = activeTools.some((item) => item.toolName === "web_search");
      const idleTimeoutMs = hasRunningWebSearch
        ? 180_000
        : activeTools.length > 0
          ? 120_000
          : 45_000;
      if (!askUserQuestionRequest && !toolPermissionRequest && Date.now() - lastActiveAt > idleTimeoutMs) {
        setStreamErrors((prev) => {
          const map = new Map(prev);
          map.set(sessionId, "Agent 长时间无响应，已自动停止本次生成，请重试。");
          return map;
        });
        setStreamingStates((prev) => {
          if (!prev.has(sessionId)) return prev;
          const map = new Map(prev);
          map.delete(sessionId);
          return map;
        });
        return;
      }
      // 事件流健康时不介入，避免打断正常流式渲染。
      if (Date.now() - lastEventAt < 6000) return;
      pending = true;

      void getAgentSessionMessages(sessionId)
        .then((next) => {
          if (disposed) return;
          startTransition(() => {
            // 仅在确有变化时更新，避免抖动。
            setMessages((prev) => {
              if (prev.length === next.length) {
                const same = prev.every((item, index) => item.id === next[index]?.id && item.content === next[index]?.content);
                return same ? prev : next;
              }
              return next;
            });
          });

          if (isAgentDebugEnabled()) {
            console.info("[AgentDebug] watchdog pull applied", {
              sessionId,
              count: next.length
            });
          }
        })
        .catch((error) => {
          if (isAgentDebugEnabled()) {
            console.warn("[AgentDebug] watchdog fetch messages failed", error);
          }
          const message = error instanceof Error ? error.message : String(error);
          setStreamErrors((prev) => {
            const map = new Map(prev);
            map.set(sessionId, `轮询读取消息失败: ${message}`);
            return map;
          });
        })
        .finally(() => {
          pending = false;
        });
    }, 1500);

    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [
    sessionId,
    streaming,
    askUserQuestionRequest,
    toolPermissionRequest,
    toolActivities,
    setMessages,
    setStreamErrors,
    setStreamingStates
  ]);

  const truncateFromMessage = useCallback(async (messageId: string): Promise<void> => {
    if (!sessionId) return;
    const updated = await truncateAgentMessagesFrom(sessionId, messageId);
    setMessages(updated);
  }, [sessionId, setMessages]);

  const handleResendMessage = useCallback(async (message: AgentMessage): Promise<void> => {
    if (streaming || !sessionId) return;
    await truncateFromMessage(message.id);
    sendFromMessageContent(message.content ?? "");
  }, [sessionId, streaming, sendFromMessageContent, truncateFromMessage]);

  const handleDeleteMessage = useCallback(async (message: AgentMessage): Promise<void> => {
    if (streaming || !sessionId) return;
    await truncateFromMessage(message.id);
    setInlineEditingMessageId(null);
  }, [sessionId, streaming, truncateFromMessage]);

  const handleStartInlineEdit = useCallback((message: AgentMessage): void => {
    if (streaming) return;
    setInlineEditingMessageId(message.id);
  }, [streaming]);

  const handleCancelInlineEdit = useCallback((): void => {
    setInlineEditingMessageId(null);
  }, []);

  const handleSubmitInlineEdit = useCallback(async (
    message: AgentMessage,
    payload: AgentInlineEditSubmitPayload
  ): Promise<void> => {
    if (streaming || !sessionId) return;
    const { block } = splitAttachedFiles(message.content ?? "");
    const text = payload.content.trim();
    const nextContent = block
      ? (text ? `${block}\n\n${text}` : block)
      : text;
    if (!nextContent) return;
    await truncateFromMessage(message.id);
    sendFromMessageContent(nextContent);
    setInlineEditingMessageId(null);
  }, [sessionId, streaming, truncateFromMessage, sendFromMessageContent]);

  const handleSaveAsTask = useCallback(async (message: AgentMessage): Promise<void> => {
    const prompt = (message.content ?? "").trim();
    if (!prompt) {
      window.alert("消息内容为空，无法保存为任务");
      return;
    }
    const defaultName = `Agent任务-${new Date().toLocaleDateString()}`;
    const name = window.prompt("请输入任务名称", defaultName)?.trim();
    if (!name) return;
    const cronExpr = window.prompt("请输入 Cron 表达式", "30 8 * * 1-5")?.trim();
    if (!cronExpr) return;

    await createAutomationJob({
      name,
      workspaceId: currentWorkspace?.id ?? session?.workspaceId,
      schedule: {
        type: "cron",
        cronExpr
      },
      prompt
    });
    window.alert("已保存为自动化任务，可在设置页查看");
  }, [currentWorkspace?.id, session?.workspaceId]);

  const handleModelSelect = useCallback((option: ModelOption): void => {
    setAgentChannelId(option.channelId);
    setAgentModelId(option.modelId);
  }, []);

  const externalSelectedModel = useMemo(() => {
    if (!agentChannelId) return null;
    if (!agentModelId) return { channelId: agentChannelId, modelId: "" };
    return { channelId: agentChannelId, modelId: agentModelId };
  }, [agentChannelId, agentModelId]);

  const canSend = (inputContent.trim().length > 0 || pendingFiles.length > 0 || pendingFolderRefs.length > 0)
    && backendReady
    && !streaming;

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
          />

          <AgentMessages
            isStreaming={streaming}
            isSwitching={sessionSwitching}
            inlineEditingMessageId={inlineEditingMessageId}
            onDeleteMessage={handleDeleteMessage}
            onResendMessage={handleResendMessage}
            onSaveAsTask={handleSaveAsTask}
            onStartInlineEdit={handleStartInlineEdit}
            onSubmitInlineEdit={handleSubmitInlineEdit}
            onCancelInlineEdit={handleCancelInlineEdit}
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
                    filterChannelId={agentChannelId ?? undefined}
                    externalSelectedModel={externalSelectedModel}
                    onModelSelect={handleModelSelect}
                  />
                ) : null}

                {backendReady ? (
                  <ContextUsageBadge
                    inputTokens={contextStatus.inputTokens}
                    contextWindow={contextStatus.contextWindow}
                    isCompacting={contextStatus.isCompacting}
                    isProcessing={streaming}
                    onCompact={handleCompact}
                  />
                ) : null}
              </div>

              <div className="flex items-center gap-1.5">
                {streaming ? (
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
            teamActivities={teamActivities}
            open={currentSidePanelOpen}
            activeTab={currentSidePanelTab}
            onOpenChange={setCurrentSidePanelOpen}
            onTabChange={setCurrentSidePanelTab}
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
    </div>
  );
}
