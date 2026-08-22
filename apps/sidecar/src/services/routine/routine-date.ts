/**
 * 本地时区日期键（YYYY-MM-DD）。
 * 此前用 toISOString().slice(0,10) 取 UTC 键：UTC-5 时区 19:00 后当日 routine
 * 即失联、晨间生成会落到昨日键（#408）。日程语义一律按本地日历日。
 */
export function localDateKey(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
