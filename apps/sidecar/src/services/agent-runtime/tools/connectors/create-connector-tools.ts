import type { ToolDefinition, ToolInputSchema } from "@lume/agent-sdk";
import {
  executeConnectorAction,
  getConnector,
  hasAnyConnectorCredential,
} from "../../../connectors/service";
import { createSdkJsonResultTool } from "../sdk-tool-result";

/** 每个连接器的工具注入配置:动作子集与只读集合按 provider 能力收敛(prompt 预算)。 */
interface ConnectorToolConfig {
  service: string;
  /** 注入的动作名;缺省注入全部。 */
  enabledActions?: readonly string[];
  readOnlyActions: ReadonlySet<string>;
  /** 排除的动作(缺省注入全部时的黑名单模式)。 */
  excludedActions?: readonly string[];
}

const GMAIL_READ_ONLY = new Set([
  "get_profile",
  "search_threads",
  "fetch_emails",
  "get_message",
  "fetch_message_by_thread_id",
  "list_labels",
]);

const MAIL_READ_ONLY = new Set(["list_folders", "search_emails", "get_email", "get_folder_status"]);

/** 导出仅供不变式测试(readOnly 映射不得包含变更类动作)。 */
export const CONNECTOR_TOOL_CONFIGS: readonly ConnectorToolConfig[] = [
  {
    service: "gmail",
    enabledActions: [
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
    ],
    readOnlyActions: GMAIL_READ_ONLY,
  },
  {
    service: "qq_mail",
    readOnlyActions: MAIL_READ_ONLY,
  },
];

function isConnected(service: string): () => boolean {
  // engine 每轮组装 provider 请求都会调 isEnabled 过滤(#700);凭证读盘解密
  // 不便宜,2s TTL 内同服务共享一次判定。注入最多延迟 2s 感知连接变化,无害。
  const TTL_MS = 2_000;
  let cached: { at: number; value: boolean } | undefined;
  return () => {
    if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
    try {
      cached = { at: Date.now(), value: hasAnyConnectorCredential(service) };
    } catch {
      cached = { at: Date.now(), value: false };
    }
    return cached.value;
  };
}

type ExecutionError = NonNullable<
  Awaited<ReturnType<typeof executeConnectorAction>>["error"]
>;

/**
 * Surface code + field-level details to the model so it can self-correct:
 * `invalid_input` carries JSON Schema OutputUnits that name the exact property
 * and violation, which a bare message string throws away.
 */
function describeExecutionError(service: string, actionName: string, error: ExecutionError): string {
  const head = `${service}.${actionName} failed (${error.code}): ${error.message}`;
  const details = Array.isArray(error.details)
    ? (error.details as Array<{ instancePath?: string; keyword?: string; message?: string }>)
        .map((unit) => `${unit.instancePath || "(input)"} ${unit.keyword ?? ""} ${unit.message ?? ""}`.trim())
        .filter(Boolean)
        .join("; ")
    : "";
  return details ? `${head}\nInput issues: ${details}` : head;
}

function toolsForService(config: ConnectorToolConfig): ToolDefinition[] {
  let actions;
  try {
    actions = getConnector(config.service).definition.actions;
  } catch {
    return [];
  }
  const enabled =
    config.enabledActions ?? actions.map((action) => action.name).filter((name) => !config.excludedActions?.includes(name));
  return actions
    .filter((action) => enabled.includes(action.name))
    .map((action) => ({
      ...createSdkJsonResultTool({
        name: `${config.service}_${action.name}`,
        description: action.description,
        inputSchema: action.inputSchema as unknown as ToolInputSchema,
        isReadOnly: config.readOnlyActions.has(action.name),
        isConcurrencySafe: config.readOnlyActions.has(action.name),
        async call(input) {
          const result = await executeConnectorAction(config.service, action.name, input ?? {});
          if (!result.ok) {
            throw new Error(
              result.error
                ? describeExecutionError(config.service, action.name, result.error)
                : `${config.service}.${action.name} 执行失败`,
            );
          }
          return result.output;
        },
      }),
      // 未连接该服务时对模型隐藏整组工具
      isEnabled: isConnected(config.service),
    }));
}

export function createSdkConnectorTools(): ToolDefinition[] {
  return CONNECTOR_TOOL_CONFIGS.flatMap((config) => toolsForService(config));
}
