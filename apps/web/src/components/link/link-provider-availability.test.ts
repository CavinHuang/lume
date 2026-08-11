import { describe, expect, test } from "bun:test";
import { canCreateLinkConnection, canStartLinkConnectionFlow, isLinkProviderVisible } from "./link-provider-availability";

describe("Link provider availability", () => {
  test("hides public-callback providers only when no manageable account exists", () => {
    expect(isLinkProviderVisible("intercom", "local", "http://127.0.0.1:51234", false)).toBe(false);
    expect(isLinkProviderVisible("intercom", "local", "http://127.0.0.1:51234", true)).toBe(true);
    expect(isLinkProviderVisible("gmail", "local", "http://127.0.0.1:51234", false)).toBe(true);
  });

  test("does not let an existing account enable creation of another account", () => {
    expect(canCreateLinkConnection("intercom", "local", "http://127.0.0.1:51234")).toBe(false);
    expect(canCreateLinkConnection("sunoapi", "remote", "https://connector.example.com")).toBe(true);
  });

  test("blocks OAuth reconnects without blocking callback-free account management", () => {
    const origin = "http://127.0.0.1:51234";
    expect(canStartLinkConnectionFlow("intercom", "local", origin, "reconnect", "oauth2")).toBe(false);
    expect(canStartLinkConnectionFlow("intercom", "local", origin, "reconnect", "api_key")).toBe(true);
    expect(canStartLinkConnectionFlow("intercom", "local", origin, "create", "api_key")).toBe(false);
  });

  test("rejects loopback and private callback origins", () => {
    for (const origin of [
      "http://localhost:51234",
      "https://127.0.0.2",
      "https://10.0.0.5",
      "https://100.64.0.1",
      "https://169.254.1.1",
      "https://172.16.0.1",
      "https://192.168.0.1",
      "https://[fd00::1]",
      "https://[fe80::1]",
      "https://[::ffff:10.0.0.5]",
      "https://connector.internal",
      "https://nas",
    ]) {
      expect(canCreateLinkConnection("intercom", "remote", origin)).toBe(false);
    }
  });

  test("accepts public callback hosts", () => {
    expect(canCreateLinkConnection("intercom", "remote", "https://connector.example.com")).toBe(true);
    expect(canCreateLinkConnection("intercom", "remote", "https://8.8.8.8")).toBe(true);
    expect(canCreateLinkConnection("intercom", "remote", "https://[2606:4700:4700::1111]")).toBe(true);
  });
});
