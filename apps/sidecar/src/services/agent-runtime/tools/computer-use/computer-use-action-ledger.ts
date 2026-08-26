import type {
  DesktopActionKind,
  DesktopActionLedgerEntry,
  Window as ComputerUseWindow,
} from "@lume/shared";
import { getRuntimeHostPorts } from "../../host-ports";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentThreadFilesPath } from "../../../infra/config-paths";
import { createLogger } from "../../../infra/logger";

/** 容量上限（#539）：长寿命线程的 jsonl 无轮转，内存 Map 与 restore 重放都须有界 */
const MAX_LEDGER_ENTRIES = 500;

export class ComputerUseActionLedger {
  readonly #entries = new Map<string, DesktopActionLedgerEntry>();
  /** 处于 dispatched/observed 活跃相的 actionId——observeWindow 只需扫这一小撮，而非全表 */
  readonly #activeIds = new Set<string>();
  readonly #expectedText = new Map<string, string>();
  readonly #baselineFingerprint = new Map<string, string>();
  readonly #requiresStateChange = new Set<string>();
  readonly #threadId: string;
  readonly #path?: string;
  readonly #log;

  constructor(input: { workspaceSlug?: string; threadId: string; filesRoot?: string }) {
    this.#threadId = input.threadId;
    this.#log = createLogger("computer-use-action", input.threadId);
    if (input.workspaceSlug) {
      const filesRoot = input.filesRoot ?? resolveFilesRoot(input.workspaceSlug, input.threadId);
      this.#path = join(
        filesRoot,
        "computer-use",
        "action-ledger.jsonl",
      );
      this.#restore();
    }
  }

  plan(input: {
    action: DesktopActionKind;
    window: ComputerUseWindow;
    screenshotId?: string;
    point?: { x: number; y: number };
    text?: string;
    sensitive?: boolean;
    baselineFingerprint?: string;
    requiresStateChange?: boolean;
  }): DesktopActionLedgerEntry {
    const now = Date.now();
    const entry: DesktopActionLedgerEntry = {
      actionId: randomUUID(),
      threadId: this.#threadId,
      action: input.action,
      window: input.window,
      phase: "planned",
      createdAt: now,
      updatedAt: now,
      ...(input.screenshotId ? { screenshotId: input.screenshotId } : {}),
      ...(input.point ? { point: input.point } : {}),
      ...(input.text !== undefined
        ? { textLength: input.text.length, sensitive: input.sensitive === true }
        : {}),
    };
    this.#entries.set(entry.actionId, entry);
    if (input.text !== undefined) this.#expectedText.set(entry.actionId, input.text);
    if (input.baselineFingerprint) {
      this.#baselineFingerprint.set(entry.actionId, input.baselineFingerprint);
    }
    if (input.requiresStateChange) this.#requiresStateChange.add(entry.actionId);
    this.#prune();
    this.#append(entry);
    this.#log.info("action phase", ledgerLogFields(entry));
    return entry;
  }

  confirm(actionId: string): void { this.#transition(actionId, "confirmed"); }
  dispatch(actionId: string): void { this.#transition(actionId, "dispatched"); }
  observe(actionId: string): void { this.#transition(actionId, "observed"); }
  verify(actionId: string): void { this.#transition(actionId, "verified"); }

  fail(actionId: string, failureReason: string): void {
    this.#transition(actionId, "failed", failureReason);
    this.#forgetPrivateVerificationState(actionId);
  }

  get(actionId: string): DesktopActionLedgerEntry | undefined {
    const entry = this.#entries.get(actionId);
    return entry ? { ...entry, window: { ...entry.window } } : undefined;
  }

  observeWindow(
    window: ComputerUseWindow,
    accessibility: unknown,
    fingerprint?: string,
  ): DesktopActionLedgerEntry[] {
    const observed: DesktopActionLedgerEntry[] = [];
    const text = accessibilityText(accessibility);
    // 只遍历活跃相条目：历史终态动作不再参与观察匹配（#539，原为全表扫描）
    for (const actionId of [...this.#activeIds]) {
      const current = this.#entries.get(actionId);
      if (!current) continue;
      if (current.window.id !== window.id || current.window.app !== window.app) continue;
      if (current.phase === "dispatched") this.observe(current.actionId);
      const expected = this.#expectedText.get(current.actionId);
      const baseline = this.#baselineFingerprint.get(current.actionId);
      const stateChanged = this.#requiresStateChange.has(current.actionId)
        && baseline !== undefined
        && fingerprint !== undefined
        && baseline !== fingerprint;
      if (
        current.action === "activate_window"
        || (expected !== undefined && expected.length > 0 && text.includes(expected))
        || stateChanged
      ) {
        this.verify(current.actionId);
      }
      const next = this.get(current.actionId);
      if (next && (current.phase === "dispatched" || next.phase === "verified")) observed.push(next);
      if (next?.phase === "verified") this.#forgetPrivateVerificationState(current.actionId);
    }
    return observed;
  }

  #forgetPrivateVerificationState(actionId: string): void {
    this.#expectedText.delete(actionId);
    this.#baselineFingerprint.delete(actionId);
    this.#requiresStateChange.delete(actionId);
  }

  #transition(
    actionId: string,
    phase: DesktopActionLedgerEntry["phase"],
    failureReason?: string,
  ): void {
    const current = this.#entries.get(actionId);
    if (!current) throw new Error(`unknown computer-use action: ${actionId}`);
    const allowed: Record<DesktopActionLedgerEntry["phase"], DesktopActionLedgerEntry["phase"][]> = {
      planned: ["confirmed", "failed"],
      confirmed: ["dispatched", "failed"],
      dispatched: ["observed", "failed"],
      observed: ["verified", "failed"],
      verified: [],
      failed: [],
    };
    if (!allowed[current.phase].includes(phase)) {
      throw new Error(`invalid computer-use action transition: ${current.phase} -> ${phase}`);
    }
    const next = {
      ...current,
      phase,
      updatedAt: Date.now(),
      ...(failureReason ? { failureReason } : {}),
    };
    this.#entries.set(actionId, next);
    if (phase === "dispatched" || phase === "observed") this.#activeIds.add(actionId);
    else this.#activeIds.delete(actionId);
    this.#append(next);
    this.#log.info("action phase", ledgerLogFields(next));
  }

  /** 终态条目超限时淘汰最旧者：不再参与观察匹配，仅 get 查询历史会落空 */
  #prune(): void {
    if (this.#entries.size <= MAX_LEDGER_ENTRIES) return;
    const removable = [...this.#entries.values()]
      .filter((entry) => entry.phase === "verified" || entry.phase === "failed")
      .sort((left, right) => left.updatedAt - right.updatedAt);
    let excess = this.#entries.size - MAX_LEDGER_ENTRIES;
    for (const entry of removable) {
      if (excess <= 0) break;
      this.#entries.delete(entry.actionId);
      this.#forgetPrivateVerificationState(entry.actionId);
      excess--;
    }
    if (excess < this.#entries.size - MAX_LEDGER_ENTRIES) {
      this.#log.info("action ledger pruned", { pruned: this.#entries.size - MAX_LEDGER_ENTRIES - excess, remaining: this.#entries.size });
    }
  }

  #append(entry: DesktopActionLedgerEntry): void {
    if (!this.#path) return;
    mkdirSync(dirname(this.#path), { recursive: true });
    appendFileSync(this.#path, `${JSON.stringify(entry)}\n`, "utf8");
  }

  #restore(): void {
    if (!this.#path || !existsSync(this.#path)) return;
    try {
      for (const line of readFileSync(this.#path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line) as DesktopActionLedgerEntry;
        if (entry.threadId === this.#threadId && typeof entry.actionId === "string") {
          this.#entries.set(entry.actionId, entry);
          // 同一 actionId 的终态行必须出集：重放是乱序追加流，后写终态覆盖前态；
          // 漏删会让 observeWindow 对历史条目重复 verify 触发非法转换 throw（#711 review）
          if (entry.phase === "dispatched" || entry.phase === "observed") this.#activeIds.add(entry.actionId);
          else this.#activeIds.delete(entry.actionId);
        }
      }
      this.#prune();    } catch {
      this.#log.warn("ignored unreadable action ledger", { path: this.#path });
    }
  }
}

function resolveFilesRoot(workspaceSlug: string, threadId: string): string {
  try {
    return getRuntimeHostPorts().resolveThreadWorkdir(threadId).filesRoot;
  } catch {
    return getAgentThreadFilesPath(workspaceSlug, threadId);
  }
}

function accessibilityText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(accessibilityText).join("\n");
  if (!value || typeof value !== "object") return "";
  return Object.values(value as Record<string, unknown>).map(accessibilityText).join("\n");
}

function ledgerLogFields(entry: DesktopActionLedgerEntry): Record<string, unknown> {
  return {
    actionId: entry.actionId,
    action: entry.action,
    phase: entry.phase,
    windowId: entry.window.id,
    app: entry.window.app,
    ...(entry.screenshotId ? { screenshotId: entry.screenshotId } : {}),
    ...(entry.point ? { point: entry.point } : {}),
    ...(entry.textLength !== undefined ? { textLength: entry.textLength, sensitive: entry.sensitive } : {}),
    ...(entry.failureReason ? { failureReason: entry.failureReason } : {}),
  };
}
