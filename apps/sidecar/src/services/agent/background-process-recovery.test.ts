import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessJob } from "@lume/agent-sdk";
import { createAgentThread, getAgentThreadSDKMessages } from "./agent-thread-manager";
import { persistTerminalProcessJobNotification } from "./background-process-recovery";

let previousConfigDir: string | undefined;

beforeEach(() => {
  previousConfigDir = process.env.LUME_CONFIG_DIR;
  process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-background-recovery-"));
});

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
  else process.env.LUME_CONFIG_DIR = previousConfigDir;
});

test("restart recovery persists one result notification without creating a model turn", () => {
  const thread = createAgentThread("recovered background task", "channel-test");
  const job: ProcessJob = {
    id: "recovered-job",
    subject: "background validation",
    status: "failed",
    threadId: thread.id,
    output: "validation failed"
  };

  persistTerminalProcessJobNotification(job);
  persistTerminalProcessJobNotification(job);

  const notifications = getAgentThreadSDKMessages(thread.id).filter((message) => (
    message.type === "system"
    && message.subtype === "task_notification"
    && message.task_id === job.id
  ));
  expect(notifications).toHaveLength(1);
});
