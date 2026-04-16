import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)));
const STREAM_COMPLETE_METHOD = "agent:stream:complete";
const SIDECAR_EXECUTABLE = process.env.LUME_SMOKE_EXECUTABLE || process.execPath;

function createSidecarProcess(configHome) {
  const sidecarEntry = resolve(SCRIPT_DIR, "../dist/index.js");
  const env = { ...process.env };
  env.HOME = configHome;
  env.USERPROFILE = configHome;
  env.LUME_AGENT_RUNTIME = "pi_agent";
  env.LUME_PI_AGENT_MOCK_SUCCESS = "1";
  env.LUME_PI_AGENT_MOCK_TEXT = "smoke-provider-matrix";

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
    STREAM_COMPLETE_METHOD,
    (params) => params?.threadId === payload.threadId,
    12000
  );
  await sidecar.call("agent:send-thread-message", payload);
  await completion;
}

async function run() {
  const configHome = mkdtempSync(join(tmpdir(), "lume-sidecar-agent-provider-matrix-"));
  let sidecar = null;

  const providerCases = [
    {
      providerKey: "anthropic",
      channelInput: {
        name: "matrix-anthropic",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        apiKey: "sk-smoke-dummy",
        models: [{ id: "anthropic/non-existent-anthropic-model", name: "Anthropic Custom", enabled: true }],
        defaultModelId: "anthropic/non-existent-anthropic-model",
        enabled: true
      },
      expectedAssistantModel: "anthropic/non-existent-anthropic-model"
    },
    {
      providerKey: "openai",
      channelInput: {
        name: "matrix-openai",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-smoke-dummy",
        models: [{ id: "openai/non-existent-openai-model", name: "OpenAI Custom", enabled: true }],
        defaultModelId: "openai/non-existent-openai-model",
        enabled: true
      },
      expectedAssistantModel: "openai/non-existent-openai-model"
    },
    {
      providerKey: "google",
      channelInput: {
        name: "matrix-google",
        provider: "google",
        baseUrl: "https://generativelanguage.googleapis.com",
        apiKey: "sk-smoke-dummy",
        models: [{ id: "google/non-existent-google-model", name: "Google Custom", enabled: true }],
        defaultModelId: "google/non-existent-google-model",
        enabled: true
      },
      expectedAssistantModel: "google/non-existent-google-model"
    },
    {
      providerKey: "zai",
      channelInput: {
        name: "matrix-zai-bigmodel-compat",
        provider: "zhipu",
        baseUrl: "https://open.bigmodel.cn/api/anthropic",
        apiKey: "sk-smoke-dummy",
        models: [{ id: "zai/non-existent-zai-model", name: "ZAI Custom", enabled: true }],
        defaultModelId: "zai/non-existent-zai-model",
        enabled: true
      },
      expectedAssistantModel: "zai/non-existent-zai-model"
    }
  ];

  try {
    sidecar = createSidecarProcess(configHome);
    const health = await sidecar.call("healthcheck");
    assert(health?.ok === true, "healthcheck failed");

    const workspace = await sidecar.call("agent:ensure-default-workspace");
    assert(typeof workspace?.id === "string", "default workspace not ready");

    const sessionsByProvider = new Map();

    for (const providerCase of providerCases) {
      const channel = await sidecar.call("channel:create", providerCase.channelInput);
      assert(typeof channel?.id === "string", `channel create failed: ${providerCase.providerKey}`);

      const session = await sidecar.call("agent:create-thread", {
        title: `smoke-provider-matrix-${providerCase.providerKey}`,
        workspaceId: workspace.id,
        channelId: channel.id,
        modelId: providerCase.channelInput.defaultModelId
      });
      assert(typeof session?.id === "string", `session create failed: ${providerCase.providerKey}`);

      await sendAndWait(sidecar, {
        threadId: session.id,
        userMessage: `provider matrix ${providerCase.providerKey}`,
        workspaceId: workspace.id,
        channelId: channel.id,
        modelId: providerCase.channelInput.defaultModelId,
        permissionMode: "bypassPermissions"
      });

      sessionsByProvider.set(providerCase.providerKey, {
        threadId: session.id,
        channelId: channel.id,
        modelId: providerCase.channelInput.defaultModelId,
        expectedAssistantModel: providerCase.expectedAssistantModel
      });
    }

    await sidecar.close();
    sidecar = createSidecarProcess(configHome);

    const sessions = await sidecar.call("agent:list-threads");
    for (const [providerKey, expected] of sessionsByProvider) {
      const restored = sessions.find((item) => item.id === expected.threadId);
      assert(restored?.channelId === expected.channelId, `restored channel mismatch: ${providerKey}`);
      assert(restored?.modelId === expected.modelId, `restored model mismatch: ${providerKey}`);

      const messages = await sidecar.call("agent:get-thread-messages", { threadId: expected.threadId });
      assert(Array.isArray(messages), `messages not readable after restart: ${providerKey}`);
      const assistantModels = messages
        .filter((item) => item.role === "assistant")
        .map((item) => item.model);
      assert(
        assistantModels.includes(expected.expectedAssistantModel),
        `assistant model missing after restart: ${providerKey}`
      );
    }

    console.log("SMOKE_AGENT_NEW_RUNTIME_PROVIDER_MATRIX_OK");
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
  console.error("SMOKE_AGENT_NEW_RUNTIME_PROVIDER_MATRIX_FAIL", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
