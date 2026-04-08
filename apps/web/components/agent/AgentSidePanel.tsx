/**
 * AgentSidePanel — Agent 侧面板容器
 *
 * 对齐 Proma SidePanel UI 风格：
 * - 顶部标题栏：FolderOpen 图标 + "文件" + 活动指示点
 * - 切换按钮带 Tooltip，面板关闭时显示活动指示点
 * - 会话文件区 section header（FolderOpen + Info + breadcrumb + ExternalLink + RefreshCw）
 * - 虚线分隔线
 * - 工作区文件区用 FolderHeart + bg-muted/30 容器
 * - 附加目录文字：附加目录（Agent 可以读取并操作此文件夹）
 */

import * as React from "react";
import { useAtom, useAtomValue } from "jotai";
import {
  ExternalLink,
  FolderHeart,
  FolderOpen,
  Info,
  PanelRight,
  RefreshCw,
  Trash2,
  X
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@/components/ui/tooltip";
import { FileBrowser, FileDropZone } from "@/components/file-browser";
import {
  agentAttachedDirectoriesMapAtom,
  workspaceAttachedDirectoriesMapAtom,
  workspaceFilesVersionAtom
} from "@/atoms";
import {
  getAgentWorkspaceRootPath,
  openAgentFile
} from "@/lib/desktop-api/agent";
import { openFolderDialog } from "@/lib/desktop-api/system";

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
  const [workspacePath, setWorkspacePath] = React.useState<string | null>(null);
  const [sessionAttachedDirs, setSessionAttachedDirs] = useAtom(agentAttachedDirectoriesMapAtom);
  const [workspaceAttachedDirs, setWorkspaceAttachedDirs] = useAtom(workspaceAttachedDirectoriesMapAtom);
  const filesVersion = useAtomValue(workspaceFilesVersionAtom);
  const [, setFilesVersion] = useAtom(workspaceFilesVersionAtom);

  const hasFileChanges = filesVersion > 0;

  const currentSessionDirs = sessionId ? sessionAttachedDirs.get(sessionId) ?? [] : [];
  const currentWorkspaceDirs = workspaceSlug ? workspaceAttachedDirs.get(workspaceSlug) ?? [] : [];

  // 是否有内容可以显示（有 sessionPath 或有附加目录）
  const hasContent = sessionPath || currentSessionDirs.length > 0;

  // 动画标志：仅用户手动点击时启用过渡动画
  const animateRef = React.useRef(false);
  React.useEffect(() => {
    animateRef.current = false;
  }, [sessionId]);

  const handleToggle = React.useCallback(() => {
    animateRef.current = true;
    onOpenChange(!open);
  }, [open, onOpenChange]);

  // 获取工作区根路径
  React.useEffect(() => {
    if (!workspaceSlug) {
      setWorkspacePath(null);
      return;
    }
    void getAgentWorkspaceRootPath(workspaceSlug)
      .then(setWorkspacePath)
      .catch(() => setWorkspacePath(null));
  }, [workspaceSlug]);

  // 自动打开：文件变化时
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

  // 会话级附加文件夹（无参数，内部调用 openFolderDialog）
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
      console.error("[AgentSidePanel] 附加会话文件夹失败:", error);
    }
  }, [sessionId, setSessionAttachedDirs]);

  const handleDetachSessionFolder = React.useCallback(
    (path: string): void => {
      if (!sessionId) return;
      setSessionAttachedDirs((prev) => {
        const map = new Map(prev);
        const current = map.get(sessionId) ?? [];
        map.set(
          sessionId,
          current.filter((d) => d !== path)
        );
        return map;
      });
    },
    [sessionId, setSessionAttachedDirs]
  );

  // 工作区级附加文件夹（无参数，内部调用 openFolderDialog）
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

  const handleDetachWorkspaceFolder = React.useCallback(
    (path: string): void => {
      if (!workspaceSlug) return;
      setWorkspaceAttachedDirs((prev) => {
        const map = new Map(prev);
        const current = map.get(workspaceSlug) ?? [];
        map.set(
          workspaceSlug,
          current.filter((d) => d !== path)
        );
        return map;
      });
    },
    [workspaceSlug, setWorkspaceAttachedDirs]
  );

  // 面包屑
  const sessionBreadcrumb = React.useMemo(() => {
    if (!sessionPath) return "";
    const normalized = sessionPath.replace(/\\/g, "/");
    const parts = normalized.split("/").filter(Boolean);
    return parts.length > 2 ? `.../${parts.slice(-2).join("/")}` : normalized;
  }, [sessionPath]);

  return (
    <div
      className={cn(
        "relative flex-shrink-0 overflow-hidden",
        animateRef.current && "transition-[width] duration-300 ease-in-out",
        open ? "w-[320px] border-l" : hasContent ? "w-10" : "w-0"
      )}
    >
      {/* ===== 切换按钮 — 固定在右上角，带 Tooltip ===== */}
      {hasContent && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-2.5 top-2.5 z-10 h-7 w-7"
              onClick={handleToggle}
            >
              <PanelRight
                className={cn(
                  "size-3.5 absolute transition-all duration-200",
                  open
                    ? "opacity-0 rotate-90 scale-75"
                    : "opacity-100 rotate-0 scale-100"
                )}
              />
              <X
                className={cn(
                  "size-3.5 absolute transition-all duration-200",
                  open
                    ? "opacity-100 rotate-0 scale-100"
                    : "opacity-0 -rotate-90 scale-75"
                )}
              />
              {/* 活动指示点（面板关闭时显示） */}
              {!open && hasFileChanges && (
                <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-primary animate-pulse" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">
            <p>{open ? "关闭侧面板" : "打开侧面板"}</p>
          </TooltipContent>
        </Tooltip>
      )}

      {/* ===== 面板内容 ===== */}
      {hasContent && (
        <div
          className={cn(
            "w-[320px] h-full flex flex-col",
            animateRef.current && "transition-opacity duration-300",
            open ? "opacity-100" : "opacity-0 pointer-events-none"
          )}
        >
          {/* ===== 顶部标题栏 ===== */}
          <div className="flex items-center gap-1 px-3 pr-10 h-[48px] border-b flex-shrink-0">
            <FolderOpen className="size-3.5 text-muted-foreground" />
            <span className="text-xs font-medium">文件</span>
            {hasFileChanges && (
              <span className="ml-0.5 size-1.5 rounded-full bg-primary" />
            )}
          </div>

          {/* ===== 文件浏览内容 ===== */}
          {hasFiles && workspaceSlug && sessionPath ? (
            <div className="flex-1 min-h-0 flex flex-col">
              {/* ===== 会话文件区 section header ===== */}
              <div className="flex items-center gap-1 px-3 h-[32px] flex-shrink-0">
                <FolderOpen className="size-3 text-muted-foreground" />
                <span className="text-[11px] font-medium text-muted-foreground">
                  会话文件
                </span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="size-3 text-muted-foreground/50 cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-[200px]">
                    <p>当前会话的专属文件，仅本次对话的 Agent 可以访问</p>
                  </TooltipContent>
                </Tooltip>
                <span
                  className="text-[10px] text-muted-foreground/50 truncate flex-1"
                  title={sessionPath}
                >
                  {sessionBreadcrumb}
                </span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 flex-shrink-0"
                      onClick={() => {
                        void openAgentFile(workspaceSlug, sessionId, sessionPath);
                      }}
                    >
                      <ExternalLink className="size-2.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    <p>在文件管理器中打开</p>
                  </TooltipContent>
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
                  <TooltipContent side="bottom">
                    <p>刷新文件列表</p>
                  </TooltipContent>
                </Tooltip>
              </div>

              {/* 会话文件内容区（独立滚动） */}
              <div className="flex-1 min-h-0 overflow-y-auto">
                {/* 附加目录 */}
                {currentSessionDirs.length > 0 && (
                  <AttachedDirsSection
                    dirs={currentSessionDirs}
                    onDetach={handleDetachSessionFolder}
                  />
                )}
                {/* 会话文件浏览器 */}
                <FileBrowser
                  workspaceSlug={workspaceSlug}
                  threadId={sessionId}
                  rootPath={sessionPath}
                  hideToolbar
                  embedded
                />
              </div>
              {/* 会话文件拖拽上传区域（固定在滚动区域外，始终可见） */}
              <FileDropZone
                workspaceSlug={workspaceSlug}
                threadId={sessionId}
                target="session"
                onFilesUploaded={handleFilesUploaded}
                onAttachFolder={handleAttachSessionFolder}
              />

              {/* ===== 虚线分隔线 ===== */}
              <div className="mx-3 my-3 border-t border-dashed border-muted-foreground/20" />

              {/* ===== 工作区文件区（带背景色容器） ===== */}
              <div className="flex-1 min-h-0 flex flex-col bg-muted/30 rounded-lg mx-2 mb-2">
                <div className="flex items-center gap-1 px-2 h-[32px] flex-shrink-0">
                  <FolderHeart className="size-3 text-primary/70" />
                  <span className="text-[11px] font-medium text-primary/70">
                    工作区文件
                  </span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="size-3 text-primary/40 cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-[220px]">
                      <p>
                        工作区内所有会话可访问的文件和文件夹，每个新对话都可以自动读取
                      </p>
                    </TooltipContent>
                  </Tooltip>
                  <div className="flex-1" />
                  {workspacePath && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5 flex-shrink-0"
                          onClick={() => {
                            void openAgentFile(
                              workspaceSlug,
                              sessionId,
                              workspacePath
                            );
                          }}
                        >
                          <ExternalLink className="size-2.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">
                        <p>在文件管理器中打开工作区文件目录</p>
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
                {/* 工作区文件内容区（独立滚动） */}
                <div className="flex-1 min-h-0 overflow-y-auto pb-1">
                  {/* 工作区级附加目录 */}
                  {currentWorkspaceDirs.length > 0 && (
                    <AttachedDirsSection
                      dirs={currentWorkspaceDirs}
                      onDetach={handleDetachWorkspaceFolder}
                    />
                  )}
                  {/* 工作区文件浏览器 */}
                  {workspacePath && (
                    <FileBrowser
                      workspaceSlug={workspaceSlug}
                      threadId={sessionId}
                      rootPath={workspacePath}
                      hideToolbar
                      embedded
                    />
                  )}
                </div>
                {/* 工作区文件拖拽上传区域（固定在滚动区域外，始终可见） */}
                <FileDropZone
                  workspaceSlug={workspaceSlug}
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
    </div>
  );
}

/* ========== 内部子组件 ========== */

function AttachedDirsSection({
  dirs,
  onDetach
}: {
  dirs: string[];
  onDetach: (path: string) => void;
}): React.ReactElement {
  return (
    <div className="pt-2.5 pb-1 flex-shrink-0">
      <div className="text-[11px] font-medium text-muted-foreground mb-1 px-3">
        附加目录（Agent 可以读取并操作此文件夹）
      </div>
      {dirs.map((dir) => {
        const name =
          dir
            .replace(/\\/g, "/")
            .split("/")
            .filter(Boolean)
            .pop() ?? dir;
        return (
          <div
            key={dir}
            className="group flex items-center gap-1.5 rounded px-3 py-0.5 text-xs hover:bg-muted/50"
          >
            <FolderOpen className="size-3 text-amber-500 shrink-0" />
            <span className="truncate flex-1 text-[11px]" title={dir}>
              {name}
            </span>
            <button
              type="button"
              className="invisible group-hover:visible shrink-0 rounded p-0.5 text-muted-foreground/60 hover:text-destructive"
              onClick={() => onDetach(dir)}
              title="移除"
            >
              <Trash2 className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

