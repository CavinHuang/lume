export type LinkOAuthSetupState = "not_supported" | "optional" | "required" | "configured";

export function resolveLinkOAuthSetupState(
  authTypes: readonly string[],
  oauthConfigured: boolean,
): LinkOAuthSetupState {
  const supportsOAuth = authTypes.includes("oauth2");
  if (!supportsOAuth) return "not_supported";
  if (oauthConfigured) return "configured";
  return authTypes.length > 0 && authTypes.every((authType) => authType === "oauth2")
    ? "required"
    : "optional";
}

const connectionNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function isValidLinkConnectionName(value: string): boolean {
  return connectionNamePattern.test(value.trim());
}
