import { startTransition, useEffect } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { AgentMessage } from "@lume/shared";
import type { AgentStreamState, ToolActivity } from "@/atoms/agent-atoms";
import { getAgentThreadMessages } from "@/lib/desktop-api/agent";
import { mergeServerMessagesWithPending } from "@/lib/agent-message-merge";
import { resolveAgentWatchdogIdleTimeoutMs } from "../agent-runtime-guard";

function isAgentDebugEnabled(): boolean {
  try {
    return window.localStorage.getItem("lume.debug.agent") === "1";
  } catch {
    return false;
  }
}

interface UseAgentRuntimeGuardParams {
  threadId: string | null;
  isAgentBusy: boolean;
  isAwaitingInteractiveInput: boolean;
  toolActivities: ToolActivity[];
  lastAgentEventAtRef: MutableRefObject<Map<string, number>>;
  setMessages: Dispatch<SetStateAction<AgentMessage[]>>;
  setStreamErrors: Dispatch<SetStateAction<Map<string, string>>>;
  setStreamingStates: Dispatch<SetStateAction<Map<string, AgentStreamState>>>;
}

export function useAgentRuntimeGuard({
  threadId,
  isAgentBusy,
  isAwaitingInteractiveInput,
  toolActivities,
  lastAgentEventAtRef,
  setMessages,
  setStreamErrors,
  setStreamingStates
}: UseAgentRuntimeGuardParams): void {
  useEffect(() => {
    if (!threadId || !isAgentBusy) return;

    let disposed = false;
    let pending = false;
    const streamStartedAt = Date.now();

    const timer = setInterval(() => {
      if (disposed || pending) return;
      const lastEventAt = lastAgentEventAtRef.current.get(threadId) ?? 0;
      const lastActiveAt = lastEventAt > 0 ? lastEventAt : streamStartedAt;
      const activeTools = toolActivities.filter((item) => !item.done);
      const idleTimeoutMs = resolveAgentWatchdogIdleTimeoutMs(activeTools);

      if (!isAwaitingInteractiveInput && Date.now() - lastActiveAt > idleTimeoutMs) {
        setStreamErrors((prev) => {
          const map = new Map(prev);
          map.set(threadId, "Agent 长时间无响应，已自动停止本次生成，请重试。");
          return map;
        });
        setStreamingStates((prev) => {
          if (!prev.has(threadId)) return prev;
          const map = new Map(prev);
          map.delete(threadId);
          return map;
        });
        return;
      }

      if (Date.now() - lastEventAt < 6000) return;
      pending = true;

      void getAgentThreadMessages(threadId)
        .then((next) => {
          if (disposed) return;
          startTransition(() => {
            setMessages((prev) => {
              const merged = mergeServerMessagesWithPending(prev, next);
              if (prev.length === merged.length) {
                const same = prev.every((item, index) => item.id === merged[index]?.id && item.content === merged[index]?.content);
                return same ? prev : merged;
              }
              return merged;
            });
          });

          if (isAgentDebugEnabled()) {
            console.info("[AgentDebug] watchdog pull applied", {
              threadId,
              count: next.length
            });
          }
        })
        .catch((error) => {
          if (isAgentDebugEnabled()) {
            console.warn("[AgentDebug] watchdog fetch messages failed", error);
          }
          const message = error instanceof Error ? error.message : String(error);
          setStreamErrors((prev) => {
            const map = new Map(prev);
            map.set(threadId, `轮询读取消息失败: ${message}`);
            return map;
          });
        })
        .finally(() => {
          pending = false;
        });
    }, 1500);

    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [
    isAgentBusy,
    isAwaitingInteractiveInput,
    lastAgentEventAtRef,
    threadId,
    setMessages,
    setStreamErrors,
    setStreamingStates,
    toolActivities
  ]);
}

