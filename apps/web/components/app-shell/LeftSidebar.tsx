"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { ArrowRightLeft, ChevronDown, ChevronRight, Pin, PinOff, Plus, Settings, Trash2, Pencil, Plug, Zap, RefreshCw } from "lucide-react";
import type { AgentSessionMeta, ConversationMeta } from "@lume/shared";
import {
  activeViewAtom,
  agentRunningSessionIdsAtom,
  agentChannelIdAtom,
  agentModelIdAtom,
  agentSessionsAtom,
  agentWorkspacesAtom,
  appModeAtom,
  conversationsAtom,
  conversationPromptIdAtom,
  currentAgentWorkspaceIdAtom,
  currentAgentSessionIdAtom,
  currentConversationIdAtom,
  hasUpdateAtom,
  promptConfigAtom,
  selectedPromptIdAtom,
  selectedModelAtom,
  streamingConversationIdsAtom,
  workspaceCapabilitiesVersionAtom
} from "@/atoms";
import {
  createAgentSession,
  deleteAgentSessionById,
  ensureDefaultAgentWorkspace,
  getAgentWorkspaceCapabilities,
  listAgentSessions,
  listAgentWorkspaces,
  moveAgentSessionToWorkspace,
  togglePinAgentSession,
  updateAgentSessionTitle
} from "@/lib/desktop-api/agent";
import {
  listConversations
} from "@/lib/desktop-api/chat";
import { cn } from "@/lib/utils";
import { WorkspaceSelector } from "@/components/agent";
import { AgentSidebarSection } from "./AgentSidebarSection";
import { ConversationSidebarSection } from "./ConversationSidebarSection";
import { useAgentSessionListController } from "./hooks/useAgentSessionListController";
import { useConversationListController } from "./hooks/useConversationListController";
import { groupConversationsByDate } from "./left-sidebar-conversations";
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
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from "@/components/ui/context-menu";
import { ModeSwitcher } from "./ModeSwitcher";

type DateGroup = "今天" | "昨天" | "更早";
type DeleteTarget = { id: string; type: "conversation" | "agent" } | null;
type EditingTarget = { id: string; type: "conversation" | "agent"; draft: string } | null;
type CapabilityCounts = { mcp: number; skills: number } | null;

export interface LeftSidebarProps {
  width?: number;
}

export function LeftSidebar({ width }: LeftSidebarProps): React.ReactElement {
  const mode = useAtomValue(appModeAtom);
  const [activeView, setActiveView] = useAtom(activeViewAtom);
  const hasUpdate = useAtomValue(hasUpdateAtom);
  const streamingIds = useAtomValue(streamingConversationIdsAtom);
  const runningIds = useAtomValue(agentRunningSessionIdsAtom);
  const agentChannelId = useAtomValue(agentChannelIdAtom);
  const agentModelId = useAtomValue(agentModelIdAtom);
  const selectedModel = useAtomValue(selectedModelAtom);
  const promptConfig = useAtomValue(promptConfigAtom);
  const capabilitiesVersion = useAtomValue(workspaceCapabilitiesVersionAtom);

  const [conversations, setConversations] = useAtom(conversationsAtom);
  const [currentConversationId, setCurrentConversationId] = useAtom(currentConversationIdAtom);
  const setConversationPromptMap = useSetAtom(conversationPromptIdAtom);
  const setSelectedPromptId = useSetAtom(selectedPromptIdAtom);
  const [agentSessions, setAgentSessions] = useAtom(agentSessionsAtom);
  const [currentAgentSessionId, setCurrentAgentSessionId] = useAtom(currentAgentSessionIdAtom);
  const [agentWorkspaces, setAgentWorkspaces] = useAtom(agentWorkspacesAtom);
  const [currentWorkspaceId, setCurrentWorkspaceId] = useAtom(currentAgentWorkspaceIdAtom);

  const [pinnedExpanded, setPinnedExpanded] = useState(true);
  const [agentPinnedExpanded, setAgentPinnedExpanded] = useState(true);
  const [capabilities, setCapabilities] = useState<CapabilityCounts>(null);
  const [pendingDelete, setPendingDelete] = useState<DeleteTarget>(null);
  const [editing, setEditing] = useState<EditingTarget>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  useEffect(() => {
    void listConversations().then((items) => {
      setConversations(items);
      setCurrentConversationId((prev) => prev ?? items[0]?.id ?? null);
    }).catch((error) => {
      console.error("[LeftSidebar] 加载对话列表失败:", error);
      setInitError(`加载对话失败: ${error instanceof Error ? error.message : String(error)}`);
    });
    void refreshAgentSessions();
    void (async () => {
      try {
        await ensureDefaultAgentWorkspace();
        const ws = await listAgentWorkspaces();
        setAgentWorkspaces(ws);
        setCurrentWorkspaceId((prev) => prev ?? ws[0]?.id ?? null);
        setInitError(null);
      } catch (error) {
        console.error("[LeftSidebar] 初始化工作区失败:", error);
        setInitError(`初始化工作区失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }, [setConversations, setCurrentConversationId, setAgentSessions, setCurrentAgentSessionId, setAgentWorkspaces, setCurrentWorkspaceId]);

  useEffect(() => {
    if (mode !== "agent" || !currentWorkspaceId) {
      setCapabilities(null);
      return;
    }
    const ws = agentWorkspaces.find((item) => item.id === currentWorkspaceId);
    if (!ws) return;
    void getAgentWorkspaceCapabilities(ws.slug).then((caps) => {
      const enabledMcp = caps.mcpServers.filter((item) => item.enabled).length;
      setCapabilities({
        mcp: enabledMcp,
        skills: caps.skills.length
      });
    });
  }, [mode, currentWorkspaceId, agentWorkspaces, activeView, capabilitiesVersion]);

  const {
    pinnedConversations,
    conversationGroups,
    beginEditConversation,
    saveConversationEdit,
    createNewConversation,
    confirmDeleteConversation,
    toggleConversationPinned,
    retryLoadConversations
  } = useConversationListController({
    selectedModel,
    defaultPromptId: promptConfig.defaultPromptId,
    setConversations,
    setCurrentConversationId,
    setConversationPromptMap,
    setSelectedPromptId,
    setActiveView,
    setInitError,
    currentConversationId,
    editing,
    setEditing,
    conversations
  });
  const {
    isRefreshingSessions,
    refreshAgentSessions,
    childSessionMap,
    pinnedAgentSessions,
    agentGroups,
    expandedParentIds,
    setExpandedParentIds,
    beginEditAgent,
    saveAgentEdit,
    createNewAgentSession,
    toggleAgentPin,
    moveAgentSession,
    confirmDeleteAgentSession
  } = useAgentSessionListController({
    agentChannelId,
    agentModelId,
    currentWorkspaceId,
    setCurrentWorkspaceId,
    setAgentSessions,
    setCurrentAgentSessionId,
    setActiveView,
    setInitError,
    currentAgentSessionId,
    editing,
    setEditing,
    agentSessions
  });

  const saveEdit = async (): Promise<void> => {
    if (!editing) return;
    if (editing.type === "conversation") {
      await saveConversationEdit();
    } else {
      await saveAgentEdit();
    }
  };

  const createNew = async (): Promise<void> => {
    if (mode === "chat") {
      await createNewConversation();
      return;
    }
    await createNewAgentSession();
  };

  const confirmDelete = async (): Promise<void> => {
    if (!pendingDelete) return;
    if (pendingDelete.type === "conversation") {
      await confirmDeleteConversation(pendingDelete.id);
    } else {
      await confirmDeleteAgentSession(pendingDelete.id);
    }
    setPendingDelete(null);
  };

  const rowClass = (active: boolean): string =>
    cn(
      "group flex w-full items-center gap-2 rounded-[10px] px-3 py-[7px] text-left text-[13px] transition-colors duration-100",
      active
        ? "bg-foreground/[0.08] text-foreground shadow-[0_1px_2px_0_rgba(0,0,0,0.05)]"
        : "text-foreground/80 hover:bg-foreground/[0.04]"
    );

  return (
    <div
      className="titlebar-no-drag h-full flex flex-col bg-background"
      style={{ width: width ?? 280, minWidth: 180, flexShrink: 1 }}
    >
      <div className="pt-[50px]">
        <ModeSwitcher />
      </div>

      {mode === "agent" ? (
        <div className="px-3 pt-3">
          <WorkspaceSelector
            workspaces={agentWorkspaces}
            value={currentWorkspaceId}
            onChange={setCurrentWorkspaceId}
            onWorkspaceChange={setAgentWorkspaces}
          />
        </div>
      ) : null}

      {initError ? (
        <div className="mx-3 mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[12px] text-destructive">
          <div className="line-clamp-3">{initError}</div>
          <button
            type="button"
            className="mt-1 text-[11px] underline underline-offset-2"
            onClick={retryLoadConversations}
          >
            重试
          </button>
        </div>
      ) : null}

      <div className="px-3 pt-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => { void createNew(); }}
            className="titlebar-no-drag flex w-full items-center gap-2 rounded-[10px] border border-dashed border-foreground/10 bg-foreground/[0.04] px-3 py-2 text-[13px] font-medium text-foreground/70 transition-colors hover:border-foreground/20 hover:bg-foreground/[0.08]"
          >
            <Plus size={14} />
            <span>{mode === "chat" ? "新对话" : "新会话"}</span>
          </button>
          {mode === "agent" ? (
            <button
              type="button"
              title="刷新会话列表"
              aria-label="刷新会话列表"
              disabled={isRefreshingSessions}
              onClick={() => { void refreshAgentSessions(); }}
              className="titlebar-no-drag inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] border border-foreground/10 bg-foreground/[0.04] text-foreground/60 transition-colors hover:border-foreground/20 hover:bg-foreground/[0.08] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RefreshCw size={14} className={cn(isRefreshingSessions ? "animate-spin" : "")} />
            </button>
          ) : null}
        </div>
      </div>

      {mode === "chat" ? (
        <ConversationSidebarSection
          pinnedExpanded={pinnedExpanded}
          onTogglePinnedExpanded={() => setPinnedExpanded((prev) => !prev)}
          pinnedConversations={pinnedConversations}
          conversationGroups={conversationGroups}
          currentConversationId={currentConversationId}
          streamingIds={streamingIds}
          editing={editing}
          inputRef={inputRef}
          hoveredId={hoveredId}
          onHoveredIdChange={setHoveredId}
          onEditingDraftChange={(draft) => setEditing((prev) => (prev ? { ...prev, draft } : prev))}
          onSaveEdit={saveEdit}
          onCancelEdit={() => setEditing(null)}
          onOpenConversation={(conversationId) => {
            setCurrentConversationId(conversationId);
            setActiveView("conversations");
          }}
          onBeginEditConversation={beginEditConversation}
          onRequestDeleteConversation={(conversationId) => setPendingDelete({ id: conversationId, type: "conversation" })}
          onToggleConversationPinned={toggleConversationPinned}
          rowClass={rowClass}
        />
      ) : (
        <AgentSidebarSection
          agentPinnedExpanded={agentPinnedExpanded}
          onTogglePinnedExpanded={() => setAgentPinnedExpanded((prev) => !prev)}
          pinnedAgentSessions={pinnedAgentSessions}
          agentGroups={agentGroups}
          childSessionMap={childSessionMap}
          expandedParentIds={expandedParentIds}
          onToggleParentExpanded={(parentId) => {
            setExpandedParentIds((prev) => {
              const next = new Set(prev);
              if (next.has(parentId)) next.delete(parentId);
              else next.add(parentId);
              return next;
            });
          }}
          currentAgentSessionId={currentAgentSessionId}
          runningIds={runningIds}
          agentWorkspaces={agentWorkspaces}
          editing={editing}
          inputRef={inputRef}
          hoveredId={hoveredId}
          onHoveredIdChange={setHoveredId}
          onEditingDraftChange={(draft) => setEditing((prev) => (prev ? { ...prev, draft } : prev))}
          onSaveEdit={saveEdit}
          onCancelEdit={() => setEditing(null)}
          onOpenAgentSession={(sessionId) => {
            setCurrentAgentSessionId(sessionId);
            setActiveView("conversations");
          }}
          onBeginEditAgent={beginEditAgent}
          onRequestDeleteAgent={(sessionId) => setPendingDelete({ id: sessionId, type: "agent" })}
          onToggleAgentPin={toggleAgentPin}
          onMoveAgentSession={moveAgentSession}
          rowClass={rowClass}
        />
      )}

      {mode === "agent" && capabilities ? (
        <div className="px-3 pb-1">
          <button
            type="button"
            className="titlebar-no-drag flex w-full items-center gap-3 rounded-[10px] px-3 py-2 text-[12px] text-foreground/50 transition-colors hover:bg-foreground/[0.04] hover:text-foreground/70"
            onClick={() => setActiveView("settings")}
          >
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              <span className="inline-flex items-center gap-1">
                <Plug size={13} className="text-foreground/40" />
                <span className="tabular-nums">{capabilities.mcp}</span>
                <span className="text-foreground/30">MCP</span>
              </span>
              <span className="text-foreground/20">·</span>
              <span className="inline-flex items-center gap-1">
                <Zap size={13} className="text-foreground/40" />
                <span className="tabular-nums">{capabilities.skills}</span>
                <span className="text-foreground/30">Skills</span>
              </span>
            </div>
          </button>
        </div>
      ) : null}

      <div className="px-3 pb-3">
        <button
          type="button"
          className={cn(
            "titlebar-no-drag flex w-full items-center justify-between rounded-[10px] px-3 py-2 text-left text-[13px] transition-colors",
            activeView === "settings"
              ? "bg-foreground/[0.08] text-foreground shadow-[0_1px_2px_0_rgba(0,0,0,0.05)]"
              : "text-foreground/60 hover:bg-foreground/[0.04] hover:text-foreground"
          )}
          onClick={() => setActiveView("settings")}
        >
          <span className="inline-flex items-center gap-3">
            <span className="inline-flex h-[18px] w-[18px] items-center justify-center">
              <Settings size={18} />
            </span>
            <span>设置</span>
          </span>
          {hasUpdate ? <span className="h-2 w-2 rounded-full bg-red-500" /> : null}
        </button>
      </div>

      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => { if (!open) setPendingDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pendingDelete?.type === "agent" ? "确认删除会话" : "确认删除对话"}</AlertDialogTitle>
            <AlertDialogDescription>
              删除后将无法恢复，确定要删除这个对话吗？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { void confirmDelete(); }}
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
