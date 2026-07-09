// packages/sdk/src/tools/render-judge.test.ts
import { describe, expect, test } from "bun:test";
import { shouldRender } from "./render-judge.js";

describe("shouldRender", () => {
  test("off => false", () => {
    expect(shouldRender("<html><body>x</body></html>", "off")).toBe(false);
  });
  test("force => true", () => {
    expect(shouldRender("<html></html>", "force")).toBe(true);
  });
  test("auto + normal article => false", () => {
    const body = "x".repeat(500);
    expect(shouldRender(`<html><body><article>${body}</article></body></html>`, "auto")).toBe(false);
  });
  test("auto + SPA shell (#app, little text) => true", () => {
    expect(shouldRender(`<html><body><div id="app"></div></body></html>`, "auto")).toBe(true);
  });
  test("auto + tiny body (< MIN_BODY_CHARS) => true", () => {
    expect(shouldRender(`<html><body>hi</body></html>`, "auto")).toBe(true);
  });
  test("auto + error shell (404) => false (rendering won't help)", () => {
    expect(shouldRender(`<html><head><title>404 Not Found</title></head><body>x</body></html>`, "auto")).toBe(false);
  });
});
