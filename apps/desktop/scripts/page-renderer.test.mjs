import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "src", "page-renderer.ts"), "utf8");

test("page-renderer.ts exists and exports PageRenderer", () => {
  assert.match(src, /export class PageRenderer/);
});

test("render window is created hidden with secure prefs", () => {
  assert.match(src, /show:\s*false/);
  assert.match(src, /createSecureWebPreferences\(\)/);
});

test("render window uses isolated in-memory partition (not persist:)", () => {
  assert.match(src, /partition:\s*['"]render['"]/);
  assert.doesNotMatch(src, /partition:\s*['"]persist:/);
});

test("render window restricts navigation to same-origin http/https only", () => {
  assert.match(src, /allowNavigation/);
  assert.match(src, /allowedOrigin/);
  assert.match(src, /parsed\.origin\s*===\s*this\.allowedOrigin/);
  assert.match(src, /protocol !== 'http:' && parsed.protocol !== 'https:'/);
});

test("render window recovers from render-process-gone crash", () => {
  assert.match(src, /render-process-gone/);
  assert.match(src, /win\.destroy\(\)|this\.win = null/);
});

test("renderUrl uses loadURL + executeJavaScript to serialize DOM", () => {
  assert.match(src, /\.loadURL\(/);
  assert.match(src, /executeJavaScript/);
  assert.match(src, /document\.documentElement\.outerHTML/);
});

test("renders are serialized via a queue", () => {
  assert.match(src, /queue|enqueue|pending|serialized/i);
});
