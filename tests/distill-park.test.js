// Finding Distillation — park / abandon (Host routes + history / pending wiring).
//
// Contract under test:
//   POST distill-park { runId, parked }  → ready only; parked releases the
//     submission lock, unpark clears the flag and restarts the ready TTL.
//   POST distill-abandon { runId }       → ready|failed|canceled|stale|
//     superseded|queued delete run + plan and keep fingerprints; applying /
//     applied are refused with ABANDON_NOT_ALLOWED.
//   GET distill-run                     → list/id carry `parked` (default false).
//   DistillView                         → pending actions (park / two-step
//     abandon) and history 「回到确认」 (park false → pending).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'
import { createHostDeskStore, sha256Hex } from '../src/store/host.js'
import { createDistillRun, deriveLockWindow, lockTtlMs } from '../src/domain/distill-run.js'
import { createDistillView } from '../src/client/ui/distill-view.js'
import { dictionaries } from '../src/locale.js'

const T0 = 1_700_000_000_000
const WS = 'ws-park'
const SESSION_IDS = ['s1', 's2', 's3']
const SESSION_OBJS = SESSION_IDS.map(sessionId => ({ sessionId }))
const GUIDE = 'docs/guide.md'

function guideContent() {
  return '# Guide\n\n## Section A\n\noriginal body\n'
}

function makePlan(runId) {
  return {
    schemaVersion: 1,
    runId,
    workspaceId: WS,
    summary: 'park plan',
    navigation: { source: 'AGENTS.md#0', mode: 'tree', fallback: false },
    targets: [{
      file: GUIDE,
      action: 'update',
      navRef: 'AGENTS.md > docs/',
      fileBaseHash: sha256Hex(guideContent()),
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
  }
}

/** Fake Cordis context + real temp store; no analyzer work happens here. */
async function makeHarness(t) {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-park-ws-'))
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-park-store-'))
  t.after(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true })
    fs.rmSync(storageDir, { recursive: true, force: true })
  })
  fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'),
    '# Repo\n\n## 0. 工程文档体系与导航 (Project Documentation Navigation)\n\n```text\n├── AGENTS.md\n└── docs/\n    └── guide.md\n```\n\n## 1. Other\n')
  fs.mkdirSync(path.join(workspaceDir, 'docs'))
  fs.writeFileSync(path.join(workspaceDir, GUIDE), guideContent())
  const backupsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-park-backups-'))
  t.after(() => fs.rmSync(backupsRoot, { recursive: true, force: true }))
  const store = createHostDeskStore({ storageRoot: storageDir })
  const routes = []
  const ctx = {
    get(name) {
      if (name === 'workspaceRegistry') {
        return { get: id => (id === WS ? { path: workspaceDir } : undefined), archivedSessionIds: [] }
      }
      if (name === 'hostStore') return store
      throw new Error(`cannot get property "${name}" without inject`)
    },
    effect: fn => fn(),
    connection: { fetch: { register: route => { routes.push(route) } } },
  }
  const applied = apply(ctx, {
    hostStore: store,
    distillAnalyzer: {
      probeContextWindow: async () => ({ ok: true, contextWindow: 200000, model: { provider: 'p', model: 'm' } }),
    },
    workspaces: [{ id: WS, path: workspaceDir }],
    distillBackupsRoot: backupsRoot,
  })
  return { workspaceDir, store, routes, lifecycle: applied.distillLifecycle }
}

async function callRoute(routes, name, { method = 'GET', query = '', body } = {}) {
  const route = routes.find(r => r.path === `/api/punch-desk/${name}`)
  assert.ok(route, `route ${name} must be registered`)
  const url = `http://localhost/api/punch-desk/${name}${query}`
  const init = method === 'POST'
    ? { method: 'POST', body: JSON.stringify(body ?? {}), headers: { 'content-type': 'application/json' } }
    : { method: 'GET' }
  const response = await route.fetch(new Request(url, init))
  return { httpStatus: response.status, body: await response.json() }
}

/** Seed a run with a fresh clock (old rows would be TTL-staled by GET). */
async function seedRun(store, { runId = 'run-1', status = 'ready', plan = true } = {}) {
  const now = Date.now()
  const run = createDistillRun({ id: runId, workspaceId: WS, sessions: SESSION_OBJS, now })
  const seeded = { ...run, status, updatedAt: now }
  await store.putDistillRun(seeded)
  if (plan) await store.putDistillPlan(makePlan(runId))
  return seeded
}

/* -------------------------------- park host ------------------------------- */

test('park: ready plan is parked, keeps its plan and releases the submission lock', async (t) => {
  const h = await makeHarness(t)
  const seeded = await seedRun(h.store, { runId: 'run-park' })

  const { httpStatus, body } = await callRoute(h.routes, 'distill-park', {
    method: 'POST',
    body: { runId: 'run-park', parked: true },
  })
  assert.equal(httpStatus, 200)
  assert.equal(body.ok, true)
  assert.equal(body.parked, true)
  assert.equal(body.run.parked, true, 'the wire run carries the parked flag')
  assert.equal(body.run.locked, false, 'a parked run does not hold the maintenance window')
  assert.equal(body.lock.locked, false)
  assert.equal(body.lock.reason, 'parked')

  const persisted = await h.store.getDistillRun('run-park')
  assert.equal(persisted.parked, true)
  assert.equal(persisted.status, 'ready', 'parking never changes the status')
  assert.ok(persisted.updatedAt >= seeded.updatedAt, 'parking refreshes updatedAt')
  assert.ok(await h.store.getDistillPlan('run-park'), 'the plan is preserved for a later write-back')

  const pure = deriveLockWindow(persisted, Date.now())
  assert.deepEqual(pure, { locked: false, reason: 'parked', expiresAt: null })

  const byId = await callRoute(h.routes, 'distill-run', { query: '?id=run-park' })
  assert.equal(byId.body.run.parked, true)
  assert.equal(byId.body.lock.locked, false, 'GET derives the unlocked window for a parked run')
})

test('unpark: clears the flag and restarts the ready TTL (re-locks)', async (t) => {
  const h = await makeHarness(t)
  await seedRun(h.store, { runId: 'run-unpark' })
  await callRoute(h.routes, 'distill-park', { method: 'POST', body: { runId: 'run-unpark', parked: true } })

  const before = Date.now()
  const { httpStatus, body } = await callRoute(h.routes, 'distill-park', {
    method: 'POST',
    body: { runId: 'run-unpark', parked: false },
  })
  const after = Date.now()
  assert.equal(httpStatus, 200)
  assert.equal(body.ok, true)
  assert.equal(body.parked, false)
  assert.equal(body.run.parked, false)
  assert.equal(body.lock.locked, true, 're-entering the confirmation page re-locks the workspace')
  assert.equal(body.lock.reason, 'ready')

  const persisted = await h.store.getDistillRun('run-unpark')
  assert.equal(persisted.parked, false)
  const expiresAt = body.lock.expiresAt
  assert.equal(persisted.lockWindow.expiresAt, expiresAt, 'the new TTL deadline is persisted')
  assert.ok(expiresAt >= before + lockTtlMs && expiresAt <= after + lockTtlMs,
    'the ready TTL restarts from the unpark write')
})

test('park: refuses every non-ready status and unknown ids without writing', async (t) => {
  const h = await makeHarness(t)
  await seedRun(h.store, { runId: 'run-analyzing', status: 'analyzing' })
  const refused = await callRoute(h.routes, 'distill-park', {
    method: 'POST',
    body: { runId: 'run-analyzing', parked: true },
  })
  assert.equal(refused.httpStatus, 200, 'business refusals keep HTTP 200')
  assert.equal(refused.body.ok, false)
  assert.equal(refused.body.error.code, 'PARK_NOT_ALLOWED')
  assert.equal(refused.body.code, 'PARK_NOT_ALLOWED')
  assert.equal((await h.store.getDistillRun('run-analyzing')).parked, undefined,
    'the refused run is untouched')

  const missing = await callRoute(h.routes, 'distill-park', { method: 'POST', body: { runId: 'nope', parked: true } })
  assert.equal(missing.body.error.code, 'RUN_NOT_FOUND')
})

test('park: a parked plan can still be applied (it is not terminal)', async (t) => {
  const h = await makeHarness(t)
  await seedRun(h.store, { runId: 'run-park-apply' })
  await callRoute(h.routes, 'distill-park', { method: 'POST', body: { runId: 'run-park-apply', parked: true } })

  const applied = await callRoute(h.routes, 'distill-apply', {
    method: 'POST',
    body: { runId: 'run-park-apply', selectedChangeIds: ['c1'] },
  })
  assert.equal(applied.httpStatus, 200)
  assert.equal(applied.body.ok, true, JSON.stringify(applied.body))
  assert.equal(applied.body.runStatus, 'applied')
  assert.match(fs.readFileSync(path.join(h.workspaceDir, GUIDE), 'utf8'), /- route rule/,
    'applying a parked plan still writes the change back')
})

/* ------------------------------ abandon host ------------------------------ */

test('abandon: deletes run + plan, releases the lock and keeps fingerprints', async (t) => {
  const h = await makeHarness(t)
  await seedRun(h.store, { runId: 'run-abandon' })
  await h.store.putDistillFingerprints(WS, [{
    id: 'fp-1',
    workspaceId: WS,
    targetFile: GUIDE,
    changeKind: 'append-section',
    normalizedHash: 'h'.repeat(64),
    runId: 'run-abandon',
    appliedAt: Date.now() - 1000,
    appliedFileHash: 'a'.repeat(64),
  }])

  const { httpStatus, body } = await callRoute(h.routes, 'distill-abandon', {
    method: 'POST',
    body: { runId: 'run-abandon' },
  })
  assert.equal(httpStatus, 200)
  assert.equal(body.ok, true)
  assert.equal(body.deleted, true)
  assert.equal(body.deletedPlan, true)
  assert.equal(body.lock.locked, false, 'removing the non-terminal run frees the window')
  assert.equal(await h.store.getDistillRun('run-abandon'), null)
  assert.equal(await h.store.getDistillPlan('run-abandon'), null)

  const fingerprints = await h.store.listDistillFingerprints(WS)
  assert.equal(fingerprints.length, 1, 'idempotency fingerprints survive an abandon')
  assert.equal(fingerprints[0].id, 'fp-1')

  const listed = await callRoute(h.routes, 'distill-run', { query: `?workspaceId=${WS}` })
  assert.equal(listed.body.ok, true)
  assert.deepEqual(listed.body.runs, [], 'the workspace slot is free again')
})

test('abandon: applying / applied are refused; unknown ids report RUN_NOT_FOUND', async (t) => {
  const h = await makeHarness(t)
  for (const status of ['applying', 'applied']) {
    await seedRun(h.store, { runId: `run-${status}`, status })
    const refused = await callRoute(h.routes, 'distill-abandon', {
      method: 'POST',
      body: { runId: `run-${status}` },
    })
    assert.equal(refused.httpStatus, 200, 'business refusals keep HTTP 200')
    assert.equal(refused.body.ok, false)
    assert.equal(refused.body.error.code, 'ABANDON_NOT_ALLOWED', `${status} cannot be abandoned`)
    assert.equal(refused.body.code, 'ABANDON_NOT_ALLOWED')
    assert.ok(await h.store.getDistillRun(`run-${status}`), `${status} run is untouched`)
    assert.ok(await h.store.getDistillPlan(`run-${status}`), `${status} plan is untouched`)
  }
  const missing = await callRoute(h.routes, 'distill-abandon', { method: 'POST', body: { runId: 'nope' } })
  assert.equal(missing.body.error.code, 'RUN_NOT_FOUND')
})

/* -------------------------------- GET parked ------------------------------ */

test('GET distill-run: list and id always carry parked (false by default)', async (t) => {
  const h = await makeHarness(t)
  await seedRun(h.store, { runId: 'run-listed' })

  const unparked = await callRoute(h.routes, 'distill-run', { query: `?workspaceId=${WS}` })
  assert.equal(unparked.body.runs[0].parked, false, 'a legacy/ready run reports parked:false')
  const idUnparked = await callRoute(h.routes, 'distill-run', { query: '?id=run-listed' })
  assert.equal(idUnparked.body.run.parked, false)

  await callRoute(h.routes, 'distill-park', { method: 'POST', body: { runId: 'run-listed', parked: true } })
  const parked = await callRoute(h.routes, 'distill-run', { query: `?workspaceId=${WS}` })
  assert.equal(parked.body.runs[0].parked, true)
  assert.equal(parked.body.runs[0].lock.reason, 'parked')
  const idParked = await callRoute(h.routes, 'distill-run', { query: '?id=run-listed' })
  assert.equal(idParked.body.run.parked, true)
})

/* --------------------------------- view ----------------------------------- */

const ZH = dictionaries().zh
const t = (key) => ZH[key] ?? key

const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) })

function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return (node.children ?? []).map(textOf).join(' ')
}

function findNode(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findNode(child, predicate)
      if (found) return found
    }
    return undefined
  }
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    const found = findNode(child, predicate)
    if (found) return found
  }
  return undefined
}

const findButtonByText = (tree, fragment) => findNode(
  tree,
  (node) => node.type === 'button' && textOf(node).includes(fragment),
)

function createHookRuntime() {
  const states = new Map()
  const refs = new Map()
  const effects = []
  let hookCursor = 0
  let effectCursor = 0
  const sameDeps = (left, right) => {
    if (left === undefined || right === undefined) return false
    if (left.length !== right.length) return false
    return left.every((value, index) => Object.is(value, right[index]))
  }
  const React = {
    useState(initial) {
      const index = hookCursor++
      if (!states.has(index)) states.set(index, typeof initial === 'function' ? initial() : initial)
      const set = (value) => states.set(index, typeof value === 'function' ? value(states.get(index)) : value)
      return [states.get(index), set]
    },
    useRef(initial) {
      const index = hookCursor++
      if (!refs.has(index)) refs.set(index, { current: initial })
      return refs.get(index)
    },
    useCallback(fn) { return fn },
    useMemo(fn, deps) {
      const index = hookCursor++
      const previous = states.get(index)
      if (!previous || !sameDeps(previous.deps, deps)) {
        const value = fn()
        states.set(index, { deps, value })
        return value
      }
      return previous.value
    },
    useEffect(fn, deps) {
      const index = effectCursor++
      const previous = effects[index]
      if (!previous || !sameDeps(previous.deps, deps)) {
        effects[index] = { deps, fn, cleanup: previous?.cleanup ?? null, pending: true }
      } else if (previous.pending) {
        previous.fn = fn
      }
    },
  }
  function expandVNode(node) {
    if (!node || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map(expandVNode)
    if (typeof node.type === 'function') {
      const props = { ...(node.props || {}) }
      if (node.children?.length) props.children = node.children.length === 1 ? node.children[0] : node.children
      return expandVNode(node.type(props))
    }
    return { ...node, children: (node.children || []).map(expandVNode) }
  }
  return {
    React,
    effects,
    render(Component, props) {
      hookCursor = 0
      effectCursor = 0
      return expandVNode(Component(props))
    },
    async flushEffects() {
      for (const item of effects) {
        if (item?.pending) {
          item.pending = false
          if (typeof item.cleanup === 'function') item.cleanup()
          item.cleanup = await item.fn()
        }
      }
    },
    cleanupAll() {
      for (const item of effects) {
        if (typeof item?.cleanup === 'function') {
          item.cleanup()
          item.cleanup = null
        }
      }
    },
  }
}

const jsonResponse = (payload, ok = true) => ({ ok, json: async () => payload })
const tick = () => new Promise((resolve) => setImmediate(resolve))

function stubFetch(handler) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    const call = {
      url: String(url),
      method: options.method || 'GET',
      body: typeof options.body === 'string' ? JSON.parse(options.body) : (options.body ?? null),
    }
    calls.push(call)
    return handler(call)
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

const SOURCE = {
  sessions: [
    { sessionId: 's-1', title: 'Refactor store', updatedAt: T0 },
    { sessionId: 's-2', title: 'Fix queue bug', updatedAt: T0 },
    { sessionId: 's-3', title: 'Write docs', updatedAt: T0 },
  ],
  findings: [],
  promptLogs: [],
  archivedSessionIds: [],
}

const PARKED_RUN = {
  id: 'run-parked',
  workspaceId: 'ws-1',
  status: 'ready',
  parked: true,
  sessions: [{ sessionId: 's-1' }, { sessionId: 's-2' }, { sessionId: 's-3' }],
  plan: { runId: 'run-parked', summary: 'plan summary', targets: [], conflicts: [], checks: [] },
}

const READY_RUN = { ...PARKED_RUN, id: 'run-ready', parked: false }

function makeMockConfirm(calls) {
  return function MockConfirm(props) {
    calls.push(props)
    return h('div', { 'data-mock-confirm': true }, 'MOCK-CONFIRM')
  }
}

async function mount({ runs = [], confirm = makeMockConfirm, handler } = {}) {
  const confirmCalls = []
  const fetchStub = stubFetch(handler || ((call) => {
    if (call.method === 'GET' && call.url.includes('distill-run')) return jsonResponse({ ok: true, runs })
    return jsonResponse({ ok: true })
  }))
  const runtime = createHookRuntime()
  const DistillView = createDistillView({
    h,
    React: runtime.React,
    services: { loadDistillSource: () => SOURCE },
    t,
    createConfirmComponent: () => confirm(confirmCalls),
  })
  const props = { workspaceId: 'ws-1' }
  let tree = runtime.render(DistillView, props)
  await runtime.flushEffects()
  await tick()
  tree = runtime.render(DistillView, props)
  return {
    runtime,
    props,
    fetchStub,
    confirmCalls,
    get tree() { return tree },
    render() {
      tree = runtime.render(DistillView, props)
      return tree
    },
    dispose() {
      runtime.cleanupAll()
      fetchStub.restore()
    },
  }
}

test('history: a parked row shows 已暂存 and 回到确认 re-locks it before opening pending', async () => {
  const view = await mount({
    runs: [PARKED_RUN],
    handler: (call) => {
      if (call.method === 'GET' && call.url.includes('distill-run')) {
        return jsonResponse({ ok: true, runs: [PARKED_RUN] })
      }
      if (call.url.includes('distill-park')) {
        return jsonResponse({
          ok: true,
          parked: false,
          run: { ...PARKED_RUN, parked: false, locked: true },
          lock: { locked: true, reason: 'ready', expiresAt: Date.now() + lockTtlMs },
        })
      }
      return jsonResponse({ ok: true })
    },
  })
  try {
    // A parked run never auto-opens the confirmation page.
    assert.equal(findNode(view.tree, (node) => node.props?.['data-mock-confirm']), undefined,
      'mounting on a parked run keeps the config page')
    const historyButton = findButtonByText(view.tree, t('distill.view.history.heading'))
    assert.ok(historyButton, 'the config header opens the history')
    historyButton.props.onClick()
    let tree = view.render()

    const parkedText = textOf(tree)
    assert.ok(parkedText.includes(t('distill.view.run.status.parked')), 'the badge says 已暂存')
    assert.ok(parkedText.includes(t('distill.view.run.status.ready')) === false,
      'the parked badge does not also print the raw ready label')
    const openConfirm = findButtonByText(tree, t('distill.view.history.openConfirm'))
    assert.ok(openConfirm, 'a parked row offers 回到确认')
    assert.equal(openConfirm.props.disabled, false, 'the parked row action is enabled')

    const deleteButton = findNode(tree, (node) => node.type === 'button'
      && node.props?.title === t('distill.view.history.delete'))
    assert.ok(deleteButton, 'a parked row still offers deletion')
    assert.equal(deleteButton.props.disabled, false, 'parked rows are deletable (abandon)')

    openConfirm.props.onClick()
    await tick()
    await tick()
    tree = view.render()
    const post = view.fetchStub.calls.find((call) => call.url.includes('distill-park'))
    assert.ok(post, '回到确认 posts to distill-park')
    assert.deepEqual(post.body, { runId: 'run-parked', parked: false }, 'it un-parks (re-locks) the run')
    assert.ok(findNode(tree, (node) => node.props?.['data-mock-confirm']),
      'the confirmation page opens after the unpark succeeds')
    assert.equal(view.confirmCalls[view.confirmCalls.length - 1].run.parked, false,
      'the confirmation page receives the re-locked run')
  } finally {
    view.dispose()
  }
})

test('pending: 暂存 parks the ready run, returns home and disables both actions while in flight', async () => {
  let release = null
  const gate = new Promise((resolve) => { release = resolve })
  const view = await mount({
    runs: [READY_RUN],
    handler: async (call) => {
      if (call.method === 'GET' && call.url.includes('distill-run')) {
        return jsonResponse({ ok: true, runs: [READY_RUN] })
      }
      if (call.url.includes('distill-park')) {
        await gate
        return jsonResponse({
          ok: true,
          parked: true,
          run: { ...READY_RUN, parked: true, locked: false },
          lock: { locked: false, reason: 'parked', expiresAt: null },
        })
      }
      return jsonResponse({ ok: true })
    },
  })
  try {
    assert.ok(findNode(view.tree, (node) => node.props?.['data-mock-confirm']),
      'the ready run opens the confirmation page')
    assert.ok(findNode(view.tree, (node) => node.props?.['data-distill-pending-actions']),
      'the secondary actions row renders below the confirmation page')

    const parkButton = findButtonByText(view.tree, t('distill.view.pending.park'))
    const abandonButton = findButtonByText(view.tree, t('distill.view.pending.abandon'))
    assert.ok(parkButton && abandonButton)

    const inFlight = parkButton.props.onClick()
    await tick()
    const busyTree = view.render()
    assert.equal(findButtonByText(busyTree, t('distill.view.pending.park')).props.disabled, true,
      'parking disables the park button')
    assert.equal(findButtonByText(busyTree, t('distill.view.pending.abandon')).props.disabled, true,
      'parking also disables abandon (no double post)')

    release()
    await inFlight
    await tick()
    const tree = view.render()
    const post = view.fetchStub.calls.find((call) => call.url.includes('distill-park'))
    assert.deepEqual(post.body, { runId: 'run-ready', parked: true })
    const text = textOf(tree)
    assert.ok(text.includes(t('distill.view.pending.parkedNote')), 'the config page states 已暂存')
    assert.equal(findNode(tree, (node) => node.props?.['data-mock-confirm']), undefined,
      'parking leaves the confirmation page for the config home page')
  } finally {
    view.dispose()
  }
})

test('pending: 放弃本次精炼 needs its two-step confirmation, then deletes the run and returns home', async () => {
  // The explicit refresh after abandon must see the deleted row, exactly like
  // the real Host (otherwise the poll would legitimately reopen a ready run).
  let deleted = false
  const view = await mount({
    runs: [READY_RUN],
    handler: (call) => {
      if (call.method === 'GET' && call.url.includes('distill-run')) {
        return jsonResponse({ ok: true, runs: deleted ? [] : [READY_RUN] })
      }
      if (call.url.includes('distill-abandon')) {
        deleted = true
        return jsonResponse({ ok: true, deleted: true })
      }
      return jsonResponse({ ok: true })
    },
  })
  try {
    const abandonButton = findButtonByText(view.tree, t('distill.view.pending.abandon'))
    abandonButton.props.onClick()
    let tree = view.render()
    assert.ok(textOf(tree).includes(t('distill.view.pending.abandonConfirm')),
      'the first click only reveals the confirmation copy')
    assert.equal(view.fetchStub.calls.filter((call) => call.url.includes('distill-abandon')).length, 0,
      'the first click never posts')
    assert.ok(findButtonByText(tree, t('distill.view.pending.abandonYes')))
    assert.ok(findButtonByText(tree, t('distill.view.pending.abandonNo')))

    findButtonByText(tree, t('distill.view.pending.abandonNo')).props.onClick()
    tree = view.render()
    assert.ok(textOf(tree).includes(t('distill.view.pending.abandon')),
      '取消 keeps the plan (confirmation collapses)')

    findButtonByText(tree, t('distill.view.pending.abandon')).props.onClick()
    tree = view.render()
    const yes = findButtonByText(tree, t('distill.view.pending.abandonYes'))
    await yes.props.onClick()
    await tick()
    await tick()
    tree = view.render()
    const post = view.fetchStub.calls.find((call) => call.url.includes('distill-abandon'))
    assert.ok(post, '确认放弃 posts to distill-abandon')
    assert.deepEqual(post.body, { runId: 'run-ready' })
    assert.equal(findNode(tree, (node) => node.props?.['data-mock-confirm']), undefined,
      'abandoning returns to the config home page')
    assert.equal(view.confirmCalls.length > 0, true)
    assert.equal(view.confirmCalls.filter((call) => call.run.parked === true).length, 0,
      'the abandoned plan is never parked as a side effect')
  } finally {
    view.dispose()
  }
})
