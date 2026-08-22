export type BrowserAgentScriptCall = {
  awaitPromise: true
  expression: string
  returnByValue: true
  timeout: number
  userGesture: true
}

export type BrowserAgentScriptResult =
  | { status: "completed"; value: unknown }
  | { status: "exception"; exception: { column?: number; line?: number; message: string } }

export function prepareBrowserAgentScript(input: Record<string, unknown>): BrowserAgentScriptCall {
  const script = typeof input.script === "string" ? input.script : ""
  if (!script.trim() || script.length > 50_000) throw codedError("invalid_browser_request")
  const arg = input.arg ?? null
  let serializedArg = ""
  try { serializedArg = JSON.stringify(arg) ?? "null" } catch { throw codedError("invalid_browser_request") }
  if (serializedArg.length > 100_000) throw codedError("invalid_browser_request")
  const invocation = `(async function(arg) {\n"use strict";\n${script}\n})(${serializedArg})`
  return {
    expression: `(async () => {
      const value = await ${invocation};
      let serialized;
      try { serialized = JSON.stringify(value); } catch { throw new Error("script_result_not_serializable"); }
      if (serialized === undefined) return null;
      if (serialized.length > 200000) throw new Error("script_result_too_large");
      return JSON.parse(serialized);
    })()`,
    awaitPromise: true,
    returnByValue: true,
    timeout: boundedInteger(input.timeout_ms ?? input.timeoutMs ?? 5_000, 100, 10_000),
    userGesture: true,
  }
}

export function normalizeBrowserAgentScriptResult(input: unknown): BrowserAgentScriptResult {
  const result = isRecord(input) && isRecord(input.result) ? input.result : {}
  const exceptionDetails = isRecord(input) && isRecord(input.exceptionDetails) ? input.exceptionDetails : undefined
  if (exceptionDetails) {
    const exception = isRecord(exceptionDetails.exception) ? exceptionDetails.exception : {}
    const message = firstString(exception.description, exceptionDetails.text, "Script execution failed").slice(0, 4_000)
    return {
      status: "exception",
      exception: {
        message,
        ...(Number.isInteger(exceptionDetails.lineNumber) ? { line: Number(exceptionDetails.lineNumber) } : {}),
        ...(Number.isInteger(exceptionDetails.columnNumber) ? { column: Number(exceptionDetails.columnNumber) } : {}),
      },
    }
  }
  if ("value" in result) return { status: "completed", value: result.value }
  if (typeof result.unserializableValue === "string") return { status: "completed", value: result.unserializableValue.slice(0, 1_000) }
  return { status: "completed", value: null }
}

function boundedInteger(value: unknown, min: number, max: number): number {
  const number = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : min
  return Math.max(min, Math.min(max, number))
}

function codedError(code: string): Error & { code: string } { return Object.assign(new Error(code), { code }) }
function firstString(...values: unknown[]): string { return values.find((value): value is string => typeof value === "string" && Boolean(value)) ?? "" }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value) }
