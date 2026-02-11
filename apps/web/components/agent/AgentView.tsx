"use client";

import { useEffect, useMemo, useState } from "react";
import { useAtom, useSetAtom } from "jotai";
import {
  agentWorkspacesAtom,
  agentSessionsAtom,
  agentStreamingStatesAtom,
  applyAgentEvent,
  currentAgentMessagesAtom,
  currentAgentSessionIdAtom,
  currentAgentWorkspaceIdAtom
} from "@/atoms";
import {
  listAgentSessions,
  listChannels,
  getAgentSessionPath,
  getAgentSessionMessages,
  onAgentStreamComplete,
  onAgentStreamError,
  onAgentStreamEvent,
  onAgentTitleUpdated,
  sendAgentMessage,
  stopAgentRun
} from "@/lib/desktop-api";
import { AgentHeader } from "./AgentHeader";
import { AgentInput } from "./AgentInput";
import { AgentMessages } from "./AgentMessages";
import { FileBrowser } from "@/components/file-browser";

export function AgentView(): React.ReactElement {
  const [sessionId] = useAtom(currentAgentSessionIdAtom);
  const [workspaceId] = useAtom(currentAgentWorkspaceIdAtom);
  const [workspaces] = useAtom(agentWorkspacesAtom);
  const [messages, setMessages] = useAtom(currentAgentMessagesAtom);
  const [streamingStates, setStreamingStates] = useAtom(agentStreamingStatesAtom);
  const setSessions = useSetAtom(agentSessionsAtom);

  const [channelId, setChannelId] = useState<string | null>(null);
  const [sessionRootPath, setSessionRootPath] = useState<string | null>(null);

  useEffect(() => {
    void listChannels().then((channels) => {
      const first = channels[0];
      if (!channelId && first) {
        setChannelId(first.id);
      }
    });
  }, [channelId]);

  useEffect(() => {
    if (!sessionId) {
      setMessages([]);
      setSessionRootPath(null);
      return;
    }

    void getAgentSessionMessages(sessionId).then(setMessages);
  }, [sessionId, setMessages]);

  useEffect(() => {
    if (!sessionId || !workspaceId) {
      setSessionRootPath(null);
      return;
    }
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (!workspace) {
      setSessionRootPath(null);
      return;
    }
    void getAgentSessionPath(workspace.slug, sessionId)
      .then(setSessionRootPath)
      .catch(() => setSessionRootPath(null));
  }, [sessionId, workspaceId, workspaces]);

  useEffect(() => {
    const unsubs: Array<() => void> = [];

    void onAgentStreamEvent((payload) => {
      setStreamingStates((prev) => {
        const map = new Map(prev);
        const current = map.get(payload.sessionId) ?? {
          running: true,
          content: "",
          toolActivities: []
        };
        map.set(payload.sessionId, applyAgentEvent(current, payload.event));
        return map;
      });
    }).then((fn) => unsubs.push(fn));

    void onAgentStreamComplete((payload) => {
      setStreamingStates((prev) => {
        const map = new Map(prev);
        map.delete(payload.sessionId);
        return map;
      });

      void getAgentSessionMessages(payload.sessionId).then((next) => {
        if (payload.sessionId === sessionId) {
          setMessages(next);
        }
      });

      void listAgentSessions().then(setSessions);
    }).then((fn) => unsubs.push(fn));

    void onAgentStreamError((payload) => {
      setStreamingStates((prev) => {
        const map = new Map(prev);
        map.delete(payload.sessionId);
        return map;
      });
      console.error("[AgentView] stream error", payload.error);
    }).then((fn) => unsubs.push(fn));

    void onAgentTitleUpdated(() => {
      void listAgentSessions().then(setSessions);
    }).then((fn) => unsubs.push(fn));

    return () => {
      for (const fn of unsubs) fn();
    };
  }, [sessionId, setMessages, setSessions, setStreamingStates]);

  const streamState = sessionId ? streamingStates.get(sessionId) : undefined;
  const canSend = useMemo(() => !!sessionId && !!channelId, [sessionId, channelId]);

  const handleSend = async (content: string): Promise<void> => {
    if (!sessionId || !channelId || !canSend) return;
    await sendAgentMessage({
      sessionId,
      userMessage: content,
      channelId,
      workspaceId: workspaceId ?? undefined
    });
  };

  if (!sessionId) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-3 p-5">
        <h2 className="text-2xl font-semibold">Agent</h2>
        <p className="text-sm text-muted-foreground">请选择或创建一个 Agent 会话。</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-5">
      <AgentHeader />
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-2.5 xl:grid-cols-[1fr_320px]">
        <AgentMessages messages={messages} streamState={streamState} />
        {sessionRootPath && workspaceId ? (
          (() => {
            const workspace = workspaces.find((item) => item.id === workspaceId);
            if (!workspace) return null;
            return (
              <FileBrowser
                workspaceSlug={workspace.slug}
                sessionId={sessionId}
                rootPath={sessionRootPath}
              />
            );
          })()
        ) : null}
      </div>
      <AgentInput
        disabled={!canSend}
        onRun={handleSend}
        onStop={() => {
          if (sessionId) {
            void stopAgentRun(sessionId);
          }
        }}
      />
    </div>
  );
}
