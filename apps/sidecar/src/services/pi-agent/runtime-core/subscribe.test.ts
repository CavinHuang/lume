import { describe, expect, test } from "bun:test";
import { projectRuntimeCoreEventToLumeEvents } from "./subscribe";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";

describe("runtime-core subscribe", () => {
  test("应忽略 session 专属自动压缩事件", () => {
    const event = {
      type: "auto_compaction_start",
      reason: "threshold"
    } as AgentSessionEvent;

    expect(projectRuntimeCoreEventToLumeEvents(event)).toEqual([]);
  });
});
