import type { KnownProvider } from "@mariozechner/pi-ai";

export function isBigmodelAnthropicCompatBaseUrl(baseUrl?: string): boolean {
  const normalized = (baseUrl ?? "").trim().toLowerCase();
  return normalized.includes("open.bigmodel.cn/api/anthropic");
}

export function prioritizeProvidersForBaseUrl(
  providers: KnownProvider[],
  baseUrl?: string
): KnownProvider[] {
  if (!isBigmodelAnthropicCompatBaseUrl(baseUrl)) {
    return providers;
  }
  const result = [...providers];
  const zaiIndex = result.indexOf("zai");
  if (zaiIndex > 0) {
    const [zai] = result.splice(zaiIndex, 1);
    if (zai) {
      result.unshift(zai);
    }
  }
  return result;
}

export function shouldApplyChannelBaseUrl(provider: KnownProvider, baseUrl?: string): boolean {
  if (isBigmodelAnthropicCompatBaseUrl(baseUrl) && provider === "zai") {
    return false;
  }
  return true;
}
