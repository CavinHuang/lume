import { existsSync, watch, type FSWatcher } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { Worker } from "node:worker_threads";

const ATTRIBUTION_GRACE_MS = 120;
const SETTLE_QUIET_MS = 150;
const SETTLE_TIMEOUT_MS = 400;
const WATCHER_READY_TIMEOUT_MS = 10_000;
const MAX_CANDIDATE_PATHS = 10_000;

const MUTATION_WINDOW_TOOLS = new Set(["bash", "write", "edit", "notebookedit", "lsp"]);

export type CodingWorkspaceMonitorReadiness = "ready" | "degraded";
const ISOLATED_WATCHER_SOURCE = String.raw`
  const { watch } = require("node:fs");
  const { resolve } = require("node:path");
  const { parentPort } = require("node:worker_threads");
  const watchers = [];

  parentPort.on("message", (message) => {
    if (message.type === "start") {
      let failed = false;
      for (const root of message.roots) {
        try {
          watchers.push(watch(root, { recursive: true }, (_eventType, filename) => {
            parentPort.postMessage(filename
              ? { type: "event", path: resolve(root, String(filename)) }
              : { type: "unknown" });
          }));
        } catch {
          failed = true;
        }
      }
      parentPort.postMessage({ type: "ready", failed });
      return;
    }
    if (message.type === "stop") {
      for (const watcher of watchers) watcher.close();
      watchers.length = 0;
    }
  });
`;

export interface CodingWorkspaceMonitor {
  start(): void;
  waitUntilReady(): Promise<CodingWorkspaceMonitorReadiness>;
  beginTool(toolName: string): void;
  finishTool(toolName: string, backgroundTaskId?: string, keepOpen?: boolean): void;
  finishBackgroundTask(taskId?: string): void;
  recordAttributedPath(path: string): void;
  settle(): Promise<void>;
  getAttributedPaths(): string[];
  getExternalPaths(): string[];
  hasUnresolvedChanges(): boolean;
  dispose(): void;
}

export function createCodingWorkspaceMonitor(
  roots: string[],
  options: { watchRoots?: string[]; isolatedWatchRoots?: string[] } = {},
): CodingWorkspaceMonitor {
  const workspaceRoots = roots.map((root) => resolve(root));
  const watchRoots = (options.watchRoots ?? roots).map((root) => resolve(root));
  const isolatedWatchRoots = (options.isolatedWatchRoots ?? []).map((root) => resolve(root));
  const watchers: FSWatcher[] = [];
  const attributedPaths = new Set<string>();
  const externalPaths = new Set<string>();
  const openWindows = new Set<number>();
  const pendingWindows = new Map<string, number[]>();
  const backgroundWindows = new Map<string, number>();
  const anonymousBackgroundWindows: number[] = [];
  const closeTimers = new Set<ReturnType<typeof setTimeout>>();
  let nextWindowId = 1;
  let lastEventAt = 0;
  let unresolvedChanges = false;
  let readinessState: "starting" | CodingWorkspaceMonitorReadiness = "starting";
  let resolveReadiness!: (readiness: CodingWorkspaceMonitorReadiness) => void;
  const readinessPromise = new Promise<CodingWorkspaceMonitorReadiness>((resolveReady) => {
    resolveReadiness = resolveReady;
  });
  let readinessTimer: ReturnType<typeof setTimeout> | undefined;
  let isolatedWorker: Worker | undefined;
  let started = false;
  let disposed = false;

  function completeReadiness(degraded: boolean): void {
    if (degraded) unresolvedChanges = true;
    if (readinessState !== "starting") {
      if (degraded) readinessState = "degraded";
      return;
    }
    readinessState = degraded ? "degraded" : "ready";
    if (readinessTimer) {
      clearTimeout(readinessTimer);
      readinessTimer = undefined;
    }
    resolveReadiness(readinessState);
  }

  function addCandidate(path: string, attributed: boolean): void {
    const canonical = resolve(path);
    if (!workspaceRoots.some((root) => isPathInside(root, canonical))) return;
    if (relativePathSegments(canonical).some((segment) => segment.toLowerCase() === ".git")) return;

    if (!attributedPaths.has(canonical) && !externalPaths.has(canonical)
      && attributedPaths.size + externalPaths.size >= MAX_CANDIDATE_PATHS) {
      unresolvedChanges = true;
      return;
    }
    if (attributed) {
      externalPaths.delete(canonical);
      attributedPaths.add(canonical);
      return;
    }
    if (!attributedPaths.has(canonical)) externalPaths.add(canonical);
  }

  function start(): void {
    if (started || disposed) return;
    started = true;
    let startupDegraded = false;
    for (const root of watchRoots) {
      if (!existsSync(root)) {
        startupDegraded = true;
        continue;
      }
      try {
        watchers.push(watch(root, { recursive: true }, (_eventType, filename) => {
          if (!filename) {
            lastEventAt = Date.now();
            unresolvedChanges = true;
            return;
          }
          const path = resolve(root, String(filename));
          if (relativePathSegments(path).some((segment) => segment.toLowerCase() === ".git")) return;
          lastEventAt = Date.now();
          addCandidate(path, openWindows.size > 0);
        }));
      } catch {
        startupDegraded = true;
      }
    }
    if (isolatedWatchRoots.length === 0) {
      completeReadiness(startupDegraded);
    } else {
      readinessTimer = setTimeout(() => completeReadiness(true), WATCHER_READY_TIMEOUT_MS);
      readinessTimer.unref?.();
      try {
        const worker = new Worker(ISOLATED_WATCHER_SOURCE, { eval: true });
        isolatedWorker = worker;
        worker.on("message", (message: { type: "event" | "unknown" | "ready"; path?: string; failed?: boolean }) => {
          if (message.type === "event" && message.path) {
            lastEventAt = Date.now();
            addCandidate(message.path, openWindows.size > 0);
          } else if (message.type === "unknown") {
            lastEventAt = Date.now();
            unresolvedChanges = true;
          } else if (message.type === "ready") {
            completeReadiness(startupDegraded || message.failed === true);
          }
        });
        worker.on("error", () => {
          completeReadiness(true);
        });
        worker.on("exit", () => {
          if (!disposed) completeReadiness(true);
          if (isolatedWorker === worker) isolatedWorker = undefined;
        });
        worker.unref();
        worker.postMessage({ type: "start", roots: isolatedWatchRoots });
      } catch {
        completeReadiness(true);
      }
    }
  }

  function beginTool(toolName: string): void {
    const name = toolName.toLowerCase();
    if (!MUTATION_WINDOW_TOOLS.has(name) || disposed) return;
    if (readinessState === "starting" && name === "bash") unresolvedChanges = true;
    const windowId = nextWindowId++;
    openWindows.add(windowId);
    const queue = pendingWindows.get(name) ?? [];
    queue.push(windowId);
    pendingWindows.set(name, queue);
  }

  function closeWindowLater(windowId: number): void {
    const timer = setTimeout(() => {
      closeTimers.delete(timer);
      openWindows.delete(windowId);
    }, ATTRIBUTION_GRACE_MS);
    closeTimers.add(timer);
  }

  function finishTool(toolName: string, backgroundTaskId?: string, keepOpen = false): void {
    const name = toolName.toLowerCase();
    const queue = pendingWindows.get(name);
    const windowId = queue?.shift();
    if (!windowId) return;
    lastEventAt = Date.now();
    if (queue?.length === 0) pendingWindows.delete(name);
    if (keepOpen) {
      if (backgroundTaskId) backgroundWindows.set(backgroundTaskId, windowId);
      else anonymousBackgroundWindows.push(windowId);
      return;
    }
    closeWindowLater(windowId);
  }

  function finishBackgroundTask(taskId?: string): void {
    const windowId = taskId
      ? backgroundWindows.get(taskId) ?? anonymousBackgroundWindows.shift()
      : anonymousBackgroundWindows.shift();
    if (!windowId) return;
    lastEventAt = Date.now();
    if (taskId) backgroundWindows.delete(taskId);
    closeWindowLater(windowId);
  }

  async function settle(): Promise<void> {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    while (!disposed) {
      const quietFor = lastEventAt === 0 ? SETTLE_QUIET_MS : Date.now() - lastEventAt;
      if (quietFor >= SETTLE_QUIET_MS || Date.now() >= deadline) return;
      await new Promise<void>((resolveWait) => {
        setTimeout(resolveWait, Math.min(SETTLE_QUIET_MS - quietFor, deadline - Date.now()));
      });
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const watcher of watchers) {
      try {
        watcher.close();
      } catch {
        // Closing one failed watcher must not leak the remaining watchers.
      }
    }
    watchers.length = 0;
    for (const timer of closeTimers) clearTimeout(timer);
    closeTimers.clear();
    if (readinessTimer) {
      clearTimeout(readinessTimer);
      readinessTimer = undefined;
    }
    completeReadiness(true);
    openWindows.clear();
    pendingWindows.clear();
    backgroundWindows.clear();
    anonymousBackgroundWindows.length = 0;
    if (isolatedWorker) {
      try {
        isolatedWorker.postMessage({ type: "stop" });
      } catch {
        // The worker may already have exited after a watcher failure.
      }
      void isolatedWorker.terminate();
      isolatedWorker = undefined;
    }
  }

  return {
    start,
    waitUntilReady: () => readinessPromise,
    beginTool,
    finishTool,
    finishBackgroundTask,
    recordAttributedPath: (path) => addCandidate(path, true),
    settle,
    getAttributedPaths: () => [...attributedPaths],
    getExternalPaths: () => [...externalPaths],
    hasUnresolvedChanges: () => unresolvedChanges || readinessState === "degraded",
    dispose,
  };
}

function relativePathSegments(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}

function isPathInside(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
