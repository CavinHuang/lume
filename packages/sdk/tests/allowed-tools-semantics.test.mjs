import test from 'node:test'
import assert from 'node:assert/strict'

const sdk = await import('../dist/index.js')

test('assembleToolPool does not hide tools when allowedTools is set', () => {
  const tools = sdk.assembleToolPool(
    sdk.getAllBaseTools(),
    [],
    ['Read', 'mcp__utilities__*'],
    ['Edit'],
  )

  const names = tools.map((tool) => tool.name)
  assert.ok(names.includes('Read'))
  assert.ok(names.includes('Bash'))
  assert.ok(!names.includes('Edit'))
})

test('default permission handler treats allowedTools as pre-approval rules', async () => {
  const agent = sdk.createAgent()
  const canUseTool = agent.getCanUseTool({
    permissionMode: 'default',
    allowedTools: ['Edit', 'mcp__utilities__*'],
    disallowedTools: ['Read'],
  })

  const editableTool = {
    name: 'Edit',
    description: 'edit file',
    inputSchema: { type: 'object', properties: {} },
    call: async () => ({ type: 'tool_result', tool_use_id: '', content: '' }),
    isReadOnly: () => false,
  }
  const readTool = {
    name: 'Read',
    description: 'read file',
    inputSchema: { type: 'object', properties: {} },
    call: async () => ({ type: 'tool_result', tool_use_id: '', content: '' }),
    isReadOnly: () => true,
  }
  const mcpTool = {
    name: 'mcp__utilities__ping',
    description: 'ping utility',
    inputSchema: { type: 'object', properties: {} },
    call: async () => ({ type: 'tool_result', tool_use_id: '', content: '' }),
    isReadOnly: () => false,
  }
  const otherMutatingTool = {
    name: 'Write',
    description: 'write file',
    inputSchema: { type: 'object', properties: {} },
    call: async () => ({ type: 'tool_result', tool_use_id: '', content: '' }),
    isReadOnly: () => false,
  }

  const editableResult = await canUseTool(editableTool, {})
  const readResult = await canUseTool(readTool, {})
  const mcpResult = await canUseTool(mcpTool, {})
  const otherResult = await canUseTool(otherMutatingTool, {})

  assert.equal(editableResult.behavior, 'allow')
  assert.equal(readResult.behavior, 'deny')
  assert.equal(mcpResult.behavior, 'allow')
  assert.equal(otherResult.behavior, 'deny')
})
