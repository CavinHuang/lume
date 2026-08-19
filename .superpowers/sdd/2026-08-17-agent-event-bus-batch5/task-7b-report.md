# Task 7b 报告:白名单单源派生 + status 归一三收一

状态:**完成**。commit:`♻️ refactor: 白名单单源派生+status 归一收编`(本 commit)。

## 改动一:白名单单源派生

**新文件** `packages/shared/src/types/renderer-allowlist.ts`:
- 导出 `SHARED_RENDERER_SIDECAR_METHODS: ReadonlySet<string>`,由 20 个 `*_IPC_CHANNELS` 常量(AGENT/AUTOMATION/CHANNEL/DESKTOP_CONTEXT/GENERAL_SETTINGS/GITHUB_RELEASE/IM/LUME_CONFIG/MEMORY/MODEL_META/PERSONA/PLANNING_TODO/READING/ROUTINE/RUNTIME/SUGGESTION/SYSTEM_CONFIG/UI_STATE/WEREAD/WIKI)派生。
- 派生规则与契约测试 `apps/desktop/scripts/electron-security.test.mjs` 逐字一致:排除通知类 key(CHANGED/REMINDER_DUE/EVENTS)、`:privileged-` 值、BROWSER_IPC_CHANNELS 成员;PLUGIN_PACKAGE_PRIVILEGED 与 AGENT_ISLAND 两常量不入 source。
- 未放 agent.ts 的原因:agent.ts 被 lume-config.ts/memory.ts 反向依赖,聚合全模块会成环;独立叶子模块零环。经 `packages/shared/src/types/index.ts` barrel 再导出。
- **契约测试零改动仍绿**(57 pass):它继续从 namespace 独立重派生并断言 PUBLIC ⊇ 派生集——未来新增 `*_IPC_CHANNELS` 常量而漏配 renderer-allowlist source 列表时,契约测试会红,是绊线而非套套逻辑。

**改写** `apps/desktop/src/renderer-sidecar-methods.ts`(397 行手写清单 → 40 行):
- `PUBLIC_RENDERER_SIDECAR_METHODS = new Set([...SHARED_RENDERER_SIDECAR_METHODS, ...LOCAL_RENDERER_SIDECAR_METHODS])`。
- 本地增量 25 项(link:* 16、browser 只读 4、agent coding 3、lume-config:changed、healthcheck),逐项注明留在本地的理由。
- 用 diff 脚本验证新 PUBLIC 与旧手写清单**成员逐一相等**(372 派生 + 25 本地 = 397)。
- desktop 引 shared 用相对路径 `../../../packages/shared/src/...`(仓库既有约定,desktop 无 @lume/shared workspace dep,避免动安装图)。

**preload.ts 的 ALLOWED_RENDERER_EVENT_CHANNELS 不动**(按任务指示:非 TS bundle,风险不匹配;其守卫测试 `preload allowlists stay in sync` 原样保留)。

## 改动二:status 归一三收一

**shared** `packages/shared/src/types/runtime-event.ts`:紧贴 `BackgroundTaskCompletedRuntimeStatus` 新增

```ts
export function normalizeBackgroundTaskStatus(raw: string): BackgroundTaskCompletedRuntimeStatus | undefined
```

(killed→stopped、canceled→cancelled、其余 undefined;返回类型即两处消费端 union,结构同一)。

三处收编:
1. `apps/sidecar/.../runner/run-item-events.ts`:删本地 `normalizeBackgroundTaskStatus`(unknown 入参);调用点改为 `typeof record.status === "string" ? normalizeBackgroundTaskStatus(...) : undefined`(语义等价)。**T7a 后此处仍有用点**——`projectBackgroundTaskNotificationRuntimeEvent` 是裁定保留类(background.task.completed RuntimeEvent)路径,故三收一成立、非两收一。
2. `packages/sdk/src/events/lifecycle-projector.ts`:删本地 `normalizeTaskNotificationStatus`,import shared。
3. `apps/sidecar/.../runtime-core/run.ts`:删本地 `normalizeTaskNotificationBusStatus`(连同其 parity 注释),import shared。

**未收编**:`coding-run-tracker.ts:999` 的 `normalizeBackgroundTaskStatus` 是**不同语义**(aborted→stopped、默认→failed、无 cancelled/undefined),不属同语义三份,保持原样。

## 验证

- `bun test packages/shared/src/types/renderer-allowlist.test.ts`(新增):4 pass——派生含公共 agent 通道、排除通知/privileged/browser;归一四态+别名+丢弃。
- `bun test apps/desktop/scripts/electron-security.test.mjs`:57 pass 0 fail(零改动)。
- `bun run verify:computer-use:portable`(根):全部通过(含 @lume/shared / desktop / sidecar / web 四包 typecheck)。
- `bun run --filter @lume/agent-sdk typecheck`:通过(sdk 也被触碰,超出任务清单补跑)。
- 定向:`lifecycle-projector.test.ts` + `run-item-events.test.ts` + `run-loop.test.ts` 58 pass;`run.task-notification-bus.test.ts` + `run.delegate.test.ts` 34 pass。
- `runtime-core/run.test.ts` 有 7±1 失败(5-9s 超时/MCP/browser 环境型):**stash 基线对照同样失败且失败名单逐次漂移**,确认为既有环境性失败非本次回归(符合 MEMORY 的 CI 平台测试长期红基线判断法)。

## Concerns / Follow-ups

1. `agent:revert-coding-file` / `agent:revert-coding-run` / `agent:rewind-coding-turn` 全仓仅白名单一处引用(无 handler、无调用方),疑为死条目;按"只清自己的 mess"原则保留在本地增量,建议单独 commit 删除。
2. `link:*` 16 个通道无 shared 常量——若后续建 `LINK_IPC_CHANNELS` 可并入派生源,本地增量再减。
3. 未来新增 `*_IPC_CHANNELS` 导出常量时必须同步 `renderer-allowlist.ts` 的 source 列表,契约测试会拦(红即漏配)。
