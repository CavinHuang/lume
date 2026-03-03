# Personal AI Assistant 对齐实施规划（Lume）

> 日期：2026-03-02  
> 输入文档：`docs/Personal_AI_Assistant_产品设计文档.md`  
> 目标：将当前 Lume 从“Agent 基座可用”推进到“产品文档能力可交付”

---

## 1. 当前状态与差距结论

### 已具备（可复用基座）
- Chat/Agent 双模式与会话体系
- Agent 执行流（Plan/Review/Execute + Tool 活动流）
- 本地优先记忆体系（memory_search/get/save + 索引）
- 浏览器自动化（Playwright + Relay Extension）

### 核心缺口（必须补齐）
- 定时任务中心（创建/编辑/暂停/执行记录）
- 工作流编排与执行引擎（多步骤、可重试、可恢复）
- 主动提醒与通知闭环（规则触发 -> 提醒 -> 用户动作）
- 垂直连接器（邮箱/日历/Jira/Git 等）
- 场景化能力产品化（文件管家、调研助手、日报周报）
- 新手引导（首次启动、配置引导、首个任务）
- 业务指标与可观测性（任务成功率、留存、提醒触达）

---

## 2. 对齐原则

1. 先补“调度与执行中台”，再堆场景能力。  
2. 所有跨层能力先建 shared contract，再接 sidecar 与 web。  
3. 优先做可验证闭环（创建 -> 执行 -> 结果 -> 追踪），避免只做 UI。  
4. 每个阶段至少提供 1 条端到端 smoke path。  
5. 不破坏现有 Chat/Agent 主流程；新能力通过增量入口接入。

---

## 3. 分阶段路线图

## Phase A（2-3 周）：任务调度与提醒基座

### A1. 调度域模型与存储
- 新增 shared contracts：
  - `TaskSchedule`（cron/once/interval）
  - `AutomationJob`（定义）
  - `AutomationRun`（执行记录）
  - `TriggerEvent`（文件变化/时间触发/手动触发）
- sidecar 新增：
  - `automation-manager.ts`（任务定义增删改查）
  - `automation-runner-service.ts`（调度 + 执行）
  - `notification-service.ts`（统一通知出口）
- 存储：
  - `~/.lume/automation/jobs.json`
  - `~/.lume/automation/runs/*.jsonl`

### A2. UI 最小闭环
- web 新增“定时任务”面板：
  - 列表、创建、启停、立即执行、最近运行状态
- 在 Agent 输出中支持“一键保存为任务”

### A3. 验收标准
- 能创建“每天 08:30 执行日报准备”任务
- 应用重启后任务仍在
- 至少有成功/失败运行记录与可读错误

---

## Phase B（2-4 周）：工作流编排与可恢复执行

### B1. 工作流 DSL（MVP）
- Step 类型：
  - `agent_prompt`
  - `browser_action`
  - `file_action`
  - `http_fetch`
  - `notify_user`
- 控制结构：
  - 顺序执行
  - 失败重试（次数/退避）
  - 条件分支（基于上一步结果）

### B2. 执行引擎
- `workflow-engine-service.ts`
- 运行时状态机：
  - pending -> running -> paused/failed/completed
- 恢复机制：
  - 崩溃重启后恢复到上次 checkpoint

### B3. UI
- 工作流详情页：
  - 可视步骤、当前步骤、日志、重试/终止按钮

### B4. 验收标准
- 完成“下载文件夹整理工作流”
- 中途中断后可恢复继续
- 失败步骤可单步重试

---

## Phase C（2-3 周）：文档核心场景产品化

### C1. 场景模板（内置）
- 智能文件管家（分类/重命名/去重）
- 智能调研助手（搜索/汇总/导出）
- 每日日报准备（Git + 任务系统 + 日历摘要）

### C2. 能力连接器（MVP）
- Git 本地仓库连接器（已天然可做，优先）
- 日历连接器（先 ICS/本地日历读）
- 邮件连接器（先 IMAP read-only）

### C3. 验收标准
- 3 个模板都能一键创建并执行
- 每个模板有可见结果产物（报告/归档目录/摘要）

---

## Phase D（2 周）：主动服务与新手引导

### D1. 主动提醒
- 规则中心（时间规则 + 任务前置条件）
- 提醒卡片（执行建议按钮）
- 通知与会话联动（点击通知跳转对应会话）

### D2. 新手引导
- 首次启动向导：
  - 模式说明
  - 模型/API 配置
  - 首个任务演示（Chat + Agent 各一条）

### D3. 验收标准
- 首次安装 5 分钟内完成可用配置并跑通首个任务
- 主动提醒可触发并可执行后续动作

---

## 4. 模块拆分建议（按现有架构）

### `packages/shared`
- `automation/types.ts`
- `automation/schemas.ts`
- `automation/constants.ts`

### `apps/sidecar`
- `services/automation/automation-manager.ts`
- `services/automation/automation-runner-service.ts`
- `services/automation/workflow-engine-service.ts`
- `services/notification/notification-service.ts`
- `services/connectors/{git,calendar,email}-service.ts`

### `apps/web`
- `components/automation/AutomationCenter.tsx`
- `components/automation/AutomationEditor.tsx`
- `components/automation/AutomationRuns.tsx`
- `components/onboarding/OnboardingWizard.tsx`
- `atoms/automation-atoms.ts`

### `apps/desktop`
- 桥接系统通知能力（若需 Tauri plugin 则封装到 desktop bridge）

---

## 5. 优先级与交付顺序（建议）

1. 调度/运行记录（Phase A）  
2. 工作流引擎（Phase B）  
3. 文件管家 + 调研助手模板（Phase C 部分）  
4. 主动提醒（Phase D 部分）  
5. 邮件/日历连接器扩展（Phase C/D 继续）

---

## 6. 风险与控制

### 风险 1：范围过大，交付节奏失控
- 控制：每阶段仅 1-2 条主流程闭环，其他能力模板化挂载。

### 风险 2：模型不稳定导致自动化失败率高
- 控制：步骤级重试 + 可人工接管 + 失败可诊断日志。

### 风险 3：主动提醒打扰用户
- 控制：默认低频 + 用户可全局静默 + 规则分级。

### 风险 4：连接器安全与凭证管理
- 控制：凭证统一走 secret 存储，日志脱敏，最小权限默认。

---

## 7. 里程碑定义（DoD）

### M1（Phase A 完成）
- 定时任务可创建、执行、查看记录、重启恢复
- 有 smoke：`create task -> run -> result`

### M2（Phase B 完成）
- 工作流可视执行、失败重试、checkpoint 恢复
- 有 smoke：`workflow with 3+ steps`

### M3（Phase C 完成）
- 文件管家/调研助手/日报准备模板可用
- 有 smoke：模板端到端跑通

### M4（Phase D 完成）
- 主动提醒与新手引导上线
- 首次用户激活路径可量化

---

## 8. 第一批落地任务（可直接开工）

1. 定义 shared automation contracts + zod schemas。  
2. sidecar 实现 `automation-manager`（CRUD + 持久化）。  
3. sidecar 实现 `automation-runner`（cron + once + run log）。  
4. web 增加“定时任务”列表与创建弹窗。  
5. 增加 smoke 用例：创建任务并验证运行记录。  
6. 在 Agent 结果区增加“保存为任务”入口（最小形态）。

---

## 9. 当前实施进度（2026-03-02）

- [x] shared automation contracts（`AutomationJob` + IPC channels）
- [x] sidecar `automation-manager`（CRUD + 原子写 + 损坏索引备份）
- [x] sidecar RPC 接线（list/create/update/delete）
- [x] web `desktop-api` 自动化接口封装
- [x] web 设置页最小任务中心（列表/创建/启停/删除，Cron MVP）
- [x] `automation-runner-service`（定时触发 + run log，MVP）
- [x] “立即执行”与最近运行记录 UI
- [x] Agent 结果区“保存为任务”入口
