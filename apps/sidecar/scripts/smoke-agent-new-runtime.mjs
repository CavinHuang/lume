import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)));
const STREAM_EVENT_METHOD = "agent:stream:event";
const STREAM_COMPLETE_METHOD = "agent:stream:complete";
const SIDECAR_EXECUTABLE = process.env.LUME_SMOKE_EXECUTABLE || process.execPath;

function createSidecarProcess(configHome) {
  const sidecarEntry = resolve(SCRIPT_DIR, "../dist/index.js");
  const env = { ...process.env };
  env.HOME = configHome;
  env.USERPROFILE = configHome;
  env.LUME_AGENT_RUNTIME = "pi_agent";
  env.LUME_PI_AGENT_MOCK_SUCCESS = "1";
  env.LUME_PI_AGENT_MOCK_TEXT = "smoke-new-runtime";

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
  const configHome = mkdtempSync(join(tmpdir(), "lume-sidecar-agent-new-runtime-"));
  let sidecar = null;

  try {
    sidecar = createSidecarProcess(configHome);
    const health = await sidecar.call("healthcheck");
    assert(health?.ok === true, "healthcheck failed");

    const workspace = await sidecar.call("agent:ensure-default-workspace");
    assert(typeof workspace?.id === "string", "default workspace not ready");

    const channel = await sidecar.call("channel:create", {
      name: "smoke-anthropic-new-runtime",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-smoke-dummy",
      models: [{ id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet", enabled: true }],
      enabled: true
    });
    assert(typeof channel?.id === "string", "channel create failed");

    const session = await sidecar.call("agent:create-session", {
      title: "smoke-agent-new-runtime",
      workspaceId: workspace.id,
      channelId: channel.id
    });
    assert(typeof session?.id === "string", "agent session create failed");

    const firstTextDelta = sidecar.waitForNotification(
      STREAM_EVENT_METHOD,
      (params) => params?.sessionId === session.id && params?.event?.type === "text_delta",
      12000
    );
    const firstComplete = sidecar.waitForNotification(
      STREAM_COMPLETE_METHOD,
      (params) => params?.sessionId === session.id,
      12000
    );

    await sidecar.call("agent:send-message", {
      sessionId: session.id,
      userMessage: "smoke new runtime first",
      workspaceId: workspace.id,
      channelId: channel.id,
      modelId: "claude-sonnet-4-5-20250929",
      permissionMode: "bypassPermissions"
    });

    await firstTextDelta;
    await firstComplete;

    const secondTextDelta = sidecar.waitForNotification(
      STREAM_EVENT_METHOD,
      (params) => params?.sessionId === session.id && params?.event?.type === "text_delta",
      12000
    );
    const secondComplete = sidecar.waitForNotification(
      STREAM_COMPLETE_METHOD,
      (params) => params?.sessionId === session.id,
      12000
    );

    await sidecar.call("agent:send-message", {
      sessionId: session.id,
      userMessage: "smoke new runtime second",
      workspaceId: workspace.id,
      channelId: channel.id,
      modelId: "claude-sonnet-4-5-20250929",
      permissionMode: "bypassPermissions"
    });

    await secondTextDelta;
    await secondComplete;

    await sidecar.close();
    sidecar = createSidecarProcess(configHome);

    const restoredSessions = await sidecar.call("agent:list-sessions");
    assert(Array.isArray(restoredSessions), "list sessions failed after restart");
    assert(restoredSessions.some((item) => item.id === session.id), "session not restored");

    const messages = await sidecar.call("agent:get-messages", { sessionId: session.id });
    assert(Array.isArray(messages), "messages not restored");
    const restoredAssistantMessages = messages.filter(
      (m) => m.role === "assistant" && typeof m.content === "string" && m.content.includes("smoke-new-runtime")
    );
    assert(restoredAssistantMessages.length >= 2, "assistant multi-turn restore failed");

    console.log("SMOKE_AGENT_NEW_RUNTIME_OK");
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
  console.error("SMOKE_AGENT_NEW_RUNTIME_FAIL", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
