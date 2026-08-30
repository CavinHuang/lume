/**
 * 页面求值 —— EVALUATE_SCRIPT 包裹执行与 {ok,kind,data} 契约解析。
 *
 * 来源:D:\workspace\projects\ai-projects\lume\.zcode\analysis\extracted\
 *       02-execution-engine.source.js(handleEvaluate)
 *       injected-scripts/runtime-exact/EVALUATE_SCRIPT(expr).js
 *
 * ZCode 原名对照:
 *   wH → handleEvaluate    Oj → evaluateScript(见 injecteds/generators.ts)
 *
 * 语义偏差:无。
 */
import type { BrowserCommandResult, ControlledView } from "../types"
import { executionError, type CommandDone, type EvaluateCommandParams } from "./dispatcher"
import { evaluateScript } from "./injecteds/generators"

/**
 * ZCode 原名 wH/handleEvaluate:EVALUATE_SCRIPT 包裹表达式求值。
 * 页面契约:{ok:true,kind:'json'|'str',data} | {ok:false,message};
 * JSON 序列化结果解析失败时降级为原始字符串(data)。
 */
export async function handleEvaluate(view: ControlledView, params: EvaluateCommandParams, done: CommandDone): Promise<BrowserCommandResult> {
  const result = await view.webContents.executeJavaScript(evaluateScript(params.expression)) as { ok?: unknown; message?: unknown; kind?: unknown; data?: unknown } | null
  if (!result || typeof result !== "object") return done(executionError("evaluate returned invalid result"))
  if (result.ok === false) return done(executionError((result.message as string | undefined) ?? "evaluate error"))
  let value: unknown
  if (result.kind === "json" && typeof result.data === "string") {
    try {
      value = JSON.parse(result.data)
    } catch {
      value = result.data
    }
  } else {
    value = result.data
  }
  return done({
    ok: true,
    value,
  })
}
