import type {
  DesktopActionKind,
  DesktopActionLedgerEntry,
  Window as ComputerUseWindow,
} from "@lume/shared";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentThreadFilesPath } from "../../../infra/config-paths";
import { createLogger } from "../../../infra/logger";

const RECENT_FOCUS_EVENT_MS = 30_000;

export class ComputerUseActionLedger {
  readonly #entries = new Map<string, DesktopActionLedgerEntry>();
  readonly #threadId: string;
  readonly #path?: string;
  readonly #log;

  constructor(input: { workspaceSlug?: string; threadId: string }) {
    this.#threadId = input.threadId;
    this.#log = createLogger("computer-use-action", input.threadId);
    if (input.workspaceSlug) {
      this.#path = join(
        getAgentThreadFilesPath(input.workspaceSlug, input.threadId),
        "computer-use",
        "action-ledger.jsonl",
      );
      this.#restore();
    }
  }

  plan(input: {
    action: DesktopActionKind;
    window: ComputerUseWindow;
    stateId?: string;
    screenshotId?: string;
    point?: { x: number; y: number };
    text?: string;
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
      ...(input.stateId ? { stateId: input.stateId } : {}),
      ...(input.screenshotId ? { screenshotId: input.screenshotId } : {}),
      ...(input.point ? { point: input.point } : {}),
      ...(input.text !== undefined ? { textLength: input.text.length, sensitive: false } : {}),
    };
    this.#entries.set(entry.actionId, entry);
    this.#append(entry);
    this.#log.info("action phase", ledgerLogFields(entry));
    return entry;
  }

  confirm(actionId: string): void { this.#transition(actionId, "confirmed"); }
  dispatch(actionId: string): void { this.#transition(actionId, "dispatched"); }
  observe(actionId: string, stateId?: string): void {
    this.#transition(actionId, "observed", undefined, stateId);
  }
  verify(actionId: string): void { this.#transition(actionId, "verified"); }

  fail(actionId: string, failureReason: string): void {
    this.#transition(actionId, "failed", failureReason);
  }

  hasRecentFocusEvent(window: ComputerUseWindow, now = Date.now()): boolean {
    for (const entry of this.#entries.values()) {
      if (entry.window.id !== window.id || entry.window.app !== window.app) continue;
      if (entry.phase !== "dispatched" && entry.phase !== "observed" && entry.phase !== "verified") continue;
      if (entry.action !== "click" && entry.action !== "activate_window") continue;
      if (now - entry.updatedAt <= RECENT_FOCUS_EVENT_MS) return true;
    }
    return false;
  }

  get(actionId: string): DesktopActionLedgerEntry | undefined {
    const entry = this.#entries.get(actionId);
    return entry ? { ...entry, window: { ...entry.window } } : undefined;
  }

  #transition(
    actionId: string,
    phase: DesktopActionLedgerEntry["phase"],
    failureReason?: string,
    stateId?: string,
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
      ...(stateId ? { stateId } : {}),
    };
    this.#entries.set(actionId, next);
    this.#append(next);
    this.#log.info("action phase", ledgerLogFields(next));
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
        }
      }
    } catch {
      this.#log.warn("ignored unreadable action ledger", { path: this.#path });
    }
  }
}

function ledgerLogFields(entry: DesktopActionLedgerEntry): Record<string, unknown> {
  return {
    actionId: entry.actionId,
    action: entry.action,
    phase: entry.phase,
    windowId: entry.window.id,
    app: entry.window.app,
    ...(entry.stateId ? { stateId: entry.stateId } : {}),
    ...(entry.screenshotId ? { screenshotId: entry.screenshotId } : {}),
    ...(entry.point ? { point: entry.point } : {}),
    ...(entry.textLength !== undefined ? { textLength: entry.textLength, sensitive: entry.sensitive } : {}),
    ...(entry.failureReason ? { failureReason: entry.failureReason } : {}),
  };
}
