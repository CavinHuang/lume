import { describe, expect, test } from "bun:test";
import {
  listPendingDesktopActionRequests,
  submitDesktopActionDecision,
  waitForDesktopActionDecision,
} from "./desktop-action-session";

describe("desktop action session", () => {
  test("blocks until one-time approval and never offers persistent approval", async () => {
    const controller = new AbortController();
    const request = {
      threadId: "thread-1",
      requestId: "desktop-1",
      toolUseId: "tool-1",
      app: { id: "wechat.exe", name: "微信" },
      action: "click" as const,
      targetLabel: "发送",
      risk: "critical" as const,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      summary: "在微信中点击发送",
    };
    const waiting = waitForDesktopActionDecision(request, controller.signal, () => {});

    expect(listPendingDesktopActionRequests()).toEqual([request]);
    expect(submitDesktopActionDecision({
      threadId: "thread-1",
      requestId: "desktop-1",
      decision: "allow_once",
    })).toBe(true);
    expect(await waiting).toBe(true);
    expect(listPendingDesktopActionRequests()).toEqual([]);
  });

  test("expires without executing when the user does not respond", async () => {
    const result = await waitForDesktopActionDecision({
      threadId: "thread-expired",
      requestId: "desktop-expired",
      toolUseId: "tool-expired",
      app: { id: "wechat.exe", name: "微信" },
      action: "click",
      targetLabel: "发送",
      risk: "critical",
      expiresAt: new Date(Date.now() + 5).toISOString(),
      summary: "在微信中点击发送",
    }, new AbortController().signal, () => {});

    expect(result).toBe(false);
    expect(listPendingDesktopActionRequests()).toEqual([]);
  });
});
