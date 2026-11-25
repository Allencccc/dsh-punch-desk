// Host half of the Finding Distillation UX contract (/tmp/pd-ux-contract.md §1).
// Covers: GET distill-estimate (read-only, budget truncation), POST distill-delete
// (terminal only, fingerprints kept), POST distill-review (persisted review marks,
// invalid ids filtered), POST distill-rebase (deterministic re-anchoring, no model
// call), and run.progress.log / run.usage accumulation from the llm stream.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'
import { createHostDeskStore, sha256Hex, withWorkspaceLock } from '../src/store/host.js'
import { createDistillAnalyzer } from '../src/store/distill-analyzer.js'
import { createDistillRun } from '../src/domain/distill-run.js'

const T0 = 1_700_000_000_000
const WS = 'ws-ux'
const SESSION_IDS = ['s1', 's2', 's3']
const SESSION_OBJS = SESSION_IDS.map(sessionId => ({ sessionId }))
const GUIDE = 'docs/guide.md'

function deferred() {
  let resolve
  const promise = new Promise((res) => { resolve = res })
  return { promise, resolve }
}

function sessionEvents(prefix, { title = '', answer = '' } = {}) {
  return [
    ...(title ? [{ type: 'session/title', seq: 0, time: T0 - 6000, data: { title, messageSeqs: [], source: 'user' } }] : []),
    { type: 'turn/start', seq: 1, time: T0 - 5000, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: T0 - 4000, data: { id: `${prefix}-u1`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `question ${prefix}` }] } },
    { type: 'assistant/message', seq: 3, time: T0 - 3000, data: { id: `${prefix}-a1`, role: 'assistant', content: [{ type: 'text', text: answer || `answer ${prefix}` }] } },
    { type: 'turn/end', seq: 4, time: T0 - 2000, data: { turn: 1 } },
  ]
}

function guideContent() {
  return '# Guide\n\n## Section A\n\noriginal body\n'
}

function makePlan(runId, { fileBaseHash, changes } = {}) {
  return {
    schemaVersion: 1,
    runId,
    workspaceId: WS,
    summary: 'ux host plan',
    navigation: { source: 'AGENTS.md#0', mode: 'tree', fallback: false },
    targets: [{
      file: GUIDE,
      action: 'update',
      navRef: 'AGENTS.md > docs/',
      fileBaseHash: fileBaseHash ?? sha256Hex(guideContent()),
      changes: changes ?? [{
        id: 'c1',
        kind: 'insert-into-section',
        sectionAnchor: '## Section A',
        proposedText: '- route rule\n',
        rationale: 'because',
        evidenceSnippet: 'snippet',
        evidence: [{ sessionId: 's1', messageId: 's1-a1', turn: 1, grade: 'resolved' }],
        dependsOn: [],
      }],
    }],
    conflicts: [],
    stats: { targets: 1, changes: 1, byGrade: { resolved: 3, commit: 0, submitted: 0 } },
    truncated: false,
  }
}

/**
 * Host harness: fake Cordis context with a Connection route registry, a real
 * temp-disk store, and a DI analyzer (mock here, real analyzer in the usage test).
 */
async function makeHarness(t, {
  navigation = true,
  contextWindow = 200000,
  stage1Impl,
  stage2Impl,
  analyzer: analyzerOverride,
  sessionEventsById,
} = {}) {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ux-ws-'))
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ux-store-'))
  t.after(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true })
    fs.rmSync(storageDir, { recursive: true, force: true })
  })
  if (navigation) {
    fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'),
      '# Repo\n\n## 0. 工程文档体系与导航 (Project Documentation Navigation)\n\n```text\n├── AGENTS.md\n└── docs/\n    └── guide.md\n```\n\n## 1. Other\n')
  }
  fs.mkdirSync(path.join(workspaceDir, 'docs'))
  fs.writeFileSync(path.join(workspaceDir, GUIDE), guideContent())
  const store = createHostDeskStore({ storageRoot: storageDir, now: () => T0 })
  const sessions = sessionEventsById || Object.fromEntries(SESSION_IDS.map(id => [id, sessionEvents(id, { title: `会话 ${id}` })]))
  const routes = []
  const ctx = {
    get(name) {
      if (name === 'sessionQuery') {
        return {
          readSession: async (id) => {
            if (!sessions[id]) {
              const err = new Error(`no session ${id}`)
              err.code = 'SESSION_QUERY_SESSION_NOT_FOUND'
              throw err
            }
            return { session: { id, cwd: workspaceDir }, inheritedEventCount: 0, events: sessions[id] }
          },
        }
      }
      if (name === 'workspaceRegistry') {
        return { get: id => (id === WS ? { path: workspaceDir } : undefined), archivedSessionIds: [] }
      }
      if (name === 'hostStore') return store
      throw new Error(`cannot get property "${name}" without inject`)
    },
    effect: fn => fn(),
    connection: { fetch: { register: route => { routes.push(route) } } },
  }
  for (const id of SESSION_IDS) {
    await store.putEntry({
      id: `f-${id}`,
      kind: 'finding',
      sessionId: id,
      workspaceKey: `session:${id}`,
      title: 't',
      body: 'b',
      submissionStatus: 'submitted',
      reviewStatus: 'resolved',
      completedVia: 'group-wrap-up',
      anchors: [{ kind: 'message', messageId: `${id}-a1` }],
      submittedAt: T0 - 3000,
    })
  }
  const analyzer = analyzerOverride || {
    probeContextWindow: async () => ({
      ok: true,
      contextWindow,
      model: { provider: 'deepseek', model: 'deepseek-chat' },
    }),
    runStage1: stage1Impl || (async ({ sessionId }) => ({
      ok: true,
      candidates: [{ rule: `rule-${sessionId}`, evidenceRefs: [], suggestedTargets: [GUIDE] }],
      usage: { usedTokens: 10, truncated: false, inputTokens: 8, outputTokens: 2, totalTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 },
    })),
    runStage2: stage2Impl || (async ({ run }) => {
      const plan = makePlan(run.id)
      await store.putDistillPlan(plan)
      return {
        ok: true,
        plan,
        summaries: [],
        usage: { usedTokens: 20, truncated: false, inputTokens: 15, outputTokens: 5, totalTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 },
      }
    }),
  }
  const applied = apply(ctx, {
    hostStore: store,
    distillAnalyzer: analyzer,
    workspaces: [{ id: WS, path: workspaceDir }],
  })
  const realWorkspaceKey = fs.realpathSync(workspaceDir)
  return {
    workspaceDir,
    realWorkspaceKey,
    store,
    routes,
    lifecycle: applied.distillLifecycle,
    statusOf: async id => (await store.getDistillRun(id))?.status,
  }
}

async function callRoute(routes, name, { method = 'GET', query = '', body, rawBody } = {}) {
  const route = routes.find(r => r.path === `/api/punch-desk/${name}`)
  assert.ok(route, `route ${name} must be registered`)
  const url = `http://localhost/api/punch-desk/${name}${query}`
  const init = method === 'POST'
    ? { method: 'POST', body: rawBody !== undefined ? rawBody : JSON.stringify(body ?? {}), headers: { 'content-type': 'application/json' } }
    : { method: 'GET' }
  const response = await route.fetch(new Request(url, init))
  return { httpStatus: response.status, body: await response.json() }
}

/** Seed a ready run + plan without running the analyzer. */
async function seedReadyRun(store, { runId = 'run-ready', status = 'ready', plan } = {}) {
  // Fresh timestamps: the Host lifecycle TTL-stales runs older than 2h, so a
  // fixture built from the frozen T0 constant would be recovered as `stale`.
  const now = Date.now()
  const run = createDistillRun({ id: runId, workspaceId: WS, sessions: SESSION_OBJS, now })
  const seeded = { ...run, status, updatedAt: now }
  await store.putDistillRun(seeded)
  await store.putDistillPlan(plan || makePlan(runId))
  return seeded
}

/* ------------------------------- estimate ------------------------------- */

test('estimate: read-only structure with session rows, model, budget and call counts', async (t) => {
  const h = await makeHarness(t)
  const { httpStatus, body } = await callRoute(h.routes, 'distill-estimate', {
    query: `?workspaceId=${WS}&sessions=${SESSION_IDS.join(',')}`,
  })
  assert.equal(httpStatus, 200)
  assert.equal(body.ok, true)
  const { estimate } = body
  assert.equal(estimate.sessions.length, 3)
  for (const row of estimate.sessions) {
    assert.equal(row.findings, 1)
    assert.equal(row.promptLogs, 0)
    assert.equal(row.readable, true)
    assert.match(row.title, /^会话 s\d$/, 'title comes from the session/title event, never a bare id')
  }
  assert.equal(estimate.totalMaterials, 3)
  assert.ok(estimate.totalTokens > 0)
  assert.equal(estimate.contextWindow, 200000)
  assert.equal(estimate.model, 'deepseek-chat')
  assert.equal(estimate.provider, 'deepseek')
  assert.equal(estimate.budget.maxTokens, 192000)
  assert.equal(estimate.budget.truncated, false)
  assert.equal(estimate.budget.usedTokens, estimate.totalTokens)
  assert.equal(estimate.stage1Calls, 3)
  assert.equal(estimate.stage2Calls, 1)
  // Read-only: nothing was persisted and no run was created.
  assert.deepEqual(await h.store.listDistillRuns(WS), [])
  assert.equal(await h.store.getDistillPlan('run-any'), null)
})

test('estimate: honors the token budget cap and reports truncation on a small window', async (t) => {
  const h = await makeHarness(t, { contextWindow: 8005 })
  const { body } = await callRoute(h.routes, 'distill-estimate', { query: `?workspaceId=${WS}&sessions=s1,s2,s3` })
  assert.equal(body.ok, true)
  assert.equal(body.estimate.contextWindow, 8005)
  assert.equal(body.estimate.budget.maxTokens, 5)
  assert.equal(body.estimate.budget.truncated, true)
  assert.equal(body.estimate.budget.usedTokens, 0, 'nothing fits the 5-token budget')
  assert.ok(body.estimate.totalTokens > 5)
})

test('estimate: never waits on the workspace lock and degrades per unreadable session', async (t) => {
  const h = await makeHarness(t)
  const gate = deferred()
  let estimateResult = null
  // Hold the very lock a run write would take; a lock-free estimate must finish.
  const held = withWorkspaceLock(h.realWorkspaceKey, async () => { await gate.promise })
  try {
    estimateResult = await callRoute(h.routes, 'distill-estimate', {
      query: `?workspaceId=${WS}&sessions=s1,s2,s-ghost`,
    })
    assert.equal(estimateResult.body.ok, true, 'estimate does not block on the workspace lock')
  } finally {
    gate.resolve()
    await held
  }
  const ghost = estimateResult.body.estimate.sessions.find(row => row.sessionId === 's-ghost')
  assert.equal(ghost.readable, false, 'a session that cannot be read is reported honestly')
  assert.equal(ghost.findings, 0)
  assert.equal(estimateResult.body.estimate.stage1Calls, 2)
})

test('estimate: rejects a missing or oversized selection without persisting anything', async (t) => {
  const h = await makeHarness(t)
  const missing = await callRoute(h.routes, 'distill-estimate', { query: `?workspaceId=${WS}` })
  assert.equal(missing.httpStatus, 400)
  assert.equal(missing.body.code, 'INVALID_REQUEST')
  const tooMany = await callRoute(h.routes, 'distill-estimate', {
    query: `?workspaceId=${WS}&sessions=s1,s2,s3,s4,s5,s6,s7,s8`,
  })
  assert.equal(tooMany.httpStatus, 400)
  assert.equal(tooMany.body.code, 'INVALID_BATCH')
})

/* -------------------------------- delete -------------------------------- */

test('delete: removes a terminal run and its plan but keeps fingerprints', async (t) => {
  const h = await makeHarness(t)
  await seedReadyRun(h.store, { runId: 'run-delete', status: 'failed', plan: makePlan('run-delete') })
  await h.store.putDistillFingerprints(WS, [{
    id: 'fp-1',
    workspaceId: WS,
    targetFile: GUIDE,
    changeKind: 'append-section',
    normalizedHash: 'h'.repeat(64),
    runId: 'run-delete',
    appliedAt: T0 - 1000,
    appliedFileHash: 'a'.repeat(64),
  }])
  const { httpStatus, body } = await callRoute(h.routes, 'distill-delete', {
    method: 'POST',
    body: { runId: 'run-delete' },
  })
  assert.equal(httpStatus, 200)
  assert.equal(body.ok, true)
  assert.equal(body.deletedPlan, true)
  assert.equal(await h.store.getDistillRun('run-delete'), null)
  assert.equal(await h.store.getDistillPlan('run-delete'), null)
  const fingerprints = await h.store.listDistillFingerprints(WS)
  assert.equal(fingerprints.length, 1, 'fingerprints are long-lived idempotency assets')
  assert.equal(fingerprints[0].id, 'fp-1')
})

test('delete: refuses a non-terminal run and reports unknown ids, always HTTP 200', async (t) => {
  const h = await makeHarness(t)
  await seedReadyRun(h.store, { runId: 'run-live', status: 'analyzing', plan: makePlan('run-live') })
  const live = await callRoute(h.routes, 'distill-delete', { method: 'POST', body: { runId: 'run-live' } })
  assert.equal(live.httpStatus, 200, 'business errors keep the contract HTTP 200')
  assert.equal(live.body.ok, false)
  assert.equal(live.body.error.code, 'RUN_NOT_READY')
  assert.equal(live.body.code, 'RUN_NOT_READY')
  assert.equal(await h.statusOf('run-live'), 'analyzing', 'non-terminal run untouched')
  assert.ok(await h.store.getDistillPlan('run-live'), 'plan untouched')

  const missing = await callRoute(h.routes, 'distill-delete', { method: 'POST', body: { runId: 'nope' } })
  assert.equal(missing.httpStatus, 200)
  assert.equal(missing.body.error.code, 'RUN_NOT_FOUND')

  const noId = await callRoute(h.routes, 'distill-delete', { method: 'POST', body: {} })
  assert.equal(noId.body.error.code, 'INVALID_REQUEST')
})

/* -------------------------------- review -------------------------------- */

test('review: persists the review marks and filters unknown change ids', async (t) => {
  const h = await makeHarness(t)
  const plan = makePlan('run-review', {
    changes: [
      { id: 'c1', kind: 'insert-into-section', sectionAnchor: '## Section A', proposedText: '- one\n', rationale: 'r1', evidenceSnippet: '', evidence: [{ sessionId: 's1', messageId: 's1-a1', turn: 1, grade: 'resolved' }], dependsOn: [] },
      { id: 'c2', kind: 'insert-into-section', sectionAnchor: '## Section A', proposedText: '- two\n', rationale: 'r2', evidenceSnippet: '', evidence: [{ sessionId: 's2', messageId: 's2-a1', turn: 1, grade: 'resolved' }], dependsOn: [] },
    ],
  })
  await seedReadyRun(h.store, { runId: 'run-review', plan })
  const { httpStatus, body } = await callRoute(h.routes, 'distill-review', {
    method: 'POST',
    body: {
      runId: 'run-review',
      ignoredChangeIds: ['c1', 'c-unknown', 'c1'],
      reviewedChangeIds: ['c2', 'c-other'],
    },
  })
  assert.equal(httpStatus, 200)
  assert.equal(body.ok, true)
  assert.deepEqual(body.review.ignoredChangeIds, ['c1'], 'unknown ids are filtered, not an error')
  assert.deepEqual(body.review.reviewedChangeIds, ['c2'])
  assert.ok(Number.isFinite(body.review.at))
  // Read-back from disk (not just the response echo).
  const persisted = await h.store.getDistillPlan('run-review')
  assert.deepEqual(persisted.review.ignoredChangeIds, ['c1'])
  assert.deepEqual(persisted.review.reviewedChangeIds, ['c2'])
  assert.equal(persisted.review.at, body.review.at)
})

test('review: only a ready run may be reviewed, and ignored changes never get written back', async (t) => {
  const h = await makeHarness(t)
  await seedReadyRun(h.store, { runId: 'run-review2' })
  await callRoute(h.routes, 'distill-review', {
    method: 'POST',
    body: { runId: 'run-review2', ignoredChangeIds: ['c1'], reviewedChangeIds: [] },
  })
  const apply = await callRoute(h.routes, 'distill-apply', {
    method: 'POST',
    body: { runId: 'run-review2', selectedChangeIds: ['c1'] },
  })
  assert.equal(apply.body.ok, false)
  assert.equal(apply.body.code, 'INVALID_REQUEST')
  assert.match(apply.body.error, /not adopted|already present/)
  assert.deepEqual(apply.body.ignoredSkipped, ['c1'])
  assert.equal(fs.readFileSync(path.join(h.workspaceDir, GUIDE), 'utf8'), guideContent(),
    'nothing was written for a non-adopted change')

  await seedReadyRun(h.store, { runId: 'run-applied', status: 'applied' })
  const notReady = await callRoute(h.routes, 'distill-review', {
    method: 'POST',
    body: { runId: 'run-applied', ignoredChangeIds: [], reviewedChangeIds: [] },
  })
  assert.equal(notReady.body.error.code, 'REVIEW_NOT_ALLOWED')
})

/* -------------------------------- rebase -------------------------------- */

test('rebase: previews the disk drift, then aligns the baseline and skips already-present changes', async (t) => {
  const h = await makeHarness(t)
  const staleHash = sha256Hex(guideContent())
  const plan = makePlan('run-rebase', {
    fileBaseHash: staleHash,
    changes: [
      { id: 'c1', kind: 'insert-into-section', sectionAnchor: '## Section A', proposedText: '- new rule\n', rationale: 'r1', evidenceSnippet: '', evidence: [{ sessionId: 's1', messageId: 's1-a1', turn: 1, grade: 'resolved' }], dependsOn: [] },
      { id: 'c2', kind: 'insert-into-section', sectionAnchor: '## Section A', proposedText: 'human already added this', rationale: 'r2', evidenceSnippet: '', evidence: [{ sessionId: 's2', messageId: 's2-a1', turn: 1, grade: 'resolved' }], dependsOn: [] },
    ],
  })
  await seedReadyRun(h.store, { runId: 'run-rebase', plan })
  // The human edited the file outside the plugin: baseline drifted.
  const drifted = '# Guide\n\n## Section A\n\noriginal body\n\nhuman already added this\n'
  fs.writeFileSync(path.join(h.workspaceDir, GUIDE), drifted)
  const currentHash = sha256Hex(drifted)

  const preview = await callRoute(h.routes, 'distill-rebase', {
    method: 'POST',
    body: { runId: 'run-rebase', filePath: GUIDE, apply: false },
  })
  assert.equal(preview.httpStatus, 200)
  assert.equal(preview.body.ok, true)
  const rebase = preview.body.rebase
  assert.equal(rebase.filePath, GUIDE)
  assert.equal(rebase.planHash, staleHash)
  assert.equal(rebase.currentHash, currentHash)
  assert.equal(rebase.canReanchor, true)
  assert.deepEqual(rebase.alreadyApplied, [{ changeId: 'c2', reason: 'already-present' }])
  const c1 = rebase.previews.find(item => item.changeId === 'c1')
  assert.equal(c1.anchor, '## Section A')
  assert.equal(c1.proposedText, '- new rule\n')
  assert.match(c1.currentText, /human already added this/, 'preview shows the current disk section')
  assert.ok(c1.currentText.length <= 2000)
  assert.equal(c1.alreadyPresent, false)
  // Preview must not mutate the persisted plan.
  assert.equal((await h.store.getDistillPlan('run-rebase')).targets[0].fileBaseHash, staleHash)

  const applied = await callRoute(h.routes, 'distill-rebase', {
    method: 'POST',
    body: { runId: 'run-rebase', filePath: GUIDE, apply: true },
  })
  assert.equal(applied.body.ok, true)
  assert.equal(applied.body.plan.targets[0].fileBaseHash, currentHash, 'baseline aligned to the disk')
  const marked = applied.body.plan.targets[0].changes.find(change => change.id === 'c2')
  assert.equal(marked.skipReason, 'already-present')
  const untouched = applied.body.plan.targets[0].changes.find(change => change.id === 'c1')
  assert.equal(untouched.skipReason, undefined, 'the human selection is preserved, not deleted')
  assert.equal(await h.statusOf('run-rebase'), 'ready', 'rebase keeps the run ready')

  const realigned = await callRoute(h.routes, 'distill-rebase', {
    method: 'POST',
    body: { runId: 'run-rebase', filePath: GUIDE },
  })
  assert.equal(realigned.body.rebase.planHash, currentHash)
  assert.equal(realigned.body.rebase.reason, 'already-aligned')

  // An already-present change is never written back twice.
  const skipWrite = await callRoute(h.routes, 'distill-apply', {
    method: 'POST',
    body: { runId: 'run-rebase', selectedChangeIds: ['c2'] },
  })
  assert.equal(skipWrite.body.ok, false)
  assert.deepEqual(skipWrite.body.alreadyPresentSkipped, ['c2'])
})

test('rebase: missing target and non-ready run report the contract error codes', async (t) => {
  const h = await makeHarness(t)
  await seedReadyRun(h.store, { runId: 'run-rebase2' })
  fs.rmSync(path.join(h.workspaceDir, GUIDE))
  const missing = await callRoute(h.routes, 'distill-rebase', {
    method: 'POST',
    body: { runId: 'run-rebase2', filePath: GUIDE },
  })
  assert.equal(missing.httpStatus, 200)
  assert.equal(missing.body.error.code, 'REBASE_TARGET_MISSING')

  const unknownFile = await callRoute(h.routes, 'distill-rebase', {
    method: 'POST',
    body: { runId: 'run-rebase2', filePath: 'docs/other.md' },
  })
  assert.equal(unknownFile.body.error.code, 'INVALID_REQUEST')

  await seedReadyRun(h.store, { runId: 'run-canceled', status: 'canceled' })
  const notReady = await callRoute(h.routes, 'distill-rebase', {
    method: 'POST',
    body: { runId: 'run-canceled', filePath: GUIDE },
  })
  assert.equal(notReady.body.error.code, 'RUN_NOT_READY')
  assert.equal(notReady.body.runStatus, 'canceled')
})

/* --------------------------- progress log + usage --------------------------- */

test('progress + usage: narration covers phases, sessions and model calls; usage sums the llm stream', async (t) => {
  // Real analyzer + fake Host llm: proves the stream usage echo reaches run.usage.
  const responses = [
    { text: JSON.stringify({ sessionId: 's1', candidates: [{ rule: 'r1', evidenceRefs: ['s1-a1'], suggestedTargets: [GUIDE] }] }) },
    { text: JSON.stringify({ sessionId: 's2', candidates: [{ rule: 'r2', evidenceRefs: ['s2-a1'], suggestedTargets: [GUIDE] }] }) },
    { text: JSON.stringify({ sessionId: 's3', candidates: [{ rule: 'r3', evidenceRefs: ['s3-a1'], suggestedTargets: [GUIDE] }] }) },
    {
      text: JSON.stringify({
        plan: {
          summary: '把本次决议写回 guide。',
          targets: [{
            file: GUIDE,
            changes: [{
              kind: 'insert-into-section',
              sectionAnchor: '## Section A',
              proposedText: '- 写回规则\n',
              rationale: '来自会话证据',
              evidenceSnippet: '证据',
              evidence: [{ sessionId: 's1', messageId: 's1-a1', grade: 'resolved' }],
            }],
          }],
          conflicts: [],
        },
        summaries: [],
      }),
    },
  ]
  const llmCalls = []
  const llm = {
    prepareCall: async (config) => {
      llmCalls.push(config)
      return {
        config: { ...config, context: { contextWindow: 200000 } },
        stream: () => {
          const response = responses.shift() || { text: '' }
          return (async function* stream() {
            if (response.text) yield { type: 'text-delta', text: response.text }
            yield {
              type: 'usage',
              usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150, cacheReadTokens: 50, cacheWriteTokens: 7 },
            }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      }
    },
  }
  const h = await makeHarness(t, {
    analyzer: createDistillAnalyzer({
      getService: (name) => {
        if (name === 'llm') return llm
        if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
        return null
      },
      store: null,
    }),
  })
  const started = await callRoute(h.routes, 'distill-run', {
    method: 'POST',
    body: { workspaceId: WS, sessions: SESSION_IDS },
  })
  assert.equal(started.body.run.usage && typeof started.body.run.usage === 'object', true, 'usage is present from the first poll')
  const runId = started.body.run.id
  await h.lifecycle.awaitRun(runId)
  const polled = await callRoute(h.routes, 'distill-run', { query: `?id=${runId}` })
  assert.equal(polled.body.run.status, 'ready', JSON.stringify(polled.body.run.error || {}))

  const run = polled.body.run
  // 3 stage-1 calls + 1 stage-2 call, each echoing the same TokenUsage.
  assert.equal(run.usage.calls, 4)
  assert.equal(run.usage.inputTokens, 480)
  assert.equal(run.usage.outputTokens, 120)
  assert.equal(run.usage.totalTokens, 600)
  assert.equal(run.usage.cacheReadTokens, 200)
  assert.equal(run.usage.cacheWriteTokens, 28)

  const log = run.progress.log
  assert.ok(Array.isArray(log) && log.length > 0)
  assert.ok(log.length <= 30, 'the timeline is bounded')
  const messages = log.map(entry => entry.message)
  assert.ok(messages.some(text => text.includes('开始收集素材')), 'phase switch: snapshotting')
  assert.ok(messages.some(text => text.includes('已读取会话 1/3')), 'per-session snapshot read')
  assert.ok(messages.some(text => text.includes('素材已冻结')), 'snapshot freeze narrated')
  assert.ok(messages.some(text => text.includes('开始分析')), 'phase switch: analyzing')
  // Result-type narration (second UX round, contract §2.3): each session line
  // says what it produced and what is still missing, instead of a tool name.
  assert.ok(messages.some(text => /会话「会话 s1」：1 条候选，其中 \d+ 条有代码提交证据；仍缺 2 个会话，正在取：会话 s2/.test(text)),
    'per-session result + remaining gap')
  assert.ok(messages.some(text => text.includes('收齐 3 个会话共 3 条候选')), 'stage 1 closes with the batch total')
  assert.ok(messages.some(text => text.includes('正在合并 3 条候选')), 'stage 2 merge is narrated')
  assert.ok(messages.some(text => text.includes('已合并为 1 个文件、1 条变更（0 项未决冲突）')), 'stage 2 result')
  assert.ok(messages.some(text => text.includes('开始静态校验')), 'phase switch: validating')
  assert.ok(messages.some(text => text.startsWith('静态校验：')), 'validation result counts errors/warnings')
  assert.ok(messages.some(text => text.includes('计划已就绪，等待你确认')), 'ready is narrated')
  for (const entry of log) {
    assert.equal(typeof entry.message, 'string')
    assert.ok(Number.isFinite(entry.at))
    assert.equal(typeof entry.stage, 'string')
  }
  // List mode (history) carries both ledgers too.
  const listed = await callRoute(h.routes, 'distill-run', { query: `?workspaceId=${WS}` })
  assert.equal(listed.body.runs[0].usage.calls, 4)
  assert.ok(listed.body.runs[0].progress.log.length > 0)
})

test('progress + usage: a legacy run without usage/log still renders defaults and errors keep HTTP 200', async (t) => {
  const h = await makeHarness(t)
  const legacy = {
    ...createDistillRun({ id: 'run-legacy', workspaceId: WS, sessions: SESSION_OBJS, now: T0 }),
    status: 'failed',
    updatedAt: T0,
    error: { code: 'ANALYZER_UNAVAILABLE', message: 'legacy failure' },
  }
  delete legacy.progress.log
  await h.store.putDistillRun(legacy)
  const { body } = await callRoute(h.routes, 'distill-run', { query: '?id=run-legacy' })
  assert.deepEqual(body.run.usage, {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    calls: 0,
  })
  assert.deepEqual(body.run.progress.log, [])

  const review = await callRoute(h.routes, 'distill-review', { method: 'POST', body: { runId: 'run-legacy' } })
  assert.equal(review.httpStatus, 200)
  assert.equal(review.body.error.code, 'REVIEW_NOT_ALLOWED')
})

test('estimate: a failed model probe degrades to null model/window instead of failing', async (t) => {
  const h = await makeHarness(t, {
    analyzer: {
      probeContextWindow: async () => ({ ok: false, error: { code: 'ANALYZER_UNAVAILABLE', message: 'no model' } }),
      runStage1: async () => ({ ok: false, error: { code: 'ANALYZER_UNAVAILABLE', message: 'no model' } }),
      runStage2: async () => ({ ok: false, error: { code: 'ANALYZER_UNAVAILABLE', message: 'no model' } }),
    },
  })
  const { httpStatus, body } = await callRoute(h.routes, 'distill-estimate', {
    query: `?workspaceId=${WS}&sessions=s1,s2,s3`,
  })
  assert.equal(httpStatus, 200)
  assert.equal(body.ok, true)
  assert.equal(body.estimate.model, null)
  assert.equal(body.estimate.contextWindow, null)
  assert.equal(body.estimate.budget.maxTokens, null, 'no trustworthy window means no invented cap')
  assert.equal(body.estimate.budget.usedTokens, body.estimate.totalTokens)
  assert.equal(body.estimate.budget.truncated, false)
  assert.ok(body.estimate.totalMaterials > 0)
})
