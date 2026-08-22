import { describe, expect, test } from "bun:test";
import { parseStructuredOutput } from "./structured-output.js";

const schema = { type: "object", properties: { answer: { type: "string" } } };

describe("parseStructuredOutput (#318)", () => {
  test("parses bare JSON and fenced JSON as before", () => {
    expect(parseStructuredOutput('{"answer":"ok"}', schema)).toEqual({ answer: "ok" });
    expect(parseStructuredOutput('```json\n{"answer":"ok"}\n```', schema)).toEqual({ answer: "ok" });
    expect(parseStructuredOutput('```\n{"answer":"ok"}\n```', schema)).toEqual({ answer: "ok" });
  });

  test("recovers JSON preceded by prose", () => {
    const text = 'Here is the requested result:\n{"answer":"ok"}';
    expect(parseStructuredOutput(text, schema)).toEqual({ answer: "ok" });
  });

  test("skips braces inside string literals and honors escapes", () => {
    const text = String.raw`Result: {"answer":"has } brace, { open brace and \" escaped quote"}`;
    expect(parseStructuredOutput(text, schema)).toEqual({
      answer: 'has } brace, { open brace and " escaped quote',
    });
  });

  test("extracts the outer object of a nested payload", () => {
    const text = 'Sure!\n{"outer":{"inner":"value"},"n":1}';
    expect(parseStructuredOutput(text, schema)).toEqual({ outer: { inner: "value" }, n: 1 });
  });

  test("returns undefined for truncated or JSON-less output", () => {
    expect(parseStructuredOutput('partial {"answer":"un', schema)).toBeUndefined();
    expect(parseStructuredOutput("no json at all", schema)).toBeUndefined();
    expect(parseStructuredOutput("", schema)).toBeUndefined();
  });

  test("returns undefined when no schema is configured", () => {
    expect(parseStructuredOutput('{"answer":"ok"}')).toBeUndefined();
  });
});
