// packages/sdk/src/tools/render-judge.ts
export type RenderMode = "auto" | "force" | "off";

export const MIN_BODY_CHARS = 200;

const SPA_ROOT_IDS = new Set(["app", "root", "__next", "__nuxt"]);

export function shouldRender(rawHtml: string, mode: RenderMode): boolean {
  if (mode === "off") return false;
  if (mode === "force") return true;
  // auto
  if (isErrorShell(rawHtml)) return false;
  if (hasSpaShell(rawHtml)) return true;
  if (bodyTextLength(rawHtml) < MIN_BODY_CHARS) return true;
  return false;
}

export function bodyTextLength(rawHtml: string): number {
  const bodyMatch = rawHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : rawHtml;
  const stripped = body
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ");
  return stripped.replace(/\s+/g, " ").trim().length;
}

export function hasSpaShell(rawHtml: string): boolean {
  if (!/id="(app|root|__next|__nuxt)"/i.test(rawHtml)) return false;
  return bodyTextLength(rawHtml) < MIN_BODY_CHARS;
}

export function isErrorShell(rawHtml: string): boolean {
  const titleMatch = rawHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = (titleMatch?.[1] || "").toLowerCase();
  if (/(403|404|not found|forbidden|access denied)/i.test(title)) return true;
  return false;
}

void SPA_ROOT_IDS; // reserved for future per-id tuning
