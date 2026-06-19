export function resolveShellInvocation(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  if (platform === 'win32') {
    return {
      command: env.ComSpec || env.comspec || 'cmd.exe',
      args: ['/d', '/s', '/c', command],
    }
  }
  return { command: 'bash', args: ['-c', command] }
}
