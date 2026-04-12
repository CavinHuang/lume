import * as React from "react";
import { useAtom, useAtomValue } from "jotai";
import {
  ChevronRight,
  ExternalLink,
  FolderHeart,
  FolderInput,
  FolderOpen,
  FolderSearch,
  Info,
  MoreHorizontal,
  PanelRight,
  Pencil,
  RefreshCw,
  Trash2,
  X
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { FileBrowser, FileDropZone, FileTypeIcon } from "@/components/file-browser";
import {
  agentAttachedDirectoriesMapAtom,
  workspaceAttachedDirectoriesMapAtom,
  workspaceFilesVersionAtom
} from "@/atoms";
import {
  getAgentWorkspaceResourcesPath,
  listAttachedDirectory,
  moveAttachedFile,
  openAgentFile,
  openAttachedFile,
  openWorkspaceFile,
  renameAttachedFile,
  showAttachedFileInFolder
} from "@/lib/desktop-api/agent";
import { openFolderDialog } from "@/lib/desktop-api/system";
import type { FileEntry } from "@lume/shared";

interface AgentSidePanelProps {
  sessionId: string;
  sessionPath: string | null;
  workspaceSlug: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AgentSidePanel({
  sessionId,
  sessionPath,
  workspaceSlug,
  open,
  onOpenChange
}: AgentSidePanelProps): React.ReactElement | null {
  const hasFiles = !!sessionPath && !!workspaceSlug;
  const [workspaceResourcesPath, setWorkspaceResourcesPath] = React.useState<string | null>(null);
  const [sessionAttachedDirs, setSessionAttachedDirs] = useAtom(agentAttachedDirectoriesMapAtom);
  const [workspaceAttachedDirs, setWorkspaceAttachedDirs] = useAtom(workspaceAttachedDirectoriesMapAtom);
  const filesVersion = useAtomValue(workspaceFilesVersionAtom);
  const [, setFilesVersion] = useAtom(workspaceFilesVersionAtom);

  const hasFileChanges = filesVersion > 0;
  const currentSessionDirs = sessionId ? sessionAttachedDirs.get(sessionId) ?? [] : [];
  const currentWorkspaceDirs = workspaceSlug ? workspaceAttachedDirs.get(workspaceSlug) ?? [] : [];
  const hasContent = sessionPath || currentSessionDirs.length > 0;

  const animateRef = React.useRef(false);
  React.useEffect(() => {
    animateRef.current = false;
  }, [sessionId]);

  const handleToggle = React.useCallback(() => {
    animateRef.current = true;
    onOpenChange(!open);
  }, [open, onOpenChange]);

  React.useEffect(() => {
    if (!workspaceSlug) {
      setWorkspaceResourcesPath(null);
      return;
    }
    void getAgentWorkspaceResourcesPath(workspaceSlug)
      .then(setWorkspaceResourcesPath)
      .catch(() => setWorkspaceResourcesPath(null));
  }, [workspaceSlug]);

  const prevFilesVersionRef = React.useRef(filesVersion);
  React.useEffect(() => {
    if (filesVersion > prevFilesVersionRef.current && sessionPath) {
      onOpenChange(true);
    }
    prevFilesVersionRef.current = filesVersion;
  }, [filesVersion, sessionPath, onOpenChange]);

  const handleFilesUploaded = React.useCallback((): void => {
    setFilesVersion((v) => v + 1);
  }, [setFilesVersion]);

  const handleRefresh = React.useCallback((): void => {
    setFilesVersion((v) => v + 1);
  }, [setFilesVersion]);

  const handleAttachSessionFolder = React.useCallback(async (): Promise<void> => {
    if (!sessionId) return;
    try {
      const result = await openFolderDialog();
      if (!result.path) return;
      const path = result.path;
      setSessionAttachedDirs((prev) => {
        const map = new Map(prev);
        const current = map.get(sessionId) ?? [];
        if (current.includes(path)) return prev;
        map.set(sessionId, [...current, path]);
        return map;
      });
    } catch (error) {
      console.error("[AgentSidePanel] 附加线程文件夹失败:", error);
    }
  }, [sessionId, setSessionAttachedDirs]);

  const handleDetachSessionFolder = React.useCallback((path: string): void => {
    if (!sessionId) return;
    setSessionAttachedDirs((prev) => {
      const map = new Map(prev);
      const current = map.get(sessionId) ?? [];
      map.set(sessionId, current.filter((d) => d !== path));
      return map;
    });
  }, [sessionId, setSessionAttachedDirs]);

  const handleAttachWorkspaceFolder = React.useCallback(async (): Promise<void> => {
    if (!workspaceSlug) return;
    try {
      const result = await openFolderDialog();
      if (!result.path) return;
      const path = result.path;
      setWorkspaceAttachedDirs((prev) => {
        const map = new Map(prev);
        const current = map.get(workspaceSlug) ?? [];
        if (current.includes(path)) return prev;
        map.set(workspaceSlug, [...current, path]);
        return map;
      });
    } catch (error) {
      console.error("[AgentSidePanel] 附加工作区文件夹失败:", error);
    }
  }, [workspaceSlug, setWorkspaceAttachedDirs]);

  const handleDetachWorkspaceFolder = React.useCallback((path: string): void => {
    if (!workspaceSlug) return;
    setWorkspaceAttachedDirs((prev) => {
      const map = new Map(prev);
      const current = map.get(workspaceSlug) ?? [];
      map.set(workspaceSlug, current.filter((d) => d !== path));
      return map;
    });
  }, [workspaceSlug, setWorkspaceAttachedDirs]);

  const sessionBreadcrumb = React.useMemo(() => {
    if (!sessionPath) return "";
    const normalized = sessionPath.replace(/\\/g, "/");
    const parts = normalized.split("/").filter(Boolean);
    return parts.length > 2 ? `.../${parts.slice(-2).join("/")}` : normalized;
  }, [sessionPath]);

  return (
    <div
      className={cn(
        "relative flex-shrink-0 overflow-hidden bg-content-area/95 backdrop-blur-xl rounded-2xl shadow-xl",
        animateRef.current && "transition-[width] duration-300 ease-in-out",
        open ? "w-[296px]" : "w-0"
      )}
    >
      {hasContent && (
        <div
          className={cn(
            "w-[296px] h-full flex flex-col titlebar-no-drag pt-0.5",
            animateRef.current && "transition-opacity duration-300",
            open ? "opacity-100" : "opacity-0 pointer-events-none"
          )}
        >
          {hasFiles && workspaceSlug && sessionPath ? (
            <div className="flex-1 min-h-0 flex flex-col">
              <div className="flex items-center gap-1 pl-3 pr-2 h-[32px] flex-shrink-0">
                <FolderOpen className="size-3 text-muted-foreground" />
                <span className="text-[11px] font-medium text-muted-foreground">线程文件</span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="size-3 text-muted-foreground/50 cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-[200px]">
                    <p>当前线程的专属文件，仅本次对话的 Agent 可以访问</p>
                  </TooltipContent>
                </Tooltip>
                <span className="text-[10px] text-muted-foreground/75 truncate flex-1" title={sessionPath}>
                  {sessionBreadcrumb}
                </span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 flex-shrink-0"
                      onClick={() => { void openAgentFile(workspaceSlug, sessionId, sessionPath); }}
                    >
                      <ExternalLink className="size-2.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom"><p>在文件管理器中打开</p></TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 flex-shrink-0"
                      onClick={handleRefresh}
                    >
                      <RefreshCw className="size-2.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom"><p>刷新文件列表</p></TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 flex-shrink-0"
                      onClick={handleToggle}
                    >
                      {open ? <X className="size-2.5" /> : <PanelRight className="size-2.5" />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom"><p>{open ? "关闭侧面板" : "打开侧面板"}</p></TooltipContent>
                </Tooltip>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto">
                {currentSessionDirs.length > 0 ? (
                  <AttachedDirsSection dirs={currentSessionDirs} onDetach={handleDetachSessionFolder} refreshVersion={filesVersion} />
                ) : null}
                <FileBrowser
                  workspaceSlug={workspaceSlug}
                  threadId={sessionId}
                  rootPath={sessionPath}
                  hideToolbar
                  embedded
                />
              </div>
              <FileDropZone
                workspaceSlug={workspaceSlug}
                threadId={sessionId}
                target="session"
                onFilesUploaded={handleFilesUploaded}
                onAttachFolder={handleAttachSessionFolder}
              />

              <div className="mx-3 my-3 border-t border-muted-foreground/20" />

              <div className="flex-1 min-h-0 flex flex-col mx-2 mb-2">
                <div className="flex items-center gap-1 px-2 h-[32px] flex-shrink-0">
                  <FolderHeart className="size-3 text-muted-foreground" />
                  <span className="text-[11px] font-medium text-muted-foreground">工作区文件</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="size-3 text-muted-foreground/50 cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-[220px]">
                      <p>工作区内所有线程可访问的文件和文件夹，每个新对话都可以自动读取</p>
                    </TooltipContent>
                  </Tooltip>
                  <div className="flex-1" />
                  {workspaceResourcesPath ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5 flex-shrink-0"
                          onClick={() => { void openWorkspaceFile(workspaceSlug, workspaceResourcesPath); }}
                        >
                          <ExternalLink className="size-2.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom"><p>在文件管理器中打开工作区共享目录</p></TooltipContent>
                    </Tooltip>
                  ) : null}
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto pb-1">
                  {currentWorkspaceDirs.length > 0 ? (
                    <AttachedDirsSection dirs={currentWorkspaceDirs} onDetach={handleDetachWorkspaceFolder} refreshVersion={filesVersion} />
                  ) : null}
                  {workspaceResourcesPath ? (
                    <FileBrowser
                      workspaceSlug={workspaceSlug}
                      rootPath={workspaceResourcesPath}
                      scope="workspace"
                      hideToolbar
                      embedded
                    />
                  ) : null}
                </div>
                <FileDropZone
                  workspaceSlug={workspaceSlug}
                  threadId={sessionId}
                  target="workspace"
                  onFilesUploaded={handleFilesUploaded}
                  onAttachFolder={handleAttachWorkspaceFolder}
                />
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              请选择工作区
            </div>
          )}
        </div>
      )}
      {!open && hasContent ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-2 top-2 h-7 w-7"
              onClick={handleToggle}
            >
              <PanelRight className="size-3.5" />
              {hasFileChanges ? (
                <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-primary animate-pulse" />
              ) : null}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left"><p>打开侧面板</p></TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}

function AttachedDirsSection({
  dirs,
  onDetach,
  refreshVersion
}: {
  dirs: string[];
  onDetach: (path: string) => void;
  refreshVersion: number;
}): React.ReactElement {
  const [selectedPaths, setSelectedPaths] = React.useState<Set<string>>(new Set());

  const handleSelect = React.useCallback((path: string, ctrlKey: boolean) => {
    setSelectedPaths((prev) => {
      if (ctrlKey) {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      }
      return new Set([path]);
    });
  }, []);

  return (
    <div className="pt-2.5 pb-1 flex-shrink-0">
      <div className="text-[11px] font-medium text-muted-foreground mb-1 px-3">
        附加目录（Agent 可以读取并操作此外部文件夹）
      </div>
      {dirs.map((dir) => (
        <AttachedDirTree
          key={dir}
          dirPath={dir}
          onDetach={() => onDetach(dir)}
          selectedPaths={selectedPaths}
          onSelect={handleSelect}
          refreshVersion={refreshVersion}
        />
      ))}
    </div>
  );
}

function AttachedDirTree({
  dirPath,
  onDetach,
  selectedPaths,
  onSelect,
  refreshVersion
}: {
  dirPath: string;
  onDetach: () => void;
  selectedPaths: Set<string>;
  onSelect: (path: string, ctrlKey: boolean) => void;
  refreshVersion: number;
}): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false);
  const [children, setChildren] = React.useState<FileEntry[]>([]);
  const [loaded, setLoaded] = React.useState(false);

  const dirName = dirPath.replace(/\\/g, "/").split("/").filter(Boolean).pop() || dirPath;

  React.useEffect(() => {
    if (expanded && loaded) {
      void listAttachedDirectory(dirPath)
        .then((items) => setChildren(items))
        .catch((err) => console.error("[AttachedDirTree] refresh failed:", err));
    }
  }, [dirPath, expanded, loaded, refreshVersion]);

  const toggleExpand = async (): Promise<void> => {
    if (!expanded && !loaded) {
      try {
        const items = await listAttachedDirectory(dirPath);
        setChildren(items);
        setLoaded(true);
      } catch (err) {
        console.error("[AttachedDirTree] load failed:", err);
      }
    }
    setExpanded((prev) => !prev);
  };

  return (
    <div>
      <div
        className="flex items-center gap-1 py-1 pl-2 pr-2 text-sm cursor-pointer hover:bg-accent/50 group mx-2 rounded-lg"
        onClick={() => { void toggleExpand(); }}
      >
        <ChevronRight className={cn("size-3.5 text-muted-foreground flex-shrink-0 transition-transform duration-150", expanded && "rotate-90")} />
        <FileTypeIcon name={dirName} isDirectory isOpen={expanded} />
        <span className="text-xs truncate flex-1" title={dirPath}>{dirName}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
          onClick={(e) => { e.stopPropagation(); onDetach(); }}
        >
          <X className="size-3" />
        </Button>
      </div>
      {expanded && children.length === 0 && loaded ? (
        <div className="text-[11px] text-muted-foreground/50 py-1" style={{ paddingLeft: 48 }}>空文件夹</div>
      ) : null}
      {expanded && children.map((child) => (
        <AttachedDirItem
          key={child.path}
          entry={child}
          depth={1}
          selectedPaths={selectedPaths}
          onSelect={onSelect}
          refreshVersion={refreshVersion}
        />
      ))}
    </div>
  );
}

function AttachedDirItem({
  entry,
  depth,
  selectedPaths,
  onSelect,
  refreshVersion
}: {
  entry: FileEntry;
  depth: number;
  selectedPaths: Set<string>;
  onSelect: (path: string, ctrlKey: boolean) => void;
  refreshVersion: number;
}): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false);
  const [children, setChildren] = React.useState<FileEntry[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [isRenaming, setIsRenaming] = React.useState(false);
  const [renameValue, setRenameValue] = React.useState(entry.name);
  const renameInputRef = React.useRef<HTMLInputElement>(null);
  const [currentName, setCurrentName] = React.useState(entry.name);
  const [currentPath, setCurrentPath] = React.useState(entry.path);

  const isSelected = selectedPaths.has(currentPath);

  React.useEffect(() => {
    if (expanded && loaded && entry.isDirectory) {
      void listAttachedDirectory(currentPath)
        .then((items) => setChildren(items))
        .catch((err) => console.error("[AttachedDirItem] refresh failed:", err));
    }
  }, [currentPath, entry.isDirectory, expanded, loaded, refreshVersion]);

  const toggleDir = async (): Promise<void> => {
    if (!entry.isDirectory) return;
    if (!expanded && !loaded) {
      try {
        const items = await listAttachedDirectory(currentPath);
        setChildren(items);
        setLoaded(true);
      } catch (err) {
        console.error("[AttachedDirItem] load failed:", err);
      }
    }
    setExpanded((prev) => !prev);
  };

  const handleClick = (e: React.MouseEvent): void => {
    onSelect(currentPath, e.ctrlKey || e.metaKey);
    if (entry.isDirectory) {
      void toggleDir();
    }
  };

  const handleDoubleClick = (): void => {
    if (!entry.isDirectory) {
      void openAttachedFile(currentPath);
    }
  };

  const startRename = (): void => {
    setRenameValue(currentName);
    setIsRenaming(true);
    setTimeout(() => renameInputRef.current?.select(), 50);
  };

  const confirmRename = async (): Promise<void> => {
    const newName = renameValue.trim();
    if (!newName || newName === currentName) {
      setIsRenaming(false);
      return;
    }
    try {
      const result = await renameAttachedFile(currentPath, newName);
      onSelect(result.path, false);
      setCurrentName(newName);
      setCurrentPath(result.path);
    } catch (err) {
      console.error("[AttachedDirItem] rename failed:", err);
    }
    setIsRenaming(false);
  };

  const cancelRename = (): void => {
    setIsRenaming(false);
    setRenameValue(currentName);
  };

  const handleMove = async (): Promise<void> => {
    try {
      const result = await openFolderDialog();
      if (!result.path) return;
      const moved = await moveAttachedFile(currentPath, result.path);
      setCurrentPath(moved.path);
    } catch (err) {
      console.error("[AttachedDirItem] move failed:", err);
    }
  };

  const paddingLeft = 8 + depth * 16;

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
        <FileTypeIcon name={currentName} isDirectory={entry.isDirectory} isOpen={expanded} />
        {isRenaming ? (
          <input
            ref={renameInputRef}
            className="text-xs flex-1 min-w-0 bg-background border border-primary rounded px-1 py-0.5 outline-none"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void confirmRename();
              if (e.key === "Escape") cancelRename();
              e.stopPropagation();
            }}
            onBlur={() => { void confirmRename(); }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="truncate text-xs flex-1">{currentName}</span>
        )}
        <div
          className={cn("flex-shrink-0", !(isSelected && !isRenaming) && "invisible")}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="h-6 w-6 rounded flex items-center justify-center hover:bg-accent/70">
                <MoreHorizontal className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            {isSelected && !isRenaming ? (
              <DropdownMenuContent align="start" className="w-40 z-[9999] min-w-0 p-0.5">
                <DropdownMenuItem className="text-xs py-1 [&>svg]:size-3.5" onSelect={() => { void showAttachedFileInFolder(currentPath); }}>
                  <FolderSearch />
                  在文件夹中显示
                </DropdownMenuItem>
                {!entry.isDirectory ? (
                  <DropdownMenuItem className="text-xs py-1 [&>svg]:size-3.5" onSelect={() => { void openAttachedFile(currentPath); }}>
                    <ExternalLink />
                    打开文件
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem className="text-xs py-1 [&>svg]:size-3.5" onSelect={startRename}>
                  <Pencil />
                  重命名
                </DropdownMenuItem>
                <DropdownMenuItem className="text-xs py-1 [&>svg]:size-3.5" onSelect={() => { void handleMove(); }}>
                  <FolderInput />
                  移动到...
                </DropdownMenuItem>
              </DropdownMenuContent>
            ) : null}
          </DropdownMenu>
        </div>
      </div>
      {expanded && children.length === 0 && loaded ? (
        <div className="text-[11px] text-muted-foreground/50 py-1" style={{ paddingLeft: paddingLeft + 24 }}>空文件夹</div>
      ) : null}
      {expanded && children.map((child) => (
        <AttachedDirItem
          key={child.path}
          entry={child}
          depth={depth + 1}
          selectedPaths={selectedPaths}
          onSelect={onSelect}
          refreshVersion={refreshVersion}
        />
      ))}
    </>
  );
}
