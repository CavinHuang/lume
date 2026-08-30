# ZCode 右侧面板(SidePane)完整逆向报告 —— 汇总

> 分析对象:`D:\software\zcode\resources\app\out\renderer\assets\styles-C2WGZ-SY.js`(4.6MB 主 renderer)+ `WikiReferenceSidePane-D4JOTihA.js` + `catalogTree-D7q4FnnV.js` + `index-CKD0zXuV.js` + `out/host/index.js` + `out/main/index.js`
> 四份分报告:P1 壳层 / P2 Git+CodeViewer / P3 Wiki+终端 / P4 交互面(本目录同名文件)
> 切片证据:`D:\tmp\zc-analysis\out\sidepane\`(40+ 美化切片,字节偏移可复核)
> 日期:2026-08-30

---

## 1. 面板家族全景

SidePane 是 ZCode 右侧的多 tab 面板,**15 种 tab 类型**:

| 类型 | id 形态 | 单例 | 归属 | 内容组件 |
|---|---|---|---|---|
| browser | `browser:<nanoid>` | 否(可多开) | 全局 | wEt(webview guest,驻留挂起) |
| browser-use | `browser-use:<tabId>` | 否 | **按会话** | TEt(agent 驱动,主进程权威) |
| git | `git` | **是** | 全局 | YEt(4 diff 作用域) |
| model-trajectory | `model-trajectory:<taskId>` | 每任务 | 全局 | ekt |
| repo-wiki | `repo-wiki` | 是 | 全局 | l2(wiki 生成管理) |
| wiki-reference | `wiki-reference:<ownerTaskId>` | 每任务 | 全局 | Q.Suspense lazy chunk(引用装配器) |
| developer-tools | `developer-tools` | 是 | 全局 | lkt(调试开关门控) |
| terminal | `terminal:<nanoid>` | 否(可多开) | 全局 | wTt(真 PTY xterm) |
| subagent-session | `subagent-session:<ws>:<root>:<child>` | — | **按 root 会话** | L$(会话视图+rewind) |
| subagent-directory | `subagent-directory:<ws>:<root>:<parent>` | — | 按 root | Hkt(运行中/已结束列表) |
| selection-side-chat | `selection-side-chat:<ws>:<parent>:<child>` + ordinal | — | 按 parent | L$(侧选会话) |
| plan-detail | `plan-detail:<ws>:<parent>:<toolCallId>` | — | 按 parent | Wkt(markdown) |
| whiteboard | `whiteboard:<boardId>` | — | 全局 | WDt |
| code-viewer | `code-viewer:<sourceKey>` | 按 sourceKey 去重 | 全局 | owt(8 种 source 分派) |
| treemapping | — | — | — | **已隐藏**(消毒函数一律剔除) |

归属规则(`xd`):browser-use 按会话、selection-side-chat/plan-detail 按父会话、subagent-\* 按 root 会话;**其余全局可见**。单例集:`git/repo-wiki/developer-tools(/treemapping)`。

## 2. 壳层三层架构

1. **纯 reducer 层**(可测试):`wd` 关 tab(邻居回落)、`Td` 激活、`Cd` 关后按 owner 重算、`Ede` 关其他、`Dde` 关全部、`Ade` 重排(不动 activeTabId)、`ode` scope 重算(无可见 tab → 自动折叠)。
2. **App 级控制器 Hook `Qde`**:持全部 React 态 + 24 个 handle\*;workspaceKey 维度 `Map≤50` 的 **renderer 内存持久化**(不落盘,reload 即失——P4 全量 localStorage 排查确认唯一 chrome 持久化是左侧栏宽度键);最近关闭环 8 条(排除 selection-side-chat/browser-use)。
3. **壳组件 `yAt`**:标签条(dnd-kit 拖拽重排 distance:4、溢出估宽 60px/tab、渐变 mask、"+" 菜单、cmdk 总览弹层)+ 分类型渲染 switch + ErrorBoundary scope。

## 3. 关键机制

### 3.1 布局与性能
- react-resizable-panels:侧面板 `default 45% / min 240px / max 65%`,底部终端 `30% / min 140px / max 50%`,均 `rememberExpandedSize`。
- **isResizeSettling**(220ms 静默)+ **96px 可见宽度门**(`renderHeavyContent`):非激活/不可见/过窄时不渲染重型内容(骨架假行)。
- 窄列自动收起:`<480px` 收侧面板、`<360px` 收左侧栏(300ms 防抖);移动端 slide-over(`w-[min(88vw,28rem)]` + 全屏遮罩)。
- 折叠动画:flex-grow transition 200ms + transitionend/240ms 兜底;隐藏前记宽度 45%、重展开占位 200ms。

### 3.2 终端(真 PTY)
- host 进程 `node-pty`(win32 ConPTY + conpty.dll 降级;unix $SHELL 探测链),`TERM=xterm-256color`、字体系统探测(WT/VS Code/kitty/alacritty)。
- 传输:host 内 VS Code 式 ChannelServer(MessagePort + VSBuffer,Promise/EventListen/EventFire 帧)→ `zcode:service-port` 递 renderer → `toService` Proxy。
- **两处呈现、一个服务**:侧栏 tab(持久 `persistentKey`,关闭走 stash div 保活或显式 release)与底部面板(非持久,树内存活)是同一 `CTt` xterm 组件的两种宿主;PowerShell 回显修正、IME 去重、OSC8 链接→内嵌浏览器。

### 3.3 Git 面板(只读)
- 数据:`gitService` RPC(services 抽象,git 执行体在主进程/sidecar 侧),4 个 diff 作用域:unstaged/staged/branch(基准比较)/last-turn(本构建疑似桩掉)。
- 刷新:手动 + **文件 watch 自动**(watch 路径由 summary 派生,60s 防抖);diff 懒加载 + revision 失效。
- 渲染:tanstack-virtual 文件列表(32px 估算/overscan 14)+ 展开式 diff;查找批量预载 + scrollToIndex。
- 降级:800 行掐首 400+尾 399+哨兵行;1200 行/180k 字符/锁文件清单 → 纯文本降级。
- **完全只读**(无 stage/commit)。

### 3.4 Code Viewer(只读 + 行评论)
- 8 种 source:file/text/image/pdf/pptx/patch/multi-file-diff/code-review;按 sourceKey 去重复用 tab。
- 高亮:**内嵌 Shiki + oniguruma WASM**,单例 highlighter,token 缓存(前 100+后 100 字符 key),>12 万字符不高亮,主题随暗色/用户设置。
- Diff:**Pierre 系 diffs 库 + Worker 池**(min(4, cores/2)),word-alt 行内 diff,主题 CSS 变量桥接。
- PDF(>2MB 分段 256KB 渐进,>64MB 拒绝)、PPTX(分块+完整性校验+watch 重载)各自懒加载 chunk。
- 行级评论:enableCodeLineSelection → 提交到会话 + 本地 store。

### 3.5 WikiReference(引用装配器)
- 消费已生成 Repo Wiki(不负责生成),目录树+预览,按整库/分组/页面拼 markdown。
- 插入聊天:`window.dispatchEvent(new CustomEvent('zcode:add-wiki-to-chat',{cancelable:true,detail}))` —— composer preventDefault=成功,无人监听=报"composer 缺失"。入口门控:需活跃任务 + 已生成 wiki。

## 4. 交互面

- **快捷键**:`Cmd/Ctrl+Alt+B` 切换侧面板(标题栏 tooltip 同款);`+K|P` quickpick、`+F` 查找、`+[`/`+]` 会话导航、`+B` 侧栏、`+J` 终端。侧面板开关是 **collapse 切换**(PAt 保持挂载),非关闭。
- **会话→面板路径**:"Open on the right"(agentSummaryAction,点击开 subagent-session)、头部菜单 model-trajectory(zustand 请求总线,workspaceKey 匹配消费)、browserNavigationRequest(聊天链接/webview window.open → 新 browser tab)、browser-use 事件驱动(ready→揭示或后台挂载;visibility 离开自动收起;operation 5s 操作锁)。
- **"更多"菜单**:关闭活动上下文(`zcode:close-active-context-request`)——面板展开且工作区可见时先关活动 tab(preventDefault),否则关窗。
- **多窗口**:renderer 状态天然 per-window(无跨窗同步);main 侧仅按 windowId 管理 browser tab 驻留预算(每窗 32,LRU)。
- **"+" 菜单可用项**(条件门控):selection-side-conversation(需活动任务)/review(无 git tab 时)/terminal(恒有)/browser(支持内嵌时)/wiki-reference(需已完成 wiki)/developer-tools(调试开关)。

## 5. 状态与持久化结论

- SidePane 状态 **100% renderer 内存**(workspaceKey 维度 Map≤50 LRU;workspace 切换存/取,应用退出即失)。浏览器 tab 重开换新 id。
- 无 sidePaneState 落盘、无 IPC 持久化;localStorage 仅左侧栏宽度 + resizable-panels 快照(左栏分组)。
- browser-use tab 的持久权威在**主进程**(guest-manager + 驻留协调器),renderer 只持有投影。

## 6. 对 Lume 重写的映射建议(要点)

1. SidePane 壳层:15-tab 联合 + reducer 纯函数 + Hook 控制器三层结构可直接套用;tab kind 首版只需 browser/git/terminal/code-viewer。
2. 驻留交互:激活 suspended tab 先 ensureResident、挂起占位 + suspend-ready ack、guestState unmounted 丢弃——Lume 新核心已具备同款 IPC。
3. 终端:若对齐,需引入 host 进程 node-pty + ChannelServer 传输 + stash 注册表(当前 Lume 终端在别处)。
4. Git/CodeViewer:只读 git 面板 + 4 作用域 + watch 自动刷新 + Shiki/diffs-worker 渲染是独立子系统,建议独立 PR。
5. 性能三闸(220ms settling/96px 宽度/非激活跳过)是 SidePane 手感的关键,重写时不可省。
