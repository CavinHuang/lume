import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)));
const RUN_EVENT_METHOD = "agent:run:event";
const SIDECAR_EXECUTABLE = process.env.LUME_SMOKE_EXECUTABLE || process.execPath;

function createSidecarProcess(configHome) {
  const sidecarEntry = resolve(SCRIPT_DIR, "../dist/index.js");
  const env = { ...process.env };
  env.HOME = configHome;
  env.USERPROFILE = configHome;
  env.LUME_AGENT_RUNTIME = "pi_agent";
  env.LUME_PI_AGENT_MOCK_ERROR = "1";
  env.LUME_PI_AGENT_MOCK_ERROR_TEXT = "smoke-new-runtime-error";

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
  const configHome = mkdtempSync(join(tmpdir(), "lume-sidecar-agent-new-runtime-error-"));
  let sidecar = null;

  try {
    sidecar = createSidecarProcess(configHome);
    const health = await sidecar.call("healthcheck");
    assert(health?.ok === true, "healthcheck failed");

    const workspace = await sidecar.call("agent:ensure-default-workspace");
    assert(typeof workspace?.id === "string", "default workspace not ready");

    const channel = await sidecar.call("channel:create", {
      name: "smoke-anthropic-new-runtime-error",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-smoke-dummy",
      models: [{ id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet", enabled: true }],
      enabled: true
    });
    assert(typeof channel?.id === "string", "channel create failed");

    const session = await sidecar.call("agent:create-thread", {
      title: "smoke-agent-new-runtime-error",
      workspaceId: workspace.id,
      channelId: channel.id
    });
    assert(typeof session?.id === "string", "agent session create failed");

    await sidecar.call("agent:send-thread-message", {
      threadId: session.id,
      userMessage: "smoke new runtime error",
      workspaceId: workspace.id,
      channelId: channel.id,
      modelId: "claude-sonnet-4-5-20250929",
      permissionMode: "bypassPermissions"
    });

    const errorEvent = await sidecar.waitForNotification(
      RUN_EVENT_METHOD,
      (params) => params?.threadId === session.id && params?.event?.type === "run_failed",
      12000
    );
    const errorMessage = errorEvent?.event?.error?.message;
    assert(
      typeof errorMessage === "string"
      && (
        errorMessage.includes("smoke-new-runtime-error")
        || errorMessage.includes("Pi Agent runtime 执行失败")
      ),
      "unexpected new runtime error payload"
    );

    console.log("SMOKE_AGENT_NEW_RUNTIME_ERROR_OK");
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
  console.error("SMOKE_AGENT_NEW_RUNTIME_ERROR_FAIL", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
