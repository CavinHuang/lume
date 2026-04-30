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
  env.LUME_PI_AGENT_MOCK_SUCCESS = "1";
  env.LUME_PI_AGENT_MOCK_TEXT = "smoke-provider-switch";

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

async function sendAndWait(sidecar, payload) {
  const completion = sidecar.waitForNotification(
    RUN_EVENT_METHOD,
    (params) => params?.threadId === payload.threadId && params?.event?.type === "run_completed",
    12000
  );
  await sidecar.call("agent:send-thread-message", payload);
  await completion;
}

async function run() {
  const configHome = mkdtempSync(join(tmpdir(), "lume-sidecar-agent-provider-switch-"));
  let sidecar = null;

  try {
    sidecar = createSidecarProcess(configHome);
    const health = await sidecar.call("healthcheck");
    assert(health?.ok === true, "healthcheck failed");

    const workspace = await sidecar.call("agent:ensure-default-workspace");
    assert(typeof workspace?.id === "string", "default workspace not ready");

    const anthropicChannel = await sidecar.call("channel:create", {
      name: "smoke-provider-anthropic",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-smoke-dummy",
      models: [{ id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet", enabled: true }],
      defaultModelId: "claude-sonnet-4-5-20250929",
      enabled: true
    });
    const zaiCompatChannel = await sidecar.call("channel:create", {
      name: "smoke-provider-zai-compat",
      provider: "zhipu",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      apiKey: "sk-smoke-dummy",
      models: [{ id: "zai/non-existent-catalog-model", name: "GLM Custom", enabled: true }],
      defaultModelId: "zai/non-existent-catalog-model",
      enabled: true
    });

    const session = await sidecar.call("agent:create-thread", {
      title: "smoke-agent-provider-switch",
      workspaceId: workspace.id,
      channelId: anthropicChannel.id,
      modelId: "claude-sonnet-4-5-20250929"
    });
    assert(typeof session?.id === "string", "agent session create failed");

    await sendAndWait(sidecar, {
      threadId: session.id,
      userMessage: "first provider run",
      workspaceId: workspace.id,
      channelId: anthropicChannel.id,
      modelId: "claude-sonnet-4-5-20250929",
      permissionMode: "bypassPermissions"
    });

    const switched = await sidecar.call("agent:update-thread-model-selection", {
      threadId: session.id,
      channelId: zaiCompatChannel.id,
      modelId: "zai/non-existent-catalog-model"
    });
    assert(switched?.channelId === zaiCompatChannel.id, "session channel switch failed");
    assert(switched?.modelId === "zai/non-existent-catalog-model", "session model switch failed");

    await sendAndWait(sidecar, {
      threadId: session.id,
      userMessage: "second provider run",
      workspaceId: workspace.id,
      channelId: zaiCompatChannel.id,
      modelId: "zai/non-existent-catalog-model",
      permissionMode: "bypassPermissions"
    });

    await sidecar.close();
    sidecar = createSidecarProcess(configHome);

    const sessions = await sidecar.call("agent:list-threads");
    const restored = sessions.find((item) => item.id === session.id);
    assert(restored?.channelId === zaiCompatChannel.id, "restored session channelId mismatch");
    assert(restored?.modelId === "zai/non-existent-catalog-model", "restored session modelId mismatch");

    const messages = await sidecar.call("agent:get-thread-messages", { threadId: session.id });
    assert(Array.isArray(messages), "messages not readable after restart");
    const assistantModels = messages
      .filter((item) => item.role === "assistant")
      .map((item) => item.model);
    assert(assistantModels.includes("anthropic/claude-sonnet-4-5-20250929"), "anthropic assistant message missing");
    assert(assistantModels.includes("zai/non-existent-catalog-model"), "zai fallback assistant message missing");

    console.log("SMOKE_AGENT_NEW_RUNTIME_PROVIDER_SWITCH_OK");
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
  console.error("SMOKE_AGENT_NEW_RUNTIME_PROVIDER_SWITCH_FAIL", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
