"use client";

import { Loader2, Sparkles } from "lucide-react";
import type { AgentModeRecommendation } from "./agent-mode-recommendation";
import { useMigrateChatToAgent } from "./use-migrate-chat-to-agent";

export function AgentModeRecommendationBanner({
  recommendation
}: {
  recommendation: AgentModeRecommendation;
}): React.ReactElement {
  const { busy, error, migrate } = useMigrateChatToAgent();

  const handleCreateAgentSession = async (): Promise<void> => {
    await migrate({ suggestedPrompt: recommendation.suggestedPrompt });
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
            <span>切换到 Agent 模式执行</span>
          </button>
          {error ? <p className="mt-1 text-[11px] text-destructive">{error}</p> : null}
        </div>
      </div>
    </div>
  );
}
