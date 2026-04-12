import { useCallback, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
  activeViewAtom,
  agentPendingPromptAtom,
  agentThreadsAtom,
  appModeAtom,
  currentConversationIdAtom,
  currentAgentThreadIdAtom,
  currentAgentWorkspaceIdAtom,
  settingsTabAtom
} from "@/atoms";
import { createAgentThread, listAgentThreads, migrateChatToAgentThread } from "@/lib/desktop-api/agent";
import { getEffectiveSystemConfig, listChannels } from "@/lib/desktop-api/system";
import { resolveChannelModelSelectionFromRef } from "@/lib/system-model-selection";

interface MigrateOptions {
  suggestedPrompt?: string;
}

export function useMigrateChatToAgent(): {
  busy: boolean;
  error: string | null;
  clearError: () => void;
  migrate: (options?: MigrateOptions) => Promise<boolean>;
} {
  const conversationId = useAtomValue(currentConversationIdAtom);
  const workspaceId = useAtomValue(currentAgentWorkspaceIdAtom);
  const setAgentSessions = useSetAtom(agentThreadsAtom);
  const setCurrentSessionId = useSetAtom(currentAgentThreadIdAtom);
  const setPendingPrompt = useSetAtom(agentPendingPromptAtom);
  const setAppMode = useSetAtom(appModeAtom);
  const setActiveView = useSetAtom(activeViewAtom);
  const setSettingsTab = useSetAtom(settingsTabAtom);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const migrate = useCallback(async (options?: MigrateOptions): Promise<boolean> => {
    if (busy) return false;
    setError(null);

    if (!conversationId) {
      setError("当前没有可迁移的 Chat 对话。");
      return false;
    }

    setBusy(true);
    try {
      const resolvedModel = await Promise.all([
        listChannels(),
        getEffectiveSystemConfig()
      ]).then(([channels, systemConfig]) =>
        resolveChannelModelSelectionFromRef(channels, systemConfig.models?.agent?.defaultModelRef, "chat")
      );
      if (!resolvedModel) {
        setAppMode("agent");
        setActiveView("settings");
        setSettingsTab("agent");
        setError("未找到可用的 Agent 默认模型，已跳转到配置页。");
        return false;
      }
      const thread = await createAgentThread({
        modelRef: resolvedModel.modelRef,
        channelId: resolvedModel.channelId,
        modelId: resolvedModel.modelId,
        workspaceId: workspaceId ?? undefined
      });
      await migrateChatToAgentThread(conversationId, thread.id);
      const sessions = await listAgentThreads();
      setAgentSessions(sessions);
      setCurrentSessionId(thread.id);
      const prompt = options?.suggestedPrompt?.trim();
      if (prompt) {
        setPendingPrompt({ threadId: thread.id, message: prompt });
      }
      setAppMode("agent");
      setActiveView("conversations");
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(`创建 Agent 线程失败：${message}`);
      return false;
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    conversationId,
    setActiveView,
    setAgentSessions,
    setAppMode,
    setCurrentSessionId,
    setPendingPrompt,
    setSettingsTab,
    workspaceId
  ]);

  return {
    busy,
    error,
    clearError: () => setError(null),
    migrate
  };
}
