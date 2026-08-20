import { CHANNEL_IPC_CHANNELS } from "@lume/shared";
import type { ChannelCreateInput, ChannelUpdateInput, FetchModelsInput } from "@lume/shared";
import {
  createChannel,
  decryptApiKey,
  deleteChannel,
  fetchModels,
  listChannels,
  syncChannelModels,
  testChannel,
  testChannelDirect,
  updateChannel
} from "../services/channel/channel-manager";
import type { RpcHandler } from "./types";
import { asObject, asString, validateInput } from "./validation";
import {
  channelCreateInputSchema,
  channelDeleteParamsSchema,
  channelUpdateParamsSchema,
  fetchModelsInputSchema
} from "./schemas";
import {
  answerConnectionOAuthPrompt,
  cancelConnectionOAuthLogin,
  getConnectionOAuthSession,
  startConnectionOAuthLogin,
} from "../services/channel/connection-oauth-service";

export function createChannelHandlers(): Record<string, RpcHandler> {
  return {
    [CHANNEL_IPC_CHANNELS.LIST]: async () => listChannels(),
    [CHANNEL_IPC_CHANNELS.CREATE]: async (params) =>
      createChannel(validateInput(channelCreateInputSchema, params, CHANNEL_IPC_CHANNELS.CREATE) as ChannelCreateInput),
    [CHANNEL_IPC_CHANNELS.UPDATE]: async (params) => {
      const input = validateInput(channelUpdateParamsSchema, params, CHANNEL_IPC_CHANNELS.UPDATE);
      return updateChannel(input.id, input.input as ChannelUpdateInput);
    },
    [CHANNEL_IPC_CHANNELS.DELETE]: async (params) => {
      const input = validateInput(channelDeleteParamsSchema, params, CHANNEL_IPC_CHANNELS.DELETE);
      deleteChannel(input.id);
      return { ok: true };
    },
    [CHANNEL_IPC_CHANNELS.DECRYPT_KEY]: async (params) => {
      const payload = asObject(params);
      const channelId = asString(payload.channelId);
      if (!channelId) {
        throw new Error("缺少 channelId");
      }
      return decryptApiKey(channelId);
    },
    [CHANNEL_IPC_CHANNELS.TEST]: async (params) => {
      const payload = asObject(params);
      const channelId = asString(payload.channelId);
      if (!channelId) {
        throw new Error("缺少 channelId");
      }
      return testChannel(channelId);
    },
    [CHANNEL_IPC_CHANNELS.TEST_DIRECT]: async (params) =>
      testChannelDirect(validateInput(fetchModelsInputSchema, params, CHANNEL_IPC_CHANNELS.TEST_DIRECT) as FetchModelsInput),
    [CHANNEL_IPC_CHANNELS.FETCH_MODELS]: async (params) =>
      fetchModels(validateInput(fetchModelsInputSchema, params, CHANNEL_IPC_CHANNELS.FETCH_MODELS) as FetchModelsInput),
    [CHANNEL_IPC_CHANNELS.SYNC_MODELS]: async (params) => {
      const payload = asObject(params);
      const channelId = asString(payload.channelId);
      if (!channelId) throw new Error("缺少 channelId");
      return syncChannelModels(channelId);
    },
    [CHANNEL_IPC_CHANNELS.OAUTH_START]: async (params) => {
      const connectionId = asString(asObject(params).connectionId);
      if (!connectionId) throw new Error("缺少 connectionId");
      return startConnectionOAuthLogin(connectionId);
    },
    [CHANNEL_IPC_CHANNELS.OAUTH_STATUS]: async (params) => {
      const sessionId = asString(asObject(params).sessionId);
      if (!sessionId) throw new Error("缺少 sessionId");
      return getConnectionOAuthSession(sessionId);
    },
    [CHANNEL_IPC_CHANNELS.OAUTH_ANSWER]: async (params) => {
      const payload = asObject(params);
      const sessionId = asString(payload.sessionId);
      const promptId = asString(payload.promptId);
      const value = asString(payload.value);
      if (!sessionId || !promptId) throw new Error("缺少 OAuth prompt 参数");
      return answerConnectionOAuthPrompt(sessionId, promptId, value ?? "");
    },
    [CHANNEL_IPC_CHANNELS.OAUTH_CANCEL]: async (params) => {
      const sessionId = asString(asObject(params).sessionId);
      if (sessionId) cancelConnectionOAuthLogin(sessionId);
      return { ok: true };
    },
  };
}
