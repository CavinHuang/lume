# 移植规范(browser/core 十路代理共用)

## 目标

把 `D:\workspace\projects\ai-projects\lume\.zcode\analysis\extracted\` 下的 ZCode 逆向还原源码移植为 Lume 的严格 TypeScript 实现。产物必须**语义等价**于还原源码(分支/守卫/顺序不简化),变量名全面语义化(还原源码里的 `e/t/r/o/n/i/a` 单字母一律重命名),公共函数/类附 JSDoc(中文,注明 ZCode 原名)。

## 来源与去处

| 提取源(.zcode/analysis/extracted/) | 产物(apps/desktop/src/browser/) |
|---|---|
| 01-browser-guest-manager.source.js | core/guest-manager.ts |
| 02-execution-engine.source.js | core/executor/*.ts |
| 03-screenshot-subsystem.source.js | core/screenshot-surface.ts |
| 05-webm-recorder.source.js | core/recording/recorder.ts |
| 07-residency-coordinator.clean.js | core/residency.ts |
| 08-input-primitives.clean.js | core/input.ts |
| injected-scripts/runtime-exact/*.js | core/injected/*.ts |
| 06-ipc-and-wiring.source.js | ipc.ts(仅 ipc 壳)/dialog-controller.ts |

补充参考:`docs/plans/2026-08-30-browser-rewrite-design.md`(模块映射/协议)、`core/types.ts`(契约,**不得修改**,缺类型找我)、`.zcode/analysis/zcode-browser-panel-architecture.md`(语义疑问时查)。

## 硬性规范

1. **契约**:只 import `./types`(`./errors` 已并入 types)与同目录你自己的子模块;**不得** import 其它代理的模块(guest-manager 由集成者装配)。类型不够用就在产物文件顶部以 `interface PortingGap { … }` 注释块声明需求,别改 types.ts。
2. **TS 严格**:strict 模式可编译目标;Electron 类型用 `import type`。`any` 仅允许在 CDP 参数透传处(`Record<string, unknown>` 优先)。
3. **命名**:全部语义化。保留 ZCode 原名的类名(BrowserGuestManager/BrowserTabResidencyCoordinator/IabPlaywrightLocatorSession/PlaywrightDomSnapshotSession/DesktopBrowserScreenshotSurfaceCoordinator/DesktopBrowserScreenshotActivityController/EmbeddedBrowserJavaScriptDialogController)。
4. **错误**:用 `browserError(code)` / `BrowserNavigationTimeoutError`;错误码只用 types 里的集合。
5. **日志**:经构造注入的 `log/warn`,禁止 console。
6. **测试**:纯逻辑(residency/policy/normalize/快照归一化/脚本生成器)附 `*.test.ts`(bun:test 或 node:test,放 `apps/desktop/src/browser/core/__tests__/`),必须在 `bun test` 下通过。
7. **平台差异**:ZCode 的 `lume-browser-restore://`/`zcode:` 频道前缀按表替换(`lume-browser-restore://pending`、`lume:browser-view-*`);分区常量 `persist:lume-browser`;除此之外逻辑逐行等价。
8. **禁止**:console.*、新增依赖、省略错误分支、把可选链守卫改成非空断言、删除"看似多余"的代际/竞态守卫。
9. 产物顶部块注释:来源文件 + ZCode 原名对照表 + 任何语义偏差(应仅剩命名/平台前缀)。

## 交付

写入指定产物路径;运行 `cd apps/desktop && bunx tsc --noEmit -p tsconfig.json` 不新增错误(全仓尚未接线,允许"文件未被引用"但不能有语法/类型错);附 200 字内报告:产物路径、行数、ZCode 原名对照条数、偏差清单。
