import { applyMemoryToolPolicy } from "../../memory-policy";
import type { MemoryToolPolicy } from "../../memory-policy";
import {
  MEMORY_GET_TOOL_NAME,
  MEMORY_SAVE_TOOL_NAME,
  MEMORY_SEARCH_TOOL_NAME
} from "../../memory-mcp-service";

export function resolveEnabledPiMemoryToolNames(policy?: MemoryToolPolicy): string[] {
  return applyMemoryToolPolicy({
    baseTools: [MEMORY_SEARCH_TOOL_NAME, MEMORY_GET_TOOL_NAME, MEMORY_SAVE_TOOL_NAME],
    policy
  });
}
