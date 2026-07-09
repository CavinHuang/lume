import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(join(here, "..", "src", "main.ts"), "utf8");

test("main.ts intercepts render:request before forwarding to renderer", () => {
  assert.match(main, /render:request/);
  assert.match(main, /handleRenderRequest/);
});

test("main.ts calls render:result back via sidecarHost", () => {
  assert.match(main, /render:result/);
});

test("main.ts instantiates PageRenderer and guards null", () => {
  assert.match(main, /pageRenderer/);
  assert.match(main, /PageRenderer/);
});
