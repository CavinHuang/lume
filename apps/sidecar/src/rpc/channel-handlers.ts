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
import { validateInput } from "./validation";
import {
  channelIdParamsSchema,
  channelCreateInputSchema,
  channelDeleteParamsSchema,
  channelUpdateParamsSchema,
  connectionIdParamsSchema,
  fetchModelsInputSchema,
  oauthAnswerParamsSchema,
  oauthCancelParamsSchema,
  oauthSessionIdParamsSchema
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
      const input = validateInput(channelIdParamsSchema, params, CHANNEL_IPC_CHANNELS.DECRYPT_KEY);
      return decryptApiKey(input.channelId);
    },
    [CHANNEL_IPC_CHANNELS.TEST]: async (params) => {
      const input = validateInput(channelIdParamsSchema, params, CHANNEL_IPC_CHANNELS.TEST);
      return testChannel(input.channelId);
    },
    [CHANNEL_IPC_CHANNELS.TEST_DIRECT]: async (params) =>
      testChannelDirect(validateInput(fetchModelsInputSchema, params, CHANNEL_IPC_CHANNELS.TEST_DIRECT) as FetchModelsInput),
    [CHANNEL_IPC_CHANNELS.FETCH_MODELS]: async (params) =>
      fetchModels(validateInput(fetchModelsInputSchema, params, CHANNEL_IPC_CHANNELS.FETCH_MODELS) as FetchModelsInput),
    [CHANNEL_IPC_CHANNELS.SYNC_MODELS]: async (params) => {
      const input = validateInput(channelIdParamsSchema, params, CHANNEL_IPC_CHANNELS.SYNC_MODELS);
      return syncChannelModels(input.channelId);
    },
    [CHANNEL_IPC_CHANNELS.OAUTH_START]: async (params) => {
      const input = validateInput(connectionIdParamsSchema, params, CHANNEL_IPC_CHANNELS.OAUTH_START);
      return startConnectionOAuthLogin(input.connectionId);
    },
    [CHANNEL_IPC_CHANNELS.OAUTH_STATUS]: async (params) => {
      const input = validateInput(oauthSessionIdParamsSchema, params, CHANNEL_IPC_CHANNELS.OAUTH_STATUS);
      return getConnectionOAuthSession(input.sessionId);
    },
    [CHANNEL_IPC_CHANNELS.OAUTH_ANSWER]: async (params) => {
      const input = validateInput(oauthAnswerParamsSchema, params, CHANNEL_IPC_CHANNELS.OAUTH_ANSWER);
      return answerConnectionOAuthPrompt(input.sessionId, input.promptId, input.value ?? "");
    },
    [CHANNEL_IPC_CHANNELS.OAUTH_CANCEL]: async (params) => {
      const input = validateInput(oauthCancelParamsSchema, params, CHANNEL_IPC_CHANNELS.OAUTH_CANCEL);
      if (input.sessionId) cancelConnectionOAuthLogin(input.sessionId);
      return { ok: true };
    },
  };
}
