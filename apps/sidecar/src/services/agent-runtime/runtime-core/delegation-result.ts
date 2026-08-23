export async function buildWaitForDelegationsResult(
  toolInput: {
    mode?: string;
    min_completed?: number;
    timeout_seconds?: number;
  },
  parentThreadId: string,
  registry: {
    waitForDelegations(input: {
      parentThreadId: string;
      mode: "all" | "any";
      minCompleted?: number;
      timeoutMs: number;
    }): Promise<{
      status: "completed" | "timeout";
      completedCount: number;
      runningCount: number;
    }>;
    listByParentSession(
      parentThreadId: string,
    ): Array<{
      runId: string;
      childThreadId: string;
      label?: string;
      status: string;
      outcome?: { output?: string; error?: string };
    }>;
  },
): Promise<{ type: "tool_result"; tool_use_id: string; content: string }> {
  const mode = toolInput.mode === "any" ? "any" : "all";
  const timeoutMs = Math.min(
    Math.max((toolInput.timeout_seconds ?? 1800) * 1000, 1000),
    2 * 3600 * 1000,
  );
  const result = await registry.waitForDelegations({
    parentThreadId,
    mode,
    minCompleted: toolInput.min_completed,
    timeoutMs,
  });
  const runs = registry.listByParentSession(parentThreadId);
  const delegations = runs.map((r) => ({
    delegationId: r.runId,
    childThreadId: r.childThreadId,
    ...(r.label ? { label: r.label } : {}),
    status: r.status,
    ...(r.outcome?.output
      ? { outputSummary: r.outcome.output.slice(0, 2000) }
      : {}),
    ...(r.outcome?.error ? { error: r.outcome.error } : {}),
  }));
  return {
    type: "tool_result" as const,
    tool_use_id: "",
    content: JSON.stringify({
      status: result.status,
      mode,
      completedCount: result.completedCount,
      runningCount: result.runningCount,
      delegations,
    }),
  };
}
