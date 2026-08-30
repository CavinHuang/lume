# ZCode 桌面端 SidePane 在 REMOTE 工作区下的语义深度分析

分析目标:`D:\software\zcode\resources\app\out\renderer\assets\styles-C2WGZ-SY.js`(4,602,074 字节)。
所有切片与美化产物已保存至 `D:\tmp\zc-analysis\out\sidepane-q10\`(svc-region / shell-layout / wsl-head / qht-fn / yht-body / xht-body / mobile-overlay / LhBcfn(L$) / i0-picker / qK-branch / sidepane-store / terminal-view / yAt-sidepane / yAt2 / stream-provider 等 .beau.js)。

---

## 1. Remote 工作区模型：remoteSessionId 与 services 解析

### 1.1 会话注册仓库($f store,@272350)

远程能力的基础是一个全局 zustand store,含 `baseServices`(本地/主进程服务)与 `sessionsById`(每个远程会话各自的 services 集合)，并维护 `sessionIdByWorkspacePath` / `sessionIdByWorkspaceIdentity` 两级绑定:

```js
// @272350 (svc-region.beau.js L45-58)
var $f = A()(e => ({
    baseServices: null,
    sessionsById: {},
    sessionIdByWorkspacePath: {},
    sessionIdByWorkspaceIdentity: {},
    registerBaseServices: t => e({ baseServices: t }),
    registerSession: t => e(e => ({
        sessionsById: { ...e.sessionsById, [t.sessionId]: t }
    })),
    ...
```

`remoteSessionId` 就是 `sessionsById` 的键:一个连到远程 runtime(SSH / WSL / Docker / Server,四种 `remoteTarget.kind`,见 @2373267 的 `Rit`/`Hit` 序列化)的会话实例。`workspaceIdentity` 由 target 派生:`remote:${kind-hash}:${path}`(@2373867 附近 `F1`)。远程断开有专用哨兵错误 `ZCODE_REMOTE_WORKSPACE_DISCONNECTED`(@272031,`Qf()` 谓词判等)。

### 1.2 核心解析函数 sp / Spe / hp

```js
// @274692 function sp(e,t,n)
function sp(e, t, n) {
    let r = ap(e, n),        // 解析出 remoteSessionId(按 id→identity→path 三级)
        i = op(e, r);        // 是否 remote target
    if (i) {
        let e = r ? n.sessionsById[r]?.services : void 0;
        return e ? { services: e, remoteSessionId: r, isRemoteWorkspace: i } : null;
    }
    return { services: t, isRemoteWorkspace: i };   // 本地 → baseServices
}
```

```js
// @276058 function Spe(e)
function Spe(e) {
    let t = e.resolvedRemoteSessionId
        ? e.sessionsById[e.resolvedRemoteSessionId]?.services ?? null
        : e.isRemoteTarget ? dp() : e.baseServices;
    return e.isRemoteTarget && !t ? dp() : t ?? e.currentContextServices;
}
```

`dp()`(@276023)是一个 **断连占位 Proxy**:每个 service 都替换为 `call: () => Promise.reject(disconnectedError)` 的 RPC stub——远程 target 存在但会话还没注册时，所有调用统一失败为 `ZCODE_REMOTE_WORKSPACE_DISCONNECTED`,而不是误落到本地服务。

```js
// @276885 function hp(e,t,n,r)  — React hook 版
    c = o ? a ? `remote-ready` : `remote-waiting` : `local-ready`;
    return (0, Q.useMemo)(() => ({
        services: s, remoteSessionId: a, isRemoteTarget: o,
        connectionKind: c,
        rpcReady: c !== `remote-waiting`
    }), [c, o, a, s]);
```

三态:`local-ready` / `remote-ready` / `remote-waiting`。**`rpcReady` 是整个 shell 的渲染闸门**——根组件 `Lt=gp(Pt,It,Ft)`(@4573337,workspacePath/remoteSessionId/workspaceIdentity)解析出 workspace 级 services 后层层下传;每个 workspace tab 由 `GKt`(@4537702)再次用 `hp()` 解析,`t.rpcReady` 为假时整个 tab 内容不渲染。

### 1.3 Side pane 里什么被降级

| 能力 | 远程工作区行为 |
|---|---|
| **终端** | side pane 终端 `CTt`(@3622250)用 **传入的 services**:`t.terminalService.create({cols,rows,cwd})`(@3627662)。而 `services` 来自 `AAt`←WorkspaceShellLayout←`gp()` 解析，即 **远程会话的 terminalService——PTY 跑在远程主机上**，非本地降级。Web 远控下另有 `webRemoteControlTerminalTransportState`(外部 store `var _ht='idle'` @2832565,`xht()` useSyncExternalStore 订阅),`'reconnecting'` 时顶部显示重连提示条。 |
| **Git 自动刷新** | `Epe`(GitAutoRefresh,@278300 前后)用 `gp(workspacePath, remoteSessionId, workspaceIdentity)` 取 `fileWatcherService.watch`——监听与刷新全部走远程服务(远端文件变更 → 60s 去抖 `Tpe=6e4` → `onRefreshGit`)。 |
| **本机文件管理器** | 显式拒绝:`[TaskListItem] 远程 workspace 不支持本机文件管理器`(@2843364),仅 `remoteTarget.kind==='wsl'` 例外(可映射本地盘)。文件树行也有 `isRemoteWorkspaceFileTree` 标记(@2923195)控制右键菜单。 |
| **嵌入式浏览器** | 见第 4 节：面板本身按 `supportsEmbeddedBrowser`(=桌面)裁剪,web 远控下不提供。 |
| **Markdown/文件链接** | `WZ`(@2053956)谓词要求 `compactForRemoteControl!==true && 无 workspaceIdentity && 无 workspaceRemoteSessionId`,否则 markdown 链接不进内部浏览器预览、文件卡不进 code viewer。 |

---

## 2. compactForRemoteControl(L$ 会话视图)

`L$`(@2285206)是会话面板主组件,签名:`{paneId, sessionId, rootSessionId, readOnly, selectionSideChat, workspacePath, workspaceIdentity, remoteSessionId, compactForRemoteControl: f=!1, provider, ...}`。`f` 一路编入会话行上下文 `Cn`(@2298456):

```js
Cn = (0, Q.useMemo)(() => ({
    workspacePath: l, workspaceIdentity: u,
    workspaceRemoteSessionId: d ?? void 0,
    ...
    compactForRemoteControl: f,
    chatLoadingBlockedByActiveWork: xn, ...
}), [...])
```

`f=true` 时 UI 的具体变化(按证据):

1. **消息操作常显**——用户行操作条去掉 hover 渐显(@2123621):`t.compactForRemoteControl ? 'opacity-100' : 'opacity-0 transition-opacity group-hover/user-row:opacity-100 ...'`(触屏无 hover)。助手行反馈按钮同样式(@2152031),且 `C = e => i ? void 0 : e` 把 tooltip 直接剥掉。
2. **空态问候语固定小字号**——`sqe({availableWidthPx, naturalTextWidthPx, compactForRemoteControl})`(@1391912):`n ? rU(20px) : 自适应 clamp(20,30)`;`cqe` 跳过 ResizeObserver 测量直接 `o(rU)`。另有 `compactEmptyStateWithDock: f`(@2333309)让空态与底部 dock 紧凑排布。
3. **自动化入口与子代理目录隐藏**——`...!f && F ? {onOpenAutomations:...} : {}, isWebRemoteControl: f`(@2331636 区段);`onOpenSubagentDirectory: B && !f ? fn : void 0`(@2332107)。
4. **交互式错误恢复禁用**——`pnt({enabled: _e!==null && ve && _ && !f && !i && !s, ...})`(@2325891,验证码/错误恢复 watcher)。
5. **Plan 交互确认走简化路径**——`onPlanInteractionAccepted: f ? De : void 0`(@2329661)。
6. **对话摘要/头部**——`pQe` 接 `isWebRemoteControl: f, isMobileViewport: Ge`。
7. **文件预览卡**——`T6e`/`p6e`:`hideOpenWithMenu: t.compactForRemoteControl===!0`(@2084404)去掉"打开方式”菜单。
8. **Git 分支切换器 qK**(@1742981):触发器收缩为纯图标 `l ? 'size-8 px-0' : 'max-w-full pl-3 pr-2'`,分支名+箭头 `l ? null` 隐藏(popover 功能保留)。
9. **工作区选择器 i0**(@2486681):触发 chip 收窄 `r ? 'max-w-44 pl-3 pr-2' : 'max-w-[15rem] pl-3 pr-2'`,并传 `remoteWorkspaceSessions/onConnectRemote` 渲染远程会话列表。

线程路径:`WorkspaceShellLayout(Jt=isWebRemoteControl)` → `Jnt`/`Sit` → `L$(f)` → 行上下文 `Cn`。

---

## 3. simplifyForNarrowRemote(window shell 精简)

定义在 `WorkspaceShellLayout`(@3832400 起):

```js
// @3829776  function vjt(){ return ...window.matchMedia($At).matches }
var $At = `(max-width: 767px)`;
// @3835116
Hn = Jt && dn,   // Jt=isWebRemoteControl(=!!webRemoteControlWorkspaceSwitcher), dn=isMobileViewport(≤767px)
```

- **桌面分支**(非移动视口):`simplifyForNarrowRemote: Hn`(@3857172)。
- **Web 远控移动分支** `Jt && dn && O`(@3848158,渲染 `wht` 手机壳):**硬编码 `simplifyForNarrowRemote: !0`**(@3849457)。

消费点一 —— `qht` 窗口控制行(@2863890):

```js
function qht({ ..., simplifyForNarrowRemote: u = !1, hideHelpMenu: d = !1, ... }) {
    return (0, $.jsxs)(`div`, { ..., children: [
        (0, $.jsx)(Kht, { /* 编辑器选择器,保留 */ ... }),
        u ? null : (0, $.jsxs)($.Fragment, {
            children: [ d ? null : (0, $.jsx)(u3, {}),          // 帮助菜单
                       (0, $.jsx)(l3, { /* 终端开关 */ ... }) ]
        }),
        (0, $.jsx)(we, { title: ...`sidePane.togglePanel`...,   // 侧面板开关:始终保留
            children: ... onClick: s ... })
    ]});
}
```

即:**隐藏帮助菜单 + 终端切换按钮,保留侧面板(slide-over)开关**。

消费点二 —— 工作区头部 `Yht`(@2865107)任务菜单:`hideMobileUnsupportedActions: P`(@2871847)→ `Fht`(@2845365)中 `d ? null` 隐藏"在文件管理器打开”与“打开 provider 配置”两个本地动作;标题/远程徽章同时收窄(`P && 'max-md:max-w-[42vw]'` 等)。`Yht` 还体现远程差异:`Fe = !!(Me || remoteTarget || remoteSessionId)` 显示远程徽章(`zit()` → `SSH · user@host` / `WSL · distro` / `docker:xxx` / `Server`),会话日志可用性按 `clientMode: M ? 'web-remote-replayable' : 'desktop-continuous'` 判定(`Jht`)。

另:shell 有"对话过窄自动收起”逻辑——侧栏 <360px(`fjt`)、侧面板 <480px(`ljt`)时自动折叠并打日志(`[WorkspaceShellLayout] conversation 过窄,自动收起左侧栏/右侧面板`,@3835595)。

---

## 4. 嵌入式浏览器与远程工作区

**webview 是本地的,分区固定,不随远程会话切换**:

```html
<!-- @3661026, 嵌入式浏览器 XTt -->
<webview ref={T} allowpopups partition=`persist:zcode-embedded-browser`
         nodeintegrationinsubframes=`true` src={r ? Gre : Qn} ... />
```

全文件仅两个 partition:另一个是设置页 coding-plan webview 的 `persist:zcode-coding-plan`(@1334209)。没有任何按 `remoteSessionId` 派生 partition 的代码。

但**面板入口被裁剪**:
- `Zkt`(@3796125)构建 side pane "+" 菜单:`a.push('terminal')` 无条件,`i && a.push('browser')` —— `supportsEmbeddedBrowser` 为假时浏览器面板从菜单消失;
- 默认值链:应用根 `Re = m ?? !!s`(@4567635,`supportsEmbeddedBrowser ?? !!isDesktop`),shell `$jt` 层 `ie = L ?? !!P`(@3882507)。**Web 远控(非桌面)→ 无浏览器面板;桌面 + 远程工作区(SSH/WSL)→ 浏览器仍在,因为它本来就是本地 Chromium**。

**tab 级远程作用域**:side pane store(@200526 `ide`)在挂载/恢复时给 `browser`/`browser-use` tab 打上 `remoteSessionId`,tab 身份比较恒包含 `(t.remoteSessionId ?? '') === (n.remoteSessionId ?? '')`(@sidepane-store L458/469/488)——不同远程会话的浏览器 tab 互不串。`browser-use`(agent 驱动)tab 由主进程事件驱动:`onBrowserViewReady/Operation/Visibility/CloseTab`(@3810xxx 区段),即 agent 侧浏览器的窗口宿主仍在桌面端渲染进程。PPTX 自动预览在远控下也关闭:`onAutoOpenAssistantPptx: R && !Jt ? Et : void 0`。

---

## 5. Web/移动端 overlay:slide-over 全交互模型

手机壳 `wht`(@2833021,条件 `Jt && dn && O` 才走此分支)。side pane 以 overlay 形式渲染(`sidePaneContent: Lr({mobileOverlay:!0})`,panel ref 复用 `zn/Bn`):

```js
// @2835900-2836400 (mobile-overlay.beau.js L110-135)
(0, $.jsxs)(`div`, { className: [`absolute inset-0 z-30 transition-opacity duration-200 ease-out`,
        s ? `opacity-100` : `pointer-events-none opacity-0`].join(` `),
    "aria-hidden": !s, "data-mobile-side-pane-overlay": `true`,
    children: [
      (0, $.jsx)(`button`, { className: `absolute inset-0 bg-background/60 backdrop-blur-[1px]`,
          "aria-label": h.formatMessage({ id: `sidePane.collapse` }), onClick: c }),   // 背景点击=收起
      (0, $.jsx)(`div`, { className: [`absolute top-0 right-0 h-full w-[min(88vw,28rem)] max-w-full border-l border-border bg-background shadow-2xl transition-transform duration-200 ease-out`,
          s ? `translate-x-0` : `translate-x-full`].join(` `), children: f })   // @2836129
    ]})
```

交互模型完整描述:

- **几何**:右侧全高滑入面板,宽 `min(88vw, 28rem)`,`translate-x-0 ↔ translate-x-full` + 200ms ease-out;遮罩 `bg-background/60` 同步淡入淡出。
- **收起途径**:遮罩按钮点击(`onClick: c = onCloseSidePane`)。**该 overlay 本身没有滑动手势**——整个 2833000-2845000 区段无 pointer/touch 处理;有手势的是另一处:web 远控**导航抽屉**(非移动分支的 sidebar,`--web-remote-navigation-height` @3853043)用 pointer capture 拖拽高度(`$n/er/tr`,@3839000 起,4px 起拖阈值 `tjt=4`,未拖动视为点击折叠;高度 ≤24px(`zAt`)判定 collapsed,`yjt()` localStorage 记忆,一次性折叠键 `zcode:web-remote-control:collapse-navigation-once` @3828694+)。
- **焦点/无障碍**:面板打开时主聊天区 `inert` + `aria-hidden` + `data-mobile-chat-surface="inert"`(`E = !!f && s`);遮罩是真实 `<button aria-label="sidePane.collapse">`。
- **历史集成**:`popstate` 监听 + `pushState({zcodeMobilePage:'chat'})`,返回键在 chat/home 间切换(`Y4/Sht/Cht` @2832700);home 由 `webRemoteControl.mobileShell.backHome` 按钮触发。
- **状态回传**:`p.updateMobileViewState(workspaceKey, taskId)` 把手机端视图同步到远控宿主;`webRemoteControlTerminalTransportState === 'reconnecting'` 时顶部居中出现重连 toast(`data-web-remote-control-reconnect-notice`)。
- **非 overlay 的移动形态**:web 远控 + 中等宽度时 side pane 走 `mobileStacked`(Jt)样式——底部半屏 `max-md:!h-[min(45dvh,24rem)]`(@3816660),tab 条 `max-md:hidden`;`mobileOverlay` 时则 `max-md:!h-full !w-full` 全屏。

---

### 附:`zcode:close-active-context-request` 闭环(@3881420)

平台层注册回调(`t.onCloseActiveContextRequest`,@4572272)→ renderer 派发可取消事件 `new Event($8, {cancelable:true})`;唯一监听者在 Git 侧面板组件(@3888693):

```js
window.addEventListener($8, e => {
    let t = Yjt({ isWorkspaceVisible: N, isSidePaneCollapsed: Se, sidePaneState: be });
    t && (e.preventDefault(), $e(t.id));   // 关闭当前激活的 side pane 上下文 tab
});
```

`Yjt`(@3881430):`!isWorkspaceVisible || isSidePaneCollapsed ? null : pd(sidePaneState)`(激活 tab)。事件未被 preventDefault 时平台才执行 `Qa.CloseWindow`——实现"先关面板上下文、再关窗口”。

**关键偏移索引**:store $f@272350 | sp@274692 | Spe@276058 | hp@276885 | dp@276023 | qK@1742981 | sqe/cqe@1391912/1392116 | WZ@2053956 | ide@200526 | L$@2285206 | Cn@2298456 | pnt@2325891 | i0@2486681 | Fht@2845365 | xht@2832672 | wht@2833021 | slide-over@2836129 | qht@2863890 | Yht@2865107 | Xht@2875425 | CTt@3622250 | webview@3661026 | yAt@3800422 | Zkt@3796125 | AAt@3824273 | $At/vjt@3828690/3829776 | Hn@3835116 | Jt&&dn&&O@3848158 | $8@3881420 | GKt@4537702 | Re@m??!!s@4567635 | Lt=gp@4573337。