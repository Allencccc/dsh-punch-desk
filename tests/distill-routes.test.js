import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  apply,
  handleDistillDocs,
  handleDistillRun,
  handleDistillCancel,
  handleDistillBaseline,
} from '../index.js'
import { createHostDeskStore, sha256Hex } from '../src/store/host.js'
import { createDistillRun } from '../src/domain/distill-run.js'

const T0 = 1_700_000_000_000
const WS = 'ws-1'
const SESSION_IDS = ['s1', 's2', 's3']
const SESSION_OBJS = SESSION_IDS.map(sessionId => ({ sessionId }))

function deferred() {
  let resolve
  const promise = new Promise(res => { resolve = res })
  return { promise, resolve }
}

async function waitFor(predicate, { timeout = 4000, interval = 5 } = {}) {
  const start = Date.now()
  while (!(await predicate())) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await new Promise(r => setTimeout(r, interval))
  }
}

function sessionEvents(prefix) {
  return [
    { type: 'turn/start', seq: 1, time: T0 - 5000, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: T0 - 4000, data: { id: `${prefix}-u1`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `question ${prefix}` }] } },
    { type: 'assistant/message', seq: 3, time: T0 - 3000, data: { id: `${prefix}-a1`, role: 'assistant', content: [{ type: 'text', text: `answer ${prefix}` }] } },
    { type: 'turn/end', seq: 4, time: T0 - 2000, data: { turn: 1 } },
  ]
}

function makePlan(runId, workspaceDir) {
  const content = fs.readFileSync(path.join(workspaceDir, 'docs', 'guide.md'), 'utf8')
  return {
    schemaVersion: 1,
    runId,
    workspaceId: WS,
    summary: 'route test plan',
    navigation: { source: 'AGENTS.md#0', mode: 'tree', fallback: false },
    targets: [{
      file: 'docs/guide.md',
      action: 'update',
      navRef: 'AGENTS.md > docs/',
      fileBaseHash: sha256Hex(content),
      changes: [{
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
    rawResponseRef: 'raw-route-1',
  }
}

function makeAnalyzer({ store, workspaceDir, probeImpl, stage1Impl }) {
  return {
    probeContextWindow: probeImpl || (async () => ({ ok: true, contextWindow: 200000, model: { provider: 'p', model: 'm' } })),
    runStage1: stage1Impl || (async ({ sessionId }) => ({
      ok: true,
      candidates: [{ rule: `rule-${sessionId}`, evidenceRefs: [], suggestedTargets: ['docs/guide.md'] }],
      usage: { usedTokens: 10, truncated: false },
    })),
    runStage2: async ({ run, stage1Results }) => {
      const plan = makePlan(run.id, workspaceDir)
      await store.putDistillPlan(plan)
      return {
        ok: true,
        plan,
        summaries: stage1Results.map(r => ({ sessionId: r.sessionId, markdown: `# sum ${r.sessionId}`, source: 'llm' })),
        usage: { usedTokens: 20, truncated: false },
      }
    },
  }
}

/**
 * Full Host wiring through apply(): fake Cordis context with a connection
 * route registry, real temp-disk store, mock analyzer (DI).
 */
async function makeRouteHarness(t, { navigation = true, probeImpl, stage1Impl } = {}) {
  const clock = { now: T0 }
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-routes-ws-'))
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-routes-store-'))
  t.after(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true })
    fs.rmSync(storageDir, { recursive: true, force: true })
  })
  if (navigation) {
    fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'),
      '# Repo\n\n## 0. 工程文档体系与导航 (Project Documentation Navigation)\n\n```text\n├── AGENTS.md\n└── docs/\n    └── guide.md\n```\n\n## 1. Other\n')
  }
  fs.mkdirSync(path.join(workspaceDir, 'docs'))
  fs.writeFileSync(path.join(workspaceDir, 'docs', 'guide.md'), '# Guide\n\n## Section A\n\noriginal body\n')
  const store = createHostDeskStore({ storageRoot: storageDir, now: () => clock.now })
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
    connection: { fetch: { register: route => { routes.push(route) } } },
  }
  for (const id of SESSION_IDS) {
    await store.putEntry({
      id: `f-${id}`, kind: 'finding', sessionId: id, workspaceKey: `session:${id}`,
      title: 't', body: 'b', submissionStatus: 'submitted', reviewStatus: 'resolved',
      completedVia: 'group-wrap-up', anchors: [{ kind: 'message', messageId: `${id}-a1` }], submittedAt: T0 - 3000,
    })
  }
  const analyzer = makeAnalyzer({ store, workspaceDir, probeImpl, stage1Impl })
  const applied = apply(ctx, {
    hostStore: store,
    distillAnalyzer: analyzer,
    workspaces: [{ id: WS, path: workspaceDir }],
  })
  const lifecycle = applied.distillLifecycle
  const statusOf = async (id) => (await store.getDistillRun(id))?.status
  return { clock, workspaceDir, store, routes, lifecycle, statusOf }
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

test('routes: apply registers the four distill paths beside the legacy nine', async (t) => {
  const h = await makeRouteHarness(t)
  // Task 4.2: spec-baseline / spec-writeback retired; the UX Host contract adds
  // distill-estimate / distill-delete / distill-review / distill-rebase, and
  // park/abandon add two more, and turn-actions-scan adds the 19th path.
  assert.equal(h.routes.length, 19)
  const byPath = Object.fromEntries(h.routes.map(r => [r.path, r.methods]))
  assert.deepEqual(byPath['/api/punch-desk/turn-actions-scan'], ['POST'])
  assert.deepEqual(byPath['/api/punch-desk/distill-docs'], ['GET'])
  assert.deepEqual(byPath['/api/punch-desk/distill-run'], ['GET', 'POST'])
  assert.deepEqual(byPath['/api/punch-desk/distill-cancel'], ['POST'])
  assert.deepEqual(byPath['/api/punch-desk/distill-baseline'], ['GET'])
  assert.deepEqual(byPath['/api/punch-desk/distill-apply'], ['POST'])
  assert.deepEqual(byPath['/api/punch-desk/distill-estimate'], ['GET'])
  assert.deepEqual(byPath['/api/punch-desk/distill-delete'], ['POST'])
  assert.deepEqual(byPath['/api/punch-desk/distill-review'], ['POST'])
  assert.deepEqual(byPath['/api/punch-desk/distill-rebase'], ['POST'])
  assert.deepEqual(byPath['/api/punch-desk/distill-park'], ['POST'])
  assert.deepEqual(byPath['/api/punch-desk/distill-abandon'], ['POST'])
  for (const legacy of ['git-branch', 'git-head', 'git-commit-range', 'commit-trace-lookup', 'workspace-files', 'store-migrate', 'store']) {
    assert.ok(byPath[`/api/punch-desk/${legacy}`], `legacy route ${legacy} intact`)
  }
  assert.equal(byPath['/api/punch-desk/spec-baseline'], undefined, 'spec-baseline route retired (Task 4.2)')
  assert.equal(byPath['/api/punch-desk/spec-writeback'], undefined, 'spec-writeback route retired (Task 4.2)')
})

test('routes: distill-docs returns navigation tree and allowedRoots', async (t) => {
  const h = await makeRouteHarness(t)
  const { httpStatus, body } = await callRoute(h.routes, 'distill-docs', { query: `?workspaceId=${WS}` })
  assert.equal(httpStatus, 200)
  assert.equal(body.ok, true)
  assert.equal(body.navigation.mode, 'tree')
  assert.ok(body.navigation.content.includes('## 0.'))
  assert.deepEqual(body.allowedRoots, ['AGENTS.md', 'README.md', 'docs/'])
})

test('routes: distill-docs degrades to fallback without AGENTS.md §0', async (t) => {
  const h = await makeRouteHarness(t, { navigation: false })
  const { body } = await callRoute(h.routes, 'distill-docs', { query: `?workspaceId=${WS}` })
  assert.equal(body.navigation.mode, 'fallback')
  assert.deepEqual(body.allowedRoots, ['AGENTS.md', 'README.md'])
})

test('routes: distill-run POST starts, GET ?id= polls, GET ?workspaceId= lists with plan', async (t) => {
  const h = await makeRouteHarness(t)
  const started = await callRoute(h.routes, 'distill-run', { method: 'POST', body: { workspaceId: WS, sessions: SESSION_IDS } })
  assert.equal(started.httpStatus, 200)
  assert.equal(started.body.ok, true)
  assert.equal(started.body.run.status, 'queued')
  const runId = started.body.run.id
  await h.lifecycle.awaitRun(runId)

  const polled = await callRoute(h.routes, 'distill-run', { query: `?id=${runId}` })
  assert.equal(polled.httpStatus, 200)
  assert.equal(polled.body.run.status, 'ready')
  assert.equal(polled.body.plan.runId, runId)
  assert.equal(polled.body.plan.rawResponseRef, 'raw-route-1')
  assert.ok(Array.isArray(polled.body.plan.checks))
  assert.equal(polled.body.lock.locked, true)
  assert.equal(polled.body.lock.reason, 'ready')

  const listed = await callRoute(h.routes, 'distill-run', { query: `?workspaceId=${WS}` })
  assert.equal(listed.httpStatus, 200)
  assert.equal(listed.body.runs.length, 1)
  assert.equal(listed.body.runs[0].id, runId)
  assert.equal(listed.body.runs[0].plan.runId, runId)
  assert.equal(listed.body.runs[0].lock.locked, true)
  assert.equal(listed.body.runs[0].summaries.length, 3)
})

test('routes: distill-run GET validates params and unknown ids', async (t) => {
  const h = await makeRouteHarness(t)
  const missing = await callRoute(h.routes, 'distill-run', {})
  assert.equal(missing.httpStatus, 400)
  assert.equal(missing.body.code, 'INVALID_REQUEST')
  const unknown = await callRoute(h.routes, 'distill-run', { query: '?id=nope' })
  assert.equal(unknown.httpStatus, 404)
  assert.equal(unknown.body.code, 'RUN_NOT_FOUND')
})

test('routes: distill-cancel arbitrates with the spec string status under HTTP 200', async (t) => {
  const h = await makeRouteHarness(t)
  const started = await callRoute(h.routes, 'distill-run', { method: 'POST', body: { workspaceId: WS, sessions: SESSION_IDS } })
  await h.lifecycle.awaitRun(started.body.run.id)
  const canceled = await callRoute(h.routes, 'distill-cancel', { method: 'POST', body: { runId: started.body.run.id } })
  assert.equal(canceled.httpStatus, 200)
  assert.equal(canceled.body.ok, true)
  assert.equal(canceled.body.status, 'canceled')
  assert.equal(canceled.body.runStatus, 'canceled')
  // idempotent repeat
  const again = await callRoute(h.routes, 'distill-cancel', { method: 'POST', body: { runId: started.body.run.id } })
  assert.equal(again.body.status, 'canceled')
  const missing = await callRoute(h.routes, 'distill-cancel', { method: 'POST', body: {} })
  assert.equal(missing.httpStatus, 400)
  const unknown = await callRoute(h.routes, 'distill-cancel', { method: 'POST', body: { runId: 'nope' } })
  assert.equal(unknown.httpStatus, 404)
})

test('routes: active cancel through the route returns cancelRequested without lock wait', async (t) => {
  const gate = deferred()
  const h = await makeRouteHarness(t, { stage1Impl: async () => { await gate.promise; return { ok: true, candidates: [] } } })
  const started = await callRoute(h.routes, 'distill-run', { method: 'POST', body: { workspaceId: WS, sessions: SESSION_IDS } })
  const runId = started.body.run.id
  await waitFor(async () => (await h.statusOf(runId)) === 'analyzing')
  const cancel = await callRoute(h.routes, 'distill-cancel', { method: 'POST', body: { runId } })
  assert.equal(cancel.httpStatus, 200)
  assert.equal(cancel.body.status, 'cancelRequested')
  gate.resolve()
  await h.lifecycle.awaitRun(runId)
  assert.equal(await h.statusOf(runId), 'canceled')
})

test('routes: distill-baseline serves multi-file content and baseHash', async (t) => {
  const h = await makeRouteHarness(t)
  const { httpStatus, body } = await callRoute(h.routes, 'distill-baseline', { query: `?workspaceId=${WS}&files=AGENTS.md,docs/guide.md,docs/missing.md` })
  assert.equal(httpStatus, 200)
  assert.equal(body.files.length, 3)
  const [agents, guide, missing] = body.files
  assert.equal(agents.exists, true)
  assert.equal(agents.baseHash, sha256Hex(agents.content))
  assert.equal(guide.file, 'docs/guide.md')
  assert.equal(guide.baseHash, sha256Hex(fs.readFileSync(path.join(h.workspaceDir, 'docs', 'guide.md'), 'utf8')))
  assert.deepEqual(missing, { file: 'docs/missing.md', exists: false, content: null, baseHash: null })
})

test('routes: distill-baseline rejects traversal and non-Markdown paths', async (t) => {
  const h = await makeRouteHarness(t)
  const traversal = await callRoute(h.routes, 'distill-baseline', { query: `?workspaceId=${WS}&files=../secret.md` })
  assert.equal(traversal.httpStatus, 403)
  assert.equal(traversal.body.code, 'PATH_REJECTED')
  const nonMd = await callRoute(h.routes, 'distill-baseline', { query: `?workspaceId=${WS}&files=package.json` })
  assert.equal(nonMd.httpStatus, 403)
  const empty = await callRoute(h.routes, 'distill-baseline', { query: `?workspaceId=${WS}` })
  assert.equal(empty.httpStatus, 400)
})

test('routes: POST error mapping follows §13.3 (probe/workspace/validation)', async (t) => {
  const unavailable = await makeRouteHarness(t, { probeImpl: async () => ({ ok: false, error: { code: 'ANALYZER_UNAVAILABLE', message: 'no model' } }) })
  const r1 = await callRoute(unavailable.routes, 'distill-run', { method: 'POST', body: { workspaceId: WS, sessions: SESSION_IDS } })
  assert.equal(r1.httpStatus, 503)
  assert.equal(r1.body.code, 'ANALYZER_UNAVAILABLE')
  assert.deepEqual(await unavailable.store.listDistillRuns(WS), [])

  const noContext = await makeRouteHarness(t, { probeImpl: async () => ({ ok: false, error: { code: 'CONTEXT_WINDOW_UNAVAILABLE', message: 'too small' } }) })
  const r2 = await callRoute(noContext.routes, 'distill-run', { method: 'POST', body: { workspaceId: WS, sessions: SESSION_IDS } })
  assert.equal(r2.httpStatus, 409)
  assert.equal(r2.body.code, 'CONTEXT_WINDOW_UNAVAILABLE')
  assert.deepEqual(await noContext.store.listDistillRuns(WS), [])

  const h = await makeRouteHarness(t)
  const r3 = await callRoute(h.routes, 'distill-run', { method: 'POST', body: { workspaceId: 'default', sessions: SESSION_IDS } })
  assert.equal(r3.httpStatus, 400)
  assert.equal(r3.body.code, 'INVALID_WORKSPACE_ID')
  const r4 = await callRoute(h.routes, 'distill-run', { method: 'POST', body: { workspaceId: 'ws-unknown', sessions: SESSION_IDS } })
  assert.equal(r4.httpStatus, 409)
  assert.equal(r4.body.code, 'WORKSPACE_UNAVAILABLE')
  const r5 = await callRoute(h.routes, 'distill-run', { method: 'POST', body: { workspaceId: WS, sessions: ['s1'] } })
  assert.equal(r5.httpStatus, 400)
})

test('routes: invalid JSON bodies are rejected with 400', async (t) => {
  const h = await makeRouteHarness(t)
  const run = await callRoute(h.routes, 'distill-run', { method: 'POST', rawBody: 'not-json' })
  assert.equal(run.httpStatus, 400)
  const cancel = await callRoute(h.routes, 'distill-cancel', { method: 'POST', rawBody: '{' })
  assert.equal(cancel.httpStatus, 400)
})

test('routes: list mode triggers lazy recovery (stale run recovered on refresh)', async (t) => {
  const h = await makeRouteHarness(t)
  const old = T0 - 3 * 60 * 60 * 1000
  await h.store.putDistillRun({ ...createDistillRun({ id: 'stranded', workspaceId: WS, sessions: SESSION_OBJS, now: old }), status: 'analyzing', updatedAt: old })
  const listed = await callRoute(h.routes, 'distill-run', { query: `?workspaceId=${WS}` })
  assert.equal(listed.httpStatus, 200)
  const stranded = listed.body.runs.find(r => r.id === 'stranded')
  assert.equal(stranded.status, 'stale')
  assert.equal(stranded.lock.locked, false)
  assert.equal(stranded.lock.reason, 'terminal')
})

test('routes: GET ?id= polling reflects live progress during analysis', async (t) => {
  const gate = deferred()
  const h = await makeRouteHarness(t, { stage1Impl: async () => { await gate.promise; return { ok: true, candidates: [] } } })
  const started = await callRoute(h.routes, 'distill-run', { method: 'POST', body: { workspaceId: WS, sessions: SESSION_IDS } })
  const runId = started.body.run.id
  await waitFor(async () => (await h.statusOf(runId)) === 'analyzing')
  const polled = await callRoute(h.routes, 'distill-run', { query: `?id=${runId}` })
  assert.equal(polled.body.run.status, 'analyzing')
  assert.equal(polled.body.run.progress.stage, 'stage1')
  assert.equal(polled.body.lock.locked, true)
  assert.equal(polled.body.lock.reason, 'analyzing')
  gate.resolve()
  await h.lifecycle.awaitRun(runId)
})

test('routes: handlers without a lifecycle degrade to 500, never throw', async () => {
  for (const handler of [handleDistillDocs, handleDistillRun, handleDistillCancel, handleDistillBaseline]) {
    const result = await handler({}, {})
    assert.equal(result.ok, false)
    assert.equal(result.status, 500)
  }
})

test('routes: the Host entry wires the real analyzer when the profile injects none', async (t) => {
  // Regression: index.js used to pass `analyzer: pluginOptions.distillAnalyzer
  // || null`, so a real installation degraded every start to
  // "distill analyzer is not wired into this Host entry". The Host entry must
  // construct createDistillAnalyzer itself and bridge ctx.get lazily.
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-routes-wired-'))
  t.after(() => fs.rmSync(storageDir, { recursive: true, force: true }))
  const store = createHostDeskStore({ storageRoot: storageDir, now: () => T0 })
  const routes = []
  const ctx = {
    get(name) { throw new Error(`cannot get property "${name}" without inject`) },
    effect: fn => fn(),
    connection: { fetch: { register: route => { routes.push(route) } } },
  }
  apply(ctx, { hostStore: store })
  const route = routes.find(item => item.path === '/api/punch-desk/distill-run')
  assert.ok(route, 'distill-run route is registered')
  const response = await route.fetch(new Request('http://localhost/api/punch-desk/distill-run', {
    method: 'POST',
    body: JSON.stringify({ workspaceId: 'ws-wired', sessions: SESSION_IDS }),
    headers: { 'content-type': 'application/json' },
  }))
  const body = await response.json()
  assert.equal(response.status, 503, 'probe failure maps to 503')
  assert.equal(body.code, 'ANALYZER_UNAVAILABLE')
  assert.match(body.error, /模型服务不可用/,
    'the wired analyzer reports the real model-service state')
  assert.doesNotMatch(body.error, /not wired into this Host entry/,
    'the placeholder analyzer is no longer used by the Host entry')
  assert.deepEqual(await store.listDistillRuns('ws-wired'), [],
    'a failed probe creates no run')
})
