import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import type { LumeLogEventInput } from "@lume/shared";
import { acknowledgeLogBatch, flushLogTransport, setLogBatchNotificationWriter } from "../../../infra/logger";
import { buildNodeReplChildEnv, JsonlNodeReplRuntimeClient } from "./node-repl-runtime-manager";

describe("node_repl trusted bundled runtimes", () => {
  test("grants only the permissions backed by bundled trusted clients", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-node-repl-computer-use-"));
    try {
      const client = join(root, "computer-use", "scripts", "computer-use-client.mjs");
      const browserClient = join(root, "browser", "scripts", "browser-client.mjs");
      await mkdir(join(root, "computer-use", "scripts"), { recursive: true });
      await mkdir(join(root, "browser", "scripts"), { recursive: true });
      await writeFile(client, "export const ready = true", "utf8");
      await writeFile(browserClient, "export const ready = true", "utf8");

      const enabled = buildNodeReplChildEnv({
        BASE: "value",
        LUME_BUNDLED_PLUGINS_DIR: root,
      });
      expect(JSON.parse(enabled.LUME_CUA_RUNTIME_MANIFEST!)).toMatchObject({
        permissions: ["computerUse", "browser"],
      });
      expect(enabled.NODE_REPL_TRUSTED_CODE_PATHS?.split(delimiter)).toEqual([client, browserClient]);

      const disabled = buildNodeReplChildEnv({ BASE: "value" });
      expect(disabled.LUME_CUA_RUNTIME_MANIFEST).toBeUndefined();
      expect(disabled.NODE_REPL_TRUSTED_CODE_PATHS).toBeUndefined();

      const existingClient = join(root, "existing-client.mjs");
      const merged = buildNodeReplChildEnv({
        LUME_BUNDLED_PLUGINS_DIR: root,
        LUME_CUA_RUNTIME_MANIFEST: JSON.stringify({
          name: "existing-runtime",
          permissions: ["legacy", "browser"],
          allowedModules: ["node:path"],
        }),
        NODE_REPL_TRUSTED_CODE_PATHS: existingClient,
      });
      expect(JSON.parse(merged.LUME_CUA_RUNTIME_MANIFEST!)).toMatchObject({
        name: "existing-runtime",
        permissions: ["legacy", "browser", "computerUse"],
        allowedModules: ["node:path"],
      });
      expect(merged.NODE_REPL_TRUSTED_CODE_PATHS?.split(delimiter)).toEqual([
        existingClient,
        client,
        browserClient,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function createStderrIngester() {
  const runtime = new JsonlNodeReplRuntimeClient({
    threadId: "thread-1",
    cwd: ".",
    hostPath: "host.mjs",
    kernelPath: "kernel.js",
    nodePath: "node",
  });
  return runtime as unknown as { ingestStderrChunk(chunk: string): void; stderr: string };
}

function captureLogEvents(): { events: LumeLogEventInput[]; cleanup: () => void } {
  const events: LumeLogEventInput[] = [];
  const batchIds: string[] = [];
  setLogBatchNotificationWriter((batch) => {
    events.push(...batch.events);
    batchIds.push(batch.batchId);
  });
  // flush 后补 ack：不能在 writer 回调里同步 ack（trySendBatch 随后重置 inFlight，
  // 残留的 inFlight 会阻塞同进程内下一次 flush）。
  return {
    events,
    cleanup: () => {
      flushLogTransport();
      for (const batchId of batchIds.splice(0)) acknowledgeLogBatch(batchId);
      setLogBatchNotificationWriter(null);
    },
  };
}

describe("JsonlNodeReplRuntimeClient stderr LUMELOG ingestion", () => {
  test("structured lines go to the sidecar logger; plain and malformed lines stay as diagnostics", () => {
    const ingester = createStderrIngester();
    const { events, cleanup } = captureLogEvents();
    try {
      ingester.ingestStderrChunk('LUMELOG {"level":"fatal","context":"repl.lifecycle","event":"run.failed","message":"boom","data":{"code":7}}\n');
      ingester.ingestStderrChunk('LUMELOG not-json\n');
      ingester.ingestStderrChunk("plain diagnostic\n");
      flushLogTransport();
      expect(events).toContainEqual(expect.objectContaining({
        level: "error",
        context: "repl.lifecycle",
        event: "run.failed",
        message: "boom",
        source: "sidecar",
        data: { code: 7 },
      }));
      expect(ingester.stderr).toBe("LUMELOG not-json\nplain diagnostic\n");
    } finally {
      cleanup();
    }
  });

  test("a LUMELOG line split across chunks is buffered and parsed once", () => {
    const ingester = createStderrIngester();
    const { events, cleanup } = captureLogEvents();
    try {
      ingester.ingestStderrChunk('LUMELOG {"level":"warn","context":"host.pipe"');
      expect(ingester.stderr).toBe("");
      ingester.ingestStderrChunk(',"event":"pipe.error","message":"m"}\n');
      flushLogTransport();
      expect(events).toContainEqual(expect.objectContaining({
        level: "warn",
        context: "host.pipe",
        event: "pipe.error",
        message: "m",
      }));
      expect(ingester.stderr).toBe("");
    } finally {
      cleanup();
    }
  });
});
