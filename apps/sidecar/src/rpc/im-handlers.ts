import { IM_IPC_CHANNELS } from "@lume/shared";
import type { ImAccountCreateInput, ImAccountUpdateInput } from "@lume/shared";
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
import {
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
}

export function createImHandlers(input: CreateImHandlersInput = {}): Record<string, RpcHandler> {
  const runtimeManager = input.runtimeManager ?? imRuntimeManager;
  const loginManager = input.loginManager ?? weixinLoginManager;

  return {
    [IM_IPC_CHANNELS.LIST_ACCOUNTS]: async () => listImAccounts(),
    [IM_IPC_CHANNELS.CREATE_ACCOUNT]: async (params) =>
      createImAccount(validateInput(
        imAccountCreateInputSchema,
        params,
        IM_IPC_CHANNELS.CREATE_ACCOUNT
      ) as ImAccountCreateInput),
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
      ) as { force?: boolean } | undefined),
    [IM_IPC_CHANNELS.POLL_WEIXIN_LOGIN]: async (params) =>
      loginManager.pollLogin(validateInput(
        imWeixinLoginPollInputSchema,
        params,
        IM_IPC_CHANNELS.POLL_WEIXIN_LOGIN
      ) as { sessionKey: string; verifyCode?: string })
  };
}
