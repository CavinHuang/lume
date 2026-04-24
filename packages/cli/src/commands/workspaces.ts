import type { AgentWorkspace } from "@lume/shared"
import type { CAC } from "cac"
import { z } from "zod"

import { requireContextMethod, type CliCommandContext, type CliIo } from "../cli"
import { writeJson } from "../output"

const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

const workspacesOutputSchema = z.object({
  workspaces: z.array(workspaceSchema),
})

interface RegisterWorkspacesCommandsOptions {
  app: CAC
  resolveContext: () => Promise<CliCommandContext>
  io?: CliIo
}

function parseWorkspace(workspace: AgentWorkspace) {
  return workspaceSchema.parse(workspace)
}

export function registerWorkspaceCommands(options: RegisterWorkspacesCommandsOptions): void {
  const stdout = options.io?.stdout ?? console

  options.app.command("workspaces", "List workspaces").action(async () => {
    const context = await options.resolveContext()
    const workspaces = await context.listWorkspaces()

    writeJson(workspacesOutputSchema.parse({
      workspaces: workspaces.map(parseWorkspace),
    }), stdout)
  })

  options.app
    .command("workspace create <name>", "Create a workspace")
    .option("--slug <slug>", "Optional workspace slug")
    .action(async (name: string, commandOptions: { slug?: string }) => {
      const context = await options.resolveContext()
      const workspace = await requireContextMethod(context.createWorkspace, "workspace create")({
        name,
        slug: commandOptions.slug,
      })

      writeJson(parseWorkspace(workspace), stdout)
    })
}
