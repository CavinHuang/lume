"use client";

import * as React from "react";
import type { FileEntry } from "@lume/shared";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  FolderSearch,
  RefreshCw,
  Trash2,
  X
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
  deleteAgentFile,
  listAgentDirectory,
  openAgentFile,
  showAgentFileInFolder
} from "@/lib/desktop-api";
import { cn } from "@/lib/utils";

interface ContextMenuState {
  x: number;
  y: number;
  entry: FileEntry;
}

type FileBrowserProps = {
  workspaceSlug: string;
  sessionId: string;
  rootPath: string;
  onClose?: () => void;
};

export function FileBrowser({
  workspaceSlug,
  sessionId,
  rootPath,
  onClose
}: FileBrowserProps): React.ReactElement {
  const [entries, setEntries] = React.useState<FileEntry[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<FileEntry | null>(null);
  const [contextMenu, setContextMenu] = React.useState<ContextMenuState | null>(null);

  const loadRoot = React.useCallback(async (): Promise<void> => {
    if (!rootPath || !workspaceSlug || !sessionId) return;
    setLoading(true);
    setError(null);
    try {
      const items = await listAgentDirectory(workspaceSlug, sessionId, rootPath);
      setEntries(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [rootPath, workspaceSlug, sessionId]);

  React.useEffect(() => {
    void loadRoot();
  }, [loadRoot]);

  React.useEffect(() => {
    if (!contextMenu) return;

    const close = (): void => setContextMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("scroll", close, true);

    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [contextMenu]);

  const handleContextMenu = React.useCallback((event: React.MouseEvent, entry: FileEntry): void => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, entry });
  }, []);

  const handleMenuOpen = (): void => {
    if (!contextMenu) return;
    void openAgentFile(workspaceSlug, sessionId, contextMenu.entry.path);
    setContextMenu(null);
  };

  const handleMenuShowInFolder = (): void => {
    if (!contextMenu) return;
    void showAgentFileInFolder(workspaceSlug, sessionId, contextMenu.entry.path);
    setContextMenu(null);
  };

  const handleMenuDelete = (): void => {
    if (!contextMenu) return;
    setDeleteTarget(contextMenu.entry);
    setContextMenu(null);
  };

  const handleDelete = async (): Promise<void> => {
    if (!deleteTarget) return;
    try {
      await deleteAgentFile(workspaceSlug, sessionId, deleteTarget.path);
      await loadRoot();
    } catch (err) {
      console.error("[FileBrowser] delete failed", err);
    }
    setDeleteTarget(null);
  };

  const breadcrumb = React.useMemo(() => {
    const normalized = rootPath.replace(/\\/g, "/");
    const parts = normalized.split("/").filter(Boolean);
    return parts.length > 2 ? `.../${parts.slice(-2).join("/")}` : normalized;
  }, [rootPath]);

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-[48px] flex-shrink-0 items-center gap-1 border-b px-3">
        <span className="flex-1 truncate text-xs text-muted-foreground" title={rootPath}>
          {breadcrumb}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 flex-shrink-0"
          onClick={() => {
            void openAgentFile(workspaceSlug, sessionId, rootPath);
          }}
          title="打开目录"
        >
          <FolderOpen className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 flex-shrink-0"
          onClick={() => {
            void loadRoot();
          }}
          disabled={loading}
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        </Button>
        {onClose ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 flex-shrink-0"
            onClick={onClose}
          >
            <X className="size-3.5" />
          </Button>
        ) : null}
      </div>

      <ScrollArea className="flex-1">
        <div className="py-1">
          {error ? <div className="px-3 py-2 text-xs text-destructive">{error}</div> : null}
          {!error && entries.length === 0 && !loading ? (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">目录为空</div>
          ) : null}
          {entries.map((entry) => (
            <FileTreeItem
              key={entry.path}
              entry={entry}
              depth={0}
              workspaceSlug={workspaceSlug}
              sessionId={sessionId}
              onContextMenu={handleContextMenu}
              onRefresh={loadRoot}
            />
          ))}
        </div>
      </ScrollArea>

      {contextMenu ? (
        <div
          className="fixed z-50 min-w-[12rem] animate-in fade-in-0 zoom-in-95 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {contextMenu.entry.isDirectory ? (
            <button
              type="button"
              className="relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground"
              onClick={handleMenuOpen}
            >
              <FolderOpen className="mr-2 size-3.5" />
              打开目录
            </button>
          ) : (
            <button
              type="button"
              className="relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground"
              onClick={handleMenuOpen}
            >
              <ExternalLink className="mr-2 size-3.5" />
              打开
            </button>
          )}
          <button
            type="button"
            className="relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground"
            onClick={handleMenuShowInFolder}
          >
            <FolderSearch className="mr-2 size-3.5" />
            在文件夹中显示
          </button>
          <div className="-mx-1 my-1 h-px bg-border" />
          <button
            type="button"
            className="relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm text-destructive outline-none hover:bg-destructive/10 hover:text-destructive"
            onClick={handleMenuDelete}
          >
            <Trash2 className="mr-2 size-3.5" />
            删除
          </button>
        </div>
      ) : null}

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除 <strong>{deleteTarget?.name}</strong> 吗？
              {deleteTarget?.isDirectory ? "（包含所有子文件）" : ""}
              此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { void handleDelete(); }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface FileTreeItemProps {
  entry: FileEntry;
  depth: number;
  workspaceSlug: string;
  sessionId: string;
  onContextMenu: (event: React.MouseEvent, entry: FileEntry) => void;
  onRefresh: () => Promise<void>;
}

function FileTreeItem({
  entry,
  depth,
  workspaceSlug,
  sessionId,
  onContextMenu,
  onRefresh
}: FileTreeItemProps): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false);
  const [children, setChildren] = React.useState<FileEntry[]>([]);
  const [childrenLoaded, setChildrenLoaded] = React.useState(false);

  const toggleDir = async (): Promise<void> => {
    if (!entry.isDirectory) return;
    if (!expanded && !childrenLoaded) {
      try {
        const items = await listAgentDirectory(workspaceSlug, sessionId, entry.path);
        setChildren(items);
        setChildrenLoaded(true);
      } catch (err) {
        console.error("[FileTreeItem] load children failed", err);
      }
    }
    setExpanded((prev) => !prev);
  };

  const handleClick = (): void => {
    if (entry.isDirectory) {
      void toggleDir();
    } else {
      void openAgentFile(workspaceSlug, sessionId, entry.path);
    }
  };

  const handleRefreshAfterDelete = async (): Promise<void> => {
    if (childrenLoaded) {
      try {
        const items = await listAgentDirectory(workspaceSlug, sessionId, entry.path);
        setChildren(items);
        return;
      } catch {
        await onRefresh();
      }
    }
  };

  const paddingLeft = 8 + depth * 16;

  return (
    <>
      <div
        className="group flex cursor-pointer items-center gap-1 py-1 pr-2 text-sm hover:bg-accent/50"
        style={{ paddingLeft }}
        onClick={handleClick}
        onContextMenu={(event) => onContextMenu(event, entry)}
      >
        {entry.isDirectory ? (
          expanded ? (
            <ChevronDown className="size-3.5 flex-shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 flex-shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="w-3.5 flex-shrink-0" />
        )}

        {entry.isDirectory ? (
          expanded ? (
            <FolderOpen className="size-4 flex-shrink-0 text-amber-500" />
          ) : (
            <Folder className="size-4 flex-shrink-0 text-amber-500" />
          )
        ) : (
          <FileText className="size-4 flex-shrink-0 text-muted-foreground" />
        )}

        <span className="flex-1 truncate text-xs">{entry.name}</span>
      </div>

      {expanded
        ? children.map((child) => (
            <FileTreeItem
              key={child.path}
              entry={child}
              depth={depth + 1}
              workspaceSlug={workspaceSlug}
              sessionId={sessionId}
              onContextMenu={onContextMenu}
              onRefresh={handleRefreshAfterDelete}
            />
          ))
        : null}
    </>
  );
}
