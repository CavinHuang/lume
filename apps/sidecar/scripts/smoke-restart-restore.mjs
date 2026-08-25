import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)));
const SIDECAR_EXECUTABLE = process.env.LUME_SMOKE_EXECUTABLE || process.execPath;
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");

function normalizePathForAssert(value) {
  return typeof value === "string" ? value.replace(/\\/g, "/") : "";
}

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

    const projectRoot = join(configHome, "smoke-project");
    mkdirSync(projectRoot, { recursive: true });
    const workspace = await sidecar.call("agent:create-workspace", {
      name: "Smoke Project",
      projectPath: projectRoot
    });
    assert(typeof workspace?.id === "string", "project workspace missing");
    assert(typeof workspace?.slug === "string" && workspace.slug.length > 0, "default workspace slug missing");
    const workspaceRoot = await sidecar.call(AGENT_GET_WORKSPACE_ROOT_PATH, { workspaceSlug: workspace.slug });
    assert(
      typeof workspaceRoot === "string"
      && normalizePathForAssert(workspaceRoot).includes(`/agent-workspaces/${workspace.slug}`),
      "workspace root missing"
    );

    const initialLumeConfig = await sidecar.call(LUME_CONFIG_GET_EFFECTIVE, { workspaceSlug: workspace.slug });
    assert(initialLumeConfig?.version === 1, "lume-config:get-effective unavailable");
    assert(
      typeof initialLumeConfig?.sourcePath === "string"
      && normalizePathForAssert(initialLumeConfig.sourcePath).endsWith("/.lume/lume.yaml"),
      "lume-config sourcePath invalid"
    );

    writeSmokeLumeConfig(configHome, workspace.slug);
    const effectiveLumeConfig = await sidecar.call(LUME_CONFIG_GET_EFFECTIVE, { workspaceSlug: workspace.slug });
    assert(
      effectiveLumeConfig?.models?.agent?.defaultModelRef === "openai/smoke-workspace-model",
      "lume.yaml workspace overlay not applied"
    );

    const thread = await sidecar.call("agent:create-thread", {
      title: "smoke-restore-thread",
      workspaceId: workspace.id,
      modelId: "restore-agent-model",
      channelId: "restore-agent-channel"
    });
    assert(typeof thread?.id === "string", "thread create failed");

    // #528：ui-state:get/update RPC 已删除（生产零引用），改用同文件存储的活入口
    // general-settings:update/get 验证持久化设置跨进程重启还原，保持 smoke 意图不变。
    const updatedSettings = await sidecar.call("general-settings:update", {
      themeMode: "dark",
      agentMessageDisplayMode: "verbose"
    });
    assert(updatedSettings?.themeMode === "dark", "general-settings write failed for themeMode");
    assert(updatedSettings?.agentMessageDisplayMode === "verbose", "general-settings write failed for display mode");

    await sidecar.close();
    sidecar = createSidecarProcess(configHome);

    const restoredSettings = await sidecar.call("general-settings:get");
    assert(restoredSettings?.themeMode === "dark", "themeMode not restored after restart");
    assert(restoredSettings?.agentMessageDisplayMode === "verbose", "agentMessageDisplayMode not restored after restart");

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

    assert(existsSync(workspaceRoot), "workspace metadata root missing after restart");
    assert(existsSync(projectRoot), "project root missing after restart");

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
