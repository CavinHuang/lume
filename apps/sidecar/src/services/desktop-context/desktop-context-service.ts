import type {
  DesktopAssistantSettings,
  DesktopContextSnapshot,
  DesktopContextTarget,
  DesktopProactiveProposal,
  DesktopProactiveProposalCreatedNotification,
  DesktopProactiveProposalStatus,
} from "@lume/shared";
import { DESKTOP_CONTEXT_IPC_CHANNELS } from "@lume/shared";
import { DesktopContextStore } from "./desktop-context-store";

type HostInvoke = (method: string, params: Record<string, unknown>) => Promise<unknown>;

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
}

export class DesktopContextService {
  #store: DesktopContextStoreLike | null = null;
  #key: Buffer | null = null;
  #collector: ReturnType<typeof setInterval> | null = null;
  #lastFingerprint: string | null = null;
  #lastSnapshotId: string | null = null;
  #collectorCapturePending = false;
  #proposals = new Map<string, DesktopProactiveProposal>();
  #proposalFingerprints = new Set<string>();
  #settings: DesktopAssistantSettings;
  readonly #input: {
    dbPath: string;
    settings: DesktopAssistantSettings;
    invokeHost: HostInvoke;
    emitNotification?: (method: string, params: unknown) => void;
    createStore?: (input: { dbPath: string; key: Buffer; retentionMs: number; maxBytes: number }) => DesktopContextStoreLike;
  };

  constructor(input: {
    dbPath: string;
    settings: DesktopAssistantSettings;
    invokeHost: HostInvoke;
    emitNotification?: (method: string, params: unknown) => void;
    createStore?: (input: { dbPath: string; key: Buffer; retentionMs: number; maxBytes: number }) => DesktopContextStoreLike;
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
    this.#syncCollector();
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

  async captureCurrent(input: { userInitiated?: boolean } = {}): Promise<unknown> {
    if (!this.#settings.enabled && input.userInitiated !== true) {
      return { status: "unavailable", message: "desktop assistant is disabled" };
    }
    if (!this.#key) {
      return { status: "unavailable", message: "desktop context store is locked" };
    }
    const response = asRecord(await this.#input.invokeHost(
      "current_context",
      input.userInitiated === true ? { includeScreenshot: true } : {},
    ));
    if (response.status !== "ok") return attachDesktopPermissionCaptureMessage(response);
    const snapshot = normalizeSnapshot(response.snapshot);
    if (!snapshot) return { status: "failed", message: "desktop host returned an invalid context snapshot" };
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
    this.#maybeCreateProposal(snapshot);
    return { status: "ok", ...snapshotToTarget(snapshot) };
  }

  async currentContext(input: { snapshotId?: string; includeScreenshot?: boolean; refresh?: boolean } = {}): Promise<unknown> {
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
    if (!this.#settings.enabled) return { status: "unavailable", message: "desktop assistant is disabled" };
    if (!this.#key) return { status: "unavailable", message: "desktop context store is locked" };
    const query = input.query?.trim();
    if (!query) return { status: "failed", message: "query is required" };
    return { status: "ok", snapshots: this.#ensureStore().search(query, input.limit) };
  }

  async getStatus(): Promise<unknown> {
    const host = asRecord(await this.#input.invokeHost("list_windows", {}));
    const stats = this.#store?.stats() ?? { items: 0, bytes: 0 };
    return {
      host: {
        status: typeof host.status === "string" ? host.status : "unavailable",
        ...(typeof host.message === "string" ? { message: host.message } : {}),
      },
      store: { unlocked: this.#key !== null, ...stats },
    };
  }

  clear(): { cleared: boolean } {
    this.#store?.clear();
    return { cleared: true };
  }

  listActivity(limit?: number): DesktopContextSnapshot[] {
    return this.#store?.recent(limit) ?? [];
  }

  listProposals(): DesktopProactiveProposal[] {
    const now = Date.now();
    for (const [id, proposal] of this.#proposals) {
      if (proposal.status === "pending" && proposal.expiresAt <= now) {
        this.#proposals.set(id, { ...proposal, status: "expired" });
      }
    }
    return Array.from(this.#proposals.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((proposal) => structuredClone(proposal));
  }

  updateProposal(id: string, status: DesktopProactiveProposalStatus): { updated: boolean } {
    const proposal = this.#proposals.get(id);
    if (!proposal) return { updated: false };
    this.#proposals.set(id, { ...proposal, status });
    return { updated: true };
  }

  close(): void {
    if (this.#collector) clearInterval(this.#collector);
    this.#collector = null;
    this.#store?.close();
    this.#store = null;
    this.#key?.fill(0);
    this.#key = null;
  }

  #syncCollector(): void {
    if (this.#collector) clearInterval(this.#collector);
    this.#collector = null;
    if (!this.#settings.enabled || !this.#key) return;
    this.#collector = setInterval(() => {
      if (this.#collectorCapturePending) return;
      this.#collectorCapturePending = true;
      void this.captureCurrent()
        .catch(() => undefined)
        .finally(() => { this.#collectorCapturePending = false; });
    }, 3_000);
    this.#collector.unref?.();
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
    return this.#store;
  }

  #maybeCreateProposal(snapshot: DesktopContextSnapshot): void {
    if (!this.#settings.proactiveEnabled) return;
    const visibleText = [snapshot.selectedText, snapshot.visibleText].filter(Boolean).join("\n");
    if (!looksLikeReplyOpportunity(visibleText)) return;
    const fingerprint = `${snapshot.app.id}\u0000${snapshot.window.id}\u0000${snapshot.window.title}\u0000${visibleText}`;
    if (this.#proposalFingerprints.has(fingerprint)) return;
    this.#proposalFingerprints.add(fingerprint);
    const createdAt = Date.now();
    const proposal: DesktopProactiveProposal = {
      id: `proposal:${snapshot.id}`,
      kind: "reply",
      status: "pending",
      snapshotId: snapshot.id,
      app: { id: snapshot.app.id, name: snapshot.app.name },
      window: { id: snapshot.window.id, title: snapshot.window.title },
      summary: `${snapshot.app.name} 中可能有一条需要回复的消息`,
      createdAt,
      expiresAt: createdAt + 30 * 60 * 1_000,
    };
    this.#proposals.set(proposal.id, proposal);
    if (this.#settings.notificationsEnabled !== false) {
      this.#input.emitNotification?.(DESKTOP_CONTEXT_IPC_CHANNELS.PROPOSAL_CREATED, proposalToCreatedNotification(proposal));
    }
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

function looksLikeReplyOpportunity(text: string): boolean {
  if (!text.trim()) return false;
  return /[?？]|(?:吗|么|如何|怎么|什么时候|能否|是否|回复|请问)/u.test(text);
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
