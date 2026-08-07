export type IconKind = "lobehub" | "image" | "letter";

// @lobehub/icons 实际覆盖的 service(5.5.4 验证)。仅这 9 个有 Mono 组件;
// 其余 service 一律走首字母兜底 —— 这是有意的,避免追求全量图标而引入额外图标资源包。
export const LOBEHUB_SERVICES = [
  "github", "notion", "microsoft", "figma", "vercel",
  "openai", "anthropic", "cohere", "perplexity",
] as const;

export function decideIconKind(service: string, iconUrl?: string): IconKind {
  const key = service.toLowerCase();
  if ((LOBEHUB_SERVICES as readonly string[]).includes(key)) return "lobehub";
  if (iconUrl) return "image";
  return "letter";
}

export function initialOf(value: string): string {
  const trimmed = value.trim();
  return trimmed ? trimmed[0].toUpperCase() : "?";
}

const LETTER_COLORS = ["#3b82f6", "#8b5cf6", "#ec4899", "#d97706", "#10b981", "#06b6d4", "#ef4444", "#6366f1"];

export function colorForSeed(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return LETTER_COLORS[Math.abs(hash) % LETTER_COLORS.length];
}
