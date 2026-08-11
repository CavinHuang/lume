import { describe, expect, test } from "bun:test";
import { findRestorableLinkOAuthSession, getSupportedLinkActions, isValidLinkConnectionName, resolveLinkOAuthSetupState } from "./link-provider-state";

describe("resolveLinkOAuthSetupState", () => {
  test("OAuth-only provider requires runtime configuration before its first connection", () => {
    expect(resolveLinkOAuthSetupState(["oauth2"], false)).toBe("required");
  });

  test("alternative account authentication keeps an unconfigured OAuth app optional", () => {
    expect(resolveLinkOAuthSetupState(["oauth2", "api_key"], false)).toBe("optional");
  });

  test("configured OAuth and providers without OAuth are distinct states", () => {
    expect(resolveLinkOAuthSetupState(["oauth2"], true)).toBe("configured");
    expect(resolveLinkOAuthSetupState(["api_key"], false)).toBe("not_supported");
  });
});

describe("isValidLinkConnectionName", () => {
  test("matches the OpenConnector connection locator contract", () => {
    expect(isValidLinkConnectionName("work-account_2")).toBe(true);
    expect(isValidLinkConnectionName(" 工作账户 ")).toBe(false);
    expect(isValidLinkConnectionName("-work")).toBe(false);
    expect(isValidLinkConnectionName("a".repeat(65))).toBe(false);
  });
});

describe("getSupportedLinkActions", () => {
  test("hides catalog-only actions while retaining legacy runtimes without execution metadata", () => {
    const actions = [
      { id: "github.read", service: "github", name: "read", execution: { locallyExecutable: true, catalogOnly: false } },
      { id: "github.catalog_only", service: "github", name: "catalog_only", execution: { locallyExecutable: false, catalogOnly: true } },
      { id: "github.legacy", service: "github", name: "legacy" },
    ];
    expect(getSupportedLinkActions(actions).map((action) => action.id)).toEqual(["github.read", "github.legacy"]);
  });
});

describe("findRestorableLinkOAuthSession", () => {
  const sessions = [
    { state: "work-state", service: "github", connectionName: "work", authorizationUrl: "https://example.test/work", status: "pending" as const },
    { state: "done-state", service: "github", connectionName: "done", authorizationUrl: "https://example.test/done", status: "authorized" as const },
  ];

  test("restores the exact named account", () => {
    expect(findRestorableLinkOAuthSession(sessions, "github", "work")?.state).toBe("work-state");
  });

  test("restores a single pending account when the create dialog started unnamed", () => {
    expect(findRestorableLinkOAuthSession(sessions, "github", "")?.connectionName).toBe("work");
    expect(findRestorableLinkOAuthSession([
      ...sessions,
      { state: "personal-state", service: "github", connectionName: "personal", authorizationUrl: "https://example.test/personal", status: "pending" },
    ], "github", "")).toBeUndefined();
  });
});
