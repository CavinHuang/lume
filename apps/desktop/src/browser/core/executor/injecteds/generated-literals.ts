/**
 * 注入脚本字节恒定字面量 —— 由 runtime-exact 提取文件逐字节生成(勿手改)。
 *
 * 来源:
 *   - SNAPSHOT_SCRIPT 主体 ← injected-scripts/runtime-exact/SNAPSHOT_SCRIPT(max=200,hidden=false).js
 *     (自 ";var ACTION_SEL=" 起的常量尾部;MAX/DOM_MAX/INCLUDE_HIDDEN 前缀由 generators.ts 插值)
 *   - ELEMENT_AT_POINT 主体 ← runtime-exact/ELEMENT_AT_POINT_SCRIPT(x,y).js
 *     (自 elementFromPoint(...) 之后的常量尾部)
 *   - Fj 粘贴页函数 ← runtime-exact/Fj.runtime.js(按 di token 位拆分插值)
 *   - elementInfoRuntime/overlayRuntime ← runtime-exact/*.exact.js
 *     (ZCode 经 fn.toString() 序列化;Bun 的 TS 转译会改写函数体字节,
 *      故以字符串常量保存序列化结果,序列化输出与 yM 逐字节一致)
 *
 * 修改注入脚本时必须同步更新 runtime-exact 参照与生成脚本。
 */

/** ZCode 原名 di:输入目标 token 的元素属性字段名。 */
export const INPUT_TARGET_TOKEN_FIELD = "__zcodeIabInputTargetToken"

/** SNAPSHOT_SCRIPT 常量尾部(不含参数化前缀,以 ";var ACTION_SEL=" 起)。 */
export const SNAPSHOT_SCRIPT_BODY = ";var ACTION_SEL='a[href], button, input, textarea, select, [role], [onclick], [tabindex], summary, label, [contenteditable]';var DOM_SEL='body, main, nav, header, footer, aside, section, article, h1, h2, h3, h4, h5, h6, p, ul, ol, li, dl, dt, dd, blockquote, pre, code, table, caption, thead, tbody, tfoot, tr, th, td, form, fieldset, legend, figure, figcaption, img, canvas, svg, a[href], button, input, textarea, select, option, summary, label, [role], [aria-label], [contenteditable]';function safeId(id){return /^[A-Za-z][A-Za-z0-9_-]*$/.test(id);}function isHidden(el){try{var st=window.getComputedStyle(el);if(!st)return false;if(st.display==='none'||st.visibility==='hidden'||st.opacity==='0')return true;var r=el.getBoundingClientRect();if(r.width<=0&&r.height<=0)return true;return false;}catch(e){return false;}}function accName(el){var n=el.getAttribute('aria-label')||el.getAttribute('alt')||el.getAttribute('title')||el.getAttribute('placeholder')||'';if(!n){n=(el.innerText||el.textContent||'');}n=(n||'').trim();return n.slice(0,120);}function semanticName(el,tag){var n=el.getAttribute('aria-label')||el.getAttribute('alt')||el.getAttribute('title')||el.getAttribute('placeholder')||'';if(!n&&/^(a|button|input|textarea|select|summary)$/.test(tag))n=accName(el);return String(n||'').trim().replace(/\\s+/g,' ').slice(0,120);}function attrsOf(el){var out={};var keys=['id','href','name','type','placeholder','title','alt','role','aria-label','data-testid','data-test','data-qa'];for(var i=0;i<keys.length;i++){var v=el.getAttribute(keys[i]);if(v!=null&&String(v).trim()!=='')out[keys[i]]=String(v).trim().slice(0,240);}return out;}function depthOf(el){if(el===document.body)return 0;var d=0;var p=el.parentElement;while(p&&p!==document.body){d++;p=p.parentElement;}return d;}function semanticText(el,tag){if(!/^(h[1-6]|p|li|dt|dd|blockquote|pre|code|caption|th|td|label|summary|button|a|option|legend|figcaption)$/.test(tag))return '';return String(el.innerText||el.textContent||'').trim().replace(/\\s+/g,' ').slice(0,300);}function implicitRole(el,tag){if(tag==='a'&&el.getAttribute('href')!=null)return 'link';if(tag==='button')return 'button';if(tag==='select')return 'combobox';if(tag==='textarea')return 'textbox';if(tag==='summary')return 'button';if(tag==='input'){var ty=(el.getAttribute('type')||'text').toLowerCase();if(ty==='checkbox')return 'checkbox';if(ty==='radio')return 'radio';if(ty==='button'||ty==='submit'||ty==='reset')return 'button';if(ty==='search')return 'searchbox';return 'textbox';}return '';}function buildSelector(el){if(el.id&&safeId(el.id))return '#'+el.id;var parts=[];var cur=el;var depth=0;while(cur&&cur.nodeType===1&&depth<6){if(cur.id&&safeId(cur.id)){parts.unshift('#'+cur.id);break;}var t=cur.tagName.toLowerCase();var idx=1;var sib=cur.previousElementSibling;while(sib){if(sib.tagName===cur.tagName)idx++;sib=sib.previousElementSibling;}parts.unshift(t+':nth-of-type('+idx+')');cur=cur.parentElement;depth++;}return parts.join(' > ');}function xpathOf(el){if(el.id&&safeId(el.id))return \"//*[@id='\"+el.id+\"']\";var parts=[];var cur=el;while(cur&&cur.nodeType===1){var t=cur.tagName.toLowerCase();var idx=1;var sib=cur.previousElementSibling;while(sib){if(sib.tagName===cur.tagName)idx++;sib=sib.previousElementSibling;}parts.unshift(t+'['+idx+']');cur=cur.parentElement;}return '/'+parts.join('/');}try{window.__zcodeRefs=new Map();}catch(e){window.__zcodeRefs=null;}var elRef=(typeof WeakMap!=='undefined')?new WeakMap():null;var vw=window.innerWidth||document.documentElement.clientWidth||0;var vh=window.innerHeight||document.documentElement.clientHeight||0;var nodes=document.querySelectorAll(ACTION_SEL);var elements=[];var truncated=false;var count=0;for(var i=0;i<nodes.length;i++){var el=nodes[i];if(!INCLUDE_HIDDEN&&isHidden(el))continue;if(count>=MAX){truncated=true;break;}count++;var ref='e'+count;if(window.__zcodeRefs)window.__zcodeRefs.set(ref,el);if(elRef)elRef.set(el,ref);var r=el.getBoundingClientRect();var rect={x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)};var inViewport=r.top<vh&&r.bottom>0&&r.left<vw&&r.right>0;var tag=el.tagName.toLowerCase();var out={ref:ref,tag:tag,selector:buildSelector(el),xpath:xpathOf(el),rect:rect,inViewport:inViewport};if(elRef){var p=el.parentElement;while(p){var pr=elRef.get(p);if(pr){out.parentRef=pr;break;}p=p.parentElement;}}var role=el.getAttribute('role')||implicitRole(el,tag);if(role)out.role=role;var name=accName(el);if(name)out.name=name;var text=(el.innerText||'').trim().slice(0,100);if(text)out.text=text;var attrs=attrsOf(el);if(Object.keys(attrs).length)out.attributes=attrs;if((tag==='input'||tag==='textarea'||tag==='select')&&el.value!=null&&el.value!=='')out.value=String(el.value);if(el.disabled===true)out.disabled=true;if(tag==='input'&&(el.type==='checkbox'||el.type==='radio'))out.checked=el.checked===true;elements.push(out);}var domCandidates=document.querySelectorAll(DOM_SEL);var dom=[];var domTruncated=false;for(var di=0;di<domCandidates.length;di++){var de=domCandidates[di];if(!INCLUDE_HIDDEN&&isHidden(de))continue;if(dom.length>=DOM_MAX){domTruncated=true;break;}var dr=de.getBoundingClientRect();var dtag=de.tagName.toLowerCase();var dn={tag:dtag,depth:depthOf(de),inViewport:dr.top<vh&&dr.bottom>0&&dr.left<vw&&dr.right>0};if(elRef){var dref=elRef.get(de);if(dref)dn.ref=dref;}var drole=de.getAttribute('role')||implicitRole(de,dtag);if(drole)dn.role=drole;var dname=semanticName(de,dtag);if(dname)dn.name=dname;var dtext=semanticText(de,dtag);if(dtext)dn.text=dtext;var dattrs=attrsOf(de);if(Object.keys(dattrs).length)dn.attributes=dattrs;dom.push(dn);}return {url:location.href,title:document.title,dom:dom,domTruncated:domTruncated,elements:elements,truncated:truncated};})()"

/** ELEMENT_AT_POINT_SCRIPT 常量尾部(不含坐标前缀,以 ";if(!el" 起)。 */
export const ELEMENT_AT_POINT_SCRIPT_BODY = ";if(!el||el.nodeType!==1)return null;function safeId(id){return /^[A-Za-z][A-Za-z0-9_-]*$/.test(id);}function accName(el){var n=el.getAttribute('aria-label')||el.getAttribute('alt')||el.getAttribute('title')||el.getAttribute('placeholder')||'';if(!n){n=(el.innerText||el.textContent||'');}n=(n||'').trim();return n.slice(0,120);}function implicitRole(el,tag){if(tag==='a'&&el.getAttribute('href')!=null)return 'link';if(tag==='button')return 'button';if(tag==='select')return 'combobox';if(tag==='textarea')return 'textbox';if(tag==='summary')return 'button';if(tag==='input'){var ty=(el.getAttribute('type')||'text').toLowerCase();if(ty==='checkbox')return 'checkbox';if(ty==='radio')return 'radio';if(ty==='button'||ty==='submit'||ty==='reset')return 'button';if(ty==='search')return 'searchbox';return 'textbox';}return '';}function buildSelector(el){if(el.id&&safeId(el.id))return '#'+el.id;var parts=[];var cur=el;var depth=0;while(cur&&cur.nodeType===1&&depth<6){if(cur.id&&safeId(cur.id)){parts.unshift('#'+cur.id);break;}var t=cur.tagName.toLowerCase();var idx=1;var sib=cur.previousElementSibling;while(sib){if(sib.tagName===cur.tagName)idx++;sib=sib.previousElementSibling;}parts.unshift(t+':nth-of-type('+idx+')');cur=cur.parentElement;depth++;}return parts.join(' > ');}function xpathOf(el){if(el.id&&safeId(el.id))return \"//*[@id='\"+el.id+\"']\";var parts=[];var cur=el;while(cur&&cur.nodeType===1){var t=cur.tagName.toLowerCase();var idx=1;var sib=cur.previousElementSibling;while(sib){if(sib.tagName===cur.tagName)idx++;sib=sib.previousElementSibling;}parts.unshift(t+'['+idx+']');cur=cur.parentElement;}return '/'+parts.join('/');}if(!window.__zcodeRefs){try{window.__zcodeRefs=new Map();}catch(e){window.__zcodeRefs=null;}}window.__zcodePtSeq=(window.__zcodePtSeq||0)+1;var ref='p'+window.__zcodePtSeq;if(window.__zcodeRefs)window.__zcodeRefs.set(ref,el);var vw=window.innerWidth||document.documentElement.clientWidth||0;var vh=window.innerHeight||document.documentElement.clientHeight||0;var r=el.getBoundingClientRect();var rect={x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)};var inViewport=r.top<vh&&r.bottom>0&&r.left<vw&&r.right>0;var tag=el.tagName.toLowerCase();var out={ref:ref,tag:tag,selector:buildSelector(el),xpath:xpathOf(el),rect:rect,inViewport:inViewport};var role=el.getAttribute('role')||implicitRole(el,tag);if(role)out.role=role;var name=accName(el);if(name)out.name=name;var text=(el.innerText||'').trim().slice(0,100);if(text)out.text=text;if((tag==='input'||tag==='textarea'||tag==='select')&&el.value!=null&&el.value!=='')out.value=String(el.value);if(el.disabled===true)out.disabled=true;if(tag==='input'&&(el.type==='checkbox'||el.type==='radio'))out.checked=el.checked===true;return out;})()"

/** Fj 文本粘贴页函数头部完整行(至 token 所在行的上一行,按 LF 分行)。 */
export const FJ_RUNTIME_HEAD_LINES: readonly string[] = [
  "async (options) => {",
  "  const asElement = (candidate) => {",
  "    if (candidate == null || typeof candidate !== \"object\" || !(\"ownerDocument\" in candidate))",
  "      return null;",
  "    const view = candidate.ownerDocument?.defaultView ?? null;",
  "    return view != null && candidate instanceof view.Element ? candidate : null;",
  "  };",
  "  const elementWindow = (element) => element.ownerDocument.defaultView ?? window;",
  "  const deepestActiveElement = (root) => {",
  "    const active = root.activeElement;",
  "    if (active == null) return null;",
  "    const view = elementWindow(active);",
  "    if (active instanceof view.HTMLElement && active.shadowRoot != null)",
  "      return deepestActiveElement(active.shadowRoot) ?? active;",
  "    if (active instanceof view.HTMLIFrameElement || active instanceof view.HTMLFrameElement) {",
  "      try {",
  "        const frameDocument = active.contentDocument ?? active.contentWindow?.document ?? null;",
  "        if (frameDocument != null) return deepestActiveElement(frameDocument) ?? active;",
  "      } catch {",
  "        return active;",
  "      }",
  "    }",
  "    return active;",
  "  };",
  "  const textForMime = (items, mimeType) =>",
  "    items.flatMap((item) => item.entries).find((entry) => entry.mime_type === mimeType)?.text ?? \"\";",
  "  const fallbackPaste = (target, html, text, replaceInputValue) => {",
  "    const element = asElement(target);",
  "    if (element == null) return;",
  "    const view = elementWindow(element);",
  "    if (element instanceof view.HTMLTextAreaElement || element instanceof view.HTMLInputElement) {",
  "      if (element.disabled || element.readOnly || text.length === 0) return;",
  "      const setValue = (value) => {",
  "        const prototype = Object.getPrototypeOf(element);",
  "        const prototypeSetter = Object.getOwnPropertyDescriptor(prototype, \"value\")?.set;",
  "        const ownSetter = Object.getOwnPropertyDescriptor(element, \"value\")?.set;",
  "        if (prototypeSetter != null && ownSetter !== prototypeSetter) prototypeSetter.call(element, value);",
  "        else element.value = value;",
  "      };",
  "      if (element.selectionStart == null || element.selectionEnd == null) {",
  "        setValue(replaceInputValue ? text : element.value + text);",
  "      } else {",
  "        const start = element.selectionStart ?? element.value.length;",
  "        const end = element.selectionEnd ?? element.value.length;",
  "        try {",
  "          element.setRangeText(text, start, end, \"end\");",
  "        } catch {",
  "          setValue(replaceInputValue ? text : element.value + text);",
  "        }",
  "      }",
  "      element.dispatchEvent(new view.InputEvent(\"input\", { bubbles: true }));",
  "      return;",
  "    }",
  "    if (",
  "      element instanceof view.HTMLElement &&",
  "      (element.isContentEditable || element.closest(\"[contenteditable=true]\"))",
  "    ) {",
  "      element.focus();",
  "      if (html.length > 0) {",
  "        element.ownerDocument.execCommand(\"insertHTML\", false, html);",
  "        return;",
  "      }",
  "      if (text.length > 0) element.ownerDocument.execCommand(\"insertText\", false, text);",
  "    }",
  "  };",
  "",
  "  const target = deepestActiveElement(document) ?? document.body;",
  "  if (options.inputTargetToken != null) {",
  "    const element = asElement(target);",
]

/** Fj token 所在行的部分行(以 "?." 结尾,与 INPUT_TARGET_TOKEN_FIELD 同行拼接)。 */
export const FJ_RUNTIME_HEAD_LAST_LINE = "    if ((element ?? null)?."

/** Fj token 插值点之后的首行(以 "!==" 起,与 INPUT_TARGET_TOKEN_FIELD 拼接)。 */
export const FJ_RUNTIME_TAIL_FIRST_LINE = "!== options.inputTargetToken)"

/** Fj 文本粘贴页函数尾部(首行之后,按 LF 分行)。 */
export const FJ_RUNTIME_TAIL_LINES: readonly string[] = [
  "      throw new Error(\"Active element is no longer the expected input target\");",
  "  }",
  "  if (options.clipboardItems.length === 0)",
  "    throw new Error(\"Browser Use virtual clipboard has no data to paste\");",
  "  const targetElement = asElement(target);",
  "  const view = targetElement == null ? window : elementWindow(targetElement);",
  "  const plainText = textForMime(options.clipboardItems, \"text/plain\");",
  "  const richText = options.richTextFallback === true",
  "    ? textForMime(options.clipboardItems, \"text/html\")",
  "    : \"\";",
  "  if (typeof view.DataTransfer !== \"function\" || typeof view.ClipboardEvent !== \"function\") {",
  "    fallbackPaste(target, richText, plainText, options.replaceInputValue === true);",
  "    return {};",
  "  }",
  "  const dataTransfer = new view.DataTransfer();",
  "  for (const item of options.clipboardItems)",
  "    for (const entry of item.entries)",
  "      if (typeof entry.text === \"string\") dataTransfer.setData(entry.mime_type, entry.text);",
  "  const pasteEvent = new view.ClipboardEvent(\"paste\", {",
  "    bubbles: true,",
  "    cancelable: true,",
  "    clipboardData: dataTransfer,",
  "    composed: true,",
  "  });",
  "  if (target.dispatchEvent(pasteEvent))",
  "    fallbackPaste(target, richText, plainText, options.replaceInputValue === true);",
  "  return {};",
  "}",
]

/** ZCode 原名 ple(elementInfoRuntime)的 fn.toString() 序列化字节。 */
export const ELEMENT_INFO_RUNTIME_FN_SOURCE = "function ple(e){let t=s(i=>globalThis.CSS?.escape?.(i)??i.replace(/[^\\w-]/g,\"\\\\$&\"),\"cssEscape\"),r=s(i=>{let a=[];i.id&&a.push(`#${t(i.id)}`);let c=i.getAttribute(\"data-testid\");c&&a.push(`[data-testid=${JSON.stringify(c)}]`);let d=i.getAttribute(\"aria-label\");return d&&a.push(`[aria-label=${JSON.stringify(d)}]`),a.push(i.tagName.toLowerCase()),[...new Set(a)]},\"candidatesFor\"),o=s(i=>i.getAttribute(\"role\")??(i.matches(\"button,input[type=button],input[type=submit]\")?\"button\":i.matches(\"a[href]\")?\"link\":i.matches(\"input:not([type]),input[type=text],textarea\")?\"textbox\":null),\"role\"),n=s(i=>!!(o(i)||i.matches(\"input,select,textarea,[tabindex],[contenteditable]\")),\"interactable\");return document.elementsFromPoint(e.x,e.y).filter(i=>e.includeNonInteractable||n(i)).map(i=>{let a=i.getBoundingClientRect(),c=r(i),d=i.innerText?.trim()||i.value||null,l=i.getAttribute(\"aria-label\")||d;return{tagName:i.tagName.toLowerCase(),role:o(i),visibleText:d,ariaName:l,testId:i.getAttribute(\"data-testid\"),boundingBox:{x:a.x,y:a.y,width:a.width,height:a.height},preview:i.outerHTML.slice(0,300),selector:{primary:c[0]??null,candidates:c}}})}"

/** ZCode 原名 IH(overlayRuntime)的 fn.toString() 序列化字节。 */
export const OVERLAY_RUNTIME_FN_SOURCE = "function IH(e){let t=\"__zcode-playwright-element-screenshot-overlay\";if(document.getElementById(t)?.remove(),e.remove)return;let r=document.createElement(\"div\");r.id=t,r.style.cssText=\"position:fixed;inset:0;pointer-events:none;z-index:2147483647\";for(let n of document.elementsFromPoint(e.x,e.y)){let i=n.getBoundingClientRect(),a=document.createElement(\"div\");a.style.cssText=`position:absolute;left:${i.x}px;top:${i.y}px;width:${i.width}px;height:${i.height}px;border:2px solid #ff2d55;box-sizing:border-box`,r.append(a)}let o=document.createElement(\"div\");o.style.cssText=`position:absolute;left:${e.x-4}px;top:${e.y-4}px;width:8px;height:8px;border-radius:50%;background:#ff2d55`,r.append(o),document.documentElement.append(r)}"
