import { appendFile, copyFile, mkdir, readdir, readFile, rename, unlink, writeFile } from 'fs/promises'
import { randomUUID } from 'crypto'
import { basename, dirname, join } from 'path'
import { withFileMutationLock } from '../utils/file-mutation-lock.js'

export interface SkillUsageInput {
  skillName: string
  skillPath?: string
  sessionId?: string
  now?: number
  throttleMs?: number
}

export interface SkillImprovementMessage {
  role: string
  content: string | Array<{ type?: string; text?: string }>
}

export interface SkillImprovementUpdate {
  section: string
  change: string
  reason: string
}

export interface SkillModelCallInput {
  systemPrompt: string
  userPrompt: string
  currentContent?: string
  updateList?: string
}

export interface ApplySkillImprovementResult {
  success: boolean
  error?: string
  versionPath?: string
  warning?: string
}

export interface SkillVersionInfo {
  path: string
  filename: string
  timestamp: string
}

const usageThrottle = new Map<string, number>()
const DEFAULT_USAGE_THROTTLE_MS = 3_600_000
const MAX_VERSIONS = 10
const VERSIONS_DIR = 'versions'
const LEGACY_VERSIONS_DIR = '.versions'

const ANALYZE_SYSTEM_PROMPT = [
  'You analyze whether a reusable SKILL.md prompt should evolve based on recent conversation evidence.',
  'Return only <updates>JSON</updates>, where JSON is an array of {section, change, reason}.',
].join('\n')

const APPLY_SYSTEM_PROMPT = [
  'You update a SKILL.md file according to specific improvement notes.',
  'Preserve useful frontmatter and existing behavior unless an update explicitly changes it.',
  'Return only <updated_file>...</updated_file>.',
].join('\n')

export async function recordSkillUsage(input: SkillUsageInput): Promise<void> {
  if (!input.skillPath) return

  const now = input.now ?? Date.now()
  const throttleMs = input.throttleMs ?? DEFAULT_USAGE_THROTTLE_MS
  const key = `${input.skillName}:${input.skillPath}`
  const last = usageThrottle.get(key)
  if (last !== undefined && now - last < throttleMs) return

  usageThrottle.set(key, now)
  const record: Record<string, unknown> = { ts: now }
  if (input.sessionId) record.sessionId = input.sessionId

  await appendFile(
    join(dirname(input.skillPath), 'usage.jsonl'),
    `${JSON.stringify(record)}\n`,
    'utf-8',
  )
}

export async function analyzeSkillImprovement(input: {
  skillContent: string
  messages: SkillImprovementMessage[]
  callModel: (input: SkillModelCallInput) => Promise<string>
}): Promise<SkillImprovementUpdate[]> {
  const recentText = formatRecentMessages(input.messages)
  if (!recentText.trim()) return []

  const userPrompt = [
    'Current SKILL.md:',
    input.skillContent,
    '',
    'Recent conversation:',
    recentText,
  ].join('\n')
  const response = await input.callModel({
    systemPrompt: ANALYZE_SYSTEM_PROMPT,
    userPrompt,
  })
  const rawUpdates = extractTaggedContent(response, 'updates')
  if (!rawUpdates) return []

  try {
    const parsed = JSON.parse(rawUpdates)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isSkillImprovementUpdate)
  } catch {
    return []
  }
}

export async function applySkillImprovement(input: {
  skillPath: string
  updates: SkillImprovementUpdate[]
  callModel: (input: SkillModelCallInput) => Promise<string>
}): Promise<ApplySkillImprovementResult> {
  if (input.updates.length === 0) {
    return { success: false, error: '没有改进建议' }
  }

  // Serialize the whole read→backup→model-call→rename window against other
  // in-process mutations; external writers are caught by the snapshot
  // re-check below.
  return withFileMutationLock(input.skillPath, async () => {
    let currentContent: string
    try {
      currentContent = await readFile(input.skillPath, 'utf-8')
    } catch {
      return { success: false, error: `无法读取技能文件：${input.skillPath}` }
    }

    if (!currentContent.trim()) {
      return { success: false, error: '技能文件内容为空' }
    }

    const versionsDir = await ensureVersionsDir(input.skillPath)
    const versionPath = await createVersionPath(input.skillPath)
    await copyFile(input.skillPath, versionPath)

    const updateList = input.updates
      .map((update) => `- ${update.section}: ${update.change}`)
      .join('\n')

    let updatedContent: string | null
    try {
      const response = await input.callModel({
        systemPrompt: APPLY_SYSTEM_PROMPT,
        userPrompt: [
          'Current content:',
          currentContent,
          '',
          'Updates:',
          updateList,
        ].join('\n'),
        currentContent,
        updateList,
      })
      updatedContent = extractTaggedContent(response, 'updated_file')
    } catch (error) {
      await unlink(versionPath).catch(() => undefined)
      return { success: false, error: `模型调用失败：${errorMessage(error)}` }
    }

    if (!updatedContent) {
      await unlink(versionPath).catch(() => undefined)
      return { success: false, error: '模型未返回 <updated_file> 标签，中止写入' }
    }

    // The model call is a long window; abort rather than silently overwrite
    // when the file changed on disk since our snapshot.
    const latestContent = await readFile(input.skillPath, 'utf-8').catch(() => null)
    if (latestContent !== currentContent) {
      await unlink(versionPath).catch(() => undefined)
      return { success: false, error: '技能文件在改进期间被外部修改，已中止写入' }
    }

    const ratio = currentContent.length > 100
      ? updatedContent.length / currentContent.length
      : 1
    const warning = ratio < 0.5
      ? `内容缩减幅度较大（${Math.round(100 * (1 - ratio))}%），已自动备份旧版本`
      : undefined
    const tempPath = `${input.skillPath}.${randomUUID().slice(0, 8)}.tmp`

    try {
      await writeFile(tempPath, updatedContent, 'utf-8')
      await rename(tempPath, input.skillPath)
    } catch (error) {
      await unlink(tempPath).catch(() => undefined)
      return { success: false, error: `写入文件失败：${errorMessage(error)}` }
    }

    await pruneVersions(versionsDir).catch(() => undefined)
    return {
      success: true,
      versionPath,
      ...(warning ? { warning } : {}),
    }
  })
}

export async function listSkillVersions(skillPath: string): Promise<SkillVersionInfo[]> {
  const entries = await readVersionEntries(skillPath)
  return entries.sort((a, b) => b.filename.localeCompare(a.filename))
}

export async function restoreSkillVersion(input: {
  skillPath: string
  filename: string
}): Promise<ApplySkillImprovementResult> {
  const versionEntry = await findVersionEntry(input.skillPath, input.filename)
  const versionsDir = join(dirname(input.skillPath), VERSIONS_DIR)
  let versionContent: string
  try {
    versionContent = await readFile(versionEntry.path, 'utf-8')
  } catch {
    return { success: false, error: '版本文件不存在' }
  }

  const currentBackup = await createVersionPath(input.skillPath)
  // Backing up the current content is the only rollback for the restore below:
  // if it fails, abort instead of overwriting the file unrecoverably.
  try {
    await copyFile(input.skillPath, currentBackup)
  } catch (error) {
    return { success: false, error: `备份当前内容失败，已中止恢复：${errorMessage(error)}` }
  }

  const tempPath = `${input.skillPath}.${randomUUID().slice(0, 8)}.tmp`
  try {
    await writeFile(tempPath, versionContent, 'utf-8')
    await rename(tempPath, input.skillPath)
  } catch (error) {
    await unlink(tempPath).catch(() => undefined)
    return { success: false, error: `恢复写入失败：${errorMessage(error)}` }
  }

  await pruneVersions(versionsDir).catch(() => undefined)
  return { success: true, versionPath: currentBackup }
}

function formatRecentMessages(messages: SkillImprovementMessage[]): string {
  return messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${messageText(message).slice(0, 500)}`)
    .join('\n\n')
}

function messageText(message: SkillImprovementMessage): string {
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''

  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
}

function extractTaggedContent(content: string, tag: string): string | null {
  const match = content.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))
  return match?.[1]?.trim() || null
}

function isSkillImprovementUpdate(value: unknown): value is SkillImprovementUpdate {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.section === 'string' &&
    typeof candidate.change === 'string' &&
    typeof candidate.reason === 'string'
  )
}

async function ensureVersionsDir(skillPath: string): Promise<string> {
  const versionsDir = join(dirname(skillPath), VERSIONS_DIR)
  await mkdir(versionsDir, { recursive: true })
  return versionsDir
}

async function createVersionPath(skillPath: string): Promise<string> {
  const versionsDir = await ensureVersionsDir(skillPath)
  const timestamp = formatBackupTimestamp(new Date())
  return join(versionsDir, `${timestamp}_${randomUUID().replace(/-/g, '').slice(0, 8)}.md`)
}

async function pruneVersions(versionsDir: string): Promise<void> {
  const versions = (await readdir(versionsDir))
    .filter(isVersionFilename)
    .sort()

  for (const filename of versions.slice(0, Math.max(0, versions.length - MAX_VERSIONS))) {
    await unlink(join(versionsDir, filename)).catch(() => undefined)
  }
}

async function readVersionEntries(skillPath: string): Promise<SkillVersionInfo[]> {
  const skillDir = dirname(skillPath)
  const dirs = [join(skillDir, VERSIONS_DIR), join(skillDir, LEGACY_VERSIONS_DIR)]
  const entries: SkillVersionInfo[] = []
  const seen = new Set<string>()

  for (const versionsDir of dirs) {
    let filenames: string[]
    try {
      filenames = await readdir(versionsDir)
    } catch {
      continue
    }

    for (const filename of filenames.filter(isVersionFilename)) {
      if (seen.has(filename)) continue
      seen.add(filename)
      entries.push({
        path: join(versionsDir, filename),
        filename,
        timestamp: formatVersionTimestamp(filename),
      })
    }
  }

  return entries
}

async function findVersionEntry(skillPath: string, filename: string): Promise<SkillVersionInfo> {
  const safeFilename = basename(filename)
  const versions = await readVersionEntries(skillPath)
  const version = versions.find((entry) => entry.filename === safeFilename)
  if (!version) {
    return {
      path: join(dirname(skillPath), VERSIONS_DIR, safeFilename),
      filename: safeFilename,
      timestamp: formatVersionTimestamp(safeFilename),
    }
  }
  return version
}

function isVersionFilename(filename: string): boolean {
  return filename.endsWith('.md') && (
    /^SKILL_\d{8}_\d{6}_[a-f0-9]{4}\.md$/i.test(filename) ||
    /^\d{4}-\d{2}-\d{2}_\d{6}_[a-f0-9]{4,8}\.md$/i.test(filename)
  )
}

function formatVersionTimestamp(filename: string): string {
  return filename
    .replace(/^SKILL_/, '')
    .replace(/\.md$/, '')
    .replace(/_[a-f0-9]{4,8}$/i, '')
    .replace('_', ' ')
}

function formatBackupTimestamp(date: Date): string {
  const parts = [
    date.getFullYear(),
    '-',
    String(date.getMonth() + 1).padStart(2, '0'),
    '-',
    String(date.getDate()).padStart(2, '0'),
    '_',
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0'),
  ]
  return parts.join('')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
