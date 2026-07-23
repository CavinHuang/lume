import { resolve } from "node:path";

export const DEFAULT_WORKSPACE_WRITER_LEASE_TTL_MS = 5 * 60 * 1000;

export type Release = (() => void) & {
  heartbeat: () => void;
};

interface ActiveLease {
  owner: string;
  lastHeartbeat: number;
  release: Release;
}

const tails = new Map<string, Promise<void>>();
const activeLeases = new Map<string, ActiveLease>();

/** Serialize workspace mutations across runs without changing tool APIs. */
export async function acquireWorkspaceWriterLease(
  workspaceRoot: string,
  owner: string,
  options: { ttlMs?: number } = {},
): Promise<Release> {
  const key = resolve(workspaceRoot);
  const ttlMs = Math.max(1, options.ttlMs ?? DEFAULT_WORKSPACE_WRITER_LEASE_TTL_MS);
  const active = activeLeases.get(key);
  if (active && Date.now() - active.lastHeartbeat > ttlMs) active.release();

  const previous = tails.get(key) ?? Promise.resolve();
  let resolveCurrent!: () => void;
  let queued!: Promise<void>;
  let released = false;
  const current = new Promise<void>((resolveCurrentPromise) => {
    resolveCurrent = resolveCurrentPromise;
  });
  queued = previous.then(() => current);
  tails.set(key, queued);
  await previous;

  let timer: ReturnType<typeof setInterval> | undefined;
  const release = (() => {
    if (released) return;
    released = true;
    if (timer) clearInterval(timer);
    const currentLease = activeLeases.get(key);
    if (currentLease?.release === release) activeLeases.delete(key);
    if (tails.get(key) === queued) tails.delete(key);
    resolveCurrent();
  }) as Release;
  const lease: ActiveLease = {
    owner,
    lastHeartbeat: Date.now(),
    release,
  };
  release.heartbeat = () => {
    if (!released && activeLeases.get(key) === lease) lease.lastHeartbeat = Date.now();
  };
  activeLeases.set(key, lease);
  timer = setInterval(() => {
    if (Date.now() - lease.lastHeartbeat > ttlMs) release();
  }, Math.min(ttlMs, 30_000));
  timer.unref?.();
  void lease.owner;
  return release;
}
