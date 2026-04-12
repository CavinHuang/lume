import { startTransition, useEffect, useMemo, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import type { AgentSavedFile, Channel } from "@lume/shared";
import {
  agentChannelIdAtom,
  agentLiveSdkMessagesMapAtom,
  agentMessageVersionsByGroupAtom,
  agentModelIdAtom,
  agentPendingFilesAtom,
  agentRuntimeStatusesAtom,
  agentSelectedVersionIndexByGroupAtom,
  agentStreamErrorsAtom,
  agentWorkspacesAtom,
  currentAgentThreadSdkMessagesAtom,
  currentAgentThreadMessagesAtom,
  currentAgentThreadAtom,
  currentAgentThreadIdAtom,
  currentAgentWorkspaceIdAtom
} from "@/atoms";
import { resetPlanStateAtom } from "@/atoms/plan-atoms";
import {
  getAgentThreadRuntimeStatus,
  getAgentThreadSDKMessages,
  getAgentThreadMessages,
  getAgentThreadPath
} from "@/lib/desktop-api/agent";
import { getEffectiveSystemConfig, listChannels } from "@/lib/desktop-api/system";
import { resolveAgentSessionWorkspace } from "../workspace-selection";
import { resolvePreferredAgentSelection } from "../agent-session-lifecycle";

interface UseAgentSessionLifecycleParams {
  setPendingFolderRefs: React.Dispatch<React.SetStateAction<AgentSavedFile[]>>;
  setInlineEditingMessageId: React.Dispatch<React.SetStateAction<string | null>>;
}

interface UseAgentSessionLifecycleResult {
  currentWorkspace: ReturnType<typeof resolveAgentSessionWorkspace>;
  sessionRootPath: string | null;
  sessionSwitching: boolean;
}

export function useAgentSessionLifecycle({
  setPendingFolderRefs,
  setInlineEditingMessageId
}: UseAgentSessionLifecycleParams): UseAgentSessionLifecycleResult {
  const [sessionId] = useAtom(currentAgentThreadIdAtom);
  const session = useAtomValue(currentAgentThreadAtom);
  const workspaceId = useAtomValue(currentAgentWorkspaceIdAtom);
  const workspaces = useAtomValue(agentWorkspacesAtom);
  const [, setMessages] = useAtom(currentAgentThreadMessagesAtom);
  const [, setSdkMessages] = useAtom(currentAgentThreadSdkMessagesAtom);
  const setLiveSdkMessagesMap = useSetAtom(agentLiveSdkMessagesMapAtom);
  const [agentChannelId, setAgentChannelId] = useAtom(agentChannelIdAtom);
  const [agentModelId, setAgentModelId] = useAtom(agentModelIdAtom);
  const setMessageVersionsByGroup = useSetAtom(agentMessageVersionsByGroupAtom);
  const setSelectedVersionIndexByGroup = useSetAtom(agentSelectedVersionIndexByGroupAtom);
  const setPendingFiles = useSetAtom(agentPendingFilesAtom);
  const setStreamErrors = useSetAtom(agentStreamErrorsAtom);
  const setRuntimeStatuses = useSetAtom(agentRuntimeStatusesAtom);
  const resetPlan = useSetAtom(resetPlanStateAtom);

  const [channels, setChannels] = useState<Channel[]>([]);
  const [agentDefaultModelRef, setAgentDefaultModelRef] = useState<string>("");
  const [sessionRootPath, setSessionRootPath] = useState<string | null>(null);
  const [sessionSwitching, setSessionSwitching] = useState(false);

  const currentWorkspace = useMemo(
    () => resolveAgentSessionWorkspace(workspaces, workspaceId, session?.workspaceId),
    [session?.workspaceId, workspaceId, workspaces]
  );

  useEffect(() => {
    void Promise.all([listChannels(), getEffectiveSystemConfig()])
      .then(([next, systemConfig]) => {
        setChannels(next);
        setAgentDefaultModelRef(systemConfig.models?.agent?.defaultModelRef ?? "");
      });
  }, []);

  useEffect(() => {
    if (channels.length === 0) return;

    const preferred = resolvePreferredAgentSelection({
      channels,
      thread: session,
      currentChannelId: agentChannelId,
      currentModelId: agentModelId,
      defaultModelRef: agentDefaultModelRef
    });

    if (preferred.channelId !== agentChannelId) {
      setAgentChannelId(preferred.channelId);
    }

    if (preferred.modelId !== agentModelId) {
      setAgentModelId(preferred.modelId);
    }
  }, [
    agentChannelId,
    agentModelId,
    channels,
    agentDefaultModelRef,
    session,
    setAgentChannelId,
    setAgentModelId
  ]);

  useEffect(() => {
    if (!sessionId) {
      setMessages([]);
      setSdkMessages([]);
      setLiveSdkMessagesMap(new Map());
      setMessageVersionsByGroup({});
      setSelectedVersionIndexByGroup({});
      setSessionRootPath(null);
      resetPlan();
      setSessionSwitching(false);
      return;
    }

    setSessionSwitching(true);
    setPendingFiles([]);
    setPendingFolderRefs([]);
    setInlineEditingMessageId(null);
    setMessageVersionsByGroup({});
    setSelectedVersionIndexByGroup({});
    setLiveSdkMessagesMap((prev) => {
      const map = new Map(prev);
      map.delete(sessionId);
      return map;
    });
    resetPlan();

    let cancelled = false;
    void getAgentThreadMessages(sessionId)
      .then(async (next) => {
        const sdkMessages = await getAgentThreadSDKMessages(sessionId);
        if (cancelled) return;
        startTransition(() => {
          setMessages(next);
          setSdkMessages(sdkMessages);
          setSessionSwitching(false);
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setMessages([]);
        setSdkMessages([]);
        setSessionSwitching(false);
        const message = error instanceof Error ? error.message : String(error);
        setStreamErrors((prev) => {
          const map = new Map(prev);
          map.set(sessionId, `读取线程消息失败: ${message}`);
          return map;
        });
      });

    return () => {
      cancelled = true;
    };
  }, [
    resetPlan,
    sessionId,
    setInlineEditingMessageId,
    setLiveSdkMessagesMap,
    setMessages,
    setSdkMessages,
    setPendingFiles,
    setPendingFolderRefs,
    setMessageVersionsByGroup,
    setStreamErrors,
    setSelectedVersionIndexByGroup
  ]);

  useEffect(() => {
    if (!sessionId) {
      setSessionRootPath(null);
      return;
    }
    if (!currentWorkspace) {
      setSessionRootPath(null);
      return;
    }
    void getAgentThreadPath(currentWorkspace.slug, sessionId)
      .then(setSessionRootPath)
      .catch(() => setSessionRootPath(null));
  }, [currentWorkspace, sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    void getAgentThreadRuntimeStatus(sessionId)
      .then((status: Awaited<ReturnType<typeof getAgentThreadRuntimeStatus>>) => {
        setRuntimeStatuses((prev) => {
          const map = new Map(prev);
          map.set(sessionId, status);
          return map;
        });
      })
      .catch(() => undefined);
  }, [sessionId, setRuntimeStatuses]);

  return {
    currentWorkspace,
    sessionRootPath,
    sessionSwitching
  };
}
