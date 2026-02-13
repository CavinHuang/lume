"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { AlertCircle, Bot, CheckCircle2, ChevronDown, ChevronRight, Circle, CornerDownLeft, FolderPlus, Loader2, Paperclip, Settings, Square, X } from "lucide-react";
import type {
  AgentAskUserQuestionRequest,
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
  onAgentTitleUpdated,
  openFolderDialog,
  openChatFileDialog,
  copyFolderToAgentSession,
  saveFilesToAgentSession,
  sendAgentMessage,
  truncateAgentMessagesFrom,
  submitAgentAskUserQuestionAnswers,
  stopAgentRun
} from "@/lib/desktop-api";
import { cn } from "@/lib/utils";
import { AgentHeader } from "./AgentHeader";
import { AgentMessages } from "./AgentMessages";
import type { AgentInlineEditSubmitPayload } from "./AgentMessages";
import { ContextUsageBadge } from "./ContextUsageBadge";
import { FileBrowser } from "@/components/file-browser";
import { AttachmentPreviewItem } from "@/components/chat/AttachmentPreviewItem";
import { ModelSelector } from "@/components/chat/ModelSelector";
import { RichTextInput } from "@/components/ai-elements/rich-text-input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
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
  const [todoPanelExpanded, setTodoPanelExpanded] = useState(true);

  type TodoItem = {
    content: string;
    status: "pending" | "in_progress" | "completed";
    activeForm?: string;
  };

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
  const backendReady = agentChannelId !== null;
  const outgoingModelId = useMemo(() => {
    const trimmed = agentModelId?.trim();
    if (trimmed) return trimmed;
    return undefined;
  }, [agentModelId]);

  const currentSessionIdRef = useRef<string | null>(sessionId);
  const lastNonPlanPermissionModeRef = useRef(agentPermissionMode);
  const modeNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      return;
    }

    setPendingFiles([]);
    setPendingFolderRefs([]);
    setInlineEditingMessageId(null);
    setInputContent("");
    void getAgentSessionMessages(sessionId).then(setMessages);
  }, [sessionId, setMessages]);

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

    const trackUnlisten = (promise: Promise<() => void>): void => {
      void promise.then((fn) => {
        if (disposed) {
          void fn();
          return;
        }
        unsubs.push(fn);
      }).catch((error) => {
        console.error("[AgentView] subscribe stream failed:", error);
      });
    };

    const removeState = (targetSessionId: string): void => {
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
      // Plan Mode 工具事件触发权限模式切换：Enter -> plan，Exit(success) -> 恢复编辑模式
      if (payload.sessionId === currentSessionIdRef.current) {
        const event = payload.event;
        if (event.type === "tool_start" && event.toolName === "EnterPlanMode") {
          setAgentPermissionMode("plan");
          showModeNotice("已进入 Plan Mode");
        } else if (event.type === "tool_result" && !event.isError && event.toolName === "ExitPlanMode") {
          const fallbackMode = lastNonPlanPermissionModeRef.current === "plan"
            ? "bypassPermissions"
            : lastNonPlanPermissionModeRef.current;
          setAgentPermissionMode(fallbackMode);
          showModeNotice(`已退出 Plan Mode，切换到 ${fallbackMode}`);
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
      markStreamCompleted(payload.sessionId);

      const finalize = (): void => {
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
          .catch(() => finalize());
      } else {
        finalize();
      }
    }));

    trackUnlisten(onAgentStreamError((payload) => {
      setStreamErrors((prev) => {
        const map = new Map(prev);
        map.set(payload.sessionId, payload.error);
        return map;
      });
    }));

    trackUnlisten(onAgentTitleUpdated(() => {
      void listAgentSessions().then(setSessions);
    }));

    trackUnlisten(onAgentAskUserQuestion((payload) => {
      setAskUserError(null);
      setAskUserQuestionRequest(payload);
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
    showModeNotice
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
      chatType: "direct",
      permissionMode: agentPermissionMode
    }).catch((error) => {
      console.error("[AgentView] send failed", error);
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

  const sendFromMessageContent = useCallback((content: string): void => {
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
      createdAt: Date.now()
    };
    setMessages((prev) => [...prev, tempMessage]);

    void sendAgentMessage({
      sessionId,
      userMessage: content,
      channelId: agentChannelId ?? undefined,
      modelId: outgoingModelId,
      workspaceId: workspaceId ?? undefined,
      chatType: "direct",
      permissionMode: agentPermissionMode
    }).catch((error) => {
      console.error("[AgentView] resend failed", error);
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
    <>
      <div className="flex h-full overflow-hidden">
        <div className="mx-auto flex h-full min-w-0 max-w-[min(72rem,100%)] flex-1 flex-col">
          <AgentHeader
            onToggleFileBrowser={() => setFileBrowserOpen((prev) => !prev)}
            fileBrowserOpen={fileBrowserOpen}
          />

          <AgentMessages
            isStreaming={streaming}
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
      <Dialog
        open={!!askUserQuestionRequest}
        onOpenChange={(open) => {
          if (!open) {
            void cancelAskUserQuestion();
          }
        }}
      >
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-[760px]">
          <DialogHeader>
            <DialogTitle>需要你确认几个问题</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {askUserQuestionRequest?.questions.map((question, questionIndex) => {
              const answerState = askUserAnswers[question.header] ?? { selected: [], otherText: "" };
              const hasOtherOption = question.options.some((item) => item.label.trim() === "其他");
              const withOtherOption = hasOtherOption
                ? question.options
                : [
                    ...question.options,
                    {
                      label: "其他",
                      description: "手动输入自定义回答"
                    }
                  ];
              const inputName = `${question.header}-${questionIndex}`;
              return (
                <div key={`${question.header}-${questionIndex}`} className="rounded-md border border-border p-3">
                  <div className="mb-1 text-xs text-muted-foreground">{question.header}</div>
                  <div className="mb-3 text-sm text-foreground">{question.question}</div>
                  <div className="space-y-2">
                    {withOtherOption.map((option, optionIndex) => {
                      const optionValue = option.label === "其他" ? ASK_USER_OTHER_OPTION : option.label;
                      const checked = answerState.selected.includes(optionValue);
                      const inputType = question.multiSelect ? "checkbox" : "radio";
                      return (
                        <label key={`${question.header}-${optionValue}-${optionIndex}`} className="flex cursor-pointer items-start gap-2 rounded border border-border/70 px-2 py-1.5 text-sm hover:bg-accent/40">
                          <input
                            type={inputType}
                            name={inputName}
                            checked={checked}
                            onChange={(event) => {
                              updateAskAnswerOption(
                                question.header,
                                optionValue,
                                event.target.checked,
                                question.multiSelect
                              );
                            }}
                            className="mt-0.5"
                          />
                          <span className="flex-1">
                            <span className="block text-foreground">{option.label}</span>
                            <span className="block text-xs text-muted-foreground">{option.description}</span>
                          </span>
                        </label>
                      );
                    })}
                    {answerState.selected.includes(ASK_USER_OTHER_OPTION) ? (
                      <Input
                        value={answerState.otherText}
                        onChange={(event) => updateAskOtherText(question.header, event.target.value)}
                        placeholder="请输入自定义回答"
                        disabled={askUserSubmitting}
                      />
                    ) : null}
                  </div>
                </div>
              );
            })}
            {askUserError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {askUserError}
              </div>
            ) : null}
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  void cancelAskUserQuestion();
                }}
                disabled={askUserSubmitting}
              >
                取消
              </Button>
              <Button
                type="button"
                onClick={() => {
                  void submitAskUserQuestion();
                }}
                disabled={askUserSubmitting}
              >
                {askUserSubmitting ? "提交中..." : "提交回答"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
