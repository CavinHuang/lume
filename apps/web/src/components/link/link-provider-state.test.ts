import { describe, expect, test } from "bun:test";
import { isValidLinkConnectionName, resolveLinkOAuthSetupState } from "./link-provider-state";

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
