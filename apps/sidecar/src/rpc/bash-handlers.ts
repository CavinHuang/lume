import { AGENT_IPC_CHANNELS } from "@lume/shared";
import { promoteForegroundShellTask } from "@lume/agent-sdk";
import { promoteShellBackgroundInputSchema } from "./schemas";
import type { RpcHandler } from "./types";
import { validateInput } from "./validation";

export function createBashHandlers(): Record<string, RpcHandler> {
  return {
    // 手动转后台:把正在前台等待的 Bash 命令立即转入后台(按 toolUseId 定位)。
    // SDK 注册表与工具执行同进程,这里只是薄薄一层校验与转发。
    [AGENT_IPC_CHANNELS.PROMOTE_SHELL_BACKGROUND]: async (params) => {
      const input = validateInput(
        promoteShellBackgroundInputSchema,
        params,
        AGENT_IPC_CHANNELS.PROMOTE_SHELL_BACKGROUND,
      ) as { toolUseId: string; sessionId?: string };
      return promoteForegroundShellTask(input);
    },
  };
}
