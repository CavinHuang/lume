import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)));
const SIDECAR_EXECUTABLE = process.env.LUME_SMOKE_EXECUTABLE || process.execPath;
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");

function ensureAgentSdkBuilt() {
  const sdkDistEntry = resolve(REPO_ROOT, "packages/sdk/dist/index.js");
  if (existsSync(sdkDistEntry)) {
    return;
  }

  const result = spawnSync(SIDECAR_EXECUTABLE, ["run", "--filter", "@lume/agent-sdk", "build"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: process.env
  });

  if (result.status !== 0 || !existsSync(sdkDistEntry)) {
    throw new Error("agent sdk build failed");
  }
}

function resolveSidecarEntry() {
  if (process.env.LUME_SMOKE_USE_DIST === "1") {
    return resolve(SCRIPT_DIR, "../dist/index.js");
  }
  const distEntry = resolve(SCRIPT_DIR, "../dist/index.js");
  const srcEntry = resolve(SCRIPT_DIR, "../src/index.ts");
  if (process.env.LUME_SMOKE_USE_SRC === "1") {
    return srcEntry;
  }
  if (!existsSync(distEntry)) {
    return srcEntry;
  }
  return srcEntry;
}

function createSidecarProcess(configHome) {
  const sidecarEntry = resolveSidecarEntry();

  const env = { ...process.env };
  env.HOME = configHome;
  env.USERPROFILE = configHome;

  const child = spawn(SIDECAR_EXECUTABLE, [sidecarEntry], {
    stdio: ["pipe", "pipe", "inherit"],
    env
  });

  let nextId = 1;
  const pending = new Map();
  const rl = createInterface({ input: child.stdout });

  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    if (msg.id === undefined) {
      return;
    }

    const item = pending.get(msg.id);
    if (!item) {
      return;
    }

    pending.delete(msg.id);
    if (msg.error) {
      item.reject(new Error(msg.error.message || "rpc error"));
    } else {
      item.resolve(msg.result);
    }
  });

  const call = (method, params = null) =>
    new Promise((resolvePromise, rejectPromise) => {
      const id = nextId++;
      pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });

  const close = async () => {
    rl.close();
    child.kill();
    await new Promise((resolvePromise) => child.once("exit", resolvePromise));
  };

  return { call, close };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function run() {
  const configHome = mkdtempSync(join(tmpdir(), "lume-sidecar-restart-restore-"));
  let sidecar = null;

  try {
    ensureAgentSdkBuilt();
    sidecar = createSidecarProcess(configHome);
    const health = await sidecar.call("healthcheck");
    assert(health?.ok === true, "healthcheck failed");

    const workspace = await sidecar.call("agent:ensure-default-workspace");
    assert(typeof workspace?.id === "string", "default workspace missing");
    assert(typeof workspace?.slug === "string" && workspace.slug.length > 0, "default workspace slug missing");
    const workspaceRoot = await sidecar.call(AGENT_GET_WORKSPACE_ROOT_PATH, { workspaceSlug: workspace.slug });
    assert(typeof workspaceRoot === "string" && workspaceRoot.includes("\\agent-workspaces\\default"), "workspace root missing");

    const initialLumeConfig = await sidecar.call(LUME_CONFIG_GET_EFFECTIVE, { workspaceSlug: workspace.slug });
    assert(initialLumeConfig?.version === 1, "lume-config:get-effective unavailable");
    assert(typeof initialLumeConfig?.sourcePath === "string" && initialLumeConfig.sourcePath.endsWith("\\.lume\\lume.yaml"), "lume-config sourcePath invalid");

    writeSmokeLumeConfig(configHome, workspace.slug);
    const effectiveLumeConfig = await sidecar.call(LUME_CONFIG_GET_EFFECTIVE, { workspaceSlug: workspace.slug });
    assert(
      effectiveLumeConfig?.models?.agent?.defaultModelRef === "openai/smoke-workspace-model",
      "lume.yaml workspace overlay not applied"
    );

    const conversation = await sidecar.call("chat:create-conversation", {
      title: "smoke-restore-chat",
      modelId: "restore-model",
      channelId: "restore-channel"
    });
    assert(typeof conversation?.id === "string", "conversation create failed");

    const thread = await sidecar.call("agent:create-thread", {
      title: "smoke-restore-thread",
      workspaceId: workspace.id,
      modelId: "restore-agent-model",
      channelId: "restore-agent-channel"
    });
    assert(typeof thread?.id === "string", "thread create failed");

    const updatedState = await sidecar.call("ui-state:update", {
      appMode: "agent",
      activeView: "settings",
      currentConversationId: conversation.id,
      currentAgentThreadId: thread.id,
      currentAgentWorkspaceId: workspace.id,
      promptSidebarOpen: true,
      agentSidePanelOpenByThreadId: {
        [thread.id]: false
      },
      chatDraftByConversationId: {
        [conversation.id]: "restore chat draft"
      },
      agentDraftByThreadId: {
        [thread.id]: "restore agent draft"
      }
    });
    assert(updatedState?.currentConversationId === conversation.id, "ui-state write failed for conversation");
    assert(updatedState?.currentAgentThreadId === thread.id, "ui-state write failed for thread");
    assert(updatedState?.currentAgentWorkspaceId === workspace.id, "ui-state write failed for workspace");
    assert(updatedState?.activeView === "settings", "ui-state write failed for activeView");
    assert(updatedState?.promptSidebarOpen === true, "ui-state write failed for promptSidebarOpen");
    assert(updatedState?.agentSidePanelOpenByThreadId?.[thread.id] === false, "ui-state write failed for side panel");
    assert(updatedState?.chatDraftByConversationId?.[conversation.id] === "restore chat draft", "ui-state write failed for chat draft");
    assert(updatedState?.agentDraftByThreadId?.[thread.id] === "restore agent draft", "ui-state write failed for agent draft");

    await sidecar.close();
    sidecar = createSidecarProcess(configHome);

    const restoredState = await sidecar.call("ui-state:get");
    assert(restoredState?.appMode === "agent", "ui-state appMode not restored");
    assert(restoredState?.activeView === "settings", "ui-state activeView not restored");
    assert(restoredState?.currentConversationId === conversation.id, "ui-state conversation not restored");
    assert(restoredState?.currentAgentThreadId === thread.id, "ui-state thread not restored");
    assert(restoredState?.currentAgentWorkspaceId === workspace.id, "ui-state workspace not restored");
    assert(restoredState?.promptSidebarOpen === true, "ui-state promptSidebarOpen not restored");
    assert(restoredState?.agentSidePanelOpenByThreadId?.[thread.id] === false, "ui-state side panel not restored");
    assert(restoredState?.chatDraftByConversationId?.[conversation.id] === "restore chat draft", "ui-state chat draft not restored");
    assert(restoredState?.agentDraftByThreadId?.[thread.id] === "restore agent draft", "ui-state agent draft not restored");

    const conversations = await sidecar.call("chat:list-conversations");
    assert(
      Array.isArray(conversations) && conversations.some((item) => item.id === conversation.id),
      "conversation metadata missing after restart"
    );

    const threads = await sidecar.call("agent:list-threads");
    assert(
      Array.isArray(threads) && threads.some((item) => item.id === thread.id),
      "thread metadata missing after restart"
    );

    const workspaces = await sidecar.call("agent:list-workspaces");
    assert(
      Array.isArray(workspaces) && workspaces.some((item) => item.id === workspace.id),
      "workspace metadata missing after restart"
    );

    const workspaceEntries = await import("node:fs").then(({ readdirSync }) => readdirSync(workspaceRoot));
    assert(workspaceEntries.includes("resources"), "workspace resources dir missing");
    assert(workspaceEntries.includes(".meta"), "workspace .meta dir missing");
    assert(workspaceEntries.includes("threads"), "workspace threads dir missing");
    assert(!workspaceEntries.includes("BOOTSTRAP.md"), "workspace BOOTSTRAP.md should not exist");
    assert(!workspaceEntries.includes(".claude-plugin"), "workspace .claude-plugin should not exist");

    console.log("SMOKE_RESTART_RESTORE_OK");
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

const AGENT_GET_WORKSPACE_ROOT_PATH = "agent:get-workspace-root-path";
const LUME_CONFIG_GET_EFFECTIVE = "lume-config:get-effective";
const LUME_CONFIG_FILE_NAME = "lume.yaml";

function writeSmokeLumeConfig(configHome, workspaceSlug) {
  const lumeDir = join(configHome, ".lume");
  mkdirSync(lumeDir, { recursive: true });
  const lumeYamlPath = join(lumeDir, LUME_CONFIG_FILE_NAME);
  writeFileSync(
    lumeYamlPath,
    `version: 1
models:
  agent:
    defaultModelRef: openai/smoke-global-model
workspaces:
  ${workspaceSlug}:
    models:
      agent:
        defaultModelRef: openai/smoke-workspace-model
`,
    "utf-8"
  );
}

run().catch((error) => {
  console.error("SMOKE_RESTART_RESTORE_FAIL", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
