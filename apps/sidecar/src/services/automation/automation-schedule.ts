import type { AutomationSchedule } from "@lume/shared";

interface CronFieldSpec {
  min: number;
  max: number;
  allowSundaySeven?: boolean;
}

const CRON_FIELD_SPECS: CronFieldSpec[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 7, allowSundaySeven: true }
];

function parseInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function inRange(value: number, spec: CronFieldSpec): boolean {
  return value >= spec.min && value <= spec.max;
}

function segmentMatchesValue(segment: string, spec: CronFieldSpec, value: number): boolean {
  const [baseRaw, stepRaw] = segment.split("/", 2);
  const base = baseRaw?.trim() ?? "";
  const step = stepRaw === undefined ? 1 : parseInteger(stepRaw);
  if (!step || step <= 0) return false;

  let start: number;
  let end: number;
  if (base === "*") {
    start = spec.min;
    end = spec.max;
  } else if (base.includes("-")) {
    const [startRaw, endRaw] = base.split("-", 2);
    const parsedStart = parseInteger(startRaw ?? "");
    const parsedEnd = parseInteger(endRaw ?? "");
    if (parsedStart === null || parsedEnd === null) return false;
    start = parsedStart;
    end = parsedEnd;
  } else {
    const exact = parseInteger(base);
    if (exact === null) return false;
    start = exact;
    end = exact;
  }

  if (!inRange(start, spec) || !inRange(end, spec) || start > end) {
    return false;
  }

  const candidates = spec.allowSundaySeven && value === 0 ? [0, 7] : [value];
  return candidates.some((candidate) =>
    candidate >= start
    && candidate <= end
    && (candidate - start) % step === 0
  );
}

function cronFieldMatches(field: string, spec: CronFieldSpec, value: number): boolean {
  return field
    .split(",")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .some((segment) => segmentMatchesValue(segment, spec, value));
}

function assertValidCronField(field: string, spec: CronFieldSpec): void {
  const segments = field.split(",").map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) {
    throw new Error("cron 表达式包含空字段");
  }
  for (const segment of segments) {
    if (!segmentMatchesValue(segment, spec, spec.min)) {
      const [baseRaw, stepRaw] = segment.split("/", 2);
      const base = baseRaw?.trim() ?? "";
      const step = stepRaw === undefined ? 1 : parseInteger(stepRaw);
      if (!step || step <= 0) {
        throw new Error(`cron 字段步长无效: ${segment}`);
      }
      if (base === "*") continue;
      if (base.includes("-")) {
        const [startRaw, endRaw] = base.split("-", 2);
        const start = parseInteger(startRaw ?? "");
        const end = parseInteger(endRaw ?? "");
        if (start !== null && end !== null && inRange(start, spec) && inRange(end, spec) && start <= end) {
          continue;
        }
      } else {
        const exact = parseInteger(base);
        if (exact !== null && inRange(exact, spec)) {
          continue;
        }
      }
      throw new Error(`cron 字段无效: ${segment}`);
    }
  }
}

export function validateCronExpression(expr: string): void {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error("cron 表达式必须包含 5 个字段");
  }
  parts.forEach((field, index) => {
    const spec = CRON_FIELD_SPECS[index];
    if (!spec) throw new Error("cron 表达式字段数量无效");
    assertValidCronField(field, spec);
  });
}

/**
 * 日/月组合是否至少存在一个可命中的日期（闰年上界保守放行 2/29）。
 * 字段各自合法但组合永假（如 `0 9 31 2 *` 二月无 31 日）会让逐分钟扫描
 * 空转满一年才返回 null，创建/改期时同步卡顿数秒（#408）。
 *
 * dom/dow 语义与 matchCronExpression 保持一致取 AND：dow 受限不再直接放行，
 * `0 9 31 2 1`（二月三十一日且周一）这类表达式实际永假。AND 语义下 dow 永远
 * 无法让组合永假——任何存在的日期都会在数年内轮遍每个星期几——故可行性
 * 只由 dom×month 决定（#452）。
 */
export function cronDateFeasible(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return true;
  const domField = parts[2]!;
  const monthField = parts[3]!;
  if (domField.trim() === "*" || monthField.trim() === "*") return true;
  const domSpec = CRON_FIELD_SPECS[2]!;
  const monthSpec = CRON_FIELD_SPECS[3]!;
  const days = Array.from({ length: 31 }, (_, i) => i + 1).filter((d) => cronFieldMatches(domField, domSpec, d));
  const months = Array.from({ length: 12 }, (_, i) => i + 1).filter((m) => cronFieldMatches(monthField, monthSpec, m));
  const daysInMonthLeap = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return months.some((m) => days.some((d) => d <= daysInMonthLeap[m - 1]!));
}

export function matchCronExpression(expr: string, date: Date, timezone?: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const values = zonedCronValues(date, timezone);
  return parts.every((field, index) => {
    const spec = CRON_FIELD_SPECS[index];
    return spec ? cronFieldMatches(field, spec, values[index]!) : false;
  });
}

export function getNextCronRunAt(expr: string, fromMs: number, timezone?: string): number | null {
  validateCronExpression(expr);
  // 永假组合直接短路返回 null（scheduleJob 对 null 即不排程），
  // 不再逐分钟空转满年（#408）
  if (!cronDateFeasible(expr)) return null;
  const resolvedTimezone = resolveTimezone(timezone);
  const candidate = new Date(fromMs);
  candidate.setSeconds(0, 0);
  let timestamp = candidate.getTime() + 60_000;
  const maxTimestamp = fromMs + 366 * 24 * 60 * 60_000;
  const previousLocalMinute = zonedMinuteKey(new Date(fromMs), resolvedTimezone);

  while (timestamp <= maxTimestamp) {
    const date = new Date(timestamp);
    const localMinute = zonedMinuteKey(date, resolvedTimezone);
    if (localMinute !== previousLocalMinute && matchCronExpression(expr, date, resolvedTimezone)) {
      return timestamp;
    }
    timestamp += 60_000;
  }

  return null;
}

export function validateAutomationSchedule(schedule: AutomationSchedule): void {
  if (!schedule || typeof schedule !== "object") {
    throw new Error("schedule 无效");
  }
  if (schedule.type === "cron") {
    if (!schedule.cronExpr || !schedule.cronExpr.trim()) {
      throw new Error("cron 类型任务缺少 cronExpr");
    }
    validateCronExpression(schedule.cronExpr);
    // 创建/改期即拒绝永假组合，而非静默永不执行（#408）
    if (!cronDateFeasible(schedule.cronExpr)) {
      throw new Error(`cron 表达式的日/月组合永不可能命中: ${schedule.cronExpr}`);
    }
    resolveTimezone(schedule.timezone);
    validateMisfirePolicy(schedule.misfirePolicy);
    return;
  }
  if (schedule.type === "once") {
    if (typeof schedule.runAt !== "number" || !Number.isFinite(schedule.runAt) || schedule.runAt <= 0) {
      throw new Error("once 类型任务缺少有效 runAt");
    }
    validateMisfirePolicy(schedule.misfirePolicy);
    return;
  }
  if (schedule.type === "interval") {
    if (typeof schedule.intervalMs !== "number" || !Number.isFinite(schedule.intervalMs) || schedule.intervalMs <= 0) {
      throw new Error("interval 类型任务缺少有效 intervalMs");
    }
    validateMisfirePolicy(schedule.misfirePolicy);
    return;
  }
  if (schedule.type === "manual") {
    return;
  }
  throw new Error(`不支持的 schedule.type: ${(schedule as { type?: string }).type ?? "unknown"}`);
}

export function getNextAutomationRunAt(schedule: AutomationSchedule, fromMs = Date.now(), anchorMs = fromMs): number | null {
  // 存量坏 schedule（旧版放行的永假 cron、无效时区等）返回 null 跳过调度而非抛：
  // 本函数在 refresh 轮询路径上，抛错会毒化整轮刷新（#452）。创建/改期入口仍由
  // validateAutomationSchedule 显式拒绝。
  try {
    validateAutomationSchedule(schedule);
  } catch {
    return null;
  }
  if (schedule.type === "manual") return null;
  if (schedule.type === "once") return schedule.runAt ?? null;
  if (schedule.type === "interval") {
    const intervalMs = schedule.intervalMs ?? 0;
    const elapsed = Math.max(0, fromMs - anchorMs);
    return anchorMs + (Math.floor(elapsed / intervalMs) + 1) * intervalMs;
  }
  return getNextCronRunAt(schedule.cronExpr ?? "", fromMs, schedule.timezone);
}

export function getAutomationTimezone(schedule: AutomationSchedule): string {
  return resolveTimezone(schedule.timezone);
}

function resolveTimezone(timezone?: string): string {
  const resolved = timezone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: resolved }).format(0);
  } catch {
    throw new Error(`无效的 IANA 时区: ${resolved}`);
  }
  return resolved;
}

function validateMisfirePolicy(value: AutomationSchedule["misfirePolicy"]): void {
  if (value !== undefined && value !== "run_latest" && value !== "skip") {
    throw new Error(`不支持的 misfirePolicy: ${String(value)}`);
  }
}

function zonedCronValues(date: Date, timezone?: string): number[] {
  const resolvedTimezone = resolveTimezone(timezone);
  const parts = getCronPartsFormatter(resolvedTimezone).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(values.weekday ?? "");
  return [
    Number(values.minute),
    Number(values.hour),
    Number(values.day),
    Number(values.month),
    weekday
  ];
}

function zonedMinuteKey(date: Date, timezone: string): string {
  return getMinuteKeyFormatter(timezone).format(date);
}

// formatter 构造占逐分钟扫描的绝对大头——按 timezone 缓存实例后复用 formatToParts/format
const cronPartsFormatters = new Map<string, Intl.DateTimeFormat>();
const minuteKeyFormatters = new Map<string, Intl.DateTimeFormat>();

function getCronPartsFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = cronPartsFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      minute: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      day: "2-digit",
      month: "2-digit",
      weekday: "short"
    });
    cronPartsFormatters.set(timezone, formatter);
  }
  return formatter;
}

function getMinuteKeyFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = minuteKeyFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("sv-SE", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    });
    minuteKeyFormatters.set(timezone, formatter);
  }
  return formatter;
}
