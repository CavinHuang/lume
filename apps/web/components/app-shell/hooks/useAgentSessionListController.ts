import { useCallback, useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { AgentThreadMeta } from "@lume/shared";
import type { ActiveView } from "@/atoms/active-view";
import {
  createAgentThread,
  deleteAgentThreadById,
  listAgentThreads,
  moveAgentThreadToWorkspace,
  togglePinAgentThread,
  updateAgentThreadTitle
} from "@/lib/desktop-api/agent";
import {
  buildChildThreadMap,
  deriveAgentGroups,
  derivePinnedAgentThreads,
  filterRootAgentThreads
} from "../left-sidebar-agent-sessions";

interface EditingTarget {
  id: string;
  type: "conversation" | "agent";
  draft: string;
}

interface UseAgentThreadListControllerParams {
  agentChannelId: string | null;
  agentModelId: string | null;
  currentWorkspaceId: string | null;
  setCurrentWorkspaceId: Dispatch<SetStateAction<string | null>>;
  setAgentSessions: Dispatch<SetStateAction<AgentThreadMeta[]>>;
  setCurrentAgentThreadId: Dispatch<SetStateAction<string | null>>;
  setActiveView: Dispatch<SetStateAction<ActiveView>>;
  setInitError: Dispatch<SetStateAction<string | null>>;
  currentAgentThreadId: string | null;
  editing: EditingTarget | null;
  setEditing: Dispatch<SetStateAction<EditingTarget | null>>;
  agentThreads: AgentThreadMeta[];
}

export function useAgentSessionListController({
  agentChannelId,
  agentModelId,
  currentWorkspaceId,
  setCurrentWorkspaceId,
  setAgentSessions,
  setCurrentAgentThreadId,
  setActiveView,
  setInitError,
  currentAgentThreadId,
  editing,
  setEditing,
  agentThreads
}: UseAgentThreadListControllerParams) {
  const [isRefreshingThreads, setIsRefreshingThreads] = useState(false);
  const [expandedParentIds, setExpandedParentIds] = useState<Set<string>>(new Set());

  const refreshAgentThreads = useCallback(async (): Promise<void> => {
    try {
      setIsRefreshingThreads(true);
      const items = await listAgentThreads();
      setAgentSessions(items);
      setCurrentAgentThreadId((prev) => {
        if (prev && items.some((item) => item.id === prev)) return prev;
        return items[0]?.id ?? null;
      });
    } catch (error) {
      console.error("[LeftSidebar] 刷新 Agent 线程失败:", error);
      setInitError(`刷新 Agent 线程失败: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsRefreshingThreads(false);
    }
  }, [setAgentSessions, setCurrentAgentThreadId, setInitError]);

  const childThreadMap = useMemo(
    () => buildChildThreadMap(agentThreads, currentWorkspaceId),
    [agentThreads, currentWorkspaceId]
  );
  const filteredAgentThreads = useMemo(
    () => filterRootAgentThreads(agentThreads, currentWorkspaceId),
    [agentThreads, currentWorkspaceId]
  );
  const pinnedAgentThreads = useMemo(
    () => derivePinnedAgentThreads(filteredAgentThreads),
    [filteredAgentThreads]
  );
  const agentGroups = useMemo(
    () => deriveAgentGroups(filteredAgentThreads),
    [filteredAgentThreads]
  );

  useEffect(() => {
    if (!currentAgentThreadId) return;
    const current = agentThreads.find((thread) => thread.id === currentAgentThreadId);
    if (current?.parentThreadId) {
      setExpandedParentIds((prev) => {
        if (prev.has(current.parentThreadId!)) return prev;
        const next = new Set(prev);
        next.add(current.parentThreadId!);
        return next;
      });
    }
  }, [currentAgentThreadId, agentThreads]);

  const beginEditAgent = useCallback((item: AgentThreadMeta): void => {
    setEditing({ id: item.id, type: "agent", draft: item.title });
  }, [setEditing]);

  const saveAgentEdit = useCallback(async (): Promise<void> => {
    if (!editing || editing.type !== "agent") return;
    const next = editing.draft.trim();
    if (!next) {
      setEditing(null);
      return;
    }
    const current = agentThreads.find((item) => item.id === editing.id);
    if (!current || next === current.title) {
      setEditing(null);
      return;
    }
    const updated = await updateAgentThreadTitle(editing.id, next);
    setAgentSessions((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    setEditing(null);
  }, [agentThreads, editing, setAgentSessions, setEditing]);

  const createNewAgentThread = useCallback(async (): Promise<void> => {
    const created = await createAgentThread({
      title: "新 Agent 线程",
      channelId: agentChannelId ?? undefined,
      modelId: agentModelId ?? undefined,
      workspaceId: currentWorkspaceId ?? undefined
    });
    setAgentSessions((prev) => [created, ...prev]);
    setCurrentAgentThreadId(created.id);
    setActiveView("conversations");
  }, [
    agentChannelId,
    agentModelId,
    currentWorkspaceId,
    setActiveView,
    setAgentSessions,
    setCurrentAgentThreadId
  ]);

  const toggleAgentPin = useCallback(async (sessionId: string): Promise<void> => {
    const updated = await togglePinAgentThread(sessionId);
    setAgentSessions((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
  }, [setAgentSessions]);

  const moveAgentThread = useCallback(async (threadId: string, workspaceId: string): Promise<void> => {
    const updated = await moveAgentThreadToWorkspace(threadId, workspaceId);
    setAgentSessions((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    if (currentAgentThreadId === threadId) {
      setCurrentWorkspaceId(workspaceId);
    }
  }, [currentAgentThreadId, setAgentSessions, setCurrentWorkspaceId]);

  const confirmDeleteAgentThread = useCallback(async (threadId: string): Promise<void> => {
    await deleteAgentThreadById(threadId);
    const next = await listAgentThreads();
    setAgentSessions(next);
    if (currentAgentThreadId === threadId) {
      setCurrentAgentThreadId(next[0]?.id ?? null);
    }
  }, [currentAgentThreadId, setAgentSessions, setCurrentAgentThreadId]);

  return {
    isRefreshingThreads,
    refreshAgentThreads,
    childThreadMap,
    pinnedAgentThreads,
    agentGroups,
    expandedParentIds,
    setExpandedParentIds,
    beginEditAgent,
    saveAgentEdit,
    createNewAgentThread,
    toggleAgentPin,
    moveAgentThread,
    confirmDeleteAgentThread
  };
}
