/**
 * Extracted from chat-service to isolate title generation from chat send orchestration.
 */

import type { GenerateTitleInput } from "@lume/shared";
import { fetchTitle, getAdapter } from "../../providers";
import { decryptApiKey, listChannels, resolveChannelModelBinding } from "../channel/channel-manager";
import {
  resolveChannelModelSelection,
  resolveRequestedModelIdForChannel
} from "../channel/model-selection";

const TITLE_PROMPT =
  "根据用户的第一条消息，生成一个简短的对话标题（10字以内）。只输出标题，不要有任何其他内容、标点符号或引号。\n\n用户消息：";
const MAX_TITLE_LENGTH = 20;

export async function generateTitle(input: GenerateTitleInput): Promise<string | null> {
  const { userMessage, channelId, modelId } = input;
  const boundModel = resolveChannelModelBinding(input.modelRef ?? "", "chat");
  const channel = boundModel?.channel ?? listChannels().find((item) => item.id === channelId);
  if (!channel) return null;

  let apiKey: string;
  try {
    apiKey = decryptApiKey(channel.id);
  } catch {
    return null;
  }

  try {
    const selectedModelId = boundModel?.modelId ?? resolveRequestedModelIdForChannel(channel, modelId) ?? modelId;
    const modelSelection = resolveChannelModelSelection({
      channelProvider: channel.provider,
      baseUrl: channel.baseUrl,
      modelId: selectedModelId
    });
    const adapter = getAdapter(modelSelection.adapterProvider);
    const request = adapter.buildTitleRequest({
      baseUrl: channel.baseUrl,
      apiKey,
      modelId: modelSelection.resolvedModelId,
      prompt: TITLE_PROMPT + userMessage
    });
    const title = await fetchTitle(request, adapter);
    if (!title) return null;
    const cleaned = title.trim().replace(/^["'""'']+|["'""'']+$/g, "").trim();
    return cleaned.slice(0, MAX_TITLE_LENGTH) || null;
  } catch {
    return null;
  }
}
