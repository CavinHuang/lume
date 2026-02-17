import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool
} from "@mariozechner/pi-coding-agent";
import type { AgentSendInput } from "@lume/shared";

type PermissionMode = NonNullable<AgentSendInput["permissionMode"]>;

const READ_ONLY_PERMISSION_MODE: PermissionMode = "plan";

export function createCoreCodingTools(
  cwd: string,
  permissionMode: AgentSendInput["permissionMode"] = "default"
): AgentTool[] {
  if (permissionMode === READ_ONLY_PERMISSION_MODE) {
    return [
      createReadTool(cwd),
      createFindTool(cwd),
      createGrepTool(cwd),
      createLsTool(cwd)
    ] as unknown as AgentTool[];
  }

  return [
    createReadTool(cwd),
    createWriteTool(cwd),
    createEditTool(cwd),
    createBashTool(cwd),
    createFindTool(cwd),
    createGrepTool(cwd),
    createLsTool(cwd)
  ] as unknown as AgentTool[];
}
