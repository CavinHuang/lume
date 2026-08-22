import { z } from 'zod'
import {
  createSdkMcpServer,
  defineTool,
  registerSkill,
  type AgentOptions,
  type ToolDefinition,
  tool,
} from '../../src/index.js'

export type WebFeatureCategory =
  | '核心能力'
  | '扩展能力'
  | '协作能力'
  | '模型提供方'
  | '控制面'

export interface WebFeatureDefinition {
  id: string
  title: string
  category: WebFeatureCategory
  description: string
  prompt: string
  tags: string[]
  details?: string[]
  disabledReason?: string
}

export interface FeatureContext {
  pluginDir: string
  openAI: {
    available: boolean
    apiKey?: string
    baseURL?: string
    model?: string
  }
}

const CalculatorTool = defineTool({
  name: 'Calculator',
  description: '计算一个简单的数学表达式。',
  inputSchema: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: '兼容 JavaScript 的数学表达式' },
    },
    required: ['expression'],
  },
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input) {
    // Demo-only helper. Do not use eval on untrusted network inputs in production.
    const result = Function(`'use strict'; return (${String(input.expression)})`)()
    return {
      data: {
        expression: input.expression,
        result,
      },
    }
  },
})

const ProjectPulseTool = defineTool({
  name: 'ProjectPulse',
  description: '返回一个适合演示的项目状态摘要。',
  inputSchema: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: '要总结的主题' },
    },
    required: ['topic'],
  },
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input) {
    return {
      data: {
        topic: input.topic,
        status: '健康',
        notes: [
          '这个代码库以 TypeScript 为主。',
          'SDK 的核心围绕 Agent、QueryEngine、工具、MCP 和会话。',
          '这个 Web 示例可以流式展示工具事件和系统事件。',
        ],
      },
    }
  },
})

const UtilityMcpServer = createSdkMcpServer({
  name: 'utilities',
  version: '1.0.0',
  tools: [
    tool(
      'get_temperature',
      '获取某个地点的当前温度',
      {
        city: z.string().describe('城市名称'),
        unit: z.enum(['celsius', 'fahrenheit']).default('celsius'),
      },
      async ({ city, unit }) => {
        const temps: Record<string, number> = {
          tokyo: 22,
          london: 14,
          paris: 16,
          'new york': 18,
          shanghai: 25,
        }
        const tempC = temps[city.toLowerCase()] ?? 20
        const temp = unit === 'fahrenheit' ? tempC * 9 / 5 + 32 : tempC
        const symbol = unit === 'fahrenheit' ? '°F' : '°C'
        return {
          content: [{ type: 'text', text: `${city} 当前温度：${temp}${symbol}` }],
        }
      },
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      'convert_units',
      '在不同计量单位之间转换',
      {
        value: z.number(),
        from_unit: z.string(),
        to_unit: z.string(),
      },
      async ({ value, from_unit, to_unit }) => {
        const conversions: Record<string, Record<string, (v: number) => number>> = {
          km: { miles: (v) => v * 0.621371 },
          miles: { km: (v) => v * 1.60934 },
          kg: { lbs: (v) => v * 2.20462 },
          lbs: { kg: (v) => v * 0.453592 },
        }
        const fn = conversions[from_unit]?.[to_unit]
        if (!fn) {
          return {
            content: [{ type: 'text', text: `无法将 ${from_unit} 转换为 ${to_unit}` }],
            isError: true,
          }
        }
        return {
          content: [{ type: 'text', text: `${value} ${from_unit} = ${fn(value).toFixed(2)} ${to_unit}` }],
        }
      },
    ),
  ],
})

let demoSkillRegistered = false

function ensureDemoSkillRegistered(): void {
  if (demoSkillRegistered) return
  demoSkillRegistered = true
  registerSkill({
    name: 'demo-explain',
    description: '用通俗语言解释仓库中的一个概念',
    userInvocable: true,
    async getPrompt(args) {
      return [
        {
          type: 'text',
          text: `请用通俗且务实的方式解释这个概念：${args || '仓库整体架构'}`,
        },
      ]
    },
  })
}

export function getDemoMcpServer() {
  return UtilityMcpServer
}

export function getExtraDemoTools(): ToolDefinition[] {
  return [CalculatorTool, ProjectPulseTool]
}

export function getWebFeatureCatalog(ctx: FeatureContext): WebFeatureDefinition[] {
  return [
    {
      id: 'playground',
      title: '综合演练',
      category: '核心能力',
      description: '默认流式聊天场景，带工具调用和可复用会话状态。',
      prompt: '读取 package.json，并用三条要点总结这个项目。',
      tags: ['流式输出', '聊天', '工具'],
    },
    {
      id: 'multi-tool',
      title: '多工具协同',
      category: '核心能力',
      description: '在一次回答里联动多个读取/搜索工具。',
      prompt: '使用 Glob、Grep 和 Read 找出这个仓库的主要入口文件。',
      tags: ['glob', 'grep', 'read'],
    },
    {
      id: 'custom-system-prompt',
      title: '自定义系统提示词',
      category: '核心能力',
      description: '通过自定义 system prompt 改变助手风格。',
      prompt: '用资深工程师的简洁风格介绍这个仓库。',
      tags: ['systemPrompt', '风格'],
    },
    {
      id: 'structured-output',
      title: '结构化输出',
      category: '核心能力',
      description: '返回符合显式 JSON Schema 的结果。',
      prompt: '检查这个仓库，并返回一个包含 title、risk、nextStep 字段的发布检查清单。',
      tags: ['json', 'schema'],
    },
    {
      id: 'custom-tools',
      title: '自定义工具',
      category: '扩展能力',
      description: '通过 defineTool() 注入低层自定义工具。',
      prompt: '使用 Calculator 计算 2**10 * 3，再用 ProjectPulse 总结仓库架构。',
      tags: ['defineTool', '扩展'],
    },
    {
      id: 'mcp-server',
      title: 'SDK MCP 服务',
      category: '扩展能力',
      description: '挂载一个带实用工具的进程内 MCP 服务。',
      prompt: '使用 MCP 工具查询东京温度，并把 10 公里换算成英里。',
      tags: ['mcp', 'sdkServer'],
    },
    {
      id: 'official-query-api',
      title: 'Query 控制面',
      category: '控制面',
      description: '用侧边控制面查看初始化信息、上下文占用、MCP 状态和运行时变更。',
      prompt: '读取 README.md，并总结这个 SDK 的内部组织方式。',
      tags: ['query', 'controls'],
      details: ['发送后，使用控制面调用 getInitializationResult()、getContextUsage()、reloadPlugins() 和 MCP 相关操作。'],
    },
    {
      id: 'skills',
      title: 'Skills',
      category: '扩展能力',
      description: '调用内置和自定义 skills。',
      prompt: '使用 demo-explain skill，用通俗语言解释 SDK 架构。',
      tags: ['skills', '提示模板'],
    },
    {
      id: 'ask-user',
      title: '向用户提问',
      category: '协作能力',
      description: '使用 AskUserQuestion，并等待浏览器端交互回答。',
      prompt: '在回答前先用 AskUserQuestion 询问我想要哪种回答风格，然后按我的选择回答。',
      tags: ['AskUserQuestion', '交互'],
    },
    {
      id: 'plugin',
      title: '插件演示',
      category: '扩展能力',
      description: '加载一个本地 demo plugin，包含工具、agent、skill 和命令。',
      prompt: '使用插件里的 echo 工具、guide agent 或插件命令来证明插件已成功加载。',
      tags: ['plugins', 'reloadPlugins'],
      details: [`Plugin path: ${ctx.pluginDir}`],
    },
    {
      id: 'session-controls',
      title: '会话控制',
      category: '控制面',
      description: '制造会话历史和文件修改，便于测试 listSessions()、rewindFiles() 和 resume。',
      prompt: '创建一个名为 examples/web/session-demo.txt 的文件，内容写入“web session demo”，然后告诉我文件路径。',
      tags: ['sessions', 'rewind', 'resume'],
    },
    {
      id: 'post-turn-summary',
      title: '回合摘要事件',
      category: '控制面',
      description: '展示每轮 assistant 输出后的 post_turn_summary 结构化事件。',
      prompt: '请审查这个仓库，并告诉我一个适合优先处理的风险点。',
      tags: ['post_turn_summary', 'events'],
    },
    {
      id: 'streamlined-output',
      title: '流线输出',
      category: '控制面',
      description: '启用 streamlined 输出风格，展示 streamlined_text 和 streamlined_tool_use_summary。',
      prompt: '读取 package.json，并概括项目用途；如果需要请调用工具。',
      tags: ['流线输出', '事件'],
    },
    {
      id: 'tool-search',
      title: '工具搜索',
      category: '控制面',
      description: '展示 deferred tool 搜索模式和 ToolSearch 的结果。',
      prompt: '如果当前看不到合适工具，请使用 ToolSearch 查找可能可用的延迟工具，并解释结果。',
      tags: ['ToolSearch', 'deferred tools'],
    },
    ctx.openAI.available
      ? {
          id: 'openai-compat',
          title: 'OpenAI 兼容端点',
          category: '模型提供方',
          description: '在配置好凭证后，切换到 OpenAI-compatible endpoint 运行。',
          prompt: '这个项目里有哪些文件？请用一句话回答。',
          tags: ['openai', 'providers'],
        }
      : null,
    {
      id: 'api-retry',
      title: '重试事件',
      category: '控制面',
      description: '用于观察 api_retry 事件。适合在容易触发重试的代理或限流环境中手动验证。',
      prompt: '简要总结这个仓库的用途，并在请求失败重试时观察事件流。',
      tags: ['api_retry', '事件'],
    },
  ].filter(Boolean) as WebFeatureDefinition[]
}

export function buildFeatureAgentOptions(
  featureId: string,
  ctx: FeatureContext,
): AgentOptions {
  ensureDemoSkillRegistered()

  const base: AgentOptions = {
    model: process.env.CODEANY_MODEL || 'claude-sonnet-4-6',
    maxTurns: 20,
    includePartialMessages: true,
    persistSession: true,
    promptSuggestions: false,
    outputStyle: 'text',
  }

  switch (featureId) {
    case 'custom-system-prompt':
      return {
        ...base,
        systemPrompt:
          '你是一位简洁直接的仓库分析助手。优先给出短答案，引用具体文件，不要铺垫。',
      }

    case 'structured-output':
      return {
        ...base,
        outputFormat: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              risk: { type: 'string' },
              nextStep: { type: 'string' },
            },
            required: ['title', 'risk', 'nextStep'],
            additionalProperties: false,
          },
        },
      }

    case 'mcp-server':
      return {
        ...base,
        mcpServers: {
          utilities: UtilityMcpServer as any,
        },
      }

    case 'custom-tools':
      return {
        ...base,
        tools: undefined,
        allowedTools: undefined,
      }

    case 'subagents':
      return {
        ...base,
        agents: {
          'code-reviewer': {
            description: '专注于仓库结构和导出接口的审查代理。',
            prompt:
              '审查目标文件的架构、导出接口和风险点。保持简洁、具体。',
            tools: ['Read', 'Glob', 'Grep'],
            maxTurns: 6,
          },
        },
      }

    case 'permissions':
      return {
        ...base,
        permissionMode: 'default',
        allowedTools: ['Read', 'Glob', 'Grep', 'AskUserQuestion', 'TodoWrite'],
      }

    case 'hooks':
      return {
        ...base,
        hooks: {
          SessionStart: [
            {
              hooks: [
                async () => ({
                  message: 'Hook 演示会话已启动。',
                }),
              ],
            },
          ],
          PreToolUse: [
            {
              hooks: [
                async (input) => ({
                  message: `即将调用 ${String(input.toolName || '工具')}`,
                }),
              ],
            },
          ],
          PostToolUse: [
            {
              hooks: [
                async (input) => ({
                  message: `已完成 ${String(input.toolName || '工具')}`,
                }),
              ],
            },
          ],
        },
      }

    case 'ask-user':
      return {
        ...base,
        allowedTools: ['Read', 'Glob', 'Grep', 'AskUserQuestion'],
        toolConfig: {
          askUserQuestion: {
            previewFormat: 'html',
          },
        },
      }

    case 'prompt-suggestions':
      return {
        ...base,
        promptSuggestions: true,
      }

    case 'plugin':
      return {
        ...base,
        plugins: [
          {
            name: 'demo-plugin',
            path: ctx.pluginDir,
          },
        ],
      }

    case 'post-turn-summary':
      return {
        ...base,
      }

    case 'streamlined-output':
      return {
        ...base,
        outputStyle: 'streamlined',
      }

    case 'tool-search':
      return {
        ...base,
        disallowedTools: ['ProjectPulse'],
      }

    case 'api-retry':
      return {
        ...base,
      }

    case 'openai-compat':
      return {
        ...base,
        apiType: 'openai-completions',
        apiKey: ctx.openAI.apiKey,
        baseURL: ctx.openAI.baseURL,
        model: ctx.openAI.model || 'gpt-4o-mini',
      }

    default:
      return base
  }
}
