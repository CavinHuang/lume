import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@lume/shared'
import { buildToolResultMap } from './SDKContentBlock'

describe('buildToolResultMap', () => {
  test('maps top-level tool_result messages by tool_use_id', () => {
    const messages = [
      {
        type: 'tool_result',
        result: {
          tool_use_id: 'glob-1',
          tool_name: 'Glob',
          output: '{"data":{"matches":["src/main.ts"]}}',
        },
      },
    ] as SDKMessage[]

    const resultMap = buildToolResultMap(messages)

    expect(resultMap.get('glob-1')).toEqual({
      toolName: 'Glob',
      output: '{"data":{"matches":["src/main.ts"]}}',
    })
  })

  test('maps persisted user tool_result content blocks by tool_use_id', () => {
    const messages = [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'glob-2',
              name: 'Glob',
              input: { pattern: '**/*.ts' },
            },
          ],
        },
      },
      {
        type: 'user',
        parent_tool_use_id: 'glob-2',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'glob-2',
              content: '{"data":{"matches":["src/lib/utils.ts"]}}',
            },
          ],
        },
      },
    ] as SDKMessage[]

    const resultMap = buildToolResultMap(messages)

    expect(resultMap.get('glob-2')).toEqual({
      toolName: 'Glob',
      output: '{"data":{"matches":["src/lib/utils.ts"]}}',
    })
  })
})
