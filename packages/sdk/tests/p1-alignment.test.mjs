import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sdk = await import('../dist/index.js')

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-sdk-p1-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('filesystem commands and skills appear in initialization metadata', async () => {
  await withTempDir(async (cwd) => {
    await mkdir(join(cwd, '.claude', 'commands'), { recursive: true })
    await mkdir(join(cwd, '.claude', 'skills', 'explain'), { recursive: true })

    await writeFile(
      join(cwd, '.claude', 'commands', 'ship.md'),
      '---\ndescription: Ship the release\n---\nRun the shipping flow.',
      'utf-8',
    )
    await writeFile(
      join(cwd, '.claude', 'skills', 'explain', 'SKILL.md'),
      '---\ndescription: Explain a concept\nwhen_to_use: User asks for an explanation\n---\nExplain the requested concept clearly.',
      'utf-8',
    )

    const agent = sdk.createAgent({ cwd, persistSession: false })
    const init = await agent.getInitializationResult()

    assert.ok(init.commands.some((command) => command.name === '/ship'))
    assert.ok(init.commands.some((command) => command.name === '/explain'))
    assert.ok(init.slash_commands?.includes('/ship'))
    assert.ok(init.skills?.includes('explain'))

    await agent.close()
  })
})

test('plugin commands appear in initialization metadata', async () => {
  await withTempDir(async (cwd) => {
    const pluginDir = join(cwd, 'demo-plugin')
    await mkdir(pluginDir, { recursive: true })
    await writeFile(
      join(pluginDir, 'index.mjs'),
      `export default {
        name: 'demo-plugin',
        commands: [{ name: 'plugin:hello', description: 'Say hello from plugin' }],
      }
      `,
      'utf-8',
    )

    const agent = sdk.createAgent({
      cwd,
      persistSession: false,
      plugins: [{ name: 'demo-plugin', path: './demo-plugin' }],
    })
    const init = await agent.getInitializationResult()

    assert.ok(init.commands.some((command) => command.name === '/plugin:hello'))
    assert.ok(init.plugins?.some((plugin) => plugin.name === 'demo-plugin'))

    await agent.close()
  })
})

test('resumeSessionAt truncates restored history to the selected message', async () => {
  await withTempDir(async (cwd) => {
    const sessionId = 'resume-session-test'
    const messages = [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
      { role: 'user', content: 'second question' },
      { role: 'assistant', content: [{ type: 'text', text: 'second answer' }] },
    ]
    const sessionMessages = [
      { uuid: 'u1', role: 'user', timestamp: new Date().toISOString(), content: 'first question' },
      { uuid: 'a1', role: 'assistant', timestamp: new Date().toISOString(), content: [{ type: 'text', text: 'first answer' }] },
      { uuid: 'u2', role: 'user', timestamp: new Date().toISOString(), content: 'second question' },
      { uuid: 'a2', role: 'assistant', timestamp: new Date().toISOString(), content: [{ type: 'text', text: 'second answer' }] },
    ]

    await sdk.saveSession(sessionId, messages, {
      cwd,
      model: 'claude-sonnet-4-6',
      sessionMessages,
      checkpoints: {},
    })

    const agent = sdk.createAgent({
      cwd,
      persistSession: false,
      resume: sessionId,
      resumeSessionAt: 'a1',
    })
    await agent.getInitializationResult()

    assert.equal(agent.history.length, 2)
    assert.equal(agent.sessionMessages.length, 2)
    assert.equal(agent.sessionMessages[1].uuid, 'a1')

    await agent.close()
  })
})
