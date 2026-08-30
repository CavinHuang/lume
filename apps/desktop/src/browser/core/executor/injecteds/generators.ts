/**
 * 注入脚本生成器 —— ZCode 浏览器命令执行引擎的页面脚本模板。
 *
 * 来源:D:\workspace\projects\ai-projects\lume\.zcode\analysis\extracted\
 *       02-execution-engine.source.js [SECTION] 注入脚本生成器
 *       injected-scripts/runtime-exact/*.js(字节参照)
 *
 * ZCode 原名对照:
 *   Rj → SNAPSHOT_SCRIPT        snapshotScript(maxElements, includeHidden)
 *   Ej → RESOLVE_SCRIPT         resolveScript(ref)
 *   Aj → SELECT_SCRIPT          selectScript(ref, values)
 *   xj → CHECK_SCRIPT           checkScript(ref, checked)
 *   Mj → ELEMENT_AT_POINT_SCRIPT elementAtPointScript(x, y)
 *   Oj → EVALUATE_SCRIPT        evaluateScript(expression)
 *   Fj → (文本粘贴页函数)        pasteTextPageFunction()
 *   di → (输入目标 token 字段)   INPUT_TARGET_TOKEN_FIELD
 *   ple → elementInfoRuntime     ELEMENT_INFO_RUNTIME_FN_SOURCE(序列化字节)
 *   IH → overlayRuntime          OVERLAY_RUNTIME_FN_SOURCE(序列化字节)
 *
 * 语义偏差(仅命名/装配层):
 *   - 每个生成器与原源码同为字符串拼接;常量主体保存在 generated-literals.ts
 *     (由 runtime-exact 文件逐字节生成),测试保证与参照文件逐字节相等。
 *   - ple/IH 在 ZCode 经 fn.toString() 序列化(yM);Bun 的 TS 转译会改写
 *     函数体字节(变量内联),故以字符串常量保存 fn.toString() 结果,
 *     serializeRuntimeCall 输出与 yM 逐字节一致(见 ../element-info.ts)。
 *
 * ref 注册表为页面内 window.__zcodeRefs(Map<ref, Element>),由 SNAPSHOT_SCRIPT
 * 与 ELEMENT_AT_POINT_SCRIPT 写入、RESOLVE/SELECT/CHECK 脚本消费。
 */
import {
  ELEMENT_AT_POINT_SCRIPT_BODY,
  ELEMENT_INFO_RUNTIME_FN_SOURCE,
  FJ_RUNTIME_HEAD_LAST_LINE,
  FJ_RUNTIME_HEAD_LINES,
  FJ_RUNTIME_TAIL_FIRST_LINE,
  FJ_RUNTIME_TAIL_LINES,
  INPUT_TARGET_TOKEN_FIELD,
  OVERLAY_RUNTIME_FN_SOURCE,
  SNAPSHOT_SCRIPT_BODY,
} from "./generated-literals"

/**
 * ZCode 原名 Rj/SNAPSHOT_SCRIPT:页面元素+DOM 双清单快照脚本。
 * 返回立即执行表达式;MAX=元素上限(默认 200),DOM_MAX=DOM 节点上限(固定 300),
 * INCLUDE_HIDDEN=是否包含隐藏元素。执行时重建 window.__zcodeRefs。
 */
export function snapshotScript(maxElements?: number, includeHidden?: boolean): string {
  const max = typeof maxElements === "number" && maxElements > 0 ? Math.floor(maxElements) : 200
  const hidden = includeHidden === true
  return "(function(){var MAX=" + String(max) + ";var DOM_MAX=" + String(300) + ";var INCLUDE_HIDDEN=" + String(hidden) + SNAPSHOT_SCRIPT_BODY
}

/**
 * ZCode 原名 Ej/RESOLVE_SCRIPT:按 ref 解析元素中心视口坐标(cx/cy),
 * 先 scrollIntoView 居中再取 getBoundingClientRect。
 */
export function resolveScript(ref: string): string {
  return "(function(){var m=window.__zcodeRefs;var el=m&&m.get(" + JSON.stringify(ref) + ");if(!el)return null;el.scrollIntoView({block:'center',inline:'center'});var b=el.getBoundingClientRect();return {cx:Math.round(b.left+b.width/2),cy:Math.round(b.top+b.height/2)};})()"
}

/**
 * ZCode 原名 Aj/SELECT_SCRIPT:按 ref 解析 <select> 并按 value/text 匹配选中
 * values 列表,派发 input+change 事件;返回 {ok:true} 或 {error:...}。
 */
export function selectScript(ref: string, values: Array<unknown>): string {
  const refJson = JSON.stringify(ref)
  const valuesJson = JSON.stringify(values)
  return "(function(){var m=window.__zcodeRefs;var el=m&&m.get(" + refJson + ");if(!el)return {error:'ref_not_found'};if(!el.tagName||el.tagName.toLowerCase()!=='select')return {error:'not_select'};var values=" + valuesJson + ";var matched=false;for(var oi=0;oi<el.options.length;oi++){el.options[oi].selected=false;}for(var vi=0;vi<values.length;vi++){var want=values[vi];var found=false;for(var i=0;i<el.options.length;i++){if(el.options[i].value===want){el.options[i].selected=true;found=true;matched=true;break;}}if(!found){for(var j=0;j<el.options.length;j++){if((el.options[j].text||'').trim()===String(want).trim()){el.options[j].selected=true;found=true;matched=true;break;}}}}if(!matched)return {error:'no_match'};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return {ok:true};})()"
}

/**
 * ZCode 原名 xj/CHECK_SCRIPT:按 ref 解析 checkbox/radio 并置为 checked
 * (默认 true),仅在 checked !== want 时 click;返回 {ok,checked} 或 {error}。
 */
export function checkScript(ref: string, checked?: boolean): string {
  const refJson = JSON.stringify(ref)
  const want = checked ? "true" : "false"
  return "(function(){var m=window.__zcodeRefs;var el=m&&m.get(" + refJson + ");if(!el)return {error:'ref_not_found'};var tag=el.tagName?el.tagName.toLowerCase():'';var ty=((el.getAttribute&&el.getAttribute('type'))||'').toLowerCase();if(tag!=='input'||(ty!=='checkbox'&&ty!=='radio'))return {error:'not_checkable'};var want=" + want + ";if(el.checked!==want){el.click();}return {ok:true,checked:el.checked===true};})()"
}

/**
 * ZCode 原名 Mj/ELEMENT_AT_POINT_SCRIPT:取 (x,y) 处最顶层元素,登记为
 * p 序列 ref 并返回元素详情(与快照元素同构);无元素时返回 null。
 */
export function elementAtPointScript(x: number, y: number): string {
  const xJson = JSON.stringify(x)
  const yJson = JSON.stringify(y)
  return "(function(){var el=document.elementFromPoint(" + xJson + "," + yJson + ")" + ELEMENT_AT_POINT_SCRIPT_BODY
}

/**
 * ZCode 原名 Oj/EVALUATE_SCRIPT:包裹用户表达式求值并序列化结果。
 * 契约:{ok:true,kind:'json',data} | {ok:true,kind:'str',data} |
 * {ok:false,message}。JSON 序列化失败降级 String();表达式原样插值。
 */
export function evaluateScript(expression: string): string {
  return "(function(){try{var __v=(function(){ return (" + expression + "\n); })();var __s;try{__s=JSON.stringify(__v);}catch(e){__s=undefined;}if(typeof __s==='string')return {ok:true,kind:'json',data:__s};return {ok:true,kind:'str',data:String(__v)};}catch(err){return {ok:false,message:(err&&err.message)?String(err.message):String(err)};}})()"
}

/**
 * ZCode 原名 Fj:虚拟剪贴板文本粘贴页函数(async (options) => {...})。
 * 处理 paste 事件 + fallbackPaste 直写 value/setRangeText/execCommand,
 * 并校验 options.inputTargetToken 未漂移(见 dispatch 的 pasteTextIntoFocusedTarget)。
 * ZCode 以模板字面量对 di 插值;此处等价拆为 head + token + tail 拼接。
 */
export function pasteTextPageFunction(): string {
  return [
    ...FJ_RUNTIME_HEAD_LINES,
    FJ_RUNTIME_HEAD_LAST_LINE + INPUT_TARGET_TOKEN_FIELD + FJ_RUNTIME_TAIL_FIRST_LINE,
    ...FJ_RUNTIME_TAIL_LINES,
  ].join("\n")
}

export {
  ELEMENT_INFO_RUNTIME_FN_SOURCE,
  OVERLAY_RUNTIME_FN_SOURCE,
  INPUT_TARGET_TOKEN_FIELD,
}
