import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createDistillAnalyzer } from '../src/store/distill-analyzer.js'
import { createHostDeskStore } from '../src/store/host.js'

const HASH = 'a'.repeat(64)

function validPlan({ runId = 'run-1', workspaceId = '/ws/a' } = {}) {
  return {
    schemaVersion: 1,
    runId,
    workspaceId,
    summary: '把本阶段的决议写回 finding 模型。',
    navigation: { source: 'AGENTS.md#0', mode: 'tree', fallback: false },
    targets: [{
      file: 'docs/guide.md',
      action: 'update',
      navRef: 'AGENTS.md > docs/arch/models/',
      fileBaseHash: HASH,
      changes: [{
        id: 'c1',
        kind: 'append-section',
        sectionAnchor: '## 4. Commit 归属与 Fork 派生',
        proposedText: '## 4. Commit 归属与 Fork 派生\n\n- 新增一条规则。',
        rationale: '补充规则',
        evidenceSnippet: '证据片段',
        evidence: [{ sessionId: 's1', messageId: 'm1', turn: 1, grade: 'commit', commit: 'a1b2c3d' }],
        dependsOn: [],
      }],
    }],
    conflicts: [],
    stats: { targets: 1, changes: 1, byGrade: { resolved: 0, commit: 1, submitted: 0 } },
    truncated: false,
  }
}

function makeDir(t, prefix = 'pd-analyzer-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function abortError() {
  const err = new Error('aborted')
  err.name = 'AbortError'
  return err
}

/**
 * @param {{contextWindow?: number, supportsEffort?: boolean, responses: object[]}} options
 */
function createMockLlm({ contextWindow = 200000, supportsEffort = false, responses = [] } = {}) {
  const calls = []
  const queue = [...responses]
  const llm = {
    resolveModelInfo: ({ model } = {}) => (supportsEffort
      ? { reasoningEfforts: ['low', 'medium', 'high'], model }
      : { reasoningEfforts: [], model }),
    prepareCall: async (config, signal) => {
      calls.push({ type: 'prepareCall', config, signal })
      return {
        config: { ...config, context: { contextWindow } },
        stream: (streamOptions) => {
          calls.push({ type: 'stream', options: streamOptions })
          const response = queue.shift() || { text: '', finish: 'stop' }
          return (async function* stream() {
            if (response.throw) throw new Error(response.throw)
            if (response.hang) {
              await new Promise((_, reject) => {
                const onAbort = () => reject(abortError())
                if (streamOptions?.signal?.aborted) onAbort()
                else streamOptions?.signal?.addEventListener('abort', onAbort, { once: true })
              })
              return
            }
            if (response.text) yield { type: 'text-delta', text: response.text }
            if (response.usage) yield { type: 'usage', usage: response.usage }
            yield {
              type: 'finish',
              reason: {
                kind: response.finish || 'stop',
                ...(response.failure ? { failure: response.failure } : {}),
              },
            }
          })()
        },
      }
    },
  }
  return { llm, calls, queue }
}

function makeGetService({ llm = null, selection = { provider: 'p', model: 'm' }, defaultModel = undefined } = {}) {
  return name => {
    if (name === 'llm') return llm
    if (name === 'agentDefaultModel') {
      if (defaultModel !== undefined) return defaultModel
      return { currentSelection: () => selection }
    }
    return null
  }
}

function stage1CandidateText(overrides = {}) {
  return JSON.stringify({
    sessionId: 's1',
    candidates: [{ rule: '规则 A', evidenceRefs: ['m1'], suggestedTargets: ['docs/arch/models/finding.md'] }],
    ...overrides,
  })
}

test('probeContextWindow reads context.contextWindow and reports selected model', async () => {
  const mock = createMockLlm({ contextWindow: 128000, responses: [] })
  const analyzer = createDistillAnalyzer({ getService: makeGetService({ llm: mock.llm }), store: null })
  const result = await analyzer.probeContextWindow()
  assert.equal(result.ok, true)
  assert.equal(result.contextWindow, 128000)
  assert.deepEqual(result.model, { provider: 'p', model: 'm' })
  assert.equal(mock.calls[0].type, 'prepareCall')
  assert.equal(mock.calls[0].config.maxTokens, 8000)
  assert.equal('reasoningEffort' in mock.calls[0].config, false)
})

test('probeContextWindow falls back to config.context.contextWindow', async () => {
  const llm = {
    prepareCall: async (config) => ({
      config: { ...config, context: { contextWindow: 64000 } },
      stream: () => (async function* stream() {})(),
    }),
  }
  const analyzer = createDistillAnalyzer({ getService: makeGetService({ llm }), store: null })
  const result = await analyzer.probeContextWindow()
  assert.equal(result.ok, true)
  assert.equal(result.contextWindow, 64000)
})

test('probeContextWindow rejects missing contextWindow without guessing', async () => {
  const llm = {
    prepareCall: async (config) => ({ config, stream: () => (async function* stream() {})() }),
  }
  const analyzer = createDistillAnalyzer({ getService: makeGetService({ llm }), store: null })
  const result = await analyzer.probeContextWindow()
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'CONTEXT_WINDOW_UNAVAILABLE')
})

test('probeContextWindow degrades when llm or model selection is unavailable', async () => {
  const noLlm = createDistillAnalyzer({ getService: makeGetService({ llm: null }), store: null })
  const noLlmResult = await noLlm.probeContextWindow()
  assert.equal(noLlmResult.ok, false)
  assert.equal(noLlmResult.error.code, 'ANALYZER_UNAVAILABLE')

  const mock = createMockLlm({ responses: [] })
  const noSelection = createDistillAnalyzer({
    getService: makeGetService({ llm: mock.llm, defaultModel: { currentSelection: () => null } }),
    store: null,
  })
  const noSelectionResult = await noSelection.probeContextWindow()
  assert.equal(noSelectionResult.ok, false)
  assert.equal(noSelectionResult.error.code, 'ANALYZER_UNAVAILABLE')

  const throwing = createDistillAnalyzer({
    getService: name => {
      if (name === 'llm') throw new Error('cannot get property "llm" without inject')
      return null
    },
    store: null,
  })
  const throwingResult = await throwing.probeContextWindow()
  assert.equal(throwingResult.ok, false)
  assert.equal(throwingResult.error.code, 'ANALYZER_UNAVAILABLE')
})

test('reasoningEffort is only passed when the model declares support', async () => {
  const supported = createMockLlm({ supportsEffort: true, responses: [] })
  const analyzer = createDistillAnalyzer({
    getService: makeGetService({ llm: supported.llm, selection: { provider: 'p', model: 'm', reasoningEffort: 'high' } }),
    store: null,
  })
  const ok = await analyzer.probeContextWindow()
  assert.equal(ok.ok, true)
  assert.equal(ok.model.reasoningEffort, 'high')
  assert.equal(supported.calls[0].config.reasoningEffort, 'high')

  const unsupported = createMockLlm({ supportsEffort: false, responses: [] })
  const analyzer2 = createDistillAnalyzer({
    getService: makeGetService({ llm: unsupported.llm, selection: { provider: 'p', model: 'm', reasoningEffort: 'high' } }),
    store: null,
  })
  const result = await analyzer2.probeContextWindow()
  assert.equal(result.ok, true)
  assert.equal('reasoningEffort' in result.model, false)
  assert.equal('reasoningEffort' in unsupported.calls[0].config, false)
})

test('runStage1 returns normalized candidates and per-call progress', async () => {
  const mock = createMockLlm({ responses: [{ text: stage1CandidateText(), usage: { inputTokens: 120, outputTokens: 30 } }] })
  const analyzer = createDistillAnalyzer({ getService: makeGetService({ llm: mock.llm }), store: null })
  const progress = []
  const result = await analyzer.runStage1({
    sessionId: 's1',
    materials: [{ sessionId: 's1', findingId: 'f1', grade: 'resolved', title: 't', text: 'result pair', turn: 2, time: 100 }],
    budget: { maxTokens: 120000, truncated: false },
    onProgress: event => progress.push(event),
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.candidates, [{
    rule: '规则 A',
    evidenceRefs: ['m1'],
    suggestedTargets: ['docs/arch/models/finding.md'],
  }])
  assert.deepEqual(progress, [
    { stage: 'stage1', completed: 0, total: 1, sessionId: 's1' },
    { stage: 'stage1', completed: 1, total: 1, sessionId: 's1' },
  ])
  assert.equal(result.usage.usedTokens, 150)
  assert.equal(result.usage.truncated, false)
  const streamCall = mock.calls.find(call => call.type === 'stream')
  assert.ok(streamCall, 'stage1 makes one model stream call')
  assert.equal(streamCall.options.system.includes('阶段 1'), true)
  assert.equal(streamCall.options.messages[0].role, 'user')
  assert.ok(Array.isArray(streamCall.options.messages[0].content),
    'stage1 sends ContentBlock[] content (the DeepSeek adapter reads message.content.some)')
  assert.equal(streamCall.options.messages[0].content[0].type, 'text')
  const stagePrepareCall = mock.calls.filter(call => call.type === 'prepareCall').at(-1)
  assert.equal(stagePrepareCall.config.temperature, 0, 'analysis calls run at temperature 0')
  assert.equal(stagePrepareCall.config.maxTokens, 120000)
})

test('runStage1 fails on a non-stop finish reason', async () => {
  const mock = createMockLlm({ responses: [{ text: '{}', finish: 'length' }] })
  const analyzer = createDistillAnalyzer({ getService: makeGetService({ llm: mock.llm }), store: null })
  const result = await analyzer.runStage1({ sessionId: 's1', materials: [], budget: { maxTokens: 1000 } })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'ANALYZER_FINISH_REASON')
})

test('runStage2 fills Host-owned plan fields from the snapshot instead of trusting the model', async () => {
  const run = { id: 'run-n', workspaceId: 'ws-1', status: 'analyzing', sessions: [], createdAt: 1, updatedAt: 1 }
  // The model knows semantics only: no schemaVersion/navigation/stats/hash.
  const draft = {
    summary: '把决议写回 finding 模型。',
    targets: [{
      file: 'docs/guide.md',
      changes: [{
        kind: 'insert-into-section',
        sectionAnchor: '## 4. Commit 归属',
        proposedText: '- 新增一条规则。',
        rationale: '补充规则',
        evidenceSnippet: '证据',
        evidence: [{ sessionId: 's1', messageId: 'm1', grade: 'resolved', turn: 3 }],
      }],
    }],
  }
  const mock = createMockLlm({ responses: [{ text: JSON.stringify({ plan: draft, summaries: [] }) }] })
  const analyzer = createDistillAnalyzer({ getService: makeGetService({ llm: mock.llm }), store: null })
  const result = await analyzer.runStage2({
    run,
    stage1Results: [],
    navigation: { content: '## 0. 导航', mode: 'tree' },
    fingerprints: [],
    targetSnippets: [],
    budget: { maxTokens: 1000, truncated: true },
    resolveFileFacts: () => ({ exists: true, fileBaseHash: 'b'.repeat(64) }),
  })
  assert.equal(result.ok, true, JSON.stringify(result.error || {}))
  const plan = result.plan
  assert.equal(plan.schemaVersion, 1)
  assert.equal(plan.runId, 'run-n')
  assert.equal(plan.workspaceId, 'ws-1')
  assert.deepEqual(plan.navigation, { source: 'AGENTS.md#0', mode: 'tree', fallback: false })
  assert.equal(plan.targets[0].action, 'update')
  assert.equal(plan.targets[0].fileBaseHash, 'b'.repeat(64), 'the hash comes from disk, never the model')
  assert.equal(plan.targets[0].changes[0].id, 'c1', 'change ids are assigned in order')
  assert.deepEqual(plan.targets[0].changes[0].dependsOn, [])
  assert.deepEqual(plan.stats, { targets: 1, changes: 1, byGrade: { resolved: 1, commit: 0, submitted: 0 } })
  assert.equal(plan.truncated, true, 'truncation is reported from the run budget')
  assert.equal(plan.targets[0].navRef.includes('docs/guide.md'), true, 'tree mode gets a navRef')
})

test('runStage2 normalizes conflicts and submitted-grade wording instead of failing the run', async () => {
  const run = { id: 'run-c', workspaceId: 'ws-1', status: 'analyzing', sessions: [], createdAt: 1, updatedAt: 1 }
  const draft = {
    summary: '冲突与待确认规则。',
    targets: [{
      file: 'docs/guide.md',
      changes: [{
        kind: 'append-section',
        proposedText: '## 待确认规则\n\n- 仅 submitted 证据。',
        rationale: '尚未执行完成',
        evidenceSnippet: '证据',
        evidence: [{ sessionId: 's1', messageId: 'm1', grade: 'submitted', turn: 2 }],
      }],
    }],
    conflicts: [
      // Incomplete: one claim → dropped entirely.
      { topic: '冲突 A', claims: [{ sessionId: 's1', claim: '单一主张', evidenceGrade: 'submitted' }], resolvedBy: 'unresolved' },
      // code resolution without codeEvidence → downgraded to unresolved.
      {
        topic: '冲突 B',
        claims: [
          { sessionId: 's1', messageId: 'm1', claim: '主张一', evidenceGrade: 'submitted', turn: 1 },
          { sessionId: 's2', messageId: 'm2', claim: '主张二', evidenceGrade: 'resolved', turn: 2 },
        ],
        resolvedBy: 'code',
      },
      // Valid code conflict survives.
      {
        topic: '冲突 C',
        claims: [
          { sessionId: 's1', messageId: 'm1', claim: '主张一', evidenceGrade: 'submitted', turn: 1 },
          { sessionId: 's2', messageId: 'm2', claim: '主张二', evidenceGrade: 'resolved', turn: 2 },
        ],
        resolvedBy: 'code',
        codeEvidence: [{ commit: 'a1b2c3d', committedAt: 1700000000, path: 'src/domain/active-group.js' }],
      },
    ],
  }
  const mock = createMockLlm({ responses: [{ text: JSON.stringify({ plan: draft, summaries: [] }) }] })
  const analyzer = createDistillAnalyzer({ getService: makeGetService({ llm: mock.llm }), store: null })
  const result = await analyzer.runStage2({
    run,
    stage1Results: [],
    navigation: { content: '## 0. 导航', mode: 'tree' },
    fingerprints: [],
    targetSnippets: [],
    budget: { maxTokens: 1000 },
    resolveFileFacts: () => ({ exists: true, fileBaseHash: 'c'.repeat(64) }),
  })
  assert.equal(result.ok, true, JSON.stringify(result.error || {}))
  const plan = result.plan
  assert.equal(plan.targets[0].changes[0].rationale.startsWith('待确认'), true,
    'submitted-grade changes are worded as pending confirmation')
  assert.deepEqual(plan.conflicts.map(conflict => conflict.topic), ['冲突 B', '冲突 C'])
  assert.equal(plan.conflicts[0].resolvedBy, 'unresolved', 'code without code evidence degrades to unresolved')
  assert.equal(plan.conflicts[1].resolvedBy, 'code')
  assert.deepEqual(plan.conflicts[1].codeEvidence, [{ commit: 'a1b2c3d', committedAt: 1700000000, path: 'src/domain/active-group.js' }])
})

test('runStage1 surfaces the provider failure behind a non-stop finish reason', async () => {
  const mock = createMockLlm({
    responses: [{
      text: '',
      finish: 'error',
      failure: { code: 'ACCOUNT_TOKEN_INVALID', message: 'token rejected by provider', status: 401 },
    }],
  })
  const analyzer = createDistillAnalyzer({ getService: makeGetService({ llm: mock.llm }), store: null })
  const result = await analyzer.runStage1({ sessionId: 's1', materials: [], budget: { maxTokens: 1000 } })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'ANALYZER_FINISH_REASON')
  assert.match(result.error.message, /ACCOUNT_TOKEN_INVALID/)
  assert.match(result.error.message, /token rejected by provider/)
  assert.equal(result.error.providerCode, 'ACCOUNT_TOKEN_INVALID')
  assert.equal(result.error.providerStatus, 401)
})

test('runStage1 maps a thrown stream to ANALYZER_UNAVAILABLE instead of throwing', async () => {
  const mock = createMockLlm({ responses: [{ throw: 'boom' }] })
  const analyzer = createDistillAnalyzer({ getService: makeGetService({ llm: mock.llm }), store: null })
  const result = await analyzer.runStage1({ sessionId: 's1', materials: [], budget: { maxTokens: 1000 } })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'ANALYZER_UNAVAILABLE')
})

test('runStage1 times out with ANALYZER_TIMEOUT', async () => {
  const mock = createMockLlm({ responses: [{ hang: true }] })
  const analyzer = createDistillAnalyzer(
    { getService: makeGetService({ llm: mock.llm }), store: null },
    { stage1TimeoutMs: 20 },
  )
  const result = await analyzer.runStage1({ sessionId: 's1', materials: [], budget: { maxTokens: 1000 } })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'ANALYZER_TIMEOUT')
})

test('runStage1 honours an external AbortSignal', async () => {
  const mock = createMockLlm({ responses: [{ hang: true }] })
  const analyzer = createDistillAnalyzer({ getService: makeGetService({ llm: mock.llm }), store: null })
  const controller = new AbortController()
  const pending = analyzer.runStage1({ sessionId: 's1', materials: [], budget: { maxTokens: 1000 }, signal: controller.signal })
  setTimeout(() => controller.abort(), 10)
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'ABORTED')
})

test('runStage2 validates the plan and persists rawResponseRef (truncated)', async (t) => {
  const dir = makeDir(t)
  const store = createHostDeskStore({ storageRoot: dir })
  const now = Date.now()
  const run = {
    id: 'run-1',
    workspaceId: '/ws/a',
    status: 'analyzing',
    sessions: [{ sessionId: 's1', title: 'S1', archived: false }],
    createdAt: now,
    updatedAt: now,
  }
  await store.putDistillRun(run)
  const plan = validPlan()
  const rawText = `\`\`\`json\n${JSON.stringify({ plan, summaries: [] })}\n\`\`\``
  const mock = createMockLlm({ responses: [{ text: rawText, usage: { inputTokens: 500, outputTokens: 100 } }] })
  const analyzer = createDistillAnalyzer(
    { getService: makeGetService({ llm: mock.llm }), store },
    { maxRawResponseChars: 200 },
  )
  const progress = []
  const result = await analyzer.runStage2({
    run,
    stage1Results: [{ sessionId: 's1', candidates: [] }],
    navigation: { content: 'AGENTS.md 导航树', mode: 'tree' },
    fingerprints: [],
    targetSnippets: {},
    budget: { maxTokens: 120000, truncated: true },
    onProgress: event => progress.push(event),
  })
  assert.equal(result.ok, true)
  assert.equal(result.plan.runId, 'run-1')
  assert.equal(result.usage.usedTokens, 600)
  assert.equal(result.usage.truncated, true)
  assert.deepEqual(progress, [
    { stage: 'stage2', completed: 0, total: 1 },
    { stage: 'stage2', completed: 1, total: 1 },
  ])
  const stagePrepareCall = mock.calls.filter(call => call.type === 'prepareCall').at(-1)
  assert.equal(stagePrepareCall.config.temperature, 0, 'stage2 prepareCall carries temperature 0')
  assert.equal(stagePrepareCall.config.maxTokens, 120000)
  const stored = await store.getDistillPlan('run-1')
  assert.ok(stored)
  assert.equal(stored.rawResponseRef.length <= 200, true)
  assert.equal(stored.summary, plan.summary)
})

test('runStage2 repairs invalid JSON exactly once and keeps the second raw copy', async (t) => {
  const dir = makeDir(t)
  const store = createHostDeskStore({ storageRoot: dir })
  const run = { id: 'run-r', workspaceId: '/ws/a', status: 'analyzing', sessions: [], createdAt: 1, updatedAt: 1 }
  await store.putDistillRun(run)
  const plan = validPlan({ runId: 'run-r' })
  const mock = createMockLlm({
    responses: [
      { text: '这不是 JSON' },
      { text: JSON.stringify({ plan, summaries: [] }) },
    ],
  })
  const analyzer = createDistillAnalyzer({ getService: makeGetService({ llm: mock.llm }), store })
  const result = await analyzer.runStage2({ run, stage1Results: [], navigation: {}, fingerprints: [], targetSnippets: {}, budget: { maxTokens: 1000 } })
  assert.equal(result.ok, true)
  const streamCalls = mock.calls.filter(call => call.type === 'stream')
  assert.equal(streamCalls.length, 2)
  // The repair turn feeds the validation error back to the model.
  const repairMessages = streamCalls[1].options.messages
  assert.equal(repairMessages.at(-1).role, 'user')
  assert.ok(Array.isArray(repairMessages.at(-1).content), 'every message content is a ContentBlock[]')
  assert.match(repairMessages.at(-1).content[0].text, /未通过校验/)
  assert.ok(repairMessages.every((message) => message.role === 'user'),
    'the repair turn stays user-only: a source-less assistant message crashes the DeepSeek replay reader')
  assert.equal((await store.getDistillPlan('run-r'))?.summary, plan.summary)
})

test('runStage2 fails after one repair attempt when the plan stays invalid', async (t) => {
  const dir = makeDir(t)
  const store = createHostDeskStore({ storageRoot: dir })
  const run = { id: 'run-bad', workspaceId: '/ws/a', status: 'analyzing', sessions: [], createdAt: 1, updatedAt: 1 }
  await store.putDistillRun(run)
  const mock = createMockLlm({ responses: [{ text: '{"bad":true}' }, { text: '{"bad":true}' }] })
  const analyzer = createDistillAnalyzer({ getService: makeGetService({ llm: mock.llm }), store })
  const result = await analyzer.runStage2({ run, stage1Results: [], navigation: {}, fingerprints: [], targetSnippets: {}, budget: { maxTokens: 1000 } })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'PLAN_INVALID')
  assert.equal(mock.calls.filter(call => call.type === 'stream').length, 2)
  assert.equal(await store.getDistillPlan('run-bad'), null, 'no plan is written on failure')
})

test('runStage2 builds digest and llm summaries plus an empty-state digest', async (t) => {
  const dir = makeDir(t)
  const store = createHostDeskStore({ storageRoot: dir })
  const run = {
    id: 'run-sum',
    workspaceId: '/ws/a',
    status: 'analyzing',
    sessions: [
      { sessionId: 's1', title: '会话一', archived: false },
      { sessionId: 's2', title: '会话二', archived: true },
      { sessionId: 's3', title: '会话三', archived: false },
    ],
    createdAt: 1,
    updatedAt: 1,
  }
  await store.putDistillRun(run)
  const plan = validPlan({ runId: 'run-sum' })
  const mock = createMockLlm({
    responses: [{
      text: JSON.stringify({
        plan,
        summaries: [{ sessionId: 's2', title: '会话二', markdown: 'LLM 摘要二' }],
      }),
    }],
  })
  const analyzer = createDistillAnalyzer({ getService: makeGetService({ llm: mock.llm }), store })
  const result = await analyzer.runStage2({
    run,
    stage1Results: [{
      sessionId: 's1',
      candidates: [],
      materials: [{
        sessionId: 's1',
        findingId: 'f1',
        grade: 'resolved',
        title: '决议一',
        text: '结果对文本',
        userText: '用户提示',
        turn: 1,
        time: 100,
      }],
    }],
    navigation: {},
    fingerprints: [],
    targetSnippets: {},
    budget: { maxTokens: 1000 },
  })
  assert.equal(result.ok, true)
  assert.equal(result.summaries.length, 3)
  const bySession = new Map(result.summaries.map(summary => [summary.sessionId, summary]))
  assert.equal(bySession.get('s1').source, 'digest')
  assert.match(bySession.get('s1').markdown, /会话一/)
  assert.equal(bySession.get('s2').source, 'llm')
  assert.equal(bySession.get('s2').markdown, 'LLM 摘要二')
  assert.equal(bySession.get('s3').source, 'digest')
  assert.ok(bySession.get('s3').markdown.length > 0, 'empty sessions get an explicit empty-state digest')
})

test('runStage2 trims rawResponseRef copies outside the newest-20 window', async (t) => {
  const dir = makeDir(t)
  const store = createHostDeskStore({ storageRoot: dir })
  const now = Date.now()
  const oldRuns = Array.from({ length: 21 }, (_, index) => ({
    id: `old-${index}`,
    workspaceId: '/ws/a',
    status: 'ready',
    createdAt: now - (index + 10) * 1000,
    updatedAt: now - (index + 10) * 1000,
  }))
  for (const oldRun of oldRuns) await store.putDistillRun(oldRun)
  for (const oldRun of oldRuns) {
    await store.putDistillPlan({ runId: oldRun.id, workspaceId: '/ws/a', summary: `plan ${oldRun.id}`, rawResponseRef: 'old raw' })
  }
  const run = { id: 'run-new', workspaceId: '/ws/a', status: 'analyzing', sessions: [], createdAt: now, updatedAt: now + 1000 }
  await store.putDistillRun(run)

  const mock = createMockLlm({ responses: [{ text: JSON.stringify({ plan: validPlan({ runId: 'run-new' }) }) }] })
  const analyzer = createDistillAnalyzer({ getService: makeGetService({ llm: mock.llm }), store })
  const result = await analyzer.runStage2({ run, stage1Results: [], navigation: {}, fingerprints: [], targetSnippets: {}, budget: { maxTokens: 1000 } })
  assert.equal(result.ok, true)

  const current = await store.getDistillPlan('run-new')
  assert.equal(typeof current.rawResponseRef, 'string')
  // newest-first: run-new + old-0..old-20 → indexes 20/21 are old-19/old-20 and lose the copy.
  assert.equal((await store.getDistillPlan('old-20')).rawResponseRef, undefined)
  assert.equal((await store.getDistillPlan('old-19')).rawResponseRef, undefined)
  assert.equal((await store.getDistillPlan('old-18')).rawResponseRef, 'old raw')
})

test('runStage2 degrades without throwing for unexpected input/service shapes', async () => {
  const analyzer = createDistillAnalyzer({ getService: () => null, store: null })
  const noRun = await analyzer.runStage2({})
  assert.equal(noRun.ok, false)
  assert.equal(noRun.error.code, 'INVALID_INPUT')

  // A failing audit store must not fail the analysis itself (best-effort raw copy).
  const mock = createMockLlm({ responses: [{ text: JSON.stringify({ plan: validPlan({ runId: 'run-x' }) }) }] })
  const analyzer2 = createDistillAnalyzer({
    getService: makeGetService({ llm: mock.llm }),
    store: { putDistillPlan: async () => { throw new Error('store down') } },
  })
  const result = await analyzer2.runStage2({
    run: { id: 'run-x', workspaceId: '/ws/a', sessions: [] },
    stage1Results: [],
    navigation: {},
    fingerprints: [],
    targetSnippets: {},
    budget: { maxTokens: 1000 },
  })
  assert.equal(result.ok, true)
  assert.equal(result.plan.runId, 'run-x')
})

test('runStage2 reports discarded proposals instead of silently shortening the plan', async () => {
  const run = { id: 'run-drop', workspaceId: 'ws-1', status: 'analyzing', sessions: [], createdAt: 1, updatedAt: 1 }
  const draft = {
    summary: '两条不会被采纳的提议。',
    targets: [
      {
        file: 'AGENTS.md',
        changes: [{
          kind: 'replace-block',
          sectionAnchor: '## 0. 导航',
          proposedText: '## 0. 导航\n\n- 改写根文件正文。',
          rationale: '根文件内容修改',
          evidenceSnippet: '证据',
          evidence: [{ sessionId: 's1', messageId: 'm1', grade: 'resolved', turn: 1 }],
        }],
      },
      {
        file: 'docs/arch/models/finding.md',
        changes: [{
          kind: 'append-section',
          proposedText: '## 新增规则\n\n- 没有 ChangeLog 行。',
          rationale: 'arch 更新',
          evidenceSnippet: '证据',
          evidence: [{ sessionId: 's2', messageId: 'm2', grade: 'resolved', turn: 2 }],
        }],
      },
      {
        file: 'docs/guide.md',
        changes: [{
          kind: 'append-section',
          proposedText: '## 保留章节\n\n- 正文。',
          rationale: '正常提议',
          evidenceSnippet: '证据',
          evidence: [{ sessionId: 's3', messageId: 'm3', grade: 'resolved', turn: 3 }],
        }],
      },
    ],
  }
  const mock = createMockLlm({ responses: [{ text: JSON.stringify({ plan: draft, summaries: [] }) }] })
  const analyzer = createDistillAnalyzer({ getService: makeGetService({ llm: mock.llm }), store: null })
  const result = await analyzer.runStage2({
    run,
    stage1Results: [],
    navigation: { content: '## 0. 导航', mode: 'tree' },
    fingerprints: [],
    targetSnippets: [],
    budget: { maxTokens: 1000, truncated: false },
    resolveFileFacts: () => ({ exists: true, fileBaseHash: 'b'.repeat(64) }),
  })
  assert.equal(result.ok, true, JSON.stringify(result.error || {}))
  const plan = result.plan
  assert.deepEqual(plan.targets.map(target => target.file), ['docs/guide.md'], 'only the valid proposal survives')
  assert.deepEqual(plan.dropped, [
    { file: 'AGENTS.md', count: 1, reason: 'root-file' },
    { file: 'docs/arch/models/finding.md', count: 1, reason: 'no-changelog' },
  ], 'discarded proposals keep a machine reason for the confirmation page')
  assert.match(plan.summary, /已省略 AGENTS\.md/, 'the summary still explains the omission in prose')
})
