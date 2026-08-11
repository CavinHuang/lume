import { describe, expect, test } from "bun:test";
import { isLinkProviderAvailable } from "./link-provider-availability";

describe("Link provider availability", () => {
  test("hides public-callback providers only for new local connections", () => {
    expect(isLinkProviderAvailable("intercom", "local", "http://127.0.0.1:51234", false)).toBe(false);
    expect(isLinkProviderAvailable("sunoapi", "local", "http://127.0.0.1:51234", false)).toBe(false);
    expect(isLinkProviderAvailable("gmail", "local", "http://127.0.0.1:51234", false)).toBe(true);
  });

  test("requires a non-loopback remote origin for new callback providers", () => {
    expect(isLinkProviderAvailable("intercom", "remote", "https://connector.example.test", false)).toBe(true);
    expect(isLinkProviderAvailable("intercom", "remote", "http://localhost:51234", false)).toBe(false);
    expect(isLinkProviderAvailable("intercom", "remote", "http://[::1]:51234", false)).toBe(false);
    expect(isLinkProviderAvailable("sunoapi", "local", "http://127.0.0.1:51234", true)).toBe(true);
  });
});
