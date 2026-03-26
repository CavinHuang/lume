"use client";

import { useCallback, useEffect } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  AgentMessage,
  AgentPendingFile,
  AgentSavedFile,
  AgentSendInput
} from "@lume/shared";
import type { AgentStreamState } from "@/atoms/agent-atoms";
import {
  copyFolderToAgentSession,
  saveFilesToAgentSession,
  sendAgentMessage,
  stopAgentRun,
  truncateAgentMessagesFrom
} from "@/lib/desktop-api/agent";
import { openChatFileDialog } from "@/lib/desktop-api/chat";
import { openFolderDialog } from "@/lib/desktop-api/system";
import {
  buildAttachedFilesReferenceBlock,
  fileToBase64,
  shouldDispatchPendingPrompt,
  shouldQueueAgentTitleGeneration
} from "../agent-composer";

interface UseAgentComposerParams {
  sessionId: string | null;
  sessionTitle: string;
  currentWorkspaceSlug: string | null;
  currentWorkspaceId: string | null;
  workspaceId: string | null;
  workspaces: Array<{ id: string; slug: string }>;
  backendReady: boolean;
  isAgentBusy: boolean;
  pendingPrompt: { sessionId: string; message: string } | null;
  setPendingPrompt: Dispatch<SetStateAction<{ sessionId: string; message: string } | null>>;
  inputContent: string;
  setInputContent: Dispatch<SetStateAction<string>>;
  pendingFiles: AgentPendingFile[];
  setPendingFiles: Dispatch<SetStateAction<AgentPendingFile[]>>;
  pendingFolderRefs: AgentSavedFile[];
  setPendingFolderRefs: Dispatch<SetStateAction<AgentSavedFile[]>>;
  setMessages: Dispatch<SetStateAction<AgentMessage[]>>;
  setStreamErrors: Dispatch<SetStateAction<Map<string, string>>>;
  setStreamingStates: Dispatch<SetStateAction<Map<string, AgentStreamState>>>;
  setInlineEditingMessageId: Dispatch<SetStateAction<string | null>>;
  enterPlan: () => void;
  agentChannelId: string | null;
  outgoingModelId: string | undefined;
  agentPermissionMode: NonNullable<AgentSendInput["permissionMode"]>;
  planStreamCaptureRef: MutableRefObject<boolean>;
  pendingTitleRef: MutableRefObject<Map<string, { userMessage: string; channelId: string; modelId: string }>>;
}

interface InlineEditPayload {
  content: string;
  preserveAttachedFiles?: boolean;
}

interface UseAgentComposerResult {
  addFilesAsAttachments: (files: File[]) => Promise<void>;
  handleOpenFileDialog: () => Promise<void>;
  handleOpenFolderDialog: () => Promise<void>;
  handleRemoveFile: (id: string) => void;
  handleCompact: () => void;
  handleStop: () => void;
  handleSend: () => Promise<void>;
  sendFromMessageContent: (content: string, messageMetadata?: Record<string, unknown>) => void;
  truncateFromMessage: (messageId: string) => Promise<void>;
  handleResendMessage: (message: AgentMessage) => Promise<void>;
  handleDeleteMessage: (message: AgentMessage) => Promise<void>;
  handleSubmitInlineEdit: (message: AgentMessage, payload: InlineEditPayload) => Promise<void>;
}

export function useAgentComposer({
  sessionId,
  sessionTitle,
  currentWorkspaceSlug,
  currentWorkspaceId,
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
  planStreamCaptureRef,
  pendingTitleRef
}: UseAgentComposerParams): UseAgentComposerResult {
  useEffect(() => {
    if (!shouldDispatchPendingPrompt({
      pendingPromptSessionId: pendingPrompt?.sessionId ?? null,
      sessionId,
      backendReady,
      isAgentBusy
    })) {
      return;
    }

    const prompt = pendingPrompt;
    if (!prompt) return;
    setPendingPrompt(null);

    const timer = setTimeout(() => {
      setStreamingStates((prev) => {
        const map = new Map(prev);
        map.set(sessionId as string, { running: true, content: "", toolActivities: [], teammates: [], events: [] });
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
        sessionId: sessionId as string,
        userMessage: prompt.message,
        channelId: agentChannelId ?? undefined,
        modelId: outgoingModelId,
        workspaceId: currentWorkspaceId ?? workspaceId ?? undefined,
        sessionType: "main",
        chatType: "direct",
        permissionMode: agentPermissionMode
      }).catch((error) => {
        console.error("[AgentView] send pending prompt failed", error);
        setStreamingStates((prev) => {
          const map = new Map(prev);
          map.delete(sessionId as string);
          return map;
        });
      });
    }, 150);

    return () => clearTimeout(timer);
  }, [
    pendingPrompt,
    sessionId,
    backendReady,
    isAgentBusy,
    setPendingPrompt,
    setStreamingStates,
    setMessages,
    planStreamCaptureRef,
    agentPermissionMode,
    enterPlan,
    agentChannelId,
    outgoingModelId,
    currentWorkspaceId,
    workspaceId
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
    } catch (error) {
      console.error("[AgentView] open native folder dialog failed", error);
    }
  }, [sessionId, setPendingFolderRefs, workspaceId, workspaces]);

  const handleRemoveFile = useCallback((id: string): void => {
    setPendingFiles((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target?.previewUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(target.previewUrl);
      }
      window.__pendingAgentFileData?.delete(id);
      return prev.filter((item) => item.id !== id);
    });
  }, [setPendingFiles]);

  const handleCompact = useCallback((): void => {
    if (!sessionId || !agentChannelId || isAgentBusy) return;

    setStreamingStates((prev) => {
      const map = new Map(prev);
      map.set(sessionId, { running: true, content: "", toolActivities: [], teammates: [], events: [] });
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
  }, [sessionId, agentChannelId, isAgentBusy, setStreamingStates, outgoingModelId, workspaceId, agentPermissionMode]);

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

  const sendFromMessageContent = useCallback((content: string, messageMetadata?: Record<string, unknown>): void => {
    if (!sessionId || !backendReady || isAgentBusy) return;
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
        teammates: [],
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
      workspaceId: currentWorkspaceId ?? workspaceId ?? undefined,
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
    isAgentBusy,
    planStreamCaptureRef,
    agentPermissionMode,
    enterPlan,
    setStreamErrors,
    setStreamingStates,
    outgoingModelId,
    setMessages,
    agentChannelId,
    currentWorkspaceId,
    workspaceId
  ]);

  const truncateFromMessage = useCallback(async (messageId: string): Promise<void> => {
    if (!sessionId) return;
    const updated = await truncateAgentMessagesFrom(sessionId, messageId);
    setMessages(updated);
  }, [sessionId, setMessages]);

  const handleResendMessage = useCallback(async (message: AgentMessage): Promise<void> => {
    if (isAgentBusy || !sessionId) return;
    await truncateFromMessage(message.id);
    sendFromMessageContent(message.content ?? "");
  }, [isAgentBusy, sessionId, truncateFromMessage, sendFromMessageContent]);

  const handleDeleteMessage = useCallback(async (message: AgentMessage): Promise<void> => {
    if (isAgentBusy || !sessionId) return;
    await truncateFromMessage(message.id);
    setInlineEditingMessageId(null);
  }, [isAgentBusy, sessionId, truncateFromMessage, setInlineEditingMessageId]);

  const handleSubmitInlineEdit = useCallback(async (message: AgentMessage, payload: InlineEditPayload): Promise<void> => {
    if (isAgentBusy || !sessionId) return;
    const text = payload.content.trim();
    const nextContent = payload.preserveAttachedFiles
      ? `${(message.content.match(/<attached_files>[\s\S]*?<\/attached_files>\n*/)?.[0] ?? "")}${text}`.trim()
      : text;
    if (!nextContent) return;
    await truncateFromMessage(message.id);
    sendFromMessageContent(nextContent);
    setInlineEditingMessageId(null);
  }, [isAgentBusy, sessionId, truncateFromMessage, sendFromMessageContent, setInlineEditingMessageId]);

  const handleSend = useCallback(async (): Promise<void> => {
    const text = inputContent.trim();
    if ((!text && pendingFiles.length === 0 && pendingFolderRefs.length === 0) || !sessionId || !backendReady || isAgentBusy) {
      return;
    }

    setStreamErrors((prev) => {
      const map = new Map(prev);
      map.delete(sessionId);
      return map;
    });

    let fileReferences = "";

    if (pendingFiles.length > 0 && currentWorkspaceSlug) {
      try {
        const files = pendingFiles.map((file) => ({
          filename: file.filename,
          data: window.__pendingAgentFileData?.get(file.id) || ""
        }));
        const saved = await saveFilesToAgentSession({
          workspaceSlug: currentWorkspaceSlug,
          sessionId,
          files
        });
        fileReferences += buildAttachedFilesReferenceBlock(saved);
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
      fileReferences += buildAttachedFilesReferenceBlock(pendingFolderRefs);
      setPendingFolderRefs([]);
    }

    const finalMessage = `${fileReferences}${text}`;

    if (shouldQueueAgentTitleGeneration({
      currentTitle: sessionTitle,
      userMessage: text,
      channelId: agentChannelId,
      modelId: outgoingModelId,
      hasPendingTitle: pendingTitleRef.current.has(sessionId)
    })) {
      pendingTitleRef.current.set(sessionId, {
        userMessage: text,
        channelId: agentChannelId as string,
        modelId: outgoingModelId as string
      });
    }

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
        teammates: [],
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
      workspaceId: currentWorkspaceId ?? workspaceId ?? undefined,
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
    isAgentBusy,
    setStreamErrors,
    currentWorkspaceSlug,
    setPendingFiles,
    setPendingFolderRefs,
    sessionTitle,
    agentChannelId,
    outgoingModelId,
    pendingTitleRef,
    planStreamCaptureRef,
    agentPermissionMode,
    enterPlan,
    setStreamingStates,
    setMessages,
    setInputContent,
    currentWorkspaceId,
    workspaceId
  ]);

  return {
    addFilesAsAttachments,
    handleOpenFileDialog,
    handleOpenFolderDialog,
    handleRemoveFile,
    handleCompact,
    handleStop,
    handleSend,
    sendFromMessageContent,
    truncateFromMessage,
    handleResendMessage,
    handleDeleteMessage,
    handleSubmitInlineEdit
  };
}
