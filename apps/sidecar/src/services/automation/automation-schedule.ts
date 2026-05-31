import type { AutomationSchedule } from "@lume/shared";

interface CronFieldSpec {
  min: number;
  max: number;
  dateValue: (date: Date) => number;
  allowSundaySeven?: boolean;
}

const CRON_FIELD_SPECS: CronFieldSpec[] = [
  { min: 0, max: 59, dateValue: (date) => date.getMinutes() },
  { min: 0, max: 23, dateValue: (date) => date.getHours() },
  { min: 1, max: 31, dateValue: (date) => date.getDate() },
  { min: 1, max: 12, dateValue: (date) => date.getMonth() + 1 },
  { min: 0, max: 7, dateValue: (date) => date.getDay(), allowSundaySeven: true }
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

export function matchCronExpression(expr: string, date: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((field, index) => {
    const spec = CRON_FIELD_SPECS[index];
    return spec ? cronFieldMatches(field, spec, spec.dateValue(date)) : false;
  });
}

function getNextCronRunAt(expr: string, fromMs: number): number | null {
  validateCronExpression(expr);
  const candidate = new Date(fromMs);
  candidate.setSeconds(0, 0);
  let timestamp = candidate.getTime() + 60_000;
  const maxTimestamp = fromMs + 366 * 24 * 60 * 60_000;

  while (timestamp <= maxTimestamp) {
    const date = new Date(timestamp);
    if (matchCronExpression(expr, date)) {
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
    return;
  }
  if (schedule.type === "once") {
    if (typeof schedule.runAt !== "number" || !Number.isFinite(schedule.runAt) || schedule.runAt <= 0) {
      throw new Error("once 类型任务缺少有效 runAt");
    }
    return;
  }
  if (schedule.type === "interval") {
    if (typeof schedule.intervalMs !== "number" || !Number.isFinite(schedule.intervalMs) || schedule.intervalMs <= 0) {
      throw new Error("interval 类型任务缺少有效 intervalMs");
    }
    return;
  }
  if (schedule.type === "manual") {
    return;
  }
  throw new Error(`不支持的 schedule.type: ${(schedule as { type?: string }).type ?? "unknown"}`);
}

export function getNextAutomationRunAt(schedule: AutomationSchedule, fromMs = Date.now()): number | null {
  validateAutomationSchedule(schedule);
  if (schedule.type === "manual") return null;
  if (schedule.type === "once") return schedule.runAt ?? null;
  if (schedule.type === "interval") return fromMs + (schedule.intervalMs ?? 0);
  return getNextCronRunAt(schedule.cronExpr ?? "", fromMs);
}
