import type { TaskGroup } from "./agent-tool-activity";

export const SUBAGENT_NO_TEXT_OUTPUT = "(Subagent completed with no text output)";

const AGENT_TASK_TOOL_NAMES = new Set(["task", "agent", "threads_spawn", "subagents_send", "subagents_steer", "subagents_kill"]);
const FAILED_TASK_STATUSES = new Set(["failed", "errored", "aborted", "timed_out", "canceled"]);

interface SdkTextBlock {
  type: "text";
  text: string;
}

interface SdkThinkingBlock {
  type: "thinking";
  thinking: string;
}

interface SdkToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type RenderableSdkContentBlock = SdkTextBlock | SdkThinkingBlock | SdkToolUseBlock | { type: string; [key: string]: unknown };

export function filterOrderedSdkBlocksForTaskGroups(
  blocks: RenderableSdkContentBlock[],
  taskGroups: TaskGroup[]
): RenderableSdkContentBlock[] {
  if (taskGroups.length === 0) {
    return blocks;
  }

  const hiddenToolUseIds = new Set(taskGroups.map((group) => group.parent.toolUseId));
  return blocks.filter((block) => {
    if (block.type !== "tool_use") {
      return true;
    }

    const toolName = typeof block.name === "string" ? block.name.trim().toLowerCase() : "";
    const toolUseId = typeof block.id === "string" ? block.id : "";
    return !(hiddenToolUseIds.has(toolUseId) && AGENT_TASK_TOOL_NAMES.has(toolName));
  });
}

export function normalizeSubagentResultText(value?: string | null): string | undefined {
  const normalized = value?.trim();
  if (!normalized || normalized === SUBAGENT_NO_TEXT_OUTPUT) {
    return undefined;
  }
  return normalized;
}

export function resolveTaskTerminalVisualState(status?: string): { done: boolean; isError: boolean } {
  const normalized = status?.trim().toLowerCase();
  if (normalized === "completed") {
    return { done: true, isError: false };
  }
  if (normalized && FAILED_TASK_STATUSES.has(normalized)) {
    return { done: true, isError: true };
  }
  return { done: false, isError: false };
}
