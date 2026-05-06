
/**
 * 系统提示词类型定义
 *
 * 管理 Chat 模式的系统提示词（system prompt），
 * 包括内置默认提示词和用户自定义提示词。
 */

/** 系统提示词 */
export interface SystemPrompt {
  /** 唯一标识 */
  id: string
  /** 提示词名称 */
  name: string
  /** 提示词内容 */
  content: string
  /** 是否为内置提示词（不可编辑/删除） */
  isBuiltin: boolean
  /** 创建时间 */
  createdAt: number
  /** 更新时间 */
  updatedAt: number
}

/** 系统提示词配置（存储在 ~/.lume/system-prompts.json） */
export interface SystemPromptConfig {
  /** 配置版本（用于后续迁移） */
  version: 1
  /** 提示词列表 */
  prompts: SystemPrompt[]
  /** 默认提示词 ID（新建对话时自动使用） */
  defaultPromptId?: string
  /** 是否追加日期时间和用户名到提示词末尾 */
  appendDateTimeAndUserName: boolean
}

/** 创建提示词输入 */
export interface SystemPromptCreateInput {
  name: string
  content: string
}

/** 更新提示词输入 */
export interface SystemPromptUpdateInput {
  name?: string
  content?: string
}

/** 内置默认提示词 ID */
export const BUILTIN_DEFAULT_ID = "builtin-default"

/** Lume 内置默认提示词内容 */
export const BUILTIN_DEFAULT_PROMPT_STRING = `你是 Lume AI 助手。你的目标是帮助用户高效解决实际问题。

你需要在以下方面保持关注：

1. 先解决问题，再补充必要上下文
- 优先给出可执行方案
- 当关键信息缺失时，先提最少必要问题
- 涉及安全/性能/稳定性风险时，主动简要提醒

2. 控制认知负担，分层输出
- 多步骤任务先给结构，再逐步展开
- 有多个方案时先给对比与适用场景
- 用户明确需要细节时再深入

3. 根据上下文匹配解释深度
- 从用户提问方式推测熟练度
- 新手强调原理与边界，熟手直接给落地方案
- 不确定时直接确认用户熟悉程度

4. 不确定就询问，不替用户拍板
- 技术选型和关键参数优先收集场景信息
- 多个合理方案时给出权衡，让用户选择

5. 回复风格
- 优先中文，保留必要英文技术术语
- 简洁、结构化、可执行
- 明确不确定性，避免模糊表达`

/** Lume 内置默认提示词 */
export const BUILTIN_DEFAULT_PROMPT: SystemPrompt = {
  id: BUILTIN_DEFAULT_ID,
  name: "Lume 内置提示词",
  content: BUILTIN_DEFAULT_PROMPT_STRING,
  isBuiltin: true,
  createdAt: 0,
  updatedAt: 0
}

/** 系统提示词 IPC 通道常量 */
export const SYSTEM_PROMPT_IPC_CHANNELS = {
  /** 获取完整配置 */
  GET_CONFIG: "system-prompt:get-config",
  /** 创建提示词 */
  CREATE: "system-prompt:create",
  /** 更新提示词 */
  UPDATE: "system-prompt:update",
  /** 删除提示词 */
  DELETE: "system-prompt:delete",
  /** 更新追加日期时间和用户名开关 */
  UPDATE_APPEND_SETTING: "system-prompt:update-append-setting",
  /** 设置默认提示词 */
  SET_DEFAULT: "system-prompt:set-default"
} as const
