"use client";

import { startTransition, useEffect } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  AgentAskUserQuestionRequest,
  AgentMessage,
  AgentRuntimeStatus,
  AgentSendInput,
  AgentSessionMeta,
  AgentToolPermissionRequest,
  PlanStateChangedEvent
} from "@lume/shared";
import type { PlanState } from "@/atoms/plan-atoms";
import { applyAgentEvent } from "@/atoms";
import type { AgentStreamState, TeammateState } from "@/atoms/agent-atoms";
import type { AgentSidePanelTab } from "../AgentSidePanel";
import {
  generateAgentSessionTitle,
  getAgentSessionMessages,
  listAgentSessions,
  onAgentAskUserQuestion,
  onAgentMessageAppended,
  onAgentPlanStateChanged,
  onAgentRuntimeStatusChanged,
  onAgentStreamComplete,
  onAgentStreamError,
  onAgentStreamEvent,
  onAgentTitleUpdated,
  onAgentToolPermissionRequest,
  updateAgentSessionTitle
} from "@/lib/desktop-api/agent";
import { extractLatestAssistantText, parseExitPlanResult } from "../agent-session-lifecycle";
import { shouldAutoOpenTeamPanel } from "../agent-stream-subscriptions";

function isAgentDebugEnabled(): boolean {
  try {
    return window.localStorage.getItem("lume.debug.agent") === "1";
  } catch {
    return false;
  }
}

interface UseAgentStreamSubscriptionsParams {
  sessionId: string | null;
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
  setAskUserQuestionRequests: Dispatch<SetStateAction<Map<string, AgentAskUserQuestionRequest>>>;
  setRuntimeStatuses: Dispatch<SetStateAction<Map<string, AgentRuntimeStatus>>>;
  setSessions: Dispatch<SetStateAction<AgentSessionMeta[]>>;
  setPlanState: Dispatch<SetStateAction<PlanState>>;
  setStreamErrors: Dispatch<SetStateAction<Map<string, string>>>;
  setStreamingStates: Dispatch<SetStateAction<Map<string, AgentStreamState>>>;
  setToolPermissionRequests: Dispatch<SetStateAction<Map<string, AgentToolPermissionRequest>>>;
  setContextCache: Dispatch<SetStateAction<Map<string, {
    inputTokens?: number;
    totalTokens: number;
    contextWindow?: number;
  }>>>;
  setCachedTeammates: Dispatch<SetStateAction<Map<string, TeammateState[]>>>;
  setSidePanelOpenMap: Dispatch<SetStateAction<Map<string, boolean>>>;
  setSidePanelTabMap: Dispatch<SetStateAction<Map<string, AgentSidePanelTab>>>;
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
  sessionId,
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
  setAskUserQuestionRequests,
  setRuntimeStatuses,
  setSessions,
  setPlanState,
  setStreamErrors,
  setStreamingStates,
  setToolPermissionRequests,
  setContextCache,
  setCachedTeammates,
  setSidePanelOpenMap,
  setSidePanelTabMap,
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
    };

    const markStreamCompleted = (targetSessionId: string): void => {
      setStreamingStates((prev) => {
        const current = prev.get(targetSessionId);
        if (!current) return prev;
        const map = new Map(prev);
        map.set(targetSessionId, { ...current, running: false });
        return map;
      });
    };

    trackUnlisten(onAgentStreamEvent((payload) => {
      lastAgentEventAtRef.current.set(payload.sessionId, Date.now());
      if (isAgentDebugEnabled()) {
        console.info("[AgentDebug] stream:event", {
          sessionId: payload.sessionId,
          type: payload.event.type,
          event: payload.event
        });
      }

      if (payload.sessionId === currentSessionIdRef.current) {
        const event = payload.event;
        if (event.type === "tool_result" && !event.isError && event.toolName === "ExitPlanMode") {
          planStreamCaptureRef.current = false;
          const parsed = parseExitPlanResult(event.result);
          if (parsed.planPath || parsed.slug || parsed.metadata) {
            exitPlan({
              ...(parsed.planPath ? { planPath: parsed.planPath } : {}),
              ...(parsed.slug ? { slug: parsed.slug } : {}),
              ...(parsed.metadata ? { metadata: parsed.metadata } : {})
            });
          }
        } else if (event.type === "tool_start" && event.toolName === "EnterPlanMode") {
          planStreamCaptureRef.current = true;
        } else if ((event.type === "text_delta" || event.type === "text_complete") && !planStreamCaptureRef.current) {
          if (currentPermissionModeRef.current === "plan") {
            planStreamCaptureRef.current = true;
          }
        }
        if (event.type === "text_delta" && planStreamCaptureRef.current) {
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
          appendPlanDraft(event.text);
        } else if (event.type === "text_complete" && planStreamCaptureRef.current) {
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
          updatePlanDraft(event.text);
        }
      }

      setStreamingStates((prev) => {
        const map = new Map(prev);
        const current = map.get(payload.sessionId) ?? {
          running: true,
          content: "",
          toolActivities: [],
          teammates: [],
          events: []
        };
        map.set(payload.sessionId, applyAgentEvent(current, payload.event));
        return map;
      });

      const usageEvent = payload.event.type === "usage_update"
        ? payload.event.usage
        : payload.event.type === "complete"
          ? payload.event.usage
          : undefined;
      if (usageEvent) {
        setContextCache((prev) => {
          const map = new Map(prev);
          map.set(payload.sessionId, {
            inputTokens: usageEvent.inputTokens,
            totalTokens: usageEvent.totalTokens ?? prev.get(payload.sessionId)?.totalTokens ?? usageEvent.inputTokens,
            contextWindow: usageEvent.contextWindow ?? prev.get(payload.sessionId)?.contextWindow
          });
          return map;
        });
      }

      if (payload.sessionId === currentSessionIdRef.current && shouldAutoOpenTeamPanel(payload.event)) {
        setSidePanelOpenMap((prev) => {
          const map = new Map(prev);
          map.set(payload.sessionId, true);
          return map;
        });
        setSidePanelTabMap((prev) => {
          const map = new Map(prev);
          map.set(payload.sessionId, "team");
          return map;
        });
      }
    }));

    trackUnlisten(onAgentStreamComplete((payload) => {
      lastAgentEventAtRef.current.set(payload.sessionId, Date.now());
      if (isAgentDebugEnabled()) {
        console.info("[AgentDebug] stream:complete", { sessionId: payload.sessionId });
      }
      markStreamCompleted(payload.sessionId);
      const finalize = (): void => {
        const streamState = streamingStates.get(payload.sessionId);
        if (streamState?.teammates && streamState.teammates.length > 0) {
          setCachedTeammates((prev) => {
            const map = new Map(prev);
            map.set(payload.sessionId, streamState.teammates);
            return map;
          });
        }
        if (payload.sessionId === currentSessionIdRef.current) {
          setAskUserQuestionRequests((prev) => {
            const map = new Map(prev);
            map.delete(payload.sessionId);
            return map;
          });
          setToolPermissionRequests((prev) => {
            const map = new Map(prev);
            map.delete(payload.sessionId);
            return map;
          });
        }
        removeState(payload.sessionId);
        void listAgentSessions().then(setSessions);

        const titleInput = pendingTitleRef.current.get(payload.sessionId);
        pendingTitleRef.current.delete(payload.sessionId);
        if (titleInput) {
          void generateAgentSessionTitle(titleInput).then((title) => {
            const nextTitle = title?.trim() || titleInput.userMessage.trim().slice(0, 20);
            if (!nextTitle) return;
            void updateAgentSessionTitle(payload.sessionId, nextTitle)
              .then((updated) => {
                setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
              })
              .catch((err) => {
                console.error("[AgentView] 自动更新 Agent 标题失败:", err);
              });
          }).catch(() => {
            const fallback = titleInput.userMessage.trim().slice(0, 20);
            if (fallback) {
              void updateAgentSessionTitle(payload.sessionId, fallback)
                .then((updated) => {
                  setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
                })
                .catch(() => {});
            }
          });
        }
      };

      if (payload.sessionId === currentSessionIdRef.current) {
        void getAgentSessionMessages(payload.sessionId)
          .then((next) => {
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
              setMessages((prev) => {
                const nextIds = new Set(next.map((m) => m.id));
                const filteredPrev = prev.filter((m) => !m.id.startsWith("temp-"));
                return [...filteredPrev.filter((m) => !nextIds.has(m.id)), ...next];
              });
              finalize();
            });
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            setStreamErrors((prev) => {
              const map = new Map(prev);
              map.set(payload.sessionId, `流结束后读取消息失败: ${message}`);
              return map;
            });
            finalize();
          });
      } else {
        finalize();
      }
    }));

    trackUnlisten(onAgentStreamError((payload) => {
      lastAgentEventAtRef.current.set(payload.sessionId, Date.now());
      if (isAgentDebugEnabled()) {
        console.info("[AgentDebug] stream:error", payload);
      }
      setStreamErrors((prev) => {
        const map = new Map(prev);
        map.set(payload.sessionId, payload.error);
        return map;
      });
      const finalize = (): void => {
        if (payload.sessionId === currentSessionIdRef.current) {
          setAskUserQuestionRequests((prev) => {
            const map = new Map(prev);
            map.delete(payload.sessionId);
            return map;
          });
          setToolPermissionRequests((prev) => {
            const map = new Map(prev);
            map.delete(payload.sessionId);
            return map;
          });
        }
        removeState(payload.sessionId);
      };

      if (payload.sessionId === currentSessionIdRef.current) {
        void getAgentSessionMessages(payload.sessionId)
          .then((next) => {
            startTransition(() => {
              setMessages(next);
              finalize();
            });
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            setStreamErrors((prev) => {
              const map = new Map(prev);
              map.set(payload.sessionId, `流错误后读取消息失败: ${message}`);
              return map;
            });
            finalize();
          });
      } else {
        finalize();
      }
    }));

    trackUnlisten(onAgentMessageAppended((payload) => {
      void listAgentSessions().then(setSessions);
      if (payload.sessionId !== currentSessionIdRef.current) {
        return;
      }
      startTransition(() => {
        setMessages((prev) => {
          if (prev.some((item) => item.id === payload.message.id)) {
            return prev;
          }
          return [...prev, payload.message];
        });
      });
    }));

    trackUnlisten(onAgentRuntimeStatusChanged((payload) => {
      setRuntimeStatuses((prev) => {
        const map = new Map(prev);
        map.set(payload.status.sessionId, payload.status);
        return map;
      });
    }));

    trackUnlisten(onAgentTitleUpdated((payload) => {
      setSessions((prev) => prev.map((item) => (
        item.id === payload.sessionId
          ? { ...item, title: payload.title, updatedAt: Date.now() }
          : item
      )));
      void listAgentSessions().then(setSessions).catch((error) => {
        console.warn("[AgentView] 刷新会话标题失败", error);
      });
    }));

    trackUnlisten(onAgentPlanStateChanged((payload) => {
      if (payload.sessionId !== currentSessionIdRef.current) return;
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
      if (payload.sessionId !== currentSessionIdRef.current) {
        return;
      }
      setAskUserError(null);
      setAskUserQuestionRequests((prev) => {
        const map = new Map(prev);
        map.set(payload.sessionId, payload);
        return map;
      });
    }));

    trackUnlisten(onAgentToolPermissionRequest((payload) => {
      if (payload.sessionId !== currentSessionIdRef.current) {
        return;
      }
      setToolPermissionError(null);
      setToolPermissionRequests((prev) => {
        const map = new Map(prev);
        map.set(payload.sessionId, payload);
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
    setCachedTeammates,
    setContextCache,
    setMessages,
    setPlanState,
    setRuntimeStatuses,
    setSessions,
    setSidePanelOpenMap,
    setSidePanelTabMap,
    setStreamErrors,
    setStreamingStates,
    setToolPermissionError,
    setToolPermissionRequests,
    showModeNotice,
    streamingStates,
    updatePlanDraft
  ]);
}
