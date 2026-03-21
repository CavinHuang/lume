"use client";

import { useCallback, useEffect, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { CornerDownLeft, Lightbulb, Paperclip, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  pendingAttachmentsAtom,
  selectedModelAtom,
  streamingAtom,
  thinkingEnabledAtom,
  type PendingAttachment
} from "@/atoms/chat-atoms";
import { openChatFileDialog } from "@/lib/desktop-api";
import { RichTextInput } from "@/components/ai-elements/rich-text-input";
import { SpeechButton } from "@/components/ai-elements/speech-button";
import { AttachmentPreviewItem } from "./AttachmentPreviewItem";
import { ModelSelector } from "./ModelSelector";
import { ContextSettingsPopover } from "./ContextSettingsPopover";
import { ClearContextButton } from "./ClearContextButton";
import { ToolSelectorPopover } from "./ToolSelectorPopover";

interface ChatInputProps {
  disabled?: boolean;
  onSend: (text: string) => Promise<void>;
  onStop: () => void;
  onClearContext?: () => void;
}

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

export function ChatInput({ disabled, onSend, onStop, onClearContext }: ChatInputProps): React.ReactElement {
  const [content, setContent] = useState("");
  const [selectedModel] = useAtom(selectedModelAtom);
  const [streaming] = useAtom(streamingAtom);
  const [thinkingEnabled, setThinkingEnabled] = useAtom(thinkingEnabledAtom);
  const [pendingAttachments, setPendingAttachments] = useAtom(pendingAttachmentsAtom);
  const [isDragOver, setIsDragOver] = useState(false);

  const canSend =
    !disabled &&
    selectedModel !== null &&
    !streaming &&
    (content.trim().length > 0 || pendingAttachments.length > 0);

  const handleRemoveAttachment = useCallback((id: string): void => {
    setPendingAttachments((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target?.previewUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(target.previewUrl);
      }
      window.__pendingAttachmentData?.delete(id);
      return prev.filter((item) => item.id !== id);
    });
  }, [setPendingAttachments]);

  const addFilesAsAttachments = useCallback(async (files: File[]): Promise<void> => {
    for (const file of files) {
      try {
        const data = await fileToBase64(file);
        const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
        const attachment: PendingAttachment = {
          id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          filename: file.name,
          mediaType: file.type || "application/octet-stream",
          localPath: "",
          size: file.size,
          previewUrl
        };
        if (!window.__pendingAttachmentData) {
          window.__pendingAttachmentData = new Map<string, string>();
        }
        window.__pendingAttachmentData.set(attachment.id, data);
        setPendingAttachments((prev) => [...prev, attachment]);
      } catch (error) {
        console.error("[ChatInput] add attachment failed:", error);
      }
    }
  }, [setPendingAttachments]);

  const handleOpenFileDialog = useCallback(async (): Promise<void> => {
    try {
      const result = await openChatFileDialog();
      for (const fileInfo of result.files) {
        const previewUrl = fileInfo.mediaType.startsWith("image/")
          ? `data:${fileInfo.mediaType};base64,${fileInfo.data}`
          : undefined;

        const attachment: PendingAttachment = {
          id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          filename: fileInfo.filename,
          mediaType: fileInfo.mediaType,
          localPath: "",
          size: fileInfo.size,
          previewUrl
        };
        if (!window.__pendingAttachmentData) {
          window.__pendingAttachmentData = new Map<string, string>();
        }
        window.__pendingAttachmentData.set(attachment.id, fileInfo.data);
        setPendingAttachments((prev) => [...prev, attachment]);
      }
    } catch (error) {
      console.error("[ChatInput] open file dialog failed:", error);
    }
  }, [setPendingAttachments]);

  const sendNow = useCallback((): void => {
    if (!canSend) return;
    const next = content.trim();
    setContent("");
    void onSend(next);
  }, [canSend, content, onSend]);

  const handleSpeechTranscript = useCallback((text: string): void => {
    setContent((prev) => prev + (prev ? " " : "") + text);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onClearContext?.();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClearContext]);

  return (
    <div className="px-2.5 pb-2.5 pt-2 md:px-[18px] md:pb-[18px]">
      <div
        className={cn(
          "rounded-[17px] border-[0.5px] border-border bg-background/70 pt-2 backdrop-blur-sm transition-all duration-200",
          "focus-within:border-foreground/20",
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
          const files = Array.from(event.dataTransfer.files ?? []);
          if (files.length > 0) {
            void addFilesAsAttachments(files);
          }
        }}
      >
        {pendingAttachments.length > 0 ? (
          <div className="flex flex-wrap gap-1 px-[15px] py-[5px]">
            {pendingAttachments.map((attachment) => (
              <AttachmentPreviewItem
                key={attachment.id}
                filename={attachment.filename}
                mediaType={attachment.mediaType}
                previewUrl={attachment.previewUrl}
                onRemove={() => handleRemoveAttachment(attachment.id)}
              />
            ))}
          </div>
        ) : null}

        <RichTextInput
          value={content}
          onChange={setContent}
          onSubmit={() => { void sendNow(); }}
          onPasteFiles={(files) => { void addFilesAsAttachments(files); }}
          placeholder={
            selectedModel
              ? "输入消息... (Enter 发送，Shift+Enter 换行。支持拖放文件和直接粘贴图片)"
              : "请先选择模型"
          }
          disabled={!selectedModel}
        />

        <div className="flex h-[40px] items-center justify-between gap-4 px-2 py-[5px]">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
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
              <TooltipContent side="top">
                <p>添加附件</p>
              </TooltipContent>
            </Tooltip>

            <ModelSelector />
            <ToolSelectorPopover />

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={cn(
                    "size-[30px] rounded-full",
                    thinkingEnabled ? "text-green-500" : "text-foreground/60 hover:text-foreground"
                  )}
                  onClick={() => setThinkingEnabled(!thinkingEnabled)}
                >
                  <Lightbulb className="size-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p>{thinkingEnabled ? "关闭思考模式" : "开启思考模式"}</p>
              </TooltipContent>
            </Tooltip>

            <SpeechButton onTranscript={handleSpeechTranscript} />
            <ContextSettingsPopover />
            <ClearContextButton onClick={onClearContext} />
          </div>

          <div className="flex items-center gap-1.5">
            {streaming ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-[30px] rounded-full text-destructive hover:bg-destructive/10"
                onClick={onStop}
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
                onClick={() => { void sendNow(); }}
                disabled={!canSend}
              >
                <CornerDownLeft className="size-[22px]" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
