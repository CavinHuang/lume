export interface PersistedFileEditorDraft {
  content: string
  savedContent: string
  mtimeMs: number
  updatedAt: number
}

const memoryFallback = new Map<string, PersistedFileEditorDraft>()
const DATABASE_NAME = 'lume-file-editor'
const STORE_NAME = 'drafts'

export async function readFileEditorDraft(key: string): Promise<PersistedFileEditorDraft | undefined> {
  if (typeof indexedDB === 'undefined') return memoryFallback.get(key)
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key)
    request.onsuccess = () => resolve(request.result as PersistedFileEditorDraft | undefined)
    request.onerror = () => reject(request.error)
  })
}

export async function writeFileEditorDraft(key: string, draft: PersistedFileEditorDraft): Promise<void> {
  memoryFallback.set(key, draft)
  if (typeof indexedDB === 'undefined') return
  const database = await openDatabase()
  await completeRequest(database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(draft, key))
}

export async function deleteFileEditorDraft(key: string): Promise<void> {
  memoryFallback.delete(key)
  if (typeof indexedDB === 'undefined') return
  const database = await openDatabase()
  await completeRequest(database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(key))
}

let databasePromise: Promise<IDBDatabase> | null = null

function openDatabase(): Promise<IDBDatabase> {
  databasePromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return databasePromise
}

function completeRequest(request: IDBRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}
