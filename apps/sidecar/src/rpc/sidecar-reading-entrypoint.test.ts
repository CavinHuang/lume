import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  READING_IPC_CHANNELS,
  WEREAD_IPC_CHANNELS
} from "@lume/shared";
import { isNativeAvailable } from "@lume/natives";

type RpcResponse = {
  id?: number;
  result?: unknown;
  error?: {
    message?: string;
  };
};

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type SidecarClient = {
  call: (method: string, params?: unknown) => Promise<unknown>;
  close: () => Promise<void>;
  stderr: () => string;
};

function createSidecarClient(configDir: string): SidecarClient {
  const sidecarCwd = resolve(import.meta.dir, "../..");
  const child = spawn(process.execPath, ["src/index.ts"], {
    cwd: sidecarCwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: configDir,
      USERPROFILE: configDir,
      LUME_CONFIG_DIR: configDir,
      LUME_AUTOMATION_RUNNER_AUTOSTART: "false",
      LUME_DEFAULT_SKILLS_AUTOSTART: "false",
      LUME_IM_AUTOSTART: "false",
      LUME_LOG_FILE: "false",
      LUME_READING_RUNNER_AUTOSTART: "false"
    }
  });

  let nextId = 1;
  let stderrText = "";
  let closed = false;
  const pending = new Map<number, PendingCall>();
  const rl = createInterface({ input: child.stdout });

  child.stderr.on("data", (chunk) => {
    stderrText = `${stderrText}${String(chunk)}`.slice(-4_000);
  });

  child.once("exit", () => {
    closed = true;
    for (const call of pending.values()) {
      clearTimeout(call.timeout);
      call.reject(new Error(`sidecar exited before RPC response: ${stderrText}`));
    }
    pending.clear();
  });

  rl.on("line", (line) => {
    let message: RpcResponse;
    try {
      message = JSON.parse(line) as RpcResponse;
    } catch {
      return;
    }
    if (message.id === undefined) {
      return;
    }
    const call = pending.get(message.id);
    if (!call) {
      return;
    }
    pending.delete(message.id);
    clearTimeout(call.timeout);
    if (message.error) {
      call.reject(new Error(message.error.message ?? "sidecar RPC error"));
      return;
    }
    call.resolve(message.result);
  });

  const call = (method: string, params?: unknown): Promise<unknown> =>
    new Promise((resolvePromise, rejectPromise) => {
      if (closed || !child.stdin.writable) {
        rejectPromise(new Error(`sidecar is not writable: ${stderrText}`));
        return;
      }
      const id = nextId++;
      const timeout = setTimeout(() => {
        pending.delete(id);
        rejectPromise(new Error(`sidecar RPC timed out: ${method}\n${stderrText}`));
      }, 5_000);
      pending.set(id, {
        resolve: resolvePromise,
        reject: rejectPromise,
        timeout
      });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });

  const close = async (): Promise<void> => {
    rl.close();
    for (const item of pending.values()) {
      clearTimeout(item.timeout);
      item.reject(new Error("sidecar client closed"));
    }
    pending.clear();
    if (closed) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolvePromise) => {
      child.once("exit", () => resolvePromise());
      setTimeout(() => {
        if (!closed) child.kill("SIGKILL");
        resolvePromise();
      }, 1_000);
    });
  };

  return {
    call,
    close,
    stderr: () => stderrText
  };
}

describe.skipIf(!isNativeAvailable())("sidecar Reading entrypoint", () => {
  let tempConfigDir = "";
  let sidecar: SidecarClient | undefined;

  beforeEach(() => {
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-reading-entrypoint-"));
  });

  afterEach(async () => {
    if (sidecar) {
      await sidecar.close();
      sidecar = undefined;
    }
    if (tempConfigDir) {
      rmSync(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = "";
    }
  });

  test("desktop sidecar process exposes active Reading and WeRead RPC methods", async () => {
    sidecar = createSidecarClient(tempConfigDir);

    const methods = await sidecar.call("rpc:list-methods") as string[];

    expect(methods).toEqual(expect.arrayContaining([
      READING_IPC_CHANNELS.GET_SNAPSHOT,
      WEREAD_IPC_CHANNELS.GET_SHELF,
      WEREAD_IPC_CHANNELS.GET_NOTEBOOKS,
      WEREAD_IPC_CHANNELS.GET_BOOKMARKS,
      WEREAD_IPC_CHANNELS.GET_REVIEWS,
      WEREAD_IPC_CHANNELS.GET_PUBLIC_REVIEWS
    ]));
  });

});
