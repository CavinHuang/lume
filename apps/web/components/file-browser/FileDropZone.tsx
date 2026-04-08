/**
 * FileDropZone — 文件拖拽上传区域
 *
 * 引导用户通过拖拽或点击将文件添加到 Agent 会话目录或工作区文件目录。
 * 文件上传后直接保存到目标目录，FileBrowser 通过版本号自动刷新。
 */

import * as React from "react";
import { File, FolderPlus, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { saveFilesToAgentThread } from "@/lib/desktop-api/agent";
import { openFolderDialog } from "@/lib/desktop-api/system";
import { fileToBase64 } from "@/components/agent/agent-composer";

export type FileDropZoneTarget = "session" | "workspace";

interface FileDropZoneProps {
  /** 当前工作区 slug（用于 IPC 调用） */
  workspaceSlug: string;
  /** 当前会话 ID（session 模式必传） */
  threadId?: string;
  /** 上传目标：session（会话目录）或 workspace（工作区文件目录） */
  target?: FileDropZoneTarget;
  /** 上传成功后的回调（触发文件浏览器刷新） */
  onFilesUploaded: () => void;
  /** 附加文件夹回调 */
  onAttachFolder?: () => void;
}

export function FileDropZone({
  workspaceSlug,
  threadId,
  target = "session",
  onFilesUploaded,
  onAttachFolder
}: FileDropZoneProps): React.ReactElement {
  const [isDragOver, setIsDragOver] = React.useState(false);
  const [isUploading, setIsUploading] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const isWorkspace = target === "workspace";

  /** 保存文件到目标目录 */
  const saveFiles = React.useCallback(async (files: globalThis.File[]): Promise<void> => {
    if (files.length === 0) return;

    setIsUploading(true);
    try {
      const fileEntries: Array<{ filename: string; data: string }> = [];
      for (const file of files) {
        const base64 = await fileToBase64(file);
        fileEntries.push({ filename: file.name, data: base64 });
      }

      await saveFilesToAgentThread({
        workspaceSlug,
        threadId: threadId ?? "",
        files: fileEntries
      });

      onFilesUploaded();
    } catch (error) {
      console.error("[FileDropZone] 文件上传失败:", error);
    } finally {
      setIsUploading(false);
    }
  }, [workspaceSlug, threadId, onFilesUploaded]);

  // ===== 拖拽处理 =====

  const handleDragOver = React.useCallback((e: React.DragEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = React.useCallback((e: React.DragEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = React.useCallback(async (e: React.DragEvent): Promise<void> => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const items = Array.from(e.dataTransfer.items);
    const regularFiles: globalThis.File[] = [];

    for (const item of items) {
      if (item.kind !== "file") continue;
      const entry = item.webkitGetAsEntry?.();
      if (entry?.isDirectory) {
        // 文件夹不支持直接拖拽
        continue;
      }
      const file = item.getAsFile();
      if (file) regularFiles.push(file);
    }

    if (regularFiles.length > 0) {
      await saveFiles(regularFiles);
    }
  }, [saveFiles]);

  // ===== 按钮点击处理 =====

  const handleSelectFiles = React.useCallback((): void => {
    fileInputRef.current?.click();
  }, []);

  const handleInputChange = React.useCallback((e: React.ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) {
      void saveFiles(files);
    }
    e.target.value = "";
  }, [saveFiles]);

  const handleAttachFolder = React.useCallback(async (): Promise<void> => {
    try {
      const result = await openFolderDialog();
      if (result.path) {
        onAttachFolder?.();
      }
    } catch (err) {
      console.error("[FileDropZone] attach folder failed", err);
    }
  }, [onAttachFolder]);

  return (
    <div className="flex-shrink-0 px-3 pt-3 pb-1">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleInputChange}
      />
      <div
        className={cn(
          "relative flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-3 py-4",
          "transition-colors duration-200 cursor-default",
          isDragOver
            ? "border-primary bg-primary/5"
            : "border-muted-foreground/20 hover:border-muted-foreground/40",
          isUploading && "pointer-events-none opacity-60"
        )}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={(e) => { void handleDrop(e); }}
      >
        {isUploading ? (
          <>
            <Loader2 className="size-5 text-muted-foreground animate-spin" />
            <span className="text-xs text-muted-foreground">正在上传...</span>
          </>
        ) : (
          <>
            <Upload className={cn(
              "size-5 transition-colors",
              isDragOver ? "text-primary" : "text-muted-foreground/60"
            )} />
            <p className="text-xs text-muted-foreground text-center leading-relaxed">
              拖拽文件到此处
              <br />
              <span className="text-[10px] text-muted-foreground/60">
                {isWorkspace ? "工作区内所有会话可访问" : "供 Agent 读取和处理"}
              </span>
            </p>
            <div className="flex items-center gap-1.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-6 text-[11px] px-2 gap-1"
                    onClick={handleSelectFiles}
                  >
                    <File className="size-3" />
                    选择文件
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p>{isWorkspace ? "添加文件到工作区文件目录" : "将文件放入 Agent 工作文件夹"}</p>
                </TooltipContent>
              </Tooltip>
              {onAttachFolder ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-6 text-[11px] px-2 gap-1"
                      onClick={() => { void handleAttachFolder(); }}
                    >
                      <FolderPlus className="size-3" />
                      附加文件夹
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    <p>{isWorkspace ? "附加文件夹供工作区所有会话访问" : "告知 Agent 你想处理的文件夹"}</p>
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

