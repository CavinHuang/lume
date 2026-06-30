import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const webRoot = resolve(import.meta.dirname, "..");
const indexHtml = readFileSync(resolve(webRoot, "index.html"), "utf8");

function extractCspContent(html) {
  const match = html.match(/<meta\s+http-equiv=["']Content-Security-Policy["']\s+content="([^"]+)"\s*\/?>/i);
  return match?.[1] ?? null;
}

test("web shell declares an Electron-compatible CSP without inline scripts", () => {
  const csp = extractCspContent(indexHtml);

  assert.ok(csp, "index.html must declare Content-Security-Policy");
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.match(csp, /object-src 'none'/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
  assert.doesNotMatch(indexHtml, /<script>([\s\S]*?)<\/script>/i);
  assert.match(indexHtml, /<script\s+src="\/boot-theme\.js"><\/script>/);
});

test("static boot assets are external so CSP can block inline script", () => {
  assert.match(indexHtml, /<link\s+rel="stylesheet"\s+href="\/boot\.css"\s*\/?>/);
  assert.equal(existsSync(resolve(webRoot, "public", "boot-theme.js")), true);
  assert.equal(existsSync(resolve(webRoot, "public", "boot.css")), true);
});
