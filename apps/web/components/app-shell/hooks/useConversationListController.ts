import { useCallback, useEffect, useMemo } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ConversationMeta } from "@lume/shared";
import type { ActiveView } from "@/atoms/active-view";
import {
  createConversation,
  deleteConversationById,
  listConversations,
  togglePinConversation,
  updateConversationTitle
} from "@/lib/desktop-api/chat";
import {
  groupConversationsByDate,
  resolveNewConversationPromptId,
  sortConversationsByUpdatedAt
} from "../left-sidebar-conversations";

interface EditingTarget {
  id: string;
  type: "conversation" | "agent";
  draft: string;
}

interface UseConversationListControllerParams {
  selectedModel: { channelId: string; modelId: string } | null;
  defaultPromptId?: string | null;
  setConversations: Dispatch<SetStateAction<ConversationMeta[]>>;
  setCurrentConversationId: Dispatch<SetStateAction<string | null>>;
  setConversationPromptMap: Dispatch<SetStateAction<Map<string, string>>>;
  setSelectedPromptId: Dispatch<SetStateAction<string>>;
  setActiveView: Dispatch<SetStateAction<ActiveView>>;
  setInitError: Dispatch<SetStateAction<string | null>>;
  currentConversationId: string | null;
  editing: EditingTarget | null;
  setEditing: Dispatch<SetStateAction<EditingTarget | null>>;
  conversations: ConversationMeta[];
}

export function useConversationListController({
  selectedModel,
  defaultPromptId,
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
}: UseConversationListControllerParams) {
  useEffect(() => {
    void listConversations().then((items) => {
      setConversations(items);
      setCurrentConversationId((prev) => prev ?? items[0]?.id ?? null);
    }).catch((error) => {
      console.error("[LeftSidebar] 加载对话列表失败:", error);
      setInitError(`加载对话失败: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, [setConversations, setCurrentConversationId, setInitError]);

  const sortedConversations = useMemo(
    () => sortConversationsByUpdatedAt(conversations),
    [conversations]
  );
  const pinnedConversations = useMemo(
    () => sortedConversations.filter((item) => item.pinned),
    [sortedConversations]
  );
  const conversationGroups = useMemo(
    () => groupConversationsByDate(sortedConversations),
    [sortedConversations]
  );

  const beginEditConversation = useCallback((item: ConversationMeta): void => {
    setEditing({ id: item.id, type: "conversation", draft: item.title });
  }, [setEditing]);

  const saveConversationEdit = useCallback(async (): Promise<void> => {
    if (!editing || editing.type !== "conversation") return;
    const next = editing.draft.trim();
    if (!next) {
      setEditing(null);
      return;
    }
    const current = conversations.find((item) => item.id === editing.id);
    if (!current || next === current.title) {
      setEditing(null);
      return;
    }
    const updated = await updateConversationTitle(editing.id, next);
    setConversations((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    setEditing(null);
  }, [conversations, editing, setConversations, setEditing]);

  const createNewConversation = useCallback(async (): Promise<void> => {
    const created = await createConversation({
      modelId: selectedModel?.modelId,
      channelId: selectedModel?.channelId
    });
    setConversations((prev) => [created, ...prev]);
    const nextPromptId = resolveNewConversationPromptId(defaultPromptId);
    setConversationPromptMap((prev) => {
      const next = new Map(prev);
      next.set(created.id, nextPromptId);
      return next;
    });
    setSelectedPromptId(nextPromptId);
    setCurrentConversationId(created.id);
    setActiveView("conversations");
  }, [
    defaultPromptId,
    selectedModel?.channelId,
    selectedModel?.modelId,
    setActiveView,
    setConversationPromptMap,
    setConversations,
    setCurrentConversationId,
    setSelectedPromptId
  ]);

  const confirmDeleteConversation = useCallback(async (conversationId: string): Promise<void> => {
    await deleteConversationById(conversationId);
    setConversationPromptMap((prev) => {
      if (!prev.has(conversationId)) return prev;
      const next = new Map(prev);
      next.delete(conversationId);
      return next;
    });
    const next = await listConversations();
    setConversations(next);
    if (currentConversationId === conversationId) {
      setCurrentConversationId(next[0]?.id ?? null);
    }
  }, [currentConversationId, setConversationPromptMap, setConversations, setCurrentConversationId]);

  const toggleConversationPinned = useCallback(async (conversationId: string): Promise<void> => {
    const updated = await togglePinConversation(conversationId);
    setConversations((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
  }, [setConversations]);

  const retryLoadConversations = useCallback((): void => {
    setInitError(null);
    void listConversations().then(setConversations).catch((error) => {
      setInitError(`重试加载对话失败: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, [setConversations, setInitError]);

  return {
    pinnedConversations,
    conversationGroups,
    beginEditConversation,
    saveConversationEdit,
    createNewConversation,
    confirmDeleteConversation,
    toggleConversationPinned,
    retryLoadConversations
  };
}
