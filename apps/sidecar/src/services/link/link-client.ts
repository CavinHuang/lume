import type { LinkRuntimePhase } from "@lume/shared";

type LinkApi = "admin" | "runtime";
type LinkRuntimeBootstrap = { phase: LinkRuntimePhase; origin?: string; adminToken?: string; runtimeToken?: string };
type BootstrapState = { phase: LinkRuntimePhase; origin?: string; adminToken?: Buffer; runtimeToken?: Buffer };

let bootstrap: BootstrapState = { phase: "disabled" };
const LINK_RUNTIME_PHASES = new Set<LinkRuntimePhase>([
  "disabled", "starting", "online", "stopping", "offline", "crashed", "port_conflict", "incompatible",
]);

export function installLinkRuntimeBootstrap(value: unknown): void {
  clearSecrets();
  if (!value || typeof value !== "object") {
    bootstrap = { phase: "offline" };
    return;
  }
  const input = value as LinkRuntimeBootstrap;
  if (!LINK_RUNTIME_PHASES.has(input.phase)) {
    bootstrap = { phase: "offline" };
    throw new Error("invalid_link_bootstrap");
  }
  if (input.phase !== "online") {
    bootstrap = { phase: input.phase };
    return;
  }
  if (!isLoopbackOrigin(input.origin) || !input.adminToken || !input.runtimeToken) {
    bootstrap = { phase: "offline" };
    throw new Error("invalid_link_bootstrap");
  }
  bootstrap = {
    phase: "online",
    origin: input.origin,
    adminToken: Buffer.from(input.adminToken),
    runtimeToken: Buffer.from(input.runtimeToken),
  };
}

export function getLinkRuntimePhase(): LinkRuntimePhase {
  return bootstrap.phase;
}

export function isLinkRuntimeOnline(): boolean {
  return bootstrap.phase === "online";
}

export async function linkAdminRequest<T>(path: string, init?: RequestInit): Promise<T> {
  return linkRequest<T>("admin", path, init);
}

export async function linkRuntimeRequest<T>(path: string, init?: RequestInit): Promise<T> {
  return linkRequest<T>("runtime", path, init);
}

async function linkRequest<T>(api: LinkApi, path: string, init: RequestInit = {}): Promise<T> {
  if (bootstrap.phase !== "online" || !bootstrap.origin) throw new Error("link_runtime_offline");
  const secret = api === "admin" ? bootstrap.adminToken : bootstrap.runtimeToken;
  if (!secret) throw new Error("link_runtime_offline");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  const onAbort = () => controller.abort();
  init.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const url = new URL(path, bootstrap.origin);
    const expectedPrefix = api === "admin" ? "/api/" : "/v1/";
    if (url.origin !== bootstrap.origin || !url.pathname.startsWith(expectedPrefix) || url.username || url.password || url.hash) {
      throw new Error("invalid_link_request_path");
    }
    const headers = new Headers(init.headers);
    if (init.body != null && !headers.has("content-type")) headers.set("content-type", "application/json");
    headers.set("authorization", `Bearer ${secret.toString()}`);
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: controller.signal,
      headers,
    });
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok || body?.success === false) {
      const adminError = body?.error && typeof body.error === "object" ? body.error as Record<string, unknown> : undefined;
      throw new LinkApiError(
        typeof body?.errorCode === "string" ? body.errorCode : typeof adminError?.code === "string" ? adminError.code : `link_http_${response.status}`,
        typeof body?.message === "string" ? body.message : typeof adminError?.message === "string" ? adminError.message : "OpenConnector request failed",
      );
    }
    return (api === "runtime" && body && "data" in body ? body.data : body) as T;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", onAbort);
  }
}

export class LinkApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function isLoopbackOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const port = Number(url.port);
    return url.protocol === "http:"
      && url.hostname === "127.0.0.1"
      && url.pathname === "/"
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && Number.isInteger(port)
      && port >= 49152
      && port <= 65535;
  } catch {
    return false;
  }
}

function clearSecrets(): void {
  bootstrap.adminToken?.fill(0);
  bootstrap.runtimeToken?.fill(0);
}
