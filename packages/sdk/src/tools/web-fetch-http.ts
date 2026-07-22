import { setTimeout as delay } from "node:timers/promises";
import type { SandboxSettings } from "../types.js";
import { ensureNetworkAllowed } from "../utils/pathing.js";

export const MAX_FETCH_BYTES = 50 * 1024 * 1024;
export const MAX_REDIRECTS = 8;

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export interface LoadPageOptions {
  timeoutMs?: number;
  maxBytes?: number;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  signal?: AbortSignal;
  sandbox?: SandboxSettings;
  userAgents?: readonly string[];
  fetchImpl: FetchImpl;
}

export interface LoadPageResult {
  ok: boolean;
  status: number;
  content: string;
  contentType: string;
  finalUrl: string;
  headers: Headers;
  truncated: boolean;
  error?: string;
}

export interface LoadBinaryResult {
  ok: boolean;
  status: number;
  bytes: Uint8Array;
  contentType: string;
  finalUrl: string;
  headers: Headers;
  error?: string;
}

const DEFAULT_USER_AGENTS = [
  "curl/8.0",
  "Mozilla/5.0 (compatible; TextBot/1.0)",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
] as const;

function signalWithTimeout(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  const abort = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  };
}

function charsetFromContentType(header: string): string | undefined {
  return /charset\s*=\s*["']?([\w-]+)/i.exec(header)?.[1];
}

function decodeBody(bytes: Uint8Array, contentType: string): string {
  const label = charsetFromContentType(contentType)
    ?? /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(Buffer.from(bytes.subarray(0, 2048)).toString("latin1"))?.[1];
  if (label && !/^utf-?8$/i.test(label)) {
    try {
      return new TextDecoder(label as never).decode(bytes);
    } catch {
      // Fall through to UTF-8 when a server advertises an unsupported label.
    }
  }
  return new TextDecoder().decode(bytes);
}

async function readBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const length = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(length) && length > maxBytes) {
    throw new Error(`response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return { bytes: new Uint8Array(), truncated: false };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error("request aborted");
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        chunks.push(value.slice(0, Math.max(0, remaining)));
        await reader.cancel();
        return { bytes: Buffer.concat(chunks.map(chunk => Buffer.from(chunk))), truncated: true };
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return { bytes: Buffer.concat(chunks.map(chunk => Buffer.from(chunk))), truncated: false };
}

function blockedContent(status: number, content: string): boolean {
  if (status !== 403 && status !== 503) return false;
  const lower = content.toLowerCase();
  return ["cloudflare", "captcha", "challenge", "blocked", "access denied", "bot detection"]
    .some(marker => lower.includes(marker));
}

function parseRetryAfter(value: string | null): number {
  if (!value) return 1000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 0) * 1000, 10000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? 1000 : Math.min(Math.max(date - Date.now(), 0), 10000);
}

function nextUrl(response: Response, currentUrl: string): string | null {
  const location = response.headers.get("location");
  if (!location) return null;
  try {
    return new URL(location, currentUrl).href;
  } catch {
    return null;
  }
}

export async function loadPage(url: string, options: LoadPageOptions): Promise<LoadPageResult> {
  const timeoutMs = options.timeoutMs ?? 30000;
  const maxBytes = options.maxBytes ?? MAX_FETCH_BYTES;
  const userAgents = options.userAgents ?? DEFAULT_USER_AGENTS;
  let currentUrl = url;
  let redirects = 0;
  let retried429 = false;
  let lastError = "request failed";

  for (let attempt = 0; attempt < userAgents.length; attempt++) {
    if (options.signal?.aborted) throw new Error("request aborted");
    const allowed = ensureNetworkAllowed(currentUrl, options.sandbox);
    if (allowed) {
      return {
        ok: false,
        status: 0,
        content: "",
        contentType: "",
        finalUrl: currentUrl,
        headers: new Headers(),
        truncated: false,
        error: allowed,
      };
    }

    const combined = signalWithTimeout(options.signal, timeoutMs);
    try {
      const response = await options.fetchImpl(currentUrl, {
        method: options.method ?? "GET",
        body: options.body,
        redirect: "manual",
        signal: combined.signal,
        headers: {
          "User-Agent": userAgents[attempt] ?? userAgents[0] ?? DEFAULT_USER_AGENTS[0],
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
          "Accept-Encoding": "identity",
          ...options.headers,
        },
      });
      const redirect = response.status >= 300 && response.status < 400 ? nextUrl(response, currentUrl) : null;
      if (redirect) {
        if (++redirects > MAX_REDIRECTS) throw new Error(`too many redirects (>${MAX_REDIRECTS})`);
        const redirectAllowed = ensureNetworkAllowed(redirect, options.sandbox);
        if (redirectAllowed) {
          return {
            ok: false,
            status: response.status,
            content: "",
            contentType: response.headers.get("content-type") ?? "",
            finalUrl: currentUrl,
            headers: response.headers,
            truncated: false,
            error: redirectAllowed,
          };
        }
        currentUrl = redirect;
        attempt--;
        continue;
      }

      if (response.status === 429 && !retried429) {
        retried429 = true;
        await response.body?.cancel().catch(() => undefined);
        await delay(parseRetryAfter(response.headers.get("retry-after")), { signal: options.signal });
        attempt--;
        continue;
      }

      const rawContentType = response.headers.get("content-type") ?? "";
      const body = await readBody(response, maxBytes, combined.signal);
      const content = decodeBody(body.bytes, rawContentType);
      if (blockedContent(response.status, content) && attempt < userAgents.length - 1) {
        await response.body?.cancel().catch(() => undefined);
        continue;
      }
      return {
        ok: response.ok,
        status: response.status,
        content,
        contentType: (rawContentType.split(";", 1)[0] ?? "").trim().toLowerCase(),
        finalUrl: response.url || currentUrl,
        headers: response.headers,
        truncated: body.truncated,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (options.signal?.aborted) throw new Error("request aborted");
      if (attempt === userAgents.length - 1) break;
    } finally {
      combined.dispose();
    }
  }

  return {
    ok: false,
    status: 0,
    content: "",
    contentType: "",
    finalUrl: currentUrl,
    headers: new Headers(),
    truncated: false,
    error: lastError,
  };
}

/** Fetch a bounded binary resource using the same timeout, redirect and sandbox rules. */
export async function loadBinary(url: string, options: LoadPageOptions): Promise<LoadBinaryResult> {
  const timeoutMs = options.timeoutMs ?? 30000;
  const maxBytes = options.maxBytes ?? MAX_FETCH_BYTES;
  const userAgent = options.userAgents?.[0] ?? DEFAULT_USER_AGENTS[1];
  let currentUrl = url;
  let redirects = 0;

  for (;;) {
    if (options.signal?.aborted) throw new Error("request aborted");
    const allowed = ensureNetworkAllowed(currentUrl, options.sandbox);
    if (allowed) return { ok: false, status: 0, bytes: new Uint8Array(), contentType: "", finalUrl: currentUrl, headers: new Headers(), error: allowed };
    const combined = signalWithTimeout(options.signal, timeoutMs);
    try {
      const response = await options.fetchImpl(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: combined.signal,
        headers: {
          "User-Agent": userAgent,
          Accept: "*/*",
          "Accept-Encoding": "identity",
          ...options.headers,
        },
      });
      const redirect = response.status >= 300 && response.status < 400 ? nextUrl(response, currentUrl) : null;
      if (redirect) {
        if (++redirects > MAX_REDIRECTS) throw new Error(`too many redirects (>${MAX_REDIRECTS})`);
        const redirectAllowed = ensureNetworkAllowed(redirect, options.sandbox);
        if (redirectAllowed) return { ok: false, status: response.status, bytes: new Uint8Array(), contentType: "", finalUrl: currentUrl, headers: response.headers, error: redirectAllowed };
        await response.body?.cancel().catch(() => undefined);
        currentUrl = redirect;
        continue;
      }
      const body = await readBody(response, maxBytes, combined.signal);
      return {
        ok: response.ok,
        status: response.status,
        bytes: body.bytes,
        contentType: ((response.headers.get("content-type") ?? "").split(";", 1)[0] ?? "").trim().toLowerCase(),
        finalUrl: response.url || currentUrl,
        headers: response.headers,
        error: body.truncated ? `response exceeds ${maxBytes} bytes` : undefined,
      };
    } catch (error) {
      if (options.signal?.aborted) throw new Error("request aborted");
      return { ok: false, status: 0, bytes: new Uint8Array(), contentType: "", finalUrl: currentUrl, headers: new Headers(), error: error instanceof Error ? error.message : String(error) };
    } finally {
      combined.dispose();
    }
  }
}
