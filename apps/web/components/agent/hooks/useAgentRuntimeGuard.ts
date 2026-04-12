import { startTransition, useEffect } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { AgentMessage, AgentRuntimeStatus } from "@lume/shared";
import type { AgentStreamState, ToolActivity } from "@/atoms/agent-atoms";
import { getAgentThreadMessages, getAgentThreadRuntimeStatus } from "@/lib/desktop-api/agent";
import { mergeServerMessagesWithPending } from "@/lib/agent-message-merge";
import { isAgentRuntimeStatusActive } from "@/lib/agent-runtime-status";
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
  setRuntimeStatuses: Dispatch<SetStateAction<Map<string, AgentRuntimeStatus>>>;
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
  setRuntimeStatuses,
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
        pending = true;
        void getAgentThreadRuntimeStatus(threadId)
          .then((status) => {
            if (disposed) return;
            setRuntimeStatuses((prev) => {
              const map = new Map(prev);
              map.set(threadId, status);
              return map;
            });
            if (isAgentRuntimeStatusActive(status)) {
              lastAgentEventAtRef.current.set(threadId, Date.now());
              return;
            }
            setStreamErrors((prev) => {
              const map = new Map(prev);
              map.set(threadId, "Agent 长时间无响应，已自动停止本次生成，请重试。");
              return map;
            });
            setStreamingStates((prev) => {
              const current = prev.get(threadId);
              if (!current) return prev;
              const map = new Map(prev);
              map.set(threadId, { ...current, running: false });
              return map;
            });
          })
          .catch(() => {
            if (disposed) return;
            setStreamErrors((prev) => {
              const map = new Map(prev);
              map.set(threadId, "Agent 长时间无响应，已自动停止本次生成，请重试。");
              return map;
            });
            setStreamingStates((prev) => {
              const current = prev.get(threadId);
              if (!current) return prev;
              const map = new Map(prev);
              map.set(threadId, { ...current, running: false });
              return map;
            });
          })
          .finally(() => {
            pending = false;
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
          lastAgentEventAtRef.current.set(threadId, Date.now());
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
    setRuntimeStatuses,
    threadId,
    setMessages,
    setStreamErrors,
    setStreamingStates,
    toolActivities
  ]);
}

