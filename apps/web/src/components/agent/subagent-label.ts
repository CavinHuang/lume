export function getSubagentDisplayLabel(input: {
  subagentLabel?: string;
  subagentRunId?: string;
}): string | undefined {
  const label = input.subagentLabel?.trim();
  if (label) {
    return label;
  }
  const runId = input.subagentRunId?.trim();
  if (runId) {
    return `Subagent ${runId}`;
  }
  return undefined;
}
