import type { CAC } from "cac"

import { requireContextMethod, type CliCommandContext, type CliIo } from "../cli"
import { CliCommandError } from "../errors"
import { writeJson } from "../output"

interface TargetOptions {
  thread?: string
  workspace?: string
}

interface RegisterFilesCommandsOptions {
  app: CAC
  resolveContext: () => Promise<CliCommandContext>
  io?: CliIo
}

function getTarget(options: TargetOptions): { threadId?: string; workspaceSlug?: string } {
  const hasThread = typeof options.thread === "string"
  const hasWorkspace = typeof options.workspace === "string"

  if (hasThread === hasWorkspace) {
    throw new CliCommandError('Exactly one of "--thread" or "--workspace" is required', {
      code: "USAGE_ERROR",
      exitCode: 2,
    })
  }

  return {
    threadId: options.thread,
    workspaceSlug: options.workspace,
  }
}

export function registerFileCommands(options: RegisterFilesCommandsOptions): void {
  const stdout = options.io?.stdout ?? console

  options.app
    .command("files", "List files for a thread or workspace")
    .option("--thread <threadId>", "Target thread ID")
    .option("--workspace <workspaceSlug>", "Target workspace slug")
    .action(async (commandOptions: TargetOptions) => {
      const context = await options.resolveContext()
      writeJson({ files: await requireContextMethod(context.listFiles, "files")(getTarget(commandOptions)) }, stdout)
    })

  options.app
    .command("file add <path>", "Attach a file to a thread or workspace")
    .option("--thread <threadId>", "Target thread ID")
    .option("--workspace <workspaceSlug>", "Target workspace slug")
    .action(async (path: string, commandOptions: TargetOptions) => {
      const context = await options.resolveContext()
      const target = getTarget(commandOptions)

      if (target.threadId) {
        writeJson(await requireContextMethod(context.addFileToThread, "file add")({
          threadId: target.threadId,
          sourcePath: path,
        }), stdout)
        return
      }

      writeJson(await requireContextMethod(context.addFileToWorkspace, "file add")({
        workspaceSlug: target.workspaceSlug as string,
        sourcePath: path,
      }), stdout)
    })
}
