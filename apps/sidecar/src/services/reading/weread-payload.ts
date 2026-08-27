import type { ReadingBookStatus } from "@lume/shared";

/**
 * WeRead 网关 payload 提取原语(#531 收敛)：reading-store / weread-client /
 * weread-reading-profile 三处同型拷贝收敛于此。
 *
 * 语义取强版本：支持 readInfo/progressInfo 嵌套对象探测与
 * finishedDate/readAt/readTime 等完整键位；秒级时间戳(<1e11)统一归一为毫秒，
 * 并施加采信窗口守卫(#531 复审加固——键链含 readTime/readingTime 这类
 * 时长语义候选，纯靠 ?? 链可能把累计阅读秒数误判成时间戳)。
 * profile 版原先缺这些键位与嵌套探测，导致同一 API 数据源下提取不到
 * 最后阅读时间/进度(#531 P0-1 修复)。
 */

/** 时间戳提取的 ?? 链键序（与原三处拷贝逐字对齐；0 值会终止链并被 >0 拒绝）。 */
function pickTimestamp(record: Record<string, unknown>): number | undefined {
  return readNumber(record.lastReadAt)
    ?? readNumber(record.readUpdateTime)
    ?? readNumber(record.lectureReadUpdateTime)
    ?? readNumber(record.lastReadTime)
    ?? readNumber(record.readAt)
    ?? readNumber(record.readTime)
    ?? readNumber(record.readingTime)
    ?? readNumber(record.updateTime)
    ?? readNumber(record.updatedAt)
    ?? readNumber(record.finishedDate);
}

const NESTED_PROGRESS_KEYS = ["readInfo", "progressInfo"] as const;

/** 微信读书上线前不可能有真实阅读事件；早于此的值来自时长型键误判（如 readTime=3600 秒）。 */
const MIN_PLAUSIBLE_READ_MS = Date.UTC(2005, 0, 1);
const MAX_PLAUSIBLE_READ_MS = 86_400_000;

/** 采信窗口 [2005-01-01, now+1d]：兜住时钟/网关污染与时长型键。 */
function isPlausibleReadTimestamp(ms: number): boolean {
  return ms >= MIN_PLAUSIBLE_READ_MS && ms <= Date.now() + MAX_PLAUSIBLE_READ_MS;
}

export function readWereadTimestamp(
  ...records: Array<Record<string, unknown> | undefined>
): number | undefined {
  for (const record of records) {
    if (!record) continue;
    const nestedValue = readNestedTimestamp(record);
    if (typeof nestedValue === "number") return nestedValue;
    const value = pickTimestamp(record);
    if (typeof value === "number" && value > 0) {
      const ms = normalizeWereadTimestamp(value);
      if (isPlausibleReadTimestamp(ms)) return ms;
    }
  }
  return undefined;
}

export function readProgressPercent(
  ...records: Array<Record<string, unknown> | undefined>
): number | undefined {
  for (const record of records) {
    if (!record) continue;
    const nestedValue = readNestedProgressPercent(record);
    if (typeof nestedValue === "number") return nestedValue;
    const value = readNumber(record.readingProgress)
      ?? readNumber(record.progressPercent)
      ?? readNumber(record.progress)
      ?? readNumber(record.readProgress);
    if (typeof value === "number") return value > 0 && value < 1 ? value * 100 : value;
  }
  return undefined;
}

/**
 * @param readExplicitStatus 可选的显式状态读取器（store 版纵深防御：
 *   先识别 queued/paused 等显式状态并在兜底时回填）；client/profile 不传。
 */
export function readWereadBookStatus(
  item: Record<string, unknown>,
  bookInfo: Record<string, unknown>,
  readExplicitStatus?: (value: unknown) => ReadingBookStatus | undefined,
): ReadingBookStatus {
  const explicitStatus = readExplicitStatus
    ? (readExplicitStatus(item.status) ?? readExplicitStatus(bookInfo.status))
    : undefined;
  if (explicitStatus === "finished") return "finished";
  if (hasFinishStatus(item) || hasFinishStatus(bookInfo)) return "finished";
  if (hasFinishedDate(item) || hasFinishedDate(bookInfo)) return "finished";
  const finishSignals = [
    item.finishReading,
    item.finished,
    item.isFinished,
    item.readFinished,
    bookInfo.finishReading,
    bookInfo.finished,
    bookInfo.isFinished,
    bookInfo.readFinished
  ];
  if (finishSignals.some(isTruthyStatus)) return "finished";

  const textStatus = [
    item.status,
    item.readingStatus,
    item.bookStatus,
    bookInfo.status,
    bookInfo.readingStatus,
    bookInfo.bookStatus
  ].map(readString).find(Boolean);
  if (textStatus) {
    const normalized = textStatus.toLowerCase();
    if (normalized.includes("finish") || normalized.includes("done") || normalized.includes("complete") || normalized.includes("已读")) {
      return "finished";
    }
  }

  if (readNumber(item.markedStatus) === 1 || readNumber(bookInfo.markedStatus) === 1) return "finished";
  return explicitStatus ?? "reading";
}

function readNestedTimestamp(record: Record<string, unknown>): number | undefined {
  for (const key of NESTED_PROGRESS_KEYS) {
    const nested = record[key];
    if (!isRecord(nested)) continue;
    const value = pickTimestamp(nested);
    if (typeof value === "number" && value > 0) {
      const ms = normalizeWereadTimestamp(value);
      if (isPlausibleReadTimestamp(ms)) return ms;
    }
  }
  return undefined;
}

function readNestedProgressPercent(record: Record<string, unknown>): number | undefined {
  for (const key of NESTED_PROGRESS_KEYS) {
    const nested = record[key];
    if (!isRecord(nested)) continue;
    const value = readNumber(nested.readingProgress)
      ?? readNumber(nested.progressPercent)
      ?? readNumber(nested.progress)
      ?? readNumber(nested.readProgress);
    if (typeof value === "number") return value > 0 && value < 1 ? value * 100 : value;
  }
  return undefined;
}

function hasFinishedDate(record: Record<string, unknown>): boolean {
  const direct = readNumber(record.finishedDate);
  if (typeof direct === "number" && direct > 0) return true;
  for (const key of NESTED_PROGRESS_KEYS) {
    const nested = record[key];
    if (!isRecord(nested)) continue;
    const value = readNumber(nested.finishedDate);
    if (typeof value === "number" && value > 0) return true;
  }
  return false;
}

function hasFinishStatus(record: Record<string, unknown>): boolean {
  const finishStatus = readNumber(record.finishStatus);
  if (finishStatus === 1) return true;
  for (const key of ["bookInfo", "book", ...NESTED_PROGRESS_KEYS]) {
    const nested = record[key];
    if (!isRecord(nested)) continue;
    if (readNumber(nested.finishStatus) === 1) return true;
  }
  return false;
}

function isTruthyStatus(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true" || value === "finished" || value === "done";
}

function normalizeWereadTimestamp(value: number): number {
  return value < 100_000_000_000 ? value * 1000 : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
