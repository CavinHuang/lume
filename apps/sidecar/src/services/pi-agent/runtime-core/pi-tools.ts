import { createCodingTools, createReadOnlyTools } from "@mariozechner/pi-coding-agent";
import type { AgentSendInput } from "@lume/shared";

export function buildRuntimeCoreTools(
  cwd: string,
  permissionMode: AgentSendInput["permissionMode"] = "default"
) {
  if (permissionMode === "plan") {
    return createReadOnlyTools(cwd);
  }
  return createCodingTools(cwd);
}
