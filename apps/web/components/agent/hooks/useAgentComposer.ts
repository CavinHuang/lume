import { useCallback, useEffect } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  AgentMessage,
  AgentPendingFile,
  AgentSavedFile,
  AgentSendInput,
  ThinkingLevel
} from "@lume/shared";
import type { AgentStreamState } from "@/atoms/agent-atoms";
import {
  copyFolderToAgentThread,
  saveFilesToAgentThread,
  sendAgentThreadMessage,
  stopAgentThreadRun,
  truncateAgentThreadMessagesFrom
} from "@/lib/desktop-api/agent";
import { openChatFileDialog } from "@/lib/desktop-api/chat";
import { openFolderDialog } from "@/lib/desktop-api/system";
import {
  buildAttachedFilesReferenceBlock,
  fileToBase64,
  shouldDispatchPendingPrompt,
  shouldQueueAgentTitleGeneration
} from "../agent-composer";
import { trimMessagesFromTarget } from "../agent-message-trim";

function createPendingClientMessageId(): string {
  return `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface UseAgentComposerParams {
  threadId: string | null;
  sessionTitle: string;
  currentWorkspaceSlug: string | null;
  currentWorkspaceId: string | null;
  workspaceId: string | null;
  workspaces: Array<{ id: string; slug: string }>;
  backendReady: boolean;
  isAgentBusy: boolean;
  pendingPrompt: { threadId: string; message: string } | null;
  setPendingPrompt: Dispatch<SetStateAction<{ threadId: string; message: string } | null>>;
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
  agentThinkingLevel: ThinkingLevel;
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
  threadId,
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
  agentThinkingLevel,
  planStreamCaptureRef,
  pendingTitleRef
}: UseAgentComposerParams): UseAgentComposerResult {
  useEffect(() => {
    if (!shouldDispatchPendingPrompt({
      pendingPromptThreadId: pendingPrompt?.threadId ?? null,
      threadId,
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
        map.set(threadId as string, { running: true, content: "", toolActivities: [] });
        return map;
      });

      const pendingClientMessageId = createPendingClientMessageId();
      const tempUserMessage: AgentMessage = {
        id: `temp-${Date.now()}`,
        role: "user",
        content: prompt.message,
        createdAt: Date.now(),
        metadata: {
          pendingClientMessageId
        }
      };
      setMessages((prev) => [...prev, tempUserMessage]);
      planStreamCaptureRef.current = agentPermissionMode === "plan";
      if (agentPermissionMode === "plan") {
        enterPlan();
      }

      void sendAgentThreadMessage({
        threadId: threadId as string,
        userMessage: prompt.message,
        messageMetadata: {
          pendingClientMessageId
        },
        thinkingLevel: agentThinkingLevel,
        channelId: agentChannelId ?? undefined,
        modelId: outgoingModelId,
        workspaceId: currentWorkspaceId ?? workspaceId ?? undefined,
        threadType: "main",
        chatType: "direct",
        permissionMode: agentPermissionMode
      }).catch((error) => {
        console.error("[AgentView] send pending prompt failed", error);
        setStreamingStates((prev) => {
          const map = new Map(prev);
          map.delete(threadId as string);
          return map;
        });
      });
    }, 150);

    return () => clearTimeout(timer);
  }, [
    pendingPrompt,
    threadId,
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
          sourcePath: fileInfo.sourcePath,
          previewUrl
        });
        if (fileInfo.data) {
          window.__pendingAgentFileData.set(id, fileInfo.data);
        }
      }
      setPendingFiles((prev) => [...prev, ...next]);
    } catch (error) {
      console.error("[AgentView] open file dialog failed", error);
    }
  }, [setPendingFiles]);

  const handleOpenFolderDialog = useCallback(async (): Promise<void> => {
    if (!threadId || !workspaceId) return;
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (!workspace) return;

    try {
      const result = await openFolderDialog();
      if (!result.path) return;
      const saved = await copyFolderToAgentThread({
        sourcePath: result.path,
        workspaceSlug: workspace.slug,
        threadId
      });
      setPendingFolderRefs((prev) => [...prev, ...saved]);
    } catch (error) {
      console.error("[AgentView] open native folder dialog failed", error);
    }
  }, [threadId, setPendingFolderRefs, workspaceId, workspaces]);

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
    if (!threadId || !agentChannelId || isAgentBusy) return;

    setStreamingStates((prev) => {
      const map = new Map(prev);
      map.set(threadId, { running: true, content: "", toolActivities: [] });
      return map;
    });

      void sendAgentThreadMessage({
        threadId,
        userMessage: "/compact",
        channelId: agentChannelId,
        modelId: outgoingModelId,
      workspaceId: workspaceId ?? undefined,
      threadType: "main",
      chatType: "direct",
      permissionMode: agentPermissionMode
    });
  }, [threadId, agentChannelId, isAgentBusy, setStreamingStates, outgoingModelId, workspaceId, agentPermissionMode]);

  const handleStop = useCallback((): void => {
    if (!threadId) return;

    setStreamingStates((prev) => {
      const current = prev.get(threadId);
      if (!current) return prev;
      const map = new Map(prev);
      map.set(threadId, { ...current, running: false });
      return map;
    });

    void stopAgentThreadRun(threadId);
  }, [threadId, setStreamingStates]);

  const sendFromMessageContent = useCallback((
    content: string,
    messageMetadata?: Record<string, unknown>,
    sendOverrides?: Pick<AgentSendInput, "resendFromMessageId" | "editFromMessageId">
  ): void => {
    if (!threadId || !backendReady || isAgentBusy) return;
    planStreamCaptureRef.current = agentPermissionMode === "plan";
    if (agentPermissionMode === "plan") {
      enterPlan();
    }

    setStreamErrors((prev) => {
      const map = new Map(prev);
      map.delete(threadId);
      return map;
    });
    setStreamingStates((prev) => {
      const map = new Map(prev);
      map.set(threadId, {
        running: true,
        content: "",
        toolActivities: [],
        model: outgoingModelId
      });
      return map;
    });

    const pendingClientMessageId = createPendingClientMessageId();
    const finalMessageMetadata = {
      ...messageMetadata,
      pendingClientMessageId
    };

    const tempMessage: AgentMessage = {
      id: `temp-${Date.now()}`,
      role: "user",
      content,
      createdAt: Date.now(),
      metadata: finalMessageMetadata
    };
    setMessages((prev) => [...prev, tempMessage]);

    void sendAgentThreadMessage({
      threadId,
      userMessage: content,
      messageMetadata: finalMessageMetadata,
      ...sendOverrides,
      channelId: agentChannelId ?? undefined,
      modelId: outgoingModelId,
      workspaceId: currentWorkspaceId ?? workspaceId ?? undefined,
      threadType: "main",
      chatType: "direct",
      permissionMode: agentPermissionMode,
      thinkingLevel: agentThinkingLevel
    }).catch((error) => {
      console.error("[AgentView] resend failed", error);
      const message = error instanceof Error ? error.message : String(error);
      setStreamErrors((prev) => {
        const map = new Map(prev);
        map.set(threadId, `重发失败: ${message}`);
        return map;
      });
      setStreamingStates((prev) => {
        if (!prev.has(threadId)) return prev;
        const map = new Map(prev);
        map.delete(threadId);
        return map;
      });
    });
  }, [
    threadId,
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
    workspaceId,
    agentThinkingLevel
  ]);

  const truncateFromMessage = useCallback(async (messageId: string): Promise<void> => {
    if (!threadId) return;
    const updated = await truncateAgentThreadMessagesFrom(threadId, messageId);
    setMessages(updated);
  }, [threadId, setMessages]);

  const handleResendMessage = useCallback(async (message: AgentMessage): Promise<void> => {
    if (isAgentBusy || !threadId) return;
    setMessages((prev) => trimMessagesFromTarget(prev, message.id));
    sendFromMessageContent(message.content ?? "", undefined, {
      resendFromMessageId: message.id
    });
  }, [isAgentBusy, threadId, sendFromMessageContent, setMessages]);

  const handleDeleteMessage = useCallback(async (message: AgentMessage): Promise<void> => {
    if (isAgentBusy || !threadId) return;
    await truncateFromMessage(message.id);
    setInlineEditingMessageId(null);
  }, [isAgentBusy, threadId, truncateFromMessage, setInlineEditingMessageId]);

  const handleSubmitInlineEdit = useCallback(async (message: AgentMessage, payload: InlineEditPayload): Promise<void> => {
    if (isAgentBusy || !threadId) return;
    const text = payload.content.trim();
    const nextContent = payload.preserveAttachedFiles
      ? `${(message.content.match(/<attached_files>[\s\S]*?<\/attached_files>\n*/)?.[0] ?? "")}${text}`.trim()
      : text;
    if (!nextContent) return;
    setMessages((prev) => trimMessagesFromTarget(prev, message.id));
    sendFromMessageContent(nextContent, undefined, {
      editFromMessageId: message.id
    });
    setInlineEditingMessageId(null);
  }, [isAgentBusy, threadId, sendFromMessageContent, setInlineEditingMessageId, setMessages]);

  const handleSend = useCallback(async (): Promise<void> => {
    const text = inputContent.trim();
    if ((!text && pendingFiles.length === 0 && pendingFolderRefs.length === 0) || !threadId || !backendReady || isAgentBusy) {
      return;
    }

    setStreamErrors((prev) => {
      const map = new Map(prev);
      map.delete(threadId);
      return map;
    });

    let fileReferences = "";

    if (pendingFiles.length > 0 && currentWorkspaceSlug) {
      try {
        const files = pendingFiles.map((file) => ({
          filename: file.filename,
          ...(window.__pendingAgentFileData?.get(file.id) ? { data: window.__pendingAgentFileData?.get(file.id) || "" } : {}),
          ...(file.sourcePath ? { sourcePath: file.sourcePath } : {})
        }));
        const saved = await saveFilesToAgentThread({
          workspaceSlug: currentWorkspaceSlug,
          threadId,
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
      hasPendingTitle: pendingTitleRef.current.has(threadId)
    })) {
      pendingTitleRef.current.set(threadId, {
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
      map.set(threadId, {
        running: true,
        content: "",
        toolActivities: [],
        model: outgoingModelId
      });
      return map;
    });

    const tempMessage: AgentMessage = {
      id: `temp-${Date.now()}`,
      role: "user",
      content: finalMessage,
      createdAt: Date.now(),
      metadata: {
        pendingClientMessageId: createPendingClientMessageId()
      }
    };
    setMessages((prev) => [...prev, tempMessage]);
    setInputContent("");

    void sendAgentThreadMessage({
      threadId,
      userMessage: finalMessage,
      messageMetadata: tempMessage.metadata,
      thinkingLevel: agentThinkingLevel,
      channelId: agentChannelId ?? undefined,
      modelId: outgoingModelId,
      workspaceId: currentWorkspaceId ?? workspaceId ?? undefined,
      threadType: "main",
      chatType: "direct",
      permissionMode: agentPermissionMode
    }).catch((error) => {
      console.error("[AgentView] send failed", error);
      const message = error instanceof Error ? error.message : String(error);
      setStreamErrors((prev) => {
        const map = new Map(prev);
        map.set(threadId, `发送失败: ${message}`);
        return map;
      });
      setStreamingStates((prev) => {
        if (!prev.has(threadId)) return prev;
        const map = new Map(prev);
        map.delete(threadId);
        return map;
      });
    });
  }, [
    inputContent,
    pendingFiles,
    pendingFolderRefs,
    threadId,
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
    ,
    agentThinkingLevel
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




