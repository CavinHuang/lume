import type { CAC } from "cac"

import { requireContextMethod, type CliCommandContext, type CliIo } from "../cli"
import { CliCommandError } from "../errors"

interface RegisterAskCommandOptions {
  app: CAC
  resolveContext: () => Promise<CliCommandContext>
  io?: CliIo
}

function validateAskTarget(commandOptions: { workspace?: string; thread?: string }): void {
  if (commandOptions.workspace && commandOptions.thread) {
    throw new CliCommandError('Exactly one of "--workspace" or "--thread" may be provided', {
      code: "USAGE_ERROR",
      exitCode: 2,
    })
  }
}

export function registerAskCommand(options: RegisterAskCommandOptions): void {
  const stdout = options.io?.stdout ?? console

  options.app
    .command("ask <text>", "Ask in a new or existing thread")
    .option("--workspace <slug>", "Workspace slug for new thread creation")
    .option("--thread <threadId>", "Continue an existing thread")
    .action(async (text: string, commandOptions: { workspace?: string; thread?: string }) => {
      validateAskTarget(commandOptions)
      const context = await options.resolveContext()
      const reply = await requireContextMethod(context.ask, "ask")({
        text,
        workspaceSlug: commandOptions.workspace,
        threadId: commandOptions.thread,
      })

      stdout.log(reply)
    })
}
