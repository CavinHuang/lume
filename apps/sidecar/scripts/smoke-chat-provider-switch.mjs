import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)));
const STREAM_COMPLETE_METHOD = "chat:stream:complete";

function createSidecarProcess(configHome) {
  const sidecarEntry = resolve(SCRIPT_DIR, "../dist/index.js");
  if (!existsSync(sidecarEntry)) {
    throw new Error(`sidecar build missing: ${sidecarEntry}`);
  }
  const env = { ...process.env };
  env.HOME = configHome;
  env.USERPROFILE = configHome;
  env.LUME_CHAT_MOCK_SUCCESS = "1";
  env.LUME_CHAT_MOCK_TEXT = "chat-provider-switch";

  const child = spawn(process.execPath, [sidecarEntry], {
    stdio: ["pipe", "pipe", "inherit"],
    env
  });
  child.once("error", (error) => {
    console.error("SMOKE_CHAT_PROVIDER_SWITCH_CHILD_ERROR", error instanceof Error ? error.message : String(error));
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
    (params) => params?.conversationId === payload.conversationId,
    12000
  );
  await sidecar.call("chat:send-message", payload);
  await completion;
}

async function run() {
  const configHome = mkdtempSync(join(tmpdir(), "lume-sidecar-chat-provider-switch-"));
  let sidecar = null;

  try {
    sidecar = createSidecarProcess(configHome);
    const health = await sidecar.call("healthcheck");
    assert(health?.ok === true, "healthcheck failed");

    const openaiChannel = await sidecar.call("channel:create", {
      name: "chat-provider-openai",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-smoke-dummy",
      models: [{ id: "gpt-4.1-mini", name: "GPT-4.1 Mini", enabled: true }],
      defaultModelId: "gpt-4.1-mini",
      enabled: true
    });
    const anthropicChannel = await sidecar.call("channel:create", {
      name: "chat-provider-anthropic",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-smoke-dummy",
      models: [{ id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet", enabled: true }],
      defaultModelId: "claude-sonnet-4-5-20250929",
      enabled: true
    });

    const conversation = await sidecar.call("chat:create-conversation", {
      title: "smoke-chat-provider-switch",
      modelId: "gpt-4.1-mini",
      channelId: openaiChannel.id
    });
    assert(typeof conversation?.id === "string", "conversation create failed");

    await sendAndWait(sidecar, {
      conversationId: conversation.id,
      userMessage: "chat first provider run",
      messageHistory: [],
      channelId: openaiChannel.id,
      modelId: "gpt-4.1-mini"
    });

    const updated = await sidecar.call("chat:update-conversation-model", {
      conversationId: conversation.id,
      channelId: anthropicChannel.id,
      modelId: "claude-sonnet-4-5-20250929"
    });
    assert(updated?.channelId === anthropicChannel.id, "conversation channel switch failed");
    assert(updated?.modelId === "claude-sonnet-4-5-20250929", "conversation model switch failed");

    const history = await sidecar.call("chat:get-messages", { conversationId: conversation.id });
    assert(Array.isArray(history), "conversation history missing before second send");

    await sendAndWait(sidecar, {
      conversationId: conversation.id,
      userMessage: "chat second provider run",
      messageHistory: history,
      channelId: anthropicChannel.id,
      modelId: "claude-sonnet-4-5-20250929"
    });

    await sidecar.close();
    sidecar = createSidecarProcess(configHome);

    const conversations = await sidecar.call("chat:list-conversations");
    const restored = conversations.find((item) => item.id === conversation.id);
    assert(restored?.channelId === anthropicChannel.id, "restored conversation channelId mismatch");
    assert(restored?.modelId === "claude-sonnet-4-5-20250929", "restored conversation modelId mismatch");

    const messages = await sidecar.call("chat:get-messages", { conversationId: conversation.id });
    assert(Array.isArray(messages), "messages not readable after restart");
    const assistantModels = messages
      .filter((item) => item.role === "assistant")
      .map((item) => item.model);
    assert(assistantModels.includes("gpt-4.1-mini"), "openai assistant message missing");
    assert(assistantModels.includes("claude-sonnet-4-5-20250929"), "anthropic assistant message missing");

    console.log("SMOKE_CHAT_PROVIDER_SWITCH_OK");
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
  console.error("SMOKE_CHAT_PROVIDER_SWITCH_FAIL", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
