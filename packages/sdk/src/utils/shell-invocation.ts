export function resolveShellInvocation(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  if (platform === 'win32') {
    const windowsCommand = withPowerShellNoProfile(command)
    return {
      command: env.ComSpec || env.comspec || 'cmd.exe',
      args: ['/d', '/s', '/c', windowsCommand],
    }
  }
  return { command: 'bash', args: ['-c', command] }
}

function withPowerShellNoProfile(command: string): string {
  const match = command.match(/^(\s*(?:powershell(?:\.exe)?|pwsh(?:\.exe)?))(\s|$)/i)
  if (!match || /\s-(?:noprofile|nop)\b/i.test(command)) return command
  const shell = match[1]
  if (!shell) return command
  return `${shell} -NoProfile${command.slice(shell.length)}`
}
