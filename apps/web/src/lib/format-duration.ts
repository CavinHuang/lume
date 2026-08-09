/** 毫秒 → 可读时长。<60s 保留 1 位小数;60s..1h 为 mm:ss;≥1h 为 h:mm:ss。 */
export function formatDurationLabel(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const totalSec = Math.floor(s);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  if (s < 3600) return `${mm}:${String(ss).padStart(2, "0")}`;
  const hh = Math.floor(mm / 60);
  return `${hh}:${String(mm % 60).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/** 运行态:<60s 取整秒,≥60s 复用 formatDurationLabel。 */
export function formatRunningDuration(ms: number): string {
  if (ms <= 0) return "";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(0)}s`;
  return formatDurationLabel(ms);
}

/** 完成态:<60s 保留 1 位小数,≥60s 复用 formatDurationLabel。 */
export function formatCompletedDuration(ms: number): string {
  if (ms <= 0) return "";
  return formatDurationLabel(ms);
}
