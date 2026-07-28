import { afterEach, describe, expect, test } from 'bun:test'
import { AskUserQuestionTool, clearQuestionHandler, setQuestionHandler } from './ask-user'

afterEach(() => clearQuestionHandler())

describe('AskUserQuestionTool', () => {
  test('preserves host-collected answers in the structured tool result', async () => {
    let handlerCalled = false
    setQuestionHandler(async () => {
      handlerCalled = true
      return 'unexpected'
    })

    const questions = [{
      header: '方向',
      question: '优先处理什么？',
      options: [
        { label: '可靠性', description: '先降低风险' },
        { label: '效率', description: '先提升速度' },
      ],
      multiSelect: false,
    }]
    const result = await AskUserQuestionTool.call({
      questions,
      answers: { '优先处理什么？': '可靠性' },
    }, { cwd: process.cwd() })
    const payload = JSON.parse(result.content as string)

    expect(handlerCalled).toBe(false)
    expect(payload).toMatchObject({
      status: 'answered',
      questions,
      answers: { '优先处理什么？': '可靠性' },
    })
  })
})
