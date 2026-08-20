/**
 * AskUserQuestionTool - Structured user questions
 *
 * Compatible with the Claude-style Agent SDK shape:
 * - Supports 1-4 questions per request
 * - Each question has a header and 2-4 choices
 * - Supports multi-select and optional annotations/previews
 *
 * The tool uses a host-provided handler when available; otherwise it
 * returns a deterministic non-interactive fallback result.
 */

import type {
  AskUserQuestionRequest,
  AskUserQuestionResponse,
  QuestionOption,
  ToolDefinition,
  ToolResult,
} from '../types.js'

type LegacyQuestionHandler = (
  question: string,
  options?: string[],
) => Promise<string>

type StructuredQuestionHandler = (
  request: AskUserQuestionRequest,
) => Promise<AskUserQuestionResponse | string>

let questionHandler:
  | LegacyQuestionHandler
  | StructuredQuestionHandler
  | null = null

export function setQuestionHandler(
  handler: LegacyQuestionHandler | StructuredQuestionHandler,
): void {
  questionHandler = handler
}

export function clearQuestionHandler(): void {
  questionHandler = null
}

function normalizeLegacyInput(input: any): AskUserQuestionRequest {
  if (Array.isArray(input?.questions) && input.questions.length > 0) {
    return {
      questions: input.questions.map((question: any) => ({
        question: String(question.question || ''),
        header: String(question.header || ''),
        options: Array.isArray(question.options)
          ? question.options.map((option: any) => ({
              label: String(option.label || ''),
              description: String(option.description || ''),
              preview:
                typeof option.preview === 'string' ? option.preview : undefined,
            }))
          : [],
        multiSelect: Boolean(question.multiSelect),
      })),
      answers:
        input.answers && typeof input.answers === 'object'
          ? input.answers
          : undefined,
      annotations:
        input.annotations && typeof input.annotations === 'object'
          ? input.annotations
          : undefined,
      metadata:
        input.metadata && typeof input.metadata === 'object'
          ? input.metadata
          : undefined,
    }
  }

  const options: QuestionOption[] = Array.isArray(input?.options)
    ? input.options.map((option: string) => ({
        label: option,
        description: option,
      }))
    : []

  return {
    questions: [
      {
        question: String(input?.question || ''),
        header: 'Question',
        options,
        multiSelect: Boolean(input?.allow_multiselect),
      },
    ],
  }
}

function validateRequest(request: AskUserQuestionRequest): string | null {
  if (!Array.isArray(request.questions) || request.questions.length < 1 || request.questions.length > 4) {
    return 'questions must contain between 1 and 4 items'
  }

  for (const question of request.questions) {
    if (!question.question?.trim()) return 'Each question must include question text'
    if (!question.header?.trim()) return 'Each question must include a header'
    if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 4) {
      return `Question "${question.question}" must have between 2 and 4 options`
    }

    const labels = new Set<string>()
    for (const option of question.options) {
      if (!option.label?.trim()) return `Question "${question.question}" has an option without label`
      if (!option.description?.trim()) return `Question "${question.question}" has an option without description`
      if (labels.has(option.label)) {
        return `Question "${question.question}" has duplicate option label "${option.label}"`
      }
      labels.add(option.label)
    }
  }

  return null
}

function validateHtmlPreview(preview: string | undefined): string | null {
  if (preview === undefined) return null
  if (/<\s*(html|body|!doctype)\b/i.test(preview)) {
    return 'preview must be an HTML fragment, not a full document'
  }
  if (/<\s*(script|style)\b/i.test(preview)) {
    return 'preview must not contain <script> or <style> tags'
  }
  if (!/<[a-z][^>]*>/i.test(preview)) {
    return 'preview must contain HTML when previewFormat is set to "html"'
  }
  return null
}

function formatFallbackAnswer(request: AskUserQuestionRequest): AskUserQuestionResponse {
  const answers: Record<string, string> = {}
  for (const question of request.questions) {
    answers[question.question] = question.multiSelect
      ? question.options.slice(0, 1).map((option) => option.label).join(', ')
      : question.options[0]?.label || ''
  }
  return {
    questions: request.questions,
    answers,
  }
}

async function invokeHandler(
  request: AskUserQuestionRequest,
  hostAnswersTrusted: boolean,
): Promise<AskUserQuestionResponse & { source: 'host' | 'fallback' }> {
  // `answers` riding along in the model's tool input is untrusted — it is a
  // forged-answer channel unless the host injected it via canUseTool
  // updatedInput (#196).
  if (hostAnswersTrusted && request.answers && Object.keys(request.answers).length > 0) {
    return {
      questions: request.questions,
      answers: request.answers,
      ...(request.annotations ? { annotations: request.annotations } : {}),
      source: 'host',
    }
  }

  if (!questionHandler) {
    return { ...formatFallbackAnswer(request), source: 'fallback' }
  }

  const handlerArity = questionHandler.length
  const prefersLegacy = handlerArity >= 2

  if (
    prefersLegacy &&
    request.questions.length === 1 &&
    request.questions[0]?.options.every((option) => !option.preview)
  ) {
    const firstQuestion = request.questions[0]
    const legacyResult = await (questionHandler as LegacyQuestionHandler)(
      firstQuestion.question,
      firstQuestion.options.map((option) => option.label),
    )
    return {
      questions: request.questions,
      answers: { [firstQuestion.question]: legacyResult },
      source: 'host',
    }
  }

  const result = await (questionHandler as StructuredQuestionHandler)(request)
  if (typeof result === 'string') {
    const firstQuestion = request.questions[0]
    return {
      questions: request.questions,
      answers: { [firstQuestion?.question || 'question']: result },
      source: 'host',
    }
  }
  return { ...result, source: 'host' }
}

export const AskUserQuestionTool: ToolDefinition = {
  name: 'AskUserQuestion',
  description:
    'Ask the user one or more structured multiple-choice questions and wait for the response.',
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description: 'Structured questions to ask the user (1-4 questions).',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            header: { type: 'string' },
            options: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  description: { type: 'string' },
                  preview: { type: 'string' },
                },
                required: ['label', 'description'],
              },
            },
            multiSelect: { type: 'boolean' },
          },
          required: ['question', 'header', 'options'],
        },
      },
      answers: {
        type: 'object',
        description: 'User answers collected by the host, when applicable.',
      },
      annotations: {
        type: 'object',
        description: 'Optional per-question annotations such as notes or selected preview.',
      },
      metadata: {
        type: 'object',
        description: 'Optional source metadata for analytics or host routing.',
      },

      // Backward-compatible legacy shape
      question: { type: 'string', description: 'Single legacy question' },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: 'Legacy option list',
      },
      allow_multiselect: {
        type: 'boolean',
        description: 'Legacy multi-select flag',
      },
    },
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() {
    return 'Ask the user structured multiple-choice questions when clarification is required.'
  },
  async call(input: any, context): Promise<ToolResult> {
    const request = normalizeLegacyInput(input)
    const validationError = validateRequest(request)
    if (validationError) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Error: ${validationError}`,
        is_error: true,
      }
    }

    const previewFormat = (context.toolConfig as any)?.askUserQuestion?.previewFormat
    if (previewFormat === 'html') {
      for (const question of request.questions) {
        for (const option of question.options) {
          const previewError = validateHtmlPreview(option.preview)
          if (previewError) {
            return {
              type: 'tool_result',
              tool_use_id: '',
              content: `Error: Question "${question.question}" option "${option.label}": ${previewError}`,
              is_error: true,
            }
          }
        }
      }
    }

    try {
      const response = await invokeHandler(request, context.permissionUpdatedInput === true)
      const answerText = Object.entries(response.answers)
        .map(([question, answer]) => `"${question}"="${answer}"`)
        .join(', ')
      const nonInteractive = response.source === 'fallback'

      return {
        type: 'tool_result',
        tool_use_id: '',
        content: JSON.stringify({
          status: nonInteractive ? 'answered_non_interactive' : 'answered',
          questions: response.questions,
          answers: response.answers,
          ...(response.annotations ? { annotations: response.annotations } : {}),
          message: nonInteractive
            ? `Non-interactive session without a question handler; defaulting to the first options: ${answerText}. These are NOT real user answers — confirm with the user before acting on them.`
            : `User has answered your questions: ${answerText}. You can now continue with the user's answers in mind.`,
        }),
      }
    } catch (err: any) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `User declined to answer questions: ${err.message}`,
        is_error: true,
      }
    }
  },
}
