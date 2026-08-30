分析完成。全部切片与美化产物已保存至 `D:\tmp\zc-analysis\out\sidepane-q8\`（约 20 个 `.beauty.js` 文件）。以下为技术报告。

---

# ZCode Desktop 渲染进程 ↔ Host 传输协议与 fileWatcherService 深度分析报告

**分析对象**（字节偏移均为原始压缩文件内 `indexOf` 定位）：
- `D:\software\zcode\resources\app\out\host\chunk-KGXW6KHC.js`（18,076 B，协议栈：VSBuffer/ChunkStream/SocketProtocol/MessagePortProtocol/ChannelServer/ChannelClient/Proxy 适配器）
- `D:\software\zcode\resources\app\out\host\index.js`（2,271,864 B，host 进程主体）
- `D:\software\zcode\resources\app\out\host\chunk-YSDGIE3M.js`（91,335 B，ServiceCollection/通道描述符/zcode-agent 连接域）
- `D:\software\zcode\resources\app\out\host\chunk-EGJBTUMC.js`（575,291 B，共享常量枚举）
- `D:\software\zcode\resources\app\out\renderer\assets\src-C3so_Fno.js`（258,861 B，通道名/消息名常量）
- `D:\software\zcode\resources\app\out\renderer\assets\index-CKD0zXuV.js`（20,881 B，渲染进程引导/握手）
- `D:\software\zcode\resources\app\out\renderer\assets\styles-C2WGZ-SY.js`（4,584,754 B，渲染进程侧协议栈副本 + 会话注册表）

渲染进程侧在 `styles-C2WGZ-SY.js` 中有一份带**完整枚举名**的协议副本（host 走 KGXW6KHC），两者语义一致，是本报告枚举值命名的直接证据（@233,600 起）：

```js
vf = function(e){ return e[e.Promise=100]=`Promise`, e[e.PromiseCancel=101]=`PromiseCancel`,
      e[e.EventListen=102]=`EventListen`, e[e.EventDispose=103]=`EventDispose`, e }({}),
yf = function(e){ return e[e.Initialize=200]=`Initialize`, e[e.PromiseSuccess=201]=`PromiseSuccess`,
      e[e.PromiseError=202]=`PromiseError`, e[e.PromiseErrorObj=203]=`PromiseErrorObj`,
      e[e.EventFire=204]=`EventFire`, e }({}),
bf = function(e){ return e[e.Uninitialized=0]=`Uninitialized`, e[e.Idle=1]=`Idle`, e }(bf||{})
```

---

## 1. VSBuffer 与帧格式

### 1.1 VSBuffer 本体（KGXW6KHC @~1740，beauty L132-180）

VSBuffer 只是 `Uint8Array` 的轻封装（`alloc/wrap/fromString/concat/slice/readUInt8/writeUInt8/readUInt32BE/writeUInt32BE`），大端 32 位读写：

```js
readUInt32BE(e){ return (this.buffer[e]<<24 | this.buffer[e+1]<<16
                | this.buffer[e+2]<<8 | this.buffer[e+3]) >>> 0 }
writeUInt32BE(e,t){ this.buffer[t]=e>>>24&255, this.buffer[t+1]=e>>>16&255,
                this.buffer[t+2]=e>>>8&255, this.buffer[t+3]=e&255 }
```

### 1.2 两层组帧：传输帧 vs RPC 帧

**关键结论：renderer↔host 走 MessagePortProtocol，每个 `postMessage` 恰好承载一条完整 RPC 消息（裸 `Uint8Array`），13 字节传输帧头只存在于 SocketProtocol 路径（TCP/socket 类传输），在 MessagePort 线路上不出现。**

**传输帧（仅 SocketProtocol，KGXW6KHC @3932/@4213，beauty L236-259）**：定长头 `T = 13` 字节：

| 偏移 | 长度 | 字段 |
|---|---|---|
| 0 | 1 | type（UInt8，仅 type=1(Data) 会触发 `onMessage`） |
| 1 | 4 | id（UInt32BE） |
| 5 | 4 | ack（UInt32BE） |
| 9 | 4 | data 长度（UInt32BE） |
| 13 | n | data（VSBuffer） |

```js
function Y(n){ let e=h.alloc(T+n.data.byteLength);
  return e.writeUInt8(n.type,0), e.writeUInt32BE(n.id,1), e.writeUInt32BE(n.ack,5),
         e.writeUInt32BE(n.data.byteLength,9), e.set(n.data,T), e }
```
粘包/拆包由 `ChunkStream`（@2938）按 13 字节头中的长度字段重组；`ack` 心跳帧为 type=1 且 data 长度 0（`readMessages` 中 `i===0 && t===1` 时 fire 空 buffer）。

**MessagePortProtocol（KGXW6KHC @5491 / styles @233,935，beauty styles L9-27）**：无帧头，直接收发；同时内建流控消息识别：

```js
constructor(e){ this.port=e, this.handler=e=>{
    if(ffe(e.data)){ this._onFlowState.fire(e.data.state); return }
    e.data instanceof Uint8Array && this._onMessage.fire(sf.wrap(e.data))
  }, this.port.addEventListener(`message`,this.handler), this.port.start() }
send(e){ this.port.postMessage(e.buffer) }        // 发裸 Uint8Array
sendFlowState(e){ this.port.postMessage({__zcodeRpcControl:`connection-flow-v1`, state:e}) }
```
流控状态仅 `saturated` / `drained`（识别函数 `isMessagePortFlowControl`，KGXW6KHC @2820）。host 侧收到后经 `G7e` 转发给远程传输（见 §2.4）。

### 1.3 RPC 帧与 requestId 编组（KGXW6KHC @7322/@7636，beauty L536-542、L543-571）

RPC 层帧 = `serialize([type, id, channelName, name])` + `serialize(arg)` 两段拼接。**requestId 是头数组第二个元素**，由客户端单调递增分配（`lastRequestId++`，ChannelClient @11677 起），数值经 VQL 变长整数编码：

```js
sendRequest(e,t,s,r,i){ let o=new v; g(o,[e,t,s,r]), g(o,i);
  try{ this.protocol.send(o.buffer) } catch{} }   // e=消息类型, t=requestId
```

**值编码**（serialize/deserialize，标签字节 @6637）：

| 标签 | 类型 | 布局 |
|---|---|---|
| 0 | Undefined | 1 字节 |
| 1 | String | 标签 + VQL 变长长度 + UTF-8 字节 |
| 2 | Buffer(Uint8Array) | 标签 + 长度 + 字节 |
| 3 | VSBuffer | 标签 + 长度 + 字节 |
| 4 | Array | 标签 + VQL 元素数 + 逐元素递归 |
| 6 | Int | 标签 + VQL 变长整数 |
| 5 | Object | 标签 + 长度 + `JSON.stringify`（replacer 将嵌套 Uint8Array 转为 `{__zcode_rpc_nested_uint8array_v1:true, base64:...}`，@6726） |

**VQL 变长整数**（readIntVQL @6311 / writeInt32VQL @6524，beauty L368-389）：LEB128 无符号变体——每字节低 7 位按 7 的倍数位移累加，最高位 0x80 为继续位：

```js
function x(n){ let e=0;
  for(let t=0;;t+=7){ let s=n.read(1);
    if(e |= (s.buffer[0]&127)<<t, !(s.buffer[0]&128)) return e } }
```

---

## 2. ChannelServer / ChannelClient 握手与生命周期

### 2.1 通道常量与客户端组装（渲染进程）

`src-C3so_Fno.js` @230,114 起为服务通道名枚举（`fw`，export `xt`），@230,811 起为窗口消息名（`hw`，export `bt`）：

```js
FileWatcher:`file-watcher`, OAuth:`oauth`, ModelProvider:`model-provider`, ... // @230114
hw = { ServicePort:`zcode:service-port`,            // @230828
       ScopedServicePort:`zcode:scoped-service-port`,
       ScopedServicePortReady:`zcode:scoped-service-port-ready`,
       TaskNotificationSound:`zcode:task-notification-sound` }   // @230811
```
`index-CKD0zXuV.js` 中，`R(port)`（@5110）= `new MessagePortProtocol(port)` + `new ChannelClient(protocol)`，日志 `[messageport] creating protocol and client...`；`Ue` 类（@2503 起）为 35 个服务逐一生成代理：

```js
this.fileWatcherService = l.toService(e.getChannel(oe.channelName)), ...
// oe = {channelName:`file-watcher`}（styles @240031: Pfe=Tf(xo.FileWatcher)，Tf=e=>({channelName:e})）
```
`toService` Proxy（KGXW6KHC @17371，beauty L968-978）把方法访问映射为 RPC：`onXxx` → `s.listen(o)`（事件）、`onDynamicXxx` → `l=>s.listen(o,l)`（带参动态事件，`isDynamicEvent` @17633）、其余 → `s.call(o,[...])`。

### 2.2 握手

- **服务端**：`ChannelServer` 构造器（KGXW6KHC @8456，`s=1e3` 默认超时 1000ms，`r=!1` 为 deferInit）在非 deferInit 时**立即回送 hello**：

```js
constructor(e,t,s=1e3,r=!1){ ... this.deferInit||this.sendResponse({type:200}) }
ready(){ this.sendResponse({type:200}) }
```
- **客户端**：初始 `state=0`，收到 200 → `state=1` 并 fire `onDidInitialize`；所有 call/listen 先 `whenInitialized()` 排队（beauty L742-756）。渲染进程日志 `[messageport] ChannelClient received Initialize from server`。
- host 的 `exposeServicesOnMessagePort`（G7e，index.js @2259130）固定 `deferInit=false`：`J4(a,"host",1e3,n)`，且 `ya.expose` 是唯一调用点（@2260647 传 `!1`），因此 hello 总是构造即发。

### 2.3 请求/响应与超时

请求：100(call)/102(event-listen)；取消与事件退订：101/103（二者同路径 `disposeActiveRequest`）。响应：201(resolve)/202(结构化错误)/203(非 Error 拒绝)/204(event-fire)。错误对象序列化保留 `{message,name,stack[],code,data,detail,details,taskId,traceId}`（beauty L594-618）。

**未注册通道 1s 超时**（beauty L642-660，"Unknown channel" @10618）：

```js
collectPendingRequest(e){ let t=this.pendingRequests.get(e.channelName)??[]; ...
  let s=setTimeout(()=>{ console.error(`Unknown channel: ${e.channelName}`),
      e.type===100 && this.sendResponse({ id:e.id,
        data:{ name:"Unknown channel",
               message:`Channel name '${e.channelName}' timed out after ${this.timeoutDelay}ms`,
               stack:void 0 }, type:202 }) }, this.timeoutDelay);
  t.push({request:e, timer:s}) }
registerChannel(e,t){ this.channels.set(e,t), setTimeout(()=>this.flushPendingRequests(e),0) }
```
即：先到的请求按通道名缓冲，注册后下一 tick 重放；call 类超时回 202，listen 类仅打日志（客户端表现为永远等不到事件）。

### 2.4 连接生命周期 / 重连

- **无自动重连**。`ChannelClient.dispose(reason)`（beauty L813-821）将全部 pending 以 `ConnectionClosed` 拒绝并清空 activeRequests；`MessagePortProtocol.disconnect()` 移除监听并 `port.close()`。
- host 侧 `G7e` 返回句柄含统一 dispose：`e.once("close", () => $.dispose())`——port close 即级联释放（flow 转发器 → attachment 服务 → agent relay → ChannelServer → protocol disconnect）。主进程也可发 `attach-service-port` 枚举中的 `DetachServicePort`（EGJBTUMC @499631：`InitLocal/AttachServicePort/DetachServicePort/Dispose/...`）触发 `ya.detach(attachmentId)`（index.js @2269471）。
- **流控**：G7e 中 `a.onFlowState`（本地 MessagePortProtocol）→ `p.setTransportFlowState(state)`（逐 attachment 的 zcode-agent 连接域 `createZCodeAgentConnectionScope`，YSDGIE3M @47189，内部维护 `saturated/drained/closed` 每路由状态与 `enqueueTransportFlowState` 串行化）；dispose 时回发 `"closed"`。
- 渲染进程对基础端口**只接受一次**（`ut` 中 `e.data!==w.ServicePort||Z` 置位拒绝，index-CKD0zXuV.js @19800）；scoped 端口则每个新建独立 ChannelClient（§4）。

**Host 端口来源**（index.js @2268914 起）：host 是 Node utility process，经 parentPort 收 `{type:"attach-service-port"}` + 转移的 `MessagePortMain`；`rge`=wrapElectronPort（@2174120）把 EventEmitter 风格适配为 DOM MessagePort 风格（`on/off/postMessage/start/close`）。

### 2.5 服务端装配（G7e + ServiceCollection，index.js @2259130；YSDGIE3M @58015）

```js
function G7e(e,t,n,o=`desktop-continuous`,r={kind:`local`}){
  let i=rge(e), a=new xw(i);                       // wrapElectronPort + MessagePortProtocol
  let c=new J4(a,`host`,1e3,n), d=new Y4(c,Z7e), l=new e6(d);  // ChannelServer → Logging → Telemetry 装饰
  let u=t.getOptional(xr), p=u?UV(u,{connectionId:`host-rpc-${yl()}`,clientMode:o}):void 0;
  t.register(ST,Es.service);
  let f=Es.createAttachmentService(), h=new Map([[ST.channelName,f]]);
  let w=t.getOptional($n); w&&h.set($n.channelName,K7e(w,r));
  p&&h.set(xr.channelName,p.service);
  t.exposeOnChannelServer(l,h);                    // 逐通道 registerChannel(name, fromService(svc))
  ...
  return e.once(`close`,()=>$.dispose()), $ }
```
描述符来自 YSDGIE3M `u(o)=>({channelName:o})`（@497）：`ST`=WindowController、`$n`=ZCodeTask（经 K7e 代理按 `resolveTaskAddress({...,attachmentScope:r})` 路由任务变更，@2258028）、`xr`=ZCodeAgent（替换为连接域 relay）、`Zc`=FileWatcher。`ServiceCollection.exposeOnChannelServer(t, overrides)`（@58293）：

```js
exposeOnChannelServer(t,n=new Map){ for(let[r,i]of this._services){
  let c=n.get(r)??i; t.registerChannel(r, P.fromService(c)) } }
```
`fromService`（KGXW6KHC @17066）把普通服务对象适配为 `IServerChannel`：`on[A-Z]*` 缓存为事件（`bufferEvent` @17951 补发首订前事件），普通方法包 Promise。

---

## 3. fileWatcherService（host 实现）

**定义**：`Pj` = `createFileWatcherService`，index.js @1501063（名称标注 @1502607）；**基于 Node 原生 `fs.watch`**（`import{watch as eBe}from"fs"` @~1500104），**无 chokidar、无轮询/目录枚举兜底**，`recursive` 原样透传（win32/macOS 由 OS 原生支持；失败直接抛错）。防抖 `nBe = 150`ms（@1500930）。

**watch / 事件聚合**（@1501288，beauty 见 `host-filewatcher.1499800-1503300.beauty.js`）：

```js
async watch(i){ let a=String(o++), c=new Ye, d=i.recursive??!1, l;
  try{ l=eBe(i.path,{recursive:d},(u,p)=>{
      let f=n.get(a); if(!f) return;
      let h=rBe(f.path,p);                       // resolveFileWatchChangedPath: path.resolve(根, filename)
      h? f.pendingChangedPaths.add(h) : f.hasUnknownChangedPath=!0,
      f.debounceTimer&&clearTimeout(f.debounceTimer),
      f.debounceTimer=setTimeout(()=>{ f.debounceTimer=null;
        let w=!f.hasUnknownChangedPath&&f.pendingChangedPaths.size===1
              ? f.pendingChangedPaths.values().next().value : void 0;
        f.pendingChangedPaths.clear(), f.hasUnknownChangedPath=!1,
        f.changeEmitter.fire({dirPath:f.path, ...w?{changedPath:w}:{}})
      }, nBe) })
  }catch(u){ c.dispose(); let p=u instanceof Error?u.message:String(u);
    throw new Error(`无法监视目录 '${i.path}': ${p}`) }
```

- **watcher id 注册表**：`Map`，键为 `String(o++)` 单调递增计数器字符串；`watch({path,recursive})` → `{id}`。
- **事件语义**：150ms 防抖；窗口内只有一个已知变更路径 → `{dirPath, changedPath}`，否则（多条或 filename 未知）只发 `{dirPath}`。
- **错误路径**：`fs.watch` 同步抛错 → 释放 emitter 并抛中文错误 `无法监视目录 '...'`；异步 `error` 事件 → `warn` + 补发一条 `{dirPath}` + 自清理（相当于自动 unwatch）：

```js
l.on("error",u=>{ let p=n.get(a); p&&(t.warn(void 0,"文件监听器异常，清理 watcher",...),
  p.changeEmitter.fire({dirPath:p.path}), r(a)) })
```

- **unwatch/disposeAll**（@1502346/@1502360）：cleanup = 清防抖定时器 + `watcher.close()` + emitter dispose + Map 删除；`disposeAll` 遍历所有 id。
- **onDynamicChange(id)**（@1502433）：存在则返回事件流；watcher 已失效则 `warn("忽略已失效的文件监听订阅")` 并返回 `Event.None`。客户端用法（styles @277900 GitAutoRefresh）：

```js
s.watch({path:i.path, recursive:i.recursive}).then(({id:e})=>{ ...
  let i=s.onDynamicChange(e)(e=>{ r(e.dirPath) });
  n.push({subscription:i, unwatch:()=>s.unwatch({id:e})}) })
```

- **注册位置**：本地服务集 `.register(Zc, Pj())`（index.js @2171046，每次构建新实例）；远程工作区会话复用共享实例 `.register(Zc, e.connectionServices.fileWatcherService)`（@2181750、@2183385）。RPC 线路上 `onDynamicChange(id)` 经 isDynamicEvent 规则映射为 `listen("onDynamicChange", id)`（arg=id）。

---

## 4. ScopedServicePort：按会话/工作区的端口分域

**消息流**（Electron main 为经纪人，创建 MessageChannel 并两端分发：renderer 窗口收 `zcode:service-port` / `zcode:scoped-service-port`，host 收 `attach-service-port`）：

1. **基础端口**：`index-CKD0zXuV.js` `ut`（window message 监听 @19680，`addEventListener` 在文件尾）收到 `{data === 'zcode:service-port'}` + `e.ports[0]` → `J = Ge(port)` 建全量 35 服务（仅一次，`Z` 闸门 @19800）。
2. **Scoped 端口解析** `Qe`（@16704）：消息须为 `{type: ScopedServicePort, attachmentId, sessionId, target}` 且带 `ports[0]`，缺一即拒。host 侧对应 `ya.attach`（`createWindowHostAttachmentRegistry`，Mge @2199864）：`resolveScope(scope)` 决定服务集——`{kind:"local"}` → 本地服务集单例（generation=1）；`{kind:"remote", remoteSessionId}` → `Wn.resolveScopedServices(e)` + 会话 generation；再 `expose(...) → G7e(port, services, false, clientMode, scope)`；同 attachmentId 重复 attach 先 dispose 旧句柄，port `close` 事件自动回收。
3. **渲染进程包装** `Q`（@19255）：

```js
function Q(e){ if(!J) return;
  let t=R(e.port), n=t.services,                       // scoped 端口上新建独立 ChannelClient
      r=e.target.kind===`server` ? Ze(J,n) : Xe(J,n);  // server: 仅 scoped；否则合并
  Se({sessionId:e.sessionId, target:e.target, services:r,
      dispose: e=>t.dispose(e??Ce())}), $e(e) }
```
   - `Ze(e,t){return t}`：`target.kind==='server'` 时**整体替换**为基础端口服务之外的纯 scoped 服务。
   - `Xe`（@16011）：**18 个工作区相关服务取 scoped 端口版本，其余沿用窗口基础服务**：

```js
return {...e, fileService:t.fileService, gitService:t.gitService,
  gitCheckpointService:t.gitCheckpointService, systemService:t.systemService,
  terminalService:t.terminalService, promptAttachmentTransferService:t.promptAttachmentTransferService,
  zcodeAgentService:t.zcodeAgentService, zcodeTaskService:t.zcodeTaskService,
  zcodeSessionService:t.zcodeSessionService, fileWatcherService:t.fileWatcherService,
  skillsService:t.skillsService, skillSyncService:t.skillSyncService,
  mcpSyncService:t.mcpSyncService, pluginSyncService:t.pluginSyncService,
  pluginsService:t.pluginsService, pluginManagementService:t.pluginManagementService,
  commandsService:t.commandsService, repoWikiService:t.repoWikiService }
```
   （该清单与 host 端远程作用域必装清单 `NQe` @2179000 一致，`fileWatcherService` 在列。）
4. **会话注册表** `Se`（=gpe，styles @273450）写入 zustand store `$f`（@271800 起，beauty `styles-gpe-full.beauty.js`）：

```js
function gpe(e){ e.services.zcodeAgentService&&Yf(e.services.zcodeAgentService);
  let t=$f.getState().sessionsById[e.sessionId];
  t&&t!==e&&t.dispose?.(Zf()),            // 旧条目以 ZCODE_REMOTE_WORKSPACE_DISCONNECTED 释放
  $f.getState().registerSession(e) }      // sessionsById[sessionId] = {sessionId,target,services,dispose}
```
   store 另维护 `sessionIdByWorkspacePath` / `sessionIdByWorkspaceIdentity` 双向绑定（`bindWorkspacePath/bindWorkspaceIdentity/unbind...`）。
5. **workspaceKey 推导**：`Su(workspacePath, workspaceIdentity)`（styles @117767）→ `Goe`（skillStore-C5tahaKT.js @2195）：

```js
function y(e,t){ return t?.trim()||e }   // workspaceKey = workspaceIdentity?.trim() || workspacePath
```
   即**优先 workspaceIdentity，退化到 workspacePath**；任务级键再拼接 `::taskId`（`Cu(e)= workspaceKey + '::' + taskId`，styles @117787 附近）。解析器 `sp(e,t,n)`（styles @~273800 区域）按 `remoteSessionId → workspaceIdentity → workspacePath` 命中会话服务，未命中回落基础服务。
6. **就绪回执** `$e`（@17077）：注册完成后 `window.postMessage({type:'zcode:scoped-service-port-ready', attachmentId, sessionId}, '*')` 通知经纪人/webview。

---

## 关键结论速览

1. **线路格式**：renderer↔host 走 MessagePort，`postMessage` 每消息一条 RPC 帧（无 13B 传输头）；RPC 帧 = `[type,id,channelName,name]` + arg 两段 VQL/标签序列化；requestId 为 Int-varint。
2. **握手**：server 构造即发 200（deferInit 在生产路径恒为 false），client 未初始化前缓冲请求；未注册通道缓冲 1s 后 call 回 202、listen 静默；注册后微任务重放。
3. **fileWatcherService**：Node `fs.watch` + `{recursive}` 透传、150ms 防抖、`String(counter++)` id 注册表、单变更路径时附带 `changedPath`、error 事件自清理并补发一次事件、无第三方库与平台兜底。
4. **ScopedServicePort**：每 attachment 独立 MessagePort/ChannelClient；`target.kind==='server'` 全量替换，否则 18 个工作区服务按 scoped 覆盖基础服务；workspaceKey = `workspaceIdentity?.trim() || workspacePath`；会话注册表按 sessionId 存储并在重注册时以 DISCONNECTED 错误释放旧条目。
5. **无重连**：port close → host `once("close")` 级联 dispose / renderer dispose 全部 pending；恢复只能靠经纪人重新 attach。

**遗留风险/未深挖**：`ya.attach` 的 `waitForScopedServices`（remote 会话就绪屏障）内部细节、`K7e` 依赖的 `Es.resolveTaskAddress` 寻址算法、以及 Electron main 侧经纪人代码（不在本次目标文件内）未展开。