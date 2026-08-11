import { describe, expect, test } from "bun:test";
import { isLinkProviderAvailable } from "./link-provider-availability";

describe("Link provider availability", () => {
  test("hides public-callback providers only for new local connections", () => {
    expect(isLinkProviderAvailable("intercom", "local", false)).toBe(false);
    expect(isLinkProviderAvailable("sunoapi", "local", false)).toBe(false);
    expect(isLinkProviderAvailable("gmail", "local", false)).toBe(true);
  });

  test("keeps callback providers manageable when remote or already connected", () => {
    expect(isLinkProviderAvailable("intercom", "remote", false)).toBe(true);
    expect(isLinkProviderAvailable("sunoapi", "local", true)).toBe(true);
  });
});
