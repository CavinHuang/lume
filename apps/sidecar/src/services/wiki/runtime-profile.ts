import type { AgentThreadMeta, WikiSearchScope } from "@lume/shared";

export interface TrustedWikiRuntimeProfile {
  scope: WikiSearchScope;
  explicit: boolean;
}

export function resolveTrustedWikiRuntimeProfile(input: {
  threadMeta?: Pick<AgentThreadMeta, "workspaceId" | "wikiProfile" | "source">;
  workspaceId?: string;
  workspaceExists: boolean;
  threadType?: string;
  chatType?: string;
}): TrustedWikiRuntimeProfile | undefined {
  if (input.threadMeta?.wikiProfile?.kind === "ask-wiki") {
    return { scope: input.threadMeta.wikiProfile.scope, explicit: true };
  }
  if (
    input.threadType !== "main"
    || input.chatType !== "direct"
    || input.threadMeta?.source
    || !input.workspaceExists
    || !input.workspaceId
    || input.threadMeta?.workspaceId !== input.workspaceId
  ) {
    return undefined;
  }
  return {
    scope: { kind: "workspace", workspaceId: input.workspaceId },
    explicit: false
  };
}
