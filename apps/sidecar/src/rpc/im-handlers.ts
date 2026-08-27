import { IM_IPC_CHANNELS, IM_MIRROR_TIERS } from "@lume/shared";
import type { ImAccountCreateInput, ImAccountUpdateInput, ImMirrorSettingsPublic, ImWeixinLoginStartInput } from "@lume/shared";
import { getImProvider } from "../services/im/provider-registry";
import {
  createImAccount,
  deleteImAccount,
  getImAccount,
  listImAccounts,
  updateImAccount
} from "../services/im/im-config-manager";
import {
  deleteImThreadBindingsForAccount,
  getImThreadBindingByThreadId,
  listImThreadBindings
} from "../services/im/im-thread-binding-store";
import {
  getImMirrorSettings,
  listImMirrorEntries,
  removeImMirrorEntriesByThreadId,
  removeImMirrorEntriesForAccount,
  setMirrorOwnerAccountId,
  upsertImMirrorEntry
} from "../services/im/im-mirror-store";
import { getAgentThreadMeta } from "../services/agent/agent-thread-manager";
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
  imMirrorAttachCandidatesInputSchema,
  imMirrorAttachInputSchema,
  imMirrorDetachInputSchema,
  imMirrorEmptyInputSchema,
  imMirrorSetOwnerInputSchema,
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
      // #544 镜像联动：清映射，若该账号正承担镜像则一并归还 owner 位
      removeImMirrorEntriesForAccount(payload.id);
      return { ok: true };
    },
    [IM_IPC_CHANNELS.MIRROR_GET_SETTINGS]: async (params) => {
      validateInput(imMirrorEmptyInputSchema, params, IM_IPC_CHANNELS.MIRROR_GET_SETTINGS);
      return getImMirrorSettings();
    },
    [IM_IPC_CHANNELS.MIRROR_SET_OWNER]: async (params) => {
      const { accountId } = validateInput(
        imMirrorSetOwnerInputSchema,
        params,
        IM_IPC_CHANNELS.MIRROR_SET_OWNER
      ) as { accountId: string | null };
      if (accountId === null) {
        setMirrorOwnerAccountId(null);
        return { ok: true, settings: getImMirrorSettings() };
      }
      const fail = (error: string): { ok: false; error: string; settings: ImMirrorSettingsPublic } => ({
        ok: false,
        error,
        settings: getImMirrorSettings()
      });
      const account = getImAccount(accountId);
      if (!account) return fail("IM 账号不存在");
      if (!account.enabled) return fail("该账号未启用，请先启用后再承担镜像");
      const tier = IM_MIRROR_TIERS[account.provider];
      if (tier.tier === "unsupported") return fail(tier.reason ?? "该渠道暂不支持镜像");
      const current = getImMirrorSettings().enabledMirrorAccountId;
      if (current && current !== accountId) return fail("已由其他账号承担镜像，请先取消原承担账号");
      setMirrorOwnerAccountId(accountId);
      return { ok: true, settings: getImMirrorSettings() };
    },
    [IM_IPC_CHANNELS.MIRROR_LIST]: async (params) => {
      validateInput(imMirrorEmptyInputSchema, params, IM_IPC_CHANNELS.MIRROR_LIST);
      const entries = listImMirrorEntries();
      const titles: Record<string, string> = {};
      for (const entry of entries) {
        titles[entry.threadId] = getAgentThreadMeta(entry.threadId)?.title ?? "";
      }
      return { entries, titles };
    },
    // ─── #544 attach 附着档：机器人已在的群 × 桌面线程 显式配对 ───
    [IM_IPC_CHANNELS.MIRROR_ATTACH_CANDIDATES]: async (params) => {
      const { accountId } = validateInput(
        imMirrorAttachCandidatesInputSchema,
        params,
        IM_IPC_CHANNELS.MIRROR_ATTACH_CANDIDATES
      ) as { accountId: string };
      const entries = listImMirrorEntries();
      const candidates = listImThreadBindings()
        .filter(
          (binding) =>
            binding.accountId === accountId &&
            binding.peerKind === "group" &&
            !entries.some((entry) => entry.accountId === accountId && entry.chatId === binding.peerId)
        )
        .map((binding) => ({
          peerId: binding.peerId,
          peerName: binding.peerName,
          threadId: binding.threadId
        }));
      return { ok: true, candidates };
    },
    [IM_IPC_CHANNELS.MIRROR_ATTACH]: async (params) => {
      const { accountId, chatId, threadId } = validateInput(
        imMirrorAttachInputSchema,
        params,
        IM_IPC_CHANNELS.MIRROR_ATTACH
      ) as { accountId: string; chatId: string; threadId: string };
      const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
      const account = getImAccount(accountId);
      if (!account) return fail("IM 账号不存在");
      if (!account.enabled) return fail("该账号未启用");
      let definition;
      try {
        definition = getImProvider(account.provider);
      } catch (error) {
        return fail(`渠道未注册：${error instanceof Error ? error.message : String(error)}`);
      }
      if (!definition.mirror) return fail("该渠道暂不支持镜像");
      // 群必须真实存在互动痕迹（该账号的 group binding），防乱配对
      const groupBinding = listImThreadBindings().find(
        (binding) =>
          binding.accountId === accountId && binding.peerKind === "group" && binding.peerId === chatId
      );
      if (!groupBinding) return fail("该群尚未与机器人互动——先把机器人拉入群并发送一条消息");
      // 自环守卫①：附着目标必须是桌面线程（无任何 IM 绑定）
      if (getImThreadBindingByThreadId(threadId)) return fail("该线程已是 IM 来源会话，不能附着");
      const meta = getAgentThreadMeta(threadId);
      if (!meta) return fail("桌面线程不存在");
      if (meta.status === "archived" || meta.status === "trashed") {
        return fail("桌面线程已归档或回收站，不能附着");
      }
      const entry = upsertImMirrorEntry({
        threadId,
        accountId,
        chatId,
        carrier: definition.mirror.carrier
      });
      return { ok: true, entry };
    },
    [IM_IPC_CHANNELS.MIRROR_DETACH]: async (params) => {
      const { threadId } = validateInput(
        imMirrorDetachInputSchema,
        params,
        IM_IPC_CHANNELS.MIRROR_DETACH
      ) as { threadId: string };
      removeImMirrorEntriesByThreadId(threadId);
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
