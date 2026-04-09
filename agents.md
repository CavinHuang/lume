# Lume Engineering Rules (`agents.md`)

## 1. Priority
1. Direct user instruction.
2. This `agents.md`.
3. Existing docs, specs, and plans.
4. Personal preference.

冲突时按更高优先级执行。

## 2. Core Principle
1. 以落地为导向，优先交付可运行结果，不做过度设计。
2. 能直接修改并验证的任务，不先长篇讨论。
3. 默认先推进最小可行方案，再在真实结果上迭代。
4. 不为了“看起来严谨”而拖慢节奏，不反复空转、细磨、兜圈子。

## 3. Execution Behavior
1. 收到明确任务后，先检查上下文，然后直接动手。
2. 只有在会导致错误方向、数据破坏、或明显返工时，才停下来确认。
3. 不把用户已经决定的事情重新拿出来讨论。
4. 遇到不确定点时，优先选风险最低且可验证的方案继续推进。
5. 任务过程中持续同步关键进展，但不要用无信息量的话刷屏。
6. 除非用户要求，只汇报结论、风险、阻塞和下一步，不写大段过程表演。

## 4. Architecture Boundaries
1. 保持目标架构：`Tauri desktop + Next.js web + Bun sidecar + shared packages`。
2. `apps/desktop` 只负责 shell、bridge、native lifecycle。
3. `apps/web` 只负责 UI，不直接访问 filesystem 或 system API。
4. `apps/sidecar` 负责 agent orchestration、storage、provider/runtime logic。
5. `packages/shared` 只放共享 contracts、schemas、constants、pure helpers。
6. 跨层通信必须走显式 contract，禁止业务逻辑重复散落在多个 app。

## 5. Migration Rules
1. Proma -> Lume 迁移优先复用已验证实现，不轻易重写。
2. 先保行为一致，再做重构和清理。
3. 迁移文件保留简短头注释：来源路径 + 适配说明。
4. 不把 Electron 假设带进 Tauri/sidecar 架构。
5. 不无声改变用户可见行为。

## 6. Code Rules
1. 保持 TypeScript strict，不随意引入 `any`。
2. 命名要贴近领域语义，避免临时、模糊、误导性名字。
3. 函数只做一件事；逻辑分支明显变复杂时就拆。
4. pure logic 和 side effects 分开。
5. shared contract 只放在 `packages/shared`。
6. 注释只解释为什么，不解释显而易见的代码。
7. 日志和用户文案以中文为主，必要技术词保留英文。

## 7. Safety and Data
1. 风险操作默认拒绝，权限绕过必须显式。
2. 所有路径操作都要做 normalize 和 allowed-root 校验。
3. Secrets 不得明文存储、明文日志输出、或暴露到 UI。
4. JSON/JSONL 写入必须原子或可恢复。
5. 持久化结构从第一天开始带 version。

## 8. Quality Bar
1. 改动必须能在目标架构下端到端工作。
2. 新核心逻辑默认补至少一个自动化测试；如果不补，要有明确理由。
3. 关键路径优先保 smoke：
   - create workspace
   - chat send/stream
   - agent send/stream
   - restart restore
4. 不在已有回归未修复的区域继续堆新功能。
5. 错误不能静默吞掉，边界处尽量返回结构化错误。

## 9. Frontend Constraint
1. 复用已有 primitives，不复制 UI 逻辑。
2. 共享状态放 atoms/store，不分散在多处局部 state。
3. Streaming UI 不能阻塞输入和导航。
4. Renderer 不直接调用 native API，统一走 desktop bridge。
5. Agent 消息列表在 `streaming -> final` 提交时必须保持稳定，不允许因为整表 reload 或 temp/final 切换造成明显抖动。

## 10. Change and Commit
1. 改动保持小而可审查，避免把无关问题卷进同一任务。
2. 行为或 contract 变化时同步更新相关文档。
3. 延后事项必须明确记录，不能默默丢掉。
4. git commit message 必须：
   - 使用中文
   - 符合 conventional commit
   - 包含 emoji
   - 描述具体修改内容
   - 不使用“更新”“修改”这类模糊表述
