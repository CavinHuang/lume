import type {
  DesktopAssistantSettings,
  DesktopAppDiscoveryResult,
  DesktopContextSnapshot,
  DesktopContextSuspensionReason,
  DesktopContextTarget,
  DesktopProactiveProposal,
  DesktopProactiveProposalCreatedNotification,
  DesktopProactiveProposalKind,
  DesktopProactiveProposalResult,
  DesktopProactiveProposalStatus,
  DesktopProactiveProposalUpdatedNotification,
} from "@lume/shared";
import { DESKTOP_CONTEXT_IPC_CHANNELS, desktopProposalSuggestedAction, isDesktopActionStatus } from "@lume/shared";
import { createHash } from "node:crypto";
import { DesktopContextStore, type DesktopProposalRecord } from "./desktop-context-store";

type HostInvoke = (method: string, params: Record<string, unknown>) => Promise<unknown>;
type DesktopContextTargetMetadata = Pick<DesktopContextTarget, "app" | "window">;
type GenerateDesktopProposalResult = (input: {
  kind: DesktopProactiveProposalKind;
  snapshots: DesktopContextSnapshot[];
}) => Promise<DesktopProactiveProposalResult | undefined>;

const PERMISSION_POLL_INTERVAL_MS = 250;
const PERMISSION_POLL_ATTEMPTS = 240;
const PERMISSION_HOST_RECONNECT_ATTEMPTS = 4;
const PERMISSION_HOST_RECONNECT_INTERVAL_MS = 250;
const CONTEXT_EVENT_SETTLE_MS = 150;
const CONTEXT_RECONCILE_INTERVAL_MS = 30_000;
const CONTEXT_CHANGE_EVENT_TYPES = new Set([
  "foreground_changed",
  "focus_changed",
  "selection_changed",
  "value_changed",
  "scroll_changed",
  "interaction_changed",
]);

interface DesktopContextStoreLike {
  put(snapshot: DesktopContextSnapshot): void;
  get(id: string): DesktopContextSnapshot | undefined;
  getRedacted(id: string): DesktopContextSnapshot | undefined;
  latestRedacted(): DesktopContextSnapshot | undefined;
  recent(limit?: number): DesktopContextSnapshot[];
  search(query: string, limit?: number): DesktopContextSnapshot[];
  purge(): void;
  stats(): { items: number; bytes: number };
  clear(): void;
  close(): void;
  putProposal?(proposal: DesktopProactiveProposal, fingerprint: string): void;
  listProposalRecords?(): DesktopProposalRecord[];
  updateProposalStatus?(id: string, status: DesktopProactiveProposalStatus): boolean;
}

export class DesktopContextService {
  #store: DesktopContextStoreLike | null = null;
  #key: Buffer | null = null;
  #collector: ReturnType<typeof setInterval> | null = null;
  #lastFingerprint: string | null = null;
  #lastSnapshotId: string | null = null;
  #collectorCapturePending = false;
  #collectorCaptureQueued = false;
  #eventCaptureTimer: ReturnType<typeof setTimeout> | null = null;
  #hostEventSubscriptionEnabled: boolean | null = null;
  #suspensionReasons = new Set<DesktopContextSuspensionReason>();
  #proposals = new Map<string, DesktopProactiveProposal>();
  #proposalFingerprints = new Set<string>();
  #settings: DesktopAssistantSettings;
  readonly #input: {
    dbPath: string;
    settings: DesktopAssistantSettings;
    invokeHost: HostInvoke;
    emitNotification?: (method: string, params: unknown) => void;
    generateProposalResult?: GenerateDesktopProposalResult;
    createStore?: (input: { dbPath: string; key: Buffer; retentionMs: number; maxBytes: number }) => DesktopContextStoreLike;
    now?: () => number;
    manageHostEventSubscription?: boolean;
  };

  constructor(input: {
    dbPath: string;
    settings: DesktopAssistantSettings;
    invokeHost: HostInvoke;
    emitNotification?: (method: string, params: unknown) => void;
    generateProposalResult?: GenerateDesktopProposalResult;
    createStore?: (input: { dbPath: string; key: Buffer; retentionMs: number; maxBytes: number }) => DesktopContextStoreLike;
    now?: () => number;
    manageHostEventSubscription?: boolean;
  }) {
    this.#input = input;
    this.#settings = input.settings;
  }

  unlock(key: Buffer): void {
    if (key.length !== 32) throw new Error("desktop context key must be 32 bytes");
    this.#store?.close();
    this.#store = null;
    this.#key?.fill(0);
    this.#key = Buffer.from(key);
    this.#proposals.clear();
    this.#proposalFingerprints.clear();
    this.#syncCollector();
  }

  setSuspended(reason: DesktopContextSuspensionReason, suspended: boolean): {
    suspended: boolean;
    suspensionReasons: DesktopContextSuspensionReason[];
  } {
    if (suspended) this.#suspensionReasons.add(reason);
    else this.#suspensionReasons.delete(reason);
    this.#syncCollector();
    return {
      suspended: this.#suspensionReasons.size > 0,
      suspensionReasons: [...this.#suspensionReasons],
    };
  }

  updateSettings(settings: DesktopAssistantSettings): void {
    this.#store?.close();
    this.#store = null;
    this.#settings = settings;
    this.#syncCollector();
  }

  getSettings(): DesktopAssistantSettings {
    return structuredClone(this.#settings);
  }

  handleHostNotification(method: string, params: unknown): void {
    const event = asRecord(params);
    if (method !== "context.event" || typeof event.type !== "string" || !CONTEXT_CHANGE_EVENT_TYPES.has(event.type)) return;
    if (!this.#settings.enabled || !this.#key || this.#suspensionReasons.size > 0) return;
    if (this.#eventCaptureTimer) clearTimeout(this.#eventCaptureTimer);
    this.#eventCaptureTimer = setTimeout(() => {
      this.#eventCaptureTimer = null;
      this.#queueCapture();
    }, CONTEXT_EVENT_SETTLE_MS);
    this.#eventCaptureTimer.unref?.();
  }

  async captureCurrent(input: { userInitiated?: boolean } = {}): Promise<unknown> {
    if (this.#suspensionReasons.size > 0) return this.#suspendedResult();
    if (!this.#settings.enabled && input.userInitiated !== true) {
      return { status: "unavailable", message: "desktop assistant is disabled" };
    }
    if (!this.#key) {
      return { status: "unavailable", message: "desktop context store is locked" };
    }
    const response = asRecord(await this.#input.invokeHost(
      "current_context",
      {},
    ));
    if (response.status !== "ok") return attachDesktopPermissionCaptureMessage(response);
    const snapshot = normalizeSnapshot(response.snapshot);
    if (!snapshot) return { status: "failed", message: "desktop host returned an invalid context snapshot" };
    if (isLumeShellSnapshot(snapshot)) {
      return { status: "unavailable", message: LUME_SELF_CONTEXT_MESSAGE };
    }
    const allowed = new Set(this.#settings.allowedApps.map((app) => app.trim().toLowerCase()).filter(Boolean));
    if (input.userInitiated !== true && !allowed.has(snapshot.app.id.toLowerCase())) {
      return { status: "blocked", message: `desktop context is not allowed for ${snapshot.app.id}` };
    }
    const fingerprint = snapshotFingerprint(snapshot);
    const hasScreenshotPixels = snapshot.screenshots?.some((screenshot) => typeof screenshot.dataUrl === "string") === true;
    if (!hasScreenshotPixels && fingerprint === this.#lastFingerprint && this.#lastSnapshotId) {
      return { status: "ok", snapshotId: this.#lastSnapshotId, unchanged: true };
    }
    const store = this.#ensureStore();
    store.put(snapshot);
    store.purge();
    this.#lastFingerprint = fingerprint;
    this.#lastSnapshotId = snapshot.id;
    this.#maybeCreateProposal(store.getRedacted(snapshot.id), store);
    return { status: "ok", ...snapshotToTarget(snapshot) };
  }

  async getForegroundTarget(): Promise<unknown> {
    if (this.#suspensionReasons.size > 0) return this.#suspendedResult();
    const response = asRecord(await this.#input.invokeHost("get_window", {}));
    if (response.status !== "ok") return attachDesktopPermissionCaptureMessage(response);
    const target = targetFromWindow(response.window);
    if (!target) return { status: "failed", message: "desktop host returned an invalid window target" };
    if (isLumeShellTarget(target)) return { status: "unavailable", message: LUME_SELF_CONTEXT_MESSAGE };
    return { status: "ok", ...target };
  }

  async listApps(): Promise<DesktopAppDiscoveryResult> {
    const response = asRecord(await this.#input.invokeHost("list_apps", {}));
    const status = isDesktopActionStatus(response.status) ? response.status : "failed";
    if (status !== "ok") {
      return {
        status,
        apps: [],
        ...(stringValue(response.message) ? { message: stringValue(response.message) } : {}),
      };
    }
    const apps = Array.isArray(response.apps) ? response.apps : [];
    const seen = new Set<string>();
    const projection: DesktopAppDiscoveryResult["apps"] = [];
    for (const candidate of apps) {
      const app = asRecord(candidate);
      const id = stringValue(app.id);
      if (!id || seen.has(id.toLowerCase())) continue;
      const name = stringValue(app.name) ?? stringValue(app.displayName) ?? id;
      seen.add(id.toLowerCase());
      projection.push({ id, name, isRunning: app.isRunning !== false });
    }
    return { status: "ok", apps: projection };
  }

  async captureWindow(input: { windowId?: string; userInitiated?: boolean } = {}): Promise<unknown> {
    if (this.#suspensionReasons.size > 0) return this.#suspendedResult();
    if (!this.#settings.enabled && input.userInitiated !== true) {
      return { status: "unavailable", message: "desktop assistant is disabled" };
    }
    if (!this.#key) {
      return { status: "unavailable", message: "desktop context store is locked" };
    }
    const windowId = input.windowId?.trim();
    if (!windowId) return { status: "failed", message: "windowId is required" };
    const state = asRecord(await this.#input.invokeHost("get_window_state", {
      windowId,
    }));
    if (state.status !== "ok") return attachDesktopPermissionCaptureMessage(state);
    const snapshot = snapshotFromWindowStateTarget(state);
    if (!snapshot) return { status: "failed", message: "desktop host returned an invalid window state" };
    if (isLumeShellSnapshot(snapshot)) return { status: "unavailable", message: LUME_SELF_CONTEXT_MESSAGE };
    if (snapshot.window.id !== windowId) {
      return { status: "stale_target", message: "desktop context target changed" };
    }
    const allowed = new Set(this.#settings.allowedApps.map((app) => app.trim().toLowerCase()).filter(Boolean));
    if (input.userInitiated !== true && !allowed.has(snapshot.app.id.toLowerCase())) {
      return { status: "blocked", message: `desktop context is not allowed for ${snapshot.app.id}` };
    }
    const store = this.#ensureStore();
    store.put(snapshot);
    store.purge();
    this.#lastFingerprint = snapshotFingerprint(snapshot);
    this.#lastSnapshotId = snapshot.id;
    this.#maybeCreateProposal(store.getRedacted(snapshot.id), store);
    return { status: "ok", ...snapshotToTarget(snapshot) };
  }

  async requestPermissions(): Promise<unknown> {
    let latest = asRecord(await this.#input.invokeHost("request_permissions", {}));
    for (let attempt = 0; attempt < PERMISSION_HOST_RECONNECT_ATTEMPTS; attempt += 1) {
      if (!isTransientHostUnavailable(latest)) break;
      await wait(PERMISSION_HOST_RECONNECT_INTERVAL_MS);
      latest = asRecord(await this.#input.invokeHost("request_permissions", {}));
    }
    if (latest.status === "ok") return completedPermissionDiagnostics(latest);
    if (latest.status !== "permission_denied") return latest;

    let requestedPermissionId = nextPermissionId(latest);
    for (let attempt = 0; attempt < PERMISSION_POLL_ATTEMPTS; attempt += 1) {
      await wait(PERMISSION_POLL_INTERVAL_MS);
      const diagnostics = asRecord(await this.#input.invokeHost("diagnose_permissions", {}));
      if (diagnostics.status === "ok") return completedPermissionDiagnostics(diagnostics);
      if (diagnostics.status !== "permission_denied") return diagnostics;

      const nextId = nextPermissionId(diagnostics);
      if (nextId && nextId !== requestedPermissionId) {
        latest = asRecord(await this.#input.invokeHost("request_permissions", {}));
        requestedPermissionId = nextId;
        if (latest.status === "ok") return completedPermissionDiagnostics(latest);
        if (latest.status !== "permission_denied") return latest;
      } else {
        latest = diagnostics;
      }
    }

    return {
      ...latest,
      message: "授权仍在等待系统设置确认。完成后请返回 Lume 重新检查。",
    };
  }

  async currentContext(input: { snapshotId?: string; includeScreenshot?: boolean; refresh?: boolean } = {}): Promise<unknown> {
    if (this.#suspensionReasons.size > 0) return this.#suspendedResult();
    if (!this.#key) return { status: "unavailable", message: "desktop context store is locked" };
    if (!this.#settings.enabled && !input.snapshotId) {
      return { status: "unavailable", message: "desktop assistant is disabled" };
    }
    const store = this.#ensureStore();
    if (input.refresh === true && input.snapshotId) {
      return this.#refreshSnapshot(store, input.snapshotId, input.includeScreenshot === true);
    }
    const snapshot = input.snapshotId
      ? store.getRedacted(input.snapshotId)
      : store.latestRedacted();
    const rawSnapshot = input.includeScreenshot === true && input.snapshotId
      ? store.get(input.snapshotId)
      : undefined;
    return snapshot
      ? { status: "ok", snapshot: attachScreenshotPixels(snapshot, rawSnapshot) }
      : { status: "unavailable", message: "desktop context snapshot was not found" };
  }

  async searchContext(input: { query?: string; limit?: number }): Promise<unknown> {
    if (this.#suspensionReasons.size > 0) return this.#suspendedResult();
    if (!this.#settings.enabled) return { status: "unavailable", message: "desktop assistant is disabled" };
    if (!this.#key) return { status: "unavailable", message: "desktop context store is locked" };
    const query = input.query?.trim();
    if (!query) return { status: "failed", message: "query is required" };
    return { status: "ok", snapshots: this.#ensureStore().search(query, input.limit) };
  }

  async getStatus(): Promise<unknown> {
    const diagnostics = asRecord(await this.#input.invokeHost("diagnose_permissions", {}));
    const host = diagnostics.status === "unavailable"
      ? asRecord(await this.#input.invokeHost("list_windows", {}).catch(() => diagnostics))
      : diagnostics;
    const stats = this.#store?.stats() ?? { items: 0, bytes: 0 };
    return {
      host: desktopAssistantHostStatus(host, diagnostics),
      store: { unlocked: this.#key !== null, ...stats },
      collector: {
        running: this.#collector !== null,
        suspensionReasons: [...this.#suspensionReasons],
      },
    };
  }

  clear(): { cleared: boolean } {
    if (this.#key) this.#ensureStore().clear();
    this.#proposals.clear();
    this.#proposalFingerprints.clear();
    return { cleared: true };
  }

  listActivity(limit?: number): DesktopContextSnapshot[] {
    return this.#store?.recent(limit) ?? [];
  }

  listProposals(): DesktopProactiveProposal[] {
    if (this.#key) this.#ensureStore();
    const now = this.#now();
    for (const [id, proposal] of this.#proposals) {
      if (proposal.status === "pending" && proposal.expiresAt <= now) {
        this.#proposals.set(id, { ...proposal, status: "expired" });
        this.#store?.updateProposalStatus?.(id, "expired");
      }
    }
    return Array.from(this.#proposals.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((proposal) => structuredClone(proposal));
  }

  updateProposal(id: string, status: DesktopProactiveProposalStatus): { updated: boolean } {
    if (this.#key) this.#ensureStore();
    const proposal = this.#proposals.get(id);
    if (!proposal) return { updated: false };
    this.#proposals.set(id, { ...proposal, status });
    this.#store?.updateProposalStatus?.(id, status);
    return { updated: true };
  }

  close(): void {
    if (this.#collector) clearInterval(this.#collector);
    if (this.#eventCaptureTimer) clearTimeout(this.#eventCaptureTimer);
    this.#collector = null;
    this.#eventCaptureTimer = null;
    this.#syncHostEventSubscription(false);
    this.#store?.close();
    this.#store = null;
    this.#key?.fill(0);
    this.#key = null;
  }

  #syncCollector(): void {
    if (this.#collector) clearInterval(this.#collector);
    if (this.#eventCaptureTimer) clearTimeout(this.#eventCaptureTimer);
    this.#collector = null;
    this.#eventCaptureTimer = null;
    const active = this.#settings.enabled && this.#key !== null && this.#suspensionReasons.size === 0;
    this.#syncHostEventSubscription(active);
    if (!active) return;
    this.#collector = setInterval(() => {
      this.#queueCapture();
    }, CONTEXT_RECONCILE_INTERVAL_MS);
    this.#collector.unref?.();
  }

  #queueCapture(): void {
    this.#collectorCaptureQueued = true;
    if (this.#collectorCapturePending) return;
    this.#collectorCapturePending = true;
    void (async () => {
      while (this.#collectorCaptureQueued) {
        this.#collectorCaptureQueued = false;
        await this.captureCurrent().catch(() => undefined);
      }
    })().finally(() => {
      this.#collectorCapturePending = false;
    });
  }

  #syncHostEventSubscription(enabled: boolean): void {
    if (this.#input.manageHostEventSubscription !== true) return;
    if (this.#hostEventSubscriptionEnabled === enabled) return;
    this.#hostEventSubscriptionEnabled = enabled;
    void this.#input.invokeHost("system.set_event_subscription", { enabled })
      .then((result) => {
        if (asRecord(result).status !== "ok" && this.#hostEventSubscriptionEnabled === enabled) {
          this.#hostEventSubscriptionEnabled = null;
        }
      })
      .catch(() => {
        if (this.#hostEventSubscriptionEnabled === enabled) {
          this.#hostEventSubscriptionEnabled = null;
        }
      });
  }

  #ensureStore(): DesktopContextStoreLike {
    if (this.#store) return this.#store;
    if (!this.#key) throw new Error("desktop context store is locked");
    const createStore = this.#input.createStore ?? ((options) => new DesktopContextStore(options));
    this.#store = createStore({
      dbPath: this.#input.dbPath,
      key: this.#key,
      retentionMs: this.#settings.retentionHours * 60 * 60 * 1_000,
      maxBytes: this.#settings.maxStorageBytes,
    });
    this.#store.purge();
    for (const record of this.#store.listProposalRecords?.() ?? []) {
      this.#proposals.set(record.proposal.id, record.proposal);
      this.#proposalFingerprints.add(record.fingerprint);
    }
    return this.#store;
  }

  #suspendedResult(): { status: "blocked"; message: string } {
    return {
      status: "blocked",
      message: `desktop context capture is suspended: ${[...this.#suspensionReasons].join(", ")}`,
    };
  }

  #maybeCreateProposal(snapshot: DesktopContextSnapshot | undefined, store: DesktopContextStoreLike): void {
    if (!this.#settings.proactiveEnabled || !snapshot) return;
    const visibleText = [snapshot.selectedText, snapshot.visibleText].filter(Boolean).join("\n");
    const createdAt = this.#now();
    for (const kind of proposalKinds(visibleText, this.#settings, createdAt)) {
      const fingerprint = proposalFingerprint(kind, snapshot, visibleText, createdAt);
      if (this.#proposalFingerprints.has(fingerprint)) continue;
      this.#proposalFingerprints.add(fingerprint);
      const proposal: DesktopProactiveProposal = {
        id: `proposal:${kind}:${snapshot.id}`,
        kind,
        status: "pending",
        snapshotId: snapshot.id,
        app: { id: snapshot.app.id, name: snapshot.app.name },
        window: { id: snapshot.window.id, title: snapshot.window.title },
        summary: proposalSummary(kind, snapshot.app.name),
        resultStatus: this.#input.generateProposalResult ? "generating" : "unavailable",
        createdAt,
        expiresAt: createdAt + proposalLifetimeMs(kind),
      };
      this.#proposals.set(proposal.id, proposal);
      this.#store?.putProposal?.(proposal, fingerprint);
      if (this.#settings.notificationsEnabled !== false) {
        this.#input.emitNotification?.(
          DESKTOP_CONTEXT_IPC_CHANNELS.PROPOSAL_CREATED,
          proposalToCreatedNotification(proposal),
        );
      }
      this.#generateProposalResult(proposal, fingerprint, store);
    }
  }

  #generateProposalResult(
    proposal: DesktopProactiveProposal,
    fingerprint: string,
    store: DesktopContextStoreLike,
  ): void {
    const generate = this.#input.generateProposalResult;
    if (!generate) return;
    const snapshots = proposal.kind === "daily_wrap"
      ? store.recent(50).filter((snapshot) => snapshot.capturedAt >= proposal.createdAt - 24 * 60 * 60 * 1_000)
      : [store.getRedacted(proposal.snapshotId)].filter((snapshot): snapshot is DesktopContextSnapshot => Boolean(snapshot));
    void generate({ kind: proposal.kind, snapshots })
      .then((result) => {
        const current = this.#proposals.get(proposal.id);
        if (!current) return;
        const normalized = normalizeProposalResult(proposal.kind, result);
        const next: DesktopProactiveProposal = normalized
          ? { ...current, resultStatus: "ready", result: normalized }
          : { ...current, resultStatus: "unavailable" };
        this.#commitGeneratedProposal(next, fingerprint, store);
      })
      .catch(() => {
        const current = this.#proposals.get(proposal.id);
        if (!current) return;
        const next: DesktopProactiveProposal = { ...current, resultStatus: "failed" };
        this.#commitGeneratedProposal(next, fingerprint, store);
      });
  }

  #commitGeneratedProposal(
    proposal: DesktopProactiveProposal,
    fingerprint: string,
    store: DesktopContextStoreLike,
  ): void {
    this.#proposals.set(proposal.id, proposal);
    try {
      store.putProposal?.(proposal, fingerprint);
      this.#emitProposalUpdated(proposal);
    } catch {
      // The service may close while a background model request is still in flight.
    }
  }

  #emitProposalUpdated(proposal: DesktopProactiveProposal): void {
    const notification: DesktopProactiveProposalUpdatedNotification = {
      proposal: {
        id: proposal.id,
        status: proposal.status,
        resultStatus: proposal.resultStatus,
      },
    };
    this.#input.emitNotification?.(DESKTOP_CONTEXT_IPC_CHANNELS.PROPOSAL_UPDATED, notification);
  }

  #now(): number {
    return this.#input.now?.() ?? Date.now();
  }

  async #refreshSnapshot(
    store: DesktopContextStoreLike,
    snapshotId: string,
    includeScreenshot: boolean,
  ): Promise<unknown> {
    const anchor = store.getRedacted(snapshotId);
    if (!anchor) return { status: "unavailable", message: "desktop context snapshot was not found" };
    const state = asRecord(await this.#input.invokeHost("get_window_state", {
      windowId: anchor.window.id,
      ...(includeScreenshot ? { includeScreenshot: true } : {}),
    }));
    if (state.status !== "ok") return state;
    const refreshed = snapshotFromWindowState(anchor, state);
    if (!refreshed) return { status: "failed", message: "desktop host returned an invalid window state" };
    if (refreshed.window.id !== anchor.window.id || refreshed.app.id !== anchor.app.id) {
      return { status: "stale_target", message: "desktop context target changed" };
    }
    store.put(refreshed);
    store.purge();
    this.#lastFingerprint = snapshotFingerprint(refreshed);
    this.#lastSnapshotId = refreshed.id;
    const redacted = store.getRedacted(refreshed.id) ?? refreshed;
    const raw = includeScreenshot ? store.get(refreshed.id) : undefined;
    return { status: "ok", snapshot: attachScreenshotPixels(redacted, raw) };
  }
}

function nextPermissionId(value: Record<string, unknown>): string | undefined {
  const next = asRecord(value.nextPermission);
  return typeof next.id === "string" && next.id.trim() ? next.id.trim() : undefined;
}

function completedPermissionDiagnostics(value: Record<string, unknown>): Record<string, unknown> {
  const target = asRecord(value.permissionTarget);
  const appBundleName = typeof target.appBundleName === "string" && target.appBundleName.trim()
    ? target.appBundleName.trim()
    : "Lume Computer Use.app";
  return {
    ...value,
    message: `${appBundleName} 已获得桌面控制权限。`,
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isTransientHostUnavailable(value: Record<string, unknown>): boolean {
  if (value.status !== "unavailable") return false;
  const message = typeof value.message === "string" ? value.message : "";
  return /desktop host connection (failed|closed)|desktop host is not connected/i.test(message);
}

const LUME_SELF_CONTEXT_MESSAGE = "当前前台窗口是 Lume，请切回目标应用后再唤起或附加上下文。";

function proposalKinds(
  text: string,
  settings: DesktopAssistantSettings,
  now: number,
): DesktopProactiveProposalKind[] {
  const kinds: DesktopProactiveProposalKind[] = [];
  const primary = classifyProposalKind(text);
  if (primary) kinds.push(primary);
  if (settings.dailyWrapEnabled === true && new Date(now).getHours() >= 17) {
    kinds.push("daily_wrap");
  }
  return kinds;
}

function classifyProposalKind(text: string): DesktopProactiveProposalKind | undefined {
  const normalized = text.trim();
  if (!normalized) return undefined;
  if (/(?:冲突|撞期|时间重叠|日程重叠|schedule conflict|double[- ]booked|overlap)/iu.test(normalized)) {
    return "conflict";
  }
  if (/(?:报错|错误|失败|无法|卡住|崩溃|error|failed|failure|unable|stuck|crash)/iu.test(normalized)) {
    return "prompt_rescue";
  }
  if (/[?？]|(?:吗|么|如何|怎么|什么时候|能否|是否|回复|请问)/u.test(normalized)) {
    return "reply";
  }
  if (/(?:跟进|待办|提醒|截止|明天|后天|下周|follow[- ]?up|todo|remind|deadline)/iu.test(normalized)) {
    return "follow_up";
  }
  return undefined;
}

function proposalFingerprint(
  kind: DesktopProactiveProposalKind,
  snapshot: DesktopContextSnapshot,
  text: string,
  now: number,
): string {
  const source = kind === "daily_wrap"
    ? `daily_wrap\u0000${localDateKey(now)}`
    : `${kind}\u0000${snapshot.app.id}\u0000${snapshot.window.id}\u0000${text}`;
  return createHash("sha256").update(source).digest("hex");
}

function localDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part) => String(part).padStart(2, "0"))
    .join("-");
}

function proposalSummary(kind: DesktopProactiveProposalKind, appName: string): string {
  switch (kind) {
    case "reply": return `${appName} 中可能有一条需要回复的消息`;
    case "conflict": return `${appName} 中可能存在需要处理的安排冲突`;
    case "prompt_rescue": return `${appName} 中可能有一个需要协助解决的问题`;
    case "daily_wrap": return "今天的桌面活动可以开始整理";
    case "follow_up": return `${appName} 中可能有一项需要跟进的事项`;
  }
}

function proposalLifetimeMs(kind: DesktopProactiveProposalKind): number {
  if (kind === "follow_up") return 24 * 60 * 60 * 1_000;
  if (kind === "daily_wrap") return 12 * 60 * 60 * 1_000;
  return 30 * 60 * 1_000;
}

function normalizeProposalResult(
  kind: DesktopProactiveProposalKind,
  result: DesktopProactiveProposalResult | undefined,
): DesktopProactiveProposalResult | undefined {
  const title = result?.title.trim().slice(0, 80);
  const body = result?.body.trim().slice(0, 2_000);
  if (!title || !body) return undefined;
  return {
    title,
    body,
    suggestedAction: desktopProposalSuggestedAction(kind),
  };
}

function proposalToCreatedNotification(proposal: DesktopProactiveProposal): DesktopProactiveProposalCreatedNotification {
  return {
    proposal: {
      id: proposal.id,
      kind: proposal.kind,
      status: proposal.status,
      snapshotId: proposal.snapshotId,
      app: proposal.app,
      createdAt: proposal.createdAt,
      expiresAt: proposal.expiresAt,
    },
  };
}

function snapshotToTarget(snapshot: DesktopContextSnapshot): DesktopContextTarget {
  return {
    snapshotId: snapshot.id,
    app: { id: snapshot.app.id, name: snapshot.app.name },
    window: { id: snapshot.window.id, title: snapshot.window.title },
    capturedAt: snapshot.capturedAt,
  };
}

function targetFromWindow(value: unknown): DesktopContextTargetMetadata | null {
  const window = asRecord(value);
  if (
    typeof window.id !== "string"
    || typeof window.appId !== "string"
    || typeof window.title !== "string"
  ) return null;
  return {
    app: {
      id: window.appId,
      name: typeof window.appName === "string" ? window.appName : window.appId,
    },
    window: { id: window.id, title: window.title },
  };
}

function isLumeShellTarget(target: DesktopContextTargetMetadata): boolean {
  return isLumeShellSnapshot({
    id: "target",
    app: target.app,
    window: {
      id: target.window.id,
      appId: target.app.id,
      title: target.window.title,
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      focused: false,
    },
    capturedAt: 0,
    eventType: "foreground_changed",
    untrusted: true,
  });
}

function snapshotFingerprint(snapshot: DesktopContextSnapshot): string {
  return [
    snapshot.app.id,
    snapshot.window.id,
    snapshot.window.title,
    snapshot.selectedText ?? "",
    snapshot.visibleText ?? "",
  ].join("\u0000");
}

function normalizeSnapshot(value: unknown): DesktopContextSnapshot | null {
  const snapshot = asRecord(value);
  const app = asRecord(snapshot.app);
  const window = asRecord(snapshot.window);
  if (
    typeof snapshot.id !== "string"
    || typeof snapshot.capturedAt !== "number"
    || typeof app.id !== "string"
    || typeof app.name !== "string"
    || typeof window.id !== "string"
    || typeof window.title !== "string"
  ) return null;
  return value as DesktopContextSnapshot;
}

function snapshotFromWindowStateTarget(value: Record<string, unknown>): DesktopContextSnapshot | null {
  const window = asRecord(value.window);
  const accessibility = asRecord(value.accessibility);
  if (
    typeof value.capturedAt !== "number"
    || typeof window.id !== "string"
    || typeof window.appId !== "string"
    || typeof window.title !== "string"
  ) return null;
  const screenshots = Array.isArray(value.screenshots)
    ? value.screenshots as DesktopContextSnapshot["screenshots"]
    : undefined;
  const capturedAt = value.capturedAt;
  const visibleText = contextVisibleText(accessibility, window);
  return {
    id: `window:${window.id}:${capturedAt}`,
    app: {
      id: window.appId,
      name: typeof window.appName === "string" ? window.appName : window.appId,
      ...(typeof window.processId === "number" ? { processId: window.processId } : {}),
    },
    window: window as DesktopContextSnapshot["window"],
    capturedAt,
    eventType: "foreground_changed",
    ...(typeof accessibility.selectedText === "string" && accessibility.selectedText.trim()
      ? { selectedText: accessibility.selectedText }
      : {}),
    ...(visibleText ? { visibleText } : {}),
    ...contextQualityFields(value),
    ...(screenshots?.[0]?.id ? { screenshotId: screenshots[0].id } : {}),
    ...(screenshots ? { screenshots } : {}),
    untrusted: true,
  };
}

function isLumeShellSnapshot(snapshot: DesktopContextSnapshot): boolean {
  const appId = normalizeSelfContextText(snapshot.app.id);
  const appName = normalizeSelfContextText(snapshot.app.name);
  const title = normalizeSelfContextText(snapshot.window.title);
  const exactLumeApp = appId === "lume" || appId === "lume.exe" || appName === "lume" || appName === "lume.exe";
  const electronShell = appId === "electron" || appId === "electron.exe" || appName === "electron" || appName === "electron.exe";
  return exactLumeApp || (electronShell && title.includes("lume"));
}

function normalizeSelfContextText(value: string): string {
  return value.trim().toLowerCase();
}

function snapshotFromWindowState(
  anchor: DesktopContextSnapshot,
  value: Record<string, unknown>,
): DesktopContextSnapshot | null {
  const window = asRecord(value.window);
  const accessibility = asRecord(value.accessibility);
  if (
    typeof value.capturedAt !== "number"
    || typeof window.id !== "string"
    || typeof window.appId !== "string"
    || typeof window.title !== "string"
  ) return null;
  const screenshots = Array.isArray(value.screenshots)
    ? value.screenshots as DesktopContextSnapshot["screenshots"]
    : undefined;
  const capturedAt = value.capturedAt;
  const visibleText = contextVisibleText(accessibility, window);
  return {
    id: `refresh:${anchor.id}:${capturedAt}`,
    app: {
      id: window.appId,
      name: typeof window.appName === "string" ? window.appName : anchor.app.name,
      ...(typeof window.processId === "number" ? { processId: window.processId } : {}),
    },
    window: window as DesktopContextSnapshot["window"],
    capturedAt,
    eventType: "typing_idle",
    ...(typeof accessibility.selectedText === "string" && accessibility.selectedText.trim()
      ? { selectedText: accessibility.selectedText }
      : {}),
    ...(visibleText ? { visibleText } : {}),
    ...contextQualityFields(value),
    ...(screenshots?.[0]?.id ? { screenshotId: screenshots[0].id } : {}),
    ...(screenshots ? { screenshots } : {}),
    untrusted: true,
  };
}

function contextVisibleText(accessibility: Record<string, unknown>, window: Record<string, unknown>): string | undefined {
  const documentText = typeof accessibility.documentText === "string" ? accessibility.documentText.trim() : "";
  if (documentText) return documentText;
  const visibleText = typeof accessibility.visibleText === "string" ? accessibility.visibleText.trim() : "";
  if (visibleText) return visibleText;
  const title = typeof window.title === "string" ? window.title.trim() : "";
  return title || undefined;
}

function contextQualityFields(value: Record<string, unknown>): Pick<
  DesktopContextSnapshot,
  "textSource" | "completeness" | "fallbackReason"
> {
  const textSources = new Set([
    "accessibility_selection",
    "accessibility_document",
    "accessibility_visible",
    "accessibility_tree",
    "window_title",
  ]);
  const completenessValues = new Set(["complete", "partial", "minimal"]);
  const textSource = typeof value.textSource === "string" && textSources.has(value.textSource)
    ? value.textSource as DesktopContextSnapshot["textSource"]
    : undefined;
  const completeness = typeof value.completeness === "string" && completenessValues.has(value.completeness)
    ? value.completeness as DesktopContextSnapshot["completeness"]
    : undefined;
  const fallbackReason = typeof value.fallbackReason === "string" && value.fallbackReason.trim()
    ? value.fallbackReason.trim()
    : undefined;
  return {
    ...(textSource ? { textSource } : {}),
    ...(completeness ? { completeness } : {}),
    ...(fallbackReason ? { fallbackReason } : {}),
  };
}

function attachScreenshotPixels(
  redacted: DesktopContextSnapshot,
  raw: DesktopContextSnapshot | undefined,
): DesktopContextSnapshot {
  if (!raw?.screenshots?.length) return redacted;
  return {
    ...redacted,
    screenshots: raw.screenshots.map((rawScreenshot) => {
      const redactedScreenshot = redacted.screenshots?.find((item) => item.id === rawScreenshot.id);
      return { ...rawScreenshot, ...redactedScreenshot, dataUrl: rawScreenshot.dataUrl };
    }),
  };
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function attachDesktopPermissionCaptureMessage(response: Record<string, any>): Record<string, any> {
  const target = asRecord(response.permissionTarget);
  const appName = stringValue(target.appBundleName) ?? stringValue(target.appName);
  if (!appName || !Array.isArray(response.permissions)) return response;

  const missingPermissions = response.permissions
    .map(asRecord)
    .filter((permission) => permission.status !== "granted")
    .map((permission) => stringValue(permission.title) ?? stringValue(permission.id))
    .filter((permission): permission is string => Boolean(permission));
  if (missingPermissions.length === 0) return response;

  return {
    ...response,
    message: `需要在 macOS 系统设置中授权 ${appName}：${missingPermissions.join("、")}。请授权 computer use 包，而不是 Lume 主应用。`,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function desktopAssistantHostStatus(
  host: Record<string, any>,
  diagnostics: Record<string, any>,
): Record<string, unknown> {
  const status = isDesktopActionStatus(host.status) ? host.status : "unavailable";
  const permissionTarget = asRecord(diagnostics.permissionTarget);
  const permissions = Array.isArray(diagnostics.permissions)
    ? diagnostics.permissions.map(asRecord)
    : undefined;
  return {
    status,
    ...(typeof host.message === "string" ? { message: host.message } : {}),
    ...(Object.keys(permissionTarget).length > 0 ? { permissionTarget } : {}),
    ...(permissions ? { permissions } : {}),
  };
}
