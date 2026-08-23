import { resolveChannelModelBinding } from "../channel/channel-manager";
import { getEffectiveLumeConfig } from "../system/lume-config-service";

export function resolveMockRuntimeModelAttemptParams<T extends {
  runtime?: {
    modelRef?: string;
    channelId?: string;
    resolvedModelId?: string;
  };
}>(params: T): T[] {
  const fallbackRefs = getEffectiveLumeConfig().models?.agent?.fallbackModelRefs ?? [];
  const refs = uniqueModelRefs([params.runtime?.modelRef, ...fallbackRefs]);
  const attempts: T[] = [params];
  for (const modelRef of refs) {
    if (modelRef === params.runtime?.modelRef) continue;
    const binding = resolveChannelModelBinding(modelRef, "chat");
    if (!binding) continue;
    attempts.push({
      ...params,
      runtime: {
        ...params.runtime,
        modelRef,
        channelId: binding.channel.id,
        resolvedModelId: binding.modelId
      }
    });
  }
  return attempts;
}

export function isMockRuntimeModelFallbackRetryable(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  const value = errorMessage.toLowerCase();
  return (
    value.includes("timeout")
    || value.includes("timed out")
    || value.includes("rate limit")
    || value.includes("429")
    || value.includes("temporar")
    || value.includes("500")
    || value.includes("502")
    || value.includes("503")
    || value.includes("504")
    || value.includes("econnreset")
    || value.includes("econnrefused")
    || value.includes("etimedout")
    || value.includes("enotfound")
    || value.includes("network")
    || value.includes("unavailable")
    || value.includes("fetch failed")
    || value.includes("connection refused")
    || value.includes("socket hang up")
  );
}

function uniqueModelRefs(values: Array<string | undefined>): string[] {
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || result.includes(trimmed)) continue;
    result.push(trimmed);
  }
  return result;
}
