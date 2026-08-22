import { describe, expect, test, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { sdkFetch } from "./web-request.js";

const curlBin = process.platform === "win32" ? "curl.exe" : "curl";

const hasCurl = await new Promise<boolean>((resolve) => {
  const child = spawn(curlBin, ["--version"], { stdio: "ignore", windowsHide: true });
  child.on("error", () => resolve(false));
  child.on("close", (code) => resolve(code === 0));
});

// A local HTTP "proxy": requests forwarded by curl arrive here with an
// absolute-form request line and we answer regardless of the target host.
let respond: (req: Request) => Response | Promise<Response>;
const server = Bun.serve({
  port: 0,
  fetch(req) {
    return respond(req);
  },
});
const proxyUrl = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));

function withProxyEnv(): () => void {
  const saved = {
    HTTP_PROXY: process.env.HTTP_PROXY,
    http_proxy: process.env.http_proxy,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    https_proxy: process.env.https_proxy,
    NO_PROXY: process.env.NO_PROXY,
    no_proxy: process.env.no_proxy,
  };
  process.env.HTTP_PROXY = proxyUrl;
  delete process.env.http_proxy;
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
  delete process.env.NO_PROXY;
  delete process.env.no_proxy;
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete (process.env as Record<string, string | undefined>)[key];
      else process.env[key] = value;
    }
  };
}

describe.skipIf(!hasCurl)("sdkFetch proxy path (#339)", () => {
  test("sends request bodies over stdin, past the Windows argv size cap", async () => {
    const restore = withProxyEnv();
    try {
      const bigBody = "x".repeat(60_000); // > ~32K Windows argv entry limit
      let receivedLength = -1;
      respond = async (req) => {
        receivedLength = (await req.text()).length;
        return new Response("ok-body", { status: 200 });
      };
      const response = await sdkFetch("http://example.com/upload", {
        method: "POST",
        body: bigBody,
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok-body");
      expect(receivedLength).toBe(bigBody.length);
    } finally {
      restore();
    }
  });

  test("accepts responses beyond the old 4MB execFile maxBuffer", async () => {
    const restore = withProxyEnv();
    try {
      const payload = Buffer.alloc(5 * 1024 * 1024, 65); // 5MB of 'A'
      respond = () => new Response(payload, { status: 200, headers: { "content-type": "application/octet-stream" } });
      const response = await sdkFetch("http://example.com/big.bin");
      expect(response.status).toBe(200);
      expect((await response.arrayBuffer()).byteLength).toBe(5 * 1024 * 1024);
    } finally {
      restore();
    }
  });
});
