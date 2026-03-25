import { CHANNEL_IPC_CHANNELS } from "@lume/shared";
import type { ChannelCreateInput, ChannelUpdateInput, FetchModelsInput } from "@lume/shared";
import {
  createChannel,
  decryptApiKey,
  deleteChannel,
  fetchModels,
  listChannels,
  testChannel,
  testChannelDirect,
  updateChannel
} from "../services/channel-manager";
import type { RpcHandler } from "./types";
import { asObject, asString } from "./validation";

export function createChannelHandlers(): Record<string, RpcHandler> {
  return {
    [CHANNEL_IPC_CHANNELS.LIST]: async () => listChannels(),
    [CHANNEL_IPC_CHANNELS.CREATE]: async (params) => createChannel(params as ChannelCreateInput),
    [CHANNEL_IPC_CHANNELS.UPDATE]: async (params) => {
      const payload = asObject(params);
      const id = asString(payload.id);
      if (!id) {
        throw new Error("缺少 channel id");
      }
      return updateChannel(id, (payload.input ?? {}) as ChannelUpdateInput);
    },
    [CHANNEL_IPC_CHANNELS.DELETE]: async (params) => {
      const payload = asObject(params);
      const id = asString(payload.id);
      if (!id) {
        throw new Error("缺少 channel id");
      }
      deleteChannel(id);
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
    [CHANNEL_IPC_CHANNELS.TEST_DIRECT]: async (params) => testChannelDirect(params as FetchModelsInput),
    [CHANNEL_IPC_CHANNELS.FETCH_MODELS]: async (params) => fetchModels(params as FetchModelsInput)
  };
}
