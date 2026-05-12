import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { assertInteractionSmokeOutcome } from "./lib/agent-runtime-interactions-smoke";

const SCRIPT_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)));
const RUN_EVENT_METHOD = "agent:run:event";
const TOOL_PERMISSION_REQUEST_METHOD = "agent:tool-permission-request";
const ASK_USER_QUESTION_METHOD = "agent:ask-user-question";
const SUBAGENT_COMPLETED_METHOD = "agent:subagent-completed";
const RUNTIME_STATUS_CHANGED_METHOD = "agent:runtime-status-changed";
const SIDECAR_EXECUTABLE = process.env.LUME_SMOKE_EXECUTABLE || process.execPath;

function createSidecarProcess(configHome) {
  const sidecarEntry = resolve(SCRIPT_DIR, "../dist/index.js");
  const env = { ...process.env };
  env.HOME = configHome;
  env.USERPROFILE = configHome;
  env.LUME_AGENT_RUNTIME = "pi_agent";
  env.LUME_PI_AGENT_MOCK_SUCCESS = "1";
  env.LUME_PI_AGENT_MOCK_TEXT = "smoke-new-runtime-interactions";
  env.LUME_PI_AGENT_MOCK_TOOL_PERMISSION = "1";
  env.LUME_PI_AGENT_MOCK_ASK_USER_QUESTION = "1";
  env.LUME_PI_AGENT_MOCK_SUBAGENT_ANNOUNCE = "1";

  const child = spawn(SIDECAR_EXECUTABLE, [sidecarEntry], {
    stdio: ["pipe", "pipe", "inherit"],
    env
  });

  let nextId = 1;
  const pending = new Map();
  const notificationHandlers = new Set();
  const rl = createInterface({ input: child.stdout });

  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    if (msg.id !== undefined) {
      const item = pending.get(msg.id);
      if (!item) return;
      pending.delete(msg.id);
      if (msg.error) {
        item.reject(new Error(msg.error.message || "rpc error"));
      } else {
        item.resolve(msg.result);
      }
      return;
    }

    if (typeof msg.method === "string") {
      for (const handler of notificationHandlers) {
        handler(msg.method, msg.params);
      }
    }
  });

  const call = (method, params = null) =>
    new Promise((resolvePromise, rejectPromise) => {
      const id = nextId++;
      pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });

  const onNotification = (handler) => {
    notificationHandlers.add(handler);
    return () => notificationHandlers.delete(handler);
  };

  const waitForNotification = (method, predicate, timeoutMs = 8000) =>
    new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        unsubscribe();
        rejectPromise(new Error(`wait notification timeout: ${method}`));
      }, timeoutMs);

      const unsubscribe = onNotification((incomingMethod, params) => {
        if (incomingMethod !== method) return;
        if (predicate && !predicate(params)) return;
        clearTimeout(timer);
        unsubscribe();
        resolvePromise(params);
      });
    });

  const close = async () => {
    rl.close();
    child.kill();
    await new Promise((r) => child.once("exit", r));
  };

  return { call, close, waitForNotification };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function run() {
  const configHome = mkdtempSync(join(tmpdir(), "lume-sidecar-agent-new-runtime-interactions-"));
  let sidecar = null;

  try {
    sidecar = createSidecarProcess(configHome);
    const health = await sidecar.call("healthcheck");
    assert(health?.ok === true, "healthcheck failed");

    const workspace = await sidecar.call("agent:ensure-default-workspace");
    assert(typeof workspace?.id === "string", "default workspace not ready");

    const channel = await sidecar.call("channel:create", {
      name: "smoke-anthropic-new-runtime-interactions",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-smoke-dummy",
      models: [{ id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet", enabled: true }],
      enabled: true
    });
    assert(typeof channel?.id === "string", "channel create failed");

    const session = await sidecar.call("agent:create-thread", {
      title: "smoke-agent-new-runtime-interactions",
      workspaceId: workspace.id,
      channelId: channel.id
    });
    assert(typeof session?.id === "string", "agent session create failed");

    const permissionRequestPromise = sidecar.waitForNotification(
      TOOL_PERMISSION_REQUEST_METHOD,
      (params) => params?.threadId === session.id,
      12000
    );
    const awaitingPermissionStatusPromise = sidecar.waitForNotification(
      RUNTIME_STATUS_CHANGED_METHOD,
      (params) => params?.status?.threadId === session.id && params?.status?.phase === "awaiting_permission",
      12000
    );
    const askUserQuestionPromise = sidecar.waitForNotification(
      ASK_USER_QUESTION_METHOD,
      (params) => params?.threadId === session.id,
      12000
    );
    const awaitingQuestionStatusPromise = sidecar.waitForNotification(
      RUNTIME_STATUS_CHANGED_METHOD,
      (params) => params?.status?.threadId === session.id && params?.status?.phase === "awaiting_user_answer",
      12000
    );
    const subagentCompletedPromise = sidecar.waitForNotification(
      SUBAGENT_COMPLETED_METHOD,
      (params) => params?.threadId === session.id && typeof params?.runId === "string",
      12000
    );
    const runCompletedPromise = sidecar.waitForNotification(
      RUN_EVENT_METHOD,
      (params) => params?.threadId === session.id && params?.event?.type === "run_completed",
      12000
    );

    await sidecar.call("agent:send-thread-message", {
      threadId: session.id,
      userMessage: "smoke new runtime interactions",
      workspaceId: workspace.id,
      channelId: channel.id,
      modelId: "claude-sonnet-4-5-20250929",
      permissionMode: "default"
    });

    const permissionRequest = await permissionRequestPromise;
    const awaitingPermissionStatus = await awaitingPermissionStatusPromise;
    await sidecar.call("agent:submit-tool-permission", {
      threadId: session.id,
      requestId: permissionRequest.requestId,
      decision: "allow_once"
    });

    const askUserRequest = await askUserQuestionPromise;
    const awaitingQuestionStatus = await awaitingQuestionStatusPromise;
    const completedStatusPromise = sidecar.waitForNotification(
      RUNTIME_STATUS_CHANGED_METHOD,
      (params) => params?.status?.threadId === session.id && params?.status?.phase === "completed",
      12000
    );
    await sidecar.call("agent:submit-ask-user-question", {
      threadId: session.id,
      toolUseId: askUserRequest.toolUseId,
      answers: {
        scope: "continue"
      }
    });

    const subagentCompletedEvent = await subagentCompletedPromise;
    await runCompletedPromise;
    const completedStatus = await completedStatusPromise;

    const listSubagentRuns = await sidecar.call("agent:list-subagent-runs", {
      ownerSessionId: session.id,
      limit: 10
    });

    await sidecar.close();
    sidecar = createSidecarProcess(configHome);

    const restoredSubagentRuns = await sidecar.call("agent:list-subagent-runs", {
      ownerSessionId: session.id,
      limit: 10
    });
    const restoredRuntimeStatus = await sidecar.call("agent:get-runtime-status", { threadId: session.id });
    const messages = await sidecar.call("agent:get-thread-messages", { threadId: session.id });
    assert(Array.isArray(messages), "messages not readable after interactions restart");

    assertInteractionSmokeOutcome({
      permissionRequest,
      askUserRequest,
      statusPhases: [
        awaitingPermissionStatus.status.phase,
        awaitingQuestionStatus.status.phase,
        completedStatus.status.phase
      ],
      restoredRuntimeStatus,
      listSubagentRuns,
      restoredSubagentRuns,
      subagentCompletedEvent,
      messages
    });

    console.log("SMOKE_AGENT_NEW_RUNTIME_BRIDGES_OK");
  } finally {
    if (sidecar) {
      try {
        await sidecar.close();
      } catch {
        // ignore
      }
    }
    rmSync(configHome, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error("SMOKE_AGENT_NEW_RUNTIME_BRIDGES_FAIL", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
