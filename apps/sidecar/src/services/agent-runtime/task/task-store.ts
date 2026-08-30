import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Task,
  TaskMetadata,
  TaskMutationResult,
  TaskStatus,
  TaskStoreAdapter,
  TaskStoreContext,
} from "@lume/agent-sdk";

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
// 持有进程仍存活但心跳超此时限：锁只覆盖单次同步 mutation（毫秒级），
// 心跳落后到这个量级只能是 PID 复用或持有者已挂死，强制自愈（#647 P1-8）。
// 后果边界：被抢者复活续写时，fn 前挂起由 revision CAS 拦截；fn 中段挂起为
// last-wins 丢更新——需 >5min 外部停摆才可达，毫秒级临界区下视为不可达。
const LOCK_ABANDONED_MS = 300_000;
// journal 全量压实的阈值：超过即视为历史行纯噪声，重置为空（#647 P1-7）
const JOURNAL_COMPACT_BYTES = 256 * 1024;
const CLAIM_FENCE_TIMEOUT_MS = 30_000;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_TASK_CLAIMS_PER_RUN = 3;

interface LockPayload {
  pid: number;
  token: string;
  heartbeatAt: number;
}

interface StoredTask extends Task {
  revision: number;
  createdAt: string;
  updatedAt: string;
}

interface JournalEntry {
  phase: "prepare" | "commit";
  transactionId: string;
  files?: Array<{ path: string; contents: string | null; truncateTo?: number }>;
}

export interface TaskStoreNotification {
  taskListId: string;
  sequence: number;
  origin: "agent" | "system" | "recovery";
  tasks: Task[];
  task?: Task;
  message?: string;
}

export interface TaskStoreEvent extends TaskStoreNotification {
  createdAt: string;
}

export interface TaskStoreOptions {
  taskListId: string;
  onNotification?: (notification: TaskStoreNotification) => void;
  onCancellationRequested?: (input: { taskId: string; claimToken?: string; executorRef?: string }) => void;
  validateCompletion?: (task: Task, context: TaskStoreContext) => Promise<string | undefined> | string | undefined;
}

function assertSafeSegment(value: string, label: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") {
    throw new Error(`${label} must be a safe path segment`);
  }
}

const waitSignal = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(waitSignal, 0, 0, ms);
}

function readLock(path: string): LockPayload | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<LockPayload>;
    if (typeof value.pid === "number" && typeof value.token === "string" && typeof value.heartbeatAt === "number") {
      return { pid: value.pid, token: value.token, heartbeatAt: value.heartbeatAt };
    }
  } catch {
    // Malformed locks are handled by the mtime-age staleness channel in acquireLock.
  }
  return null;
}

function lockFileAgeMs(path: string): number {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch (error) {
    // 仅 ENOENT（文件已消失）按无限老处理，rm(force) 对不存在文件是无操作；
    // 其他错误按未知处理返回 0 走保守等待
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return Number.POSITIVE_INFINITY;
    return 0;
  }
}

// agent-runtime 分层内不得引用 services/*（#289），此处保持本地实现，
// 语义对齐 infra/index-mutation-lock 的 isProcessAlive
function processAlive(pid: number): boolean | undefined {
  if (!Number.isFinite(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 表示目标进程存在但无权发信号——仍视为存活
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM" ? true : false;
  }
}

function acquireLock(path: string): LockPayload {
  mkdirSync(dirname(path), { recursive: true });
  const startedAt = Date.now();
  const payload: LockPayload = { pid: process.pid, token: randomUUID(), heartbeatAt: Date.now() };
  while (true) {
    try {
      const fd = openSync(path, "wx");
      try {
        writeFileSync(fd, JSON.stringify(payload), "utf8");
      } finally {
        closeSync(fd);
      }
      return payload;
    } catch {
      // 超时检查前置：任何路径（含下方陈旧分支的 rm 持续失败热旋）都保证 5s 内干净抛出
      if (Date.now() - startedAt > LOCK_TIMEOUT_MS) throw new Error(`Task lock timeout: ${path}`);
      const current = readLock(path);
      // 陈旧判定三通道（#647 P1-8）：持有进程已死+心跳超时（原规则）、
      // 持有进程存活但心跳落后到废弃时限（PID 复用/挂死自愈）、
      // 锁文件损坏不可解析且 mtime 已老化（半截写入自愈）。
      const heartbeatAge = current ? Date.now() - current.heartbeatAt : Number.POSITIVE_INFINITY;
      const stale = current
        ? (processAlive(current.pid) === false && heartbeatAge > LOCK_STALE_MS)
          || heartbeatAge > LOCK_ABANDONED_MS
        : lockFileAgeMs(path) > LOCK_STALE_MS;
      if (!stale) {
        sleepSync(25);
        continue;
      }
      // rm 前身份复核：观测到的锁已被他人接管/替换则放弃破坏，避免误删新鲜锁
      if (current) {
        const latest = readLock(path);
        if (!latest || latest.token !== current.token) {
          sleepSync(25);
          continue;
        }
      } else {
        // 损坏通道：若文件此刻已变得可解析（他人重建），同样放弃本轮
        if (readLock(path)) {
          sleepSync(25);
          continue;
        }
      }
      try { rmSync(path, { force: true }); } catch { /* another writer won the race */ }
      sleepSync(25);
    }
  }
}

function withLock<T>(path: string, fn: () => T): T {
  const payload = acquireLock(path);
  try {
    // Synchronous mutations are short; refresh before and after the critical section.
    const current = readLock(path);
    if (!current || current.token !== payload.token) throw new Error("Task lock fencing token changed");
    writeFileSync(path, JSON.stringify({ ...payload, heartbeatAt: Date.now() }), "utf8");
    const result = fn();
    const after = readLock(path);
    if (!after || after.token !== payload.token) throw new Error("Task lock fencing token changed");
    return result;
  } finally {
    const current = readLock(path);
    if (current?.token === payload.token) rmSync(path, { force: true });
  }
}

function writeAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, contents, "utf8");
  renameSync(temp, path);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function metadataObject(value: unknown): TaskMetadata {
  return value && typeof value === "object" && !Array.isArray(value) ? clone(value as TaskMetadata) : {};
}

function metadataBytes(value: TaskMetadata): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function serviceMetadata(task: StoredTask): Record<string, unknown> {
  return metadataObject(task.metadata?._lume);
}

function publicTask(task: StoredTask): Task {
  const metadata = metadataObject(task.metadata);
  const lume = metadataObject(metadata._lume);
  lume.revision = task.revision;
  if (lume.claim && typeof lume.claim === "object") {
    const claim = lume.claim as Record<string, unknown>;
    if (typeof claim.token === "string") lume.claimToken = claim.token;
  }
  metadata._lume = lume;
  return {
    id: task.id,
    subject: task.subject,
    ...(task.description !== undefined ? { description: task.description } : {}),
    ...(task.activeForm !== undefined ? { activeForm: task.activeForm } : {}),
    ...(task.owner !== undefined ? { owner: task.owner } : {}),
    status: task.status,
    blocks: [...task.blocks],
    blockedBy: [...task.blockedBy],
    metadata,
  };
}

function taskFileName(taskId: string): string {
  assertSafeSegment(taskId, "taskId");
  return `${taskId}.json`;
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()))];
}

export class FileBackedTaskStore implements TaskStoreAdapter {
  private readonly sessionRoot: string;
  private readonly taskRoot: string;
  private readonly listRoot: string;
  private readonly taskListId: string;
  private readonly listLockPath: string;
  private readonly highwatermarkPath: string;
  private readonly eventSequencePath: string;
  private readonly eventsPath: string;
  private readonly journalPath: string;
  private readonly onNotification?: TaskStoreOptions["onNotification"];
  private readonly onCancellationRequested?: TaskStoreOptions["onCancellationRequested"];
  private readonly validateCompletion?: TaskStoreOptions["validateCompletion"];

  constructor(sessionDir: string, options: TaskStoreOptions) {
    this.sessionRoot = resolve(sessionDir);
    this.taskRoot = join(this.sessionRoot, "tasks");
    this.taskListId = options.taskListId;
    assertSafeSegment(this.taskListId, "taskListId");
    this.listRoot = join(this.taskRoot, this.taskListId);
    this.listLockPath = join(this.listRoot, ".lock");
    this.highwatermarkPath = join(this.listRoot, ".highwatermark");
    this.eventSequencePath = join(this.listRoot, ".event-sequence");
    this.eventsPath = join(this.listRoot, ".events.jsonl");
    this.journalPath = join(this.listRoot, ".journal.jsonl");
    this.onNotification = options.onNotification;
    this.onCancellationRequested = options.onCancellationRequested;
    this.validateCompletion = options.validateCompletion;
    mkdirSync(this.listRoot, { recursive: true });
    withLock(this.listLockPath, () => this.recoverJournal());
  }

  async create(input: { subject: string; description?: string; activeForm?: string }, context: TaskStoreContext): Promise<TaskMutationResult> {
    return this.mutate("create", context, (tasks, now) => {
      const nextId = this.nextId();
      const task: StoredTask = {
        id: nextId,
        subject: requireText(input.subject, "subject"),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.activeForm !== undefined ? { activeForm: input.activeForm } : {}),
        status: "pending",
        blocks: [],
        blockedBy: [],
        metadata: {},
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      tasks.set(task.id, task);
      return { changed: [task], task, message: `Task created: ${task.id}` };
    });
  }

  async list(input: { status?: TaskStatus; owner?: string }, context: TaskStoreContext): Promise<Task[]> {
    this.assertContext(context);
    return this.readTasks().map(publicTask).filter((task) =>
      (!input.status || task.status === input.status) && (!input.owner || task.owner === input.owner)
    );
  }

  listEvents(): TaskStoreEvent[] {
    const contents = this.readFile(this.eventsPath);
    if (!contents) return [];
    return contents.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try {
        const value = JSON.parse(line) as TaskStoreEvent;
        return value.taskListId === this.taskListId && typeof value.sequence === "number" ? [value] : [];
      } catch {
        return [];
      }
    });
  }

  async get(taskId: string, context: TaskStoreContext): Promise<TaskMutationResult | null> {
    this.assertContext(context);
    const task = this.readTask(taskId);
    return task ? this.toResult(task) : null;
  }

  async update(input: Record<string, unknown>, context: TaskStoreContext): Promise<TaskMutationResult> {
    const taskId = requireText(input.taskId, "taskId");
    const validationTask = this.readTask(taskId);
    if (!validationTask) throw new Error(`Task not found: ${taskId}`);
    let mutationInput = input;
    if (input.status === "completed" && this.validateCompletion) {
      const validation = await this.validateCompletion(publicTask(validationTask), context);
      if (validation) throw new Error(`Task completion blocked: ${validation}`);
      mutationInput = {
        ...input,
        ...(typeof input.expectedRevision === "number" ? {} : { expectedRevision: validationTask.revision }),
        ...(typeof input.claimToken === "string" ? {} : (this.claimToken(validationTask) ? { claimToken: this.claimToken(validationTask) } : {})),
      };
    }
    return this.mutate("update", context, (tasks, now) => {
      const task = tasks.get(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      const requestedStatus = mutationInput.status as TaskStatus | undefined;
      if (requestedStatus && !["pending", "in_progress", "completed"].includes(requestedStatus)) throw new Error("Invalid Task status");
      // completed 准终态，唯一出口是 reopen 到 pending（#647 P2-6）
      if (task.status === "completed" && requestedStatus !== "pending") throw new Error("Completed Tasks cannot be overwritten");
      const ownerChange = Object.prototype.hasOwnProperty.call(mutationInput, "owner");
      const sensitive = requestedStatus === "in_progress" || requestedStatus === "completed" || requestedStatus === "pending" || ownerChange;
      this.assertFence(task, mutationInput, sensitive, context);

      const changed = new Map<string, StoredTask>();
      const updateTask = (item: StoredTask) => {
        item.updatedAt = now;
        item.revision += 1;
        changed.set(item.id, item);
      };
      // 类型不符的字段显式报错而非静默忽略——拼错字段名的更新必须失败可见（#647 P2-3）
      for (const key of ["subject", "description", "activeForm"] as const) {
        if (Object.prototype.hasOwnProperty.call(mutationInput, key) && typeof mutationInput[key] !== "string") {
          throw new Error(`Task ${key} must be a string`);
        }
      }
      // 依赖变更先行：认领/完成的门控按本次调用后的依赖关系判定，
      // 消除"同一次 update 内先 claim 后加阻塞"产出的矛盾态（#647 P2-4）
      this.applyDependencies(tasks, task, mutationInput, updateTask);
      if (typeof mutationInput.subject === "string") task.subject = requireText(mutationInput.subject, "subject");
      if (typeof mutationInput.description === "string") task.description = mutationInput.description;
      if (typeof mutationInput.activeForm === "string") task.activeForm = mutationInput.activeForm;
      if (requestedStatus === "in_progress") this.claim(task, context, mutationInput);
      if (requestedStatus === "completed") {
        if (this.executorBinding(task)) throw new Error("Task cannot be completed while its executor is active");
        // 与 claim 同门控：被未完成依赖阻塞的 Task 不得直通 completed（#647 P2-1）
        if (task.blockedBy.some((id) => tasks.get(id)?.status !== "completed")) {
          throw new Error("Task is blocked by unfinished dependencies");
        }
        task.status = "completed";
        task.owner = context.actorId;
        this.clearExecutorBinding(task);
      }
      if (requestedStatus === "pending") {
        if (task.status === "completed") {
          // reopen（#647 P2-6）：completed 的唯一出口。完成路径不清 _lume.claim（预存），
          // 这里镜像 releaseClaim 归档清理，避免过期 claimToken 经 publicTask 持续暴露
          const lume = serviceMetadata(task);
          const staleClaim = lume.claim as Record<string, unknown> | undefined;
          lume.claimGeneration = Number(lume.claimGeneration ?? 0) + 1;
          lume.previousClaim = staleClaim ? { ...staleClaim, releasedAt: now, releaseReason: "reopened" } : undefined;
          delete lume.claim;
          task.metadata = { ...metadataObject(task.metadata), _lume: lume };
          delete task.owner;
          task.status = "pending";
        } else {
          this.releaseClaim(task, mutationInput, "reset");
        }
      }
      if (ownerChange) {
        if (mutationInput.owner !== null && mutationInput.owner !== context.actorId) throw new Error("owner must be derived from the current main actor");
        if (mutationInput.owner === null) this.releaseClaim(task, mutationInput, "owner cleared");
        else task.owner = context.actorId;
      }

      this.applyMetadataPatch(task, mutationInput.metadata);
      updateTask(task);
      return { changed: [...changed.values()], task, message: `Task updated: ${task.id}` };
    });
  }

  async stop(input: { taskId: string; expectedRevision?: number; claimToken?: string; reason?: string }, context: TaskStoreContext): Promise<TaskMutationResult> {
    let cancellation: { taskId: string; claimToken?: string; executorRef?: string } | undefined;
    const result = this.mutate("stop", context, (tasks, now) => {
      const task = tasks.get(requireText(input.taskId, "taskId"));
      if (!task) throw new Error(`Task not found: ${input.taskId}`);
      if (task.status !== "in_progress") throw new Error("Only an in_progress Task can be stopped");
      this.assertFence(task, input, true, context);
      const oldToken = this.claimToken(task);
      const executorRef = this.executorBinding(task);
      cancellation = { taskId: task.id, claimToken: oldToken, ...(executorRef ? { executorRef } : {}) };
      this.releaseClaim(task, input, "stopped");
      const lume = serviceMetadata(task);
      lume.cancellation = {
        claimToken: oldToken,
        reason: typeof input.reason === "string" ? input.reason : undefined,
        requestedAt: now,
      };
      if (this.executorBinding(task)) {
        lume.executionFence = {
          executorRef: this.executorBinding(task),
          cancellationDeadline: new Date(Date.now() + CLAIM_FENCE_TIMEOUT_MS).toISOString(),
          recoveryState: "awaiting_terminal_ack",
        };
      }
      task.metadata = { ...metadataObject(task.metadata), _lume: lume };
      task.updatedAt = now;
      task.revision += 1;
      return { changed: [task], task, message: `Task stopped: ${task.id}` };
    });
    if (cancellation) this.onCancellationRequested?.(cancellation);
    return result;
  }

  async bindExecutor(input: { taskId: string; claimToken: string; expectedRevision: number; executorRef: string; attempt?: number }, context: TaskStoreContext): Promise<TaskMutationResult> {
    return this.mutate("bind_executor", context, (tasks, now) => {
      const task = tasks.get(requireText(input.taskId, "taskId"));
      if (!task) throw new Error(`Task not found: ${input.taskId}`);
      if (task.status !== "in_progress") throw new Error("Only an in_progress Task can bind an executor");
      this.assertFence(task, input, true, context);
      if (this.executorBinding(task)) throw new Error("Task claim already has an active executor");
      const lume = serviceMetadata(task);
      lume.executorRef = input.executorRef;
      lume.attempt = input.attempt ?? Number(lume.attempt ?? 1);
      lume.executorBinding = { executorRef: input.executorRef, claimToken: input.claimToken, boundAt: now };
      task.metadata = { ...metadataObject(task.metadata), _lume: lume };
      task.updatedAt = now;
      task.revision += 1;
      return { changed: [task], task, message: `Executor bound: ${input.executorRef}` };
    });
  }

  async acknowledgeExecutor(input: { taskId: string; claimToken: string; executorRef: string; terminal: boolean; forced?: boolean; error?: string; resultSummary?: string; resultStatus?: "completed" | "errored" | "aborted" | "timed_out" }, context: TaskStoreContext): Promise<TaskMutationResult> {
    const trustedContext: TaskStoreContext = {
      threadId: this.taskListId,
      threadType: input.forced ? "recovery" : "system",
      actorId: input.forced ? "recovery:executor-control" : "system:executor-control",
      trusted: true,
    };
    return this.mutate("executor_ack", trustedContext, (tasks, now) => {
      const task = tasks.get(requireText(input.taskId, "taskId"));
      if (!task) throw new Error(`Task not found: ${input.taskId}`);
      const lume = serviceMetadata(task);
      const binding = lume.executorBinding as Record<string, unknown> | undefined;
      if (!binding || binding.executorRef !== input.executorRef || binding.claimToken !== input.claimToken) throw new Error("Executor acknowledgement does not match the active binding");
      if (!input.terminal && !input.forced) throw new Error("Only terminal or forced executor acknowledgement releases the fence");
      delete lume.executorBinding;
      delete lume.executorRef;
      delete lume.executionFence;
      lume.recoveryState = input.forced ? "forced_terminated" : "terminal_ack";
      if (input.error) lume.lastError = { source: "executor", message: input.error.slice(0, 4_000), recordedAt: now };
      if (input.resultStatus || input.error || (typeof input.resultSummary === "string" && input.resultSummary.trim())) {
        lume.lastResult = {
          status: input.resultStatus ?? (input.error ? "errored" : "completed"),
          ...(typeof input.resultSummary === "string" && input.resultSummary.trim()
            ? { summary: input.resultSummary.trim().slice(0, 4_000) }
            : {}),
          recordedAt: now,
        };
      }
      task.metadata = { ...metadataObject(task.metadata), _lume: lume };
      task.updatedAt = now;
      task.revision += 1;
      return { changed: [task], task, message: "Executor fence released" };
    });
  }

  async delete(taskId: string, context: TaskStoreContext): Promise<void> {
    await this.mutate("delete", context, (tasks, now) => {
      const task = tasks.get(requireText(taskId, "taskId"));
      if (!task) throw new Error(`Task not found: ${taskId}`);
      if (task.status !== "pending") throw new Error("Only pending Tasks can be deleted");
      tasks.delete(task.id);
      const changed: StoredTask[] = [];
      for (const other of tasks.values()) {
        const beforeBlocks = other.blocks.length;
        const beforeBlockedBy = other.blockedBy.length;
        other.blocks = other.blocks.filter((id) => id !== task.id);
        other.blockedBy = other.blockedBy.filter((id) => id !== task.id);
        if (other.blocks.length !== beforeBlocks || other.blockedBy.length !== beforeBlockedBy) {
          other.updatedAt = now;
          other.revision += 1;
          changed.push(other);
        }
      }
      return { changed, removed: [task.id], task: changed[0] ?? task, message: `Task deleted: ${task.id}` };
    });
  }

  private mutate(
    label: string,
    context: TaskStoreContext,
    operation: (tasks: Map<string, StoredTask>, now: string) => { changed: StoredTask[]; removed?: string[]; task: StoredTask; message?: string },
  ): TaskMutationResult {
    this.assertContext(context);
    return withLock(this.listLockPath, () => {
      this.recoverJournal();
      const tasks = new Map(this.readTasks().map((task) => [task.id, task]));
      const before = new Map<string, string | null>();
      const now = new Date().toISOString();
      const result = operation(tasks, now);
      for (const task of result.changed) before.set(this.pathFor(task.id), this.readFile(this.pathFor(task.id)));
      for (const taskId of result.removed ?? []) before.set(this.pathFor(taskId), this.readFile(this.pathFor(taskId)));
      const nextSequence = this.readEventSequence() + 1;
      const nextTaskIdHighwatermark = Math.max(
        Number(this.readFile(this.highwatermarkPath) ?? "0") || 0,
        ...[...tasks.keys()].map((id) => Number(id) || 0),
      );
      before.set(this.highwatermarkPath, this.readFile(this.highwatermarkPath));
      before.set(this.eventSequencePath, this.readFile(this.eventSequencePath));
      // #647 P1-7：events.jsonl 只记回滚截断点，不再整文件嵌入 prepare 行
      // （此前每笔事务的 journal 增量 ≈ 事件全史体积，磁盘 O(n²) 膨胀根因）。
      let eventsTruncateTo = 0;
      try {
        eventsTruncateTo = statSync(this.eventsPath).size;
      } catch (error) {
        // 仅 ENOENT 表示"尚无事件文件"可默认 0；其他错误不得静默取 0——
        // 那会让崩溃恢复清空整份事件审计史（评审 must-fix）
        if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
      }
      const transactionId = randomUUID();
      this.appendJournal({
        phase: "prepare",
        transactionId,
        files: [
          ...[...before].map(([path, contents]) => ({ path, contents })),
          { path: this.eventsPath, contents: null, truncateTo: eventsTruncateTo },
        ],
      });
      for (const task of result.changed) writeAtomic(this.pathFor(task.id), JSON.stringify(task, null, 2));
      for (const taskId of result.removed ?? []) rmSync(this.pathFor(taskId), { force: true });
      writeAtomic(this.highwatermarkPath, String(nextTaskIdHighwatermark));
      writeAtomic(this.eventSequencePath, String(nextSequence));
      const event = {
        type: "task.mutated",
        taskListId: this.taskListId,
        sequence: nextSequence,
        origin: eventOrigin(context),
        operation: label,
        task: result.task.id === "" ? undefined : publicTask(result.task),
        tasks: [...tasks.values()].map(publicTask),
        createdAt: now,
        ...(result.message ? { message: result.message } : {}),
      };
      appendFileSync(this.eventsPath, `${JSON.stringify(event)}\n`, "utf8");
      this.appendJournal({ phase: "commit", transactionId });
      const notification: TaskStoreNotification = {
        taskListId: this.taskListId,
        sequence: nextSequence,
        origin: eventOrigin(context),
        tasks: event.tasks,
        task: event.task,
        ...(result.message ? { message: result.message } : {}),
      };
      this.onNotification?.(notification);
      return this.toResult(result.task);
    });
  }

  private applyDependencies(tasks: Map<string, StoredTask>, task: StoredTask, input: Record<string, unknown>, updateTask: (task: StoredTask) => void): void {
    const addBlocks = uniqueStrings(input.addBlocks);
    const addBlockedBy = uniqueStrings(input.addBlockedBy);
    const removeBlocks = uniqueStrings(input.removeBlocks);
    const removeBlockedBy = uniqueStrings(input.removeBlockedBy);
    const targetIds = [...addBlocks, ...addBlockedBy, ...removeBlocks, ...removeBlockedBy];
    for (const targetId of targetIds) {
      if (targetId === task.id || !tasks.has(targetId)) throw new Error(`Unknown dependency Task: ${targetId}`);
    }
    for (const targetId of addBlocks) {
      if (!task.blocks.includes(targetId)) task.blocks.push(targetId);
      const target = tasks.get(targetId)!;
      if (!target.blockedBy.includes(task.id)) target.blockedBy.push(task.id);
      updateTask(target);
    }
    for (const targetId of addBlockedBy) {
      if (!task.blockedBy.includes(targetId)) task.blockedBy.push(targetId);
      const target = tasks.get(targetId)!;
      if (!target.blocks.includes(task.id)) target.blocks.push(task.id);
      updateTask(target);
    }
    for (const targetId of removeBlocks) {
      task.blocks = task.blocks.filter((id) => id !== targetId);
      const target = tasks.get(targetId)!;
      target.blockedBy = target.blockedBy.filter((id) => id !== task.id);
      updateTask(target);
    }
    for (const targetId of removeBlockedBy) {
      task.blockedBy = task.blockedBy.filter((id) => id !== targetId);
      const target = tasks.get(targetId)!;
      target.blocks = target.blocks.filter((id) => id !== task.id);
      updateTask(target);
    }
    if (this.hasCycle(tasks)) throw new Error("Task dependency change would create a cycle");
  }

  private claim(task: StoredTask, context: TaskStoreContext, input: Record<string, unknown>): void {
    if (task.status !== "pending") throw new Error("Only pending Tasks can be claimed");
    if (task.blockedBy.some((id) => this.readTask(id)?.status !== "completed")) throw new Error("Task is blocked by unfinished dependencies");
    const active = this.readTasks().find((item) => item.status === "in_progress");
    if (active && active.id !== task.id) throw new Error(`Task list already has active Task ${active.id}`);
    if (this.readTasks().some((item) => this.executorFence(item))) throw new Error("Task list is fenced until the previous executor terminates");
    const lume = serviceMetadata(task);
    const parentRunId = context.runId?.trim();
    const attemptsInRun = parentRunId
      ? (lume.attemptRunId === parentRunId ? Number(lume.attemptsInRun ?? 0) : 0) + 1
      : 1;
    if (parentRunId && attemptsInRun > MAX_TASK_CLAIMS_PER_RUN) {
      throw new Error(`同一父 Run 中最多认领同一 Task ${MAX_TASK_CLAIMS_PER_RUN} 次；请在新 Run 中改派或调整策略`);
    }
    const token = randomUUID();
    task.status = "in_progress";
    task.owner = context.actorId;
    task.metadata = {
      ...metadataObject(task.metadata),
      _lume: {
        ...lume,
        claim: { actor: context.actorId, parentRun: context.runId, token, claimedAt: new Date().toISOString() },
        claimGeneration: Number(lume.claimGeneration ?? 0) + 1,
        attempts: Number(lume.attempts ?? 0) + 1,
        ...(parentRunId ? { attemptRunId: parentRunId, attemptsInRun } : {}),
      },
    };
    void input;
  }

  private releaseClaim(task: StoredTask, input: Record<string, unknown>, reason: string): void {
    if (task.status !== "in_progress") {
      if (reason === "reset") throw new Error("Only an in_progress Task can be reset with a claim fence");
      return;
    }
    const lume = serviceMetadata(task);
    const claim = lume.claim as Record<string, unknown> | undefined;
    lume.claimGeneration = Number(lume.claimGeneration ?? 0) + 1;
    lume.previousClaim = claim ? { ...claim, releasedAt: new Date().toISOString(), releaseReason: reason } : undefined;
    delete lume.claim;
    task.status = "pending";
    delete task.owner;
    task.metadata = { ...metadataObject(task.metadata), _lume: lume };
  }

  private clearExecutorBinding(task: StoredTask): void {
    const lume = serviceMetadata(task);
    delete lume.executorBinding;
    delete lume.executorRef;
    delete lume.executionFence;
    task.metadata = { ...metadataObject(task.metadata), _lume: lume };
  }

  private assertFence(task: StoredTask, input: Record<string, unknown>, sensitive: boolean, context: TaskStoreContext): void {
    if (!sensitive) return;
    // 同 actor 串行路径宽容（LLM 不必先读 revision 再写）：缺省 expectedRevision
    // 视为按当前 revision 提交；显式传入但不匹配仍报错，跨代理并发 fencing 语义不变。
    if (typeof input.expectedRevision !== "number") input.expectedRevision = task.revision;
    if (input.expectedRevision !== task.revision) throw new Error(`Task revision conflict: expected ${String(input.expectedRevision)}, current ${task.revision}`);
    const token = this.claimToken(task);
    if (task.status === "in_progress") {
      if (!token) throw new Error("Task claim token is missing or expired");
      // 缺省 claimToken 时复用当前 actor 自己的活跃认领；跨 actor 仍必须显式携带
      if (typeof input.claimToken !== "string") {
        const claim = serviceMetadata(task).claim as Record<string, unknown> | undefined;
        if (claim && claim.actor === context.actorId) input.claimToken = token;
      }
      if (input.claimToken !== token) throw new Error("Task claim token is missing or expired");
    }
  }

  private applyMetadataPatch(task: StoredTask, patch: unknown): void {
    if (patch === undefined) return;
    if (patch === null) {
      const current = metadataObject(task.metadata);
      task.metadata = current._lume === undefined ? {} : { _lume: current._lume };
      return;
    }
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("metadata must be a shallow object or null");
    const incoming = patch as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(incoming, "_lume")) throw new Error("metadata._lume is server-managed");
    const current = metadataObject(task.metadata);
    for (const [key, value] of Object.entries(incoming)) {
      if (value === null) delete current[key];
      else current[key] = clone(value);
    }
    if (metadataBytes(current) > MAX_METADATA_BYTES) throw new Error(`metadata exceeds ${MAX_METADATA_BYTES} bytes`);
    task.metadata = current;
  }

  private hasCycle(tasks: Map<string, StoredTask>): boolean {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): boolean => {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      const task = tasks.get(id);
      if (task?.blocks.some(visit)) return true;
      visiting.delete(id);
      visited.add(id);
      return false;
    };
    return [...tasks.keys()].some(visit);
  }

  private executorBinding(task: StoredTask): string | undefined {
    const value = serviceMetadata(task).executorBinding;
    return value && typeof value === "object" && typeof (value as Record<string, unknown>).executorRef === "string"
      ? (value as Record<string, string>).executorRef
      : undefined;
  }

  private executorFence(task: StoredTask): boolean {
    const value = serviceMetadata(task).executionFence;
    return Boolean(value && typeof value === "object");
  }

  private claimToken(task: StoredTask): string | undefined {
    const claim = serviceMetadata(task).claim;
    return claim && typeof claim === "object" && typeof (claim as Record<string, unknown>).token === "string"
      ? (claim as Record<string, string>).token
      : undefined;
  }

  private nextId(): string {
    const highwatermark = Number(this.readFile(this.highwatermarkPath) ?? "0");
    return String((Number.isFinite(highwatermark) ? highwatermark : 0) + 1);
  }

  private assertContext(context: TaskStoreContext): void {
    const trustedSystem = (context.threadType === "system" || context.threadType === "recovery") && context.trusted === true;
    if (context.threadType !== "main" && !trustedSystem) throw new Error("Only the main agent or trusted runtime recovery may access Task state");
    if (context.threadId !== this.taskListId) throw new Error("Task list does not belong to the current main thread");
    if (!context.actorId.trim()) throw new Error("Task actor is required");
  }

  private pathFor(taskId: string): string {
    const path = resolve(this.listRoot, taskFileName(taskId));
    const root = resolve(this.listRoot);
    if (relative(root, path).startsWith("..") || resolve(dirname(path)) !== root) throw new Error("Task path escaped task list root");
    return path;
  }

  private readFile(path: string): string | null {
    try { return readFileSync(path, "utf8"); } catch { return null; }
  }

  private readTask(taskId: string): StoredTask | null {
    const path = this.pathFor(taskId);
    const contents = this.readFile(path);
    if (!contents) return null;
    try {
      const task = JSON.parse(contents) as StoredTask;
      if (task.id !== taskId || typeof task.revision !== "number") return null;
      return task;
    } catch { return null; }
  }

  private readTasks(): StoredTask[] {
    if (!existsSync(this.listRoot)) return [];
    return readdirSync(this.listRoot)
      .filter((name) => /^[-A-Za-z0-9._]+\.json$/.test(name))
      .map((name) => this.readTask(name.slice(0, -5)))
      .filter((task): task is StoredTask => Boolean(task))
      .sort((left, right) => (Number(left.id) || 0) - (Number(right.id) || 0));
  }

  private readEventSequence(): number {
    const value = Number(this.readFile(this.eventSequencePath) ?? "0");
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }

  private appendJournal(entry: JournalEntry): void {
    appendFileSync(this.journalPath, `${JSON.stringify(entry)}\n`, "utf8");
  }

  private recoverJournal(): void {
    const contents = this.readFile(this.journalPath);
    if (!contents) return;
    const pending = new Map<string, JournalEntry>();
    for (const line of contents.split(/\r?\n/).filter(Boolean)) {
      try {
        const entry = JSON.parse(line) as JournalEntry;
        if (entry.phase === "prepare") pending.set(entry.transactionId, entry);
        else pending.delete(entry.transactionId);
      } catch { /* ignore a truncated trailing journal line */ }
    }
    for (const entry of pending.values()) {
      for (const file of entry.files ?? []) {
        if (file.truncateTo !== undefined) {
          try {
            truncateSync(file.path, file.truncateTo);
          } catch (error) {
            // 仅 ENOENT 可忽略；其余失败必须上抛保持 pending 待重试（与兄弟分支
            // 的 writeAtomic/rmSync 错误契约一致），否则事务被标记已解决而幽灵
            // 事件永留日志（评审 should-fix）
            if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
          }
          continue;
        }
        if (file.contents === null) rmSync(file.path, { force: true });
        else writeAtomic(file.path, file.contents);
      }
      this.appendJournal({ phase: "commit", transactionId: entry.transactionId });
    }
    // 走到此处所有历史事务均已解决，旧行即纯噪声：超阈值压实，
    // 防锁内全量解析随 journal 历史线性恶化（#647 P1-7）
    if (Buffer.byteLength(contents) > JOURNAL_COMPACT_BYTES) {
      try { writeAtomic(this.journalPath, ""); } catch { /* 下轮再试 */ }
    }
  }

  private toResult(task: StoredTask): TaskMutationResult {
    const lume = serviceMetadata(task);
    return {
      task: publicTask(task),
      revision: task.revision,
      ...(this.claimToken(task) ? { claimToken: this.claimToken(task) } : {}),
      ...(lume.executorRef ? {} : {}),
    };
  }
}

function eventOrigin(context: TaskStoreContext): "agent" | "system" | "recovery" {
  if (context.threadType === "recovery") return "recovery";
  if (context.threadType === "system") return "system";
  return "agent";
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

export function createFileBackedTaskStore(sessionDir: string, options: TaskStoreOptions): FileBackedTaskStore {
  return new FileBackedTaskStore(sessionDir, options);
}
