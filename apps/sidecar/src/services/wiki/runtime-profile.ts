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
  const threadType = input.threadType ?? "main";
  const chatType = input.chatType ?? "direct";
  if (
    threadType !== "main"
    || chatType !== "direct"
    || !input.threadMeta
    || input.threadMeta?.source
  ) {
    return undefined;
  }
  if (!input.workspaceId && !input.threadMeta.workspaceId) {
    return {
      scope: { kind: "inbox" },
      explicit: false
    };
  }
  if (
    !input.workspaceExists
    || !input.workspaceId
    || input.threadMeta.workspaceId !== input.workspaceId
  ) return undefined;
  return {
    scope: { kind: "workspace", workspaceId: input.workspaceId },
    explicit: false
  };
}
