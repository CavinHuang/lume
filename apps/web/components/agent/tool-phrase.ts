/**
 * 工具语义化短语 — 将工具名 + input 转换为人类可读的进行时描述
 *
 * 用于 ContentBlock 等组件中，以 "正在读取文件…" 代替 "Read(file_path=...)"
 */

type PhraseEntry = {
  /** 进行时短语（流式/运行中显示） */
  active: string;
  /** 完成时短语 */
  done: string;
  /** 根据 input 动态生成更具体的描述，返回 null 则回退到 active */
  describe?: (input: Record<string, unknown>) => string | null;
};

const PHRASES: Record<string, PhraseEntry> = {
  // 文件操作
  read: {
    active: "读取文件",
    done: "已读取文件",
    describe: (input) => {
      const fp = asString(input.file_path ?? input.filePath);
      return fp ? `读取 ${basename(fp)}` : null;
    },
  },
  write: {
    active: "写入文件",
    done: "已写入文件",
    describe: (input) => {
      const fp = asString(input.file_path ?? input.filePath);
      return fp ? `写入 ${basename(fp)}` : null;
    },
  },
  edit: {
    active: "编辑文件",
    done: "已编辑文件",
    describe: (input) => {
      const fp = asString(input.file_path ?? input.filePath);
      return fp ? `编辑 ${basename(fp)}` : null;
    },
  },
  multiedit: {
    active: "批量编辑",
    done: "已批量编辑",
  },

  // 搜索
  grep: {
    active: "搜索代码",
    done: "已搜索代码",
    describe: (input) => {
      const p = asString(input.pattern);
      return p ? `搜索 /${p.length > 30 ? `${p.slice(0, 30)}…` : p}/` : null;
    },
  },
  glob: {
    active: "查找文件",
    done: "已查找文件",
    describe: (input) => {
      const p = asString(input.pattern);
      return p ? `查找 ${p}` : null;
    },
  },
  find: { active: "搜索目录", done: "已搜索目录" },
  ls: { active: "列出目录", done: "已列出目录" },

  // 终端
  bash: {
    active: "执行命令",
    done: "已执行命令",
    describe: (input) => {
      const cmd = asString(input.command);
      if (!cmd) return null;
      const short = cmd.length > 40 ? `${cmd.slice(0, 40)}…` : cmd;
      return `执行 \`${short}\``;
    },
  },

  // Agent / 子任务
  task: { active: "派发子任务", done: "子任务完成" },
  agent: { active: "启动子 Agent", done: "子 Agent 完成" },
  sessions_spawn: { active: "创建子线程", done: "子线程完成" },
  skill: { active: "调用技能", done: "技能调用完成" },

  // 网络
  web_search: {
    active: "搜索网页",
    done: "已搜索网页",
    describe: (input) => {
      const q = asString(input.query);
      return q ? `搜索 "${q.length > 30 ? `${q.slice(0, 30)}…` : q}"` : null;
    },
  },
  web_fetch: {
    active: "获取网页",
    done: "已获取网页",
    describe: (input) => {
      const url = asString(input.url);
      return url ? `获取 ${url.length > 40 ? `${url.slice(0, 40)}…` : url}` : null;
    },
  },

  // 控制
  askuserquestion: { active: "等待用户回答", done: "用户已回答" },
  todowrite: { active: "更新任务列表", done: "已更新任务列表" },
  taskcreate: { active: "创建任务", done: "已创建任务" },
  taskupdate: { active: "更新任务", done: "已更新任务" },

  // 记忆
  memory_search: { active: "搜索记忆", done: "已搜索记忆" },
  memory_get: { active: "获取记忆", done: "已获取记忆" },
  memory_save: { active: "保存记忆", done: "已保存记忆" },

  // 定时
  cron_read: { active: "读取定时任务", done: "已读取定时任务" },
  cron_set: { active: "设置定时任务", done: "已设置定时任务" },
  cron_query: { active: "查询定时任务", done: "已查询定时任务" },
};

// ─── 公共 API ───

/**
 * 获取工具的进行时描述（用于运行中状态）
 */
export function getToolActivePhrase(toolName: string, input: Record<string, unknown> = {}): string {
  const entry = PHRASES[toolName.toLowerCase()];
  if (!entry) return toolName;
  const dynamic = entry.describe?.(input);
  return dynamic ?? entry.active;
}

/**
 * 获取工具的完成时描述
 */
export function getToolDonePhrase(toolName: string, input: Record<string, unknown> = {}): string {
  const entry = PHRASES[toolName.toLowerCase()];
  if (!entry) return toolName;
  return entry.done;
}

/**
 * 判断工具名是否有已注册的语义短语
 */
export function hasToolPhrase(toolName: string): boolean {
  return toolName.toLowerCase() in PHRASES;
}

// ─── 内部工具 ───

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? path;
}
