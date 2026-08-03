import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Mention, { type MentionOptions } from '@tiptap/extension-mention'
import { ReactNodeViewRenderer } from '@tiptap/react'
import type { Extensions } from '@tiptap/core'
import { CapabilityMentionNodeView } from './CapabilityMentionNodeView'
import { PlanningTodoMentionNodeView } from './PlanningTodoMentionNodeView'

interface PromptEditorExtensionOptions {
  placeholder: string
  capabilitySuggestion: MentionOptions['suggestion']
  agentSuggestion?: MentionOptions['suggestion']
  planningTodoSuggestion?: MentionOptions['suggestion']
}

/** Shared editor schema for every Lume prompt surface. */
export function createPromptEditorExtensions(options: PromptEditorExtensionOptions) {
  const extensions: Extensions = [
    StarterKit.configure({ bold: false, italic: false, strike: false }),
    Placeholder.configure({ placeholder: options.placeholder }),
  ]

  if (options.agentSuggestion) {
    extensions.push(Mention.configure({
      HTMLAttributes: {
        class: 'mention bg-blue-500/10 text-blue-600 dark:text-blue-400 px-0.5 rounded font-medium text-[13px]',
      },
      suggestion: options.agentSuggestion,
    }))
  }

  extensions.push(Mention.extend({
    name: 'capabilityMention',
    addAttributes() {
      return {
        ...this.parent?.(),
        uri: { default: null },
        kind: { default: null },
        occurrenceId: { default: null },
        iconUrl: { default: null },
      }
    },
    addNodeView() {
      return ReactNodeViewRenderer(CapabilityMentionNodeView)
    },
  }).configure({
    HTMLAttributes: { class: 'capability-mention' },
    renderText: ({ node }) => node.attrs.uri ?? '',
    suggestion: options.capabilitySuggestion,
  }))

  if (options.planningTodoSuggestion) {
    extensions.push(Mention.extend({
      name: 'planningTodoMention',
      addAttributes() {
        return {
          ...this.parent?.(),
          schemaVersion: { default: 1 },
          uri: { default: null },
          todoId: { default: null },
          relation: { default: 'mentioned' },
          displayText: { default: '' },
        }
      },
      addNodeView() {
        return ReactNodeViewRenderer(PlanningTodoMentionNodeView)
      },
    }).configure({
      HTMLAttributes: { class: 'planning-todo-mention' },
      renderText: ({ node }) => `&${node.attrs.displayText ?? ''}`,
      suggestion: options.planningTodoSuggestion,
    }))
  }

  return extensions
}
