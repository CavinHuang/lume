All analysis artifacts are saved under `D:\tmp\zc-analysis\out\sidepane-q3\` (Q1/Q2 = 生成面板， Q3/Q4 = SidePane 壳， H1–H4 = host 服务端， plus probes). Below is the technical report.

---

# ZCode RepoWiki 生成面板(`l2`)逆向报告

**分析对象**:`D:\software\zcode\resources\app\out\renderer\assets\styles-C2WGZ-SY.js`(渲染端，4.6MB)、`out\host\index.js`(服务端实现)、`src-C3so_Fno.js`(协议/常量)、`catalogTree-D7q4FnnV.js`(共享谓词/树构建)。
**产物**:`D:\tmp\zc-analysis\out\sidepane-q3\{Q1,Q2,Q3,Q4,H1-H4}.*.js` + probes。以下偏移均为对应文件内的字节偏移。

---

## 1. 生成面板 UI(`l2`,styles@2560888)

`l2` 即 RepoWiki 生成面板(“仓库 Wiki”),SidePane 的 `repo-wiki` tab **内联渲染**(与懒加载的 wiki-reference 消费面板不同)：

```js
// styles@3814882(SidePane tab 内容分发)
i.type===`repo-wiki`?(0,$.jsx)(l2,{workspacePath:c,workspaceIdentity:l,
  remoteSessionId:u,onOpenCodeViewer:ne})
  :i.type===`wiki-reference`?(0,$.jsx)(Q.Suspense,{fallback:...,
  children:(0,$.jsx)(mAt,{workspacePath:c,workspaceIdentity:l})})
```

另有**主区域全页模式**两处挂载(styles@3849943、@3859485):`n==='repo-wiki'` 时渲染 `l2` 且带 `onBack`/`workspaceTabs`(多项目)；由标题栏 `onOpenRepoWiki`(styles@3261945,`repoWikiActive:n==='repo-wiki'`)触发。tab 工厂 `Gue()`(styles@196543):`{id:'repo-wiki',type:'repo-wiki',openedAt}`;`tde` 单例集合(styles@200176)使 git/repo-wiki/developer-tools/treemapping 四类 tab 跨任务常驻。

### 1.1 生成选项(空态卡片 `Mlt`@2587521 + 头部工具条)

每 workspaceKey 一份设置，存于 zustand store `vlt.generationSettingsByWorkspaceKey`;默认值工厂 `h2`(styles@2599966):

```js
// styles@2599966
function h2(e,t,n){return{modelValue:e,modelTouched:!1,language:t,
  languageTouched:!1,maxRetries:s2 /*=3*/,modelRequestTimeoutSeconds:c2 /*=900*/,
  generateDiagrams:n,diagramsTouched:!1,thoughtLevel:void 0,thoughtLevelTouched:!1}}
```

- **语言** `lr` Select:`zh-CN`/`en-US`(`Dut` 归一化)；
- **模型** `EL` ModelSelector,选项来自 workspace configOptions(先经 `_lt`@Q1-221 预热:`syncProviderRegistry → resolveRuntimeModelForV4 → prepareDraftSession(createDraftSession)` 拿 configOptions/slashCommands 写入 workspace store,再 `closeDeferredDraftSession` 清理；去重签名 `Blt`);
- **思考等级** `nz`(仅当模型支持 `modelThoughtLevels`);
- **maxRetries** number input 0–5(`v2` clamp,默认 3)、**模型超时** 60–3600s step 30(默认 900s);
- **generateDiagrams** Switch(“按内容需要生成架构图、流程图、时序图和状态图”)。

testid 常量(src@226767):`repo-wiki-generate-button`/`-delete-button`/`-delete-confirm-button`/`-regenerate-button`/`-model-select-trigger`/`-empty-model-select-trigger`/`-max-retries-input`/`-timeout-input`/`-catalog-node`/`-project`。

### 1.2 状态谓词与按钮门控

```js
// styles@2603606 —— 任务进行中谓词(即题述 wR 的对偶)
function y2(e){return e?.status===`pending`||e?.status===`running`}
// styles@2560888 内:
G=y2(he),                    // 任务运行中
Le=G||De||!Ie||d,            // 设置禁用 = 运行中 || 模型切换 pending || summary 未加载 || settings loading
_e=!!(U&&(me||ge)&&!G),      // 显示“删除”:有 publishedWiki 或 (draft+任务失败/取消) 且未运行
ve=!!(U&&(me||ge)&&!G)       // 显示“重新生成”:同条件
```

- `p2(wiki,draft,task)`(styles@2599xxx):task 为 running/failed/cancelled 时展示 **draft**,否则 `wiki ?? draft`;
- `Wlt(draft,task)`:draft 可见 = task failed/cancelled。

### 1.3 Generate 流程(乐观本地 pending)

```js
// styles@2572383(rt 回调)
let r=Date.now(),i=Ult(r);         // taskId = `local-pending:${Date.now()}`
S(e=>{...n.set(t.workspaceKey,Hlt({...taskId:i,now:r}))...}),  // 乐观置 pending
J.info(`[RepoWikiPane] Wiki 生成已进入本地等待状态`,...),
c.generate({...n,language:ze.language,force:e,...hut(Be),   // hut@2603171 → {modelProviderId,modelName}
  maxRetries:v2(ze.maxRetries),modelRequestTimeoutSeconds:...,
  generateDiagrams:ze.generateDiagrams,thoughtLevel:...})
 .then(()=>c.readSummary(n))       // 返回后拉 summary 同步
 .catch(e=>{...若仍是本地 pending 任务→改写为 {phase:'error',status:'failed',error:n}...})
```

`Hlt`(styles@2598165)生成本地占位任务 `{phase:'preparing',status:'pending',completedPages:0,failedPages:0}`;`De`(modelSwitchPending)时直接跳过生成并打日志。**生成与重新生成均 `force:!0`**。

### 1.4 Stop / Delete / 补齐失败页

```js
// styles@2573542 it()
!U||!G||(J.info(`[RepoWikiPane] 用户停止 Wiki 生成`,{...,taskId:he?.taskId}),
  c.cancel({workspacePath:U.workspacePath,workspaceIdentity:U.workspaceIdentity}))
// styles@2576589 删除(AlertDialog 二次确认 vne)
let e=U&&(U.publishedWiki||Wlt(U.draft,U.task))&&!G;
...c.delete({workspacePath:t.workspacePath,...}).catch(...J.warn(`[RepoWikiPane] 删除项目 Wiki 失败`...))
// styles@2573869 失败页补齐 at()
c.regenerateFailedPages({...t,maxRetries:v2(n.maxRetries),modelRequestTimeoutSeconds:n.modelRequestTimeoutSeconds})
  .then(()=>c.readSummary(t))...
```

### 1.5 进度与错误呈现

- `Olt`(@2581369,顶部 banner):wiki.context.name、运行中显示 Stop 按钮、`<details>` 元数据(defaultBranch/language/updatedAt/commitHash 前 12 位/fileCount),未完成时嵌 `Flt`;
- `Flt`(@2594759):`completedPages/totalPages` 计数 + 百分比进度条 + `currentPage` + error(destructive)+ retryableHint(warning);完成且 `phase==='done'` 时返回 null;
- `Ilt`(@2596304):failed→`repoWiki.statusFailed`,cancelled→`statusCancelled`,否则 `repoWiki.phase.${phase}`;
- phase 文案(IntlProvider@27169):`preparing 正在分析代码库 / catalog 正在生成目录 / pages 正在生成页面 / saving 正在保存 Wiki / done Wiki 已生成 / error Wiki 生成失败`;
- `Plt`(@2594090):`status==='completed' && failedPages>0` 时显示“{count} 个页面生成失败，可单独补齐而不重跑全部。”+ 补齐按钮(运行中 disabled);
- `jlt`(@2585xxx,项目树)中:`error` 在“非 completed-with-failedPages”时以 destructive 文本显示;`retryableHint` 独立 warning 框(服务端文案：“模型输出偶发异常，建议将重试次数调到至少 2 次后重试，或更换模型。”)；
- 页面级：目录节点按 `generatedPageIds` 判断未生成页(`repoWiki.pageGenerating 正在生成` / `pagePending 等待生成`),选中未生成页显示 `Nlt`(@2593469)占位卡；
- 分帧渲染 `klt`:markdown 按空行/围栏切块(每块 ≤8000 字符 `Clt`,首帧 ≥12000 字符 `wlt`,每帧 +2 块 `Tlt`),perf 日志 `[RepoWikiPane][perf]`。

## 2. repoWikiService RPC 全貌与生成执行位置

### 2.1 通道与客户端

- 通道注册表(src@230588):`ServiceChannelName = {..., RepoWiki:'repo-wiki', ...}`;
- 渲染端客户端(index-CKD0zXuV.js@2395):`this.repoWikiService=l.toService(e.getChannel(ke.channelName))` —— 通用 service-port 代理(ScopedServicePort 按 workspace 派发)；
- host 端经 `createRemoteRepoWikiServiceRelay`(`pge`,host@2185304)挂到通道 `Hc`,**方法集即完整 RPC 面**：

```js
// host/index.js(pge relay,beau H4:114-125)
onDidChangeRepoWiki /* 引用计数事件转发 */,
read, readSummary, readPage, readPages,
generate, regenerateFailedPages,
captureTaskCompleteUpdate, refreshExistingWikiAfterTaskComplete,
cancel, delete
```

事件 `onDidChangeRepoWiki` 载荷 `{workspaceKey, wiki, draft, task}`,每次 task 写盘/删除后由 `emitWorkspace` 触发(host@2009383 `onDidChangeRepoWiki:o.event`)。另有广播消息 `repo-wiki-running-task-count-changed`(src@205889),由 `reportRunningTaskCount`(host@1994147)在任务表增减时上报。

### 2.2 生成在哪跑：host 进程 + agent 专用 lane,**不是 sidecar,也不是 agent tool**

host/index.js@2169593:

```js
at=CG({modelGenerator:e?.repoWikiModelGenerator??{async generateText(me){
      return await rt.generateWorkspaceText({...me,agentLane:"repo-wiki"})}},
  repoSnapshotSidecar:j, runningTaskReporter:e?.repoWikiTaskReporter,
  runtimeReleaser:{async disposeRepoWikiRuntime(me){await rt.disposeRepoWikiRuntime(me)}},
  storage:$, currentModelProvider:..., workspaceProviderRegistry:Nme(...)})
```

`RepoWikiModelClient`(host H2 `PR`)把 prompt 封装为 `generateWorkspaceText({modelRef:{providerId,modelId,variant:thoughtLevel}, querySource:'repo_wiki_catalog|repo_wiki_catalog_tools|repo_wiki_page|repo_wiki_page_tools', maxOutputTokens, requestTimeoutMs})` 走 **zcodeAgentService 的 workspace 文本生成，固定 `agentLane:"repo-wiki"`**(闲置后 `disposeRepoWikiRuntime` 回收 lane)。所有 workspace 读取都在 host 本地(`Kp=LocalWorkspaceRepoReader`:文件枚举+.gitignore+私有文件过滤+symlink 拒绝+路径越界校验+manifestHash v2)。sidecar 只用于快照采集(`captureRepoWikiSnapshot → repoSnapshotSidecar.captureBeforePrompt`,失败仅 debug "Wiki 生成 sidecar 已跳过”)。

生成流水线(`runGenerate`,host@1995065):写 task.json(status running)→ 读 overview(缓存)→ `manifestHash` 未变且语言/思考等级未变则**直接跳过置 completed**→ 解析模型配置 → phase `catalog`(带重试 `G8e`:截断 `Ui` 一次性提高 maxOutputTokens 16384→32768,其余错误按 maxRetries 重试)→ 写 draft(draft.json + 逐页 draft-pages)→ phase `pages` 循环(`gfe` 每页 8192→16384 截断重试)→ phase `saving` → 合并 draft 页 `q8e` → `writeWiki` → `done/completed`(failedPages=缺失数)。

目录/页面生成本身是两段式 **tool-use LLM 调用**(`RepoWikiGenerator` host@1981472):catalog 最多 6 轮、每轮 3 个、共 12 次 `get_dir_structure`/`view_file_in_detail` 工具调用(结果预算 64KB),超限后压缩证据出最终 JSON;page 最多 5 轮/共 8 次(预算 56KB),兜底 `requestCompactPageFinal`;目录 JSON 解析失败可回退纯 prompt 生成，候选页经 `normalizeRepoWikiCatalog` 校验(filePaths 必须真实存在、每页须有“主源码证据”路径、上限 60 页)。

任务生命周期治理：内存 `runningTasks` Map(AbortController);`cancel` abort 并写 `status:'cancelled'`;`readValidatedTask` 发现 task.json 为 running 但无内存态(进程重启)→ 补写 cancelled + “上次 Wiki 生成在应用关闭或进程退出时中断，已停止。”;`disposeAllAndWait` 退出时全部 abort;`refreshExistingWikiAfterTaskComplete`(host@2003361)在 agent 任务完成后对比 manifestHash,变了就 **force:false 自动增量重生成**;`delete` 在运行中直接抛错。E2E fixture:`ZCODE_E2E_REPO_WIKI_GENERATION_FIXTURE=1`(host@2193516 起)。

## 3. Wiki 数据模型与持久化

### 3.1 存储(host@1991338-1991344)

```
<数据根>/.zcode/v2/repo-wiki/<sha256(workspaceKey).slice(0,12)>/
  ├ wiki.json      // 已发布 Wiki(含全文页)
  ├ task.json      // 最近任务状态
  ├ draft.json     // 生成中草稿(页摘要+generatedPageIds)
  └ draft-pages/<sha256(pageId).slice(0,16)>.json  // 草稿单页全文
```

`workspaceKey = workspaceIdentity?.trim() || workspacePath`(chunk-EGJBTUMC@570109 `buildRepoWikiWorkspaceKey`;渲染端同源 `eo`)。该目录在日志导出排除列表内(host@1916305 `hXe`)。

### 3.2 结构

- **Wiki/Draft 公共字段**:`{wikiId, repoId, workspaceKey, workspacePath, workspaceIdentity, language('zh-CN'|'en-US'), generationModel:{providerId,providerName,modelName}, generationOptions:{generateDiagrams,thoughtLevel?}, manifestHash, context:{name,rootPath,defaultBranch,commitHash,commitTime,fileCount,languageStats,readme}, catalogTree, pages, createdAt, updatedAt}`;draft 额外有 `taskId` 与 `generatedPageIds[]`(增量补齐进度)；
- **catalogTree**:`[{id, title, order, pageId?, children?}]` — 分组节点无 pageId,叶子持 pageId;渲染端 `Gr`(=catalogTree chunk `LR`@650772)在缺失时按 `parentId` 聚组或按 `order` 摊平；
- **页摘要**(readSummary 返回，host `toRepoWikiSummary` 剥掉 markdown):`{id, parentId, title, order, description?, filePaths[]}`;
- **页全文**(`vG=buildRepoWikiPage`):摘要 + `markdown` + `sources:[{path,startLine:1}]`;markdown 保证以 `Sources: [path](path#L1-L80)` 结尾(模型未给则自动追加，取前 5 个 filePaths);
- `readPage = readWikiPage(wiki.json) ?? readDraftPage(draft-pages)`;`readPages` 批量(并发 4,服务 wiki-reference 引用)。

## 4. 对 wiki-reference 入口的完成门控

SidePane 壳 `yAt`(styles@3794xxx)在可见时用同一个服务探测完成态：

```js
// styles@3801741
he=e.repoWikiService,
[G,ge]=(0,Q.useState)(!1);            // hasCompletedWiki
(0,Q.useEffect)(()=>{ if(!eAt({isSidePaneVisible:r})){ge(!1);return}
  let t=t=>{e||ge(Nn({wiki:t.wiki,draft:t.draft,task:t.task}))};
  he.readSummary({workspacePath:c,workspaceIdentity:l}).then(t).catch(...debug `隐藏 Wiki 引用入口`...);
  let n=he.onDidChangeRepoWiki(e=>{e.workspaceKey===me&&t(e)});
  ...},[r,he,c,l,me])
```

`Nn` 即 catalogTree chunk 导出的 `wR`(styles 从 `./catalogTree-D7q4FnnV.js` 以 `f as Nn` 导入；chunk@648452):

```js
// catalogTree-D7q4FnnV.js@648452
function wR(e){return e.wiki?!(e.task?.status===`pending`||e.task?.status===`running`):!1}
```

门控谓词(styles@3796544)：

```js
function $kt({activeTaskId:e,hasCompletedWiki:t,isMobileTextInputViewport:n,mobileOverlay:r}){
  return !!(e && t && !r && !n)}
```

`qe=$kt(...)` 决定 "+ tab" 下拉里的 **`wiki-reference` 菜单项**(styles@3807324 起 `it=Zkt({canOpenWikiReference:qe,...})` 排序)，即：**必须有活跃任务(activeTaskId)+ 该 workspace 的 wiki 存在且无 pending/running 任务**(只认 published wiki —— draft 不算，`e.wiki` 只在 wiki.json 存在时为真)+ 非移动端浮层。消费面板本体懒加载 `./WikiReferenceSidePane-D4JOTihA.js`(styles@Q3:208),tab id 为 `wiki-reference:${encodeURIComponent(ownerTaskId)}`(styles@196618),按任务隔离(与 repo-wiki 单例常驻相反)。

---

### 风险/备注
- 渲染端 `readSummary` 有 10s 节流去抖(`Slt`),事件到达才清；失败时以空态落盘(loaded:true),下次重进恢复。
- 渲染端所有主动生成/重生成均 `force:true`,会无视 manifestHash 短路；自动刷新链路(task_complete)才用 `force:false`。
- `generate()` RPC resolve 只代表任务已被 host 接管(或复用进行中任务返回其 task.json),真实完成靠 `onDidChangeRepoWiki` 事件推进 UI。