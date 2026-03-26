import type { AgentSendInput } from "@lume/shared";

export function resolveRestoredPermissionMode(
  value: NonNullable<AgentSendInput["permissionMode"]>
): NonNullable<AgentSendInput["permissionMode"]> {
  return value === "plan" ? "default" : value;
}
