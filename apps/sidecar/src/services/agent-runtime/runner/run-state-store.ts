import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { ACTIVE_RUN_STATUSES, type LumeRunState } from "./run-state";
import type { LumeRunItem } from "./run-items";

export interface LumeRunStateStore {
  create(state: LumeRunState): Promise<void>;
  get(runId: string): Promise<LumeRunState | null>;
  update(runId: string, patch: Partial<LumeRunState>): Promise<void>;
  appendItem(runId: string, item: LumeRunItem): Promise<void>;
  listByThread(threadId: string): Promise<LumeRunState[]>;
  findActiveByThread(threadId: string): Promise<LumeRunState | null>;
}

function writeTextAtomic(path: string, payload: string): void {
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, payload, "utf-8");
  renameSync(tmpPath, path);
}

function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function readJsonlFile<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as T;
      } catch {
        return null;
      }
    })
    .filter((item): item is T => item !== null);
}

class FileBackedLumeRunStateStore implements LumeRunStateStore {
  private readonly runsDir: string;

  constructor(sessionDir: string) {
    this.runsDir = join(sessionDir, "runs");
    mkdirSync(this.runsDir, { recursive: true });
  }

  async create(state: LumeRunState): Promise<void> {
    mkdirSync(this.runsDir, { recursive: true });
    writeTextAtomic(this.statePath(state.runId), JSON.stringify({
      ...state,
      generatedItems: []
    }, null, 2));
    if (state.generatedItems.length > 0) {
      writeTextAtomic(
        this.itemsPath(state.runId),
        state.generatedItems.map((item) => JSON.stringify(item)).join("\n")
      );
    }
  }

  async get(runId: string): Promise<LumeRunState | null> {
    const state = readJsonFile<LumeRunState>(this.statePath(runId));
    if (!state) return null;
    return {
      ...state,
      generatedItems: readJsonlFile<LumeRunItem>(this.itemsPath(runId))
    };
  }

  async update(runId: string, patch: Partial<LumeRunState>): Promise<void> {
    const state = await this.get(runId);
    if (!state) return;
    const generatedItems = patch.generatedItems ?? state.generatedItems;
    const next: LumeRunState = {
      ...state,
      ...patch,
      generatedItems,
      updatedAt: patch.updatedAt ?? new Date().toISOString()
    };
    writeTextAtomic(this.statePath(runId), JSON.stringify({
      ...next,
      generatedItems: []
    }, null, 2));
    writeTextAtomic(this.itemsPath(runId), generatedItems.map((item) => JSON.stringify(item)).join("\n"));
  }

  async appendItem(runId: string, item: LumeRunItem): Promise<void> {
    const state = await this.get(runId);
    if (!state) return;
    const generatedItems = [...state.generatedItems, item];
    await this.update(runId, { generatedItems });
  }

  async listByThread(threadId: string): Promise<LumeRunState[]> {
    if (!existsSync(this.runsDir)) return [];
    const states: LumeRunState[] = [];
    for (const file of readdirSync(this.runsDir)) {
      if (!file.endsWith(".json") || file.endsWith(".items.json")) continue;
      const runId = file.slice(0, -".json".length);
      const state = await this.get(runId);
      if (state?.threadId === threadId) {
        states.push(state);
      }
    }
    return states.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async findActiveByThread(threadId: string): Promise<LumeRunState | null> {
    const states = await this.listByThread(threadId);
    return states.find((state) => ACTIVE_RUN_STATUSES.has(state.status)) ?? null;
  }

  private statePath(runId: string): string {
    return join(this.runsDir, `${runId}.json`);
  }

  private itemsPath(runId: string): string {
    return join(this.runsDir, `${runId}.items.jsonl`);
  }
}

export function createFileBackedLumeRunStateStore(sessionDir: string): LumeRunStateStore {
  return new FileBackedLumeRunStateStore(sessionDir);
}
