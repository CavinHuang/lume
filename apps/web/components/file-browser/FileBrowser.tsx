import * as React from "react";
import type { FileEntry } from "@lume/shared";
import { useAtomValue } from "jotai";
import {
  ArrowRightLeft,
  ChevronRight,
  Edit3,
  Eye,
  ExternalLink,
  FolderOpen,
  FolderSearch,
  RefreshCw,
  Search,
  Trash2,
  X
} from "lucide-react";
import { FileTypeIcon } from "./FileTypeIcon";
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
  moveAgentFile,
  openAgentFile,
  previewAgentFile,
  renameAgentFile,
  searchAgentWorkspaceFiles,
  showAgentFileInFolder
} from "@/lib/desktop-api/agent";
import { cn } from "@/lib/utils";
import { workspaceFilesVersionAtom } from "@/atoms";

interface ContextMenuState {
  x: number;
  y: number;
  entry: FileEntry;
}

type FileBrowserProps = {
  workspaceSlug: string;
  threadId: string;
  rootPath: string;
  onClose?: () => void;
  /** 隐藏顶部路径栏和搜索栏 */
  hideToolbar?: boolean;
  /** 嵌入模式：去除背景色，更紧凑 */
  embedded?: boolean;
};

function trimTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

function joinPathFromRoot(rootPath: string, relativePath: string): string {
  const separator = rootPath.includes("\\") ? "\\" : "/";
  let rel = relativePath.trim();
  while (rel.startsWith("/") || rel.startsWith("\\")) {
    rel = rel.slice(1);
  }
  rel = rel.replace(/[\\/]+/g, separator);
  if (!rel) return rootPath;
  return `${trimTrailingSeparators(rootPath)}${separator}${rel}`;
}

function resolveTargetDir(rootPath: string, rawInput: string): string | null {
  const input = rawInput.trim();
  if (!input) return null;
  const isAbsolute = /^([a-zA-Z]:[\\/]|\/)/.test(input);
  if (isAbsolute) return input;
  if (input === "." || input === "./" || input === ".\\") return rootPath;
  return joinPathFromRoot(rootPath, input);
}

export function FileBrowser({
  workspaceSlug,
  threadId,
  rootPath,
  onClose,
  hideToolbar = false,
  embedded = false
}: FileBrowserProps): React.ReactElement {
  const filesVersion = useAtomValue(workspaceFilesVersionAtom);
  const [entries, setEntries] = React.useState<FileEntry[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<FileEntry | null>(null);
  const [contextMenu, setContextMenu] = React.useState<ContextMenuState | null>(null);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [searching, setSearching] = React.useState(false);
  const [searchTotal, setSearchTotal] = React.useState(0);
  const [searchEntries, setSearchEntries] = React.useState<FileEntry[]>([]);

  const loadRoot = React.useCallback(async (): Promise<void> => {
    if (!rootPath || !workspaceSlug || !threadId) return;
    setLoading(true);
    setError(null);
    try {
      const items = await listAgentDirectory(workspaceSlug, threadId, rootPath);
      setEntries(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [rootPath, workspaceSlug, threadId]);

  React.useEffect(() => {
    void loadRoot();
  }, [loadRoot, filesVersion]);

  React.useEffect(() => {
    const trimmed = searchQuery.trim();
    if (!trimmed) {
      setSearchEntries([]);
      setSearchTotal(0);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSearching(true);
      void searchAgentWorkspaceFiles(workspaceSlug, threadId, trimmed, 100, rootPath)
        .then((result) => {
          if (cancelled) return;
          setSearchTotal(result.total);
          setSearchEntries(
            result.entries.map((entry) => ({
              name: entry.name,
              path: joinPathFromRoot(rootPath, entry.path),
              isDirectory: entry.type === "dir"
            }))
          );
        })
        .catch((err) => {
          if (cancelled) return;
          console.error("[FileBrowser] search failed", err);
          setSearchEntries([]);
          setSearchTotal(0);
        })
        .finally(() => {
          if (!cancelled) {
            setSearching(false);
          }
        });
    }, 240);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [rootPath, searchQuery, threadId, workspaceSlug]);

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
    void openAgentFile(workspaceSlug, threadId, contextMenu.entry.path);
    setContextMenu(null);
  };

  const handleMenuPreview = (): void => {
    if (!contextMenu) return;
    if (contextMenu.entry.isDirectory) return;
    void previewAgentFile(workspaceSlug, threadId, contextMenu.entry.path);
    setContextMenu(null);
  };

  const handleMenuShowInFolder = (): void => {
    if (!contextMenu) return;
    void showAgentFileInFolder(workspaceSlug, threadId, contextMenu.entry.path);
    setContextMenu(null);
  };

  const handleMenuDelete = (): void => {
    if (!contextMenu) return;
    setDeleteTarget(contextMenu.entry);
    setContextMenu(null);
  };

  const handleMenuRename = async (): Promise<void> => {
    if (!contextMenu) return;
    const target = contextMenu.entry;
    const defaultName = target.name;
    const nextName = window.prompt("请输入新名称", defaultName)?.trim();
    setContextMenu(null);
    if (!nextName || nextName === defaultName) return;
    try {
      await renameAgentFile(workspaceSlug, threadId, target.path, nextName);
      await loadRoot();
    } catch (err) {
      console.error("[FileBrowser] rename failed", err);
      setError(err instanceof Error ? err.message : "重命名失败");
    }
  };

  const handleMenuMove = async (): Promise<void> => {
    if (!contextMenu) return;
    const target = contextMenu.entry;
    const rawTarget = window.prompt("请输入目标目录（相对会话根目录或绝对路径）", ".")?.trim();
    setContextMenu(null);
    if (!rawTarget) return;
    const targetDir = resolveTargetDir(rootPath, rawTarget);
    if (!targetDir) return;
    try {
      await moveAgentFile(workspaceSlug, threadId, target.path, targetDir);
      await loadRoot();
    } catch (err) {
      console.error("[FileBrowser] move failed", err);
      setError(err instanceof Error ? err.message : "移动失败");
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!deleteTarget) return;
    try {
      await deleteAgentFile(workspaceSlug, threadId, deleteTarget.path);
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
    <div className={cn("flex h-full flex-col", embedded ? "" : "bg-background")}>
      {!hideToolbar ? (
        <>
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
                void openAgentFile(workspaceSlug, threadId, rootPath);
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

          <div className="flex items-center gap-2 border-b px-3 py-2">
            <Search className={cn("size-3.5 text-muted-foreground", searching && "animate-pulse")} />
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="搜索文件（名称/路径）"
              className="h-7 w-full rounded-md border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
            />
            {searchQuery.trim() ? (
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {searching ? "搜索中..." : `${searchEntries.length}/${searchTotal}`}
              </span>
            ) : null}
          </div>
        </>
      ) : null}

      <ScrollArea className="flex-1">
        <div className="py-1">
          {error ? <div className="px-3 py-2 text-xs text-destructive">{error}</div> : null}
          {!error && searchQuery.trim() && !searching && searchEntries.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">未找到匹配文件</div>
          ) : null}
          {!error && !searchQuery.trim() && entries.length === 0 && !loading ? (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">目录为空</div>
          ) : null}
          {(searchQuery.trim() ? searchEntries : entries).map((entry) => (
            <FileTreeItem
              key={entry.path}
              entry={entry}
              depth={searchQuery.trim() ? -1 : 0}
              workspaceSlug={workspaceSlug}
              threadId={threadId}
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
            <>
              <button
                type="button"
                className="relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground"
                onClick={handleMenuOpen}
              >
                <ExternalLink className="mr-2 size-3.5" />
                打开
              </button>
              <button
                type="button"
                className="relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground"
                onClick={handleMenuPreview}
              >
                <Eye className="mr-2 size-3.5" />
                预览
              </button>
            </>
          )}
          <button
            type="button"
            className="relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground"
            onClick={() => { void handleMenuRename(); }}
          >
            <Edit3 className="mr-2 size-3.5" />
            重命名
          </button>
          <button
            type="button"
            className="relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground"
            onClick={() => { void handleMenuMove(); }}
          >
            <ArrowRightLeft className="mr-2 size-3.5" />
            移动到...
          </button>
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
  threadId: string;
  onContextMenu: (event: React.MouseEvent, entry: FileEntry) => void;
  onRefresh: () => Promise<void>;
}

function FileTreeItem({
  entry,
  depth,
  workspaceSlug,
  threadId,
  onContextMenu,
  onRefresh
}: FileTreeItemProps): React.ReactElement {
  const isSearchResult = depth < 0;
  const [expanded, setExpanded] = React.useState(false);
  const [children, setChildren] = React.useState<FileEntry[]>([]);
  const [childrenLoaded, setChildrenLoaded] = React.useState(false);

  const toggleDir = async (): Promise<void> => {
    if (!entry.isDirectory) return;
    if (!expanded && !childrenLoaded) {
      try {
        const items = await listAgentDirectory(workspaceSlug, threadId, entry.path);
        setChildren(items);
        setChildrenLoaded(true);
      } catch (err) {
        console.error("[FileTreeItem] load children failed", err);
      }
    }
    setExpanded((prev) => !prev);
  };

  const handleClick = (): void => {
    if (isSearchResult) {
      void openAgentFile(workspaceSlug, threadId, entry.path);
      return;
    }
    if (entry.isDirectory) {
      void toggleDir();
    } else {
      void openAgentFile(workspaceSlug, threadId, entry.path);
    }
  };

  const handleRefreshAfterDelete = async (): Promise<void> => {
    if (childrenLoaded) {
      try {
        const items = await listAgentDirectory(workspaceSlug, threadId, entry.path);
        setChildren(items);
        return;
      } catch {
        await onRefresh();
      }
    }
  };

  const paddingLeft = isSearchResult ? 8 : 8 + depth * 16;

  return (
    <>
      <div
        className="group flex cursor-pointer items-center gap-1 py-1 pr-2 text-sm hover:bg-accent/50"
        style={{ paddingLeft }}
        onClick={handleClick}
        onContextMenu={(event) => onContextMenu(event, entry)}
      >
        {!isSearchResult && entry.isDirectory ? (
          <ChevronRight
            className={cn(
              "size-3.5 flex-shrink-0 text-muted-foreground transition-transform duration-150",
              expanded && "rotate-90"
            )}
          />
        ) : (
          <span className="w-3.5 flex-shrink-0" />
        )}

        <FileTypeIcon
          name={entry.name}
          isDirectory={entry.isDirectory}
          isOpen={expanded}
          size={14}
          className={cn(
            "flex-shrink-0",
            entry.isDirectory ? "text-amber-500" : "text-muted-foreground"
          )}
        />

        <span className="flex-1 truncate text-xs">{entry.name}</span>
      </div>

      {!isSearchResult && expanded
        ? children.map((child) => (
            <FileTreeItem
              key={child.path}
              entry={child}
              depth={depth + 1}
              workspaceSlug={workspaceSlug}
              threadId={threadId}
              onContextMenu={onContextMenu}
              onRefresh={handleRefreshAfterDelete}
            />
          ))
        : null}
    </>
  );
}

