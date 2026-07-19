import { describe, expect, test } from "bun:test";
import { resolveTrustedWikiRuntimeProfile } from "./runtime-profile";

describe("trusted Wiki runtime profile", () => {
  test("accepts only a sidecar-stamped explicit Wiki scope", () => {
    expect(resolveTrustedWikiRuntimeProfile({
      threadMeta: { wikiProfile: { kind: "ask-wiki", scope: { kind: "all" } } },
      workspaceExists: false
    })).toEqual({ scope: { kind: "all" }, explicit: true });
  });

  test("grants ordinary read scope only to the matching local direct workspace thread", () => {
    const trusted = resolveTrustedWikiRuntimeProfile({
      threadMeta: { workspaceId: "workspace-1" },
      workspaceId: "workspace-1",
      workspaceExists: true,
      threadType: "main",
      chatType: "direct"
    });
    expect(trusted).toEqual({
      scope: { kind: "workspace", workspaceId: "workspace-1" },
      explicit: false
    });

    expect(resolveTrustedWikiRuntimeProfile({
      threadMeta: { workspaceId: "workspace-1" },
      workspaceId: "workspace-1",
      workspaceExists: true
    })).toEqual({
      scope: { kind: "workspace", workspaceId: "workspace-1" },
      explicit: false
    });

    expect(resolveTrustedWikiRuntimeProfile({
      threadMeta: { workspaceId: "workspace-2" },
      workspaceId: "workspace-1",
      workspaceExists: true,
      threadType: "main",
      chatType: "direct"
    })).toBeUndefined();
    expect(resolveTrustedWikiRuntimeProfile({
      threadMeta: { workspaceId: "workspace-1", source: { type: "im", provider: "test" } },
      workspaceId: "workspace-1",
      workspaceExists: true,
      threadType: "main",
      chatType: "direct"
    })).toBeUndefined();
    expect(resolveTrustedWikiRuntimeProfile({
      threadMeta: { workspaceId: "workspace-1" },
      workspaceId: "workspace-1",
      workspaceExists: true,
      threadType: "main",
      chatType: "group"
    })).toBeUndefined();
  });
});
