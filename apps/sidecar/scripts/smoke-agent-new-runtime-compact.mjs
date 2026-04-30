import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  assertCompactSmokeOutcome,
  buildLongCompactionSeedMessages
} from "./lib/agent-runtime-compact-smoke";

const SCRIPT_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)));
const RUNTIME_STATUS_METHOD = "agent:runtime-status-changed";
const RUN_EVENT_METHOD = "agent:run:event";
const SIDECAR_EXECUTABLE = process.env.LUME_SMOKE_EXECUTABLE || process.execPath;
const SEED_TURN_COUNT = Number(process.env.LUME_SMOKE_COMPACT_TURN_COUNT || 6);
const SEED_PAYLOAD_REPEATS = Number(process.env.LUME_SMOKE_COMPACT_PAYLOAD_REPEATS || 4);
const MOCK_TEXT_MARKER = "smoke-new-runtime-compact";
const COMPACTION_SUMMARY = "smoke compaction summary";

function createSidecarProcess(configHome) {
  const sidecarEntry = resolve(SCRIPT_DIR, "../dist/index.js");
  const env = { ...process.env };
  env.HOME = configHome;
  env.USERPROFILE = configHome;
  env.LUME_AGENT_RUNTIME = "pi_agent";
  env.LUME_PI_AGENT_MOCK_SUCCESS = "1";
  env.LUME_PI_AGENT_MOCK_COMPACTION = "1";
  env.LUME_PI_AGENT_MOCK_TEXT = MOCK_TEXT_MARKER;
  env.LUME_PI_AGENT_MOCK_COMPACTION_SUMMARY = COMPACTION_SUMMARY;
  env.LUME_PI_AGENT_MOCK_TRACE_SESSION = "1";

  const child = spawn(SIDECAR_EXECUTABLE, [sidecarEntry], {
    stdio: ["pipe", "pipe", "inherit"],
    env
  });

  let nextId = 1;
  const pending = new Map();
  const notificationHandlers = new Set();
  const notifications = [];
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
      notifications.push({ method: msg.method, params: msg.params });
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

  return { call, close, waitForNotification, notifications };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function collectJsonlFiles(rootDir) {
  if (!existsSync(rootDir)) {
    return [];
  }
  const files = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJsonlFiles(fullPath));
      continue;
    }
    if (entry.isFile() && fullPath.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
  return files;
}

async function run() {
  const configHome = mkdtempSync(join(tmpdir(), "lume-sidecar-agent-new-runtime-compact-"));
  let sidecar = null;

  try {
    sidecar = createSidecarProcess(configHome);
    const health = await sidecar.call("healthcheck");
    assert(health?.ok === true, "healthcheck failed");

    const workspace = await sidecar.call("agent:ensure-default-workspace");
    assert(typeof workspace?.id === "string", "default workspace not ready");

    const channel = await sidecar.call("channel:create", {
      name: "smoke-anthropic-new-runtime-compact",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-smoke-dummy",
      models: [{ id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet", enabled: true }],
      enabled: true
    });
    assert(typeof channel?.id === "string", "channel create failed");

    const session = await sidecar.call("agent:create-thread", {
      title: "smoke-agent-new-runtime-compact",
      workspaceId: workspace.id,
      channelId: channel.id
    });
    assert(typeof session?.id === "string", "agent session create failed");

    const seedMessages = buildLongCompactionSeedMessages({
      turnCount: SEED_TURN_COUNT,
      marker: "compact-seed",
      payloadRepeats: SEED_PAYLOAD_REPEATS
    });
    let completedSeedTurns = 0;
    for (const userMessage of seedMessages) {
      await sidecar.call("agent:send-thread-message", {
        threadId: session.id,
        userMessage,
        workspaceId: workspace.id,
        channelId: channel.id,
        modelId: "claude-sonnet-4-5-20250929",
        permissionMode: "bypassPermissions"
      });

      await sidecar.waitForNotification(
        RUN_EVENT_METHOD,
        (params) => params?.threadId === session.id && params?.event?.type === "run_completed",
        12000
      );
      completedSeedTurns += 1;
    }

    const streamComplete = sidecar.waitForNotification(
      RUN_EVENT_METHOD,
      (params) => params?.threadId === session.id && params?.event?.type === "run_completed",
      12000
    );
    const compactNotificationStartIndex = sidecar.notifications.length;

    await sidecar.call("agent:send-thread-message", {
      threadId: session.id,
      userMessage: "/compact",
      workspaceId: workspace.id,
      channelId: channel.id,
      modelId: "claude-sonnet-4-5-20250929",
      permissionMode: "bypassPermissions"
    });

    await streamComplete;

    const compactEvents = sidecar.notifications
      .slice(compactNotificationStartIndex)
      .filter((item) => item.method === RUNTIME_STATUS_METHOD && item.params?.status?.threadId === session.id)
      .map((item) => {
        const phase = item.params?.status?.phase;
        if (phase === "compacting") return { type: "compacting" };
        if (phase === "completed") return { type: "compact_complete" };
        return null;
      })
      .filter(Boolean);

    await sidecar.close();
    sidecar = createSidecarProcess(configHome);

    const restoredMessages = await sidecar.call("agent:get-thread-messages", { threadId: session.id });
    assert(Array.isArray(restoredMessages), "messages not readable after compact restart");
    const persistedJsonlFiles = collectJsonlFiles(configHome);
    const persistedJsonlContents = persistedJsonlFiles.map((filePath) => readFileSync(filePath, "utf-8"));
    assertCompactSmokeOutcome({
      restoredMessages,
      compactEvents: compactEvents.map((item) => item.params?.event ?? {}),
      persistedJsonlContents,
      completedSeedTurns,
      compactionSummary: COMPACTION_SUMMARY,
      expectedSeedMarker: "compact-seed"
    });

    console.log("SMOKE_AGENT_NEW_RUNTIME_COMPACT_OK");
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
  console.error("SMOKE_AGENT_NEW_RUNTIME_COMPACT_FAIL", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
