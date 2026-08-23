import { createSdkJsonResultTool } from "../sdk-tool-result";
import type { ToolDefinition, ToolInputSchema } from "@lume/agent-sdk";
import { executeConnectorAction, getConnector } from "../../../connectors/service";
import { getConnectorOAuthCredential } from "../../../connectors/credential-store";

const SERVICE = "gmail";

/**
 * 首批注入的动作子集:覆盖搜索/读取/发送/回复/草稿/标签/归档的管理闭环。
 * 上游 provider 还有 30+ 动作(settings/filters/watch 等),按需在此扩名即可。
 */
const ENABLED_ACTIONS = [
  "get_profile",
  "search_threads",
  "fetch_emails",
  "get_message",
  "fetch_message_by_thread_id",
  "list_labels",
  "send_email",
  "reply_to_thread",
  "create_email_draft",
  "batch_modify_messages",
  "move_to_trash",
  "create_label",
] as const;

const READ_ONLY_ACTIONS = new Set<string>([
  "get_profile",
  "search_threads",
  "fetch_emails",
  "get_message",
  "fetch_message_by_thread_id",
  "list_labels",
]);

function isConnected(): boolean {
  try {
    return getConnectorOAuthCredential(SERVICE) !== undefined;
  } catch {
    return false;
  }
}

export function createSdkGmailTools(): ToolDefinition[] {
  let actions;
  try {
    actions = getConnector(SERVICE).definition.actions;
  } catch {
    return [];
  }
  return actions
    .filter((action): action is (typeof actions)[number] => (ENABLED_ACTIONS as readonly string[]).includes(action.name))
    .map((action) => ({
      ...createSdkJsonResultTool({
        name: `gmail_${action.name}`,
        description: action.description,
        inputSchema: action.inputSchema as unknown as ToolInputSchema,
        isReadOnly: READ_ONLY_ACTIONS.has(action.name),
        isConcurrencySafe: READ_ONLY_ACTIONS.has(action.name),
        async call(input) {
          const result = await executeConnectorAction(SERVICE, action.name, input ?? {});
          if (!result.ok) {
            throw new Error(result.error?.message ?? `gmail_${action.name} 执行失败`);
          }
          return result.output;
        },
      }),
      // 未连接 Gmail 时对模型隐藏整组工具
      isEnabled: isConnected,
    }));
}
