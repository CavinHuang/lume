import { useCallback, useEffect, useState } from "react";
import type {
  AgentAskUserQuestionRequest,
  AgentRuntimeStatus,
  AgentToolPermissionDecision,
  AgentToolPermissionRequest
} from "@lume/shared";
import {
  submitAgentAskUserQuestionAnswers,
  submitAgentToolPermission
} from "@/lib/desktop-api/agent";
import { buildAskUserQuestionAnswers } from "../agent-interactive-requests";

interface UseAgentInteractiveRequestsParams {
  sessionId: string | null;
  currentRuntimeStatus: AgentRuntimeStatus | null;
  askUserQuestionRequest: AgentAskUserQuestionRequest | null;
  toolPermissionRequest: AgentToolPermissionRequest | null;
  setAskUserQuestionRequests: React.Dispatch<React.SetStateAction<Map<string, AgentAskUserQuestionRequest>>>;
  setToolPermissionRequests: React.Dispatch<React.SetStateAction<Map<string, AgentToolPermissionRequest>>>;
}

export function useAgentInteractiveRequests({
  sessionId,
  currentRuntimeStatus,
  askUserQuestionRequest,
  toolPermissionRequest,
  setAskUserQuestionRequests,
  setToolPermissionRequests
}: UseAgentInteractiveRequestsParams) {
  const [askUserAnswers, setAskUserAnswers] = useState<Record<string, { selected: string[]; otherText: string }>>({});
  const [askUserError, setAskUserError] = useState<string | null>(null);
  const [askUserSubmitting, setAskUserSubmitting] = useState(false);
  const [toolPermissionSubmitting, setToolPermissionSubmitting] = useState(false);
  const [toolPermissionError, setToolPermissionError] = useState<string | null>(null);

  useEffect(() => {
    if (!askUserQuestionRequest) return;
    const initial: Record<string, { selected: string[]; otherText: string }> = {};
    for (const question of askUserQuestionRequest.questions) {
      initial[question.header] = { selected: [], otherText: "" };
    }
    setAskUserAnswers(initial);
    setAskUserError(null);
    setAskUserSubmitting(false);
  }, [askUserQuestionRequest]);

  useEffect(() => {
    if (currentRuntimeStatus && currentRuntimeStatus.phase !== "awaiting_user_answer") {
      setAskUserQuestionRequests((prev) => {
        const map = new Map(prev);
        if (sessionId) {
          map.delete(sessionId);
        }
        return map;
      });
    }
    if (currentRuntimeStatus && currentRuntimeStatus.phase !== "awaiting_permission") {
      setToolPermissionRequests((prev) => {
        const map = new Map(prev);
        if (sessionId) {
          map.delete(sessionId);
        }
        return map;
      });
    }
  }, [currentRuntimeStatus, sessionId, setAskUserQuestionRequests, setToolPermissionRequests]);

  const updateAskAnswerOption = useCallback((header: string, label: string, checked: boolean, multiSelect: boolean): void => {
    setAskUserAnswers((prev) => {
      const current = prev[header] ?? { selected: [], otherText: "" };
      let nextSelected: string[];
      if (multiSelect) {
        nextSelected = checked
          ? [...new Set([...current.selected, label])]
          : current.selected.filter((item) => item !== label);
      } else {
        nextSelected = checked ? [label] : [];
      }
      return {
        ...prev,
        [header]: {
          ...current,
          selected: nextSelected
        }
      };
    });
  }, []);

  const updateAskOtherText = useCallback((header: string, text: string): void => {
    setAskUserAnswers((prev) => {
      const current = prev[header] ?? { selected: [], otherText: "" };
      return {
        ...prev,
        [header]: {
          ...current,
          otherText: text
        }
      };
    });
  }, []);

  const submitAskUserQuestion = useCallback(async (): Promise<void> => {
    if (!askUserQuestionRequest) return;

    const result = buildAskUserQuestionAnswers(askUserQuestionRequest, askUserAnswers);
    if ("error" in result) {
      setAskUserError(result.error);
      return;
    }

    setAskUserSubmitting(true);
    setAskUserError(null);
    try {
      await submitAgentAskUserQuestionAnswers({
        sessionId: askUserQuestionRequest.sessionId,
        toolUseId: askUserQuestionRequest.toolUseId,
        answers: result.answers
      });
      setAskUserQuestionRequests((prev) => {
        const map = new Map(prev);
        map.delete(askUserQuestionRequest.sessionId);
        return map;
      });
      setAskUserAnswers({});
    } catch (error) {
      setAskUserError(error instanceof Error ? error.message : "提交回答失败");
    } finally {
      setAskUserSubmitting(false);
    }
  }, [askUserAnswers, askUserQuestionRequest, setAskUserQuestionRequests]);

  const cancelAskUserQuestion = useCallback(async (): Promise<void> => {
    if (!askUserQuestionRequest || askUserSubmitting) return;
    setAskUserSubmitting(true);
    setAskUserError(null);
    try {
      await submitAgentAskUserQuestionAnswers({
        sessionId: askUserQuestionRequest.sessionId,
        toolUseId: askUserQuestionRequest.toolUseId,
        canceled: true
      });
      setAskUserQuestionRequests((prev) => {
        const map = new Map(prev);
        map.delete(askUserQuestionRequest.sessionId);
        return map;
      });
      setAskUserAnswers({});
    } catch (error) {
      setAskUserError(error instanceof Error ? error.message : "取消提问失败");
    } finally {
      setAskUserSubmitting(false);
    }
  }, [askUserQuestionRequest, askUserSubmitting, setAskUserQuestionRequests]);

  const submitToolPermissionDecision = useCallback(async (decision: AgentToolPermissionDecision): Promise<void> => {
    if (!toolPermissionRequest || toolPermissionSubmitting) return;
    setToolPermissionSubmitting(true);
    setToolPermissionError(null);
    try {
      await submitAgentToolPermission({
        sessionId: toolPermissionRequest.sessionId,
        requestId: toolPermissionRequest.requestId,
        decision
      });
      setToolPermissionRequests((prev) => {
        const map = new Map(prev);
        map.delete(toolPermissionRequest.sessionId);
        return map;
      });
    } catch (error) {
      setToolPermissionError(error instanceof Error ? error.message : "提交工具权限失败");
    } finally {
      setToolPermissionSubmitting(false);
    }
  }, [toolPermissionRequest, toolPermissionSubmitting, setToolPermissionRequests]);

  return {
    askUserAnswers,
    askUserError,
    askUserSubmitting,
    toolPermissionSubmitting,
    toolPermissionError,
    updateAskAnswerOption,
    updateAskOtherText,
    submitAskUserQuestion,
    cancelAskUserQuestion,
    submitToolPermissionDecision,
    setAskUserError,
    setToolPermissionError
  };
}
