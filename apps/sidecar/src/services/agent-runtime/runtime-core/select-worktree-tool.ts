/**
 * Agent 侧绑定既有 linked worktree 的工具（对齐 Proma SelectWorktree）。
 *
 * 创建 worktree 走 bash / EnterWorktree；本工具只负责「接管」已存在的目录。
 * 绑定校验（linked worktree + 主仓库根，必须属于线程所属项目仓库）在
 * agent-worktree-service.setThreadWorktree 单点完成——Agent 可以接管新目录，
 * 但不能借此扩大文件访问边界。仅主任务线程与交互执行注入，后台自动任务与
 * 子 Agent 不得重定向交互会话的开发目录。
 */

import { defineTool, type ToolDefinition } from "@lume/agent-sdk";
import { resolve } from "node:path";
import { getRuntimeHostPorts } from "../host-ports";

export function createSelectWorktreeTool(input: {
  threadId: string;
  enabled: boolean;
}): ToolDefinition | null {
  if (!input.enabled) return null;
  return defineTool({
    name: "SelectWorktree",
    description:
      "Bind this session to an existing linked Git worktree of the project (create it beforehand via `git worktree add`). Call it right after creating or locating the worktree, before editing its files: the binding makes the worktree the session cwd for subsequent runs and keeps the Changes panel aligned. Only worktrees of the project repository are accepted.",
    inputSchema: {
      type: "object",
      properties: {
        worktreePath: {
          type: "string",
          description:
            "Absolute path, or a path relative to the current working directory, of the linked worktree to use.",
        },
      },
      required: ["worktreePath"],
    },
    isReadOnly: false,
    isConcurrencySafe: false,
    async call(toolInput, context) {
      const requested = typeof (toolInput as Record<string, unknown>)?.worktreePath === "string"
        ? ((toolInput as Record<string, unknown>).worktreePath as string).trim()
        : "";
      if (!requested) {
        return { data: { error: "worktreePath 必填" }, is_error: true };
      }
      const worktreePath = resolve(context.cwd, requested);
      try {
        const updated = await getRuntimeHostPorts().bindThreadWorktree(input.threadId, worktreePath);
        return {
          data: {
            activeWorktree: updated.activeWorktree,
            note: "已绑定到当前会话；本轮后续命令如未显式指定 cwd，请使用该目录。下一轮 Agent 将自动以此 Worktree 为 cwd。",
          },
        };
      } catch (error) {
        return {
          data: { error: `绑定 worktree 失败: ${error instanceof Error ? error.message : String(error)}` },
          is_error: true,
        };
      }
    },
  });
}
