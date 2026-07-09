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

test("renderUrl uses loadURL + executeJavaScript to serialize DOM", () => {
  assert.match(src, /\.loadURL\(/);
  assert.match(src, /executeJavaScript/);
  assert.match(src, /document\.documentElement\.outerHTML/);
});

test("renders are serialized via a queue", () => {
  assert.match(src, /queue|enqueue|pending|serialized/i);
});
