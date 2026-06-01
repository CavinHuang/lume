import { describe, expect, test } from 'bun:test'
import {
  MEMORY_SETTINGS_VIEWS,
  MEMORY_TOOL_POLICY_GROUPS,
  buildEmbeddingModelOptions,
  buildMemoryLayerMetrics,
  filterMemoryEntriesByLayer,
  filterMemoryEntriesByUserCategory,
  buildRerankModelOptions,
  buildMemoryDetailRows,
  buildMemoryOverviewMetrics,
  buildMemoryIngestItemRows,
  applyMemoryIngestTargetScope,
  localOnnxStatusTone,
  isMemoryToolGroupEnabled,
  memoryEntryLayerLabel,
  memoryPendingCandidateLayerLabel,
  pendingNotice,
  setMemoryToolGroupEnabled,
  summarizeMemoryIngestSourcesJob,
  summarizeMemoryOrganizeJob,
  summarizeMemoryIngestSourcesResult,
  summarizeMemoryExtractionStatus,
  summarizeMemoryOrganizeEntriesResult,
  summarizeMemoryOrganizeResult,
  summarizeMemoryEntry,
  summarizeLocalOnnxStatus,
} from './memory-settings-state'

describe('memory settings state', () => {
  test('memory settings views expose V2-only order', () => {
    expect(MEMORY_SETTINGS_VIEWS.map((item) => item.id)).toEqual([
      'profile',
      'workflow',
      'voice',
      'instruction',
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

  test('layer filters group entries by Alice-style memory categories', () => {
    const entries = [{
      id: 'profile-1',
      path: 'profile.md',
      scope: 'global' as const,
      kind: 'preference' as const,
      status: 'active' as const,
      confidence: 'high' as const,
      statement: '用户希望被称呼为 Mason',
      updated: '2026-05-31T00:00:00.000Z',
      pinned: false,
      tags: ['profile', 'preferred-name'],
      claim: {
        subject: 'user/self',
        predicate: 'preferred_name',
        object: 'Mason',
      },
    }, {
      id: 'voice-1',
      path: 'voice.md',
      scope: 'global' as const,
      kind: 'preference' as const,
      status: 'active' as const,
      confidence: 'high' as const,
      statement: '用户写作风格偏好简洁',
      updated: '2026-05-31T00:00:00.000Z',
      pinned: false,
      tags: ['voice'],
      claim: {
        subject: 'user/self',
        predicate: 'writing_style',
        object: '简洁',
      },
    }, {
      id: 'global-rule-1',
      path: 'MEMORY.md',
      scope: 'global' as const,
      kind: 'summary' as const,
      status: 'active' as const,
      confidence: 'high' as const,
      statement: '最终回复需要说明剩余风险',
      updated: '2026-05-31T00:00:00.000Z',
      pinned: true,
      tags: [],
    }, {
      id: 'claim-1',
      path: 'claim.md',
      scope: 'workspace' as const,
      kind: 'decision' as const,
      status: 'active' as const,
      confidence: 'high' as const,
      statement: 'Memory V2 使用 Markdown 作为事实源',
      updated: '2026-05-31T00:00:00.000Z',
      pinned: false,
      tags: [],
      claim: {
        subject: 'workspace/default',
        predicate: 'source_of_truth',
        object: 'Markdown',
      },
    }]

    expect(filterMemoryEntriesByLayer(entries, 'profile').map((entry) => entry.id)).toEqual(['profile-1'])
    expect(filterMemoryEntriesByLayer(entries, 'voice').map((entry) => entry.id)).toEqual(['voice-1'])
    expect(filterMemoryEntriesByLayer(entries, 'global-memory').map((entry) => entry.id)).toEqual(['global-rule-1'])
    expect(filterMemoryEntriesByLayer(entries, 'structured').map((entry) => entry.id)).toEqual(['claim-1'])
    expect(filterMemoryEntriesByLayer(entries, 'all')).toHaveLength(4)
    expect(memoryEntryLayerLabel(entries[0])).toBe('身份画像')
    expect(memoryEntryLayerLabel(entries[1])).toBe('写作风格')
    expect(memoryEntryLayerLabel(entries[2])).toBe('全局记忆')
    expect(memoryEntryLayerLabel(entries[3])).toBe('结构化事实')
  })

  test('user memory categories keep the primary settings page approachable', () => {
    const entries = [{
      id: 'profile-1',
      path: 'profile.md',
      scope: 'global' as const,
      kind: 'preference' as const,
      status: 'active' as const,
      confidence: 'high' as const,
      statement: '用户希望被称呼为 Mason',
      updated: '2026-05-31T00:00:00.000Z',
      pinned: false,
      tags: ['profile', 'preferred-name'],
      claim: {
        subject: 'user/self',
        predicate: 'preferred_name',
        object: 'Mason',
      },
    }, {
      id: 'workflow-1',
      path: 'workflow.md',
      scope: 'workspace' as const,
      kind: 'preference' as const,
      status: 'active' as const,
      confidence: 'high' as const,
      statement: '用户偏好先讨论方案再改代码',
      updated: '2026-05-31T00:00:00.000Z',
      pinned: false,
      tags: ['workflow'],
    }, {
      id: 'voice-1',
      path: 'voice.md',
      scope: 'global' as const,
      kind: 'preference' as const,
      status: 'active' as const,
      confidence: 'high' as const,
      statement: '用户写作风格偏好简洁',
      updated: '2026-05-31T00:00:00.000Z',
      pinned: false,
      tags: ['voice'],
      claim: {
        subject: 'user/self',
        predicate: 'writing_style',
        object: '简洁',
      },
    }, {
      id: 'instruction-1',
      path: 'MEMORY.md',
      scope: 'global' as const,
      kind: 'summary' as const,
      status: 'active' as const,
      confidence: 'high' as const,
      statement: '最终回复需要说明剩余风险',
      updated: '2026-05-31T00:00:00.000Z',
      pinned: true,
      tags: [],
    }]

    expect(filterMemoryEntriesByUserCategory(entries, 'profile').map((entry) => entry.id)).toEqual(['profile-1'])
    expect(filterMemoryEntriesByUserCategory(entries, 'workflow').map((entry) => entry.id)).toEqual(['workflow-1'])
    expect(filterMemoryEntriesByUserCategory(entries, 'voice').map((entry) => entry.id)).toEqual(['voice-1'])
    expect(filterMemoryEntriesByUserCategory(entries, 'instruction').map((entry) => entry.id)).toEqual(['instruction-1'])
  })

  test('pending candidates use the same Alice-style layer labels as stored entries', () => {
    expect(memoryPendingCandidateLayerLabel({
      scope: 'global',
      kind: 'preference',
      confidence: 'high',
      statement: '用户希望被称呼为 Mason',
      tags: ['profile', 'preferred-name'],
      claim: {
        subject: 'user/self',
        predicate: 'preferred_name',
        object: 'Mason',
      },
    })).toBe('身份画像')

    expect(memoryPendingCandidateLayerLabel({
      scope: 'workspace',
      kind: 'preference',
      confidence: 'medium',
      statement: '用户写作风格偏好简洁',
      tags: ['voice'],
      claim: {
        subject: 'user/self',
        predicate: 'writing_style',
        object: '简洁',
      },
    })).toBe('写作风格')
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
      { label: '分层', value: '结构化事实' },
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
    expect(summarizeMemoryOrganizeJob({
      jobId: 'job-entries',
      kind: 'entries',
      workspaceSlug: 'demo',
      status: 'running',
      startedAt: 100,
      progress: {
        label: '分析已有记忆',
        scannedItems: 80,
        processedItems: 40,
        scannedBatches: 2,
        processedBatches: 1,
      },
    })).toBe('分析已有记忆 · 已分析 1/2 批 · 处理 40/80 条')
    expect(summarizeMemoryOrganizeJob({
      jobId: 'job-history',
      kind: 'history',
      workspaceSlug: 'demo',
      status: 'running',
      startedAt: 100,
      progress: {
        label: '分析历史对话',
        scannedItems: 12,
        processedItems: 1,
        scannedBatches: 3,
        processedBatches: 1,
        candidateCount: 2,
      },
    })).toBe('分析历史对话 · 已分析 1/3 批 · 处理 1/12 条 · 抽取 2 条候选')
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
      jobId: 'job-1-progress',
      workspaceSlug: 'demo',
      status: 'running',
      startedAt: 100,
      progress: {
        scannedSources: 2,
        scannedChunks: 3,
        scannedBatches: 2,
        processedBatches: 1,
        candidateCount: 4,
      },
    })).toBe('后台整理中 · 已分析 1/2 批 · 处理 3 段 · 抽取 4 条候选')
    expect(summarizeMemoryIngestSourcesJob({
      jobId: 'job-2',
      workspaceSlug: 'demo',
      status: 'failed',
      startedAt: 100,
      completedAt: 200,
      error: '本地文件不存在',
    })).toBe('整理失败：本地文件不存在')
  })

  test('ingest item rows explain why external sources became memory or not', () => {
    expect(buildMemoryIngestItemRows({
      workspaceSlug: 'demo',
      scannedSources: 2,
      scannedChunks: 2,
      scannedBatches: 1,
      candidateCount: 2,
      actions: {
        duplicate: 1,
        related: 0,
        mergeable: 0,
        conflict: 0,
        suspected_stale: 0,
        low_confidence: 0,
        new: 1,
        suppressed: 0,
      },
      items: [{
        sourcePath: 'pasted://source-1#chunk-1',
        statement: '用户希望被称呼为 Mason',
        scope: 'global',
        kind: 'preference',
        confidence: 'high',
        action: 'new',
        reason: 'Candidate stored as active memory.',
        entryId: 'mem-1',
      }, {
        sourcePath: 'pasted://source-2#chunk-1',
        statement: '用户希望被称呼为 Mason',
        scope: 'global',
        kind: 'preference',
        confidence: 'high',
        action: 'duplicate',
        reason: 'Candidate duplicates an active claim memory.',
      }, {
        sourcePath: 'pasted://source-3#chunk-1',
        statement: '普通文本',
        action: 'suppressed',
        reason: 'No durable memory candidates found.',
      }],
    })).toEqual([{
      id: 'pasted://source-1#chunk-1:0',
      title: '已写入 · 全局 · 偏好',
      desc: '用户希望被称呼为 Mason\n已写入为可用记忆\npasted://source-1#chunk-1',
      tone: 'good',
    }, {
      id: 'pasted://source-2#chunk-1:1',
      title: '重复 · 全局 · 偏好',
      desc: '用户希望被称呼为 Mason\n与已有结构化记忆重复\npasted://source-2#chunk-1',
      tone: 'neutral',
    }, {
      id: 'pasted://source-3#chunk-1:2',
      title: '已跳过',
      desc: '普通文本\n没有发现适合长期记住的内容\npasted://source-3#chunk-1',
      tone: 'warn',
    }])
  })

  test('ingest item rows localize skipped source reasons', () => {
    expect(buildMemoryIngestItemRows({
      workspaceSlug: 'demo',
      scannedSources: 3,
      scannedChunks: 0,
      scannedBatches: 0,
      candidateCount: 0,
      actions: {
        duplicate: 0,
        related: 0,
        mergeable: 0,
        conflict: 0,
        suspected_stale: 0,
        low_confidence: 0,
        new: 0,
        suppressed: 3,
      },
      items: [{
        sourcePath: 'pasted://source-1',
        statement: '空文本',
        action: 'suppressed',
        reason: 'Source contains no ingestible text.',
      }, {
        sourcePath: 'workspace://demo/image.png',
        statement: 'image.png',
        action: 'suppressed',
        reason: 'Unsupported workspace file type.',
      }, {
        sourcePath: 'file:///tmp/assets',
        statement: '/tmp/assets',
        action: 'suppressed',
        reason: 'No supported local text files found.',
      }],
    }).map((row) => row.desc)).toEqual([
      '空文本\n没有可整理的文本内容\npasted://source-1',
      'image.png\n暂不支持这个工作区文件类型\nworkspace://demo/image.png',
      '/tmp/assets\n没有找到支持的本地文本文件\nfile:///tmp/assets',
    ])
  })

  test('extraction status explains whether external sources use LLM analysis', () => {
    expect(summarizeMemoryExtractionStatus({
      source: 'disabled',
      message: '未配置记忆提取模型；外部资料只会使用显式记忆句式。',
    })).toBe('未配置记忆提取模型；外部资料只会使用显式记忆句式。')

    expect(summarizeMemoryExtractionStatus({
      source: 'configured',
      modelRef: 'openai/gpt-5-mini',
      message: '已配置记忆提取模型，外部资料会优先使用 LLM 分析。',
    })).toBe('已配置记忆提取模型，外部资料会优先使用 LLM 分析。')
  })

  test('memory ingest target scope applies only when the user chooses an explicit scope', () => {
    const sources = [{
      kind: 'pasted_text' as const,
      content: '叫我 Mason',
    }, {
      kind: 'workspace_file' as const,
      path: 'docs/profile.md',
    }]

    expect(applyMemoryIngestTargetScope(sources, 'auto')).toEqual(sources)
    expect(applyMemoryIngestTargetScope(sources, 'workspace')).toEqual([
      { ...sources[0], targetScope: 'workspace' },
      { ...sources[1], targetScope: 'workspace' },
    ])
    expect(applyMemoryIngestTargetScope(sources, 'global')).toEqual([
      { ...sources[0], targetScope: 'global' },
      { ...sources[1], targetScope: 'global' },
    ])
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
