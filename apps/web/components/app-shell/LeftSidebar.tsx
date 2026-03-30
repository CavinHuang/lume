import { useEffect, useRef, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Plus, RefreshCw } from "lucide-react";
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
  listAgentWorkspaces,
} from "@/lib/desktop-api/agent";
import { cn } from "@/lib/utils";
import { WorkspaceSelector } from "@/components/agent";
import { AgentSidebarSection } from "./AgentSidebarSection";
import { ConversationSidebarSection } from "./ConversationSidebarSection";
import { SidebarSettingsEntry } from "./SidebarSettingsEntry";
import { useAgentSessionListController } from "./hooks/useAgentSessionListController";
import { useConversationListController } from "./hooks/useConversationListController";
import { useWorkspaceSidebarState } from "./hooks/useWorkspaceSidebarState";
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
import { ModeSwitcher } from "./ModeSwitcher";

type DeleteTarget = { id: string; type: "conversation" | "agent" } | null;
type EditingTarget = { id: string; type: "conversation" | "agent"; draft: string } | null;

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
  const {
    capabilities,
    workspaceInitError
  } = useWorkspaceSidebarState({
    mode,
    currentWorkspaceId,
    agentWorkspaces,
    capabilitiesVersion,
    setAgentWorkspaces,
    setCurrentWorkspaceId
  });

  useEffect(() => {
    void refreshAgentSessions();
  }, [refreshAgentSessions]);

  useEffect(() => {
    setInitError(workspaceInitError);
  }, [workspaceInitError]);

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

      <SidebarSettingsEntry
        active={activeView === "settings"}
        hasUpdate={hasUpdate}
        capabilities={capabilities}
        showCapabilities={mode === "agent"}
        onOpenSettings={() => setActiveView("settings")}
      />

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
