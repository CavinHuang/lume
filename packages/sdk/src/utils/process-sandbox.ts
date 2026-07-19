import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import {
  createConfigFromPolicy,
  getPlatformSupport,
  spawnSandboxFromConfig,
  type PlatformSupport,
  type SandboxPolicy,
} from '@microsoft/mxc-sdk'
import type { SandboxSettings } from '../types.js'

export interface ProcessSandboxSupport {
  available: boolean
  reason: string
  isolationTier?: string
  warnings: string[]
}

export interface SandboxedProcessOptions {
  cwd: string
  cwdAccess?: 'readonly' | 'readwrite'
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  detached?: boolean
  stdio?: SpawnOptions['stdio']
}

export interface ProcessSandboxProbeInput {
  probeRoot: string
  deniedPath: string
  readonlyPaths?: string[]
  readwritePaths?: string[]
  timeoutMs?: number
}

export interface ProcessSandboxProbeResult extends ProcessSandboxSupport {
  verified: boolean
}

export function getProcessSandboxSupport(): ProcessSandboxSupport {
  return mapPlatformSupport(getPlatformSupport())
}

export function spawnWithProcessSandbox(
  command: string,
  args: string[],
  options: SandboxedProcessOptions,
  sandbox?: SandboxSettings,
): ChildProcess {
  const isolation = sandbox?.processIsolation
  if (!sandbox?.enabled || !isolation?.enabled) {
    return spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      detached: options.detached,
      stdio: options.stdio ?? ['pipe', 'pipe', 'pipe'],
    })
  }

  const support = getProcessSandboxSupport()
  if (!support.available) {
    if (isolation.required !== false) {
      throw new Error(`OS process sandbox unavailable: ${support.reason}`)
    }
    return spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      detached: options.detached,
      stdio: options.stdio ?? ['pipe', 'pipe', 'pipe'],
    })
  }

  const env = buildSandboxEnvironment(options.env ?? process.env, isolation.executableSearchPaths)
  const executable = resolveExecutable(command, env)
  const readonlyPaths = uniqueExistingPaths([
    ...(isolation.readonlyPaths ?? []),
    ...(shouldGrantExecutableDirectory(executable) ? [dirname(executable)] : []),
    ...(options.cwdAccess === 'readonly' ? [options.cwd] : []),
  ])
  const readwritePaths = uniqueExistingPaths([
    ...(options.cwdAccess === 'readonly' ? [] : [options.cwd]),
    ...(isolation.readwritePaths ?? []),
  ])
  const deniedPaths = uniquePaths([
    ...(sandbox.filesystem?.denyRead ?? []),
    ...(sandbox.filesystem?.denyWrite ?? []),
    ...(isolation.deniedPaths ?? []),
  ])
  const conflictingPath = [...readonlyPaths, ...readwritePaths]
    .find((allowedPath) => deniedPaths.some((deniedPath) =>
      isPathWithin(deniedPath, allowedPath) || isPathWithin(allowedPath, deniedPath)))
  if (conflictingPath) {
    throw new Error(`OS process sandbox refused overlapping allowed and denied roots: ${conflictingPath}`)
  }
  const policy: SandboxPolicy = {
    version: '0.7.0-alpha',
    filesystem: {
      readonlyPaths,
      readwritePaths,
      deniedPaths,
    },
    network: {
      allowOutbound: isolation.allowOutbound ?? true,
      allowLocalNetwork: isolation.allowLocalNetwork ?? true,
    },
    ui: {
      allowWindows: true,
      clipboard: 'all',
      allowInputInjection: true,
    },
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  }
  const config = createConfigFromPolicy(policy, 'process', `LumeAgent_${randomUUID().replaceAll('-', '')}`)
  config.process = {
    ...config.process,
    cwd: resolve(options.cwd),
    commandLine: buildCommandLine(executable, args),
  }

  if (process.platform === 'win32') pruneMissingMxcDaclRecoveryEntries()

  return spawnSandboxFromConfig(
    config,
    { usePty: false },
    resolve(options.cwd),
    env,
  )
}

/**
 * MXC keeps a crash-recovery journal before mutating Windows DACLs. If a
 * sandbox-owned temporary directory is deleted after the owner exits, older
 * MXC builds keep retrying that now-impossible restore and fail every later
 * spawn with code 126. Remove only dead-owner entries whose every target is
 * already absent; entries for live owners or existing targets remain intact.
 */
export function pruneMissingMxcDaclRecoveryEntries(stateDir = resolveMxcDaclStateDir()): number {
  if (!stateDir || !existsSync(stateDir)) return 0
  let removed = 0
  try {
    for (const entry of readdirSync(stateDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/^pid-\d+-[a-f0-9]+\.json$/i.test(entry.name)) continue
      const filePath = join(stateDir, entry.name)
      try {
        const state = JSON.parse(readFileSync(filePath, 'utf8')) as {
          pid?: unknown
          image_name?: unknown
          applied?: Array<{ canonical_path?: unknown }>
        }
        if (
          typeof state.pid !== 'number'
          || state.image_name !== 'wxc-exec.exe'
          || isProcessAlive(state.pid)
          || !Array.isArray(state.applied)
          || state.applied.length === 0
          || !state.applied.every((item) => typeof item.canonical_path === 'string' && isDefinitelyMissing(item.canonical_path))
        ) continue
        rmSync(filePath)
        removed += 1
      } catch {
        // MXC owns the schema; preserve malformed or concurrently changing files.
      }
    }
  } catch {
    return removed
  }
  return removed
}

function isDefinitelyMissing(path: string): boolean {
  try {
    lstatSync(path)
    return false
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
  }
}

function resolveMxcDaclStateDir(): string | undefined {
  const explicit = process.env.MXC_DACL_STATE_DIR?.trim()
  if (explicit) return resolve(explicit)
  const localAppData = process.env.LOCALAPPDATA?.trim()
  return localAppData ? join(localAppData, 'Microsoft', 'MXC', 'dacl-restore') : undefined
}

function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}

export async function probeProcessSandbox(
  input: ProcessSandboxProbeInput,
): Promise<ProcessSandboxProbeResult> {
  const support = getProcessSandboxSupport()
  if (!support.available) return { ...support, verified: false }
  if (!existsSync(input.probeRoot) || !existsSync(input.deniedPath)) {
    return {
      ...support,
      verified: false,
      reason: 'Sandbox probe roots must already exist',
    }
  }

  const probeDir = mkdtempSync(join(resolve(input.probeRoot), '.lume-process-sandbox-'))
  const allowedFile = join(probeDir, 'allowed.txt')
  const outputFile = join(probeDir, 'output.txt')
  writeFileSync(allowedFile, 'allowed', 'utf8')
  const timeoutMs = input.timeoutMs ?? 30_000
  const script = [
    "const fs=require('node:fs')",
    "const [allowed,output,denied]=process.argv.slice(1)",
    "if(fs.readFileSync(allowed,'utf8')!=='allowed')process.exit(20)",
    "fs.writeFileSync(output,'verified','utf8')",
    "try{fs.readdirSync(denied);process.exit(21)}catch(error){",
    "if(!error||!['EACCES','EPERM'].includes(error.code))process.exit(22)",
    "}",
  ].join(';')

  try {
    const child = spawnWithProcessSandbox(process.execPath, ['-e', script, allowedFile, outputFile, resolve(input.deniedPath)], {
      cwd: probeDir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    }, {
      enabled: true,
      filesystem: {
        denyRead: [input.deniedPath],
        denyWrite: [input.deniedPath],
      },
      processIsolation: {
        enabled: true,
        required: true,
        readonlyPaths: input.readonlyPaths,
        readwritePaths: [probeDir, ...(input.readwritePaths ?? [])],
        deniedPaths: [input.deniedPath],
        allowOutbound: true,
        allowLocalNetwork: true,
      },
    })
    const stderr: Buffer[] = []
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error(`Sandbox probe timed out after ${timeoutMs}ms`))
      }, timeoutMs + 1_000)
      timer.unref?.()
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        resolveExit(code)
      })
    })
    const verified = exitCode === 0 && existsSync(outputFile)
    return {
      ...support,
      verified,
      reason: verified
        ? 'OS process sandbox enforcement probe passed'
        : `Sandbox probe exited with code ${exitCode ?? 'null'}${stderr.length ? `: ${Buffer.concat(stderr).toString('utf8').trim().slice(0, 500)}` : ''}`,
    }
  } catch (error) {
    return {
      ...support,
      verified: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await removeProbeDirectory(probeDir)
  }
}

async function removeProbeDirectory(path: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true })
      return
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EPERM') return
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
    }
  }
}

export function buildCommandLine(command: string, args: string[], platform = process.platform): string {
  const quote = platform === 'win32' ? quoteWindowsArgument : quotePosixArgument
  return [command, ...args].map(quote).join(' ')
}

export function buildSandboxEnvironment(
  source: NodeJS.ProcessEnv,
  executableSearchPaths: string[] = [],
  platform = process.platform,
): NodeJS.ProcessEnv {
  const preferredPaths = uniqueExistingPaths(executableSearchPaths)
  if (preferredPaths.length === 0) return source

  const env = { ...source }
  const pathKeys = Object.keys(env).filter((key) => key.toLocaleLowerCase() === 'path')
  const currentPath = pathKeys.map((key) => env[key]).find(Boolean) ?? ''
  for (const key of pathKeys) delete env[key]
  const seen = new Set<string>()
  const pathValue = [
    ...preferredPaths,
    ...currentPath.split(delimiter).filter(Boolean),
  ].filter((value) => {
    const key = platform === 'win32' ? value.toLocaleLowerCase() : value
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).join(delimiter)
  env[platform === 'win32' ? 'Path' : 'PATH'] = pathValue
  return env
}

function mapPlatformSupport(support: PlatformSupport): ProcessSandboxSupport {
  return {
    available: support.isSupported && (
      process.platform !== 'win32'
      || support.availableMethods.includes('processcontainer')
    ),
    reason: support.reason || (support.isSupported ? '' : 'MXC reports this platform as unsupported'),
    ...(support.isolationTier ? { isolationTier: support.isolationTier } : {}),
    warnings: support.isolationWarnings ?? [],
  }
}

function resolveExecutable(command: string, env: NodeJS.ProcessEnv): string {
  if (isAbsolute(command)) return resolve(command)
  const pathEntries = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')
    : ['']
  for (const pathEntry of pathEntries) {
    for (const extension of extensions) {
      const candidate = join(pathEntry, command.toLocaleLowerCase().endsWith(extension.toLocaleLowerCase()) ? command : `${command}${extension}`)
      if (existsSync(candidate)) return resolve(candidate)
    }
  }
  return command
}

function shouldGrantExecutableDirectory(executable: string): boolean {
  if (!isAbsolute(executable)) return false
  if (process.platform !== 'win32') return true
  const normalized = executable.toLocaleLowerCase()
  const implicitRoots = [
    process.env.SystemRoot,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
  ].filter((value): value is string => Boolean(value)).map((value) => resolve(value).toLocaleLowerCase())
  return !implicitRoots.some((root) => normalized === root || normalized.startsWith(`${root}\\`))
}

function uniqueExistingPaths(paths: string[]): string[] {
  return uniquePaths(paths).filter(existsSync)
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.filter(Boolean).map((value) => resolve(value)))]
}

function isPathWithin(root: string, target: string): boolean {
  const value = relative(resolve(root), resolve(target))
  return value === '' || (!value.startsWith('..') && !isAbsolute(value))
}

function quoteWindowsArgument(value: string): string {
  if (value.length > 0 && !/[\s"]/u.test(value)) return value
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`
}

function quotePosixArgument(value: string): string {
  if (value.length > 0 && !/[^A-Za-z0-9_@%+=:,./-]/u.test(value)) return value
  return `'${value.replaceAll("'", `'"'"'`)}'`
}
