import type {
  DesktopAssistantSettings,
  DesktopContextSnapshot,
  DesktopContextTarget,
  DesktopProactiveProposal,
  DesktopProactiveProposalStatus,
} from "@lume/shared";
import { DesktopContextStore } from "./desktop-context-store";

type HostInvoke = (method: string, params: Record<string, unknown>) => Promise<unknown>;

interface DesktopContextStoreLike {
  put(snapshot: DesktopContextSnapshot): void;
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
    createStore?: (input: { dbPath: string; key: Buffer; retentionMs: number; maxBytes: number }) => DesktopContextStoreLike;
  };

  constructor(input: {
    dbPath: string;
    settings: DesktopAssistantSettings;
    invokeHost: HostInvoke;
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

  async captureCurrent(): Promise<unknown> {
    if (!this.#settings.enabled) {
      return { status: "unavailable", message: "desktop assistant is disabled" };
    }
    if (!this.#key) {
      return { status: "unavailable", message: "desktop context store is locked" };
    }
    const response = asRecord(await this.#input.invokeHost("current_context", {}));
    if (response.status !== "ok") return response;
    const snapshot = normalizeSnapshot(response.snapshot);
    if (!snapshot) return { status: "failed", message: "desktop host returned an invalid context snapshot" };
    const allowed = new Set(this.#settings.allowedApps.map((app) => app.trim().toLowerCase()).filter(Boolean));
    if (!allowed.has(snapshot.app.id.toLowerCase())) {
      return { status: "blocked", message: `desktop context is not allowed for ${snapshot.app.id}` };
    }
    const fingerprint = snapshotFingerprint(snapshot);
    if (fingerprint === this.#lastFingerprint && this.#lastSnapshotId) {
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

  async currentContext(input: { snapshotId?: string } = {}): Promise<unknown> {
    if (!this.#settings.enabled) return { status: "unavailable", message: "desktop assistant is disabled" };
    if (!this.#key) return { status: "unavailable", message: "desktop context store is locked" };
    const store = this.#ensureStore();
    const snapshot = input.snapshotId
      ? store.getRedacted(input.snapshotId)
      : store.latestRedacted();
    return snapshot
      ? { status: "ok", snapshot }
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
  }
}

function looksLikeReplyOpportunity(text: string): boolean {
  if (!text.trim()) return false;
  return /[?？]|(?:吗|么|如何|怎么|什么时候|能否|是否|回复|请问)/u.test(text);
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

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}
