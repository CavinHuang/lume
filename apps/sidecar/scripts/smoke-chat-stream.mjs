import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)));
const STREAM_CHUNK_METHOD = "chat:stream:chunk";
const STREAM_COMPLETE_METHOD = "chat:stream:complete";

function createSidecarProcess(configHome) {
  const sidecarEntry = resolve(SCRIPT_DIR, "../dist/index.js");
  const env = { ...process.env };
  env.HOME = configHome;
  env.USERPROFILE = configHome;
  env.LUME_CHAT_MOCK_SUCCESS = "1";
  env.LUME_CHAT_MOCK_TEXT = "chat-smoke-success";

  const child = spawn(process.execPath, [sidecarEntry], {
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
  const configHome = mkdtempSync(join(tmpdir(), "lume-sidecar-chat-smoke-"));
  let sidecar = null;

  try {
    sidecar = createSidecarProcess(configHome);
    const health = await sidecar.call("healthcheck");
    assert(health?.ok === true, "healthcheck failed");

    const conversation = await sidecar.call("chat:create-conversation", {
      title: "smoke-chat-stream",
      modelId: "mock-model",
      channelId: "mock-channel"
    });
    assert(typeof conversation?.id === "string", "conversation create failed");

    const waitChunk = sidecar.waitForNotification(
      STREAM_CHUNK_METHOD,
      (params) => params?.conversationId === conversation.id,
      12000
    );
    const waitComplete = sidecar.waitForNotification(
      STREAM_COMPLETE_METHOD,
      (params) => params?.conversationId === conversation.id,
      12000
    );

    await sidecar.call("chat:send-message", {
      conversationId: conversation.id,
      userMessage: "chat smoke",
      messageHistory: [],
      channelId: "mock-channel",
      modelId: "mock-model"
    });

    const chunkEvent = await waitChunk;
    assert(typeof chunkEvent?.delta === "string" && chunkEvent.delta.includes("chat-smoke-success"), "missing chunk payload");

    await waitComplete;

    const messages = await sidecar.call("chat:get-messages", { conversationId: conversation.id });
    assert(Array.isArray(messages), "messages missing");
    assert(messages.some((m) => m.role === "assistant" && typeof m.content === "string" && m.content.includes("chat-smoke-success")), "assistant message missing");

    console.log("SMOKE_CHAT_STREAM_OK");
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
  console.error("SMOKE_CHAT_STREAM_FAIL", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
