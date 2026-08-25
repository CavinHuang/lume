import { IM_IPC_CHANNELS } from "@lume/shared";
import type { ImAccountCreateInput, ImAccountUpdateInput, ImWeixinLoginStartInput } from "@lume/shared";
import {
  createImAccount,
  deleteImAccount,
  getImAccount,
  listImAccounts,
  updateImAccount
} from "../services/im/im-config-manager";
import { deleteImThreadBindingsForAccount } from "../services/im/im-thread-binding-store";
import { imRuntimeManager, type ImRuntimeManager } from "../services/im/im-runtime-manager";
import {
  weixinLoginManager,
  type WeixinLoginManager
} from "../services/im/weixin/openclaw-weixin-login";
import { cliAuthManager, type CliAuthManager } from "../services/agent-runtime/tools/im-cli/cli-auth-manager";
import { getImCliBaseDir } from "../services/infra/config-paths";
import { dingtalkCliConfig, type CliProviderConfig } from "../services/agent-runtime/tools/im-cli/providers/dingtalk";
import { larkCliConfig } from "../services/agent-runtime/tools/im-cli/providers/feishu";
import { wecomCliConfig } from "../services/agent-runtime/tools/im-cli/providers/wecom";
import {
  cliAuthSessionInputSchema,
  cliAuthStartInputSchema,
  imAccountCreateInputSchema,
  imAccountIdInputSchema,
  imAccountUpdateInputSchema,
  imWeixinLoginPollInputSchema,
  imWeixinLoginStartInputSchema
} from "./schemas";
import type { RpcHandler } from "./types";
import { validateInput } from "./validation";

export interface CreateImHandlersInput {
  runtimeManager?: ImRuntimeManager;
  loginManager?: WeixinLoginManager;
  authManager?: CliAuthManager;
}

/** CLI 授权是 provider 级:三企业渠道 config 映射(微信走扫码,不入此表) */
const CLI_PROVIDER_CONFIGS: Record<string, CliProviderConfig> = {
  dingtalk: dingtalkCliConfig,
  feishu: larkCliConfig,
  wecom: wecomCliConfig,
};

export function createImHandlers(input: CreateImHandlersInput = {}): Record<string, RpcHandler> {
  const runtimeManager = input.runtimeManager ?? imRuntimeManager;
  const loginManager = input.loginManager ?? weixinLoginManager;
  const authManager = input.authManager ?? cliAuthManager;

  return {
    [IM_IPC_CHANNELS.LIST_ACCOUNTS]: async () => listImAccounts(),
    [IM_IPC_CHANNELS.CREATE_ACCOUNT]: async (params) => {
      const account = await createImAccount(validateInput(
        imAccountCreateInputSchema,
        params,
        IM_IPC_CHANNELS.CREATE_ACCOUNT
      ) as ImAccountCreateInput);
      // 启用的账号创建即启动通道（对齐微信扫码 connected 后自动 start 的闭环），
      // 否则用户保存凭据后通道并未运行，IM 侧收不到任何消息
      if (account.enabled) {
        void runtimeManager.startAccount(account.id).catch(() => {
          // 启动失败已由 runtime manager 回写 status/lastError，设置页可见
        });
      }
      return account;
    },
    [IM_IPC_CHANNELS.UPDATE_ACCOUNT]: async (params) => {
      const payload = validateInput(
        imAccountUpdateInputSchema,
        params,
        IM_IPC_CHANNELS.UPDATE_ACCOUNT
      ) as { id: string; input: ImAccountUpdateInput };
      return updateImAccount(payload.id, payload.input);
    },
    [IM_IPC_CHANNELS.DELETE_ACCOUNT]: async (params) => {
      const payload = validateInput(
        imAccountIdInputSchema,
        params,
        IM_IPC_CHANNELS.DELETE_ACCOUNT
      ) as { id: string };
      runtimeManager.stopAccount(payload.id);
      deleteImAccount(payload.id);
      deleteImThreadBindingsForAccount(payload.id);
      return { ok: true };
    },
    [IM_IPC_CHANNELS.START_ACCOUNT]: async (params) => {
      const payload = validateInput(
        imAccountIdInputSchema,
        params,
        IM_IPC_CHANNELS.START_ACCOUNT
      ) as { id: string };
      await runtimeManager.startAccount(payload.id);
      return getImAccount(payload.id) ?? { ok: true };
    },
    [IM_IPC_CHANNELS.STOP_ACCOUNT]: async (params) => {
      const payload = validateInput(
        imAccountIdInputSchema,
        params,
        IM_IPC_CHANNELS.STOP_ACCOUNT
      ) as { id: string };
      runtimeManager.stopAccount(payload.id);
      return getImAccount(payload.id) ?? { ok: true };
    },
    [IM_IPC_CHANNELS.START_WEIXIN_LOGIN]: async (params) =>
      loginManager.startLogin(validateInput(
        imWeixinLoginStartInputSchema,
        params ?? {},
        IM_IPC_CHANNELS.START_WEIXIN_LOGIN
      ) as ImWeixinLoginStartInput | undefined),
    [IM_IPC_CHANNELS.POLL_WEIXIN_LOGIN]: async (params) => {
      const result = await loginManager.pollLogin(validateInput(
        imWeixinLoginPollInputSchema,
        params,
        IM_IPC_CHANNELS.POLL_WEIXIN_LOGIN
      ) as { sessionKey: string; verifyCode?: string });
      if (result.connected && result.account?.id) {
        await runtimeManager.startAccount(result.account.id);
        return {
          ...result,
          account: getImAccount(result.account.id) ?? result.account
        };
      }
      return result;
    },
    [IM_IPC_CHANNELS.START_CLI_AUTH]: async (params) => {
      const { provider } = validateInput(
        cliAuthStartInputSchema,
        params,
        IM_IPC_CHANNELS.START_CLI_AUTH
      ) as { provider: string };
      const config = CLI_PROVIDER_CONFIGS[provider];
      if (!config) return { sessionKey: "", error: `不支持的 CLI 渠道: ${provider}` };
      return authManager.startAuth(config, getImCliBaseDir(), process.platform, process.arch);
    },
    [IM_IPC_CHANNELS.POLL_CLI_AUTH]: async (params) => {
      const { sessionKey } = validateInput(
        cliAuthSessionInputSchema,
        params,
        IM_IPC_CHANNELS.POLL_CLI_AUTH
      ) as { sessionKey: string };
      return authManager.pollAuth(sessionKey);
    },
    [IM_IPC_CHANNELS.CANCEL_CLI_AUTH]: async (params) => {
      const { sessionKey } = validateInput(
        cliAuthSessionInputSchema,
        params,
        IM_IPC_CHANNELS.CANCEL_CLI_AUTH
      ) as { sessionKey: string };
      authManager.cancelAuth(sessionKey);
      return { ok: true };
    }
  };
}
