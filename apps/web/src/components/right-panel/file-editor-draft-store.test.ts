import { describe, expect, test } from 'bun:test'
import {
  deleteFileEditorDraft,
  readFileEditorDraft,
  writeFileEditorDraft,
} from './file-editor-draft-store'

describe('file editor draft storage', () => {
  test('retains unsaved text until a successful save removes it', async () => {
    const key = `test:${crypto.randomUUID()}`
    const draft = {
      content: 'local edit',
      savedContent: 'disk',
      mtimeMs: 42,
      updatedAt: Date.now(),
    }
    await writeFileEditorDraft(key, draft)
    expect(await readFileEditorDraft(key)).toEqual(draft)
    await deleteFileEditorDraft(key)
    expect(await readFileEditorDraft(key)).toBeUndefined()
  })
})
