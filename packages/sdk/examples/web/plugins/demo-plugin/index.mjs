import { defineTool } from '../../../../src/index.js'

const PluginEchoTool = defineTool({
  name: 'PluginEcho',
  description: 'Echo plugin metadata back to the assistant.',
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Message to echo' },
    },
    required: ['message'],
  },
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input) {
    return {
      data: {
        source: 'examples/web/plugins/demo-plugin',
        echoed: input.message,
      },
    }
  },
})

export default {
  name: 'demo-plugin',
  source: 'examples/web',
  tools: [PluginEchoTool],
  agents: {
    'plugin-guide': {
      description: 'Plugin-provided guide agent for repository onboarding.',
      prompt:
        'Explain how the demo plugin is wired into the web example. Focus on tools, skills, and runtime loading.',
      tools: ['Read', 'Glob', 'Grep'],
      maxTurns: 4,
    },
  },
  skills: [
    {
      name: 'plugin-brief',
      description: 'Summarize plugin behavior in a short note.',
      userInvocable: true,
      async getPrompt(args) {
        return [
          {
            type: 'text',
            text: `Summarize the demo plugin behavior briefly. Extra context: ${args || 'none'}`,
          },
        ]
      },
    },
  ],
}
