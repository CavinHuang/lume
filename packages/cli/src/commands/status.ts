import type { CAC } from "cac"

import { requireContextMethod, type CliCommandContext, type CliIo } from "../cli"
import { writeJson } from "../output"

interface RegisterStatusCommandsOptions {
  app: CAC
  resolveContext: () => Promise<CliCommandContext>
  io?: CliIo
}

export function registerStatusCommands(options: RegisterStatusCommandsOptions): void {
  const stdout = options.io?.stdout ?? console

  options.app.command("status", "Show runtime status").action(async () => {
    const context = await options.resolveContext()
    writeJson(await requireContextMethod(context.status, "status")(), stdout)
  })

  options.app.command("health", "Run CLI healthcheck").action(async () => {
    const context = await options.resolveContext()
    writeJson(await requireContextMethod(context.health, "health")(), stdout)
  })
}
