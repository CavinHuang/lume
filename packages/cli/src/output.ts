import { CliCommandError } from "./errors"

export interface JsonStdout {
  log(message: string): void
}

export interface JsonStderr {
  error(message: string): void
}

export function writeJson(value: unknown, stdout: JsonStdout = console): void {
  stdout.log(JSON.stringify(value))
}

export function writeError(error: unknown, stderr: JsonStderr = console): number {
  const cliError = error instanceof CliCommandError
    ? error
    : new CliCommandError(
        error instanceof Error ? error.message : "Unknown CLI error",
        { code: "CLI_UNKNOWN_ERROR" },
      )

  stderr.error(
    JSON.stringify({
      error: {
        code: cliError.code,
        message: cliError.message,
      },
    }),
  )

  return cliError.exitCode
}
