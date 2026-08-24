import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getImSeenMessagesPath } from "../infra/config-paths";
import { createLogger } from "../infra/logger";

const log = createLogger("im-seen-messages");

/** 保留条数上限：覆盖重启窗口的重投去重足够，避免文件无界增长。 */
const MAX_ENTRIES = 2000;
/** 条目有效期：IM 平台重投窗口远小于此，超龄清理。 */
const ENTRY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface SeenMessagesFile {
  version: 1;
  entries: Record<string, number>;
}

/**
 * IM 入站消息跨重启去重存储（#157）。
 *
 * 三个 WS 渠道（钉钉/飞书/企微）立即 ack + fire-and-forget 路由，服务端重投/进程重启
 * 会重复路由同一消息触发 agent 重复执行；微信渠道靠 cursor 但"已路由未落 cursor 前
 * 重启"同样重复。按 `provider:accountId:messageId` 做短 TTL 持久化去重统一覆盖四渠道。
 *
 * 契约（#158 防崩边界）：三个 WS worker 的 `void routeMessage` 无 .catch，本 store
 * 不得向 routeInboundImMessage 抛出任何异常——读失败按未见过处理，写失败仅记日志。
 * 内存 Map 首次加载 + remember 时 write-through，避免每条消息同步读盘。
 */
let cache: Map<string, number> | null = null;

function loadEntries(): Map<string, number> {
  if (cache) return cache;
  const path = getImSeenMessagesPath();
  const entries = new Map<string, number>();
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<SeenMessagesFile>;
      if (parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object") {
        for (const [key, seenAt] of Object.entries(parsed.entries)) {
          if (typeof seenAt === "number") entries.set(key, seenAt);
        }
      }
    } catch (error) {
      // 损坏按空表处理（去重是尽力而为的防护层，不能因文件损坏阻断 IM 路由）
      log.warn("failed to read seen messages store, starting empty", { path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  cache = entries;
  return entries;
}

function persist(entries: Map<string, number>): void {
  const path = getImSeenMessagesPath();
  try {
    const now = Date.now();
    for (const [key, seenAt] of entries) {
      if (now - seenAt > ENTRY_TTL_MS) entries.delete(key);
    }
    while (entries.size > MAX_ENTRIES) {
      const oldest = [...entries.entries()].sort((a, b) => a[1] - b[1])[0];
      if (!oldest) break;
      entries.delete(oldest[0]);
    }
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, entries: Object.fromEntries(entries) } satisfies SeenMessagesFile), "utf-8");
    renameSync(temporary, path);
  } catch (error) {
    log.warn("failed to persist seen messages store", { path, error: error instanceof Error ? error.message : String(error) });
  }
}

export function buildImSeenMessageKey(provider: string, accountId: string, messageId: string): string {
  return `${provider}:${accountId}:${messageId}`;
}

export function hasSeenImMessage(provider: string, accountId: string, messageId: string): boolean {
  try {
    return loadEntries().has(buildImSeenMessageKey(provider, accountId, messageId));
  } catch {
    return false;
  }
}

export function rememberImMessage(provider: string, accountId: string, messageId: string): void {
  try {
    const entries = loadEntries();
    entries.set(buildImSeenMessageKey(provider, accountId, messageId), Date.now());
    persist(entries);
  } catch (error) {
    log.warn("failed to remember im message", { provider, accountId, error: error instanceof Error ? error.message : String(error) });
  }
}

/** 批量标记已见：一次落盘（管线批量结算用，避免逐条全量写放大）。 */
export function rememberImMessages(
  items: Array<{ provider: string; accountId: string; messageId: string }>
): void {
  const valid = items.filter((item) => item.messageId);
  if (valid.length === 0) return;
  try {
    const entries = loadEntries();
    const now = Date.now();
    for (const item of valid) {
      entries.set(buildImSeenMessageKey(item.provider, item.accountId, item.messageId), now);
    }
    persist(entries);
  } catch (error) {
    log.warn("failed to remember im messages", { count: valid.length, error: error instanceof Error ? error.message : String(error) });
  }
}

/** 测试辅助：清空内存缓存。 */
export function resetImSeenMessageCacheForTest(): void {
  cache = null;
}
