import { startTransition, useEffect, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  AgentAskUserQuestionRequest,
  AgentMessage,
  AgentRuntimeStatus,
  AgentSendInput,
  AgentThreadMeta,
  AgentToolPermissionRequest,
  PlanStateChangedEvent
} from "@lume/shared";
import type { PlanState } from "@/atoms/plan-atoms";
import type { AgentStreamState } from "@/atoms/agent-atoms";
import { enrichAssistantMessages } from "@/lib/agent-display-message";
import { applySdkMessage } from "@/lib/agent-streaming";
import {
  generateAgentThreadTitle,
  getAgentThreadSDKMessages,
  getAgentThreadMessages,
  listAgentThreads,
  onAgentAskUserQuestion,
  onAgentMessageAppended,
  onAgentPlanStateChanged,
  onAgentRuntimeStatusChanged,
  onAgentStreamError,
  onAgentStreamEvent,
  onAgentTitleUpdated,
  onAgentToolPermissionRequest,
  updateAgentThreadTitle
} from "@/lib/desktop-api/agent";
import { mergeServerMessagesWithPending, replaceVisibleMessage } from "@/lib/agent-message-merge";
import { extractLatestAssistantText } from "../agent-session-lifecycle";

function isAgentDebugEnabled(): boolean {
  try {
    return window.localStorage.getItem("lume.debug.agent") === "1";
  } catch {
    return false;
  }
}

interface UseAgentStreamSubscriptionsParams {
  threadId: string | null;
  agentPermissionMode: NonNullable<AgentSendInput["permissionMode"]>;
  planSessionActive: boolean;
  streamingStates: Map<string, AgentStreamState>;
  currentSessionIdRef: MutableRefObject<string | null>;
  lastNonPlanPermissionModeRef: MutableRefObject<NonNullable<AgentSendInput["permissionMode"]>>;
  currentPermissionModeRef: MutableRefObject<NonNullable<AgentSendInput["permissionMode"]>>;
  lastAgentEventAtRef: MutableRefObject<Map<string, number>>;
  pendingTitleRef: MutableRefObject<Map<string, { userMessage: string; channelId: string; modelId: string }>>;
  planStreamCaptureRef: MutableRefObject<boolean>;
  setMessages: Dispatch<SetStateAction<AgentMessage[]>>;
  setSdkMessages: Dispatch<SetStateAction<import("@lume/shared").SDKMessage[]>>;
  setLiveSdkMessagesMap: Dispatch<SetStateAction<Map<string, import("@lume/shared").SDKMessage[]>>>;
  setAskUserQuestionRequests: Dispatch<SetStateAction<Map<string, AgentAskUserQuestionRequest>>>;
  setRuntimeStatuses: Dispatch<SetStateAction<Map<string, AgentRuntimeStatus>>>;
  setSessions: Dispatch<SetStateAction<AgentThreadMeta[]>>;
  setPlanState: Dispatch<SetStateAction<PlanState>>;
  setStreamErrors: Dispatch<SetStateAction<Map<string, string>>>;
  setStreamingStates: Dispatch<SetStateAction<Map<string, AgentStreamState>>>;
  setToolPermissionRequests: Dispatch<SetStateAction<Map<string, AgentToolPermissionRequest>>>;
  setContextCache: Dispatch<SetStateAction<Map<string, {
    inputTokens?: number;
    totalTokens: number;
    contextWindow?: number;
  }>>>;
  setAgentPermissionMode: Dispatch<SetStateAction<NonNullable<AgentSendInput["permissionMode"]>>>;
  setAskUserError: Dispatch<SetStateAction<string | null>>;
  setToolPermissionError: Dispatch<SetStateAction<string | null>>;
  appendPlanDraft: (value: string) => void;
  updatePlanDraft: (value: string) => void;
  enterPlan: () => void;
  exitPlan: (input?: {
    planPath?: string;
    slug?: string;
    metadata?: {
      summary?: string;
      estimatedFiles?: number;
      estimatedLines?: number;
    };
  }) => void;
  applyPlanStateChanged: (payload: PlanStateChangedEvent) => void;
  showModeNotice: (text: string) => void;
}

export function useAgentStreamSubscriptions({
  threadId,
  agentPermissionMode,
  planSessionActive,
  streamingStates,
  currentSessionIdRef,
  lastNonPlanPermissionModeRef,
  currentPermissionModeRef,
  lastAgentEventAtRef,
  pendingTitleRef,
  planStreamCaptureRef,
  setMessages,
  setSdkMessages,
  setLiveSdkMessagesMap,
  setAskUserQuestionRequests,
  setRuntimeStatuses,
  setSessions,
  setPlanState,
  setStreamErrors,
  setStreamingStates,
  setToolPermissionRequests,
  setContextCache,
  setAgentPermissionMode,
  setAskUserError,
  setToolPermissionError,
  appendPlanDraft,
  updatePlanDraft,
  enterPlan,
  exitPlan,
  applyPlanStateChanged,
  showModeNotice
}: UseAgentStreamSubscriptionsParams): void {
  // 用 ref 持有 streamingStates 的最新值，避免将其放入 useEffect deps
  // 否则每次 streaming state 更新都会导致 effect 重新执行（注销+重新注册所有监听器）
  const streamingStatesRef = useRef(streamingStates);
  streamingStatesRef.current = streamingStates;

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    let disposed = false;
    if (isAgentDebugEnabled()) {
      console.info("[AgentDebug] subscribe stream listeners");
    }

    const trackUnlisten = (promise: Promise<() => void>): void => {
      void promise.then((fn) => {
        if (disposed) {
          void fn();
          return;
        }
        unsubs.push(fn);
      }).catch((error) => {
        console.error("[AgentView] subscribe stream failed:", error);
        if (isAgentDebugEnabled()) {
          console.error("[AgentDebug] subscribe failed", error);
        }
      });
    };

    const removeState = (targetSessionId: string): void => {
      lastAgentEventAtRef.current.delete(targetSessionId);
      setStreamingStates((prev) => {
        const map = new Map(prev);
        map.delete(targetSessionId);
        return map;
      });
      setLiveSdkMessagesMap((prev) => {
        if (!prev.has(targetSessionId)) return prev;
        const map = new Map(prev);
        map.delete(targetSessionId);
        return map;
      });
    };

    const finalizeCompleted = (targetThreadId: string): void => {
      const finalize = (): void => {
        if (targetThreadId === currentSessionIdRef.current) {
          setAskUserQuestionRequests((prev) => {
            const map = new Map(prev);
            map.delete(targetThreadId);
            return map;
          });
          setToolPermissionRequests((prev) => {
            const map = new Map(prev);
            map.delete(targetThreadId);
            return map;
          });
        }
        removeState(targetThreadId);
        void listAgentThreads().then(setSessions);

        const titleInput = pendingTitleRef.current.get(targetThreadId);
        pendingTitleRef.current.delete(targetThreadId);
        if (titleInput) {
          void generateAgentThreadTitle(titleInput).then((title) => {
            const nextTitle = title?.trim() || titleInput.userMessage.trim().slice(0, 20);
            if (!nextTitle) return;
            void updateAgentThreadTitle(targetThreadId, nextTitle)
              .then((updated) => {
                setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
              })
              .catch((err) => {
                console.error("[AgentView] 自动更新 Agent 标题失败:", err);
              });
          }).catch(() => {
            const fallback = titleInput.userMessage.trim().slice(0, 20);
            if (fallback) {
              void updateAgentThreadTitle(targetThreadId, fallback)
                .then((updated) => {
                  setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
                })
                .catch(() => {});
            }
          });
        }
      };

      const streamStateForDuration = streamingStatesRef.current.get(targetThreadId);
      let thinkingDuration: number | undefined;
      if (streamStateForDuration?.streamStartedAt && streamStateForDuration.firstOutputAt) {
        const sec = (streamStateForDuration.firstOutputAt - streamStateForDuration.streamStartedAt) / 1000;
        if (sec >= 1) {
          thinkingDuration = Math.ceil(sec);
        }
      }

      if (targetThreadId === currentSessionIdRef.current) {
        void Promise.all([
          getAgentThreadMessages(targetThreadId),
          getAgentThreadSDKMessages(targetThreadId)
        ])
          .then(([next, sdkMessages]) => {
            startTransition(() => {
              if (planStreamCaptureRef.current) {
                const fallbackText = extractLatestAssistantText(next);
                if (fallbackText) {
                  setPlanState((prev) => (
                    prev.draft.content.trim().length > 0
                      ? prev
                      : {
                        ...prev,
                        draft: {
                          content: fallbackText,
                          updatedAt: Date.now()
                        }
                      }
                  ));
                }
              }
              const latestAssistantId = [...next].reverse().find((message) => message.role === "assistant")?.id;
              const enriched = enrichAssistantMessages({
                messages: next,
                thinkingDuration,
                toolActivities: streamStateForDuration?.toolActivities,
                targetMessageId: latestAssistantId
              });
              setMessages((prev) => mergeServerMessagesWithPending(prev, enriched));
              setSdkMessages(sdkMessages);
              finalize();
            });
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            startTransition(() => {
              setStreamErrors((prev) => {
                const map = new Map(prev);
                map.set(targetThreadId, `流结束后读取消息失败: ${message}`);
                return map;
              });
              finalize();
            });
          });
        return;
      }

      finalize();
    };

    trackUnlisten(onAgentStreamEvent((payload) => {
      lastAgentEventAtRef.current.set(payload.threadId, Date.now());
      if (isAgentDebugEnabled()) {
        console.info("[AgentDebug] stream:event", {
          threadId: payload.threadId,
          type: payload.message.type,
          message: payload.message
        });
      }

      if (payload.threadId === currentSessionIdRef.current) {
        const streamEvent = payload.message.type === "stream_event"
          ? payload.message.event as { type?: string; delta?: { type?: string; text?: string } }
          : null;
        if (streamEvent?.type === "content_block_delta" && streamEvent.delta?.type === "text_delta") {
          if (!planStreamCaptureRef.current && currentPermissionModeRef.current === "plan") {
            planStreamCaptureRef.current = true;
          }
          if (planStreamCaptureRef.current && typeof streamEvent.delta.text === "string") {
            setPlanState((prev) => (
              prev.phase === "planning" && prev.sessionActive
                ? prev
                : {
                  ...prev,
                  phase: "planning",
                  sessionActive: true,
                  reviewOpen: false
                }
            ));
            appendPlanDraft(streamEvent.delta.text);
          }
        } else if (payload.message.type === "assistant" && planStreamCaptureRef.current) {
          const finalText = (payload.message.message?.content ?? [])
            .filter((block) => !!block && typeof block === "object" && (block as { type?: string }).type === "text")
            .map((block) => (block as { text?: string }).text ?? "")
            .join("");
          if (finalText) {
            setPlanState((prev) => (
              prev.phase === "planning" && prev.sessionActive
                ? prev
                : {
                  ...prev,
                  phase: "planning",
                  sessionActive: true,
                  reviewOpen: false
                }
            ));
            updatePlanDraft(finalText);
          }
        }
      }

      setStreamingStates((prev) => {
        const map = new Map(prev);
        const current = map.get(payload.threadId) ?? {
          running: true,
          sdkMessages: [],
          content: "",
          toolActivities: [],
        };
        map.set(payload.threadId, applySdkMessage(current, payload.message));
        return map;
      });
      const isReplay = ((payload.message as unknown) as Record<string, unknown>).isReplay === true;
      if (!isReplay) {
        setLiveSdkMessagesMap((prev) => {
          const map = new Map(prev);
          const current = map.get(payload.threadId) ?? [];
          map.set(payload.threadId, [...current, payload.message]);
          return map;
        });
      }

      if (payload.message.type === "result" && payload.message.usage) {
        const usage = payload.message.usage;
        const modelUsage = payload.message.modelUsage;
        setContextCache((prev) => {
          const map = new Map(prev);
          map.set(payload.threadId, {
            inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
            totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
            contextWindow: modelUsage ? Object.values(modelUsage)[0]?.contextWindow : prev.get(payload.threadId)?.contextWindow
          });
          return map;
        });
      }

    }));

    trackUnlisten(onAgentMessageAppended((payload) => {
      lastAgentEventAtRef.current.set(payload.threadId, Date.now());
      if (payload.threadId !== currentSessionIdRef.current) {
        void listAgentThreads().then(setSessions);
        return;
      }
      startTransition(() => {
        setMessages((prev) => replaceVisibleMessage(prev, payload.message));
        if (Array.isArray(payload.message.sdkMessages) && payload.message.sdkMessages.length > 0) {
          setSdkMessages((prev) => [...prev, ...payload.message.sdkMessages!]);
        }
      });
      void listAgentThreads().then(setSessions);
    }));

    trackUnlisten(onAgentStreamError((payload) => {
      lastAgentEventAtRef.current.set(payload.threadId, Date.now());
      if (isAgentDebugEnabled()) {
        console.info("[AgentDebug] stream:error", payload);
      }
      setStreamErrors((prev) => {
        const map = new Map(prev);
        map.set(payload.threadId, payload.error);
        return map;
      });
      const finalize = (): void => {
        if (payload.threadId === currentSessionIdRef.current) {
          setAskUserQuestionRequests((prev) => {
            const map = new Map(prev);
            map.delete(payload.threadId);
            return map;
          });
          setToolPermissionRequests((prev) => {
            const map = new Map(prev);
            map.delete(payload.threadId);
            return map;
          });
        }
        removeState(payload.threadId);
      };

      if (payload.threadId === currentSessionIdRef.current) {
        void Promise.all([
          getAgentThreadMessages(payload.threadId),
          getAgentThreadSDKMessages(payload.threadId)
        ])
          .then(([next, sdkMessages]) => {
            startTransition(() => {
              setMessages((prev) => mergeServerMessagesWithPending(prev, next));
              setSdkMessages(sdkMessages);
              finalize();
            });
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            // catch 路径也需要在 transition 内一起清除，避免抖动
            startTransition(() => {
              setStreamErrors((prev) => {
                const map = new Map(prev);
                map.set(payload.threadId, `流错误后读取消息失败: ${message}`);
                return map;
              });
              finalize();
            });
          });
      } else {
        finalize();
      }
    }));

    trackUnlisten(onAgentRuntimeStatusChanged((payload) => {
      setRuntimeStatuses((prev) => {
        const map = new Map(prev);
        map.set(payload.status.threadId, payload.status);
        return map;
      });
      if (payload.status.phase === "completed" && streamingStatesRef.current.has(payload.status.threadId)) {
        lastAgentEventAtRef.current.set(payload.status.threadId, Date.now());
        if (isAgentDebugEnabled()) {
          console.info("[AgentDebug] runtime:completed", { threadId: payload.status.threadId });
        }
        finalizeCompleted(payload.status.threadId);
      }
    }));

    trackUnlisten(onAgentTitleUpdated((payload) => {
      setSessions((prev) => prev.map((item) => (
        item.id === payload.threadId
          ? { ...item, title: payload.title, updatedAt: Date.now() }
          : item
      )));
      void listAgentThreads().then(setSessions).catch((error) => {
        console.warn("[AgentView] 刷新线程标题失败", error);
      });
    }));

    trackUnlisten(onAgentPlanStateChanged((payload) => {
      if (payload.threadId !== currentSessionIdRef.current) return;
      if (payload.phase === "planning") {
        planStreamCaptureRef.current = true;
        enterPlan();
        setAgentPermissionMode("plan");
        applyPlanStateChanged(payload);
        showModeNotice("已进入 Plan Mode");
        return;
      }
      if (payload.phase === "review") {
        planStreamCaptureRef.current = false;
        const parsedPath = typeof payload.planPath === "string" ? payload.planPath : null;
        const fromPlanningStage = agentPermissionMode === "plan" || planSessionActive;
        if (fromPlanningStage) {
          exitPlan(parsedPath ? { planPath: parsedPath } : undefined);
        } else {
          applyPlanStateChanged(payload);
        }
        if (fromPlanningStage) {
          const fallbackMode = lastNonPlanPermissionModeRef.current === "plan"
            ? "default"
            : lastNonPlanPermissionModeRef.current;
          setAgentPermissionMode(fallbackMode);
          showModeNotice("计划已完成，进入执行阶段");
        } else {
          showModeNotice("计划执行已暂停，已回到待确认阶段。");
        }
        return;
      }
      if (payload.phase === "executing" || payload.phase === "executed") {
        if (payload.phase === "executed") {
          planStreamCaptureRef.current = false;
        }
        applyPlanStateChanged(payload);
      }
    }));

    trackUnlisten(onAgentAskUserQuestion((payload) => {
      if (payload.threadId !== currentSessionIdRef.current) {
        return;
      }
      setAskUserError(null);
      setAskUserQuestionRequests((prev) => {
        const map = new Map(prev);
        map.set(payload.threadId, payload);
        return map;
      });
    }));

    trackUnlisten(onAgentToolPermissionRequest((payload) => {
      if (payload.threadId !== currentSessionIdRef.current) {
        return;
      }
      setToolPermissionError(null);
      setToolPermissionRequests((prev) => {
        const map = new Map(prev);
        map.set(payload.threadId, payload);
        return map;
      });
    }));

    return () => {
      disposed = true;
      for (const fn of unsubs) fn();
    };
  }, [
    agentPermissionMode,
    appendPlanDraft,
    applyPlanStateChanged,
    currentPermissionModeRef,
    currentSessionIdRef,
    enterPlan,
    exitPlan,
    lastAgentEventAtRef,
    lastNonPlanPermissionModeRef,
    pendingTitleRef,
    planSessionActive,
    planStreamCaptureRef,
    setAgentPermissionMode,
    setAskUserError,
    setAskUserQuestionRequests,
    setContextCache,
    setMessages,
    setPlanState,
    setRuntimeStatuses,
    setSessions,
    setStreamErrors,
    setStreamingStates,
    setToolPermissionError,
    setToolPermissionRequests,
    showModeNotice,
    updatePlanDraft
  ]);
}
