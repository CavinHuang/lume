import { cac, type CAC } from "cac"
import { createRequire } from "node:module"

import { registerAskCommand } from "./commands/ask"
import { registerFileCommands } from "./commands/files"
import { registerStatusCommands } from "./commands/status"
import { registerThreadCommands } from "./commands/threads"
import { registerWorkspaceCommands } from "./commands/workspaces"
import { createUnknownCommandError } from "./errors"
import { type JsonStderr, type JsonStdout } from "./output"
import type {
  AgentThreadMessage,
  AgentThreadMessageDispatchResult,
  AgentThreadMeta,
  AgentWorkspace,
} from "@lume/shared"

export interface CliCommandContext {
  status?: () => Promise<unknown>
  health?: () => Promise<unknown>
  listWorkspaces(): Promise<AgentWorkspace[]>
  createWorkspace?: (input: { name: string; slug?: string }) => Promise<AgentWorkspace>
  listThreads?: (input: { workspaceSlug?: string; limit?: number }) => Promise<AgentThreadMeta[]>
  createThread?: (input: { title?: string; workspaceSlug?: string }) => Promise<AgentThreadMeta>
  sendThreadMessage?: (input: { threadId: string; text: string }) => Promise<{
    accepted: AgentThreadMessageDispatchResult & { threadId: string }
    text: string
  }>
  ask?: (input: { text: string; workspaceSlug?: string; threadId?: string }) => Promise<string>
  getThreadMessages?: (input: { threadId: string; limit?: number }) => Promise<AgentThreadMessage[]>
  listFiles?: (input: { threadId?: string; workspaceSlug?: string }) => Promise<unknown[]>
  addFileToThread?: (input: { threadId: string; sourcePath: string }) => Promise<unknown>
  addFileToWorkspace?: (input: { workspaceSlug: string; sourcePath: string }) => Promise<unknown>
}

export interface CliIo {
  stdout?: JsonStdout
  stderr?: JsonStderr
}

const require = createRequire(import.meta.url)
const cliPackage = require("../package.json") as { version: string }

type CliCommandContextProvider =
  | CliCommandContext
  | (() => CliCommandContext | Promise<CliCommandContext>)

async function resolveContext(provider: CliCommandContextProvider): Promise<CliCommandContext> {
  return typeof provider === "function"
    ? await provider()
    : provider
}

function normalizeCompositeCommandArgv(argv: string[], commandNames: readonly string[]): string[] {
  if (argv.length < 4) {
    return argv
  }

  const compositeCommandNames = commandNames.filter((commandName) => commandName.includes(" "))
  if (compositeCommandNames.length === 0) {
    return argv
  }

  const [node = "", script = "", ...rest] = argv
  const firstOptionIndex = rest.findIndex((token) => token.startsWith("-"))
  const candidateLength = Math.min(
    Math.max(...compositeCommandNames.map((commandName) => commandName.split(" ").length)),
    firstOptionIndex === -1 ? rest.length : firstOptionIndex,
  )
  const compositeCommands = new Set(compositeCommandNames)

  for (let length = candidateLength; length >= 2; length -= 1) {
    const compositeName = rest.slice(0, length).join(" ")

    if (compositeCommands.has(compositeName)) {
      return [node, script, compositeName, ...rest.slice(length)]
    }
  }

  return argv
}

export function requireContextMethod<T>(method: T | undefined, commandName: string): T {
  if (typeof method !== "undefined") {
    return method
  }

  throw new Error(`CLI runtime does not implement "${commandName}"`)
}

export function getCliVersion(): string {
  return cliPackage.version
}

export function createCliApp(contextProvider: CliCommandContextProvider, io: CliIo = {}): CAC {
  const app = cac("lume")
  const resolveCliContext = () => resolveContext(contextProvider)
  const originalParse = app.parse.bind(app)

  app.help().version(getCliVersion())

  registerStatusCommands({ app, resolveContext: resolveCliContext, io })
  registerWorkspaceCommands({ app, resolveContext: resolveCliContext, io })
  registerThreadCommands({ app, resolveContext: resolveCliContext, io })
  registerAskCommand({ app, resolveContext: resolveCliContext, io })
  registerFileCommands({ app, resolveContext: resolveCliContext, io })

  app.on("command:*", () => {
    const [command = ""] = app.args
    throw createUnknownCommandError(command)
  })

  app.parse = ((argv?: string[], options?: { run?: boolean }) =>
    originalParse(
      argv ? normalizeCompositeCommandArgv(argv, app.commands.map((command) => command.name)) : argv,
      options,
    )) as typeof app.parse

  return app
}
