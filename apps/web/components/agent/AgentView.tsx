"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { AlertCircle, Bot, CornerDownLeft, FolderPlus, Paperclip, Settings, Square, X } from "lucide-react";
import type { AgentMessage, AgentPendingFile, AgentSavedFile, Channel, ModelOption } from "@lume/shared";
import {
  activeViewAtom,
  agentContextStatusAtom,
  agentSessionsAtom,
  agentChannelIdAtom,
  agentModelIdAtom,
  agentPendingFilesAtom,
  agentPendingPromptAtom,
  agentStreamingAtom,
  agentStreamErrorsAtom,
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
  onAgentTitleUpdated,
  openFolderDialog,
  openChatFileDialog,
  copyFolderToAgentSession,
  saveFilesToAgentSession,
  sendAgentMessage,
  stopAgentRun
} from "@/lib/desktop-api";
import { cn } from "@/lib/utils";
import { AgentHeader } from "./AgentHeader";
import { AgentMessages } from "./AgentMessages";
import { ContextUsageBadge } from "./ContextUsageBadge";
import { FileBrowser } from "@/components/file-browser";
import { AttachmentPreviewItem } from "@/components/chat/AttachmentPreviewItem";
import { ModelSelector } from "@/components/chat/ModelSelector";
import { RichTextInput } from "@/components/ai-elements/rich-text-input";
import { Button } from "@/components/ui/button";
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

export function AgentView(): React.ReactElement {
  const [sessionId] = useAtom(currentAgentSessionIdAtom);
  const session = useAtomValue(currentAgentSessionAtom);
  const [workspaceId] = useAtom(currentAgentWorkspaceIdAtom);
  const [workspaces] = useAtom(agentWorkspacesAtom);
  const [, setMessages] = useAtom(currentAgentMessagesAtom);
  const setStreamingStates = useSetAtom(agentStreamingStatesAtom);
  const streaming = useAtomValue(agentStreamingAtom);
  const contextStatus = useAtomValue(agentContextStatusAtom);
  const [agentError] = useAtom(currentAgentErrorAtom);
  const setActiveView = useSetAtom(activeViewAtom);
  const setSessions = useSetAtom(agentSessionsAtom);
  const setStreamErrors = useSetAtom(agentStreamErrorsAtom);

  const [channels, setChannels] = useState<Channel[]>([]);
  const [agentChannelId, setAgentChannelId] = useAtom(agentChannelIdAtom);
  const [agentModelId, setAgentModelId] = useAtom(agentModelIdAtom);
  const [pendingFiles, setPendingFiles] = useAtom(agentPendingFilesAtom);
  const [pendingPrompt, setPendingPrompt] = useAtom(agentPendingPromptAtom);
  const [inputContent, setInputContent] = useState("");
  const [sessionRootPath, setSessionRootPath] = useState<string | null>(null);
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [pendingFolderRefs, setPendingFolderRefs] = useState<AgentSavedFile[]>([]);

  const currentSessionIdRef = useRef<string | null>(sessionId);
  useEffect(() => {
    currentSessionIdRef.current = sessionId;
  }, [sessionId]);

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

    trackUnlisten(onAgentStreamEvent((payload) => {
      setStreamingStates((prev) => {
        const map = new Map(prev);
        const current = map.get(payload.sessionId) ?? {
          running: true,
          content: "",
          toolActivities: []
        };
        map.set(payload.sessionId, applyAgentEvent(current, payload.event));
        return map;
      });
    }));

    trackUnlisten(onAgentStreamComplete((payload) => {
      const finalize = (): void => {
        removeState(payload.sessionId);
        void listAgentSessions().then(setSessions);
      };

      if (payload.sessionId === currentSessionIdRef.current) {
        void getAgentSessionMessages(payload.sessionId)
          .then((next) => {
            setMessages(next);
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

      const finalize = (): void => removeState(payload.sessionId);

      if (payload.sessionId === currentSessionIdRef.current) {
        void getAgentSessionMessages(payload.sessionId)
          .then((next) => {
            setMessages(next);
            finalize();
          })
          .catch(() => finalize());
      } else {
        finalize();
      }
    }));

    trackUnlisten(onAgentTitleUpdated(() => {
      void listAgentSessions().then(setSessions);
    }));

    return () => {
      disposed = true;
      for (const fn of unsubs) fn();
    };
  }, [setMessages, setSessions, setStreamErrors, setStreamingStates]);

  useEffect(() => {
    if (!pendingPrompt) return;
    if (!sessionId || pendingPrompt.sessionId !== sessionId) return;
    if (!agentChannelId || streaming) return;

    const prompt = pendingPrompt;
    setPendingPrompt(null);

    const timer = setTimeout(() => {
      setStreamingStates((prev) => {
        const map = new Map(prev);
        map.set(sessionId, { running: true, content: "", toolActivities: [] });
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
        channelId: agentChannelId,
        modelId: agentModelId ?? undefined,
        workspaceId: workspaceId ?? undefined
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
    agentChannelId,
    agentModelId,
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
      const current = map.get(sessionId) ?? { running: true, content: "", toolActivities: [] };
      map.set(sessionId, { ...current, running: true });
      return map;
    });

    void sendAgentMessage({
      sessionId,
      userMessage: "/compact",
      channelId: agentChannelId,
      modelId: agentModelId ?? undefined,
      workspaceId: workspaceId ?? undefined
    });
  }, [sessionId, agentChannelId, agentModelId, workspaceId, streaming, setStreamingStates]);

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
    if ((!text && pendingFiles.length === 0 && pendingFolderRefs.length === 0) || !sessionId || !agentChannelId || streaming) {
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
        model: agentModelId ?? undefined
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
      channelId: agentChannelId,
      modelId: agentModelId ?? undefined,
      workspaceId: workspaceId ?? undefined
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
    agentChannelId,
    agentModelId,
    workspaceId,
    workspaces,
    streaming,
    setStreamErrors,
    setStreamingStates,
    setMessages
  ]);

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
    && agentChannelId !== null
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
    <div className="flex h-full overflow-hidden">
      <div className="mx-auto flex h-full min-w-0 max-w-[min(72rem,100%)] flex-1 flex-col">
        <AgentHeader
          onToggleFileBrowser={() => setFileBrowserOpen((prev) => !prev)}
          fileBrowserOpen={fileBrowserOpen}
        />

        <AgentMessages />

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
              placeholder={agentChannelId ? "输入消息... (Enter 发送，Shift+Enter 换行)" : "请先在设置中选择 Agent 供应商"}
              disabled={!agentChannelId}
            />

            <div className="flex h-[40px] items-center justify-between gap-4 px-2 py-[5px]">
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                {agentChannelId ? (
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

                    <ModelSelector
                      filterChannelId={agentChannelId}
                      externalSelectedModel={externalSelectedModel}
                      onModelSelect={handleModelSelect}
                    />

                    <ContextUsageBadge
                      inputTokens={contextStatus.inputTokens}
                      contextWindow={contextStatus.contextWindow}
                      isCompacting={contextStatus.isCompacting}
                      isProcessing={streaming}
                      onCompact={handleCompact}
                    />
                  </>
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
  );
}
