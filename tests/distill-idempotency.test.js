import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHostDeskStore, sha256Hex } from '../src/store/host.js'
import { createDistillLifecycle, createDistillApply } from '../src/store/distill-host.js'
import { createDistillRun } from '../src/domain/distill-run.js'
import { resolveConflictClaim } from '../src/domain/distill-plan.js'
import { createDistillAnalyzer } from '../src/store/distill-analyzer.js'

const T0 = 1_700_000_000_000
const DAY = 24 * 3600 * 1000
const WS = 'ws-1'
const GUIDE = '# Guide\n\n## Section A\n\nalpha\n\n## Section B\n\nbeta\n'
const AGENTS_NAV = '# AGENTS\n\n## 0. 工程文档体系与导航 (Project Documentation Navigation)\n\n- AGENTS.md\n- README.md\n- docs/\n  - guide.md\n\n## 1. Other\n'
const SESSIONS = [{ sessionId: 's1' }, { sessionId: 's2' }, { sessionId: 's3' }]

function mkChange(over = {}) {
  return {
    id: 'c1',
    kind: 'insert-into-section',
    sectionAnchor: '## Section A',
    proposedText: 'inserted note',
    rationale: 'because the session decided so',
    evidenceSnippet: 'excerpt',
    evidence: [{ sessionId: 's1', messageId: 'm1', turn: 1, grade: 'resolved' }],
    dependsOn: [],
    ...over,
  }
}

function restat(plan) {
  const byGrade = { resolved: 0, commit: 0, submitted: 0 }
  let changes = 0
  for (const target of plan.targets) {
    for (const change of target.changes) {
      changes += 1
      const grades = change.evidence.map(evidence => evidence.grade)
      const grade = grades.includes('resolved') ? 'resolved' : grades.includes('commit') ? 'commit' : grades.includes('submitted') ? 'submitted' : null
      if (grade) byGrade[grade] += 1
    }
  }
  plan.stats = { targets: plan.targets.length, changes, byGrade }
  return plan
}

function makeEnv(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-idem-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const wsDir = path.join(root, 'ws')
  fs.mkdirSync(path.join(wsDir, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(wsDir, 'AGENTS.md'), AGENTS_NAV)
  fs.writeFileSync(path.join(wsDir, 'docs', 'guide.md'), GUIDE)
  const backupsRoot = path.join(root, 'backups')
  const store = createHostDeskStore({ storageFilePath: path.join(root, 'store', 'punch_desk.json'), now: () => T0 })
  const clock = { now: T0 }
  let seq = 0
  const now = () => clock.now
  const uuid = () => `id-${++seq}`
  const workspaces = [{ id: WS, path: wsDir }]
  const analyzer = {
    probeContextWindow: async () => ({ ok: true, contextWindow: 200000, model: { provider: 'p', model: 'm' } }),
    runStage1: async () => ({ ok: false, error: { code: 'ANALYZER_UNAVAILABLE', message: 'stub' } }),
    runStage2: async () => ({ ok: false, error: { code: 'ANALYZER_UNAVAILABLE', message: 'stub' } }),
  }
  const lifecycle = createDistillLifecycle({ store, workspaces, now, uuid, analyzer })
  const distillApply = createDistillApply({ lifecycle, store, workspaces, now, uuid, backupsRoot })
  lifecycle.registerApplyRecovery(distillApply.recoverApplying)
  return { root, wsDir, backupsRoot, store, lifecycle, distillApply, clock, workspaces, uuid }
}

function makePlan(env, over = {}) {
  const content = fs.readFileSync(path.join(env.wsDir, 'docs', 'guide.md'), 'utf8')
  return restat({
    schemaVersion: 1,
    runId: 'run-1',
    workspaceId: WS,
    summary: 'idempotency test plan',
    navigation: { source: 'AGENTS.md#0', mode: 'tree', fallback: false },
    targets: [{
      file: 'docs/guide.md',
      action: 'update',
      navRef: 'AGENTS.md > docs/',
      fileBaseHash: sha256Hex(content),
      changes: [mkChange()],
    }],
    conflicts: [],
    stats: { targets: 1, changes: 1, byGrade: { resolved: 1, commit: 0, submitted: 0 } },
    truncated: false,
    ...over,
  })
}

async function seedReadyRun(env, plan, { runId = 'run-1' } = {}) {
  const created = createDistillRun({ id: runId, workspaceId: WS, sessions: SESSIONS, now: T0 })
  const run = await env.store.putDistillRun({ ...created, status: 'ready', planId: runId, updatedAt: T0 })
  await env.store.putDistillPlan({ ...plan, runId })
  return run
}

function validAnalyzerPlan(runId = 'run-1') {
  return {
    schemaVersion: 1,
    runId,
    workspaceId: WS,
    summary: 'summary',
    navigation: { source: 'AGENTS.md#0', mode: 'tree', fallback: false },
    targets: [{
      file: 'docs/guide.md',
      action: 'update',
      navRef: 'AGENTS.md > docs/',
      fileBaseHash: 'a'.repeat(64),
      changes: [{
        id: 'c1',
        kind: 'append-section',
        proposedText: '## New\n\nbody',
        rationale: 'r',
        evidenceSnippet: 'e',
        evidence: [{ sessionId: 's1', messageId: 'm1', turn: 1, grade: 'resolved' }],
        dependsOn: [],
      }],
    }],
    conflicts: [],
    stats: { targets: 1, changes: 1, byGrade: { resolved: 1, commit: 0, submitted: 0 } },
    truncated: false,
  }
}

function makeAnalyzerLlm({ contextWindow = 200000, response } = {}) {
  const calls = []
  const llm = {
    prepareCall: async (config) => {
      calls.push({ type: 'prepareCall', config })
      return {
        config: { ...config, context: { contextWindow } },
        stream: (streamOptions) => {
          calls.push({ type: 'stream', options: streamOptions })
          return (async function* stream() {
            yield { type: 'text-delta', text: response }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      }
    },
  }
  return { llm, calls }
}

// ---------------------------------------------------------------------------
// 1) §12.3 — stage-2 prompt carries a recent, file-grouped fingerprint digest
// ---------------------------------------------------------------------------

test('stage2 prompt injects a 180-day same-workspace fingerprint summary grouped by file', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-idem-analyzer-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const store = createHostDeskStore({ storageRoot: dir })
  const run = { id: 'run-1', workspaceId: WS, status: 'analyzing', sessions: [{ sessionId: 's1', title: 'S1' }], createdAt: T0, updatedAt: T0 }
  await store.putDistillRun(run)
  const mock = makeAnalyzerLlm({ response: JSON.stringify({ plan: validAnalyzerPlan() }) })
  const analyzer = createDistillAnalyzer(
    { getService: name => (name === 'llm' ? mock.llm : { currentSelection: () => ({ provider: 'p', model: 'm' }) }), store },
    { now: () => T0 },
  )
  const fingerprints = [
    { id: 'f1', workspaceId: WS, targetFile: 'docs/guide.md', changeKind: 'insert-into-section', sectionAnchor: '## Section A', normalizedHash: 'hash-1', appliedAt: T0 - 1 * DAY },
    { id: 'f2', workspaceId: WS, targetFile: 'docs/guide.md', changeKind: 'append-section', normalizedHash: 'hash-2', appliedAt: T0 - 30 * DAY },
    { id: 'f3', workspaceId: WS, targetFile: 'docs/old.md', changeKind: 'append-section', normalizedHash: 'hash-old', appliedAt: T0 - 200 * DAY },
    { id: 'f4', workspaceId: 'other-ws', targetFile: 'docs/other.md', changeKind: 'append-section', normalizedHash: 'hash-other', appliedAt: T0 - 1 * DAY },
  ]
  const result = await analyzer.runStage2({
    run,
    stage1Results: [],
    navigation: {},
    fingerprints,
    targetSnippets: {},
    budget: { maxTokens: 1000 },
  })
  assert.equal(result.ok, true)

  const streamCall = mock.calls.find(call => call.type === 'stream')
  assert.ok(streamCall)
  assert.match(streamCall.options.system, /已沉淀指纹摘要/)
  assert.match(streamCall.options.system, /不得重复提议/)
  const stage2Message = streamCall.options.messages[0]
  assert.ok(Array.isArray(stage2Message.content),
    'Host LLM messages take ContentBlock[] — a bare string makes the adapter fail at dispatch')
  assert.equal(stage2Message.content[0].type, 'text')
  const user = JSON.parse(stage2Message.content[0].text)
  assert.equal(user.fingerprintSummary.windowDays, 180)
  assert.equal(user.fingerprintSummary.total, 2)
  assert.deepEqual(user.fingerprintSummary.byFile.map(group => group.file), ['docs/guide.md'])
  assert.deepEqual(user.fingerprintSummary.byFile[0].changes.map(change => change.normalizedHash), ['hash-1', 'hash-2'])
  assert.equal(user.fingerprintSummary.byFile[0].changes[0].sectionAnchor, '## Section A')
  assert.equal(JSON.stringify(user).includes('docs/old.md'), false, 'stale fingerprints are excluded from the prompt')
  assert.equal(JSON.stringify(user).includes('docs/other.md'), false, 'cross-workspace fingerprints are excluded from the prompt')
  // Raw fingerprint rows are not echoed verbatim; only the compact digest is sent.
  assert.equal('fingerprints' in user, false)
})

// ---------------------------------------------------------------------------
// 2) §12.4 — equivalent final content degrades to "already present, skipped"
// ---------------------------------------------------------------------------

test('apply skips an update whose synthesized content is already on disk', async (t) => {
  const env = makeEnv(t)
  // replace-block with the exact current block content → synthesis is a no-op.
  const plan = makePlan(env, {
    targets: [{
      file: 'docs/guide.md',
      action: 'update',
      navRef: 'AGENTS.md > docs/',
      fileBaseHash: sha256Hex(GUIDE),
      changes: [mkChange({ id: 'c1', kind: 'replace-block', sectionAnchor: '## Section A', proposedText: 'alpha' })],
    }],
  })
  await seedReadyRun(env, plan)

  const result = await env.distillApply.applyPlan({ runId: 'run-1', selectedChangeIds: ['c1'] })
  assert.equal(result.ok, true)
  assert.equal(result.status, 200)
  assert.deepEqual(result.applied, [])
  assert.equal(result.skipped.length, 1)
  assert.equal(result.skipped[0].file, 'docs/guide.md')
  assert.equal(result.skipped[0].reason, 'equivalent')
  assert.equal(result.skipped[0].hash, sha256Hex(GUIDE))
  assert.equal(fs.readFileSync(path.join(env.wsDir, 'docs', 'guide.md'), 'utf8'), GUIDE)
  assert.equal((await env.store.getDistillRun('run-1')).status, 'applied')
  // §12.2: an equivalent-skipped change still leaves a fingerprint (no duplicate proposal later).
  const fingerprints = await env.store.listDistillFingerprints(WS)
  assert.equal(fingerprints.length, 1)
  assert.equal(fingerprints[0].targetFile, 'docs/guide.md')
  assert.equal(fingerprints[0].appliedFileHash, sha256Hex(GUIDE))
  assert.equal(fingerprints[0].backupPath, undefined)
})

// ---------------------------------------------------------------------------
// 3) §12.5 — rerun creates a new run and supersedes the old ready plan
// ---------------------------------------------------------------------------

test('a rerun supersedes the old ready run without touching its plan', async (t) => {
  const env = makeEnv(t)
  const plan = makePlan(env)
  await seedReadyRun(env, plan)

  const result = await env.lifecycle.startRun({ workspaceId: WS, sessions: SESSIONS })
  assert.equal(result.ok, true)
  assert.equal(result.run.status, 'queued')
  assert.notEqual(result.run.id, 'run-1')
  assert.deepEqual(result.supersededRunIds, ['run-1'])

  const oldRun = await env.store.getDistillRun('run-1')
  assert.equal(oldRun.status, 'superseded')
  assert.equal(oldRun.supersededBy, result.run.id)
  // The old plan is still readable (human selections are never overwritten).
  assert.equal((await env.store.getDistillPlan('run-1')).runId, 'run-1')

  await env.lifecycle.awaitRun(result.run.id)
  assert.equal((await env.store.getDistillRun('run-1')).status, 'superseded')
})

test('a non-ready active run still blocks rerun creation', async (t) => {
  const env = makeEnv(t)
  const created = createDistillRun({ id: 'run-active', workspaceId: WS, sessions: SESSIONS, now: T0 })
  await env.store.putDistillRun({ ...created, status: 'analyzing', updatedAt: T0 })
  const result = await env.lifecycle.startRun({ workspaceId: WS, sessions: SESSIONS })
  assert.equal(result.ok, false)
  assert.equal(result.status, 409)
  assert.equal(result.activeRunId, 'run-active')
})

// ---------------------------------------------------------------------------
// 4) §4.2 — ready plan 24h soft expiry hint
// ---------------------------------------------------------------------------

test('getRun exposes planExpired for a ready plan older than 24h', async (t) => {
  const env = makeEnv(t)
  await seedReadyRun(env, makePlan(env))

  env.clock.now = T0 + 25 * 3600 * 1000
  const polled = await env.lifecycle.getRun({ id: 'run-1' })
  assert.equal(polled.ok, true)
  assert.equal(polled.planExpired, true)

  // Separate workspace state: the first poll above already TTL-staled this run,
  // so list mode needs its own pre-recovery snapshot.
  const listEnv = makeEnv(t)
  await seedReadyRun(listEnv, makePlan(listEnv))
  listEnv.clock.now = T0 + 25 * 3600 * 1000
  const listed = await listEnv.lifecycle.getRun({ workspaceId: WS })
  assert.equal(listed.ok, true)
  assert.equal(listed.runs.length, 1)
  assert.equal(listed.runs[0].planExpired, true)

  const freshEnv = makeEnv(t)
  await seedReadyRun(freshEnv, makePlan(freshEnv))
  const fresh = await freshEnv.lifecycle.getRun({ id: 'run-1' })
  assert.equal(fresh.planExpired, false)
})

// ---------------------------------------------------------------------------
// 5) §6.2 / D15 — conflict adjudication tri-state
// ---------------------------------------------------------------------------

const claims = (over = {}) => ([
  { sessionId: 's1', messageId: 'm1', claim: '完成态归还配额', evidenceGrade: 'resolved', turn: 1 },
  { sessionId: 's2', messageId: 'm2', claim: '完成态不归还配额', evidenceGrade: 'commit', turn: 2, commit: 'abc1234' },
])

test('resolveConflictClaim: single claim resolves to the session', () => {
  const result = resolveConflictClaim({ claims: [claims()[0]], commitTraces: [] })
  assert.equal(result.resolvedBy, 'session')
  assert.match(result.reason, /single claim/)
})

test('resolveConflictClaim: a commit later than every claim turn wins as code', () => {
  const result = resolveConflictClaim({
    claims: claims(),
    commitTraces: [
      // claim turn times (ms)
      { sessionId: 's1', turn: 1, capturedAt: T0, commits: [] },
      { sessionId: 's2', turn: 2, capturedAt: T0 - 1000, commits: [{ hash: 'abc1234', time: Math.floor((T0 + 5000) / 1000) }] },
    ],
  })
  assert.equal(result.resolvedBy, 'code')
  assert.deepEqual(result.codeEvidence, [{ hash: 'abc1234', time: T0 + 5000 }])
  assert.match(result.reason, /later than every claim turn/)
})

test('resolveConflictClaim: a commit earlier than a claim turn stays unresolved', () => {
  const result = resolveConflictClaim({
    claims: claims(),
    commitTraces: [
      { sessionId: 's1', turn: 1, capturedAt: T0, commits: [] },
      { sessionId: 's2', turn: 2, capturedAt: T0 - 1000, commits: [{ hash: 'abc1234', time: Math.floor((T0 - 5000) / 1000) }] },
    ],
  })
  assert.equal(result.resolvedBy, 'unresolved')
  assert.match(result.reason, /predates at least one claim turn/)
})

test('resolveConflictClaim: missing commit evidence or unknown turn time stays unresolved', () => {
  const noCommit = resolveConflictClaim({ claims: claims(), commitTraces: [] })
  assert.equal(noCommit.resolvedBy, 'unresolved')
  assert.match(noCommit.reason, /no commit evidence/)

  const unknownTurn = resolveConflictClaim({
    claims: claims(),
    commitTraces: [{ sessionId: 's2', turn: 2, capturedAt: T0, commits: [{ hash: 'abc1234', time: Math.floor((T0 + 5000) / 1000) }] }],
  })
  assert.equal(unknownTurn.resolvedBy, 'unresolved')
  assert.match(unknownTurn.reason, /turn time is unavailable/)
})

test('resolveConflictClaim: no claims is unresolved', () => {
  assert.equal(resolveConflictClaim({}).resolvedBy, 'unresolved')
})
