import test from 'node:test'
import assert from 'node:assert/strict'

const sdk = await import('../dist/index.js')

test('tool search defaults to tst mode', () => {
  delete process.env.ENABLE_TOOL_SEARCH
  assert.equal(sdk.getToolSearchMode(), 'tst')
})

test('tool search respects explicit standard mode', () => {
  process.env.ENABLE_TOOL_SEARCH = 'false'
  assert.equal(sdk.getToolSearchMode(), 'standard')
  delete process.env.ENABLE_TOOL_SEARCH
})

test('tool search respects auto mode', () => {
  process.env.ENABLE_TOOL_SEARCH = 'auto:1'
  assert.equal(sdk.getToolSearchMode(), 'tst-auto')
  delete process.env.ENABLE_TOOL_SEARCH
})

test('auto tool search enables when deferred tool payload is large enough', () => {
  process.env.ENABLE_TOOL_SEARCH = 'auto:0'
  const hugeTool = {
    name: 'HugeDeferredTool',
    description: 'x'.repeat(5000),
    inputSchema: { type: 'object', properties: { payload: { type: 'string' } } },
    call: async () => ({ type: 'tool_result', tool_use_id: '', content: '' }),
  }

  assert.equal(
    sdk.isToolSearchEnabled([hugeTool], 'claude-sonnet-4-6'),
    true,
  )
  delete process.env.ENABLE_TOOL_SEARCH
})

test('auto tool search disables when deferred tool payload is below threshold', () => {
  process.env.ENABLE_TOOL_SEARCH = 'auto:50'
  const smallTool = {
    name: 'SmallDeferredTool',
    description: 'tiny',
    inputSchema: { type: 'object', properties: {} },
    call: async () => ({ type: 'tool_result', tool_use_id: '', content: '' }),
  }

  assert.equal(
    sdk.isToolSearchEnabled([smallTool], 'claude-sonnet-4-6'),
    false,
  )
  delete process.env.ENABLE_TOOL_SEARCH
})
