import type { LinkRuntimeConfigurationInput, LinkRuntimeDiagnostic, LinkRuntimeMode, LinkRuntimeState } from "../../../packages/shared/src/types/link";
import type { UtilityProcess } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { randomInt } from "node:crypto";
import { loadLinkRemoteCredentials, loadOrCreateLinkSecrets, saveLinkRemoteCredentials, type LinkRemoteCredentials } from "./link-secret-store";

interface PersistedLinkState { enabled: boolean; mode: LinkRuntimeMode; port: number | null; remoteOrigin: string | null }
interface ResourceMetadata { version: string; archiveSha256: string; commit: string; available: boolean }
interface LinkRuntimeBootstrap { mode: LinkRuntimeMode; phase: LinkRuntimeState["phase"]; origin?: string; adminToken?: string; runtimeToken?: string }
interface LinkBootstrapCredentials { adminToken: string; runtimeToken: string }

const OPENCONNECTOR_VERSION = "1.3.5";
const OPENCONNECTOR_COMMIT = "5719a69468c698c7cb8108e062ff64ecef8a2e65";
const OPENCONNECTOR_ARCHIVE_SHA256 = "4991b3a5a44ae68c57976767462f313f8d9bc1075ae0f64b314fca277e19441f";

export function createLinkRuntimeSupervisor(input: {
  configDir: string;
  resourceDir: string;
  getMasterKey: () => Buffer | null;
  fork: (modulePath: string, args: string[], options: Electron.ForkOptions) => UtilityProcess;
  emit: (state: LinkRuntimeState) => void;
  installBootstrap: (bootstrap: LinkRuntimeBootstrap) => void | Promise<void>;
  killProcessTree: (pid: number) => void;
}) {
  const runtimeDir = join(input.configDir, "link-runtime");
  const statePath = join(runtimeDir, "state.json");
  const remoteSecretsPath = join(runtimeDir, "remote-secrets.json");
  const dataDirectory = join(runtimeDir, "openconnector", "data");
  const metadata = readMetadata(input.resourceDir);
  let persisted = readPersistedState(statePath);
  let child: UtilityProcess | null = null;
  let stopping = false;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let crashTimes: number[] = [];
  let currentCredentials: LinkBootstrapCredentials | null = null;
  let remoteCredentials = loadRemoteCredentialsIfAvailable();
  let bootstrapDelivery = Promise.resolve();
  let operationGeneration = 0;
  let state: LinkRuntimeState = publicState(persisted, "disabled", metadata.version, dataDirectory, 0, remoteCredentials);

  const deliverBootstrap = (bootstrap: LinkRuntimeBootstrap): Promise<void> => {
    const delivery = bootstrapDelivery.then(() => input.installBootstrap(bootstrap));
    bootstrapDelivery = delivery.catch(() => undefined);
    return delivery;
  };

  const publish = (phase: LinkRuntimeState["phase"], error?: string) => {
    state = publicState(persisted, phase, metadata.version, dataDirectory, crashTimes.length, remoteCredentials, error);
    input.emit(state);
    if (phase !== "online") {
      currentCredentials = null;
      void deliverBootstrap({ mode: persisted.mode, phase }).catch(() => undefined);
    }
  };

  async function start(): Promise<LinkRuntimeState> {
    if (!persisted.enabled) { publish("disabled"); await bootstrapDelivery; return state; }
    if (persisted.mode === "remote") return connectRemote();
    if (child || state.phase === "starting") return state;
    if (!persisted.port) throw new Error("link_port_missing");
    // 并发守卫必须覆盖整个 async 区间：置 starting 要在 await isPortFree 之前，
    // 否则两次并发 start 都能通过最上面的 child/starting 检查，各自 fork 出孤儿进程(#126)
    publish("starting");
    const generation = operationGeneration;
    const isCurrent = () => generation === operationGeneration && persisted.enabled && persisted.mode === "local";
    const portFree = await isPortFree(persisted.port);
    if (!isCurrent()) return state;
    if (!portFree) { publish("port_conflict", "Configured port is already in use."); await bootstrapDelivery; return state; }
    if (!metadata.available) { publish("incompatible", "OpenConnector 1.3.5 resources are missing or failed integrity validation."); await bootstrapDelivery; return state; }
    const masterKey = input.getMasterKey();
    if (!masterKey) { publish("offline", "Connection vault is locked."); await bootstrapDelivery; throw new Error("connection_vault_locked"); }
    const secrets = loadOrCreateLinkSecrets(join(runtimeDir, "secrets.json"), masterKey);
    currentCredentials = secrets;
    mkdirSync(dataDirectory, { recursive: true });
    currentCredentials = secrets;
    stopping = false;
    const origin = `http://127.0.0.1:${persisted.port}`;
    const inheritedEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("OOMOL_CONNECT_")),
    );
    // fork bundle 产物(纯 JS,已由 scripts/build-openconnector-bundle.mjs 产出,消除 TS strip 依赖)。
    const running = input.fork(join(input.resourceDir, "openconnector.mjs"), [], {
      cwd: input.resourceDir,
      env: {
        ...inheritedEnvironment,
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: String(persisted.port),
        OOMOL_CONNECT_ORIGIN: origin,
        OOMOL_CONNECT_DATA_DIR: dataDirectory,
        OOMOL_CONNECT_ENCRYPTION_KEY: secrets.encryptionKey,
        OOMOL_CONNECT_ADMIN_TOKEN: secrets.adminToken,
        OOMOL_CONNECT_RUNTIME_TOKEN: secrets.runtimeToken,
        OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK: "false",
      },
      stdio: "pipe",
    });
    running.stdout?.resume();
    running.stderr?.resume();
    child = running;
    // exited 标志须在 fork 后立即注册：健康等待期内进程崩溃时 exit 事件已 flush，
    // catch 里再 once("exit") 永不触发，会白等 1.5s 并对可能已被系统回收的 pid 调
    // killProcessTree 误杀无关进程树(#127)
    let exitedDuringStart = false;
    running.on("exit", () => {
      exitedDuringStart = true;
      if (child !== running) return;
      child = null;
      if (stopping || !persisted.enabled) { publish(persisted.enabled ? "offline" : "disabled"); return; }
      const crash = nextLinkCrashState(crashTimes, Date.now());
      crashTimes = crash.crashTimes;
      if (!crash.shouldRestart) { publish("crashed", "OpenConnector exited repeatedly."); return; }
      publish("offline", "OpenConnector exited unexpectedly.");
      restartTimer = setTimeout(() => void start().catch((error) => publish("crashed", message(error))), crash.delayMs);
    });
    try {
      await waitForLinkHealth(origin, secrets.runtimeToken);
      if (!isCurrent()) return state;
      if (child !== running) throw new Error("link_runtime_exited_during_start");
      await deliverBootstrap({ mode: "local", phase: "online", origin, adminToken: secrets.adminToken, runtimeToken: secrets.runtimeToken });
      if (!isCurrent()) return state;
      state = { ...publicState(persisted, "online", metadata.version, dataDirectory, crashTimes.length, remoteCredentials), origin };
      input.emit(state);
    } catch (error) {
      if (!isCurrent()) return state;
      if (child === running) child = null;
      stopping = true;
      // 进程已退出(exit 事件已发)时不再注册等待/kill——此时 pid 可能已被回收(#127)
      if (!exitedDuringStart) {
        const pid = running.pid;
        let exited = false;
        const exitedPromise = new Promise<void>((resolve) => running.once("exit", () => { exited = true; resolve(); }));
        running.kill();
        await Promise.race([exitedPromise, new Promise((resolve) => setTimeout(resolve, 1_500))]);
        if (!exited && pid) input.killProcessTree(pid);
      }
      publish("crashed", message(error));
      throw error;
    }
    return state;
  }

  async function connectRemote(): Promise<LinkRuntimeState> {
    if (state.phase === "starting") return state;
    const origin = persisted.remoteOrigin;
    if (!origin) { publish("offline", "Existing deployment URL is not configured."); await bootstrapDelivery; return state; }
    const generation = operationGeneration;
    const isCurrent = () => generation === operationGeneration
      && persisted.enabled
      && persisted.mode === "remote"
      && persisted.remoteOrigin === origin;
    try {
      const credentials = loadRemoteCredentials();
      remoteCredentials = credentials;
      currentCredentials = credentials;
      publish("starting");
      currentCredentials = credentials;
      await waitForLinkHealth(origin, credentials.runtimeToken, 10_000);
      if (!isCurrent()) return state;
      await validateLinkAdminAccess(origin, credentials.adminToken);
      if (!isCurrent()) return state;
      await deliverBootstrap({
        mode: "remote",
        phase: "online",
        origin,
        ...(credentials.adminToken ? { adminToken: credentials.adminToken } : {}),
        ...(credentials.runtimeToken ? { runtimeToken: credentials.runtimeToken } : {}),
      });
      if (!isCurrent()) return state;
      state = { ...publicState(persisted, "online", metadata.version, dataDirectory, 0, credentials), origin };
      input.emit(state);
      return state;
    } catch (error) {
      if (!isCurrent()) return state;
      publish("offline", message(error));
      await bootstrapDelivery;
      throw error;
    }
  }

  async function stop(nextPhase: LinkRuntimeState["phase"] = "offline"): Promise<LinkRuntimeState> {
    operationGeneration += 1;
    stopping = true;
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    const running = child;
    child = null;
    if (running) {
      publish("stopping");
      const pid = running.pid;
      let exited = false;
      const exitedPromise = new Promise<void>((resolve) => running.once("exit", () => { exited = true; resolve(); }));
      running.kill();
      await Promise.race([exitedPromise, new Promise((resolve) => setTimeout(resolve, 1_500))]);
      if (!exited && pid) input.killProcessTree(pid);
    }
    publish(nextPhase);
    await bootstrapDelivery;
    return state;
  }

  return {
    getState: () => state,
    async initialize() {
      remoteCredentials = loadRemoteCredentialsIfAvailable();
      if (persisted.enabled) await start(); else { publish("disabled"); await bootstrapDelivery; }
      return state;
    },
    async enable() {
      if (persisted.mode === "local" && !persisted.port) persisted.port = await choosePort();
      if (persisted.mode === "remote" && !persisted.remoteOrigin) throw new Error("link_remote_origin_missing");
      persisted.enabled = true; savePersistedState(statePath, persisted);
      return start();
    },
    async disable() { persisted.enabled = false; savePersistedState(statePath, persisted); return stop("disabled"); },
    async restart() { await stop("offline"); crashTimes = []; return start(); },
    async configure(configuration: LinkRuntimeConfigurationInput) {
      if (configuration.mode === "local") {
        if (persisted.mode !== "local" || child || state.phase === "online" || state.phase === "starting") await stop("offline");
        persisted = { ...persisted, enabled: true, mode: "local" };
        if (!persisted.port) persisted.port = await choosePort();
        savePersistedState(statePath, persisted);
        crashTimes = [];
        return start();
      }
      const origin = normalizeRemoteOrigin(configuration.origin);
      const masterKey = input.getMasterKey();
      if (!masterKey) throw new Error("connection_vault_locked");
      await stop("offline");
      const existing = loadRemoteCredentialsIfAvailable();
      const sameOrigin = existing?.origin === origin;
      remoteCredentials = {
        origin,
        adminToken: configuration.clearAdminToken ? "" : normalizeToken(configuration.adminToken) ?? (sameOrigin ? existing.adminToken : ""),
        runtimeToken: configuration.clearRuntimeToken ? "" : normalizeToken(configuration.runtimeToken) ?? (sameOrigin ? existing.runtimeToken : ""),
      };
      saveLinkRemoteCredentials(remoteSecretsPath, remoteCredentials, masterKey);
      persisted = { ...persisted, enabled: true, mode: "remote", remoteOrigin: origin };
      savePersistedState(statePath, persisted);
      crashTimes = [];
      return start();
    },
    async changePort(port: number) {
      if (persisted.mode !== "local") throw new Error("link_port_not_available_for_remote");
      if (!Number.isInteger(port) || port < 49152 || port > 65535) throw new Error("invalid_link_port");
      if (port === persisted.port) return state;
      if (!(await isPortFree(port))) throw new Error("link_port_conflict");
      const shouldRestart = persisted.enabled;
      if (shouldRestart) await stop("offline");
      persisted.port = port; savePersistedState(statePath, persisted);
      return shouldRestart ? start() : (publish("disabled"), state);
    },
    async syncBootstrap() {
      if (state.phase === "online" && state.origin && currentCredentials) {
        await deliverBootstrap({
          mode: persisted.mode,
          phase: "online",
          origin: state.origin,
          ...(currentCredentials.adminToken ? { adminToken: currentCredentials.adminToken } : {}),
          ...(currentCredentials.runtimeToken ? { runtimeToken: currentCredentials.runtimeToken } : {}),
        });
      } else {
        await deliverBootstrap({ mode: persisted.mode, phase: state.phase });
      }
    },
    async diagnose(): Promise<LinkRuntimeDiagnostic> {
      const startedAt = Date.now();
      const result: LinkRuntimeDiagnostic = {
        checkedAt: new Date(startedAt).toISOString(),
        runtimePhase: state.phase,
        resourceReady: persisted.mode === "remote" || metadata.available,
        dataDirectoryReady: persisted.mode === "remote" || existsSync(dataDirectory),
        endpointReachable: false,
      };
      if (state.phase !== "online" || !state.origin || !currentCredentials) {
        return { ...result, ...(state.lastError ? { error: state.lastError } : {}) };
      }
      try {
        const response = await fetch(`${state.origin}/v1/health`, {
          redirect: "error",
          headers: currentCredentials.runtimeToken ? { authorization: `Bearer ${currentCredentials.runtimeToken}` } : undefined,
          signal: AbortSignal.timeout(3_000),
        });
        const healthy = await isLinkHealthResponse(response);
        return {
          ...result,
          endpointReachable: healthy,
          latencyMs: Date.now() - startedAt,
          ...(!healthy ? { error: response.ok ? "health_invalid_response" : `health_http_${response.status}` } : {}),
        };
      } catch (error) {
        return { ...result, latencyMs: Date.now() - startedAt, error: message(error) };
      }
    },
    stop,
  };

  function loadRemoteCredentials(): LinkRemoteCredentials {
    const origin = persisted.remoteOrigin;
    if (!origin) throw new Error("link_remote_origin_missing");
    const masterKey = input.getMasterKey();
    if (!masterKey) {
      if (existsSync(remoteSecretsPath)) throw new Error("connection_vault_locked");
      return { origin, adminToken: "", runtimeToken: "" };
    }
    const credentials = loadLinkRemoteCredentials(remoteSecretsPath, masterKey);
    if (!credentials) return { origin, adminToken: "", runtimeToken: "" };
    if (credentials.origin !== origin) throw new Error("link_remote_credential_origin_mismatch");
    return credentials;
  }

  function loadRemoteCredentialsIfAvailable(): LinkRemoteCredentials | null {
    if (!persisted.remoteOrigin) return null;
    try { return loadRemoteCredentials(); } catch { return null; }
  }
}

export function nextLinkCrashState(previous: number[], now: number): { crashTimes: number[]; shouldRestart: boolean; delayMs: number } {
  const crashTimes = [...previous.filter((time) => now - time < 5 * 60_000), now];
  return { crashTimes, shouldRestart: crashTimes.length < 3, delayMs: 2 ** Math.max(0, crashTimes.length - 1) * 1000 };
}

function readMetadata(resourceDir: string): ResourceMetadata {
  const path = join(resourceDir, "lume-resource.json");
  // bundle 形态:入口为 openconnector.mjs,运行时仅需 catalog(连接器目录)与 migrations(SQLite schema);
  // dist/web(console 前端)与 node_modules 不再是启动必需——staticRoot 缺失时仅 warn,bundle 已 inline 全部依赖。
  const entry = join(resourceDir, "openconnector.mjs");
  const requiredDirectories = ["catalog", "migrations"];
  if (!existsSync(path) || !existsSync(entry) || requiredDirectories.some((name) => !existsSync(join(resourceDir, name)))) {
    return { version: OPENCONNECTOR_VERSION, archiveSha256: "", commit: "", available: false };
  }
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    const available = value.version === OPENCONNECTOR_VERSION
      && value.commit === OPENCONNECTOR_COMMIT
      && value.archiveSha256 === OPENCONNECTOR_ARCHIVE_SHA256;
    return {
      version: typeof value.version === "string" ? value.version : OPENCONNECTOR_VERSION,
      archiveSha256: typeof value.archiveSha256 === "string" ? value.archiveSha256 : "",
      commit: typeof value.commit === "string" ? value.commit : "",
      available,
    };
  } catch {
    return { version: OPENCONNECTOR_VERSION, archiveSha256: "", commit: "", available: false };
  }
}
function readPersistedState(path: string): PersistedLinkState {
  if (!existsSync(path)) return { enabled: false, mode: "local", port: null, remoteOrigin: null };
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return {
      enabled: value.enabled === true,
      mode: value.mode === "remote" ? "remote" : "local",
      port: Number.isInteger(value.port) ? value.port : null,
      remoteOrigin: typeof value.remoteOrigin === "string" ? value.remoteOrigin : null,
    };
  } catch {
    return { enabled: false, mode: "local", port: null, remoteOrigin: null };
  }
}
function savePersistedState(path: string, value: PersistedLinkState): void { mkdirSync(dirname(path), { recursive: true }); const temporary = `${path}.tmp`; writeFileSync(temporary, `${JSON.stringify(value)}\n`); renameSync(temporary, path); }
function publicState(persisted: PersistedLinkState, phase: LinkRuntimeState["phase"], version: string, dataDirectory: string, restartCount: number, remoteCredentials: LinkRemoteCredentials | null, lastError?: string): LinkRuntimeState {
  return {
    enabled: persisted.enabled,
    mode: persisted.mode,
    phase,
    port: persisted.port,
    origin: phase === "online" ? (persisted.mode === "remote" ? persisted.remoteOrigin : persisted.port ? `http://127.0.0.1:${persisted.port}` : null) : null,
    remoteOrigin: persisted.remoteOrigin,
    adminTokenConfigured: Boolean(remoteCredentials?.adminToken),
    runtimeTokenConfigured: Boolean(remoteCredentials?.runtimeToken),
    version,
    dataDirectory,
    restartCount,
    ...(lastError ? { lastError } : {}),
  };
}
async function isPortFree(port: number): Promise<boolean> { return new Promise((resolve) => { const server = createServer(); server.once("error", () => resolve(false)); server.listen(port, "127.0.0.1", () => server.close(() => resolve(true))); }); }
async function choosePort(): Promise<number> { for (let attempt = 0; attempt < 100; attempt += 1) { const port = randomInt(49152, 65536); if (await isPortFree(port)) return port; } throw new Error("link_port_unavailable"); }
export async function waitForLinkHealth(origin: string, token: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let delay = 100;
  while (Date.now() < deadline) {
    try {
      const remaining = Math.max(1, deadline - Date.now());
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(3_000, remaining));
      try {
        const response = await fetch(`${origin}/v1/health`, {
          redirect: "error",
          headers: token ? { authorization: `Bearer ${token}` } : undefined,
          signal: controller.signal,
        });
        if (await isLinkHealthResponse(response)) return;
      } finally {
        clearTimeout(timer);
      }
    } catch { /* retry until the bounded deadline */ }
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(delay, remaining)));
    delay = Math.min(1000, delay * 2);
  }
  throw new Error("link_health_timeout");
}

async function validateLinkAdminAccess(origin: string, token: string): Promise<void> {
  try {
    const response = await fetch(`${origin}/api/providers`, {
      redirect: "error",
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
      signal: AbortSignal.timeout(3_000),
    });
    const body = await response.json().catch(() => null) as unknown;
    const validBody = Array.isArray(body)
      || (body !== null && typeof body === "object" && (body as Record<string, unknown>).success === true);
    if (!response.ok || !validBody) throw new Error("link_admin_access_failed");
  } catch {
    throw new Error("link_admin_access_failed");
  }
}

async function isLinkHealthResponse(response: Response): Promise<boolean> {
  if (!response.ok) return false;
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (body?.success !== true || !body.data || typeof body.data !== "object") return false;
  const payload = body.data as Record<string, unknown>;
  return payload.ok === true && payload.runtime === "oomol-connect";
}
function normalizeRemoteOrigin(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("invalid_link_remote_origin");
  try {
    const url = new URL(value.trim());
    const loopback = isLoopbackHostname(url.hostname);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
      throw new Error("invalid_link_remote_origin");
    }
    return url.origin;
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_link_remote_origin") throw error;
    throw new Error("invalid_link_remote_origin");
  }
}
function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}
function normalizeToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const token = value.trim();
  return token || undefined;
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
