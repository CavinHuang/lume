import assert from "node:assert/strict";
import test from "node:test";
import { createCursorUpdateScript } from "../src/browser-cursor.ts";

test("cursor update script parses and updates left/top with pulse state", () => {
  const script = createCursorUpdateScript(42, 17, true);
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /style\.left/);
  assert.match(script, /style\.top/);
  assert.match(script, /42/);
  assert.match(script, /17/);
  assert.match(script, /pulse/);
});
