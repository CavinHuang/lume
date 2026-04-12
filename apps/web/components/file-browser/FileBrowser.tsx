import * as React from "react";
import type { FileEntry } from "@lume/shared";
import { useAtomValue } from "jotai";
import {
  ChevronRight,
  Trash2,
  RefreshCw,
  ExternalLink,
  FolderSearch,
  MoreHorizontal,
  ArrowRightLeft,
  Pencil,
  Eye
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import {
  deleteAgentFile,
  deleteWorkspaceFile,
  listAgentDirectory,
  listWorkspaceDirectory,
  moveAgentFile,
  moveWorkspaceFile,
  openAgentFile,
  openWorkspaceFile,
  previewAgentFile,
  previewWorkspaceFile,
  renameAgentFile,
  renameWorkspaceFile,
  showAgentFileInFolder,
  showWorkspaceFileInFolder
} from "@/lib/desktop-api/agent";
import { cn } from "@/lib/utils";
import { workspaceFilesVersionAtom } from "@/atoms";
import { FileTypeIcon } from "./FileTypeIcon";

interface FileBrowserProps {
  workspaceSlug: string;
  threadId?: string;
  rootPath: string;
  scope?: "thread" | "workspace";
  hideToolbar?: boolean;
  embedded?: boolean;
  hideEmpty?: boolean;
}

export function FileBrowser({
  workspaceSlug,
  threadId,
  rootPath,
  scope = "thread",
  hideToolbar = false,
  embedded = false,
  hideEmpty = false
}: FileBrowserProps): React.ReactElement {
  const [entries, setEntries] = React.useState<FileEntry[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const filesVersion = useAtomValue(workspaceFilesVersionAtom);
  const isWorkspaceScope = scope === "workspace";

  const [selectedPaths, setSelectedPaths] = React.useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = React.useState<FileEntry | null>(null);
  const [deleteCount, setDeleteCount] = React.useState(1);
  const [renamingPath, setRenamingPath] = React.useState<string | null>(null);
  const [moving, setMoving] = React.useState(false);

  const selectedCount = selectedPaths.size;

  const loadDirectory = React.useCallback(async (path: string): Promise<FileEntry[]> => {
    if (isWorkspaceScope) {
      return listWorkspaceDirectory(workspaceSlug, path);
    }
    if (!threadId) {
      throw new Error("缺少线程 ID");
    }
    return listAgentDirectory(workspaceSlug, threadId, path);
  }, [isWorkspaceScope, threadId, workspaceSlug]);

  const openPath = React.useCallback((path: string): Promise<{ ok: true }> => {
    if (isWorkspaceScope) {
      return openWorkspaceFile(workspaceSlug, path);
    }
    if (!threadId) {
      return Promise.reject(new Error("缺少线程 ID"));
    }
    return openAgentFile(workspaceSlug, threadId, path);
  }, [isWorkspaceScope, threadId, workspaceSlug]);

  const previewPath = React.useCallback((path: string): Promise<{ ok: true }> => {
    if (isWorkspaceScope) {
      return previewWorkspaceFile(workspaceSlug, path);
    }
    if (!threadId) {
      return Promise.reject(new Error("缺少线程 ID"));
    }
    return previewAgentFile(workspaceSlug, threadId, path);
  }, [isWorkspaceScope, threadId, workspaceSlug]);

  const showInFolder = React.useCallback((path: string): Promise<{ ok: true }> => {
    if (isWorkspaceScope) {
      return showWorkspaceFileInFolder(workspaceSlug, path);
    }
    if (!threadId) {
      return Promise.reject(new Error("缺少线程 ID"));
    }
    return showAgentFileInFolder(workspaceSlug, threadId, path);
  }, [isWorkspaceScope, threadId, workspaceSlug]);

  const renamePath = React.useCallback((path: string, newName: string): Promise<{ ok: true; path: string }> => {
    if (isWorkspaceScope) {
      return renameWorkspaceFile(workspaceSlug, path, newName);
    }
    if (!threadId) {
      return Promise.reject(new Error("缺少线程 ID"));
    }
    return renameAgentFile(workspaceSlug, threadId, path, newName);
  }, [isWorkspaceScope, threadId, workspaceSlug]);

  const deletePath = React.useCallback((path: string): Promise<{ ok: true }> => {
    if (isWorkspaceScope) {
      return deleteWorkspaceFile(workspaceSlug, path);
    }
    if (!threadId) {
      return Promise.reject(new Error("缺少线程 ID"));
    }
    return deleteAgentFile(workspaceSlug, threadId, path);
  }, [isWorkspaceScope, threadId, workspaceSlug]);

  const movePath = React.useCallback((path: string, targetDir: string): Promise<{ ok: true; path: string }> => {
    if (isWorkspaceScope) {
      return moveWorkspaceFile(workspaceSlug, path, targetDir);
    }
    if (!threadId) {
      return Promise.reject(new Error("缺少线程 ID"));
    }
    return moveAgentFile(workspaceSlug, threadId, path, targetDir);
  }, [isWorkspaceScope, threadId, workspaceSlug]);

  const loadRoot = React.useCallback(async (): Promise<void> => {
    if (!rootPath || !workspaceSlug || (!isWorkspaceScope && !threadId)) return;
    setLoading(true);
    setError(null);
    try {
      const items = await loadDirectory(rootPath);
      setEntries(items);
    } catch (err) {
      const message = err instanceof Error ? err.message : "加载失败";
      setError(message);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [isWorkspaceScope, loadDirectory, rootPath, threadId, workspaceSlug]);

  React.useEffect(() => {
    void loadRoot();
  }, [filesVersion, loadRoot]);

  const handleSelect = React.useCallback((entry: FileEntry, event: React.MouseEvent) => {
    const isMulti = event.metaKey || event.ctrlKey;
    if (isMulti) {
      setSelectedPaths((prev) => {
        const next = new Set(prev);
        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
        return next;
      });
    } else {
      setSelectedPaths(new Set([entry.path]));
    }
  }, []);

  const handleBackgroundClick = React.useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      setSelectedPaths(new Set());
    }
  }, []);

  const handleShowInFolder = React.useCallback((entry: FileEntry) => {
    void showInFolder(entry.path);
  }, [showInFolder]);

  const handleStartRename = React.useCallback((entry: FileEntry) => {
    setRenamingPath(entry.path);
  }, []);

  const handleCancelRename = React.useCallback(() => {
    setRenamingPath(null);
  }, []);

  const handleRename = React.useCallback(async (filePath: string, newName: string): Promise<string | null> => {
    const parentDir = filePath.replace(/[/\\][^/\\]+$/, "");
    try {
      const siblings = await loadDirectory(parentDir);
      const conflict = siblings.some((item) => item.name === newName && item.path !== filePath);
      if (conflict) return "同名文件已存在";
    } catch {
      // ignore
    }

    try {
      await renamePath(filePath, newName);
      await loadRoot();
      setRenamingPath(null);
      setSelectedPaths(new Set());
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : "重命名失败";
    }
  }, [loadDirectory, loadRoot, renamePath]);

  const handleRequestDelete = React.useCallback((entry: FileEntry) => {
    setDeleteTarget(entry);
    setDeleteCount(selectedCount > 1 ? selectedCount : 1);
  }, [selectedCount]);

  const handleDelete = React.useCallback(async () => {
    if (!deleteTarget) return;
    try {
      if (selectedPaths.size > 1) {
        for (const path of selectedPaths) {
          await deletePath(path);
        }
      } else {
        await deletePath(deleteTarget.path);
      }
      setSelectedPaths(new Set());
      await loadRoot();
    } catch (err) {
      console.error("[FileBrowser] 删除失败:", err);
    }
    setDeleteTarget(null);
  }, [deletePath, deleteTarget, loadRoot, selectedPaths]);

  const handleMove = React.useCallback(async (entry: FileEntry) => {
    setMoving(true);
    try {
      const promptText = isWorkspaceScope
        ? "请输入目标目录（相对工作区共享根目录或绝对路径）"
        : "请输入目标目录（相对会话根目录或绝对路径）";
      const rawTarget = window.prompt(promptText, ".")?.trim();
      if (!rawTarget) return;
      const targetDir = resolveTargetDir(rootPath, rawTarget);
      if (!targetDir) return;

      if (selectedPaths.size > 1) {
        for (const path of selectedPaths) {
          await movePath(path, targetDir);
        }
      } else {
        await movePath(entry.path, targetDir);
      }
      setSelectedPaths(new Set());
      await loadRoot();
    } catch (err) {
      console.error("[FileBrowser] 移动失败:", err);
    } finally {
      setMoving(false);
    }
  }, [isWorkspaceScope, loadRoot, movePath, rootPath, selectedPaths]);

  const breadcrumb = React.useMemo(() => {
    const parts = rootPath.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts.length > 2 ? `.../${parts.slice(-2).join("/")}` : rootPath;
  }, [rootPath]);

  const fileTree = (
    <div className="py-1" onClick={handleBackgroundClick}>
      {error ? <div className="px-3 py-2 text-xs text-destructive">{error}</div> : null}
      {!error && entries.length === 0 && !loading && !hideEmpty ? (
        <div className="px-3 py-4 text-center text-xs text-muted-foreground">目录为空</div>
      ) : null}
      {entries.map((entry) => (
        <FileTreeItem
          key={entry.path}
          entry={entry}
          depth={0}
          selectedPaths={selectedPaths}
          selectedCount={selectedCount}
          renamingPath={renamingPath}
          moving={moving}
          refreshVersion={filesVersion}
          workspaceSlug={workspaceSlug}
          threadId={threadId}
          scope={scope}
          loadDirectory={loadDirectory}
          openPath={openPath}
          previewPath={previewPath}
          onSelect={handleSelect}
          onShowInFolder={handleShowInFolder}
          onStartRename={handleStartRename}
          onCancelRename={handleCancelRename}
          onRename={handleRename}
          onDelete={handleRequestDelete}
          onMove={handleMove}
          onRefresh={loadRoot}
        />
      ))}
    </div>
  );

  return (
    <div className={cn("flex flex-col", !embedded && "h-full")}>
      {!hideToolbar ? (
        <div className="flex items-center gap-1 px-3 pr-10 h-[48px] border-b flex-shrink-0">
          <span className="text-xs text-muted-foreground truncate flex-1" title={rootPath}>
            {breadcrumb}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 flex-shrink-0"
            onClick={() => { void openPath(rootPath); }}
            title="在文件管理器中打开"
          >
            <ExternalLink className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 flex-shrink-0"
            onClick={() => { void loadRoot(); }}
            disabled={loading}
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          </Button>
        </div>
      ) : null}

      {embedded ? fileTree : <ScrollArea className="flex-1">{fileTree}</ScrollArea>}

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteCount > 1 ? (
                <>确定要删除选中的 <strong>{deleteCount}</strong> 个项目吗？</>
              ) : (
                <>
                  确定要删除 <strong>{deleteTarget?.name}</strong> 吗？
                  {deleteTarget?.isDirectory ? "（包含所有子文件）" : ""}
                </>
              )}
              此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => { void handleDelete(); }} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function FileTreeItem({
  entry,
  depth,
  selectedPaths,
  selectedCount,
  renamingPath,
  moving,
  refreshVersion,
  workspaceSlug,
  threadId,
  scope,
  loadDirectory,
  openPath,
  previewPath,
  onSelect,
  onShowInFolder,
  onStartRename,
  onCancelRename,
  onRename,
  onDelete,
  onMove,
  onRefresh
}: {
  entry: FileEntry;
  depth: number;
  selectedPaths: Set<string>;
  selectedCount: number;
  renamingPath: string | null;
  moving: boolean;
  refreshVersion: number;
  workspaceSlug: string;
  threadId?: string;
  scope: "thread" | "workspace";
  loadDirectory: (path: string) => Promise<FileEntry[]>;
  openPath: (path: string) => Promise<{ ok: true }>;
  previewPath: (path: string) => Promise<{ ok: true }>;
  onSelect: (entry: FileEntry, event: React.MouseEvent) => void;
  onShowInFolder: (entry: FileEntry) => void;
  onStartRename: (entry: FileEntry) => void;
  onCancelRename: () => void;
  onRename: (filePath: string, newName: string) => Promise<string | null>;
  onDelete: (entry: FileEntry) => void;
  onMove: (entry: FileEntry) => void;
  onRefresh: () => Promise<void>;
}): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false);
  const [children, setChildren] = React.useState<FileEntry[]>([]);
  const [childrenLoaded, setChildrenLoaded] = React.useState(false);
  const [editName, setEditName] = React.useState("");
  const [renameError, setRenameError] = React.useState<string | null>(null);
  const renameInputRef = React.useRef<HTMLInputElement>(null);
  const justStartedEditing = React.useRef(false);

  const isSelected = selectedPaths.has(entry.path);
  const isRenaming = renamingPath === entry.path;

  React.useEffect(() => {
    if (expanded && childrenLoaded && entry.isDirectory) {
      void loadDirectory(entry.path)
        .then((items) => setChildren(items))
        .catch((err) => console.error("[FileTreeItem] 刷新子目录失败:", err));
    }
  }, [childrenLoaded, entry.isDirectory, entry.path, expanded, loadDirectory, refreshVersion]);

  React.useEffect(() => {
    if (isRenaming) {
      setEditName(entry.name);
      setRenameError(null);
      justStartedEditing.current = true;
      const timer = setTimeout(() => {
        justStartedEditing.current = false;
        const input = renameInputRef.current;
        if (!input) return;
        input.focus();
        const lastDotIndex = entry.name.lastIndexOf(".");
        if (lastDotIndex > 0 && !entry.isDirectory) {
          input.setSelectionRange(0, lastDotIndex);
        } else {
          input.select();
        }
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [entry.isDirectory, entry.name, isRenaming]);

  const toggleDir = async (): Promise<void> => {
    if (!entry.isDirectory) return;
    if (!expanded && !childrenLoaded) {
      try {
        const items = await loadDirectory(entry.path);
        setChildren(items);
        setChildrenLoaded(true);
      } catch (err) {
        console.error("[FileTreeItem] 加载子目录失败:", err);
      }
    }
    setExpanded((prev) => !prev);
  };

  const handleClick = (e: React.MouseEvent): void => {
    e.stopPropagation();
    onSelect(entry, e);
    if (entry.isDirectory && !e.metaKey && !e.ctrlKey) {
      void toggleDir();
    }
  };

  const handleDoubleClick = (): void => {
    if (!entry.isDirectory) {
      void previewPath(entry.path);
    }
  };

  const handleRefreshAfterDelete = async (): Promise<void> => {
    if (childrenLoaded) {
      try {
        const items = await loadDirectory(entry.path);
        setChildren(items);
      } catch {
        await onRefresh();
      }
    }
  };

  const saveRename = async (): Promise<void> => {
    if (justStartedEditing.current) return;
    const trimmed = editName.trim();
    if (!trimmed || trimmed === entry.name) {
      onCancelRename();
      return;
    }
    const error = await onRename(entry.path, trimmed);
    if (error) {
      setRenameError(error);
    }
  };

  const paddingLeft = 8 + depth * 16;
  const showMenu = isSelected && selectedCount > 0 && !isRenaming;
  void workspaceSlug;
  void threadId;
  void scope;

  return (
    <>
      <div
        className={cn(
          "flex items-center gap-1 py-1 pr-2 text-sm cursor-pointer group mx-2 rounded-lg",
          isSelected ? "bg-accent" : "hover:bg-accent/50"
        )}
        style={{ paddingLeft }}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
      >
        {entry.isDirectory ? (
          <ChevronRight className={cn("size-3.5 text-muted-foreground flex-shrink-0 transition-transform duration-150", expanded && "rotate-90")} />
        ) : (
          <span className="w-3.5 flex-shrink-0" />
        )}
        <FileTypeIcon name={entry.name} isDirectory={entry.isDirectory} isOpen={expanded} />
        {isRenaming ? (
          <div className="flex-1 min-w-0">
            <input
              ref={renameInputRef}
              value={editName}
              onChange={(e) => { setEditName(e.target.value); setRenameError(null); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void saveRename();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onCancelRename();
                }
              }}
              onBlur={() => { void saveRename(); }}
              onClick={(e) => e.stopPropagation()}
              className={cn("w-full bg-transparent text-xs border-b outline-none py-0.5", renameError ? "border-destructive" : "border-primary/50")}
              maxLength={255}
            />
            {renameError ? <div className="text-[10px] text-destructive mt-0.5">{renameError}</div> : null}
          </div>
        ) : (
          <span className="truncate text-xs flex-1">{entry.name}</span>
        )}
        <div className={cn("flex-shrink-0", !showMenu && "invisible")} onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="h-6 w-6 rounded flex items-center justify-center hover:bg-accent/70">
                <MoreHorizontal className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            {showMenu ? (
              <DropdownMenuContent align="start" className="w-40 z-[9999] min-w-0 p-0.5">
                {selectedCount === 1 ? (
                  <DropdownMenuItem className="text-xs py-1 [&>svg]:size-3.5" onSelect={() => onShowInFolder(entry)}>
                    <FolderSearch />
                    在文件夹中显示
                  </DropdownMenuItem>
                ) : null}
                {selectedCount === 1 && !entry.isDirectory ? (
                  <DropdownMenuItem className="text-xs py-1 [&>svg]:size-3.5" onSelect={() => { void openPath(entry.path); }}>
                    <Eye />
                    打开
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem className="text-xs py-1 [&>svg]:size-3.5" disabled={moving} onSelect={() => { void onMove(entry); }}>
                  <ArrowRightLeft />
                  {selectedCount > 1 ? `移动选中 (${selectedCount})` : "移动到..."}
                </DropdownMenuItem>
                {selectedCount === 1 ? (
                  <DropdownMenuItem className="text-xs py-1 [&>svg]:size-3.5" onSelect={() => onStartRename(entry)}>
                    <Pencil />
                    重命名
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator className="my-0.5" />
                <DropdownMenuItem className="text-xs py-1 [&>svg]:size-3.5 text-destructive" onSelect={() => onDelete(entry)}>
                  <Trash2 />
                  {selectedCount > 1 ? `删除选中 (${selectedCount})` : "删除"}
                </DropdownMenuItem>
              </DropdownMenuContent>
            ) : null}
          </DropdownMenu>
        </div>
      </div>
      {expanded && children.length === 0 && childrenLoaded ? (
        <div className="text-[11px] text-muted-foreground/50 py-1" style={{ paddingLeft: paddingLeft + 24 }}>
          空文件夹
        </div>
      ) : null}
      {expanded ? children.map((child) => (
        <FileTreeItem
          key={child.path}
          entry={child}
          depth={depth + 1}
          selectedPaths={selectedPaths}
          selectedCount={selectedCount}
          renamingPath={renamingPath}
          moving={moving}
          refreshVersion={refreshVersion}
          workspaceSlug={workspaceSlug}
          threadId={threadId}
          scope={scope}
          loadDirectory={loadDirectory}
          openPath={openPath}
          previewPath={previewPath}
          onSelect={onSelect}
          onShowInFolder={onShowInFolder}
          onStartRename={onStartRename}
          onCancelRename={onCancelRename}
          onRename={onRename}
          onDelete={onDelete}
          onMove={onMove}
          onRefresh={handleRefreshAfterDelete}
        />
      )) : null}
    </>
  );
}

function resolveTargetDir(rootPath: string, rawInput: string): string | null {
  const input = rawInput.trim();
  if (!input) return null;
  const isAbsolute = /^([a-zA-Z]:[\\/]|\/)/.test(input);
  if (isAbsolute) return input;
  const separator = rootPath.includes("\\") ? "\\" : "/";
  let rel = input;
  while (rel.startsWith("/") || rel.startsWith("\\")) rel = rel.slice(1);
  if (!rel || rel === "." || rel === "./" || rel === ".\\") return rootPath;
  return `${rootPath.replace(/[\\/]+$/, "")}${separator}${rel.replace(/[\\/]+/g, separator)}`;
}
