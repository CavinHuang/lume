# ZCode 桌面端 Chat Composer 与侧面板集成 — 深度技术报告

分析对象:`D:\software\zcode\resources\app\out\renderer\assets\styles-C2WGZ-SY.js`(4,584,754 字符)、`catalogTree-D7q4FnnV.js`(654,733)、`skillStore-C5tahaKT.js`(43,819)、`imeComposition-DbZxs-Pr.js`(11,035)、`WikiReferenceSidePane-D4JOTihA.js`(11,048)。以下偏移量均为**原始压缩文件的字节偏移**；beautified 产物已存至 `D:\tmp\zc-analysis\out\sidepane-q12\`。

**关键前提：跨 chunk import 绑定**(styles @65972 / @58672-60903)。`zcode:add-whiteboard-to-chat` 字面量不在 styles 中，而在共享 chunk skillStore 里，经 import 别名进入 composer:

```js
// styles @65972 附近(import 自 skillStore):
//   l as Ro, m as tse, s as ise, u as ase, o as zo …
// styles @58672-60903(import 自 catalogTree):
//   i as Jn, n as _r, o as Sr, r as Ir
```

对应关系(已逐一验证)：
| styles 别名 | 来源 chunk 导出 | 本体 |
|---|---|---|
| `ise` | skillStore `s` | `mn` = `zcode:add-whiteboard-to-chat`(@31594) |
| `tse` / `Ro` | skillStore `m` / `l` | `Cn` 事件守卫(@33288)/ `K` workspace 规整键 |
| `ase` | skillStore `u` | `Sn` board→PNG File(@33024) |
| `zo` | skillStore `o` | `On` 白板 zustand store(含 `getBoard`) |
| `_r` / `Sr` / `Ir` / `Jn` | catalogTree `n`/`o`/`r`/`i` | `jR`=`zcode:add-wiki-to-chat`(@650075)/ `PR` 守卫(@650305)/ `MR` 规整键(@650107)/ `FR` markdown→File(@650425) |

---

## 1. Composer 的 window 事件监听注册表

Composer 侧(含其子 hook)共消费 **9 个 window CustomEvent 类型**。核心注册点在 v4-composer 附件控制器 hook `VNe`(@902792)及后续三个 hook:

```js
// styles @912499 与 @912756(VNe 内,白板+wiki,受特性开关 d 约束)
(0,Q.useEffect)(()=>{if(!d||typeof window>`u`)return;
  let e=e=>{tse(e)&&Ro(e.detail)===Ro({workspacePath:t,workspaceIdentity:n})
           &&(e.preventDefault(),se(e.detail.boardId))};
  return window.addEventListener(ise,e),()=>window.removeEventListener(ise,e)
},[se,d,n,t]),
(0,Q.useEffect)(()=>{if(!d||typeof window>`u`)return;
  let e=e=>{Sr(e)&&Ir(e.detail)===Ir({workspacePath:t,workspaceIdentity:n})
           &&(e.preventDefault(),B([Jn(e.detail)]))};
  return window.addEventListener(_r,e),()=>window.removeEventListener(_r,e)
},[B,d,n,t]);
```

| # | 事件类型 | 定义处 | 监听处 | 消费方 hook |
|---|---|---|---|---|
| 1 | `zcode:add-whiteboard-to-chat` | skillStore @31594 | @912499 | `VNe`(@902792) |
| 2 | `zcode:add-wiki-to-chat` | catalogTree @650075 | @912756 | `VNe` |
| 3/4 | `zcode:code-comment-add-to-chat` / `-remove-` | styles @918886/918922 | @929794/929824 | 代码评论 chip hook |
| 5/6 | `zcode:web-element-context-add-to-chat` / `-remove-` | styles @923923/923966 | @930972/931002 | `CPe`(@930321) |
| 7 | `zcode:pptx-element-reference-add-to-chat` | imeComposition @5944 | @931707 | `wPe`(@931204) |
| 8 | `zcode:add-workspace-file-to-chat` | styles @577005 | @1376859 | v4 发送区组件 |
| 9 | `zcode:workspace-file-drag-state`(通知) | styles @577043 | @876710 | `kk` 拖拽遮罩(@876106) |
| 10 | `zcode:conversation-selection-add`(通知) | styles @211447 | @935503 | `DPe`(@935076) |

**消费契约(cancelable + preventDefault)** 分三档严格度：

- **wiki / whiteboard**:cancelable 派发；composer 无条件 `preventDefault()` 表示“已消费”。守卫 = 类型检查(且 `instanceof CustomEvent`)+ detail 校验 + **workspace 匹配**(把 detail 的 `{workspacePath,workspaceIdentity}` 与 composer 自己的做 `trim||path` 规整后全等比较)。
- **code-comment(最严格)**：双重防重入检查——
```js
// styles @929794
let t=e=>{if(!KNe(e)||!PA(e.detail)||e.defaultPrevented||!e.cancelable
          ||(e.preventDefault(),!e.defaultPrevented))return;
  let t={...e.detail,id:e.detail.id??yPe()}, ... // 合并/去重 chip,随后 requestFocus
```
- **web-element / pptx**:只做类型+scope 匹配(pptx 额外比对 `remoteSessionId`),`preventDefault()` 但**不要求 cancelable**(两者派发端 `_Pe`/`Ee` 均非 cancelable);workspace-file 与两个通知类事件同样是弱契约(仅 type 检查)。

---

## 2. 附件插入路径：File 附件 vs 文本插入 vs 上下文 chip

**(a) File 附件路径(wiki、白板)** — 汇合到 `B`(@909235)→ `z`(@908417):

```js
// styles @908417
let z=(0,Q.useCallback)(e=>{if(e.length===0)return;
  let t=8-bA(h).length;               // 上限 8 个附件
  ...
  uploadStatus:t?`ready`:r?.sessionId?`queued`:`waitingSession`, ... // 本地 zero-copy ready
  N(h,e=>[...e,...i]); ...},[N,F,m,h]),
B=(0,Q.useCallback)(e=>{z(e.map(e=>{let t;
  try{let n=f.getPathForFile?.(e);t=n?.trim()?n:void 0} ...   // Electron 本地路径
  return pNe(e,t)}))},[z,f]);
```

白板转 PNG 的实现在 skillStore(@32819-33414):`xn` 离屏 canvas `toDataURL('image/png')` → `Sn` base64 解码为 `Uint8Array` → `new File([i], name.png, {type:'image/png'})`。wiki 则由 `FR`(@650425)打包 `new File([markdown], title.md, {type:'text/markdown'})`。

**(b) 文本插入路径(workspace file)** — 唯一走“输入框文本”的事件，@1376859 监听后调 `Ok`:

```js
// styles @875671
function Ok(e){let t=ETe(e.payload,e.workspacePath,e.workspaceIdentity),
  n=e.currentMarkdown.length>0&&!/\s$/.test(e.currentMarkdown)?` `:``,
  r=`${e.currentMarkdown}${n}${t.markdown} `;
  return e.onTextChange(r),
    e.inputApiRef.current?.appendFileMention(e.payload.name,t.value,t.markdown,t.data),
    e.inputApiRef.current?.focus(), r}
```
`ETe`(@577825 附近)按 `TTe` workspace 精确匹配决定用 `relativePath` 还是全路径，生成 markdown 链接。

**(c) 上下文 chip 路径(code-comment / web-element / pptx / 会话选区)** — 平时不进文本，**发送时统一序列化**：

```js
// styles @928094 — 发送组合管线
function qA(e,t){return Vce(                       // # Presentation element comments:
  fPe(XNe(Kde(e,t.conversationSelections),          // # userselect: → # Code comments:
    t.codeComments),t.webElements),                 // # Web page elements:
  t.pptxElements)}
// @928218 — 反向解析(恢复 chip):vPe → {visibleContent, codeComments, …, pptxElements}
```
各 block 生成器:`Kde`(@212406,`# userselect:`)、`XNe`(@920507,`# Code comments:` + `## Comment N/File/Lines/Selected text/Comment`)、`fPe`(@926045,`# Web page elements:`,每字段 8000 字符截断 `zA=8e3`)、`Vce`(imeComposition `Ce`,`# Presentation element comments:` + sha256 指纹)。web-element 有独立的块解析器 `gPe`(@927838 附近)。

---

## 3. @-mention 系统

输入编辑器为 **Lexical**(`FMe` @873090,即 `LexicalChatInput`),mention 面板为 `nMe`(@855200)。触发符三种:`@`、`$`(skills)、`#`(sessions)。**类别→触发符映射** `pje`(@824792):

```js
var uje=[`plugins`,`files`,`sessions`,`whiteboards`],dje=[`sessions`],fje=[`skills`];
function pje(e){return e===`@`?uje:e===`#`?dje:e===`$`?fje:[]}
function mje(e){return e===`#`?`same-authority-workspaces`:`current-workspace`}
```

五个数据源 hook(beautified `q12-mention-dropdown.beau.js`,原文 @854313-855200):
- **files**:`Tje`(工作区文件搜索，空查询 limit 3 / 有查询 10)
- **plugins**:`kje`
- **sessions(agents)**:`Qje`(@854337 前段)——经 agent service 枚举，`current-workspace` 或 `Zje` 跨 tab+远端会话聚合；**注意类别名叫 sessions,实际列出的是 agents/子代理会话，无浏览器 tab**
- **skills**:`xAe`(`$` 触发)
- **whiteboards**:`eMe`(@854538)读白板 store + `$je` 映射：

```js
// styles @854313
function $je(e){return e.map(e=>({id:`whiteboard:${e.id}`,category:`whiteboards`,
  label:e.name,description:`${e.strokes.length}`,value:e.id,markdown:`@${e.name}`,
  keywords:[e.name,e.id],data:{boardId:e.id,kind:`whiteboard`}}))}
```

**选中行为分叉**(`nMe` 内 `N` 回调)：白板项走特殊分支——从 Lexical 删除 `@query` 文本、**不插入 mention 节点**，改调 `onWhiteboardMentionSelected(boardId)`;该回调在 `VNe` 中即 `ce`(@915650)= `se` → `getBoard` → `B([ase(board)])`,**与 `zcode:add-whiteboard-to-chat` 窗口事件汇合到同一条 PNG-File 附件路径**。其余类别插入 Lexical mention 节点 `OO({id,category,label,value,markdown,description,data})` + 空格。渲染上白板行显示笔划数(intl id `chat.mention.whiteboards.strokeCount`)。

---

## 4. browserNavigationRequest → composer?

**结论：纯 shell→浏览器面板的 React props 通道，composer 完全不参与，也不是 window 事件。** styles 中 6 处命中全部是工作区壳层装配链：@227831(shell hook 返回值)、@3800737(侧面板容器 `yAt` 的 props)、@3832080/@3846775/@3896981(壳层渲染 props 透传)、@3883849(壳层 hook 解构)。

生产者 `handleOpenBrowserUrl`(shell hook 内 `z`,@216208):

```js
z=(0,Q.useCallback)(e=>{
  if(!u){window.open(e,`_blank`,`noopener,noreferrer`);return}   // 无内嵌浏览器→系统浏览器
  let n=`browser:${io()}`;
  w({id:io(),targetTabId:n,url:e}),b(!1),                        // setState: {id,targetTabId,url}
  J.info(`[App] 切换右侧面板 mode=browser workspace=${t} url=${e}`),
  P(t=>_d(t,{tabId:n,initialUrl:e}))},[P,u,t])                   // 新建 browser tab 并展开侧栏
```

消费者在 `yAt`(@3815995)——按 `targetTabId` 路由到对应浏览器面板实例：

```js
navigationRequest:_?.targetTabId===i.id?{id:_.id,url:_.url}:null,
onNavigationRequestHandled:ae
```

即：URL 导航是“shell state → 浏览器 surface”的定向投递，与 composer 的窗口事件体系无交集。

**补充**：terminal 面板经 `onOpenBrowserUrl: te` 回调(同一 shell 路径)打开 URL,亦不经过 composer。

---

## 附：产出文件清单(D:\tmp\zc-analysis\out\sidepane-q12\)

`skillStore-C5tahaKT.beau.js`(白板事件/store/Sn 完整实现)、`imeComposition-DbZxs-Pr.beau.js`(pptx 引用事件+序列化/解析)、`WikiReferenceSidePane-D4JOTihA.beau.js`(wiki 派发端，@203 处 `a({...})||toast`)、`q12-composer-attach.beau.js`(VNe 附件区)、`q12-codecomment-webelem-listeners.beau.js`、`q12-mention-dropdown.beau.js`(nMe 全文)、`q12-codecomment-serialize.beau.js`、`q12-webelem-block-builder.beau.js`、`q12-workspacefile-module.beau.js`、`q12-workspacefile-insert.beau.js`、`q12-browsernav-shell.beau.js` 及对应 `.orig.js`。

**分析方法的局限**：白板事件名因 rollup 跨 chunk 导出而无法用字面量锚定，是通过枚举全部 2681 个 chunk 中 `to-chat` 模式(skillStore 唯一命中)+ styles 顶部 import 别名表回推的；报告中的偏移量为 UTF-16 索引，引文区域均为 ASCII,字节偏移一致。