import * as React from "react";
import { Upload, File, FolderPlus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { saveFilesToAgentThread, saveFilesToWorkspace } from "@/lib/desktop-api/agent";
import { fileToBase64 } from "@/components/agent/agent-composer";

interface FileDropZoneProps {
  workspaceSlug: string;
  threadId?: string;
  target?: "session" | "workspace";
  onFilesUploaded: () => void;
  onAttachFolder?: () => void;
  onFoldersDropped?: (folderPaths: string[]) => void;
}

export function FileDropZone({
  workspaceSlug,
  threadId,
  target = "session",
  onFilesUploaded,
  onAttachFolder,
  onFoldersDropped
}: FileDropZoneProps): React.ReactElement {
  const [isDragOver, setIsDragOver] = React.useState(false);
  const [isUploading, setIsUploading] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const isWorkspace = target === "workspace";

  const saveFiles = React.useCallback(async (files: globalThis.File[]): Promise<void> => {
    if (files.length === 0) return;

    setIsUploading(true);
    try {
      const fileEntries: Array<{ filename: string; data: string }> = [];
      for (const file of files) {
        const base64 = await fileToBase64(file);
        fileEntries.push({ filename: file.name, data: base64 });
      }

      if (isWorkspace) {
        await saveFilesToWorkspace({
          workspaceSlug,
          files: fileEntries
        });
      } else {
        await saveFilesToAgentThread({
          workspaceSlug,
          threadId: threadId ?? "",
          files: fileEntries
        });
      }

      onFilesUploaded();
    } catch (error) {
      console.error("[FileDropZone] 文件上传失败:", error);
    } finally {
      setIsUploading(false);
    }
  }, [onFilesUploaded, threadId, workspaceSlug]);

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
    const folderPaths: string[] = [];

    for (const item of items) {
      if (item.kind !== "file") continue;
      const entry = item.webkitGetAsEntry?.();
      if (entry?.isDirectory) {
        folderPaths.push((entry as FileSystemDirectoryEntry).fullPath || entry.name);
        continue;
      }
      const file = item.getAsFile();
      if (file) regularFiles.push(file);
    }

    if (folderPaths.length > 0) {
      if (onFoldersDropped) {
        onFoldersDropped(folderPaths);
      } else {
        console.info("[FileDropZone] 不支持直接拖拽文件夹，请使用附加文件夹按钮");
      }
    }

    if (regularFiles.length > 0) {
      await saveFiles(regularFiles);
    }
  }, [onFoldersDropped, saveFiles]);

  const handleSelectFiles = React.useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleInputChange = React.useCallback((e: React.ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) {
      void saveFiles(files);
    }
    e.target.value = "";
  }, [saveFiles]);

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
          isDragOver ? "border-primary bg-primary/5" : "border-muted-foreground/20 hover:border-muted-foreground/40",
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
            <Upload className={cn("size-5 transition-colors", isDragOver ? "text-primary" : "text-muted-foreground/75")} />
            <p className="text-xs text-muted-foreground text-center leading-relaxed">
              拖拽文件到此处
              <br />
              <span className="text-[10px] text-muted-foreground/75">
                {isWorkspace ? "工作区内所有会话可访问" : "供 Agent 读取和处理"}
              </span>
            </p>
            <div className="flex items-center gap-1.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 text-[11px] px-2 gap-1 text-muted-foreground hover:text-foreground"
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
                    variant="ghost"
                    size="sm"
                    className="h-6 text-[11px] px-2 gap-1 text-muted-foreground hover:text-foreground"
                    onClick={() => { onAttachFolder(); }}
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
