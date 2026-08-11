import type { LinkRuntimeMode } from "@lume/shared";

// These providers cannot complete their main local flow with OpenConnector's
// http://127.0.0.1 OAuth/action callback. Keep them available to remote
// deployments and to existing connections so users can still manage them.
const PUBLIC_CALLBACK_REQUIRED_SERVICES = new Set([
  "intercom",
  "sunoapi",
]);

export function isLinkProviderAvailable(
  service: string,
  runtimeMode: LinkRuntimeMode,
  runtimeOrigin: string | null,
  configured: boolean,
): boolean {
  return configured || !PUBLIC_CALLBACK_REQUIRED_SERVICES.has(service) || hasPublicCallbackOrigin(runtimeMode, runtimeOrigin);
}

function hasPublicCallbackOrigin(runtimeMode: LinkRuntimeMode, runtimeOrigin: string | null): boolean {
  if (runtimeMode !== "remote" || !runtimeOrigin) return false;
  try {
    const hostname = new URL(runtimeOrigin).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1";
  } catch {
    return false;
  }
}
