import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { ACTIVE_RUN_STATUSES, type LumeRunState } from "./run-state";
import type { LumeRunItem } from "../runner/run-items";
import { runHasAssistantMessage } from "../runner/run-item-events";

/** 线程级 todo 最新快照（recordTodoState 写入，readLatestTodoState 优先读取）。 */
export interface LumeTodoSnapshot {
  todos: Array<{ content: string; activeForm: string; status: "pending" | "in_progress" | "completed" }>;
  currentActiveForm: string | null;
  runId: string;
  createdAt: string;
}

export interface LumeRunStateStore {
  create(state: LumeRunState): Promise<void>;
  get(runId: string): Promise<LumeRunState | null>;
  /** 只读 state.json（不解析 items.jsonl）——读取 state 字段（如 usage）的轻量路径。 */
  getState(runId: string): Promise<LumeRunState | null>;
  update(runId: string, patch: Partial<LumeRunState>): Promise<void>;
  appendItem(runId: string, item: LumeRunItem): Promise<void>;
  /** tool_result 落盘后回写对应 tool_call 行的终态（completed/failed）；找不到时静默。 */
  settleToolCall(runId: string, toolCallId: string, status: "completed" | "failed", endedAt: string): Promise<void>;
  listByThread(threadId: string): Promise<LumeRunState[]>;
  /** 只读各 run 的 state.json（generatedItems 恒空）——列表/判定类调用的轻量路径。 */
  listStatesByThread(threadId: string): Promise<LumeRunState[]>;
  /** items.jsonl 行计数（不 JSON.parse）——展示层条数。 */
  countItems(runId: string): Promise<number>;
  /** 终态收敛：run 已有 assistant_message 时滤掉 model_stream delta 行（对 hydrate 投影透明）。 */
  compactModelStreamItems(runId: string): Promise<void>;
  findActiveByThread(threadId: string): Promise<LumeRunState | null>;
  saveTodoSnapshot(threadId: string, snapshot: LumeTodoSnapshot): void;
  readTodoSnapshot(threadId: string): LumeTodoSnapshot | null;
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

/**
 * tool_call 终态侧车行：settleToolCall 只 append 此记录（O(1)），
 * 读取投影时物化回对应 tool_call 行，finalize compact 时随重写一次性收敛掉。
 */
interface ToolSettleRecord {
  type: "tool_settled";
  toolCallId: string;
  status: "completed" | "failed";
  endedAt: string;
}

/** 物化侧车终态到 tool_call 行并剔除侧车行；无侧车行时原数组原样返回（零分配快路）。 */
function projectSettledItems(items: LumeRunItem[]): LumeRunItem[] {
  let settles: Map<string, ToolSettleRecord> | null = null;
  const retained: LumeRunItem[] = [];
  for (const item of items) {
    const record = item as unknown as Partial<ToolSettleRecord>;
    if (record.type === "tool_settled" && typeof record.toolCallId === "string") {
      // 同 id 多条取最新（后到终态胜出）
      (settles ??= new Map()).set(record.toolCallId, record as ToolSettleRecord);
    } else {
      retained.push(item);
    }
  }
  if (!settles) return items;
  return retained.map((item) => {
    if (item.type !== "tool_call") return item;
    const settle = settles.get(item.id);
    return settle ? { ...item, status: settle.status, endedAt: settle.endedAt } : item;
  });
}

class FileBackedLumeRunStateStore implements LumeRunStateStore {
  private readonly sessionDir: string;
  private readonly runsDir: string;

  constructor(sessionDir: string) {
    this.sessionDir = sessionDir;
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
        state.generatedItems.map((item) => JSON.stringify(item)).join("\n") + "\n"
      );
    }
  }

  async get(runId: string): Promise<LumeRunState | null> {
    const state = readJsonFile<LumeRunState>(this.statePath(runId));
    if (!state) return null;
    return {
      ...state,
      generatedItems: projectSettledItems(readJsonlFile<LumeRunItem>(this.itemsPath(runId)))
    };
  }

  async getState(runId: string): Promise<LumeRunState | null> {
    return readJsonFile<LumeRunState>(this.statePath(runId));
  }

  async update(runId: string, patch: Partial<LumeRunState>): Promise<void> {
    const state = readJsonFile<LumeRunState>(this.statePath(runId));
    if (!state) return;
    const next: LumeRunState = {
      ...state,
      ...patch,
      updatedAt: patch.updatedAt ?? new Date().toISOString()
    };
    writeTextAtomic(this.statePath(runId), JSON.stringify({
      ...next,
      generatedItems: []
    }, null, 2));
    if (patch.generatedItems !== undefined) {
      const items = patch.generatedItems;
      writeTextAtomic(
        this.itemsPath(runId),
        items.length > 0 ? items.map((item) => JSON.stringify(item)).join("\n") + "\n" : ""
      );
    }
  }

  async appendItem(runId: string, item: LumeRunItem): Promise<void> {
    if (!existsSync(this.statePath(runId))) return;
    appendFileSync(this.itemsPath(runId), JSON.stringify(item) + "\n", "utf-8");
  }

  async settleToolCall(runId: string, toolCallId: string, status: "completed" | "failed", endedAt: string): Promise<void> {
    // append-only 侧车行（O(1)）：不再全量读改写 items.jsonl——每条 tool_result 触发的
    // 整文件重写在长 run 下是 O(N²) IO。物化时机：读取投影（get）与 finalize compact。
    // 目标行不存在时记录成孤儿侧车行，投影时自然丢弃——与原"找不到静默"语义一致。
    if (!existsSync(this.itemsPath(runId))) return;
    const record: ToolSettleRecord = { type: "tool_settled", toolCallId, status, endedAt };
    appendFileSync(this.itemsPath(runId), JSON.stringify(record) + "\n", "utf-8");
  }

  async listByThread(threadId: string): Promise<LumeRunState[]> {
    const runIds = this.listRunFileIds();
    const states: LumeRunState[] = [];
    for (const runId of runIds) {
      const state = await this.get(runId);
      if (state?.threadId === threadId) {
        states.push(state);
      }
    }
    return states.sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.runId.localeCompare(b.runId)
    );
  }

  async listStatesByThread(threadId: string): Promise<LumeRunState[]> {
    const runIds = this.listRunFileIds();
    const states: LumeRunState[] = [];
    for (const runId of runIds) {
      const state = readJsonFile<LumeRunState>(this.statePath(runId));
      if (state?.threadId === threadId) {
        states.push(state);
      }
    }
    return states.sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.runId.localeCompare(b.runId)
    );
  }

  async countItems(runId: string): Promise<number> {
    const path = this.itemsPath(runId);
    if (!existsSync(path)) return 0;
    // 侧车行不是用户可见 item，排除之（JSON.stringify 无空格序列化，子串匹配可靠）
    return readFileSync(path, "utf-8")
      .split("\n")
      .filter((line) => line.trim().length > 0 && !line.includes('"type":"tool_settled"'))
      .length;
  }

  async compactModelStreamItems(runId: string): Promise<void> {
    const path = this.itemsPath(runId);
    if (!existsSync(path)) return;
    const items = readJsonlFile<LumeRunItem>(path);
    // 与 hydrate 投影同一判定：无 assistant_message 的 run 依赖 model_stream 重建文本，不裁
    if (items.length === 0 || !runHasAssistantMessage(items)) return;
    // finalize 收敛一并物化侧车终态：重写后文件回归纯净形态（tool_call 行自带终态，无侧车行）
    const filtered = items.filter((item) => item.type !== "model_stream");
    const retained = projectSettledItems(filtered);
    // 无 delta 可裁且无侧车行待物化（投影快路原引用返回）才免重写
    if (filtered.length === items.length && retained === filtered) return;
    writeTextAtomic(path, retained.map((item) => JSON.stringify(item)).join("\n") + "\n");
  }

  async findActiveByThread(threadId: string): Promise<LumeRunState | null> {
    const states = await this.listStatesByThread(threadId);
    return states.find((state) => ACTIVE_RUN_STATUSES.has(state.status)) ?? null;
  }

  saveTodoSnapshot(threadId: string, snapshot: LumeTodoSnapshot): void {
    writeTextAtomic(this.todoSnapshotPath(threadId), JSON.stringify(snapshot, null, 2));
  }

  readTodoSnapshot(threadId: string): LumeTodoSnapshot | null {
    return readJsonFile<LumeTodoSnapshot>(this.todoSnapshotPath(threadId));
  }

  /** runs/ 目录下的 run state 文件 id 列表（排除 items/continuation 及非 run 文件）。 */
  private listRunFileIds(): string[] {
    if (!existsSync(this.runsDir)) return [];
    return readdirSync(this.runsDir)
      .filter((file) => file.endsWith(".json") && !file.endsWith(".items.json") && !file.endsWith(".continuation.json"))
      .map((file) => file.slice(0, -".json".length));
  }

  private statePath(runId: string): string {
    return join(this.runsDir, `${runId}.json`);
  }

  private itemsPath(runId: string): string {
    return join(this.runsDir, `${runId}.items.jsonl`);
  }

  /** runs/ 目录外的线程级快照，避免污染 runs/ 扫描。 */
  private todoSnapshotPath(threadId: string): string {
    return join(this.sessionDir, `todo-latest-${threadId}.json`);
  }
}

export function createFileBackedLumeRunStateStore(sessionDir: string): LumeRunStateStore {
  return new FileBackedLumeRunStateStore(sessionDir);
}
