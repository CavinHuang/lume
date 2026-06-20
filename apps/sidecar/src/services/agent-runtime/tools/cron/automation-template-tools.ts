import type { ToolDefinition } from "@lume/agent-sdk";
import type { AutomationCreateJobInput, AutomationSchedule } from "@lume/shared";
import { createAutomationJob, listAutomationJobs } from "../../../automation/automation-manager";
import {
  listAutomationRuns,
  refreshAutomationRunnerJobs,
  startAutomationRunner,
  runAutomationJobNow,
} from "../../../automation/automation-runner-service";
import { createSdkJsonResultTool } from "../sdk-tool-result";

// ─── Template Definitions ───────────────────────────────────────────

interface AutomationTemplate {
  templateId: string;
  name: string;
  description: string;
  prompt: string;
  schedule: AutomationSchedule;
  category: "automation" | "routine";
}

const AUTOMATION_TEMPLATES: readonly AutomationTemplate[] = [
  // ─── 通用自动化模板 ────────────────────────────────────────────
  {
    templateId: "daily-bug-scan",
    name: "每日缺陷扫描",
    description: "扫描最近提交，查找可能的 bug 并提出最小修复方案。",
    prompt:
      "扫描最近的 commit（自上次运行以来，或过去 24 小时内），查找可能的 bug 并提出最小修复方案。依据规则：\n- 只使用仓库中的具体证据（commit SHA、PR、文件路径、diff、失败的测试、CI 信号）。\n- 不要臆造 bug；如果证据不足，请说明并跳过。\n- 优先选择最小且安全的修复；避免重构和无关清理。",
    schedule: { type: "cron", cronExpr: "0 9 * * *" },
    category: "automation",
  },
  {
    templateId: "weekly-release-notes",
    name: "每周版本说明",
    description: "基于已合并 PR 起草每周发布说明。",
    prompt:
      "根据已合并的 PR 起草每周发布说明（如有链接请附上）。范围与依据：\n- 严格以该仓库当周历史记录为限；不要添加超出数据支持的额外部分。\n- 使用 PR 编号/标题；除非仓库中的 PR 描述、测试或指标支持，否则避免对影响作出结论。",
    schedule: { type: "cron", cronExpr: "0 9 * * 1" },
    category: "automation",
  },
  {
    templateId: "standup-summary",
    name: "站会摘要",
    description: "总结昨天的 git 活动，适合团队同步。",
    prompt:
      "为站会总结昨天的 git 活动。依据规则：\n- 陈述应锚定到 commit/PR/文件；不要臆测意图或未来工作。\n- 保持便于快速浏览，并适合团队同步。",
    schedule: { type: "cron", cronExpr: "0 9 * * *" },
    category: "automation",
  },
  {
    templateId: "nightly-ci-report",
    name: "夜间 CI 报告",
    description: "总结 CI 失败和不稳定测试，提出修复建议。",
    prompt:
      "总结上一个 CI 窗口中的 CI 失败和不稳定测试；提出首要修复建议。依据规则：\n- 尽可能引用具体作业、测试、错误信息或日志片段。\n- 避免过度自信地断言根因；区分「已观察到」与「疑似」。",
    schedule: { type: "cron", cronExpr: "0 22 * * *" },
    category: "automation",
  },
  {
    templateId: "daily-classic-game",
    name: "每日经典游戏",
    description: "创建范围尽可能小的经典小游戏。",
    prompt:
      "创建一个范围尽可能小的经典小游戏。约束：\n- 除非必要，否则不要添加额外功能、样式系统、内容或新的依赖项。\n- 复用现有仓库的工具和模式。",
    schedule: { type: "cron", cronExpr: "0 9 * * *" },
    category: "automation",
  },
  {
    templateId: "skill-progression",
    name: "技能进阶图",
    description: "根据近期 PR 和评审建议下一步技能改进。",
    prompt:
      "根据近期 PR 和评审，建议下一步需要深入提升的技能。依据规则：\n- 每条建议都要锚定具体证据（PR 主题、评审意见、反复出现的问题）。\n- 避免空泛建议；每条建议都要可执行且具体。",
    schedule: { type: "cron", cronExpr: "0 9 * * 1" },
    category: "automation",
  },
  {
    templateId: "weekly-eng-summary",
    name: "每周工程摘要",
    description: "汇总本周 PR、发布、故障和评审成每周更新。",
    prompt:
      "将本周的 PR、发布、故障事件和评审汇总成一份每周更新。依据规则：\n- 不要虚构事件；如果数据缺失，请简要说明。\n- 在条件允许时，优先使用具体引用（PR 编号、故障事件 ID、发布说明、文件路径）。",
    schedule: { type: "cron", cronExpr: "0 9 * * 5" },
    category: "automation",
  },
  {
    templateId: "perf-regression",
    name: "性能回归监测",
    description: "对比基准测试或追踪结果，标记性能回归。",
    prompt:
      "将最近的更改与基准测试或追踪结果进行比较，并尽早标记回归。依据规则：\n- 所有判断都应以可测量的信号（基准测试、追踪、耗时、火焰图）为依据。\n- 如果没有测量数据，请注明「未找到测量数据」，不要猜测。",
    schedule: { type: "cron", cronExpr: "0 9 * * *" },
    category: "automation",
  },
  {
    templateId: "dep-sdk-drift",
    name: "依赖项和 SDK 漂移",
    description: "检测依赖项和 SDK 漂移，提出最小对齐方案。",
    prompt:
      "检测依赖项和 SDK 漂移，并提出最小对齐方案。依据规则：\n- 尽可能从仓库中引用当前版本和目标版本（锁文件、包清单文件）。\n- 不要猜测版本；如果目标不明确，请提出可选方案并标明为建议。",
    schedule: { type: "cron", cronExpr: "0 9 * * 1" },
    category: "automation",
  },
  {
    templateId: "issue-triage",
    name: "问题分类",
    description: "分诊新问题，建议负责人、优先级和标签。",
    prompt:
      "分诊新问题；建议负责人、优先级和标签。依据规则：\n- 根据问题内容 + 仓库上下文（CODEOWNERS、涉及区域、以往类似问题）给出建议。\n- 没有明确信号时不要猜测负责人；如不明确，请写「Owner: Unknown」，并改为建议一个团队。",
    schedule: { type: "cron", cronExpr: "0 9 * * *" },
    category: "automation",
  },
  {
    templateId: "changelog-update",
    name: "更新变更日志",
    description: "用本周亮点和关键 PR 链接更新变更日志。",
    prompt:
      "用本周亮点和关键 PR 链接更新变更日志。约束：\n- 仅包含有仓库历史支持的条目。\n- 保持结构简洁，并与现有变更日志格式一致。",
    schedule: { type: "cron", cronExpr: "0 17 * * 5" },
    category: "automation",
  },
  {
    templateId: "dep-security-scan",
    name: "依赖项扫描",
    description: "扫描过时依赖项，提出安全升级方案。",
    prompt:
      "扫描过时的依赖项；以最小改动提出安全升级方案。规则：\n- 优先采用最小可行的升级集合。\n- 明确标出破坏性变更风险和所需迁移。\n- 在未从仓库识别出当前版本前，不要提出升级建议。",
    schedule: { type: "cron", cronExpr: "0 9 * * 1" },
    category: "automation",
  },
  // ─── Routine 活动模板 ────────────────────────────────────────────
  {
    templateId: "routine-data-sync",
    name: "数据同步",
    description: "同步微信读书数据（书架、进度、划线、书签）。",
    prompt:
      "执行微信读书数据同步：同步书架、更新进度、刷新划线和书签。完成后简要汇报同步了哪些数据。",
    schedule: { type: "once", runAt: Date.now() + 60000 },
    category: "routine",
  },
  {
    templateId: "routine-reading-progress",
    name: "读书进度推进",
    description: "推进当前在读书籍的阅读进度。",
    prompt:
      "推进当前在读书籍的阅读进度。使用 lume_reading_snapshot 查看当前在读的书，为每本书按比例推进 progressPercent（模拟每日阅读进度）。如果某本书进度达到 100%，标记为 finished。完成后简要汇报进度变化。",
    schedule: { type: "once", runAt: Date.now() + 60000 },
    category: "routine",
  },
  {
    templateId: "routine-reading-note",
    name: "读书笔记",
    description: "为当前在读的一本书生成读书笔记。",
    prompt:
      "为当前在读的一本书生成一篇读书笔记。使用 lume_reading_snapshot 查看书籍列表，选择一本合适的书，然后调用 lume_write_reading_note 生成笔记。笔记深度根据当前上下文决定。",
    schedule: { type: "once", runAt: Date.now() + 60000 },
    category: "routine",
  },
  {
    templateId: "routine-memory-organize",
    name: "记忆整理",
    description: "整理近期记忆，提取关键事实，去重分类。",
    prompt:
      "整理近期记忆。查看最近的对话和记忆条目，提取关键事实，去重、分类、写入记忆系统。完成后简要汇报整理了哪些记忆。",
    schedule: { type: "once", runAt: Date.now() + 60000 },
    category: "routine",
  },
  {
    templateId: "routine-todo-review",
    name: "待办提醒",
    description: "检查用户对话中提取的待办事项，生成优先级提醒列表。",
    prompt:
      "检查用户对话中提取的待办事项。搜索记忆中的待办条目，按优先级排序，生成一份待办提醒列表。如果所有待办都已完成，简要确认即可。",
    schedule: { type: "once", runAt: Date.now() + 60000 },
    category: "routine",
  },
  {
    templateId: "routine-interest-digest",
    name: "兴趣资讯",
    description: "根据用户兴趣搜索并聚合资讯，筛选推荐内容。",
    prompt: "根据用户兴趣搜索并聚合资讯，筛选 3-5 条推荐。",
    schedule: { type: "once", runAt: Date.now() + 60000 },
    category: "routine",
  },
  {
    templateId: "routine-work-overview",
    name: "工作概览",
    description: "生成今日工作概览（仅工作日）。",
    prompt:
      "生成今日工作概览。检查近期 git 提交、项目状态，生成一份简短的工作日报。",
    schedule: { type: "once", runAt: Date.now() + 60000 },
    category: "routine",
  },
  {
    templateId: "routine-daily-summary",
    name: "每日总结",
    description: "汇总今天的日程执行结果，生成简短总结。",
    prompt:
      "汇总今天的日程执行结果。查看今天完成了哪些活动，生成一段简短的每日总结。",
    schedule: { type: "once", runAt: Date.now() + 60000 },
    category: "routine",
  },
  {
    templateId: "routine-weekly-summary",
    name: "每周总结",
    description: "生成本周总结（仅周日）。",
    prompt:
      "生成本周总结。汇总本周读书进度、笔记数量、记忆增长、待办完成情况，输出一篇结构化的周报。",
    schedule: { type: "once", runAt: Date.now() + 60000 },
    category: "routine",
  },
];

const VALID_TEMPLATE_IDS = new Set(AUTOMATION_TEMPLATES.map((t) => t.templateId));

// ─── Helpers ────────────────────────────────────────────────────────

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function findTemplate(templateId: string): AutomationTemplate {
  const template = AUTOMATION_TEMPLATES.find((t) => t.templateId === templateId);
  if (!template) throw new Error(`模板不存在: ${templateId}`);
  return template;
}

async function syncRunnerJobs(): Promise<void> {
  await startAutomationRunner();
  await refreshAutomationRunnerJobs();
}

// ─── Tool ──────────────────────────────────────────────────────────

export function createAutomationTemplateTools(_input: { workspaceId?: string }): ToolDefinition[] {
  return [
    createSdkJsonResultTool({
      name: "automation_template",
      description:
        "查看和使用自动化任务模板。list 列出所有可用模板（通用自动化 + 日程活动），create 用模板一键创建任务。",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "create"] },
          templateId: { type: "string" },
          name: { type: "string" },
          prompt: { type: "string" },
          cronExpr: { type: "string" },
          runAt: { type: "number" },
          intervalMs: { type: "number" },
          enabled: { type: "boolean" },
        },
        required: ["action"],
      },
      async call(input) {
        const action = asString(input.action);
        if (!action) throw new Error("action 必填");
        if (action !== "list" && action !== "create") {
          throw new Error(`不支持的 action: ${action}，支持 list | create`);
        }

        if (action === "list") {
          const templates = AUTOMATION_TEMPLATES.map((t) => ({
            templateId: t.templateId,
            name: t.name,
            description: t.description,
            prompt: t.prompt,
            schedule: t.schedule,
            category: t.category,
          }));
          return { ok: true, templates };
        }

        const templateId = asString(input.templateId);
        if (!templateId) throw new Error("create 需要 templateId");
        if (!VALID_TEMPLATE_IDS.has(templateId)) {
          throw new Error(`模板不存在: ${templateId}，请先调用 automation_template list 查看可用模板`);
        }

        const template = findTemplate(templateId);
        const name = asString(input.name) ?? template.name;
        const prompt = asString(input.prompt) ?? template.prompt;

        let schedule: AutomationSchedule;
        if (asString(input.cronExpr) && template.schedule.type === "cron") {
          schedule = { type: "cron", cronExpr: asString(input.cronExpr)! };
        } else if (asNumber(input.runAt) !== undefined && template.schedule.type === "once") {
          schedule = { type: "once", runAt: asNumber(input.runAt)! };
        } else if (asNumber(input.intervalMs) !== undefined && template.schedule.type === "interval") {
          schedule = { type: "interval", intervalMs: asNumber(input.intervalMs)! };
        } else {
          schedule = { ...template.schedule };
        }

        const jobInput: AutomationCreateJobInput = {
          name,
          prompt,
          schedule,
          enabled: asBoolean(input.enabled) ?? true,
          source: "manual",
        };

        const created = createAutomationJob(jobInput);
        await syncRunnerJobs();
        return { ok: true, action: "create", job: created };
      },
    }),
  ];
}
