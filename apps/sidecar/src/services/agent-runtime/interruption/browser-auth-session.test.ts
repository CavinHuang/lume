import { afterEach, describe, expect, test } from "bun:test";
import {
  listPendingBrowserAuthRequests,
  submitBrowserAuthResponse,
  waitForBrowserAuthResponse
} from "./browser-auth-session";

describe("browser auth session", () => {
  afterEach(async () => {
    await submitBrowserAuthResponse({
      threadId: "thread-1",
      requestId: "auth-1",
      status: "cancelled"
    });
  });

  test("lists only non-secret metadata and resolves waiters with submitted values", async () => {
    const emitted: unknown[] = [];
    const pending = waitForBrowserAuthResponse(
      {
        threadId: "thread-1",
        requestId: "auth-1",
        origin: "https://accounts.example.test",
        reason: "Sign in.",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        fields: [{
          id: "password",
          label: "Password",
          type: "password",
          autocomplete: "current-password",
          required: true
        }]
      },
      new AbortController().signal,
      (request) => emitted.push(request)
    );

    const listed = listPendingBrowserAuthRequests();
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("password-value");
    expect(JSON.stringify(emitted)).not.toContain("password-value");

    await submitBrowserAuthResponse({
      threadId: "thread-1",
      requestId: "auth-1",
      status: "submitted",
      values: { password: "password-value" }
    });

    await expect(pending).resolves.toEqual({
      status: "submitted",
      values: { password: "password-value" }
    });
    expect(listPendingBrowserAuthRequests()).toEqual([]);
  });
});
