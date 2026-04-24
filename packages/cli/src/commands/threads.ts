import type { CAC } from "cac"

import { requireContextMethod, type CliCommandContext, type CliIo } from "../cli"
import { CliCommandError } from "../errors"
import { writeJson } from "../output"

interface RegisterThreadsCommandsOptions {
  app: CAC
  resolveContext: () => Promise<CliCommandContext>
  io?: CliIo
}

function parseOptionalLimit(limit: string | undefined): number | undefined {
  if (typeof limit === "undefined") {
    return undefined
  }

  if (!/^[1-9]\d*$/.test(limit)) {
    throw new CliCommandError('Argument "[limit]" must be a positive integer', {
      code: "USAGE_ERROR",
      exitCode: 2,
    })
  }

  return Number(limit)
}

export function registerThreadCommands(options: RegisterThreadsCommandsOptions): void {
  const stdout = options.io?.stdout ?? console

  options.app
    .command("threads [limit]", "List threads")
    .option("--workspace <workspaceSlug>", "Filter by workspace slug")
    .action(async (limit: string | undefined, commandOptions: { workspace?: string }) => {
      const context = await options.resolveContext()
      const threads = await requireContextMethod(context.listThreads, "threads")({
        workspaceSlug: commandOptions.workspace,
        limit: parseOptionalLimit(limit),
      })

      writeJson({ threads }, stdout)
    })

  options.app
    .command("thread create", "Create a thread")
    .option("--workspace <workspaceSlug>", "Associate the thread with a workspace")
    .action(async (commandOptions: { workspace?: string }) => {
      const context = await options.resolveContext()
      writeJson(await requireContextMethod(context.createThread, "thread create")({
        workspaceSlug: commandOptions.workspace,
      }), stdout)
    })

  options.app.command("thread messages <threadId> [limit]", "List thread messages").action(
    async (threadId: string, limit: string | undefined) => {
      const context = await options.resolveContext()
      writeJson({
        messages: await requireContextMethod(context.getThreadMessages, "thread messages")({
          threadId,
          limit: parseOptionalLimit(limit),
        }),
      }, stdout)
    },
  )

  options.app.command("thread send <threadId> <text>", "Send a message to a thread").action(
    async (threadId: string, text: string) => {
      const context = await options.resolveContext()
      const result = await requireContextMethod(context.sendThreadMessage, "thread send")({
        threadId,
        text,
      })

      writeJson(result.accepted, stdout)
    },
  )
}
