# 浏览器对齐 ZCode 实现 —— 前置清理计划

> 目标:让 Lume 右侧面板浏览器对齐 ZCode IAB 的实现(驻留状态机/截图表面协议/录像/自由视口/操作事件)。
> 本计划只解决**对齐动工前必须先清理的东西**,避免后续每个对齐 PR 都在修同一批地基问题、或破坏 sidecar↔main 与 renderer↔main 两条桥。
> 结论先行:**Lume 已是 ZCode 同型架构**(renderer `<webview>` + 主进程 BrowserRuntime 唯一权威 + `webContents.debugger` CDP + mountToken 挂载授权 + iab/extension 双后端 registry)。对齐是补差,不是重写。

## 0. 现状与 ZCode 的对齐差距总览

| 能力 | ZCode | Lume 现状 | 差距定性 |
|---|---|---|---|
| tab 宿主 | renderer `<webview partition>` | 相同(webviewTag:true + will-attach 加固) | ✅ 无 |
| 状态权威 | BrowserGuestManager(46 命令) | BrowserRuntime dispatch(45 命令) | ✅ 同型 |
| guest 挂载 | attachGuest + residencyGeneration | mountToken grant + sync ack + generation | ✅ 同型 |
| CDP 自动化 | 自研 playwright-over-CDP + 隔离世界 | browser-cdp-input/locator/semantic-snapshot + createIsolatedWorld | ✅ 同型(实现细节不同) |
| 能力协商 | apiSupportOverrides + capability | BROWSER_API_REGISTRY + browserApiSupportForBackend(iab/extension) | ✅ 同型(Lume 多 extension 后端) |
| tab 租约 | claimTab/markDeliverable/markHandoff | agentLease/handoff/share/unshare | ✅ 同型 |
| 下载 | 队列+等待 | 配额+台账+磁盘 GC(更强) | ✅ Lume 更强 |
| **驻留状态机** | live-visible/background/suspend-pending/restoring/suspended + generation 跃迁 + 活动保护集 + ack 协议 + 每窗口 LRU 淘汰(32) | active/background/suspended/crashed + 单点 `setTabSuspended`(CDP frozen)+ "后台>4 自动挂起"启发式,无 ack/无恢复代际 | ⛔ 差距大 |
| **截图表面** | prepare/ready/release 三段协议 + renderer 屏外定影 + 透明窗口引导 + capture pump + CSS 像素校正 | capturePage 主路径 + **父窗口裁剪 fallback** | ⛔ 差距大 |
| **录像** | setDisplayMediaRequestHandler + MediaRecorder VP8 全链 | 无 | ⛔ 缺失 |
| **视口模型** | 自由宽高 320×320~3840×2160 + `browserViewportSet/Reset` + resize 基线 | 预设制(desktop/responsive/4k/laptop…)+ emulateDevice | ⛔ 模型不同 |
| 操作事件 | `browser-view-operation`(前/后,resetsResizeBaseline) | agent-dispatching/agent-cursor(无 resize 基线概念) | ⚠️ 部分差距 |
| JS 对话框 | 主进程原生对话框 + 自动化代答 | renderer 内渲染对话框 UI(automation 代答待确认) | ⚠️ 方案不同,可保留 |

## 1. 必须先清理的部分(按序执行,每项独立可 review)

### C1. 测试白名单归位 —— 让"行为保护"真实生效(不改行为)

**问题**:浏览器模块测试分裂在两处:`apps/desktop/src/*.test.ts`(bun test 直跑)与 `scripts/*.test.mjs`(靠 package.json `test` 脚本白名单)。**不在白名单里的测试 CI 根本不跑** —— 对齐重构会误以为有保护实则没有。
**动作**:
- 盘点 `browser-*` 相关全部测试(两处),核对 `apps/desktop/package.json` 与根 `package.json` 的 test 脚本引用链;
- 把测试白名单收敛为目录级(如 `src` 内 bun test 自动发现 + scripts 显式列出),消除"文件存在≠受保护"的暗坑;
- 产出一张"模块 → 测试 → 是否真在 CI"对照表放进 PR 描述。
**验收**:白名单外无 browser 测试;`bun run test:core` 全绿。
**风险**:低;纯构建配置。

### C2. 死代码:browser-action-queue 的 epoch/cancel 机制

**问题**:`browser-action-queue.ts` 注释自述 epoch 作废/cancel「从无调用方」,随 paused_by_user 接管路径移除后成为历史残留;但行为被测试保护(#610)。
**动作**:删除死机制及对应断言,保留仍在用的"同 key 串行"主功能;PR 描述注明 #610 的行为边界变化。
**验收**:browser-action-queue.test.ts 更新后全绿;全仓无该 epoch API 调用方。
**风险**:低;有测试护栏。

### C3. guest DOM 内重复的"覆盖物"路径统一 —— 光标 badge vs 批注 overlay

**问题**:存在两条往 guest 页面 DOM 注入 UI 的路径:① `browser-cursor.ts` 的 `createCursorUpdateScript`(光标 badge);② `browser-guest-preload` 注入的 `browser-overlay/*` React 树(内含 CursorBadge)。ZCode 录像方案还要注入第三个光标 overlay —— 不先统一,对齐后会出现三套光标互相打架。
**动作**:确认两路现状职责重叠度;把"光标呈现"收敛到 overlay 树单一路径,cursor 脚本降级为数据通道(或删除);在 overlay 树上预留录像光标挂点。
**验收**:guest 内光标渲染入口唯一;现有 annotation 测试全绿。
**风险**:中;触及 guest DOM,必须有 C1 的测试先行。

### C4. 截图 fallback 封装 —— 移除父窗口裁剪的裸依赖

**问题**:`parent.webContents.capturePage(tab.surfaceBounds)` 的 fallback 依赖"webview 在窗口里的绝对 bounds",面板折叠/DPR 缩放/responsive 变换时是隐性错误源;且与 ZCode 表面协议(屏外定影)是两套互相冲突的语义。
**动作**:把截图抽象为 `captureTabSurface(tab, {viewport, scaleMode})` 单一入口,父窗口裁剪降级为入口内部策略之一并打 deprecation 注释;为后续 `prepare/ready/release` 协议预留接口形状(scaleMode: "scaled"|"unscaled"、invalidated signal)。
**验收**:全仓 screenshot 路径走唯一入口;现有截图行为回归通过。
**风险**:中;先做 C1。

### C5. 挂起逻辑收拢 —— 启发式与单点状态写入分离

**问题**:挂起相关逻辑散落:`setTabSuspended`(CDP frozen)、"后台 tab >4 自动挂起"启发式(browser-runtime.ts:4182 一带)、lifecycle 字段多处写。未来引入 ZCode 式驻留状态机时,协调器会与启发式互相触发(挂起→恢复→挂起循环)。
**动作**:把"何时挂起"的决策收敛到一个函数(输入:tab 运行态,输出:目标 residency),把"如何挂起"收敛到 setTabSuspended;启发式临时保留为决策函数的现有策略。之后驻留状态机 PR 只替换决策函数。
**验收**:挂起决策点唯一;现有 suspend 行为测试锁定。
**风险**:中低;纯主进程内部重构。

### C6. 两条桥的契约冻结与版本握手(防"桥接受影响"的关键)

**问题**:对齐会持续改命令面/事件面。当前桥:`sidecar→main` 的 `browser:request`(HMAC+sequence)与 `main→renderer` 的 `browser:event`(19 种 `browser:*` 事件)+ 4 个 renderer 方法 + guest 挂载协议。已有 `BROWSER_PROTOCOL_VERSION` 但需确认是否在桥上强制校验。
**动作**:
- 在 sidecar↔main 握手处强制校验 `BROWSER_PROTOCOL_VERSION`(不匹配即拒,带明确错误码),防版本漂移静默错配;
- 事件面文档化:19 种 `browser:*` 事件列出 payload 形状与稳定级(stable/内部),写进 `packages/shared` 注释或 docs;
- **冻结命名**:对齐期间不改既有频道/事件/命令的名字与 payload 必填字段;新增能力一律新增名字(ZCode 对齐层走增量方法,如 `browserViewportSet` 语义用新方法名挂载而非改 `emulate`)。
**验收**:握手校验生效(可造一个旧版本号被拒的测试);事件面文档合入。
**风险**:低;改动集中在握手点。

### C7. WebMCP 实验链隔离

**问题**:webmcp-shim → guest-preload → `lume:get-browser-webmcp-enabled` 整条链是移植自 Codex 的实验特性,guest-preload 注入时机与挂载协议强耦合。
**动作**:确认开关现状;若默认关闭,补一条"开关关闭时不注册任何 guest 注入"的测试;若默认开启,评估是否降级为 flag。不删除(留待独立决策)。
**风险**:低。

### C8. 一次性 webview 用例隔离(`open_weread_key_webview`,main.ts:2801)

**问题**:与浏览器子系统无关的一次性 webview,但影响 `webviewTag` 全局开启的归属判断。
**动作**:确认其 webPreferences 是否可复用 `createSecureWebPreferences`;在代码注释标注它不是 browser 子系统消费方,避免后续对齐误伤;若可行,让它走独立 partition。
**风险**:低。

### C9. dispatch 方法面盘点标记(只标记,不删)

**问题**:45 个方法 vs registry 能力表,哪些是 agent 面、哪些是 renderer 用户面、哪些已无消费方(sidecar 工具表 vs BrowserShell 调用点)没有对照表;对齐加新命令时无法判断旧命令可否废弃。
**动作**:产出 `方法 × 消费方(agent tool / BrowserShell / 两者)` 对照表(临时 docs 文件即可);对确认无消费方的方法标 `@deprecated`,**不在本 PR 删除**。
**风险**:无。

## 2. 明确不清理的部分(防过度清理)

- `browser-runtime.ts` 5,635 行的拆分 —— 对齐期间**不做大拆**;新能力(驻留协调器/表面协议/录像)以独立文件落地,runtime 只挂接,拆分留到对齐稳定后;
- extension 后端与 external-chrome-transport —— 与 IAB 宿主无关,不碰;
- 语义快照(browser-semantic-snapshot,自研 ref 体系)与 ZCode aria 快照的取舍是**独立决策**,不在清理范围;清理后它通过 C4 的截图/观察接口解耦,可并存;
- annotation 子系统(5,800+ 行)—— 产品级功能,只在 C3 统一光标路径时最小触碰;
- 测试断言细节 —— 除 C2 死机制外不改断言。

## 3. 建议执行顺序与 PR 切分

| 顺序 | PR | 内容 | 依赖 |
|---|---|---|---|
| 1 | `chore(browser): 测试白名单归位` | C1 | 无 |
| 2 | `♻️ refactor(browser): 清理动作队列死机制` | C2 | C1 |
| 3 | `♻️ refactor(browser): 截图单一入口封装` | C4 | C1 |
| 4 | `♻️ refactor(browser): 挂起决策收拢` | C5 | C1 |
| 5 | `✨ feat(desktop,sidecar): 浏览器协议版本握手 + 事件面文档` | C6 | 无(可并行) |
| 6 | `♻️ refactor(web): guest 光标路径统一` | C3 | C1、C4 |
| 7 | `🔧 chore(browser): webmcp 隔离 + weread webview 隔离 + 方法面盘点` | C7、C8、C9 | C1 |

之后才进入对齐主线(每个独立 PR):
A. 驻留状态机(suspend-pending/restoring + generation + ack + 活动保护 + LRU 淘汰);
B. 截图表面协议(prepare/ready/release,复用 C4 接口);
C. 录像(setDisplayMediaRequestHandler 全链,复用 C3 光标挂点);
D. 自由视口模型 + operation/resize-baseline 事件(涉及桥,需 C6 版本握手先行)。

## 4. 桥安全规则(对齐全程有效)

1. `browser:request` 的 MAC+sequence 帧、`browser:event` 的 19 个事件名、guest 挂载三步协议、4 个 renderer 方法:**不改名、不改必填 payload**;
2. 新增命令/事件一律新增名字;废弃走 `@deprecated` 标记 + 一个版本周期的双发;
3. 任何跨进程 payload 变更必须带 `BROWSER_PROTOCOL_VERSION` bump + 双端握手测试;
4. renderer 恒为 `actor=user`、agent 必经 sidecar ingress 的安全边界不动。
