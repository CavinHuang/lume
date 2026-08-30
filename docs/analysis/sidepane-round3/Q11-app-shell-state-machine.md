All data is collected and verified. The analysis is complete — here is the technical report.

---

# ZCode 桌面端 Workspace Shell 状态机区域深挖报告（H-consumer3：3,877,000–3,898,000 及 wjt 定义区）

## 0. 方法与产物

- 定位失败根因：先前切片从 3,877,000 处起切，落在字符串/模板字面量内部导致 js-beautify 失败。
- 本次用自写 scanner（跟踪 `'`/`"`/`` ` ``/`//`/`/* */`/正则/模板 `${}` 嵌套，生成全文件 code-mask）回扫到干净的**顶层声明边界**：`function wjt(` @ **3864783**（前一个顶层函数 `Cjt` 已闭合），前向扫到 App 组件闭合后的 `var eMt=300;` 末尾 @ **3898620**。切片为一段连续完整顶层声明序列，beautify 零报错。
- 产物（均已保存）：
  - `D:\tmp\zc-analysis\out\sidepane-q11\raw-3864783-3898620.js`（33,837 字节原始切片）
  - `D:\tmp\zc-analysis\out\sidepane-q11\beautified-3864783-3898620.js`（1,575 行）
  - `D:\tmp\zc-analysis\out\sidepane-q11\offset-map.tsv`（美化行号 → 原文件字节偏移精确映射，0 次重同步）
- 下文引用均标注**原文件字节偏移**。App 组件本体是 `$jt`（@3881469 之后的 `function $jt(...)`），WorkspaceShell 组件是 `xjt`（JSX 调用 @3894971）；props 表完整覆盖到 @3898492 `handleBrowserNavigationRequestHandled`、@3898540 附近 `taskFindDialogProps:Dr})]})}` 收口。

## 1. 工作区壳状态机

### 1.1 重要纠正：wjt / Yjt 的真实职责

P1/P4 报告把 `wjt`、`Yjt` 称作 "workspace shell state machine"，实际代码为：

- **`wjt`（@3864783）是桌面窗口 chrome/自动更新 hook，与侧栏状态机无关**。返回 `{isMacFullscreen, desktopWindowChromeState, macWindowControlsLeftPaddingPx, windowsWindowControlsRightPaddingPx, updateReadyVersion, updateState, sidebarContainerRef}`（@3865290 附近）。内部 4 个 effect：全屏状态监听（`onWindowFullscreenChanged`）、Windows 窗口 chrome 状态同步（`getDesktopWindowChromeState` + `onDesktopWindowChromeStateChanged`，失败日志 `[app-chrome] 同步桌面窗口外观状态失败`）、窗口控制区几何（`onWindowControlsOverlayChanged` → 左右 padding，`d(q8)/p(J8)` 默认值回退）、更新就绪 toast（`update.toast.ready`）。
- **`Yjt`（@3881460）是“关闭活动上下文”目标的解析器**，不是状态机本体：

```js
// @3881420
  $8 = `zcode:close-active-context-request`;

// @3881460
function Yjt(e) {
  return !e.isWorkspaceVisible || e.isSidePaneCollapsed
    ? null
    : pd(e.sidePaneState)
}
```

  其中 `pd`（@200067）= `e ? e.tabs.find(t => t.id === e.activeTabId) ?? null : null`，即“当前激活侧栏 tab”。

### 1.2 状态机的真实载体与订阅切片

壳状态存在外部 store（`Io`，按 `workspacePath+workspaceIdentity` 键控，getter `Po`）。App 侧通过 `zjt`（@3872815）做**投影订阅**，这是状态机的输入面：

```js
// @3872815 (function zjt)
    workspaceShellZCodeState: Io(Pl(n => {
      let r = Po(n, e, t),
          i = Eo(r);
      return {
        activeTaskId: r.activeTaskId,
        draftFocusVersion: r.draftFocusVersion,
        modelSwitchPending: r.modelSwitchPending,
        modelSwitchStage: r.modelSwitchStage,
        selectedProvider: r.selectedProvider,
        selectedSupplierKey: r.selectedSupplierKey,
        configOptions: r.configOptions,
        optimisticTaskListByTaskId: r.optimisticTaskListByTaskId,
        workspaceInit: r.workspaceInit,
        taskStatus: i.taskStatus,
        taskError: i.taskError
      }
    })),
```

状态字段与转移（本区域可见部分）：

- **task/draft 域**：`activeTaskId`（null=草稿态）、`draftSessionId`、`draftFocusVersion`、`groupedDraftTask`（含 placement）、`draftRuntime.status`、`taskStatus`；忙碌态谓词 `Ijt`（@3877937）= `creating|restoring|streaming`。
- **模型切换子状态机**：`modelSwitchPending × modelSwitchStage`，阻塞谓词 `Z8`（@3873819）：

```js
// @3873819
function Z8(e, t) {
  return e && t === `restartingRuntime`
}
```

  转移由 store 的 `startModelSwitch/updateModelSwitchStage/finishModelSwitch` 驱动；`stage==='restartingRuntime'` 时阻塞：选择任务（@3875583 `忽略 task 切换`）、任务后退导航（@3876040 `忽略任务后退导航`）、前进导航（@3876370），`canTaskNavBack/Forward = canGoBack/Forward && !T`（@3877087 附近）。

- **任务导航历史子状态机**（`Hjt` @3874027）：`taskNavHistory` + `taskNavGoBack/GoForward/removeTaskFromNavHistory`。回退/前进沿历史栈行走：automations 条目（`Voe`）→ 切 workspace tab + 打开 automations；plugin-store 条目（`Hoe`）→ 打开插件商店；任务条目需过可见性校验 `Vjt`（@3873870，`visibleTasks` 含该 taskId 或 `taskMetaByEntityKey[entityKey].taskId` 匹配）；**不可见的条目被弹出并继续回溯**——这是切换后跨任务过滤的核心：

```js
// @3876150 (handleTaskNavBack 内部循环)
      for (; i;) {
        let e = i;
        if (Voe(e)) { r(e.workspacePath, ...); a?.({...automationId/Tab}); return }
        if (Hoe(e)) { r(e.workspacePath, ...); o?.(e); return }
        if (Vjt({entry: e, visibleTasks: Wo(Io.getState().getWorkspaceState(...)),
                 taskMetaByEntityKey: s})) {
          g(e.workspacePath, e.taskId, e.workspaceIdentity);   // handleSelectTask
          return
        }
        h(e.taskId), i = p()          // @3876772: 弹出失效条目继续回溯
      }
      y(e.formatMessage({id: `taskNav.noMoreBack`}))
```

  栈耗尽 → toast `taskNav.noMoreBack` / `taskNav.noMoreForward`。

- **设置页可见性子状态机**（`Bjt` @3874896 附近）：三个 ref（`isWorkspaceVisible`、`workspaceMainView`、“等待退出”标记）。可见→隐藏时记下当前 view；再可见且 view 未变则自动退出设置（`onExitSettings`）；`preserveNextSettingsExit` 可豁免一次。

- **侧栏开合状态**：`isSidePaneCollapsed`（`Se`）与 setter `Ce`、`sidePaneState`（`be`）、`recentClosedSidePaneTabs`（`xe`）、`handleToggleSidePaneCollapse`（`Je`）等全部来自 `Qde`（@214020，另一区域，即真正的侧栏状态机 hook）。派生：

```js
// @3887191 (组件体内)
    un = (0, Q.useMemo)(() => pd(be), [be]),      // 激活侧栏 tab
    dn = un?.type === `browser`,                  // isBrowserOpen
    fn = un?.type === `git`,                      // isGitOpen
    pn = be?.tabs.some(e => e.type === `git`) ?? !1   // 有 git tab → git summary 含扩展数据
```

  开合布尔：`Sn = !Se`（@3888516），作为 prop `isSidePaneOpen: Sn`（@3896545）下传。切换入口 `Cn = useCallback(() => { Je() }, [Je])`（@3888753），快捷键经 `bme({... toggleSidePane: () => wn(Cn) ...})`（@3893277）。

### 1.3 `$8` 关闭活动上下文事件流

```js
// @3888523 (App 组件体内)
(0, Q.useEffect)(() => {
  let e = e => {
    let t = Yjt({
      isWorkspaceVisible: N,
      isSidePaneCollapsed: Se,
      sidePaneState: be
    });
    t && (e.preventDefault(), $e(t.id))       // handleCloseSidePaneTab(激活tab.id)
  };
  return window.addEventListener($8, e),
         () => { window.removeEventListener($8, e) }
}, [$e, Se, N, be]);
```

语义：`zcode:close-active-context-request` 到达时，若工作区可见且侧栏未折叠，**关闭当前激活侧栏 tab**（而非折叠整个面板）；面板已折叠/工作区不可见时 no-op（不 preventDefault）。

## 2. sidePaneOwnerId 派生链与 draftFocusVersion 全部 setter

### 2.1 派生链（精确优先级，@3883553）

```js
// @3883553
  let pe = de.activeTaskId,                                        // ① 订阅切片里的 activeTaskId
      me = Io(e => e.getWorkspaceState(A, ce).draftSessionId),     // ② store 直读 draftSessionId
      he = pe ?? me ?? null,                                       // ③ activeTaskId → draftSessionId → null
      [G, ge] = (0, Q.useState)(null),
      _e = de.draftFocusVersion;                                   // 草稿焦点版本
```

与任务描述的先验完全一致：**`activeTaskId` → `draftSessionId` → `null`**。`he` 有两个消费点：传入 `Qde`（`sidePaneOwnerId: he`，@3884806）和传给 WorkspaceShell prop（`sidePaneOwnerId: he`，@3896742）。注意 `de.activeTaskId` 走 `Pl` 投影订阅（稳定引用优化），而 `me` 是无等值函数的裸 selector（返回原始值，安全）。

### 2.2 draftFocusVersion 的全部 setter：全局唯一一处

全 bundle 共 14 处 `draftFocusVersion`，**全部是读**；唯一写点在 store chunk `skillStore-C5tahaKT.js` 的 `startDraft` action（该 chunk 名有误导性，实际内含 workspace store）：

- 初始化（该 chunk @1373）：workspace 初始状态 `... taskListCache: null, draftFocusVersion: 0 }}`。
- 唯一递增点（该 chunk @28427，action `startDraft:(t,r,i,o)=>{` @27162）：

```js
// skillStore-C5tahaKT.js @27162 起 (startDraft action, 节选)
startDraft: (t, r, i, o) => {
  ...
  return {...e,
    activeTaskId: null,
    groupedDraftTask: ee,                 // 继承或新建 groupedDraft placement
    draftRuntime: {status: `idle`, error: null},
    ...draftPreferredModel/Mode/ThoughtLevel 重置...,
    draftError: null,
    modelSwitchRequestId: null, modelSwitchPending: !1, modelSwitchStage: `idle`,
    draftFocusVersion: e.draftFocusVersion + 1,     // @28427：唯一 setter
    optimisticMessages: [],
    ...
  }
}
```

即 **draftFocusVersion 仅由 `startDraft` 递增**（每次“新建任务/开始草稿” +1）。相邻的 `invalidateDraftRuntime`（@26628）递增的是另一个计数器 `draftRuntimeInvalidationVersion` 并清空 `draftSessionId`，不要混淆。

`startDraft` 的调用方（全 bundle）：本区域 `tr`/`handleStartDraftInWorkspace`（@3891088）、4.5M 区域顶层壳的 `startDraftInWorkspace`/`startNewTaskFromActiveWorkspace`（@4518788、@4520367、@4521452）、移动端/远程路径 `p.startDraft(t,{mobileNavigationIntent:'chat'})`（@2818714）、某组件直取 `Io(e=>e.startDraft)`（@3228961）。**这些全是间接 setter 触发点。**

### 2.3 消费方（draftFocusVersion 的 3 个读点）

1. 本区域新建任务自动收起 effect（§2.4）；
2. `Ait`（@2370397）+ `kit`（@2370328）：`kit = e.enabled && e.rendererReload && e.activeSessionId===null && e.draftFocusVersion===0` —— 仅在“无会话且草稿从未聚焦”时允许恢复会话选择，由 WorkspaceShell 侧调用（@3834230）；
3. 零散读点 @1368801、@3164625（其他组件订阅）。

### 2.4 新建任务自动收起右侧面板（完整语义，@3885271）

```js
// @3885271
  let st = (0, Q.useRef)({ workspaceKey: at, draftFocusVersion: _e });
  (0, Q.useEffect)(() => {
    let e = st.current;
    if (e.workspaceKey !== at) {          // ① 换工作区：只同步基线，绝不收起
      st.current = { workspaceKey: at, draftFocusVersion: _e };
      return
    }
    if (e.draftFocusVersion === _e || (st.current = { workspaceKey: at, draftFocusVersion: _e }, _e === 0))
      return;                             // ② 版本未变，或初值 0（首挂载）：不动
    let t = be?.tabs.length ?? 0;
    Se || (J.info(`[App] 新建任务时收起右侧面板 workspace=${A} tabs=${t}`), Ce(!0))
                                          // @3885570：③ 仅当面板当前展开时收起
  }, [_e, Se, Ce, be, A, at]);
```

三重防误触发：工作区切换不同步收起（只更新基线 ref）；`_e===0` 视为初始化；已折叠时不重复动作（不覆盖用户手动展开）。

## 3. 先前报告未覆盖的 App 级侧栏/壳逻辑

### 3.1 跨任务浏览器/Git 恢复态迁移（`Ujt` @3878163）——"preferred-tab map" 的 App 侧 половина

```js
// @3878163 function Ujt({activeTaskId, gitSelectedSourceId, setGitSelectedSourceId, ...})
  let a = (0, Q.useMemo)(() => kd({workspacePath: r, workspaceIdentity: i, taskId: e}), [e, r, i]),
      o = (0, Q.useRef)(a),                                   // 上一任务的恢复键
      [s, c] = (0, Q.useState)(() => {
        let e = Ad(a);                                        // Ad: 按键读持久化
        return e.browserUrl ? {browser: e.browserUrl, ...e.browserUrls} : e.browserUrls
      }),
      l = (0, Q.useRef)(t);
  return l.current = t,
  (0, Q.useEffect)(() => {                                    // @3878514 任务切换
    let e = o.current;
    if (e === a) return;
    jd(e, {activeGitSourceId: l.current});                    // jd: 写回旧任务
    let t = Ad(a);                                            // 读新任务
    o.current = a, n(t.activeGitSourceId), c(t.browserUrl ? {...} : t.browserUrls)
  }, [a, n]),
  (0, Q.useEffect)(() => () => { jd(o.current, {activeGitSourceId: l.current}) }, []),  // @3878738 卸载兜底
  { browserRestoreUrls: s,                                    // @3878822
    handleBrowserUrlChange: (0, Q.useCallback)((e, t) => {    // @3878843 双写：组件态+持久层
      c(n => ({...n, [e]: t})), jd(a, {browserUrls: {...Ad(a).browserUrls, [e]: t}})
    }, [a]) }
```

要点：恢复数据**按任务键控**（`kd({workspacePath, workspaceIdentity, taskId})`），切换任务时旧任务的 `activeGitSourceId` 写回、新任务的 `browserUrls + browserUrl + activeGitSourceId` 恢复；`browserRestoreUrls` 是 `{[tabId|'browser']: url}` 映射（@3897009 下传 prop）。任务卸载时兜底写回，防丢最后一次选择。

### 3.2 草稿 vs 已提交任务的处理（`tr`/`handleStartDraftInWorkspace` @3890513）

```js
// @3890513
    tr = (0, Q.useCallback)((e, t, n) => {          // (workspacePath, identity?, purpose?)
      ...
      let o = r.getWorkspaceState(A, ce),
          s = o.activeTaskId === null ? o.groupedDraftTask?.placement : void 0,  // @3890816
      ...
      n ? Jt(e, c) : Yt(e, ...) || Jt(e, c),
      w || (k1.getState().deactivateActiveGroup(), o1.getState().resetToPrimaryPane()),
      r.startDraft(e, a, i, s ? {groupedDraftPlacement: s} : void 0),          // @3891088
      s && (ce?.trim() || A) !== (i?.trim() || e) && r.clearGroupedDraftTask(A, ce)  // @3911131
    }, [...])
```

草稿 placement 仅在**当前无 activeTask** 时携带迁移；跨工作区启动草稿会清掉源工作区的 groupedDraft。且工作区不可见（`w===false`）时额外重置 active group/主面板——这是“切走后回到主面板”的壳级约束。

### 3.3 reload 会话的门禁状态机（`Pjt`/`Rjt`/`Ljt`/`Ijt`）

`reloadSessionDisabled`（`zjt` 第二返回值，@3873317 附近）由 `Rjt`（@3873967 附近，行 345）计算：把 `taskRuntimeByTaskId`、`optimisticTaskListByTaskId`、`taskListCache` 三方的 provider 归并（`Ljt`），任一处于 `Ijt` 忙碌态（`creating|restoring|streaming`）且 provider 等于当前默认 provider → 禁用重建；无 provider 信息时仅当该 taskId 就是 `activeTaskId` 才算忙。`Pjt`（@3876832 附近，行 222）内还有 1200ms 去抖（`Tjt=1200` @3865291，`Djt` 判重）与 `resumeTaskId = c?.resumeTaskId?.trim() || d.activeTaskId` 的续跑逻辑。

### 3.4 其他未报告项

- **`wn` 可见性守卫**（@3888930 附近，行 1124）：`Vbe({isWorkspaceVisible: N, onReturnToWorkspace: S, run: e})` —— 所有 shell 开关（sidebar/terminal/sidePane/前后导航/上一个/下一个会话）统一经 `wn` 包裹，工作区不可见时委托 `onReturnToWorkspace`（如先返回工作区再执行）。
- **`Fjt` 卸栽回收**（@3876313 附近，行 307）：`workspaceAbsPath` 变化时清 `browserNavigationRequest` 与 `testMessages`；卸载时若“无 activeTask 且非 creating/streaming 且预热态非 idle”，回退 workspace 预热并 `releaseWorkspacePreparation`。
- **`Wjt` 活动目标解析**（@3879009）：有效 `workspaceIdentity/remoteSessionId/remoteTarget` = 激活 tab（须 `mt(t)` 且 `t.workspacePath===A`，否则全空）优先，显式 props 兜底；`Q8 = trim || undefined`。派生的 `ce`（有效 identity）贯穿本区域所有调用。
- **上一个/下一个会话**（`Sr` @3892683）：基于查询结果 + fallback 列表（`Sbe`）排序后取 `previousTaskId/nextTaskId`，经 `pr`（handleSelectTask）切换，同样被 `wn` 守卫。
- **props 表侧栏相关全集**（App→`xjt`/WorkspaceShell）：`isSidePaneOpen: Sn`（@3896545）、`sidePaneState: be`（@3896632）、`recentClosedSidePaneTabs: xe`（@3896649）、`sidePaneOwnerId: he`（@3896742）、`browserRestoreUrls: Pt`（@3897009）、`handleBrowserNavigationRequestHandled: rt`（@3898492），以及 `handleActivate/Reorder/Close/CloseOther/CloseAll/ReopenClosedSidePaneTab` 全套（@3898160–3898480 区段）与 `toggleSidePaneShortcutLabel: te`（`pse('B')`）。

## 4. 产物、简化与遗留风险

- 产物路径：`D:\tmp\zc-analysis\out\sidepane-q11\`（raw 切片、beautified 全文 1575 行、精确 offset-map.tsv）。
- 对先验的修正：`wjt` 并非侧栏状态机（是窗口 chrome/更新 hook）；`Yjt` 仅是关闭上下文目标解析器；真正的侧栏状态机在 `Qde`（@214020，另一区域）。
- 遗留：`Qde` 内部的 preferred-tab 两级 map（`A.current/D.current`）与折叠持久化细节在本区域之外，本次仅确认其消费接口（`be/Se/Ce/Je/$e/...`）；`Vbe`、`Wo`、`Po`、`Pl` 等辅助函数体在更早区域，未展开。