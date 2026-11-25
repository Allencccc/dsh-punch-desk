// Host half of the second Finding Distillation UX round (/tmp/pd-ux2-contract.md
// §2): result-type process narration, `plan.changes[].beforeText` from the
// plan-time target snapshots, and `run.applyResult` persisted on success and
// failure (GET distill-run must expose it in both id and list modes).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'
import { createHostDeskStore, sha256Hex } from '../src/store/host.js'
import { createDistillAnalyzer } from '../src/store/distill-analyzer.js'
import { createDistillApply, createDistillLifecycle } from '../src/store/distill-host.js'
import { createDistillRun, appendProgressLog, PROGRESS_LOG_LIMIT } from '../src/domain/distill-run.js'

const T0 = 1_700_000_000_000
const WS = 'ws-ux2'
const SESSION_IDS = ['s1', 's2', 's3']
const SESSIONS = SESSION_IDS.map(sessionId => ({ sessionId, title: `会话 ${sessionId}` }))
const GUIDE = 'docs/guide.md'

function guideContent() {
  return '# Guide\n\n## Section A\n\noriginal body\n'
}

function makePlan(runId, workspaceDir) {
  const content = fs.readFileSync(path.join(workspaceDir, GUIDE), 'utf8')
  return {
    schemaVersion: 1,
    runId,
    workspaceId: WS,
    summary: 'ux2 host plan',
    navigation: { source: 'AGENTS.md#0', mode: 'tree', fallback: false },
    targets: [{
      file: GUIDE,
      action: 'update',
      navRef: 'AGENTS.md > docs/',
      fileBaseHash: sha256Hex(content),
      changes: [{
        id: 'c1',
        kind: 'insert-into-section',
        sectionAnchor: '## Section A',
        proposedText: '- ux2 rule\n',
        rationale: 'because',
        evidenceSnippet: 'snippet',
        evidence: [{ sessionId: 's1', messageId: 's1-a1', turn: 1, grade: 'resolved' }],
        dependsOn: [],
      }],
    }],
    conflicts: [],
    stats: { targets: 1, changes: 1, byGrade: { resolved: 1, commit: 0, submitted: 0 } },
    truncated: false,
  }
}

function sessionEvents(prefix) {
  return [
    { type: 'session/title', seq: 0, time: T0 - 6000, data: { title: `会话 ${prefix}`, messageSeqs: [], source: 'user' } },
    { type: 'turn/start', seq: 1, time: T0 - 5000, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: T0 - 4000, data: { id: `${prefix}-u1`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `question ${prefix}` }] } },
    { type: 'assistant/message', seq: 3, time: T0 - 3000, data: { id: `${prefix}-a1`, role: 'assistant', content: [{ type: 'text', text: `answer ${prefix}` }] } },
    { type: 'turn/end', seq: 4, time: T0 - 2000, data: { turn: 1 } },
  ]
}

/** Minimal Host llm double: text + usage + stop, queue-driven. */
function createMockLlm(responses) {
  const queue = [...responses]
  return {
    prepareCall: async (config) => ({
      config: { ...config, context: { contextWindow: 200000 } },
      stream: () => {
        const response = queue.shift() || {}
        return (async function* stream() {
          if (response.text) yield { type: 'text-delta', text: response.text }
          yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }),
  }
}

function makeRealAnalyzer(llm) {
  return createDistillAnalyzer({
    getService: (name) => {
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
      return null
    },
    store: null,
  })
}

/**
 * Host harness: fake Cordis context with a Connection route registry, real
 * temp-disk store, tree navigation and the injected analyzer.
 */
async function makeHarness(t, { analyzer, findCommitTrace = false } = {}) {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ux2-ws-'))
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ux2-store-'))
  const backupsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ux2-backups-'))
  t.after(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true })
    fs.rmSync(storageDir, { recursive: true, force: true })
    fs.rmSync(backupsRoot, { recursive: true, force: true })
  })
  fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'),
    '# Repo\n\n## 0. 工程文档体系与导航 (Project Documentation Navigation)\n\n```text\n├── AGENTS.md\n└── docs/\n    └── guide.md\n```\n\n## 1. Other\n')
  fs.mkdirSync(path.join(workspaceDir, 'docs'))
  fs.writeFileSync(path.join(workspaceDir, GUIDE), guideContent())
  const store = createHostDeskStore({ storageRoot: storageDir, now: () => Date.now() })
  const sessions = Object.fromEntries(SESSION_IDS.map(id => [id, sessionEvents(id)]))
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
    connection: { fetch: { register: (route) => { routes.push(route) } } },
  }
  // s1 keeps a commit-grade finding so the narration can count code evidence;
  // s2/s3 are human wrap-ups (resolved) like a normal batch.
  for (const id of SESSION_IDS) {
    await store.putEntry({
      id: `f-${id}`,
      kind: 'finding',
      sessionId: id,
      workspaceKey: `session:${id}`,
      title: `finding ${id}`,
      body: 'body',
      submissionStatus: 'submitted',
      ...(id === 's1' ? {} : { reviewStatus: 'resolved', completedVia: 'group-wrap-up' }),
      anchors: [{ kind: 'message', messageId: `${id}-a1` }],
      submittedAt: T0 - 3000,
    })
  }
  if (findCommitTrace) {
    const capturedAt = Date.now() - 60_000
    await store.putCommitTraces('session:s1', [{
      id: 'trace-s1',
      sessionId: 's1',
      findingIds: ['f-s1'],
      status: 'complete',
      preHead: 'a'.repeat(40),
      postHead: 'b'.repeat(40),
      commits: [{ hash: 'c'.repeat(40), shortHash: 'ccccccc', subject: 'commit', time: capturedAt }],
      turn: 1,
      capturedAt,
    }])
  }
  const applied = apply(ctx, {
    hostStore: store,
    distillAnalyzer: analyzer,
    workspaces: [{ id: WS, path: workspaceDir }],
    distillBackupsRoot: backupsRoot,
  })
  return {
    workspaceDir,
    backupsRoot,
    store,
    routes,
    lifecycle: applied.distillLifecycle,
    distillApply: applied.distillApply,
  }
}

async function callRoute(routes, name, { method = 'GET', query = '', body } = {}) {
  const route = routes.find(item => item.path === `/api/punch-desk/${name}`)
  assert.ok(route, `route ${name} must be registered`)
  const url = `http://localhost/api/punch-desk/${name}${query}`
  const init = method === 'POST'
    ? { method: 'POST', body: JSON.stringify(body ?? {}), headers: { 'content-type': 'application/json' } }
    : { method: 'GET' }
  const response = await route.fetch(new Request(url, init))
  return { httpStatus: response.status, body: await response.json() }
}

/** Seed a fresh ready run + plan (lazy recovery must not stale the fixture). */
async function seedReadyRun(store, workspaceDir, runId = 'run-ux2') {
  const now = Date.now()
  const run = createDistillRun({ id: runId, workspaceId: WS, sessions: SESSIONS, now })
  await store.putDistillRun({ ...run, status: 'ready', planId: runId, updatedAt: now })
  await store.putDistillPlan(makePlan(runId, workspaceDir))
  return runId
}

/* ----------------------------- beforeText ----------------------------- */

function beforeTextDraft(overrides = {}) {
  return {
    summary: 'beforeText',
    targets: [{
      file: GUIDE,
      changes: [{
        kind: 'insert-into-section',
        sectionAnchor: '## Section B',
        proposedText: '- rule\n',
        rationale: 'because',
        evidenceSnippet: 'snippet',
        evidence: [{ sessionId: 's1', messageId: 'm1', grade: 'resolved' }],
      }],
    }],
    conflicts: [],
    ...overrides,
  }
}

async function normalizeThroughStage2(draft, targetSnippets, fileFacts) {
  const mock = createMockLlm([{ text: JSON.stringify({ plan: draft, summaries: [] }) }])
  const analyzer = makeRealAnalyzer(mock)
  const run = { id: 'run-before', workspaceId: 'ws-before', status: 'analyzing', sessions: [], createdAt: 1, updatedAt: 1 }
  return analyzer.runStage2({
    run,
    stage1Results: [],
    navigation: { content: '', mode: 'fallback' },
    fingerprints: [],
    targetSnippets,
    budget: { maxTokens: 1000 },
    resolveFileFacts: fileFacts,
  })
}

test('beforeText: slices the plan-time snapshot at the section anchor and skips create targets', async () => {
  const snapshot = '# Guide\n\n## Section A\n\nalpha\n\n## Section B\n\nbeta\n'
  const draft = beforeTextDraft({
    targets: [
      {
        file: 'docs/guide.md',
        changes: [{
          kind: 'insert-into-section',
          sectionAnchor: '## Section B',
          proposedText: '- rule\n',
          rationale: 'because',
          evidenceSnippet: 'snippet',
          evidence: [{ sessionId: 's1', messageId: 'm1', grade: 'resolved' }],
        }],
      },
      {
        file: 'docs/new.md',
        changes: [{
          kind: 'create-file',
          proposedText: '# New\n\nfresh body\n',
          rationale: 'new doc',
          evidenceSnippet: 'snippet',
          evidence: [{ sessionId: 's1', messageId: 'm1', grade: 'resolved' }],
        }],
      },
    ],
  })
  const result = await normalizeThroughStage2(
    draft,
    [{ file: 'docs/guide.md', content: snapshot }, { file: 'docs/new.md', content: 'ignored' }],
    file => (file === 'docs/guide.md'
      ? { exists: true, fileBaseHash: 'a'.repeat(64) }
      : { exists: false, fileBaseHash: null }),
  )
  assert.equal(result.ok, true, JSON.stringify(result.error || {}))
  const guide = result.plan.targets.find(target => target.file === 'docs/guide.md')
  assert.equal(guide.action, 'update')
  assert.equal(
    guide.changes[0].beforeText,
    '## Section B\n\nbeta',
    'only the anchored section is echoed, taken from the plan-time snapshot',
  )
  const created = result.plan.targets.find(target => target.file === 'docs/new.md')
  assert.equal(created.action, 'create')
  assert.equal('beforeText' in created.changes[0], false, 'create targets never carry beforeText')
})

test('beforeText: falls back to the file head and is capped at 2000 characters', async () => {
  const longContent = `# Long\n\n${'x'.repeat(3000)}\n`
  const draft = beforeTextDraft({
    targets: [
      {
        file: 'docs/long.md',
        changes: [{
          kind: 'insert-into-section',
          sectionAnchor: '## Missing Section',
          proposedText: '- rule\n',
          rationale: 'because',
          evidenceSnippet: 'snippet',
          evidence: [{ sessionId: 's1', messageId: 'm1', grade: 'resolved' }],
        }],
      },
      {
        file: 'docs/append.md',
        changes: [{
          kind: 'append-section',
          proposedText: '## Appended\n\nbody\n',
          rationale: 'because',
          evidenceSnippet: 'snippet',
          evidence: [{ sessionId: 's1', messageId: 'm1', grade: 'resolved' }],
        }],
      },
    ],
  })
  const result = await normalizeThroughStage2(
    draft,
    [
      { file: 'docs/long.md', content: longContent },
      { file: 'docs/append.md', content: '# App\n\nbody\n' },
    ],
    () => ({ exists: true, fileBaseHash: 'b'.repeat(64) }),
  )
  assert.equal(result.ok, true, JSON.stringify(result.error || {}))
  const long = result.plan.targets.find(target => target.file === 'docs/long.md')
  assert.ok(long.changes[0].beforeText.startsWith('# Long'), 'missing anchor falls back to the file head')
  assert.equal(Array.from(long.changes[0].beforeText).length, 2000, 'beforeText is capped at 2000 characters')
  const append = result.plan.targets.find(target => target.file === 'docs/append.md')
  assert.equal(append.changes[0].beforeText, '# App\n\nbody\n', 'append-section echoes the file head')
})

/* ----------------------------- applyResult ----------------------------- */

test('applyResult: a successful apply is persisted and served by GET (id + list)', async (t) => {
  const h = await makeHarness(t, { analyzer: makeRealAnalyzer(createMockLlm([])) })
  const runId = await seedReadyRun(h.store, h.workspaceDir)

  const applied = await callRoute(h.routes, 'distill-apply', {
    method: 'POST',
    body: { runId, selectedChangeIds: ['c1'] },
  })
  assert.equal(applied.httpStatus, 200)
  assert.equal(applied.body.ok, true)
  assert.equal(applied.body.runStatus, 'applied')

  const byId = await callRoute(h.routes, 'distill-run', { query: `?id=${runId}` })
  assert.equal(byId.httpStatus, 200)
  const persisted = byId.body.run.applyResult
  assert.ok(persisted, 'GET ?id= carries run.applyResult')
  assert.equal(persisted.ok, true)
  assert.ok(Number.isFinite(persisted.appliedAt))
  assert.equal(persisted.applied.length, 1)
  assert.equal(persisted.applied[0].file, GUIDE)
  assert.match(persisted.applied[0].newHash, /^[0-9a-f]{64}$/)
  assert.ok(persisted.applied[0].backupPath, 'the backup path is part of the ledger')
  assert.deepEqual(persisted.skipped, [])
  assert.deepEqual(persisted.fingerprints, applied.body.fingerprints)
  assert.equal(persisted.readBackOk, true)
  assert.deepEqual(persisted.selectedChangeIds, ['c1'])
  assert.deepEqual(persisted.ignoredSkipped, [])
  assert.deepEqual(persisted.alreadyPresentSkipped, [])
  assert.equal(typeof persisted.usage, 'object')
  assert.ok(Number.isInteger(persisted.usage.calls))

  const listed = await callRoute(h.routes, 'distill-run', { query: `?workspaceId=${WS}` })
  assert.equal(listed.httpStatus, 200)
  const row = listed.body.runs.find(run => run.id === runId)
  assert.ok(row, 'the applied run is listed')
  assert.equal(row.applyResult.ok, true, 'GET ?workspaceId= carries run.applyResult too')
  assert.equal(row.applyResult.applied[0].file, GUIDE)
  // The write-back narration names the file and confirms the read-back.
  const messages = row.progress.log.map(entry => entry.message)
  assert.ok(messages.some(text => text.startsWith(`正在写回 ${GUIDE}（1/1）`)))
  assert.ok(messages.some(text => text.includes('已写回 1 个文件并完成回读校验')))
})

test('applyResult: a refused apply persists the failure and keeps the run ready', async (t) => {
  const h = await makeHarness(t, { analyzer: makeRealAnalyzer(createMockLlm([])) })
  const runId = await seedReadyRun(h.store, h.workspaceDir)
  // The human edited the file outside the plugin: the plan baseline drifted.
  fs.writeFileSync(path.join(h.workspaceDir, GUIDE), '# Guide\n\nexternally edited\n')

  const refused = await callRoute(h.routes, 'distill-apply', {
    method: 'POST',
    body: { runId, selectedChangeIds: ['c1'] },
  })
  assert.equal(refused.body.ok, false)
  assert.equal(refused.body.code, 'CAS_CONFLICT')

  const byId = await callRoute(h.routes, 'distill-run', { query: `?id=${runId}` })
  assert.equal(byId.body.run.status, 'ready', 'a refused apply must not move the run out of ready')
  const persisted = byId.body.run.applyResult
  assert.ok(persisted, 'GET ?id= carries the failure record')
  assert.equal(persisted.ok, false)
  assert.equal(persisted.code, 'CAS_CONFLICT')
  assert.equal(persisted.file, GUIDE)
  assert.equal(persisted.rolledBack, false)
  assert.ok(Number.isFinite(persisted.at))
  assert.equal(typeof persisted.message, 'string')

  const listed = await callRoute(h.routes, 'distill-run', { query: `?workspaceId=${WS}` })
  const row = listed.body.runs.find(run => run.id === runId)
  assert.equal(row.applyResult.ok, false, 'GET ?workspaceId= carries the failure record too')
  assert.ok(row.progress.log.some(entry => entry.message.includes('写回未开始：CAS_CONFLICT')))
})

test('applyResult: a mid-write failure rolls back and records the failure on the run', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ux2-writefail-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const wsDir = path.join(root, 'ws')
  fs.mkdirSync(path.join(wsDir, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(wsDir, 'AGENTS.md'),
    '# Repo\n\n## 0. 工程文档体系与导航 (Project Documentation Navigation)\n\n```text\n├── AGENTS.md\n└── docs/\n    └── guide.md\n```\n\n## 1. Other\n')
  fs.writeFileSync(path.join(wsDir, GUIDE), guideContent())
  const target = path.join(wsDir, GUIDE)
  // Fail the FIRST atomic replacement of the target only; the rollback write
  // must still go through (otherwise this would test the recovery-conflict path).
  let failedOnce = false
  const failingFs = new Proxy(fs, {
    get(targetFs, prop) {
      if (prop === 'renameSync') {
        return (from, to) => {
          if (!failedOnce && to === target) {
            failedOnce = true
            const error = new Error('simulated disk failure')
            error.code = 'EIO'
            throw error
          }
          return targetFs.renameSync(from, to)
        }
      }
      const value = targetFs[prop]
      return typeof value === 'function' ? value.bind(targetFs) : value
    },
  })
  const store = createHostDeskStore({ storageRoot: path.join(root, 'store'), now: () => Date.now() })
  let seq = 0
  const now = () => Date.now()
  const uuid = () => `id-${++seq}`
  const workspaces = [{ id: WS, path: wsDir }]
  const lifecycle = createDistillLifecycle({ store, workspaces, now, uuid, fs: failingFs })
  const engine = createDistillApply({
    lifecycle,
    store,
    workspaces,
    now,
    uuid,
    backupsRoot: path.join(root, 'backups'),
    fs: failingFs,
  })
  const runId = await seedReadyRun(store, wsDir)

  const result = await engine.applyPlan({ runId, selectedChangeIds: ['c1'] })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'EIO')
  assert.equal(result.rolledBack, true)
  assert.equal(fs.readFileSync(target, 'utf8'), guideContent(), 'the target is restored from the backup')

  const run = await store.getDistillRun(runId)
  assert.equal(run.status, 'failed')
  assert.equal(run.applyResult.ok, false)
  assert.equal(run.applyResult.code, 'EIO')
  assert.equal(run.applyResult.rolledBack, true)
  assert.equal(typeof run.applyResult.message, 'string')
  assert.ok(Number.isFinite(run.applyResult.at))
  const messages = run.progress.log.map(entry => entry.message)
  assert.ok(messages.some(text => text.includes(`正在写回 ${GUIDE}（1/1）`)))
  assert.ok(messages.some(text => text.includes('写回失败：EIO，已回滚全部写入')))
})

/* --------------------------- result narration --------------------------- */

function narrationResponses() {
  return [
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
              evidence: [{ sessionId: 's1', messageId: 's1-a1', grade: 'commit', commit: 'ccccccc' }],
            }],
          }],
          conflicts: [],
        },
        summaries: [],
      }),
    },
  ]
}

test('narration: stage 1/2 report results and the remaining gap, bounded to 30 lines', async (t) => {
  const h = await makeHarness(t, {
    analyzer: makeRealAnalyzer(createMockLlm(narrationResponses())),
    findCommitTrace: true,
  })
  const started = await callRoute(h.routes, 'distill-run', {
    method: 'POST',
    body: { workspaceId: WS, sessions: SESSIONS },
  })
  assert.equal(started.body.ok, true)
  const runId = started.body.run.id
  await h.lifecycle.awaitRun(runId)
  const polled = await callRoute(h.routes, 'distill-run', { query: `?id=${runId}` })
  assert.equal(polled.body.run.status, 'ready', JSON.stringify(polled.body.run.error || {}))

  const log = polled.body.run.progress.log
  assert.ok(Array.isArray(log))
  assert.ok(log.length <= PROGRESS_LOG_LIMIT, 'the timeline stays bounded to 30 lines')
  const messages = log.map(entry => entry.message)

  // Per-session result + explicit gap (never a bare tool name).
  assert.ok(
    messages.includes('会话「会话 s1」：1 条候选，其中 1 条有代码提交证据；仍缺 2 个会话，正在取：会话 s2'),
    'stage-1 narration names the produced candidates, the commit evidence and the next session',
  )
  assert.ok(
    messages.includes('会话「会话 s2」：1 条候选，其中 0 条有代码提交证据；仍缺 1 个会话，正在取：会话 s3'),
  )
  assert.ok(messages.includes('收齐 3 个会话共 3 条候选，进入合并去重与冲突裁决'))
  assert.ok(messages.includes('正在合并 3 条候选，去重并裁决冲突…'))
  assert.ok(messages.includes('已合并为 1 个文件、1 条变更（0 项未决冲突）'))
  assert.ok(messages.some(text => text.startsWith('静态校验：')), 'validation reports its error/warning counts')
  assert.ok(messages.includes('计划已就绪，等待你确认'))
  for (const entry of log) {
    assert.equal(typeof entry.stage, 'string')
    assert.ok(Number.isFinite(entry.at))
  }
})

test('narration: appendProgressLog keeps exactly the newest 30 lines', () => {
  let progress = { log: [] }
  for (let i = 0; i < 40; i += 1) progress = appendProgressLog(progress, 'stage1', `line ${i}`, T0 + i)
  assert.equal(progress.log.length, PROGRESS_LOG_LIMIT)
  assert.equal(progress.log[0].message, 'line 10')
  assert.equal(progress.log.at(-1).message, 'line 39')
  assert.equal(progress.log.at(-1).at, T0 + 39)
})
