import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LumeRuntimeEvent, SDKMessage } from "@lume/shared";
import { LumeRunObserver } from "./run-observer";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("LumeRunObserver retry events", () => {
  test("keeps repeated retry phases distinct across provider fallback routes", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "lume-run-observer-retry-"));
    directories.push(sessionDir);
    const observer = await LumeRunObserver.create({
      sessionDir,
      threadId: "thread-1",
      userMessage: "hello",
      model: { provider: "openai", modelId: "gpt-test" },
    });
    const events: LumeRuntimeEvent[] = [];
    const retryMessage: SDKMessage = {
      type: "system",
      subtype: "api_retry",
      phase: "waiting",
      attempt: 5,
      max_retries: 5,
      retry_delay_ms: 0,
      error_status: 503,
      error: "server_error",
      session_id: "thread-1",
    };

    observer.recordSdkMessage(retryMessage, (event) => events.push(event));
    observer.recordSdkMessage(retryMessage, (event) => events.push(event));
    await observer.flush();

    const retryEvents = events.filter((event) => event.type === "model.retry");
    expect(retryEvents).toHaveLength(2);
    expect(new Set(retryEvents.map((event) => event.id)).size).toBe(2);
    expect(retryEvents.map((event) => event.sequence)).toEqual([0, 1]);
  });
});
