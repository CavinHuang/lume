import type { LinkActionSummary, LinkOAuthSession } from "@lume/shared";

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

export function findRestorableLinkOAuthSession(
  sessions: readonly LinkOAuthSession[],
  service: string,
  initialConnectionName: string,
): LinkOAuthSession | undefined {
  const pending = sessions.filter((session) => session.service === service && session.status === "pending");
  if (initialConnectionName) {
    return pending.find((session) => session.connectionName === initialConnectionName);
  }
  return pending.length === 1 ? pending[0] : undefined;
}

export function getSupportedLinkActions(actions: readonly LinkActionSummary[]): LinkActionSummary[] {
  return actions.filter((action) => action.execution?.locallyExecutable !== false);
}
