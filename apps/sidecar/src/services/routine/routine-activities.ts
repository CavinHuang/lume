import type { AutomationCreateJobInput, RoutineActivity, RoutineContext, RoutineEntry } from "@lume/shared"

export interface RoutineActivityExecutor {
  activity: RoutineActivity
  shouldInclude(context: RoutineContext): boolean
  buildJobInput(entry: RoutineEntry, context: RoutineContext): AutomationCreateJobInput
  estimatedMinutes: number
}

const executors: RoutineActivityExecutor[] = [
  {
    activity: "data_sync",
    shouldInclude(ctx) {
      return ctx.lastSyncAt == null || Date.now() - ctx.lastSyncAt >= 6 * 3600_000
    },
    buildJobInput(entry, _ctx) {
      return {
        name: "数据同步",
        prompt: "执行微信读书数据同步：同步书架、更新进度、刷新划线和书签。完成后简要汇报同步了哪些数据。",
        schedule: { type: "once", runAt: entry.scheduledAt },
        enabled: true,
      }
    },
    estimatedMinutes: 2,
  },
  {
    activity: "reading_progress",
    shouldInclude(ctx) {
      return ctx.activeBooks > 0
    },
    buildJobInput(entry, _ctx) {
      return {
        name: "读书进度推进",
        prompt: "推进当前在读书籍的阅读进度。使用 lume_reading_snapshot 查看当前在读的书，为每本书按比例推进 progressPercent（模拟每日阅读进度）。如果某本书进度达到 100%，标记为 finished。完成后简要汇报进度变化。",
        schedule: { type: "once", runAt: entry.scheduledAt },
        enabled: true,
      }
    },
    estimatedMinutes: 1,
  },
  {
    activity: "reading_note",
    shouldInclude(ctx) {
      return ctx.activeBooks > 0 && ctx.recentNotes < 4
    },
    buildJobInput(entry, _ctx) {
      return {
        name: "读书笔记",
        prompt: "为当前在读的一本书生成一篇读书笔记。使用 lume_reading_snapshot 查看书籍列表，选择一本合适的书，然后调用 lume_write_reading_note 生成笔记。笔记深度根据当前上下文决定。",
        schedule: { type: "once", runAt: entry.scheduledAt },
        enabled: true,
      }
    },
    estimatedMinutes: 2,
  },
  {
    activity: "book_discover",
    shouldInclude(ctx) {
      // 仅当「无在读」且「无 queued 待读」时触发：完全没书可读才去发现新书。
      // 有在读/待读时由 reading_progress / reading_note / pick_next 覆盖。
      return ctx.activeBooks === 0 && ctx.queuedBooks === 0
    },
    buildJobInput(entry, _ctx) {
      return {
        name: "发现新书",
        prompt:
          "当前书库没有在读或待读的书，需要为用户挑选下一本要读的书。" +
          "先调用 lume_reading_snapshot 查看已读书目、笔记与偏好画像；" +
          "再推荐一本与用户兴趣契合、且容易获取的书（优先公共领域或广可获取的作品，避免冷门或难寻的版本）。" +
          "然后用 lume_add_book 把推荐的书加入书架（status 必须设为 queued），" +
          "紧接着调用 lume_reading_pick_next 把它从 queued 晋升为 reading，让后续读书活动恢复。" +
          "最后简要说明推荐理由。如果实在没有合适的推荐，请明确说明，不要凭空捏造书名或作者。",
        schedule: { type: "once", runAt: entry.scheduledAt },
        enabled: true,
      }
    },
    estimatedMinutes: 2,
  },
  {
    activity: "memory_organize",
    shouldInclude(ctx) {
      return ctx.pendingMemories > 0
    },
    buildJobInput(entry, _ctx) {
      return {
        name: "记忆整理",
        prompt: "整理近期记忆。查看最近的对话和记忆条目，提取关键事实，去重、分类、写入记忆系统。完成后简要汇报整理了哪些记忆。",
        schedule: { type: "once", runAt: entry.scheduledAt },
        enabled: true,
      }
    },
    estimatedMinutes: 3,
  },
  {
    activity: "todo_review",
    shouldInclude(ctx) {
      return ctx.unfinishedTodos > 0
    },
    buildJobInput(entry, _ctx) {
      return {
        name: "待办提醒",
        prompt: "使用 PlanningTodoList 和 PlanningTodoGet 检查持久化 Planning Todo，按优先级和截止时间生成一份待办提醒列表。如果所有待办都已完成，简要确认即可。不要读取 Memory 来代替 Planning Todo。",
        schedule: { type: "once", runAt: entry.scheduledAt },
        enabled: true,
      }
    },
    estimatedMinutes: 1,
  },
  {
    activity: "interest_digest",
    shouldInclude(_ctx) {
      return false
    },
    buildJobInput(entry, _ctx) {
      return {
        name: "兴趣资讯",
        prompt: "根据用户兴趣搜索并聚合资讯，筛选 3-5 条推荐。",
        schedule: { type: "once", runAt: entry.scheduledAt },
        enabled: true,
      }
    },
    estimatedMinutes: 2,
  },
  {
    activity: "work_overview",
    shouldInclude(ctx) {
      return ctx.dayOfWeek >= 1 && ctx.dayOfWeek <= 5
    },
    buildJobInput(entry, _ctx) {
      return {
        name: "工作概览",
        prompt: "生成今日工作概览。检查近期 git 提交、项目状态，生成一份简短的工作日报。",
        schedule: { type: "once", runAt: entry.scheduledAt },
        enabled: true,
      }
    },
    estimatedMinutes: 2,
  },
  {
    activity: "daily_summary",
    shouldInclude(_ctx) {
      return true
    },
    buildJobInput(entry, _ctx) {
      return {
        name: "每日总结",
        prompt: "汇总今天的日程执行结果。查看今天完成了哪些活动，生成一段简短的每日总结。",
        schedule: { type: "once", runAt: entry.scheduledAt },
        enabled: true,
      }
    },
    estimatedMinutes: 1,
  },
  {
    activity: "weekly_summary",
    shouldInclude(ctx) {
      return ctx.dayOfWeek === 0
    },
    buildJobInput(entry, _ctx) {
      return {
        name: "每周总结",
        prompt: "生成本周总结。汇总本周读书进度、笔记数量、记忆增长、待办完成情况，输出一篇结构化的周报。",
        schedule: { type: "once", runAt: entry.scheduledAt },
        enabled: true,
      }
    },
    estimatedMinutes: 3,
  },
]

export function getActivityExecutor(activity: RoutineActivity): RoutineActivityExecutor | undefined {
  return executors.find((e) => e.activity === activity)
}

export function getApplicableActivities(context: RoutineContext): RoutineActivityExecutor[] {
  return executors.filter((e) => e.shouldInclude(context))
}
