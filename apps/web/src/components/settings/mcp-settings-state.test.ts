import { describe, expect, test } from 'bun:test'
import type { McpServerStatus, WorkspaceMcpConfig } from '@lume/shared'
import {
  MCP_TRANSPORT_OPTIONS,
  buildMcpConfigAfterSave,
  buildMcpServerRows,
  buildMcpToolDisplayItems,
  createMcpServerDraft,
  formatMcpLastChecked,
  formatMcpToolPreview,
  parseMcpConfigImportText,
  shouldPollMcpStatus,
} from './mcp-settings-state'

describe('mcp settings state', () => {
  test('transport options use canonical streamable_http value', () => {
    expect(MCP_TRANSPORT_OPTIONS.map((option) => option.value)).toEqual([
      'stdio',
      'streamable_http',
      'sse',
    ])
  })

  test('builds rows from config and live status', () => {
    const config: WorkspaceMcpConfig = {
      servers: {
        github: {
          enabled: true,
          transport: 'streamable_http',
          url: 'http://127.0.0.1:8787/mcp',
        },
        filesystem: {
          enabled: false,
          type: 'stdio',
          command: 'npx',
        },
      },
    }
    const statuses: McpServerStatus[] = [{
      serverId: 'github',
      name: 'GitHub',
      enabled: true,
      transport: 'streamable_http',
      status: 'connected',
      tools: ['search_issues', 'create_issue'],
      toolDetails: [],
      lastCheckedAt: 1_700_000_000_000,
      lastConnectedAt: 1_700_000_000_000,
    }]

    expect(buildMcpServerRows(config.servers, statuses, 1_700_000_120_000)).toEqual([
      expect.objectContaining({
        name: 'github',
        displayName: 'GitHub',
        transport: 'streamable_http',
        status: 'connected',
        statusLabel: '已连接',
        toolCount: 2,
        lastChecked: '2 分钟前',
      }),
      expect.objectContaining({
        name: 'filesystem',
        displayName: 'filesystem',
        transport: 'stdio',
        status: 'disconnected',
        statusLabel: '未启用',
        toolCount: 0,
        lastChecked: '—',
      }),
    ])
  })

  test('surfaces enabled server diagnostics as warning rows', () => {
    const rows = buildMcpServerRows({
      broken: {
        enabled: true,
        transport: 'stdio',
        command: 'missing-command',
      },
    }, [{
      serverId: 'broken',
      name: 'broken',
      enabled: true,
      transport: 'stdio',
      status: 'error',
      tools: [],
      toolDetails: [],
      error: { code: 'spawn_failed', message: 'command not found' },
      lastCheckedAt: 1_700_000_000_000,
    }], 1_700_000_010_000)

    expect(rows[0]).toMatchObject({
      status: 'warning',
      statusLabel: '异常',
      errorMessage: 'command not found',
      lastChecked: '刚刚',
    })
  })

  test('builds display items from loaded MCP tool details', () => {
    const rows = buildMcpServerRows({
      github: {
        enabled: true,
        transport: 'streamable_http',
        url: 'http://127.0.0.1:8787/mcp',
      },
    }, [{
      serverId: 'github',
      name: 'GitHub',
      enabled: true,
      transport: 'streamable_http',
      status: 'connected',
      tools: ['mcp__github__search_issues', 'mcp__github__create_issue'],
      toolDetails: [
        {
          name: 'mcp__github__search_issues',
          originalName: 'search/issues',
          wrapperName: 'mcp__github__search_issues',
          description: 'Search GitHub issues',
          serverId: 'github',
          serverName: 'GitHub',
        },
        {
          name: 'mcp__github__create_issue',
          originalName: 'create_issue',
          wrapperName: 'mcp__github__create_issue',
          serverId: 'github',
          serverName: 'GitHub',
        },
      ],
    }])

    expect(buildMcpToolDisplayItems(rows[0]!)).toEqual([
      {
        label: 'search/issues',
        originalName: 'search/issues',
        wrapperName: 'mcp__github__search_issues',
        description: 'Search GitHub issues',
        enabled: true,
      },
      {
        label: 'create_issue',
        originalName: 'create_issue',
        wrapperName: 'mcp__github__create_issue',
        enabled: true,
      },
    ])
  })

  test('marks disabled MCP tools from server config', () => {
    const rows = buildMcpServerRows({
      demo: {
        enabled: true,
        transport: 'stdio',
        command: 'bun',
        disabledTools: ['write_file'],
      },
    }, [{
      serverId: 'demo',
      name: 'Demo',
      enabled: true,
      transport: 'stdio',
      status: 'connected',
      tools: ['read_file', 'write_file'],
      toolDetails: [],
    }])

    expect(buildMcpToolDisplayItems(rows[0]!)).toEqual([
      {
        label: 'read_file',
        originalName: 'read_file',
        wrapperName: 'read_file',
        enabled: true,
      },
      {
        label: 'write_file',
        originalName: 'write_file',
        wrapperName: 'write_file',
        enabled: false,
      },
    ])
    expect(formatMcpToolPreview(rows[0]!, 2)).toBe('read_file')
  })

  test('formats a compact preview for loaded MCP tools', () => {
    const rows = buildMcpServerRows({
      demo: {
        enabled: true,
        transport: 'stdio',
        command: 'bun',
      },
    }, [{
      serverId: 'demo',
      name: 'Demo',
      enabled: true,
      transport: 'stdio',
      status: 'connected',
      tools: ['read_file', 'write_file', 'list_dir'],
      toolDetails: [],
    }])

    expect(formatMcpToolPreview(rows[0]!, 2)).toBe('read_file, write_file +1')
    expect(formatMcpToolPreview({ ...rows[0]!, tools: [], toolDetails: [] })).toBe('暂无工具')
  })

  test('draft save writes canonical transport and trims connection fields', () => {
    const draft = createMcpServerDraft({
      name: 'github',
      entry: {
        enabled: true,
        type: 'http',
        url: ' http://127.0.0.1:8787/mcp ',
        headers: { Authorization: 'Bearer old' },
      },
    })
    draft.headersText = 'Authorization: Bearer next\nX-Debug: 1'

    expect(buildMcpConfigAfterSave({ servers: {} }, null, draft)).toEqual({
      servers: {
        github: {
          enabled: true,
          transport: 'streamable_http',
          url: 'http://127.0.0.1:8787/mcp',
          headers: {
            Authorization: 'Bearer next',
            'X-Debug': '1',
          },
        },
      },
    })
  })

  test('draft save removes old key when a server is renamed', () => {
    const next = buildMcpConfigAfterSave({
      servers: {
        old: { enabled: true, transport: 'stdio', command: 'npx' },
      },
    }, 'old', {
      name: 'new',
      enabled: true,
      transport: 'stdio',
      command: 'bunx',
      argsText: '@modelcontextprotocol/server-filesystem, /tmp',
      envText: 'DEBUG=1',
      url: '',
      headersText: '',
    })

    expect(next).toEqual({
      servers: {
        new: {
          enabled: true,
          transport: 'stdio',
          command: 'bunx',
          args: ['@modelcontextprotocol/server-filesystem', '/tmp'],
          env: { DEBUG: '1' },
        },
      },
    })
  })

  test('imports standard mcpServers JSON', () => {
    expect(parseMcpConfigImportText(JSON.stringify({
      mcpServers: {
        'GitHub MCP': {
          type: 'http',
          url: 'https://example.com/mcp',
        },
      },
    }))).toEqual({
      ok: true,
      config: {
        servers: {
          'github-mcp': {
            enabled: true,
            transport: 'streamable_http',
            url: 'https://example.com/mcp',
          },
        },
      },
    })
  })

  test('import reports invalid JSON without throwing', () => {
    expect(parseMcpConfigImportText('{')).toEqual({
      ok: false,
      error: 'JSON 格式无效',
    })
  })

  test('last checked formatter keeps table compact', () => {
    expect(formatMcpLastChecked(undefined, 1_700_000_000_000)).toBe('—')
    expect(formatMcpLastChecked(1_699_996_400_000, 1_700_000_000_000)).toBe('1 小时前')
  })

  test('polls status only while a server is connecting', () => {
    expect(shouldPollMcpStatus([
      { status: 'connected' },
      { status: 'warning' },
    ])).toBe(false)
    expect(shouldPollMcpStatus([
      { status: 'connected' },
      { status: 'connecting' },
    ])).toBe(true)
  })
})
