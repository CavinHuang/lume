# 事件总线生产加固实施计划(F3-F8 + 减配收口)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把批次5 终审遗留的 F3-F8 功能缺口与已知减配全部收口到生产可用。

**Architecture:** 独立加固分支(非批次制):F3 终值缺口(P1)是唯一语义修复,其余为清理/收编/测试基建;减配三项(compaction 真值/outcome 条件携带/preload)按成本效益逐项裁定做或不做。

**Spec:** `docs/superpowers/specs/2026-08-15-agent-event-bus-design.md`(§9 遗留清单)

## Global Constraints

- 投影与 UI 零改动铁律继续(经适配器)
- commit emoji + `Co-Authored-By: Claude <noreply@anthropic.com>`
- 分支 `fix/event-bus-hardening`(基于 #107 后 main @53aafd88)
- 每任务先跑基线

## 已知事实

- F3 位置:`apps/sidecar/src/services/agent-runtime/runner/lume-runner.ts`(fail 路径);run 链内 createRuntimeCoreSession throw 时 projector 未开 run → 无总线 run.end;attempt.ts:910 二次 onError 带 fromActiveRun 抑制合成
- F4 双读:web 重开线程走 hydrate(listThreadRuntimeEvents)+快照(get-events);保留类历史在源 A
- F5 死条目:`apps/desktop/src/renderer-allowlist.ts` LOCAL 增量;契约测试 `electron-security.test.mjs`
- F6 同名:`runtime-core/coding-run-tracker.ts:999` normalizeBackgroundTaskStatus
- F7:sidecar test:unit 组合跑 mock 污染;单文件绿
- 减配:compaction trigger 恒 'auto'(projector 未带);outcome 恒带;preload 手写

---

### Task 1: F3 终值缺口(P1)

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runner/lume-runner.ts`(fail/createRuntimeCoreSession catch)
- Test: `apps/sidecar/src/services/agent-runtime/runner/lume-runner.test.ts`(追加)

- [ ] 失败测试:①createRuntimeCoreSession throw → 总线收到 run.end{isError:true, stopReason:'error'}(且 fromActiveRun 抑制下 web 仍有终值)②run 中途抛错 → run.end 标 error 而非 aborted(projector post-loop 补发处区分:流正常结束无 result=aborted;流抛错=error——读 projector 现状,若区分不可行则 LumeRunner.fail 补发)
- [ ] 实现:LumeRunner.fail / createRuntimeCoreSession catch 补 bus.publish run.end{isError}(与 post-loop aborted 互斥——同一 run 只一个终值)
- [ ] commit `🐛 fix: F3 run 链内失败补总线终值,消除静默失败`

### Task 2: F5+F6 清理(P3,批量)

**Files:**
- Modify: `apps/desktop/src/renderer-allowlist.ts`(删 3 死条目)
- Modify: `packages/shared/src/types/renderer-allowlist.ts`(导出本地增量)
- Modify: `apps/desktop/scripts/electron-security.test.mjs`(契约升级双向 ==)
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/coding-run-tracker.ts`(同名改 normalizeCodingExitStatus)

- [ ] 死条目删除+契约双向化(本地增量导出后 == 断言)+F6 改名(grep 调用点全改)
- [ ] `bun run verify:computer-use`+定向
- [ ] commit `🧹 chore: F5 死条目+契约双向化;F6 同名归一改名`

### Task 3: 减配收口(逐项裁定执行)

**Files:**
- Modify: `packages/sdk/src/events/lifecycle-projector.ts`(compaction trigger 真值)
- Modify: `packages/shared/src/types/agent-events.ts`(ContextCompactionDetail.trigger 语义注释)

- [ ] ①compaction trigger 真值:projector 从 compaction 消息的 trigger 字段(manual/auto)透传——读 engine.ts compaction 工厂确认字段名;缺省 'auto'
- [ ] ②outcome 条件携带:projector 仅 boundary 带值(现恒带——查 T2 实现的省略逻辑是否已对,不对则改)
- [ ] ③preload 单源:**裁定不做**(非 TS bundle 物化风险>收益,守卫测试在)——报告记录
- [ ] 测试:trigger 两态(manual/auto)/outcome 条件
- [ ] commit `✨ feat: compaction trigger 真值透传+outcome 条件携带`

### Task 4: F7 测试隔离(P2)

**Files:**
- Modify: `apps/sidecar/package.json`(test:unit 脚本)

- [ ] 方案:run-unit-tests.mjs 改逐文件隔离子进程(或 bun test --preload 清 mock;选最小:逐文件 spawn,并行度 4)——读现有脚本结构改
- [ ] 验证:整目录跑零污染(基线对比)
- [ ] commit `🧪 test: F7 sidecar 测试逐文件隔离`

### Task 5: F4 存储收尾(P2,方案落地)

**Files:**
- Modify: `apps/sidecar/src/rpc/agent-handlers.ts`(GET_THREAD_RUNTIME_EVENTS 保留类过滤)
- Modify: `apps/web/src/hooks/useGlobalAgentListeners.ts`(hydrate 路径)

- [ ] ①**双读到单读的分界落地**:新线程(kickoff 在 #107 后)只读 events.jsonl 快照;旧线程(hydrate 有数据)继续双读——判定信号:events.jsonl 存在且有骨架事件(而非硬编码时间)
- [ ] ②GET_THREAD_RUNTIME_EVENTS 保留类过滤(已迁类不再投影——T7a 已删 live,hydrate 的已迁类投影是幽灵残留,补删)——**注意**:旧线程历史展示依赖它,改为只投保留类
- [ ] 测试:双读分界/保留类投影
- [ ] commit `♻️ refactor: F4 存储双读收口——新线程单读总线+hydrate 保留类过滤`
- [ ] **注**:GET_THREAD_RUNTIME_EVENTS 完全下线留观察期(旧线程存续期),本批不做

### Task 6: 回归+终审+PR

- [ ] 四包全量+typecheck
- [ ] 整分支终审(opus)
- [ ] PR(base=main)
