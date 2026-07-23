import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { BrowserActionRequest } from "@lume/shared";
import type { BrowserMainTransport } from "./browser-broker";

const APP_SERVER_PROTOCOL_VERSION = 2;
const NATIVE_HOST_PROTOCOL_VERSION = 5;
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type BridgePeer = {
  send: (value: unknown) => void;
  close: () => void;
  onMessage?: (value: unknown) => void;
  onClose?: () => void;
};

export type ExternalChromeTransportOptions = {
  endpoint?: string;
  token?: string;
  pairingId?: string;
  generation?: number;
  hostPath?: string;
  hostSha256?: string;
  requestTimeoutMs?: number;
  onStateChange?: (state: { connected: boolean; generation: number; endpoint?: string }) => void;
};

/**
 * Lume owns this app server. The Native Host connects to it; Lume never
 * attempts to connect to a guessed Chrome endpoint.
 */
export class ExternalChromeTransport implements BrowserMainTransport {
  private readonly timeoutMs: number;
  private readonly endpoint?: string;
  private token?: Buffer;
  private readonly pairingId?: string;
  private readonly pairingGeneration?: number;
  private readonly hostPath?: string;
  private readonly hostSha256?: string;
  private readonly onStateChange?: ExternalChromeTransportOptions["onStateChange"];
  private server: Server | null = null;
  private peer: BridgePeer | null = null;
  private startPromise: Promise<void> | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly seenIds = new Set<string>();
  private sequence = 1;
  private generation = 1;
  private closed = false;

  constructor(options: ExternalChromeTransportOptions = {}) {
    this.timeoutMs = Math.max(100, options.requestTimeoutMs ?? 10_000);
    this.onStateChange = options.onStateChange;
    if (options.endpoint) this.endpoint = validateBridgeEndpoint(options.endpoint);
    if (options.token) this.token = Buffer.from(options.token, "base64url");
    if (options.pairingId && /^[A-Za-z0-9_-]{8,96}$/.test(options.pairingId)) this.pairingId = options.pairingId;
    if (Number.isSafeInteger(options.generation) && Number(options.generation) > 0) this.pairingGeneration = Number(options.generation);
    if (options.hostPath) this.hostPath = validateNativeHostPath(options.hostPath);
    if (options.hostSha256 && /^[a-f0-9]{64}$/i.test(options.hostSha256)) this.hostSha256 = options.hostSha256.toLowerCase();
  }

  get boundEndpoint(): string | undefined { return this.server ? this.endpoint : undefined; }
  get hostGeneration(): number { return this.generation; }
  isAvailable(): boolean { return this.peer !== null && this.server !== null; }

  async start(): Promise<void> {
    if (!this.token && this.hostPath && this.hostSha256 && this.pairingId) this.token = readPairingKey(this.hostPath, this.hostSha256, this.pairingId);
    if (this.closed || this.server || !this.endpoint || !this.token?.length || !this.pairingId || !this.pairingGeneration) return;
    if (this.startPromise) return this.startPromise;
    if (process.platform !== "win32" && existsSync(this.endpoint)) {
      if (!lstatSync(this.endpoint).isSocket()) throw new Error("external browser socket path is not a socket");
      rmSync(this.endpoint, { force: true });
    }
    this.startPromise = new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => {
        if (this.peer) {
          socket.destroy();
          return;
        }
        this.attachPeer(new LineJsonPeer(socket));
      });
      server.once("error", reject);
      server.listen(this.endpoint, () => {
        server.removeListener("error", reject);
        this.server = server;
        resolve();
      });
    }).finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async request(request: BrowserActionRequest): Promise<unknown> {
    await this.start();
    const peer = this.peer;
    if (!peer) throw new Error("browser_unavailable");
    const id = `lume-broker-${Date.now()}-${this.sequence++}`;
    if (this.seenIds.has(id)) throw new Error("browser_replay_rejected");
    this.seenIds.add(id);
    const mapped = mapExternalChromeRequest(request);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("external browser request timed out"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        sendSecure(peer, { jsonrpc: "2.0", id, method: mapped.method, params: mapped.params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.dropPeer(new Error("external browser bridge closed"));
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform !== "win32" && this.endpoint) rmSync(this.endpoint, { force: true });
  }

  private attachPeer(peer: BridgePeer): void {
    peer.onMessage = (message) => this.handleMessage(peer, message);
    peer.onClose = () => { if (this.peer === peer) this.dropPeer(new Error("external browser bridge disconnected")); };
    this.peer = peer;
    this.onStateChange?.({ connected: false, generation: this.generation, endpoint: this.endpoint });
    const nonceMain = randomBytes(24).toString("base64url");
    setPeerHandshake(peer, { nonceMain });
    peer.send({ jsonrpc: "2.0", method: "app.challenge", params: { protocolVersion: APP_SERVER_PROTOCOL_VERSION, pairingId: this.pairingId, generation: this.pairingGeneration, nonceMain } });
    const timer = setTimeout(() => {
      if (this.peer === peer) { peer.close(); this.dropPeer(new Error("external browser handshake timed out")); }
    }, this.timeoutMs);
    (peer as BridgePeer & { handshakeTimer?: ReturnType<typeof setTimeout> }).handshakeTimer = timer;
  }

  private handleMessage(peer: BridgePeer, value: unknown): void {
    if (this.peer !== peer || !isRecord(value)) return;
    if (!peerAuthenticated(peer)) {
      if (value.method !== "app.hello" || typeof value.id !== "string") {
        peer.close();
        this.dropPeer(new Error("external browser authentication required"));
        return;
      }
      const params = isRecord(value.params) ? value.params : {};
      const handshake = getPeerHandshake(peer);
      const nonceHost = typeof params.nonceHost === "string" ? params.nonceHost : "";
      const hostBuild = typeof params.hostBuild === "string" ? params.hostBuild : "";
      const transcript = `${APP_SERVER_PROTOCOL_VERSION}|${this.pairingId}|${this.pairingGeneration}|${handshake.nonceMain}|${nonceHost}|${hostBuild}`;
      const validProof = typeof params.proofHost === "string" && verifyMac(this.token!, "host\n" + transcript, params.proofHost);
      if (!validProof || !/^[A-Za-z0-9_-]{16,128}$/.test(nonceHost) || !/^[A-Za-z0-9._-]{1,64}$/.test(hostBuild) || params.pairingId !== this.pairingId || params.generation !== this.pairingGeneration || params.appServerProtocolVersion !== APP_SERVER_PROTOCOL_VERSION || params.nativeHostProtocolVersion !== NATIVE_HOST_PROTOCOL_VERSION) {
        peer.close();
        this.dropPeer(new Error("external browser authentication failed"));
        return;
      }
      markPeerAuthenticated(peer);
      setPeerSession(peer, deriveSessionKey(this.token!, handshake.nonceMain, nonceHost));
      const handshakeTimer = (peer as BridgePeer & { handshakeTimer?: ReturnType<typeof setTimeout> }).handshakeTimer;
      if (handshakeTimer) clearTimeout(handshakeTimer);
      peer.send({ jsonrpc: "2.0", id: value.id, result: { ok: true, proofMain: signMac(this.token!, "main\n" + transcript), appServerProtocolVersion: APP_SERVER_PROTOCOL_VERSION, nativeHostProtocolVersion: NATIVE_HOST_PROTOCOL_VERSION } });
      this.generation += 1;
      this.onStateChange?.({ connected: true, generation: this.generation, endpoint: this.endpoint });
      return;
    }
    let message: Record<string, any>;
    try { message = receiveSecure(peer, value); } catch {
      peer.close();
      this.dropPeer(new Error("external browser secure frame rejected"));
      return;
    }
    if (typeof message.id === "string" && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (isRecord(message.error)) pending.reject(new Error(stableExternalErrorCode(message.error.code)));
      else pending.resolve(message.result);
    }
  }

  private dropPeer(error: Error): void {
    const peer = this.peer;
    this.peer = null;
    if (peer) {
      const handshakeTimer = (peer as BridgePeer & { handshakeTimer?: ReturnType<typeof setTimeout> }).handshakeTimer;
      if (handshakeTimer) clearTimeout(handshakeTimer);
      peer.close();
    }
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    this.generation += 1;
    this.onStateChange?.({ connected: false, generation: this.generation, endpoint: this.endpoint });
  }
}

function peerAuthenticated(peer: BridgePeer): boolean { return (peer as BridgePeer & { authenticated?: boolean }).authenticated === true; }
function markPeerAuthenticated(peer: BridgePeer): void { (peer as BridgePeer & { authenticated?: boolean }).authenticated = true; }
type PeerSecurity = BridgePeer & { nonceMain?: string; sessionKey?: Buffer; sendSequence?: number; receiveSequence?: number };
function setPeerHandshake(peer: BridgePeer, value: { nonceMain: string }): void { (peer as PeerSecurity).nonceMain = value.nonceMain; }
function getPeerHandshake(peer: BridgePeer): { nonceMain: string } {
  const nonceMain = (peer as PeerSecurity).nonceMain;
  if (!nonceMain) throw new Error("browser pairing challenge is missing");
  return { nonceMain };
}
function setPeerSession(peer: BridgePeer, sessionKey: Buffer): void {
  const state = peer as PeerSecurity;
  state.sessionKey = sessionKey;
  state.sendSequence = 0;
  state.receiveSequence = 0;
}
function signMac(key: Buffer, value: string | Buffer): string { return createHmac("sha256", key).update(value).digest("base64url"); }
function verifyMac(key: Buffer, value: string | Buffer, encoded: string): boolean {
  const expected = createHmac("sha256", key).update(value).digest();
  const supplied = Buffer.from(encoded, "base64url");
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}
function deriveSessionKey(key: Buffer, nonceMain: string, nonceHost: string): Buffer {
  return Buffer.from(hkdfSync("sha256", key, Buffer.from(`${nonceMain}\0${nonceHost}`), Buffer.from("lume-browser-bridge-v1"), 32));
}
function sendSecure(peer: BridgePeer, value: unknown): void {
  const state = peer as PeerSecurity;
  if (!state.sessionKey) throw new Error("external browser secure channel is unavailable");
  const sequence = (state.sendSequence ?? 0) + 1;
  const payload = Buffer.from(JSON.stringify(value));
  state.sendSequence = sequence;
  peer.send({ sequence, payload: payload.toString("base64url"), mac: signFrame(state.sessionKey, sequence, payload) });
}
function receiveSecure(peer: BridgePeer, envelope: Record<string, any>): Record<string, any> {
  const state = peer as PeerSecurity;
  if (!state.sessionKey || !Number.isSafeInteger(envelope.sequence) || envelope.sequence !== (state.receiveSequence ?? 0) + 1 || typeof envelope.payload !== "string" || typeof envelope.mac !== "string") {
    throw new Error("invalid secure browser frame");
  }
  const payload = Buffer.from(envelope.payload, "base64url");
  if (!verifyFrame(state.sessionKey, envelope.sequence, payload, envelope.mac)) throw new Error("secure browser frame MAC mismatch");
  const value = JSON.parse(payload.toString("utf8"));
  if (!isRecord(value)) throw new Error("secure browser frame payload is invalid");
  state.receiveSequence = envelope.sequence;
  return value;
}
function signFrame(key: Buffer, sequence: number, payload: Buffer): string {
  const counter = Buffer.allocUnsafe(8);
  counter.writeBigUInt64BE(BigInt(sequence));
  return signMac(key, Buffer.concat([counter, payload]));
}
function verifyFrame(key: Buffer, sequence: number, payload: Buffer, encoded: string): boolean {
  const counter = Buffer.allocUnsafe(8);
  counter.writeBigUInt64BE(BigInt(sequence));
  return verifyMac(key, Buffer.concat([counter, payload]), encoded);
}
function isRecord(value: unknown): value is Record<string, any> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function stableExternalErrorCode(value: unknown): string {
  if (value === "E_UNSUPPORTED" || value === "E_NOT_IMPLEMENTED") return "unsupported";
  if (value === "E_BROWSER_UNAVAILABLE") return "browser_unavailable";
  if (value === "E_STALE_TARGET") return "stale_target";
  if (value === "E_ACTION_DENIED") return "action_denied";
  return "browser_internal_error";
}

class LineJsonPeer implements BridgePeer {
  onMessage?: (value: unknown) => void;
  onClose?: () => void;
  private buffer = Buffer.alloc(0);
  private closed = false;
  constructor(private readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => this.read(chunk));
    socket.on("close", () => this.onClose?.());
    socket.on("error", () => this.onClose?.());
  }
  send(value: unknown): void {
    if (this.closed) throw new Error("socket closed");
    const payload = Buffer.from(JSON.stringify(value));
    if (payload.length > MAX_MESSAGE_BYTES) throw new Error("browser bridge message too large");
    this.socket.write(Buffer.concat([payload, Buffer.from("\n")]));
  }
  close(): void { if (!this.closed) { this.closed = true; this.socket.destroy(); } }
  private read(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_MESSAGE_BYTES) { this.close(); return; }
    for (let newline = this.buffer.indexOf(10); newline >= 0; newline = this.buffer.indexOf(10)) {
      const payload = this.buffer.subarray(0, newline)
      this.buffer = this.buffer.subarray(newline + 1)
      if (!payload.length) continue
      try { this.onMessage?.(JSON.parse(payload.toString("utf8"))); } catch { this.close(); return; }
    }
  }
}

function validateBridgeEndpoint(endpoint: string): string {
  if (process.platform === "win32" && /^\\\\\.\\pipe\\lume-browser-[a-zA-Z0-9_-]{8,80}$/.test(endpoint)) return endpoint;
  if (process.platform !== "win32" && endpoint.endsWith(".sock") && !endpoint.includes("\0")) return endpoint;
  throw new Error("invalid external browser pipe endpoint");
}

function validateNativeHostPath(hostPath: string): string {
  const absolute = resolve(hostPath);
  const expected = process.platform === "win32" ? "lume-chrome-host.exe" : "lume-chrome-host";
  if (absolute !== hostPath || basename(absolute) !== expected || !existsSync(absolute) || !lstatSync(absolute).isFile()) throw new Error("invalid external browser native host path");
  return absolute;
}

function readPairingKey(hostPath: string, hostSha256: string, pairingId: string): Buffer {
  const actualHash = createHash("sha256").update(readFileSync(hostPath)).digest();
  const expectedHash = Buffer.from(hostSha256, "hex");
  if (actualHash.length !== expectedHash.length || !timingSafeEqual(actualHash, expectedHash)) throw new Error("external browser native host hash mismatch");
  const result = spawnSync(hostPath, ["pairing", "get", pairingId], { encoding: "utf8", timeout: 5_000, windowsHide: true });
  const encoded = result.status === 0 ? result.stdout.trim() : "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new Error("external browser pairing key is unavailable");
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== 32) throw new Error("external browser pairing key is invalid");
  return key;
}

export function mapExternalChromeRequest(request: BrowserActionRequest): { method: string; params: Record<string, unknown> } {
  const params = { ...(request.params ?? {}), context: request.context };
  const tabId = String(request.params?.tabId ?? request.context.tabId ?? "");
  const locator = request.params?.locator;
  switch (request.method) {
    case "handshake": return { method: "runtime_ping", params: { clientType: "extension", context: request.context } };
    case "list": return { method: "list_tabs", params };
    case "openTabs": return { method: "browser_user_open_tabs", params };
    case "claim": return { method: "browser_user_claim_tab", params: { ...params, tabId } };
    case "ensure": return { method: "create_tab", params: { ...params, options: { url: request.params?.url, active: request.params?.active !== false } } };
    case "get": return { method: "get_tab", params: { ...params, tabId } };
    case "selected": return { method: "selected_tab", params };
    case "release": return { method: "release_tabs", params };
    case "handoff": return { method: "handoff_tabs", params };
    case "resumeHandoff": return { method: "resume_handoff_tabs", params };
    case "finalize": return { method: "finalize_tabs", params };
    case "close": return { method: "close_tab", params: { ...params, tabId } };
    case "goto": case "navigate": return { method: "navigate_tab_url", params: { ...params, tabId, url: request.params?.url } };
    case "back": return { method: "navigate_tab_back", params: { ...params, tabId } };
    case "forward": return { method: "navigate_tab_forward", params: { ...params, tabId } };
    case "reload": return { method: "navigate_tab_reload", params: { ...params, tabId } };
    case "snapshot": return { method: "playwright_dom_snapshot", params: { ...params, tabId } };
    case "screenshot": return { method: "tab_screenshot", params: { ...params, tabId, options: { fullPage: request.params?.fullPage === true } } };
    case "url": return { method: "tab_url", params: { ...params, tabId } };
    case "title": return { method: "tab_title", params: { ...params, tabId } };
    case "dialog:get": return { method: "tab_js_dialog_get", params: { ...params, tabId } };
    case "dialog:handle": return { method: "tab_js_dialog_handle", params: { ...params, tabId } };
    case "click": return locator ? { method: "playwright_locator_click", params: { ...params, tabId, locator } } : { method: "cua_click", params: { ...params, tabId } };
    case "doubleClick": case "dblclick": return locator ? { method: "playwright_locator_dblclick", params: { ...params, tabId, locator } } : { method: "cua_double_click", params: { ...params, tabId } };
    case "hover": return locator ? { method: "playwright_locator_hover", params: { ...params, tabId, locator } } : { method: "cua_move", params: { ...params, tabId } };
    case "fill": return { method: "playwright_locator_fill", params: { ...params, tabId, locator, text: request.params?.value ?? request.params?.text } };
    case "type": return { method: "playwright_locator_type", params: { ...params, tabId, locator, text: request.params?.text } };
    case "press": return { method: "playwright_locator_press", params: { ...params, tabId, locator, key: request.params?.key } };
    case "typeActive": return { method: "cua_type", params: { ...params, tabId, text: request.params?.text } };
    case "pressActive": return { method: "cua_keypress", params: { ...params, tabId, key: request.params?.key } };
    case "select": return { method: "playwright_locator_select_option", params: { ...params, tabId, locator, value: request.params?.values ?? request.params?.value } };
    case "check": return { method: "playwright_locator_check", params: { ...params, tabId, locator } };
    case "uncheck": return { method: "playwright_locator_uncheck", params: { ...params, tabId, locator } };
    case "scroll": return locator
      ? { method: "playwright_locator_scroll", params: { ...params, tabId, locator, deltaX: request.params?.deltaX, deltaY: request.params?.deltaY } }
      : { method: "cua_scroll", params: { ...params, tabId, scrollX: request.params?.deltaX, scrollY: request.params?.deltaY } };
    case "drag": return { method: "cua_drag", params: { ...params, tabId, path: [{ x: request.params?.x, y: request.params?.y }, { x: request.params?.toX, y: request.params?.toY }] } };
    case "locator:getAttribute": return { method: "playwright_locator_get_attribute", params: { ...params, tabId, locator } };
    case "locator:innerText": return { method: "playwright_locator_inner_text", params: { ...params, tabId, locator } };
    case "locator:textContent": return { method: "playwright_locator_text_content", params: { ...params, tabId, locator } };
    case "locator:inputValue": return { method: "playwright_locator_input_value", params: { ...params, tabId, locator } };
    case "locator:isVisible": return { method: "playwright_locator_is_visible", params: { ...params, tabId, locator } };
    case "locator:isEnabled": return { method: "playwright_locator_is_enabled", params: { ...params, tabId, locator } };
    case "locator:isChecked": return { method: "playwright_locator_is_checked", params: { ...params, tabId, locator } };
    case "locator:count": return { method: "playwright_locator_count", params: { ...params, tabId, locator } };
    case "locator:allTextContents": return { method: "playwright_locator_all_text_contents", params: { ...params, tabId, locator } };
    case "locator:readAll": return { method: "playwright_locator_read_all", params: { ...params, tabId, locator } };
    case "locator:waitFor": return { method: "playwright_locator_wait_for", params: { ...params, tabId, locator } };
    case "wait:url": return { method: "playwright_wait_for_url", params: { ...params, tabId, url: request.params?.url, options: { timeoutMs: request.params?.timeoutMs } } };
    case "wait:load": return { method: "playwright_wait_for_load_state", params: { ...params, tabId } };
    case "wait:timeout": return { method: "playwright_wait_for_timeout", params: { ...params, tabId } };
    case "cdp": return { method: "tab_cdp_call", params: { ...params, tabId } };
    case "browser_name_session": case "browser_visibility_get": case "browser_visibility_set": case "browser_viewport_set": case "browser_viewport_reset": case "tab_bot_detection_report":
      return { method: request.method, params: { ...params, tabId } };
    case "playwright_element_info": case "playwright_element_screenshot": case "tab_cdp_events": case "tab_dev_logs":
    case "dom_cua_get_visible_dom": case "dom_cua_click": case "dom_cua_double_click": case "dom_cua_type": case "dom_cua_keypress": case "dom_cua_scroll":
      return { method: request.method, params: { ...params, tabId } };
    default: throw new Error("unsupported external browser method");
  }
}
