import type { SubagentRun } from "./subagent-run.types";

type LogFields = Record<string, unknown>;

function compactFields(fields: LogFields): LogFields {
  const cleaned: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === "") continue;
    cleaned[key] = value;
  }
  return cleaned;
}

export function subagentLogFields(
  run: Partial<SubagentRun>,
  extra?: LogFields
): LogFields {
  return compactFields({
    runId: run.runId,
    parentRunId: run.parentRunId,
    rootSessionId: run.rootSessionId,
    sessionId: run.parentSessionId,
    parentSessionId: run.parentSessionId,
    childSessionId: run.childSessionId,
    deliverySessionId: run.deliverySessionId,
    requestedAgentId: run.requestedAgentId,
    resolvedAgentId: run.resolvedAgentId,
    status: run.status,
    errorCode: run.outcome?.errorCode,
    ...extra
  });
}
