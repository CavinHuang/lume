"use client";

import * as React from "react";
import { Paperclip, SendHorizontal, X } from "lucide-react";
import type { ChatMessage, FileAttachment } from "@lume/shared";
import { MessageAction } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import { openChatFileDialog, readChatAttachment } from "@/lib/desktop-api";
import { AttachmentPreviewItem } from "./AttachmentPreviewItem";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.includes(",") ? result.split(",")[1] ?? "" : "");
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

interface NewInlineAttachment {
  filename: string;
  mediaType: string;
  size: number;
  data: string;
}

export interface InlineEditSubmitPayload {
  content: string;
  keepExistingAttachments: FileAttachment[];
  newAttachments: NewInlineAttachment[];
}

type EditableAttachment =
  | {
      kind: "existing";
      id: string;
      attachment: FileAttachment;
      previewUrl?: string;
    }
  | {
      kind: "new";
      id: string;
      attachment: FileAttachment;
      base64: string;
      previewUrl?: string;
    };

interface InlineEditFormProps {
  message: ChatMessage;
  onSubmit: (payload: InlineEditSubmitPayload) => void;
  onCancel: () => void;
}

export function InlineEditForm({ message, onSubmit, onCancel }: InlineEditFormProps): React.ReactElement {
  const [editingContent, setEditingContent] = React.useState(message.content ?? "");
  const [editableAttachments, setEditableAttachments] = React.useState<EditableAttachment[]>([]);
  const [isDragOver, setIsDragOver] = React.useState(false);

  React.useEffect(() => {
    const existing: EditableAttachment[] = (message.attachments ?? []).map((att) => ({
      kind: "existing",
      id: `existing-${att.id}`,
      attachment: att
    }));
    setEditableAttachments(existing);

    const imageAttachments = (message.attachments ?? []).filter((att) => att.mediaType.startsWith("image/"));
    if (imageAttachments.length === 0) return;

    let canceled = false;
    void Promise.all(
      imageAttachments.map(async (att) => {
        try {
          const base64 = await readChatAttachment(att.localPath);
          return { id: `existing-${att.id}`, previewUrl: `data:${att.mediaType};base64,${base64}` };
        } catch {
          return { id: `existing-${att.id}`, previewUrl: undefined };
        }
      })
    ).then((results) => {
      if (canceled) return;
      setEditableAttachments((prev) =>
        prev.map((item) => {
          const found = results.find((result) => result.id === item.id);
          if (!found || !found.previewUrl) return item;
          return { ...item, previewUrl: found.previewUrl };
        })
      );
    });

    return () => {
      canceled = true;
    };
  }, [message.id, message.attachments]);

  const addPendingAttachments = React.useCallback((items: NewInlineAttachment[]): void => {
    if (items.length === 0) return;
    const now = Date.now();
    const next: EditableAttachment[] = items.map((item, idx) => {
      const tempId = `inline-new-${now}-${idx}-${Math.random().toString(36).slice(2)}`;
      return {
        kind: "new",
        id: tempId,
        attachment: {
          id: tempId,
          filename: item.filename,
          mediaType: item.mediaType,
          localPath: "",
          size: item.size
        },
        base64: item.data,
        previewUrl: item.mediaType.startsWith("image/") ? `data:${item.mediaType};base64,${item.data}` : undefined
      };
    });
    setEditableAttachments((prev) => [...prev, ...next]);
  }, []);

  const handleSelectAttachments = React.useCallback(async (): Promise<void> => {
    try {
      const result = await openChatFileDialog();
      addPendingAttachments(
        result.files.map((file) => ({
          filename: file.filename,
          mediaType: file.mediaType,
          size: file.size,
          data: file.data
        }))
      );
    } catch (error) {
      console.error("[InlineEditForm] 选择附件失败:", error);
    }
  }, [addPendingAttachments]);

  const handleDropFiles = React.useCallback(
    async (files: File[]): Promise<void> => {
      const converted: NewInlineAttachment[] = [];
      for (const file of files) {
        try {
          const base64 = await fileToBase64(file);
          converted.push({
            filename: file.name || `粘贴附件-${Date.now()}`,
            mediaType: file.type || "application/octet-stream",
            size: file.size,
            data: base64
          });
        } catch (error) {
          console.error("[InlineEditForm] 处理附件失败:", error);
        }
      }
      addPendingAttachments(converted);
    },
    [addPendingAttachments]
  );

  const removeEditableAttachment = React.useCallback((id: string): void => {
    setEditableAttachments((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const canSubmit = editingContent.trim().length > 0 || editableAttachments.length > 0;

  const buildPayload = React.useCallback(
    (): InlineEditSubmitPayload => ({
      content: editingContent.trim(),
      keepExistingAttachments: editableAttachments
        .filter((item): item is EditableAttachment & { kind: "existing" } => item.kind === "existing")
        .map((item) => item.attachment),
      newAttachments: editableAttachments
        .filter((item): item is EditableAttachment & { kind: "new" } => item.kind === "new")
        .map((item) => ({
          filename: item.attachment.filename,
          mediaType: item.attachment.mediaType,
          size: item.attachment.size,
          data: item.base64
        }))
    }),
    [editingContent, editableAttachments]
  );

  const handleSubmit = React.useCallback((): void => {
    if (!canSubmit) return;
    onSubmit(buildPayload());
  }, [buildPayload, canSubmit, onSubmit]);

  return (
    <div
      className={cn(
        "space-y-2 rounded-xl border border-border/60 bg-background/40 p-2",
        isDragOver && "border-dashed border-primary/70 bg-primary/5"
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
        const files = Array.from(event.dataTransfer.files);
        if (files.length > 0) {
          void handleDropFiles(files);
        }
      }}
    >
      {editableAttachments.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {editableAttachments.map((item) => (
            <AttachmentPreviewItem
              key={item.id}
              filename={item.attachment.filename}
              mediaType={item.attachment.mediaType}
              previewUrl={item.previewUrl}
              onRemove={() => removeEditableAttachment(item.id)}
            />
          ))}
        </div>
      ) : null}
      <textarea
        value={editingContent}
        onChange={(event) => setEditingContent(event.target.value)}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files || []);
          if (files.length === 0) return;
          event.preventDefault();
          void handleDropFiles(files);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          } else if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            handleSubmit();
          }
        }}
        className="min-h-[92px] w-full resize-y rounded-xl border border-border bg-background/80 px-3 py-2 text-sm outline-none focus:border-foreground/30"
        placeholder="编辑消息..."
        autoFocus
      />
      <div className="flex items-center justify-end gap-1.5">
        <MessageAction tooltip="添加附件" onClick={() => void handleSelectAttachments()}>
          <Paperclip className="size-3.5" />
        </MessageAction>
        <MessageAction tooltip="取消 (Esc)" onClick={onCancel}>
          <X className="size-3.5" />
        </MessageAction>
        <MessageAction tooltip="发送 (Enter)" onClick={handleSubmit}>
          <SendHorizontal className="size-3.5" />
        </MessageAction>
      </div>
    </div>
  );
}
