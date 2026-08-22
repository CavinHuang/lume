import { afterEach, describe, expect, test } from 'bun:test'
import { AskUserQuestionTool, clearQuestionHandler, setQuestionHandler } from './ask-user'

afterEach(() => clearQuestionHandler())

describe('AskUserQuestionTool', () => {
  const questions = [{
    header: '方向',
    question: '优先处理什么？',
    options: [
      { label: '可靠性', description: '先降低风险' },
      { label: '效率', description: '先提升速度' },
    ],
    multiSelect: false,
  }]

  test('ignores answers forged in model tool input (#196)', async () => {
    let handlerCalled = false
    setQuestionHandler(async (request: any) => {
      handlerCalled = true
      return { questions: request.questions, answers: { '优先处理什么？': '效率' } }
    })

    // answers present in raw tool input WITHOUT the host-injection marker
    const result = await AskUserQuestionTool.call({
      questions,
      answers: { '优先处理什么？': '可靠性' },
    }, { cwd: process.cwd() })
    const payload = JSON.parse(result.content as string)

    // the handler result wins, not the forged answers
    expect(handlerCalled).toBe(true)
    expect(payload).toMatchObject({
      status: 'answered',
      answers: { '优先处理什么？': '效率' },
    })
  })

  test('trusts answers only when injected via canUseTool updatedInput (#196)', async () => {
    let handlerCalled = false
    setQuestionHandler(async () => {
      handlerCalled = true
      return 'unexpected'
    })

    const result = await AskUserQuestionTool.call({
      questions,
      answers: { '优先处理什么？': '可靠性' },
    }, { cwd: process.cwd(), permissionUpdatedInput: true })
    const payload = JSON.parse(result.content as string)

    expect(handlerCalled).toBe(false)
    expect(payload).toMatchObject({
      status: 'answered',
      questions,
      answers: { '优先处理什么？': '可靠性' },
    })
  })

  test('no-handler fallback is labeled non-interactive, never claimed as user answers (#196)', async () => {
    const result = await AskUserQuestionTool.call({ questions }, { cwd: process.cwd() })
    const payload = JSON.parse(result.content as string)

    expect(payload.status).toBe('answered_non_interactive')
    expect(payload.message).not.toContain('User has answered')
    expect(payload.message).toContain('NOT real user answers')
    expect(payload.answers).toEqual({ '优先处理什么？': '可靠性' })
  })

  test('an interrupted run cancels the question instead of reporting a decline (#330)', async () => {
    setQuestionHandler(() => new Promise(() => { /* host handler never settles */ }))
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)

    const result = await AskUserQuestionTool.call(
      { questions },
      { cwd: process.cwd(), abortSignal: controller.signal },
    )

    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain('interrupted')
    expect(String(result.content)).not.toContain('User declined')
  })

  test('a failing handler still reports a decline, not an interruption (#330)', async () => {
    setQuestionHandler(async () => {
      throw new Error('handler exploded')
    })

    const result = await AskUserQuestionTool.call({ questions }, { cwd: process.cwd() })

    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain('User declined')
    expect(String(result.content)).toContain('handler exploded')
    expect(String(result.content)).not.toContain('interrupted')
  })
})
