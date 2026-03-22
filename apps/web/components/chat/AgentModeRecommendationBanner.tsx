"use client";

import { useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { Loader2, Sparkles } from "lucide-react";
import type { ChatToolActivity } from "@lume/shared";
import {
  activeViewAtom,
  agentChannelIdAtom,
  agentPendingPromptAtom,
  agentSessionsAtom,
  appModeAtom,
  currentAgentSessionIdAtom,
  currentAgentWorkspaceIdAtom,
  settingsTabAtom
} from "@/atoms";
import { createAgentSession, listAgentSessions } from "@/lib/desktop-api";

export interface AgentModeRecommendation {
  reason: string;
  suggestedPrompt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function extractAgentModeRecommendation(
  activities?: ChatToolActivity[]
): AgentModeRecommendation | null {
  if (!activities || activities.length === 0) return null;
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.type !== "result") continue;
    if (activity.toolName !== "suggest_agent_mode" || activity.isError || !activity.result) continue;

    try {
      const parsed = JSON.parse(activity.result) as unknown;
      if (!isRecord(parsed) || parsed.type !== "agent_recommendation") continue;
      const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
      const suggestedPrompt = typeof parsed.suggestedPrompt === "string" ? parsed.suggestedPrompt.trim() : "";
      if (!reason || !suggestedPrompt) continue;
      return { reason, suggestedPrompt };
    } catch {
      continue;
    }
  }
  return null;
}

export function AgentModeRecommendationBanner({
  recommendation
}: {
  recommendation: AgentModeRecommendation;
}): React.ReactElement {
  const agentChannelId = useAtomValue(agentChannelIdAtom);
  const workspaceId = useAtomValue(currentAgentWorkspaceIdAtom);
  const setAgentSessions = useSetAtom(agentSessionsAtom);
  const setCurrentSessionId = useSetAtom(currentAgentSessionIdAtom);
  const setPendingPrompt = useSetAtom(agentPendingPromptAtom);
  const setAppMode = useSetAtom(appModeAtom);
  const setActiveView = useSetAtom(activeViewAtom);
  const setSettingsTab = useSetAtom(settingsTabAtom);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreateAgentSession = async (): Promise<void> => {
    if (busy) return;
    setError(null);

    if (!agentChannelId) {
      setAppMode("agent");
      setActiveView("settings");
      setSettingsTab("agent");
      setError("未设置 Agent 渠道，已跳转到配置页。");
      return;
    }

    setBusy(true);
    try {
      const session = await createAgentSession({
        channelId: agentChannelId,
        workspaceId: workspaceId ?? undefined
      });
      const sessions = await listAgentSessions();
      setAgentSessions(sessions);
      setCurrentSessionId(session.id);
      setPendingPrompt({ sessionId: session.id, message: recommendation.suggestedPrompt });
      setAppMode("agent");
      setActiveView("conversations");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(`创建 Agent 会话失败：${message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-2 rounded-lg border border-amber-200/80 bg-amber-50/60 p-3">
      <div className="flex items-start gap-2">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-amber-600" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-amber-900">推荐切换到 Agent 模式</div>
          <p className="mt-1 whitespace-pre-wrap text-xs text-amber-900/90">{recommendation.reason}</p>
          <button
            type="button"
            onClick={() => { void handleCreateAgentSession(); }}
            disabled={busy}
            className="mt-2 inline-flex items-center gap-1 rounded-md border border-amber-300/90 bg-white px-2 py-1 text-xs text-amber-900 transition-colors hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
            <span>{agentChannelId ? "切换到 Agent 模式执行" : "去设置 Agent 渠道"}</span>
          </button>
          {error ? <p className="mt-1 text-[11px] text-destructive">{error}</p> : null}
        </div>
      </div>
    </div>
  );
}
