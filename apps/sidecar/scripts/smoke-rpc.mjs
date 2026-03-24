import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)));
const SIDECAR_EXECUTABLE = process.env.LUME_SMOKE_EXECUTABLE || process.execPath;

function createSidecarProcess(configHome) {
  const sidecarEntry = resolve(SCRIPT_DIR, "../dist/index.js");
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
    await new Promise((r) => child.once("exit", r));
  };

  return { call, close };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function run() {
  const configHome = mkdtempSync(join(tmpdir(), "lume-sidecar-smoke-"));
  let sidecar = null;

  try {
    sidecar = createSidecarProcess(configHome);
    const health = await sidecar.call("healthcheck");
    assert(health?.ok === true, "healthcheck failed");

    const workspace = await sidecar.call("agent:ensure-default-workspace");
    assert(workspace?.slug === "default", "default workspace not ready");

    const session = await sidecar.call("agent:create-session", {
      title: "smoke-session",
      workspaceId: workspace.id
    });
    assert(typeof session?.id === "string", "session create failed");

    const sessionPath = await sidecar.call("agent:get-session-path", {
      workspaceSlug: workspace.slug,
      sessionId: session.id
    });
    assert(typeof sessionPath === "string" && sessionPath.length > 0, "session path missing");

    await sidecar.call("agent:save-files-to-session", {
      workspaceSlug: workspace.slug,
      sessionId: session.id,
      files: [
        {
          filename: "smoke.txt",
          data: Buffer.from("smoke-ok", "utf8").toString("base64")
        }
      ]
    });

    const firstList = await sidecar.call("agent:list-directory", {
      workspaceSlug: workspace.slug,
      sessionId: session.id,
      path: sessionPath
    });
    assert(Array.isArray(firstList) && firstList.some((item) => item.name === "smoke.txt"), "file write/list failed");

    await sidecar.close();
    sidecar = createSidecarProcess(configHome);

    const sessionsAfterRestart = await sidecar.call("agent:list-sessions");
    assert(
      Array.isArray(sessionsAfterRestart) &&
        sessionsAfterRestart.some((item) => item.id === session.id),
      "session restore failed after restart"
    );

    const listAfterRestart = await sidecar.call("agent:list-directory", {
      workspaceSlug: workspace.slug,
      sessionId: session.id,
      path: sessionPath
    });
    assert(
      Array.isArray(listAfterRestart) &&
        listAfterRestart.some((item) => item.name === "smoke.txt"),
      "file restore failed after restart"
    );

    console.log("SMOKE_RPC_OK");
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
  console.error("SMOKE_RPC_FAIL", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
