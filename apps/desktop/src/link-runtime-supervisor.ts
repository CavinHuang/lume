import type { LinkRuntimeDiagnostic, LinkRuntimeState } from "../../../packages/shared/src/types/link";
import type { UtilityProcess } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { randomInt } from "node:crypto";
import { loadOrCreateLinkSecrets, type LinkRuntimeSecrets } from "./link-secret-store";

interface PersistedLinkState { enabled: boolean; port: number | null }
interface ResourceMetadata { version: string; archiveSha256: string; commit: string; available: boolean }
interface LinkRuntimeBootstrap { phase: LinkRuntimeState["phase"]; origin?: string; adminToken?: string; runtimeToken?: string }

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
  const dataDirectory = join(runtimeDir, "openconnector", "data");
  const metadata = readMetadata(input.resourceDir);
  let persisted = readPersistedState(statePath);
  let child: UtilityProcess | null = null;
  let stopping = false;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let crashTimes: number[] = [];
  let currentSecrets: LinkRuntimeSecrets | null = null;
  let bootstrapDelivery = Promise.resolve();
  let state: LinkRuntimeState = publicState(persisted, "disabled", metadata.version, dataDirectory, 0);

  const deliverBootstrap = (bootstrap: LinkRuntimeBootstrap): Promise<void> => {
    const delivery = bootstrapDelivery.then(() => input.installBootstrap(bootstrap));
    bootstrapDelivery = delivery.catch(() => undefined);
    return delivery;
  };

  const publish = (phase: LinkRuntimeState["phase"], error?: string) => {
    state = publicState(persisted, phase, metadata.version, dataDirectory, crashTimes.length, error);
    input.emit(state);
    if (phase !== "online") {
      void deliverBootstrap({ phase }).catch(() => undefined);
    }
  };

  async function start(): Promise<LinkRuntimeState> {
    if (!persisted.enabled) { publish("disabled"); await bootstrapDelivery; return state; }
    if (child || state.phase === "starting") return state;
    if (!persisted.port) throw new Error("link_port_missing");
    if (!(await isPortFree(persisted.port))) { publish("port_conflict", "Configured port is already in use."); await bootstrapDelivery; return state; }
    if (!metadata.available) { publish("incompatible", "OpenConnector 1.3.5 resources are missing or failed integrity validation."); await bootstrapDelivery; return state; }
    const masterKey = input.getMasterKey();
    if (!masterKey) { publish("offline", "Connection vault is locked."); await bootstrapDelivery; throw new Error("connection_vault_locked"); }
    const secrets = loadOrCreateLinkSecrets(join(runtimeDir, "secrets.json"), masterKey);
    currentSecrets = secrets;
    mkdirSync(dataDirectory, { recursive: true });
    publish("starting");
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
    running.on("exit", () => {
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
      await waitForHealth(origin, secrets.runtimeToken);
      if (child !== running) throw new Error("link_runtime_exited_during_start");
      state = { ...publicState(persisted, "online", metadata.version, dataDirectory, crashTimes.length), origin };
      input.emit(state);
      await deliverBootstrap({ phase: "online", origin, adminToken: secrets.adminToken, runtimeToken: secrets.runtimeToken });
    } catch (error) {
      if (child === running) child = null;
      stopping = true;
      const pid = running.pid;
      let exited = false;
      const exitedPromise = new Promise<void>((resolve) => running.once("exit", () => { exited = true; resolve(); }));
      running.kill();
      await Promise.race([exitedPromise, new Promise((resolve) => setTimeout(resolve, 1_500))]);
      if (!exited && pid) input.killProcessTree(pid);
      publish("crashed", message(error));
      throw error;
    }
    return state;
  }

  async function stop(nextPhase: LinkRuntimeState["phase"] = "offline"): Promise<LinkRuntimeState> {
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
    async initialize() { if (persisted.enabled) await start(); else { publish("disabled"); await bootstrapDelivery; } return state; },
    async enable() {
      if (!persisted.port) persisted.port = await choosePort();
      persisted.enabled = true; savePersistedState(statePath, persisted);
      return start();
    },
    async disable() { persisted.enabled = false; savePersistedState(statePath, persisted); return stop("disabled"); },
    async restart() { await stop("offline"); crashTimes = []; return start(); },
    async changePort(port: number) {
      if (!Number.isInteger(port) || port < 49152 || port > 65535) throw new Error("invalid_link_port");
      if (port === persisted.port) return state;
      if (!(await isPortFree(port))) throw new Error("link_port_conflict");
      const shouldRestart = persisted.enabled;
      if (shouldRestart) await stop("offline");
      persisted.port = port; savePersistedState(statePath, persisted);
      return shouldRestart ? start() : (publish("disabled"), state);
    },
    async syncBootstrap() {
      if (state.phase === "online" && state.origin && currentSecrets) {
        await deliverBootstrap({ phase: "online", origin: state.origin, adminToken: currentSecrets.adminToken, runtimeToken: currentSecrets.runtimeToken });
      } else {
        await deliverBootstrap({ phase: state.phase });
      }
    },
    async diagnose(): Promise<LinkRuntimeDiagnostic> {
      const startedAt = Date.now();
      const result: LinkRuntimeDiagnostic = {
        checkedAt: new Date(startedAt).toISOString(),
        runtimePhase: state.phase,
        resourceReady: metadata.available,
        dataDirectoryReady: existsSync(dataDirectory),
        endpointReachable: false,
      };
      if (state.phase !== "online" || !state.origin || !currentSecrets) {
        return { ...result, ...(state.lastError ? { error: state.lastError } : {}) };
      }
      try {
        const response = await fetch(`${state.origin}/v1/health`, {
          redirect: "error",
          headers: { authorization: `Bearer ${currentSecrets.runtimeToken}` },
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
  if (!existsSync(path)) return { enabled: false, port: null };
  try { const value = JSON.parse(readFileSync(path, "utf8")); return { enabled: value.enabled === true, port: Number.isInteger(value.port) ? value.port : null }; } catch { return { enabled: false, port: null }; }
}
function savePersistedState(path: string, value: PersistedLinkState): void { mkdirSync(dirname(path), { recursive: true }); const temporary = `${path}.tmp`; writeFileSync(temporary, `${JSON.stringify(value)}\n`); renameSync(temporary, path); }
function publicState(persisted: PersistedLinkState, phase: LinkRuntimeState["phase"], version: string, dataDirectory: string, restartCount: number, lastError?: string): LinkRuntimeState { return { enabled: persisted.enabled, phase, port: persisted.port, origin: phase === "online" && persisted.port ? `http://127.0.0.1:${persisted.port}` : null, version, dataDirectory, restartCount, ...(lastError ? { lastError } : {}) }; }
async function isPortFree(port: number): Promise<boolean> { return new Promise((resolve) => { const server = createServer(); server.once("error", () => resolve(false)); server.listen(port, "127.0.0.1", () => server.close(() => resolve(true))); }); }
async function choosePort(): Promise<number> { for (let attempt = 0; attempt < 100; attempt += 1) { const port = randomInt(49152, 65536); if (await isPortFree(port)) return port; } throw new Error("link_port_unavailable"); }
async function waitForHealth(origin: string, token: string): Promise<void> { const deadline = Date.now() + 30_000; let delay = 100; while (Date.now() < deadline) { try { const response = await fetch(`${origin}/v1/health`, { redirect: "error", headers: { authorization: `Bearer ${token}` } }); if (response.ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, delay)); delay = Math.min(1000, delay * 2); } throw new Error("link_health_timeout"); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
