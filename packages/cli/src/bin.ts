#!/usr/bin/env bun

import { pathToFileURL } from "node:url"
import { format } from "node:util"

import { createCliApp, type CliCommandContext, type CliIo } from "./cli"
import type { JsonStderr, JsonStdout } from "./output"
import { writeError } from "./output"

export interface CliMainDeps {
  createRuntime?: () => CliCommandContext | Promise<CliCommandContext>
}

async function createDefaultRuntime(): Promise<CliCommandContext> {
  const { createCliRuntime } = await import("@lume/sidecar/headless/cli-runtime")
  return createCliRuntime()
}

function createProcessStdout(): JsonStdout {
  return {
    log(message: string) {
      process.stdout.write(`${message}\n`)
    },
  }
}

function createProcessStderr(): JsonStderr {
  return {
    error(message: string) {
      process.stderr.write(`${message}\n`)
    },
  }
}

function isMetadataOnlyArgv(argv: string[]): boolean {
  const args = argv.slice(2)
  return args.length === 0
    || args.includes("--help")
    || args.includes("-h")
    || args.includes("--version")
    || args.includes("-v")
}

async function withConsoleSilenced<T>(
  stderr: JsonStderr,
  callback: () => Promise<T>,
): Promise<T> {
  const originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  }

  console.log = () => undefined
  console.info = () => undefined
  console.warn = () => undefined
  console.debug = () => undefined
  console.error = (...args: unknown[]) => {
    stderr.error(format(...args))
  }

  try {
    return await callback()
  } finally {
    console.log = originalConsole.log
    console.info = originalConsole.info
    console.warn = originalConsole.warn
    console.error = originalConsole.error
    console.debug = originalConsole.debug
  }
}

function isDirectExecution(): boolean {
  const importMeta = import.meta as ImportMeta & { main?: boolean }
  if (importMeta.main) {
    return true
  }

  const entryArg = process.argv[1]
  return Boolean(entryArg && import.meta.url === pathToFileURL(entryArg).href)
}

export async function main(
  argv = process.argv,
  deps: CliMainDeps = {},
  io: CliIo = {},
): Promise<number> {
  const createRuntime = deps.createRuntime ?? createDefaultRuntime
  const stdout = io.stdout ?? createProcessStdout()
  const stderr = io.stderr ?? createProcessStderr()

  try {
    const execute = async () => {
      const app = createCliApp(() => createRuntime(), { stdout, stderr })
      app.parse(argv, { run: false })
      await app.runMatchedCommand()
      return 0
    }

    if (isMetadataOnlyArgv(argv)) {
      return await execute()
    }

    return await withConsoleSilenced(stderr, execute)
  } catch (error) {
    return writeError(error, stderr)
  }
}

if (isDirectExecution()) {
  void main().then((exitCode) => {
    if (exitCode !== 0) {
      process.exitCode = exitCode
    }
  })
}
