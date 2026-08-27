import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createHmac, hkdfSync, randomUUID } from "node:crypto";
import { connect } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ExternalChromeTransport, mapExternalChromeRequest, stableExternalErrorCode } from "./external-chrome-transport";

const token = Buffer.from("round2-bridge-token").toString("base64url");
const pairingId = "pairing-test-01";
const pairingGeneration = 7;
const request = { requestId: "req-1", context: { actor: "agent" as const, browserSessionId: "s", browserTurnId: "t" }, method: "list" };
const endpoint = () => process.platform === "win32" ? `\\\\.\\pipe\\lume-browser-${randomUUID()}` : join(tmpdir(), `lume-browser-${randomUUID()}.sock`);

test("external Chrome keeps stable reference grant errors", () => {
  assert.equal(stableExternalErrorCode("reference_grant_expired"), "reference_grant_expired");
  assert.equal(stableExternalErrorCode("tab_generation_changed"), "tab_generation_changed");
  assert.equal(stableExternalErrorCode("action_denied"), "action_denied");
});

test("external bridge authenticates a connected native host and correlates requests", async () => {
  const bridge = new ExternalChromeTransport({ endpoint: endpoint(), token, pairingId, generation: pairingGeneration, requestTimeoutMs: 500 });
  await bridge.start();
  const sent: any[] = [];
  const peer: any = { send: (value: unknown) => sent.push(value), close: () => peer.onClose?.() };
  (bridge as any).attachPeer(peer);
  assert.equal(bridge.isAvailable(), false);
  const secure = authenticate(peer, sent);
  assert.equal(sent.at(-1).result.ok, true);
  assert.equal(bridge.isAvailable(), true);
  const response = bridge.request(request);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const outbound = decodeFrame(sent.at(-1), secure.key, 1);
  assert.equal(outbound.method, "list_tabs");
  peer.onMessage(encodeFrame({ jsonrpc: "2.0", id: outbound.id, result: { tabs: [] } }, secure.key, 1));
  assert.deepEqual(await response, { tabs: [] });
  await bridge.close();
});

test("external bridge accepts responses above the former 2MB frame limit", async () => {
  const pipe = endpoint();
  const bridge = new ExternalChromeTransport({ endpoint: pipe, token, pairingId, generation: pairingGeneration, requestTimeoutMs: 2_000 });
  await bridge.start();
  const client = connect(pipe);
  await new Promise<void>((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  const challenge = await readJsonLine(client) as any;
  const nonceHost = "native-host-large-frame";
  const hostBuild = "test-build";
  const transcript = `2|${pairingId}|${pairingGeneration}|${challenge.params.nonceMain}|${nonceHost}|${hostBuild}`;
  client.write(`${JSON.stringify({ jsonrpc: "2.0", id: "hello", method: "app.hello", params: {
    pairingId,
    generation: pairingGeneration,
    nonceHost,
    hostBuild,
    proofHost: hmac(Buffer.from(token, "base64url"), `host\n${transcript}`),
    appServerProtocolVersion: 2,
    nativeHostProtocolVersion: 5,
  } })}\n`);
  await readJsonLine(client);
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(token, "base64url"), Buffer.from(`${challenge.params.nonceMain}\0${nonceHost}`), Buffer.from("lume-browser-bridge-v1"), 32));

  const response = bridge.request(request);
  const outbound = decodeFrame(await readJsonLine(client), key, 1);
  const data = "x".repeat(2 * 1024 * 1024 + 1);
  client.write(`${JSON.stringify(encodeFrame({ jsonrpc: "2.0", id: outbound.id, result: { data } }, key, 1))}\n`);
  assert.equal(((await response) as { data: string }).data.length, data.length);
  assert.equal(bridge.isAvailable(), true);

  client.destroy();
  await bridge.close();
});

test("external bridge reports disconnected in-flight requests as executed_unknown", async () => {
  const bridge = new ExternalChromeTransport({ endpoint: endpoint(), token, pairingId, generation: pairingGeneration, requestTimeoutMs: 500 });
  await bridge.start();
  const sent: any[] = [];
  const peer: any = { send: (value: unknown) => sent.push(value), close: () => undefined };
  (bridge as any).attachPeer(peer);
  authenticate(peer, sent);
  const response = bridge.request(request);
  await new Promise<void>((resolve) => setImmediate(resolve));
  peer.onClose();

  await assert.rejects(response, (error: Error & { code?: string }) => error.code === "executed_unknown");
  await bridge.close();
});

test("external bridge rejects bad authentication and fails pending work on disconnect", async () => {
  let disconnected = false;
  const bridge = new ExternalChromeTransport({ endpoint: endpoint(), token, pairingId, generation: pairingGeneration, requestTimeoutMs: 500, onStateChange: (state) => { if (!state.connected) disconnected = true; } });
  await bridge.start();
  const sent: any[] = [];
  const peer: any = { send: (value: unknown) => sent.push(value), close: () => peer.onClose?.() };
  (bridge as any).attachPeer(peer);
  const challenge = sent[0].params;
  peer.onMessage({ jsonrpc: "2.0", id: "hello", method: "app.hello", params: { pairingId, generation: pairingGeneration, nonceHost: "bad-nonce", hostBuild: "test", proofHost: "wrong", appServerProtocolVersion: 2, nativeHostProtocolVersion: 5, nonceMain: challenge.nonceMain } });
  assert.equal(bridge.isAvailable(), false);
  assert.equal(disconnected, true);
  await assert.rejects(() => bridge.request(request), /browser_unavailable/);
  await bridge.close();
});

test("external bridge rejects replayed and tampered authenticated frames", async () => {
  const bridge = new ExternalChromeTransport({ endpoint: endpoint(), token, pairingId, generation: pairingGeneration, requestTimeoutMs: 500 });
  await bridge.start();
  const sent: any[] = [];
  const peer: any = { send: (value: unknown) => sent.push(value), close: () => peer.onClose?.() };
  (bridge as any).attachPeer(peer);
  const secure = authenticate(peer, sent);
  const frame = encodeFrame({ jsonrpc: "2.0", id: "unknown", result: null }, secure.key, 1);
  peer.onMessage(frame);
  assert.equal(bridge.isAvailable(), true);
  peer.onMessage(frame);
  assert.equal(bridge.isAvailable(), false);
  await bridge.close();
});

test("external bridge closes an attached socket without hanging", async () => {
  const pipe = endpoint();
  const bridge = new ExternalChromeTransport({ endpoint: pipe, token, pairingId, generation: pairingGeneration, requestTimeoutMs: 500 });
  await bridge.start();
  const client = connect(pipe);
  await new Promise<void>((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  await Promise.race([
    bridge.close(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("bridge close timed out")), 1_000)),
  ]);
  assert.equal(bridge.isAvailable(), false);
  client.destroy();
});

test("external Chrome mapping preserves locator input and existing-tab operations", () => {
  const base = { requestId: "req-map", context: { actor: "agent" as const, browserSessionId: "s", browserTurnId: "t" } };
  assert.equal(mapExternalChromeRequest({ ...base, method: "openTabs" }).method, "browser_user_open_tabs");
  assert.equal(mapExternalChromeRequest({ ...base, method: "claim", params: { tabId: "chrome-tab:7" } }).method, "browser_user_claim_tab");
  assert.equal(mapExternalChromeRequest({ ...base, method: "mark", params: { tabId: "chrome-tab:7", status: "handoff" } }).method, "mark_tab");
  assert.equal(mapExternalChromeRequest({ ...base, method: "referenceGrant:create", params: { tabId: "chrome-tab:7" } }).method, "browser_user_create_reference_grant");
  assert.equal(mapExternalChromeRequest({ ...base, method: "referenceGrant:revoke", params: { referenceGrantId: "grant-1" } }).method, "browser_user_revoke_reference_grant");
  assert.deepEqual(mapExternalChromeRequest({ ...base, method: "fill", params: { tabId: "tab-1", locator: { version: 1, steps: [] }, value: "hello" } }).params.text, "hello");
  assert.deepEqual(mapExternalChromeRequest({ ...base, method: "select", params: { tabId: "tab-1", locator: { version: 1, steps: [] }, values: ["one"] } }).params.value, ["one"]);
  assert.deepEqual(mapExternalChromeRequest({ ...base, method: "ensure", params: { url: "https://example.test" } }).params.options, { url: "https://example.test", active: true });
  assert.equal(mapExternalChromeRequest({ ...base, method: "elementInfo", params: { tabId: "tab-1", x: 10, y: 20 } }).method, "playwright_element_info");
  assert.equal(mapExternalChromeRequest({ ...base, method: "evaluate:readonly", params: { tabId: "tab-1", script: "(arg) => arg.title" } }).method, "playwright_evaluate");
  assert.equal(mapExternalChromeRequest({ ...base, method: "clipboard:readText", params: { tabId: "tab-1" } }).method, "tab_clipboard_read_text");
  assert.equal(mapExternalChromeRequest({ ...base, method: "content:export", params: { tabId: "tab-1" } }).method, "tab_content_export");
  assert.deepEqual(
    mapExternalChromeRequest({ ...base, method: "dialog:handle", params: { tabId: "tab-1", dialogId: "dialog-1", accept: true, promptText: "Lume" } }),
    {
      method: "tab_handle_js_dialog",
      params: {
        context: base.context,
        tabId: "tab-1",
        dialogId: "dialog-1",
        accept: true,
        promptText: "Lume",
        tab_id: "tab-1",
        action: "accept",
        dialog_id: "dialog-1",
        prompt_text: "Lume",
      },
    },
  );
  assert.equal(mapExternalChromeRequest({ ...base, method: "wait:filechooser", params: { tabId: "tab-1" } }).method, "playwright_wait_for_file_chooser");
  assert.equal(mapExternalChromeRequest({ ...base, method: "filechooser:setFiles", params: { tabId: "tab-1", fileChooserId: "chooser-1", __authorizedFiles: ["C:\\task\\file.txt"] } }).method, "playwright_file_chooser_set_files");
  assert.equal(mapExternalChromeRequest({ ...base, method: "pageAssets:list", params: { tabId: "tab-1" } }).method, "tab_page_assets_list");
  assert.deepEqual(
    mapExternalChromeRequest({ ...base, method: "webmcp:invoke", params: { tabId: "tab-1", toolName: "search", input: { query: "Lume" } } }),
    {
      method: "webmcp_invoke_tool",
      params: {
        context: base.context,
        tabId: "tab-1",
        toolName: "search",
        input: { query: "Lume" },
        tool_name: "search",
        timeout_ms: undefined,
      },
    },
  );
  assert.equal(mapExternalChromeRequest({ ...base, method: "locator:evaluate", params: { tabId: "tab-1", locator: { version: 1, steps: [] }, expression: "(element) => element.textContent" } }).method, "playwright_locator_evaluate");
  assert.equal(mapExternalChromeRequest({ ...base, method: "cdp", params: { tabId: "tab-1", method: "DOM.getDocument" } }).method, "tab_cdp_call");
  assert.equal(mapExternalChromeRequest({ ...base, method: "cookieExport", params: { cursor: 200 } }).method, "browser_user_export_cookies");
});

function authenticate(peer: any, sent: any[]): { key: Buffer } {
  const challenge = sent[0].params;
  const nonceHost = "native-host-test-nonce";
  const hostBuild = "test-build";
  const transcript = `2|${pairingId}|${pairingGeneration}|${challenge.nonceMain}|${nonceHost}|${hostBuild}`;
  peer.onMessage({ jsonrpc: "2.0", id: "hello", method: "app.hello", params: {
    pairingId,
    generation: pairingGeneration,
    nonceHost,
    hostBuild,
    proofHost: hmac(Buffer.from(token, "base64url"), `host\n${transcript}`),
    appServerProtocolVersion: 2,
    nativeHostProtocolVersion: 5,
  } });
  assert.equal(sent.at(-1).result.proofMain, hmac(Buffer.from(token, "base64url"), `main\n${transcript}`));
  return { key: Buffer.from(hkdfSync("sha256", Buffer.from(token, "base64url"), Buffer.from(`${challenge.nonceMain}\0${nonceHost}`), Buffer.from("lume-browser-bridge-v1"), 32)) };
}

function hmac(key: Buffer, value: string | Buffer): string { return createHmac("sha256", key).update(value).digest("base64url"); }
function encodeFrame(value: unknown, key: Buffer, sequence: number): unknown {
  const payload = Buffer.from(JSON.stringify(value));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(sequence));
  return { sequence, payload: payload.toString("base64url"), mac: hmac(key, Buffer.concat([counter, payload])) };
}
function decodeFrame(envelope: any, key: Buffer, sequence: number): any {
  assert.equal(envelope.sequence, sequence);
  const payload = Buffer.from(envelope.payload, "base64url");
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(sequence));
  assert.equal(envelope.mac, hmac(key, Buffer.concat([counter, payload])));
  return JSON.parse(payload.toString("utf8"));
}

const socketBuffers = new WeakMap<import("node:net").Socket, Buffer>();
async function readJsonLine(socket: import("node:net").Socket): Promise<unknown> {
  while (true) {
    const buffered = socketBuffers.get(socket) ?? Buffer.alloc(0);
    const newline = buffered.indexOf(10);
    if (newline >= 0) {
      socketBuffers.set(socket, buffered.subarray(newline + 1));
      return JSON.parse(buffered.subarray(0, newline).toString("utf8"));
    }
    const chunk = await new Promise<Buffer>((resolve, reject) => {
      socket.once("data", resolve);
      socket.once("error", reject);
    });
    socketBuffers.set(socket, Buffer.concat([buffered, chunk]));
  }
}
