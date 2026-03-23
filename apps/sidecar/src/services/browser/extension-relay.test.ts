import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { startRelayServer, stopRelayServer } from "./extension-relay";

describe("extension-relay", () => {
  const prevRelayPort = process.env.LUME_BROWSER_RELAY_PORT;

  afterEach(async () => {
    if (prevRelayPort === undefined) delete process.env.LUME_BROWSER_RELAY_PORT;
    else process.env.LUME_BROWSER_RELAY_PORT = prevRelayPort;
    await stopRelayServer();
  });

  test("端口被占用时应返回受控错误而不是触发未捕获异常", async () => {
    const occupiedServer = createServer();
    await new Promise<void>((resolve, reject) => {
      occupiedServer.once("error", reject);
      occupiedServer.listen(0, "127.0.0.1", resolve);
    });

    try {
      const addr = occupiedServer.address();
      if (!addr || typeof addr === "string") {
        throw new Error("failed to resolve occupied port");
      }

      process.env.LUME_BROWSER_RELAY_PORT = String(addr.port);

      await expect(startRelayServer()).rejects.toThrow(`浏览器 Relay 端口 ${addr.port} 已被占用`);
      await expect(startRelayServer()).rejects.toThrow(`浏览器 Relay 端口 ${addr.port} 已被占用`);
    } finally {
      await new Promise<void>((resolve, reject) => {
        occupiedServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });
});
