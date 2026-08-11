import { describe, expect, test } from "bun:test";
import { isRecommendedLinkService, linkServicePriority, shouldShowLinkProviderByDefault } from "./provider-ranking";

describe("Link provider recommendation visibility", () => {
  test("recognizes the Wanta recommendation list across service separators", () => {
    expect(isRecommendedLinkService("google_sheets")).toBe(true);
    expect(isRecommendedLinkService("cloudflare-r2")).toBe(true);
    expect(isRecommendedLinkService("github")).toBe(true);
  });

  test("keeps uncommon services outside the default catalog", () => {
    expect(isRecommendedLinkService("accredible_certificates")).toBe(false);
    expect(linkServicePriority("accredible_certificates")).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("never hides an uncommon service that is connected or currently selected", () => {
    expect(shouldShowLinkProviderByDefault("accredible_certificates", false, false)).toBe(false);
    expect(shouldShowLinkProviderByDefault("accredible_certificates", true, false)).toBe(true);
    expect(shouldShowLinkProviderByDefault("accredible_certificates", false, true)).toBe(true);
  });
});
