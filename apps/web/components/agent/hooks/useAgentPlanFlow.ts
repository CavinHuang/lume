import { useCallback, useEffect, useRef, useState } from "react";
import { useAtom, useSetAtom } from "jotai";
import type { AgentSendInput } from "@lume/shared";
import {
  appendPlanDraftAtom,
  applyPlanStateChangedAtom,
  enterPlanModeAtom,
  exitPlanModeAtom,
  planStateAtom,
  updatePlanDraftAtom
} from "@/atoms/plan-atoms";

export function useAgentPlanFlow(
  sessionId: string | null,
  agentPermissionMode: NonNullable<AgentSendInput["permissionMode"]>
){
  const [modeNotice, setModeNotice] = useState<string | null>(null);
  const [planState, setPlanState] = useAtom(planStateAtom);
  const enterPlan = useSetAtom(enterPlanModeAtom);
  const appendPlanDraft = useSetAtom(appendPlanDraftAtom);
  const updatePlanDraft = useSetAtom(updatePlanDraftAtom);
  const exitPlan = useSetAtom(exitPlanModeAtom);
  const applyPlanStateChanged = useSetAtom(applyPlanStateChangedAtom);

  const planStreamCaptureRef = useRef(false);
  const currentSessionIdRef = useRef<string | null>(sessionId);
  const lastNonPlanPermissionModeRef = useRef(agentPermissionMode);
  const currentPermissionModeRef = useRef(agentPermissionMode);
  const modeNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    currentSessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    if (agentPermissionMode !== "plan") {
      lastNonPlanPermissionModeRef.current = agentPermissionMode;
    }
    currentPermissionModeRef.current = agentPermissionMode;
  }, [agentPermissionMode]);

  const showModeNotice = useCallback((text: string): void => {
    setModeNotice(text);
    if (modeNoticeTimerRef.current) {
      clearTimeout(modeNoticeTimerRef.current);
    }
    modeNoticeTimerRef.current = setTimeout(() => {
      setModeNotice(null);
      modeNoticeTimerRef.current = null;
    }, 2600);
  }, []);

  useEffect(() => () => {
    if (modeNoticeTimerRef.current) {
      clearTimeout(modeNoticeTimerRef.current);
    }
  }, []);

  return {
    modeNotice,
    setPlanState,
    planSessionActive: planState.sessionActive,
    enterPlan,
    appendPlanDraft,
    updatePlanDraft,
    exitPlan,
    applyPlanStateChanged,
    planStreamCaptureRef,
    currentSessionIdRef,
    lastNonPlanPermissionModeRef,
    currentPermissionModeRef,
    showModeNotice
  };
}
