"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  agentWorkspacesAtom,
  applyAgentEvent,
  currentAgentErrorAtom,
  currentAgentMessagesAtom,
  currentAgentSessionAtom,
  currentAgentSessionIdAtom,
  currentAgentWorkspaceIdAtom
} from "@/atoms";
import {
  getAgentSessionMessages,
  getAgentSessionPath,
  listAgentSessions,
  listChannels,
  onAgentStreamComplete,
  onAgentStreamError,
  onAgentStreamEvent,
  onAgentAskUserQuestion,
  onAgentToolPermissionRequest,
  onAgentTitleUpdated,
  openFolderDialog,
  openAgentFile,
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
import { FileBrowser } from "@/components/file-browser";
import { AttachmentPreviewItem } from "@/components/chat/AttachmentPreviewItem";
import { ModelSelector } from "@/components/chat/ModelSelector";
import { RichTextInput } from "@/components/ai-elements/rich-text-input";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

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

function extractPlanPathFromResult(result: string): string | null {
  const findPlanPath = (value: unknown): string | null => {
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (typeof record.planPath === "string" && record.planPath.trim()) {
      return record.planPath.trim();
    }
    if (record.details && typeof record.details === "object") {
      const nested = findPlanPath(record.details);
      if (nested) return nested;
    }
    if (Array.isArray(record.content)) {
      for (const item of record.content) {
        if (!item || typeof item !== "object") continue;
        const text = (item as { text?: unknown }).text;
        if (typeof text !== "string") continue;
        const parsed = tryParseJson(text);
        const nested = findPlanPath(parsed);
        if (nested) return nested;
      }
    }
    return null;
  };

  const parsed = tryParseJson(result);
  if (parsed) {
    const nested = findPlanPath(parsed);
    if (nested) return nested;
  }
  return null;
}

interface PlanStep {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "completed";
  failCount: number;
  lastError: string | null;
}

function parsePlanStepsFromDraft(draft: string): PlanStep[] {
  const lines = draft
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const stepLines = lines.filter((line) => /^(\d+\.)|^[-*]\s+/.test(line));
  const selected = (stepLines.length > 0 ? stepLines : lines)
    .slice(0, 12)
    .map((line) => line.replace(/^(\d+\.)\s*|^[-*]\s+/, "").trim())
    .filter((line) => line.length > 0);
  return selected.map((text, index) => ({
    id: `plan-step-${index + 1}`,
    text,
    status: "pending",
    failCount: 0,
    lastError: null
  }));
}

function normalizePlanTextForKey(input: string): string {
  return input
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function buildPlanExecutionKey(planDraft: string, planPath: string | null): string | null {
  const normalizedPath = planPath?.trim();
  if (normalizedPath) {
    return `path:${normalizedPath}`;
  }
  const normalizedText = normalizePlanTextForKey(planDraft);
  if (!normalizedText) return null;
  return `draft:${normalizedText}`;
}

export function AgentView(): React.ReactElement {
  const [sessionId] = useAtom(currentAgentSessionIdAtom);
  const session = useAtomValue(currentAgentSessionAtom);
  const [workspaceId] = useAtom(currentAgentWorkspaceIdAtom);
  const [workspaces] = useAtom(agentWorkspacesAtom);
  const [messages, setMessages] = useAtom(currentAgentMessagesAtom);
  const setStreamingStates = useSetAtom(agentStreamingStatesAtom);
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
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
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
  const [latestPlanPath, setLatestPlanPath] = useState<string | null>(null);
  const [planDraft, setPlanDraft] = useState("");
  const [planDraftUpdatedAt, setPlanDraftUpdatedAt] = useState<number | null>(null);
  const [planSessionActive, setPlanSessionActive] = useState(false);
  const [planReviewOpen, setPlanReviewOpen] = useState(false);
  const [planPanelExpanded, setPlanPanelExpanded] = useState(true);
  const [planExecutionSteps, setPlanExecutionSteps] = useState<PlanStep[]>([]);
  const [planExecutionTriggered, setPlanExecutionTriggered] = useState(false);
  const [activeExecutingStepIndex, setActiveExecutingStepIndex] = useState<number | null>(null);
  const activeExecutingStepRef = useRef<{ sessionId: string; stepIndex: number } | null>(null);

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

  const todoProgressText = useMemo(() => {
    if (!latestTodoItems || latestTodoItems.length === 0) return null;
    const completed = latestTodoItems.filter((todo) => todo.status === "completed").length;
    return `${completed}/${latestTodoItems.length}`;
  }, [latestTodoItems]);

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
  const modeNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAgentEventAtRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    currentSessionIdRef.current = sessionId;
  }, [sessionId]);
  useEffect(() => {
    if (agentPermissionMode !== "plan") {
      lastNonPlanPermissionModeRef.current = agentPermissionMode;
    }
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

  useEffect(() => {
    if (!sessionId) {
      setMessages([]);
      setSessionRootPath(null);
      setToolPermissionRequest(null);
      setLatestPlanPath(null);
      setPlanDraft("");
      setPlanDraftUpdatedAt(null);
      setPlanSessionActive(false);
      setPlanReviewOpen(false);
      setPlanExecutionSteps([]);
      setPlanExecutionTriggered(false);
      setActiveExecutingStepIndex(null);
      activeExecutingStepRef.current = null;
      return;
    }

    setPendingFiles([]);
    setPendingFolderRefs([]);
    setInlineEditingMessageId(null);
    setInputContent("");
    setToolPermissionRequest(null);
    setLatestPlanPath(null);
    setPlanDraft("");
    setPlanDraftUpdatedAt(null);
    setPlanSessionActive(false);
    setPlanReviewOpen(false);
    setPlanExecutionSteps([]);
    setPlanExecutionTriggered(false);
    setActiveExecutingStepIndex(null);
    activeExecutingStepRef.current = null;
    void getAgentSessionMessages(sessionId)
      .then(setMessages)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setStreamErrors((prev) => {
          const map = new Map(prev);
          map.set(sessionId, `读取会话消息失败: ${message}`);
          return map;
        });
      });
  }, [sessionId, setMessages, setStreamErrors]);

  useEffect(() => {
    if (!sessionId || !workspaceId) {
      setSessionRootPath(null);
      return;
    }
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (!workspace) {
      setSessionRootPath(null);
      return;
    }
    void getAgentSessionPath(workspace.slug, sessionId)
      .then(setSessionRootPath)
      .catch(() => setSessionRootPath(null));
  }, [sessionId, workspaceId, workspaces]);

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
        if (event.type === "tool_start" && event.toolName === "EnterPlanMode") {
          setAgentPermissionMode("plan");
          setPlanSessionActive(true);
          setPlanReviewOpen(false);
          setPlanExecutionSteps([]);
          setPlanExecutionTriggered(false);
          setActiveExecutingStepIndex(null);
          activeExecutingStepRef.current = null;
          setPlanDraft("");
          setPlanDraftUpdatedAt(Date.now());
          showModeNotice("已进入 Plan Mode");
        } else if (event.type === "tool_result" && !event.isError && event.toolName === "ExitPlanMode") {
          const fallbackMode = lastNonPlanPermissionModeRef.current === "plan"
            ? "default"
            : lastNonPlanPermissionModeRef.current;
          setAgentPermissionMode(fallbackMode);
          setPlanSessionActive(false);
          setPlanReviewOpen(true);
          showModeNotice(`已退出 Plan Mode，切换到 ${fallbackMode}`);
          const planPath = extractPlanPathFromResult(event.result);
          if (planPath) {
            setLatestPlanPath(planPath);
          }
        } else if (event.type === "text_delta" && (planSessionActive || agentPermissionMode === "plan")) {
          setPlanDraft((prev) => `${prev}${event.text}`);
          setPlanDraftUpdatedAt(Date.now());
        } else if (event.type === "text_complete" && (planSessionActive || agentPermissionMode === "plan")) {
          setPlanDraft((prev) => (prev.length === 0 ? event.text : prev));
          setPlanDraftUpdatedAt(Date.now());
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
    }));

    trackUnlisten(onAgentStreamComplete((payload) => {
      lastAgentEventAtRef.current.set(payload.sessionId, Date.now());
      if (isAgentDebugEnabled()) {
        console.info("[AgentDebug] stream:complete", { sessionId: payload.sessionId });
      }
      markStreamCompleted(payload.sessionId);
      if (activeExecutingStepRef.current?.sessionId === payload.sessionId) {
        const stepIndex = activeExecutingStepRef.current.stepIndex;
        setPlanExecutionSteps((prev) => prev.map((step, index) => (
          index === stepIndex ? { ...step, status: "completed", lastError: null } : step
        )));
        showModeNotice(`步骤 ${stepIndex + 1} 已自动标记完成`);
        setActiveExecutingStepIndex(null);
        activeExecutingStepRef.current = null;
      }

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
            // 去重：移除与新消息 ID 冲突的旧消息
            setMessages((prev) => {
              const nextIds = new Set(next.map(m => m.id));
              // 先过滤掉临时消息，再过滤重复的正式消息
              const filteredPrev = prev.filter(m => !m.id.startsWith('temp-'));
              return [...filteredPrev.filter(m => !nextIds.has(m.id)), ...next];
            });
            finalize();
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
      if (activeExecutingStepRef.current?.sessionId === payload.sessionId) {
        const stepIndex = activeExecutingStepRef.current.stepIndex;
        setPlanExecutionSteps((prev) => prev.map((step, index) => (
          index === stepIndex
            ? { ...step, failCount: step.failCount + 1, lastError: payload.error }
            : step
        )));
        setActiveExecutingStepIndex(null);
        activeExecutingStepRef.current = null;
        showModeNotice("当前步骤执行失败，已保留为进行中，请重试或手动标记完成。");
      }

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
            setMessages(next);
            finalize();
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

    trackUnlisten(onAgentTitleUpdated(() => {
      void listAgentSessions().then(setSessions);
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
    setStreamErrors,
    setStreamingStates,
    setAgentPermissionMode,
    showModeNotice,
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

  const historicalPlanDetected = useMemo(() => messages.some((message) => {
    if (!message.events) return false;
    return message.events.some((event) => {
      if (event.type === "tool_start" && event.toolName === "EnterPlanMode") return true;
      if (event.type === "tool_result" && !event.isError && event.toolName === "ExitPlanMode") return true;
      return false;
    });
  }), [messages]);

  const inferredPlanDraft = useMemo(() => {
    if (!historicalPlanDetected || planDraft.trim().length > 0) return "";
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (!message || message.role !== "assistant") continue;
      const content = message.content?.trim() ?? "";
      if (!content) continue;
      if (parsePlanStepsFromDraft(content).length >= 1) {
        return content;
      }
    }
    return "";
  }, [historicalPlanDetected, messages, planDraft]);

  const effectivePlanDraft = planDraft.trim().length > 0 ? planDraft : inferredPlanDraft;
  const executablePlanSteps = useMemo(() => parsePlanStepsFromDraft(effectivePlanDraft), [effectivePlanDraft]);

  const resolvedLatestPlanPath = useMemo(() => {
    if (latestPlanPath) return latestPlanPath;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (!message?.events) continue;
      for (let j = message.events.length - 1; j >= 0; j -= 1) {
        const event = message.events[j];
        if (!event) continue;
        if (event.type === "tool_result" && !event.isError && event.toolName === "ExitPlanMode") {
          const planPath = extractPlanPathFromResult(event.result);
          if (planPath) return planPath;
        }
      }
    }
    return null;
  }, [latestPlanPath, messages]);
  const currentPlanExecutionKey = useMemo(
    () => buildPlanExecutionKey(effectivePlanDraft, resolvedLatestPlanPath),
    [effectivePlanDraft, resolvedLatestPlanPath]
  );
  const historicalPlanExecutionTriggered = useMemo(
    () => messages.some((message) => {
      if (message.role !== "user") return false;
      const markerKey = typeof message.metadata?.planExecutionKey === "string"
        ? message.metadata.planExecutionKey
        : null;
      if (markerKey) {
        if (!currentPlanExecutionKey) return true;
        return markerKey === currentPlanExecutionKey;
      }
      const content = message.content ?? "";
      return content.includes("请开始执行计划第") || content.includes("请切换到执行模式，并从计划文件开始执行第一步");
    }),
    [currentPlanExecutionKey, messages]
  );

  const handleStartPlanExecution = useCallback((): void => {
    if (!sessionId) return;
    if (typeof window !== "undefined") {
      const confirmed = window.confirm("开始执行后将切换到 Edit 模式，并自动执行计划第 1 步。是否继续？");
      if (!confirmed) return;
    }
    const steps = executablePlanSteps;
    if (steps.length === 0 && !resolvedLatestPlanPath && effectivePlanDraft.trim().length === 0) {
      setStreamErrors((prev) => {
        const map = new Map(prev);
        map.set(sessionId, "计划内容为空，无法开始执行。请先完善计划。");
        return map;
      });
      return;
    }
    if (steps.length > 0) {
      const firstStepIndex = 0;
      const nextSteps = steps.map((step, index) => (
        index === firstStepIndex
          ? { ...step, status: "in_progress" as const }
          : step
      ));
      setPlanExecutionSteps(nextSteps);
      setActiveExecutingStepIndex(firstStepIndex);
      activeExecutingStepRef.current = { sessionId, stepIndex: firstStepIndex };
    }
    setPlanExecutionTriggered(true);
    if (steps.length === 0) {
      setActiveExecutingStepIndex(null);
      activeExecutingStepRef.current = null;
    }
    setPlanReviewOpen(false);
    setPlanSessionActive(false);
    setAgentPermissionMode("acceptEdits");
    const planPathHint = resolvedLatestPlanPath ? `\n计划文件: ${resolvedLatestPlanPath}` : "";
    const executionMetadata = currentPlanExecutionKey
      ? { planExecutionKey: currentPlanExecutionKey }
      : undefined;
    if (steps.length > 0) {
      const firstStep = steps[0];
      if (firstStep) {
        sendFromMessageContent(
          `请开始执行计划第 1 步：${firstStep.text}${planPathHint}\n执行后请简短汇报结果，并给出下一步。`,
          executionMetadata
        );
      }
    } else if (resolvedLatestPlanPath) {
      sendFromMessageContent(
        `请切换到执行模式，并从计划文件开始执行第一步：${resolvedLatestPlanPath}\n先汇报你识别到的步骤，再执行第 1 步。`,
        executionMetadata
      );
    } else {
      sendFromMessageContent(
        `请切换到执行模式，并基于当前计划内容拆分出可执行步骤，然后开始执行第 1 步。\n先给出你识别到的步骤，再执行。`,
        executionMetadata
      );
    }
    showModeNotice("已切换到 Edit 模式并开始按计划执行");
  }, [
    effectivePlanDraft,
    executablePlanSteps,
    resolvedLatestPlanPath,
    currentPlanExecutionKey,
    sendFromMessageContent,
    sessionId,
    setStreamErrors,
    setAgentPermissionMode,
    showModeNotice
  ]);

  const handleContinuePlanning = useCallback((): void => {
    setPlanReviewOpen(false);
    setPlanSessionActive(true);
    setActiveExecutingStepIndex(null);
    activeExecutingStepRef.current = null;
    setAgentPermissionMode("plan");
    showModeNotice("继续完善计划");
  }, [setAgentPermissionMode, showModeNotice]);

  const handleBeginPlanning = useCallback((): void => {
    if (streaming) return;
    setPlanExecutionTriggered(false);
    setPlanExecutionSteps([]);
    setPlanSessionActive(true);
    setPlanReviewOpen(false);
    setAgentPermissionMode("plan");
    setPlanPanelExpanded(true);
    showModeNotice("已进入 Plan 模式，开始生成计划");
    if (effectivePlanDraft.trim().length === 0) {
      sendFromMessageContent("请进入计划阶段，输出可执行的分步计划（编号列表），暂不直接修改代码。");
    }
  }, [effectivePlanDraft, sendFromMessageContent, setAgentPermissionMode, showModeNotice, streaming]);

  const handleStopPlanning = useCallback((): void => {
    if (agentPermissionMode !== "plan") return;
    setPlanSessionActive(false);
    setPlanReviewOpen(effectivePlanDraft.trim().length > 0 || Boolean(resolvedLatestPlanPath));
    setAgentPermissionMode("default");
    showModeNotice("已停止规划，切换到 Edit 模式");
  }, [agentPermissionMode, effectivePlanDraft, resolvedLatestPlanPath, setAgentPermissionMode, showModeNotice]);

  const handleReparsePlanSteps = useCallback((): void => {
    if (streaming) return;
    sendFromMessageContent("请将当前计划重写为清晰的编号步骤（1. 2. 3.），每步一句并可执行。");
  }, [sendFromMessageContent, streaming]);

  const handleExecuteNextPlanStep = useCallback((): void => {
    if (streaming) {
      showModeNotice("当前步骤仍在执行中，请等待本轮输出完成。");
      return;
    }
    if (!sessionId) {
      return;
    }
    if (planExecutionSteps.length === 0) {
      return;
    }
    let nextIndex = planExecutionSteps.findIndex((step) => step.status === "pending");
    if (nextIndex === -1) {
      nextIndex = planExecutionSteps.findIndex((step) => step.status === "in_progress");
    }
    if (nextIndex === -1) {
      showModeNotice("计划步骤已全部执行完");
      return;
    }
    setPlanExecutionSteps((prev) => prev.map((step, index) => {
      if (index < nextIndex && step.status !== "completed") {
        return { ...step, status: "completed" };
      }
      if (index === nextIndex) {
        return { ...step, status: "in_progress", lastError: null };
      }
      return step;
    }));
    setActiveExecutingStepIndex(nextIndex);
    activeExecutingStepRef.current = { sessionId, stepIndex: nextIndex };
    const step = planExecutionSteps[nextIndex];
    if (!step) return;
    const planPathHint = resolvedLatestPlanPath ? `\n计划文件: ${resolvedLatestPlanPath}` : "";
    sendFromMessageContent(
      `请开始执行计划第 ${nextIndex + 1} 步：${step.text}${planPathHint}\n执行后请简短汇报结果，并给出下一步。`
    );
  }, [planExecutionSteps, resolvedLatestPlanPath, sessionId, showModeNotice, sendFromMessageContent, streaming]);

  const handleMarkCurrentPlanStepDone = useCallback((): void => {
    const currentIndex = planExecutionSteps.findIndex((step) => step.status === "in_progress");
    if (currentIndex === -1) return;
    setPlanExecutionSteps((prev) => prev.map((step, index) => (
      index === currentIndex ? { ...step, status: "completed", lastError: null } : step
    )));
    if (activeExecutingStepRef.current?.stepIndex === currentIndex) {
      setActiveExecutingStepIndex(null);
      activeExecutingStepRef.current = null;
    }
  }, [planExecutionSteps]);

  const handleRetryCurrentPlanStep = useCallback((): void => {
    if (streaming) {
      showModeNotice("当前仍在输出中，请等待结束后再重试。");
      return;
    }
    if (!sessionId) return;
    const currentIndex = planExecutionSteps.findIndex((step) => step.status === "in_progress");
    if (currentIndex === -1) {
      showModeNotice("当前没有进行中的步骤可重试。");
      return;
    }
    const step = planExecutionSteps[currentIndex];
    if (!step) return;
    setActiveExecutingStepIndex(currentIndex);
    activeExecutingStepRef.current = { sessionId, stepIndex: currentIndex };
    const planPathHint = resolvedLatestPlanPath ? `\n计划文件: ${resolvedLatestPlanPath}` : "";
    sendFromMessageContent(
      `请重试执行计划第 ${currentIndex + 1} 步：${step.text}${planPathHint}\n执行后请简短汇报结果，并给出下一步。`
    );
  }, [resolvedLatestPlanPath, planExecutionSteps, sendFromMessageContent, sessionId, showModeNotice, streaming]);

  const planExecutionCompleted = useMemo(
    () => planExecutionSteps.length > 0 && planExecutionSteps.every((step) => step.status === "completed"),
    [planExecutionSteps]
  );
  const hasPlanPanel = useMemo(
    () =>
      planSessionActive ||
      agentPermissionMode === "plan" ||
      planReviewOpen ||
      planExecutionSteps.length > 0 ||
      effectivePlanDraft.trim().length > 0 ||
      Boolean(resolvedLatestPlanPath),
    [
      agentPermissionMode,
      effectivePlanDraft,
      planExecutionSteps.length,
      planReviewOpen,
      planSessionActive,
      resolvedLatestPlanPath
    ]
  );
  const planStats = useMemo(() => {
    const total = planExecutionSteps.length;
    const completed = planExecutionSteps.filter((step) => step.status === "completed").length;
    const inProgress = planExecutionSteps.filter((step) => step.status === "in_progress").length;
    const pending = planExecutionSteps.filter((step) => step.status === "pending").length;
    const failed = planExecutionSteps.filter((step) => step.failCount > 0).length;
    return { total, completed, inProgress, pending, failed };
  }, [planExecutionSteps]);
  const planPreviewSteps = useMemo(() => executablePlanSteps.slice(0, 12), [executablePlanSteps]);
  const canStartPlanExecution = useMemo(
    () =>
      !streaming &&
      planExecutionSteps.length === 0 &&
      !planExecutionTriggered &&
      !historicalPlanExecutionTriggered &&
      (effectivePlanDraft.trim().length > 0 || Boolean(resolvedLatestPlanPath)),
    [
      effectivePlanDraft,
      historicalPlanExecutionTriggered,
      planExecutionSteps.length,
      planExecutionTriggered,
      resolvedLatestPlanPath,
      streaming
    ]
  );
  const startPlanExecutionLabel = useMemo(
    () => (planExecutionTriggered || historicalPlanExecutionTriggered ? "已执行" : "开始执行"),
    [historicalPlanExecutionTriggered, planExecutionTriggered]
  );
  const planExecutionHintText = useMemo(() => {
    if (planExecutionTriggered || historicalPlanExecutionTriggered) {
      return "该计划已执行过。";
    }
    if (streaming) {
      return "计划构建中，完成后可执行。";
    }
    return "计划已可执行，点击后将切换到执行模式。";
  }, [historicalPlanExecutionTriggered, planExecutionTriggered, streaming]);
  const planPhase = useMemo<"idle" | "planning" | "review" | "executing" | "executed">(() => {
    if (planExecutionSteps.length > 0) return "executing";
    if (planExecutionTriggered || historicalPlanExecutionTriggered) return "executed";
    if (agentPermissionMode === "plan" && streaming) return "planning";
    if (agentPermissionMode === "plan" || planSessionActive) {
      return (effectivePlanDraft.trim().length > 0 || Boolean(resolvedLatestPlanPath)) ? "review" : "planning";
    }
    if (effectivePlanDraft.trim().length > 0 || Boolean(resolvedLatestPlanPath)) return "review";
    return "idle";
  }, [
    agentPermissionMode,
    effectivePlanDraft,
    historicalPlanExecutionTriggered,
    planExecutionSteps.length,
    planExecutionTriggered,
    planSessionActive,
    resolvedLatestPlanPath,
    streaming
  ]);
  const suppressPlanTextInMessages = useMemo(
    () => hasPlanPanel && (planSessionActive || agentPermissionMode === "plan" || planReviewOpen),
    [agentPermissionMode, hasPlanPanel, planReviewOpen, planSessionActive]
  );

  const handleFinishPlanExecution = useCallback((): void => {
    if (!planExecutionCompleted) return;
    setPlanExecutionSteps([]);
    setActiveExecutingStepIndex(null);
    activeExecutingStepRef.current = null;
    showModeNotice("本轮计划执行已结束。");
  }, [planExecutionCompleted, showModeNotice]);

  const handleSummarizePlanExecution = useCallback((): void => {
    if (!planExecutionCompleted) return;
    const summary = planExecutionSteps
      .map((step, index) => `${index + 1}. ${step.text}`)
      .join("\n");
    sendFromMessageContent(`请总结本轮计划执行结果，并给出后续建议：\n${summary}`);
  }, [planExecutionCompleted, planExecutionSteps, sendFromMessageContent]);

  useEffect(() => {
    if (planSessionActive || planReviewOpen) {
      setPlanPanelExpanded(true);
    }
  }, [planReviewOpen, planSessionActive]);

  useEffect(() => {
    if (!sessionId || !streaming) return;

    let disposed = false;
    let pending = false;

    const timer = setInterval(() => {
      if (disposed || pending) return;
      const lastEventAt = lastAgentEventAtRef.current.get(sessionId) ?? 0;
      // 事件流健康时不介入，避免打断正常流式渲染。
      if (Date.now() - lastEventAt < 6000) return;
      pending = true;

      void getAgentSessionMessages(sessionId)
        .then((next) => {
          if (disposed) return;
          // 仅在确有变化时更新，避免抖动。
          setMessages((prev) => {
            if (prev.length === next.length) {
              const same = prev.every((item, index) => item.id === next[index]?.id && item.content === next[index]?.content);
              return same ? prev : next;
            }
            return next;
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
  }, [sessionId, streaming, setMessages, setStreamingStates]);

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
            onToggleFileBrowser={() => setFileBrowserOpen((prev) => !prev)}
            fileBrowserOpen={fileBrowserOpen}
          />

          <AgentMessages
            isStreaming={streaming}
            suppressAssistantText={suppressPlanTextInMessages}
            suppressStreamingAssistantText={suppressPlanTextInMessages}
            suppressLastAssistantMessage={suppressPlanTextInMessages && planExecutionSteps.length === 0}
            supplementalFrom={hasPlanPanel ? "assistant" : "none"}
            supplementalContent={hasPlanPanel ? (
              <Collapsible
                open={planPanelExpanded}
                onOpenChange={setPlanPanelExpanded}
                className="mb-2 rounded-md border border-sky-300/40 bg-sky-500/5"
              >
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        {planPanelExpanded ? <ChevronDown className="size-3.5 text-muted-foreground" /> : <ChevronRight className="size-3.5 text-muted-foreground" />}
                        <span className="text-xs font-medium text-foreground/90">计划区块</span>
                        <span className={cn(
                          "rounded px-1.5 py-0.5 text-[10px]",
                          planPhase === "planning" && "bg-sky-500/15 text-sky-700",
                          planPhase === "review" && "bg-amber-500/15 text-amber-700",
                          planPhase === "executing" && "bg-violet-500/15 text-violet-700",
                          (planPhase === "executed" || planPhase === "idle") && "bg-muted text-muted-foreground"
                        )}>
                          {planPhase === "planning" ? "规划中" : planPhase === "review" ? "待确认" : planPhase === "executing" ? "执行中" : planPhase === "executed" ? "已执行" : "未开始"}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                        {planStats.total > 0 ? (
                          <span>进度 {planStats.completed}/{planStats.total}</span>
                        ) : (
                          <span>{effectivePlanDraft.trim().length > 0 ? "已生成计划草稿" : "等待计划输出"}</span>
                        )}
                        {planStats.inProgress > 0 ? <span>进行中 {planStats.inProgress}</span> : null}
                        {planStats.pending > 0 ? <span>待处理 {planStats.pending}</span> : null}
                        {planStats.failed > 0 ? <span className="text-amber-700/90">失败 {planStats.failed}</span> : null}
                      </div>
                    </div>
                    {planDraftUpdatedAt ? (
                      <span className="text-[11px] text-muted-foreground">
                        更新于 {new Date(planDraftUpdatedAt).toLocaleTimeString("zh-CN")}
                      </span>
                    ) : null}
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-2 px-3 pb-3">
                  <div className="text-[11px] font-medium text-foreground/80">规划内容</div>
                  {planPhase !== "planning" ? (
                    <div className="grid grid-cols-3 gap-1 text-[10px] text-muted-foreground">
                      <div className="rounded border border-sky-300/50 bg-sky-500/10 px-2 py-1 text-center text-sky-700">1. 规划中</div>
                      <div className={cn("rounded border px-2 py-1 text-center", (planPhase === "review" || planPhase === "executing" || planPhase === "executed") && "border-amber-300/50 bg-amber-500/10 text-amber-700")}>2. 确认计划</div>
                      <div className={cn("rounded border px-2 py-1 text-center", (planPhase === "executing" || planPhase === "executed") && "border-violet-300/50 bg-violet-500/10 text-violet-700")}>3. 执行计划</div>
                    </div>
                  ) : null}
                  <div className="flex items-center gap-2 rounded-md border border-border/50 bg-muted/30 px-2.5 py-1.5 text-[11px] text-foreground/80">
                    <span>
                      当前模式：
                      <span className="ml-1 font-medium">
                        {agentPermissionMode === "plan" ? "Plan" : "Edit"}
                      </span>
                    </span>
                    {planExecutionSteps.length > 0 ? (
                      <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] text-violet-700">执行中</span>
                    ) : null}
                    {(planExecutionTriggered || historicalPlanExecutionTriggered) && planExecutionSteps.length === 0 ? (
                      <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-700">已执行</span>
                    ) : null}
                  </div>
                  {resolvedLatestPlanPath && workspaceId ? (
                    <div className="flex items-center justify-between gap-2 rounded-md border border-emerald-300/40 bg-emerald-500/5 px-2.5 py-2 text-xs text-foreground/80">
                      <span className="truncate">规划已保存: <span className="font-mono">{resolvedLatestPlanPath}</span></span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => {
                          const workspace = workspaces.find((item) => item.id === workspaceId);
                          if (!workspace) return;
                          void openAgentFile(workspace.slug, sessionId, resolvedLatestPlanPath).catch((error) => {
                            const message = error instanceof Error ? error.message : String(error);
                            setStreamErrors((prev) => {
                              const map = new Map(prev);
                              map.set(sessionId, `打开 plan.md 失败: ${message}`);
                              return map;
                            });
                          });
                        }}
                      >
                        打开
                      </Button>
                    </div>
                  ) : null}

                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-background/70 px-2 py-1.5 text-[12px] text-foreground/80">
                    {effectivePlanDraft.trim() || (planSessionActive || (agentPermissionMode === "plan" && streaming) ? "正在生成规划内容..." : "暂无计划内容")}
                  </pre>

                  {planExecutionSteps.length === 0 && planPreviewSteps.length > 0 && planPhase !== "planning" ? (
                    <div className="rounded-md border border-border/50 bg-background/60 px-2.5 py-2">
                      <div className="mb-1 text-[11px] font-medium text-foreground/80">计划任务清单</div>
                      <div className="space-y-1">
                        {planPreviewSteps.map((step, index) => (
                          <div key={step.id} className="flex items-start gap-2 text-xs">
                            <span className="mt-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-muted text-[10px] text-muted-foreground">
                              {index + 1}
                            </span>
                            <span>{step.text}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {planExecutionSteps.length === 0 && planPhase === "review" && (effectivePlanDraft.trim().length > 0 || Boolean(resolvedLatestPlanPath)) ? (
                    <div className="flex items-center gap-2 rounded-md border border-amber-300/40 bg-amber-500/5 px-2.5 py-2">
                      <span className="flex-1 text-[11px] text-foreground/80">{planExecutionHintText}</span>
                      <Button
                        type="button"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={handleStartPlanExecution}
                        disabled={!canStartPlanExecution}
                      >
                        {startPlanExecutionLabel}
                      </Button>
                    </div>
                  ) : null}

                  {planExecutionSteps.length > 0 ? (
                    <>
                      <div className="pt-1 text-[11px] font-medium text-foreground/80">执行步骤</div>
                      <div className="space-y-1.5">
                        {planExecutionSteps.map((step, index) => (
                          <div key={step.id} className="space-y-1 text-xs">
                            <div className="flex items-start gap-2">
                              <span className={cn(
                                "mt-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full text-[10px]",
                                step.status === "completed" && "bg-green-500/20 text-green-700",
                                step.status === "in_progress" && "bg-blue-500/20 text-blue-700",
                                step.status === "pending" && "bg-muted text-muted-foreground"
                              )}>
                                {index + 1}
                              </span>
                              <span className={cn(step.status === "completed" && "line-through text-muted-foreground")}>
                                {step.text}
                              </span>
                            </div>
                            {(step.failCount > 0 || step.lastError) ? (
                              <div className="ml-6 text-[11px] text-amber-700/90">
                                失败 {step.failCount} 次{step.lastError ? `，最近错误：${step.lastError}` : ""}
                              </div>
                            ) : null}
                          </div>
                        ))}
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={handleExecuteNextPlanStep}
                          disabled={streaming}
                        >
                          执行下一步
                        </Button>
                        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={handleMarkCurrentPlanStepDone}>
                          标记当前完成
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={handleRetryCurrentPlanStep}
                          disabled={streaming || !planExecutionSteps.some((step) => step.status === "in_progress")}
                        >
                          重试当前步骤
                        </Button>
                      </div>
                      {activeExecutingStepIndex !== null ? (
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          正在执行步骤 {activeExecutingStepIndex + 1}，本轮输出完成后会自动标记完成。
                        </div>
                      ) : null}
                      {planExecutionCompleted ? (
                        <div className="mt-2 rounded-md border border-emerald-300/40 bg-emerald-500/10 px-2 py-1.5">
                          <div className="text-[11px] text-emerald-800/90">所有步骤已完成，建议结束本轮计划执行或让 Agent 产出总结。</div>
                          <div className="mt-1 flex items-center gap-2">
                            <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={handleFinishPlanExecution}>
                              结束本轮执行
                            </Button>
                            <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={handleSummarizePlanExecution}>
                              生成执行总结
                            </Button>
                          </div>
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </CollapsibleContent>
              </Collapsible>
            ) : null}
            inlineEditingMessageId={inlineEditingMessageId}
            onDeleteMessage={handleDeleteMessage}
            onResendMessage={handleResendMessage}
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

        <div className="mx-4 mb-2 flex items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2">
          <span className="text-xs text-foreground/80">规划助手</span>
          <span className="rounded bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {planPhase === "planning" ? "规划中" : planPhase === "review" ? "待确认" : planPhase === "executing" ? "执行中" : planPhase === "executed" ? "已执行" : "未开始"}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            {agentPermissionMode === "plan" ? (
              <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={handleStopPlanning}>
                结束规划
              </Button>
            ) : null}
            {planPhase === "review" ? (
              <Button
                type="button"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={handleStartPlanExecution}
                disabled={!canStartPlanExecution}
              >
                {startPlanExecutionLabel}
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={handleBeginPlanning}
              disabled={streaming || planPhase === "executing" || agentPermissionMode === "plan"}
            >
              {planPhase === "idle" ? "开始规划" : "重新规划"}
            </Button>
          </div>
        </div>

        {agentPermissionMode === "plan" ? (
          <div className="mx-4 mb-2 rounded-md border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-xs text-foreground/80">
            Plan Mode 已启用：当前只允许规划与只读工具。执行改动请先退出 Plan Mode。
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

                <select
                  value={agentPermissionMode}
                  onChange={(event) => {
                    setAgentPermissionMode(event.target.value as typeof agentPermissionMode);
                  }}
                  className="h-[28px] rounded-md border border-border bg-background px-2 text-xs text-foreground/80"
                  title="Agent 权限模式"
                >
                  <option value="default">default</option>
                  <option value="acceptEdits">acceptEdits</option>
                  <option value="bypassPermissions">bypassPermissions</option>
                  <option value="plan">plan</option>
                </select>

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

          {fileBrowserOpen && sessionRootPath && workspaceId ? (
            (() => {
              const workspace = workspaces.find((item) => item.id === workspaceId);
              if (!workspace) return null;
              return (
                <div className="w-[300px] shrink-0 border-l">
                  <FileBrowser
                    workspaceSlug={workspace.slug}
                    sessionId={sessionId}
                    rootPath={sessionRootPath}
                  />
                </div>
              );
            })()
          ) : null}
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
