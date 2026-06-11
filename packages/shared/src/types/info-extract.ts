/**
 * InfoExtract tool result types
 *
 * Used by the info_extract tool and its result renderer.
 */

export interface InfoExtractStep {
  id: string
  title: string
  description: string
  status: 'completed' | 'running' | 'pending'
}

export interface InfoExtractExpert {
  name: string
  title: string
  description: string
  avatarColor?: string
}

export interface InfoExtractResultData {
  expert?: InfoExtractExpert
  configConfirmed?: boolean
  steps: InfoExtractStep[]
  sourceDocument?: string
  extractionType?: string
}
