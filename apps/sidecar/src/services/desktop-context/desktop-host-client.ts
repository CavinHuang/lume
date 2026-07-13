import { createConnection, type Socket } from "node:net";
import { DesktopHostFrameDecoder, encodeDesktopHostFrame } from "./desktop-host-protocol";

export const DESKTOP_HOST_PROTOCOL_VERSION = 3;

export class DesktopHostRequestError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = "DesktopHostRequestError";
  }
}

export interface DesktopHostConnection {
  write(data: Buffer): void;
  onData(listener: (chunk: Buffer) => void): void;
  onClose(listener: () => void): void;
  onError(listener: (error: Error) => void): void;
  destroy(): void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface DesktopHostRpcClientOptions {
  token: string;
  connect: () => Promise<DesktopHostConnection>;
  connectTimeoutMs?: number;
  retryDelayMs?: number;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  timeoutMs?: number;
}

export class DesktopHostRpcClient {
  #connection: DesktopHostConnection | null = null;
  #startPromise: Promise<void> | null = null;
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #notificationListeners = new Set<(method: string, params: unknown) => void>();
  #decoder = new DesktopHostFrameDecoder();
  readonly #timeoutMs: number;
  readonly #connectTimeoutMs: number;
  readonly #retryDelayMs: number;
  readonly #now: () => number;
  readonly #sleep: (delayMs: number) => Promise<void>;

  constructor(private readonly options: DesktopHostRpcClientOptions) {
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#connectTimeoutMs = Math.max(0, options.connectTimeoutMs ?? 5_000);
    this.#retryDelayMs = Math.max(1, options.retryDelayMs ?? 100);
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  }

  start(): Promise<void> {
    this.#startPromise ??= this.#start();
    return this.#startPromise;
  }

  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    await this.start();
    return this.#request(method, params);
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  close(): void {
    this.#connection?.destroy();
    this.#connection = null;
    this.#startPromise = null;
    this.#rejectPending(new Error("desktop host connection closed"));
  }

  async #start(): Promise<void> {
    const deadline = this.#now() + this.#connectTimeoutMs;
    let connection: DesktopHostConnection;
    try {
      connection = await this.options.connect();
    } catch (error) {
      const initialError = error instanceof Error ? error : new Error(String(error));
      connection = await this.#retryConnect(deadline, initialError);
    }
    this.#connection = connection;
    connection.onData((chunk) => this.#onData(chunk));
    connection.onClose(() => this.#onDisconnect(new Error("desktop host connection closed")));
    connection.onError((error) => this.#onDisconnect(error));
    const result = await this.#request("system.handshake", { token: this.options.token });
    const handshake = asRecord(result);
    if (handshake.status !== "ok") {
      this.close();
      throw new Error("desktop host handshake rejected");
    }
    if (handshake.protocolVersion !== DESKTOP_HOST_PROTOCOL_VERSION) {
      const received = typeof handshake.protocolVersion === "number"
        ? handshake.protocolVersion
        : "unknown";
      this.close();
      throw new Error(
        `desktop host protocol version mismatch: expected ${DESKTOP_HOST_PROTOCOL_VERSION}, received ${received}; restart Lume`,
      );
    }
  }

  async #retryConnect(deadline: number, lastError: Error): Promise<DesktopHostConnection> {
    while (true) {
      try {
        return await this.options.connect();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
      const now = this.#now();
      if (now >= deadline) throw lastError;
      await this.#sleep(Math.min(this.#retryDelayMs, deadline - now));
    }
  }

  #request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const connection = this.#connection;
    if (!connection) return Promise.reject(new Error("desktop host is not connected"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`desktop host request timed out: ${method}`));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timeout });
      connection.write(encodeDesktopHostFrame({ id, method, params }));
    });
  }

  #onData(chunk: Buffer): void {
    let messages: Record<string, unknown>[];
    try {
      messages = this.#decoder.push(chunk);
    } catch (error) {
      this.#onDisconnect(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    for (const message of messages) {
      if (typeof message.id === "number") {
        const pending = this.#pending.get(message.id);
        if (!pending) continue;
        this.#pending.delete(message.id);
        clearTimeout(pending.timeout);
        if (message.error) {
          const error = asRecord(message.error);
          pending.reject(new DesktopHostRequestError(
            typeof error.message === "string" ? error.message : "desktop host request failed",
            typeof error.code === "number" ? error.code : undefined,
          ));
        } else {
          pending.resolve(message.result);
        }
        continue;
      }
      if (typeof message.method === "string") {
        for (const listener of this.#notificationListeners) listener(message.method, message.params);
      }
    }
  }

  #onDisconnect(error: Error): void {
    this.#connection = null;
    this.#startPromise = null;
    this.#rejectPending(error);
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

export function connectDesktopHost(endpoint: string): Promise<DesktopHostConnection> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    socket.once("connect", () => resolve(wrapSocket(socket)));
    socket.once("error", reject);
  });
}

function wrapSocket(socket: Socket): DesktopHostConnection {
  return {
    write: (data) => { socket.write(data); },
    onData: (listener) => { socket.on("data", listener); },
    onClose: (listener) => { socket.on("close", listener); },
    onError: (listener) => { socket.on("error", listener); },
    destroy: () => socket.destroy(),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
