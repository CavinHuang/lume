"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { AgentSessionMeta } from "@lume/shared";
import type { ActiveView } from "@/atoms/active-view";
import {
  createAgentSession,
  deleteAgentSessionById,
  listAgentSessions,
  moveAgentSessionToWorkspace,
  togglePinAgentSession,
  updateAgentSessionTitle
} from "@/lib/desktop-api/agent";
import {
  buildChildSessionMap,
  deriveAgentGroups,
  derivePinnedAgentSessions,
  filterRootAgentSessions
} from "../left-sidebar-agent-sessions";

interface EditingTarget {
  id: string;
  type: "conversation" | "agent";
  draft: string;
}

interface UseAgentSessionListControllerParams {
  agentChannelId: string | null;
  agentModelId: string | null;
  currentWorkspaceId: string | null;
  setCurrentWorkspaceId: Dispatch<SetStateAction<string | null>>;
  setAgentSessions: Dispatch<SetStateAction<AgentSessionMeta[]>>;
  setCurrentAgentSessionId: Dispatch<SetStateAction<string | null>>;
  setActiveView: Dispatch<SetStateAction<ActiveView>>;
  setInitError: Dispatch<SetStateAction<string | null>>;
  currentAgentSessionId: string | null;
  editing: EditingTarget | null;
  setEditing: Dispatch<SetStateAction<EditingTarget | null>>;
  agentSessions: AgentSessionMeta[];
}

export function useAgentSessionListController({
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
}: UseAgentSessionListControllerParams) {
  const [isRefreshingSessions, setIsRefreshingSessions] = useState(false);
  const [expandedParentIds, setExpandedParentIds] = useState<Set<string>>(new Set());

  const refreshAgentSessions = useCallback(async (): Promise<void> => {
    try {
      setIsRefreshingSessions(true);
      const items = await listAgentSessions();
      setAgentSessions(items);
      setCurrentAgentSessionId((prev) => {
        if (prev && items.some((item) => item.id === prev)) return prev;
        return items[0]?.id ?? null;
      });
    } catch (error) {
      console.error("[LeftSidebar] 刷新 Agent 会话失败:", error);
      setInitError(`刷新 Agent 会话失败: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsRefreshingSessions(false);
    }
  }, [setAgentSessions, setCurrentAgentSessionId, setInitError]);

  const childSessionMap = useMemo(
    () => buildChildSessionMap(agentSessions, currentWorkspaceId),
    [agentSessions, currentWorkspaceId]
  );
  const filteredAgentSessions = useMemo(
    () => filterRootAgentSessions(agentSessions, currentWorkspaceId),
    [agentSessions, currentWorkspaceId]
  );
  const pinnedAgentSessions = useMemo(
    () => derivePinnedAgentSessions(filteredAgentSessions),
    [filteredAgentSessions]
  );
  const agentGroups = useMemo(
    () => deriveAgentGroups(filteredAgentSessions),
    [filteredAgentSessions]
  );

  useEffect(() => {
    if (!currentAgentSessionId) return;
    const current = agentSessions.find((session) => session.id === currentAgentSessionId);
    if (current?.parentSessionId) {
      setExpandedParentIds((prev) => {
        if (prev.has(current.parentSessionId!)) return prev;
        const next = new Set(prev);
        next.add(current.parentSessionId!);
        return next;
      });
    }
  }, [currentAgentSessionId, agentSessions]);

  const beginEditAgent = useCallback((item: AgentSessionMeta): void => {
    setEditing({ id: item.id, type: "agent", draft: item.title });
  }, [setEditing]);

  const saveAgentEdit = useCallback(async (): Promise<void> => {
    if (!editing || editing.type !== "agent") return;
    const next = editing.draft.trim();
    if (!next) {
      setEditing(null);
      return;
    }
    const current = agentSessions.find((item) => item.id === editing.id);
    if (!current || next === current.title) {
      setEditing(null);
      return;
    }
    const updated = await updateAgentSessionTitle(editing.id, next);
    setAgentSessions((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    setEditing(null);
  }, [agentSessions, editing, setAgentSessions, setEditing]);

  const createNewAgentSession = useCallback(async (): Promise<void> => {
    const created = await createAgentSession({
      title: "新 Agent 会话",
      channelId: agentChannelId ?? undefined,
      modelId: agentModelId ?? undefined,
      workspaceId: currentWorkspaceId ?? undefined
    });
    setAgentSessions((prev) => [created, ...prev]);
    setCurrentAgentSessionId(created.id);
    setActiveView("conversations");
  }, [
    agentChannelId,
    agentModelId,
    currentWorkspaceId,
    setActiveView,
    setAgentSessions,
    setCurrentAgentSessionId
  ]);

  const toggleAgentPin = useCallback(async (sessionId: string): Promise<void> => {
    const updated = await togglePinAgentSession(sessionId);
    setAgentSessions((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
  }, [setAgentSessions]);

  const moveAgentSession = useCallback(async (sessionId: string, workspaceId: string): Promise<void> => {
    const updated = await moveAgentSessionToWorkspace(sessionId, workspaceId);
    setAgentSessions((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    if (currentAgentSessionId === sessionId) {
      setCurrentWorkspaceId(workspaceId);
    }
  }, [currentAgentSessionId, setAgentSessions, setCurrentWorkspaceId]);

  const confirmDeleteAgentSession = useCallback(async (sessionId: string): Promise<void> => {
    await deleteAgentSessionById(sessionId);
    const next = await listAgentSessions();
    setAgentSessions(next);
    if (currentAgentSessionId === sessionId) {
      setCurrentAgentSessionId(next[0]?.id ?? null);
    }
  }, [currentAgentSessionId, setAgentSessions, setCurrentAgentSessionId]);

  return {
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
  };
}
