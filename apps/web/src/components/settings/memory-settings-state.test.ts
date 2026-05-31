import { describe, expect, test } from 'bun:test'
import {
  MEMORY_SETTINGS_VIEWS,
  MEMORY_TOOL_POLICY_GROUPS,
  buildEmbeddingModelOptions,
  buildMemoryLayerMetrics,
  buildRerankModelOptions,
  buildMemoryDetailRows,
  buildMemoryOverviewMetrics,
  localOnnxStatusTone,
  isMemoryToolGroupEnabled,
  pendingNotice,
  setMemoryToolGroupEnabled,
  summarizeMemoryIngestSourcesJob,
  summarizeMemoryIngestSourcesResult,
  summarizeMemoryOrganizeEntriesResult,
  summarizeMemoryOrganizeResult,
  summarizeMemoryEntry,
  summarizeLocalOnnxStatus,
} from './memory-settings-state'

describe('memory settings state', () => {
  test('memory settings views expose V2-only order', () => {
    expect(MEMORY_SETTINGS_VIEWS.map((item) => item.id)).toEqual([
      'overview',
      'workspace',
      'global',
      'pending',
    ])
  })

  test('overview metrics and pending notice stay quiet until action is needed', () => {
    const metrics = buildMemoryOverviewMetrics({
      workspaceSlug: 'demo',
      counts: {
        active: 3,
        workspace: 2,
        global: 1,
        suspectedStale: 1,
        pinned: 1,
        daily: 4,
        runs: 2,
        pending: {
          conflicts: 1,
          stale: 1,
          lowConfidence: 0,
          total: 2,
        },
      },
      files: [],
      workspaceEntries: [],
      globalEntries: [],
      pending: [],
      retrieval: {
        semantic: {
          mode: 'auto',
          status: 'not_configured',
          message: '未配置 embedding，基础召回仍可用',
        },
        rerank: {
          source: 'disabled',
        },
      },
    })

    expect(metrics.map((item) => item.value)).toEqual(['3', '2', '1', '1', '2'])
    expect(metrics.at(-1)?.tone).toBe('warn')
    expect(pendingNotice({
      conflicts: 1,
      stale: 1,
      lowConfidence: 0,
      total: 2,
    })).toBe('1 个冲突 · 1 个可能过期')
    expect(pendingNotice()).toBe('无待处理记忆')
  })

  test('layer metrics expose Alice-style memory categories without changing storage', () => {
    const snapshot = {
      workspaceSlug: 'demo',
      counts: {
        active: 3,
        workspace: 2,
        global: 1,
        suspectedStale: 0,
        pinned: 0,
        daily: 0,
        runs: 0,
        pending: {
          conflicts: 0,
          stale: 0,
          lowConfidence: 0,
          total: 0,
        },
      },
      files: [],
      workspaceEntries: [{
        id: 'voice-1',
        path: 'voice.md',
        scope: 'workspace' as const,
        kind: 'preference' as const,
        status: 'active' as const,
        confidence: 'high' as const,
        statement: '用户写作风格偏好简洁、有温度',
        updated: '2026-05-31T00:00:00.000Z',
        pinned: false,
        tags: ['voice', 'writing-style'],
        claim: {
          subject: 'user/self',
          predicate: 'writing_style',
          object: '简洁、有温度',
        },
      }, {
        id: 'rule-1',
        path: 'rule.md',
        scope: 'workspace' as const,
        kind: 'fact' as const,
        status: 'active' as const,
        confidence: 'high' as const,
        statement: 'Markdown 是事实源',
        updated: '2026-05-31T00:00:00.000Z',
        pinned: false,
        tags: [],
        claim: {
          subject: 'workspace/default',
          predicate: 'source_of_truth',
          object: 'Markdown',
        },
      }],
      globalEntries: [{
        id: 'profile-1',
        path: 'profile.md',
        scope: 'global' as const,
        kind: 'preference' as const,
        status: 'active' as const,
        confidence: 'high' as const,
        statement: '用户希望被称呼为 Mason',
        updated: '2026-05-31T00:00:00.000Z',
        pinned: false,
        tags: ['profile', 'identity', 'preferred-name'],
        claim: {
          subject: 'user/self',
          predicate: 'preferred_name',
          object: 'Mason',
        },
      }],
      pending: [],
      retrieval: {
        semantic: {
          mode: 'auto' as const,
          status: 'available' as const,
          message: '语义召回可用',
        },
        rerank: {
          source: 'disabled' as const,
        },
      },
    }

    expect(buildMemoryLayerMetrics(snapshot).map((item) => [item.label, item.value])).toEqual([
      ['身份画像', '1'],
      ['写作风格', '1'],
      ['规则指令', '1'],
      ['语义条目', '3'],
    ])
  })

  test('labels keep memory UI compact and localized', () => {
    expect(summarizeMemoryEntry({
      id: 'mem-1',
      path: 'MEMORY.md',
      scope: 'workspace',
      kind: 'decision',
      status: 'suspected_stale',
      confidence: 'medium',
      statement: 'Use Memory V2.',
      updated: '2026-05-19T00:00:00.000Z',
      pinned: false,
      tags: [],
    })).toBe('工作区 · 决策 · 可能过期')
  })

  test('memory detail rows expose readable metadata for selected entries', () => {
    expect(buildMemoryDetailRows({
      id: 'mem-1',
      path: '/tmp/memory/entries/mem-1.md',
      text: 'User wants Lume memory details to show full content.',
      metadata: {
        scope: 'workspace',
        kind: 'decision',
        tags: ['memory-ui'],
        claim: {
          subject: 'workspace/default',
          predicate: 'preference',
          object: 'show full memory content',
        },
      },
      citation: '/tmp/memory/entries/mem-1.md',
    })).toEqual([
      { label: '范围', value: '工作区' },
      { label: '类型', value: '决策' },
      { label: 'Claim', value: 'workspace/default.preference = show full memory content' },
      { label: '标签', value: 'memory-ui' },
      { label: '路径', value: '/tmp/memory/entries/mem-1.md' },
    ])
  })

  test('organize result summary keeps the history action scannable', () => {
    expect(summarizeMemoryOrganizeResult({
      workspaceSlug: 'demo',
      scannedSources: 2,
      scannedMessages: 20,
      candidateCount: 4,
      actions: {
        duplicate: 1,
        related: 1,
        mergeable: 0,
        conflict: 1,
        suspected_stale: 0,
        low_confidence: 0,
        new: 1,
        suppressed: 0,
      },
      items: [],
    })).toBe('扫描 20 条用户消息 · 抽取 4 条候选 · 写入 2 条 · 重复 1 条 · 待处理 1 条')
  })

  test('entry organize result summary keeps memory cleanup scannable', () => {
    expect(summarizeMemoryOrganizeEntriesResult({
      workspaceSlug: 'demo',
      scannedEntries: 6,
      keptEntries: 4,
      supersededDuplicates: 2,
      items: [],
    })).toBe('扫描 6 条历史记忆 · 保留 4 条 · 归并重复 2 条')
  })

  test('ingest result summary keeps external source imports scannable', () => {
    expect(summarizeMemoryIngestSourcesResult({
      workspaceSlug: 'demo',
      scannedSources: 2,
      scannedChunks: 2,
      scannedBatches: 1,
      candidateCount: 3,
      actions: {
        duplicate: 1,
        related: 0,
        mergeable: 0,
        conflict: 1,
        suspected_stale: 0,
        low_confidence: 0,
        new: 1,
        suppressed: 0,
      },
      items: [],
    })).toBe('扫描 2 个来源 · 分析 1 批 · 处理 2 段 · 抽取 3 条候选 · 写入 1 条 · 重复 1 条 · 待处理 1 条')
    expect(summarizeMemoryIngestSourcesJob({
      jobId: 'job-1',
      workspaceSlug: 'demo',
      status: 'running',
      startedAt: 100,
    })).toBe('后台整理中')
    expect(summarizeMemoryIngestSourcesJob({
      jobId: 'job-2',
      workspaceSlug: 'demo',
      status: 'failed',
      startedAt: 100,
      completedAt: 200,
      error: '本地文件不存在',
    })).toBe('整理失败：本地文件不存在')
  })

  test('memory tool policy group helpers toggle allow entries', () => {
    const config = {
      version: 1,
      tools: { allow: ['group:memory'] },
      citations: 'auto' as const,
      sources: ['memory' as const],
      extraPaths: [],
    }

    expect(MEMORY_TOOL_POLICY_GROUPS.map((group) => group.id)).toEqual([
      'group:memory',
      'group:memory-write',
    ])
    expect(isMemoryToolGroupEnabled(config.tools, 'group:memory')).toBe(true)
    expect(setMemoryToolGroupEnabled(config, 'group:memory-write', true).allow).toEqual([
      'group:memory',
      'group:memory-write',
    ])
    expect(setMemoryToolGroupEnabled(config, 'group:memory', false).allow).toEqual([])
  })

  test('embedding options only include enabled embedding-capable models', () => {
    expect(buildEmbeddingModelOptions([{
      id: 'openai-main',
      name: 'OpenAI',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'encrypted',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
      models: [
        { id: 'gpt-5', name: 'GPT-5', enabled: true, capabilities: { chat: true } },
        { id: 'text-embedding-3-small', name: 'Embed small', enabled: true, capabilities: { embedding: true } },
        { id: 'text-embedding-disabled', name: 'Disabled embed', enabled: false, capabilities: { embedding: true } },
      ],
    }, {
      id: 'siliconflow',
      name: 'SiliconFlow',
      provider: 'siliconflow',
      baseUrl: 'https://api.siliconflow.cn/v1',
      apiKey: 'encrypted',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
      models: [
        { id: 'Qwen/Qwen3-Embedding-0.6B', name: 'Qwen3 0.6B', enabled: true, capabilities: { embedding: true } },
      ],
    }, {
      id: 'disabled',
      name: 'Disabled',
      provider: 'jina',
      baseUrl: 'https://api.jina.ai/v1',
      apiKey: 'encrypted',
      enabled: false,
      createdAt: 1,
      updatedAt: 1,
      models: [
        { id: 'jina-embeddings-v3', name: 'Jina v3', enabled: true, capabilities: { embedding: true } },
      ],
    }])).toEqual([{
      modelRef: 'local-onnx/Xenova/bge-small-zh-v1.5',
      label: '本地 ONNX bge-small-zh',
    }, {
      modelRef: 'openai/text-embedding-3-small',
      label: 'Embed small · OpenAI',
    }, {
      modelRef: 'siliconflow/Qwen/Qwen3-Embedding-0.6B',
      label: 'Qwen3 0.6B · SiliconFlow',
    }])
  })

  test('local ONNX status helpers keep download awareness visible', () => {
    const status = {
      modelRef: 'local-onnx/Xenova/bge-small-zh-v1.5',
      label: '本地 ONNX bge-small-zh',
      status: 'downloading' as const,
      cacheDir: '/tmp/lume/memory/models',
      message: '正在下载并初始化本地 ONNX 模型，首次使用可能需要一点时间。',
    }

    expect(summarizeLocalOnnxStatus(status)).toBe(status.message)
    expect(localOnnxStatusTone(status.status)).toBe('warn')
  })

  test('rerank options include enabled chat models but skip embedding-only models', () => {
    expect(buildRerankModelOptions([{
      id: 'glm',
      name: 'GLM',
      provider: 'zai',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'encrypted',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
      models: [
        { id: 'glm-4.5-air', name: 'GLM 4.5 Air', enabled: true, capabilities: { chat: true } },
        { id: 'embedding-3', name: 'Embedding 3', enabled: true, capabilities: { embedding: true, chat: false } },
      ],
    }])).toEqual([{
      modelRef: 'zai/glm-4.5-air',
      label: 'GLM 4.5 Air · GLM',
    }])
  })
})
