export class CliCommandError extends Error {
  readonly code: string
  readonly exitCode: number

  constructor(message: string, options: { code: string; exitCode?: number }) {
    super(message)
    this.name = "CliCommandError"
    this.code = options.code
    this.exitCode = options.exitCode ?? 1
  }
}

export function createUnknownCommandError(command: string): CliCommandError {
  return new CliCommandError(`Unknown command: "${command}"`, {
    code: "CLI_UNKNOWN_COMMAND",
    exitCode: 1,
  })
}
