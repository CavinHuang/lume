// #580:审批类挂起请求的公共生命周期,收编 tool-permission / ask-user 两处
// 逐字同构的 Map+timeout+resolve 手写三联(desktop-action 为 expiresAt 型且
// 总量小,未纳入)。统一保证:settle 前 clearTimeout→摘 abort 监听→删表的顺序、
// 同 key 重入时旧等待者以 superseded 值先行结束(不做持久化清理)、
// 持久化联动失败仅记日志不得阻断 resolve。

import { createLogger } from "../../infra/logger";

const log = createLogger("pending-request");

export type PendingSettleReason = "answered" | "timeout" | "aborted" | "superseded";

interface PendingEntry<T, M> {
  settle: (value: T, reason: PendingSettleReason) => void;
  meta: M;
  timer?: ReturnType<typeof setTimeout>;
}

export interface PendingWaitInput<T, M> {
  /** 登记项携带的业务元数据(threadId 等),供按会话批量取消时过滤。 */
  meta: M;
  timeoutMs: number;
  signal: AbortSignal;
  timeoutValue: () => T;
  abortValue: () => T;
  supersededValue: () => T;
  /** 每次 settle 前调用(重入挤掉除外——旧等待者直接结束、不做持久化清理);
   * 抛错仅记日志,resolve 仍会执行。 */
  beforeResolve?: (value: T, reason: PendingSettleReason) => Promise<void> | void;
  /** 超时触发时先行回调(发超时事件等),先于 settle。 */
  onTimeout?: () => void;
  /** Bun test 环境下超短 unref timer 可能不触发,测试专用短超时不做 unref。 */
  unref?: boolean;
}

export class PendingRequestRegistry<K, T, M extends object> {
  private readonly pending = new Map<K, PendingEntry<T, M>>();

  wait(key: K, input: PendingWaitInput<T, M>): Promise<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const onAbort = (): void => settle(input.abortValue(), "aborted");
    const settle = (value: T, reason: PendingSettleReason): void => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      input.signal.removeEventListener("abort", onAbort);
      this.pending.delete(key);
      void (async () => {
        if (reason !== "superseded") {
          try {
            await input.beforeResolve?.(value, reason);
          } catch (error) {
            // 持久化失败只降级冷启动恢复能力;resolve 必须仍被执行,
            // 否则 timer 已清除、abort 监听已摘除,等待方将无限悬挂。
            log.warn("Failed pending-request settle cleanup", {
              reason,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
        resolve(value);
      })();
    };

    const entry: PendingEntry<T, M> = { settle, meta: input.meta };
    const existing = this.pending.get(key);
    if (existing) existing.settle(input.supersededValue(), "superseded");
    timer = setTimeout(() => {
      input.onTimeout?.();
      settle(input.timeoutValue(), "timeout");
    }, Math.max(0, input.timeoutMs));
    if (
      input.unref !== false &&
      typeof timer === "object" &&
      "unref" in timer &&
      typeof timer.unref === "function"
    ) {
      timer.unref();
    }
    this.pending.set(key, entry);
    input.signal.addEventListener("abort", onAbort, { once: true });
    return promise;
  }

  /** submit/审批路径:定点 settle。返回是否存在该挂起项。 */
  settle(key: K, value: T): boolean {
    const entry = this.pending.get(key);
    if (!entry) return false;
    entry.settle(value, "answered");
    return true;
  }

  getMeta(key: K): M | undefined {
    return this.pending.get(key)?.meta;
  }

  updateMeta(key: K, patch: Partial<M>): void {
    const entry = this.pending.get(key);
    if (entry) Object.assign(entry.meta, patch);
  }

  list(): Array<{ key: K; meta: M }> {
    return Array.from(this.pending, ([key, entry]) => ({ key, meta: entry.meta }));
  }

  /** 按 thread 会话批量取消(线程删除/断开):命中项以 cancel 值结束并执行持久化清理。 */
  cancelWhere(
    matches: (meta: M, key: K) => boolean,
    buildCancelValue: (meta: M, key: K) => T
  ): void {
    for (const [key, entry] of this.pending) {
      if (!matches(entry.meta, key)) continue;
      entry.settle(buildCancelValue(entry.meta, key), "aborted");
    }
  }
}
