import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  DISTILL_VIEW_POLL_MS,
  createDistillView,
  deriveDistillCandidates,
  formatRelativeTime,
} from '../src/client/ui/distill-view.js'
import { createDeskPage } from '../src/client/ui/desk.js'
import { DRAFTS_WORKSPACE_KEY } from '../src/domain/desk.js'
import { createWorkspaceRecord } from '../src/domain/workspace.js'
import { dictionaries } from '../src/locale.js'
import {
  createHookRuntime as createDeskHookRuntime,
  findNode as findDeskNode,
  textOf as deskTextOf,
} from './helpers/desk-harness.js'

const t = (key) => key

const h = (type, props, ...children) => ({
  type,
  props: props ?? {},
  children: children.flat(Infinity),
})

function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return (node.children ?? []).map(textOf).join(' ')
}

function collectNodes(node, out = []) {
  if (!node || typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children ?? []) collectNodes(child, out)
  return out
}

function findButtonByText(tree, fragment) {
  return collectNodes(tree).find(
    (node) => node.type === 'button' && textOf(node).includes(fragment),
  )
}

function findCheckboxFor(tree, sessionId) {
  const row = collectNodes(tree).find(
    (node) => node.type === 'label' && node.props?.key === sessionId,
  )
  if (!row) return null
  return collectNodes(row).find(
    (node) => node.type === 'input' && node.props?.type === 'checkbox',
  )
}

/**
 * Minimal hook runtime (same shape as tests/session-pane-edit.test.js):
 * index-based state/ref slots, memoized deps, and effect registration with
 * explicit flush + cleanup so intervals/aborts never leak between tests.
 */
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
    useCallback(fn) {
      return fn
    },
    useMemo(fn, deps) {
      const index = hookCursor++
      const prev = states.get(index)
      if (!prev || !sameDeps(prev.deps, deps)) {
        const val = fn()
        states.set(index, { deps, val })
        return val
      }
      return prev.val
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
      const p = { ...(node.props || {}) }
      if (node.children?.length) p.children = node.children.length === 1 ? node.children[0] : node.children
      return expandVNode(node.type(p))
    }
    return {
      ...node,
      children: (node.children || []).map(expandVNode),
    }
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
        if (item.pending) {
          item.pending = false
          if (typeof item.cleanup === 'function') item.cleanup()
          item.cleanup = await item.fn()
        }
      }
    },
    cleanupAll() {
      for (const item of effects) {
        if (typeof item.cleanup === 'function') {
          item.cleanup()
          item.cleanup = null
        }
      }
    },
  }
}

/** globalThis.fetch stub in the shape of tests/distill-lock.test.js. */
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

const jsonResponse = (payload, ok = true) => ({ ok, json: async () => payload })

const tick = () => new Promise((resolve) => setImmediate(resolve))

const SOURCE = {
  sessions: [
    { sessionId: 's-1', title: 'Refactor store', updatedAt: 3000 },
    { sessionId: 's-2', title: 'Fix queue bug', updatedAt: 2000 },
    { sessionId: 's-3', title: 'Write docs', updatedAt: 1000 },
    { sessionId: 's-4', title: 'Archived work', updatedAt: 500 },
  ],
  findings: [
    { sessionId: 's-1', updatedAt: 2500 },
    { sessionId: 's-1', updatedAt: 2600 },
    { sessionId: 's-3', updatedAt: 900 },
  ],
  promptLogs: [{ sessionId: 's-1', updatedAt: 2400 }],
  archivedSessionIds: ['s-4'],
}

// ---------------------------------------------------------------- candidates

test('deriveDistillCandidates: deduplicates the union of sessions, findings and prompt logs', () => {
  const candidates = deriveDistillCandidates({
    sessions: [
      { sessionId: 's-1', title: 'Alpha' },
      { sessionId: 's-2', title: 'Beta' },
    ],
    findings: [
      { sessionId: 's-1' },
      { sessionId: 's-1' },
      { sessionId: 's-3' },
    ],
    promptLogs: [{ sessionId: 's-3' }, { sessionId: 's-4' }],
    archivedSessionIds: [],
  })

  assert.deepEqual(candidates.map((c) => c.sessionId), ['s-1', 's-2', 's-3', 's-4'],
    'sessions first, then findings/promptLogs-only sessions, deduped by sessionId')
  const s1 = candidates.find((c) => c.sessionId === 's-1')
  assert.equal(s1.title, 'Alpha', 'title comes from the sessions entry')
  assert.equal(s1.hasFindings, true)
  assert.equal(s1.findingCount, 2)
  assert.equal(s1.hasPromptLog, false)
  assert.equal(s1.promptLogCount, 0, 'no prompt-log rows means a zero material count')
  const s2 = candidates.find((c) => c.sessionId === 's-2')
  assert.equal(s2.hasFindings, false, 'a visible session without material is still a candidate')
  assert.equal(s2.findingCount, 0)
  const s3 = candidates.find((c) => c.sessionId === 's-3')
  assert.equal(s3.hasFindings, true)
  assert.equal(s3.hasPromptLog, true)
  assert.equal(s3.promptLogCount, 1, 'prompt-log rows are counted for the material readout')
  const s4 = candidates.find((c) => c.sessionId === 's-4')
  assert.equal(s4.hasPromptLog, true)
  assert.equal(s4.promptLogCount, 1)
  assert.equal(s4.title, '', 'no title is fabricated for material-only sessions')
})

test('deriveDistillCandidates: marks archived sessions and merges the latest updatedAt', () => {
  const withSet = deriveDistillCandidates({
    sessions: [
      { sessionId: 's-1', title: 'One', updatedAt: 100 },
      { sessionId: 's-2', title: 'Two', updatedAt: 500 },
    ],
    findings: [{ sessionId: 's-1', updatedAt: 800 }, { sessionId: 's-9', updatedAt: 50 }],
    promptLogs: [],
    archivedSessionIds: new Set(['s-2', 's-9']),
  })

  assert.equal(withSet.find((c) => c.sessionId === 's-2').archived, true,
    'archived flag is derived from a Set of archived ids')
  assert.equal(withSet.find((c) => c.sessionId === 's-9').archived, true,
    'material-only sessions can be archived too')
  assert.equal(withSet.find((c) => c.sessionId === 's-1').archived, false)
  assert.equal(withSet.find((c) => c.sessionId === 's-1').updatedAt, 800,
    'updatedAt is the max across sessions and findings')
  assert.equal(withSet.find((c) => c.sessionId === 's-2').updatedAt, 500)

  const withArray = deriveDistillCandidates({
    sessions: [{ sessionId: 's-1', title: 'One' }],
    findings: [],
    promptLogs: [],
    archivedSessionIds: ['s-1'],
  })
  assert.equal(withArray[0].archived, true, 'an array of archived ids is accepted as well')
})

test('deriveDistillCandidates: empty and missing inputs yield an empty list', () => {
  assert.deepEqual(deriveDistillCandidates(), [])
  assert.deepEqual(deriveDistillCandidates({}), [])
  assert.deepEqual(deriveDistillCandidates({
    sessions: [], findings: [], promptLogs: [], archivedSessionIds: new Set(),
  }), [])
  assert.deepEqual(deriveDistillCandidates({
    sessions: [null, { title: 'no id' }, {}],
    findings: [null, {}],
    promptLogs: [null, {}],
    archivedSessionIds: null,
  }), [], 'malformed rows are skipped defensively')
})

// ---------------------------------------------------------------- component

test('DistillView: initial render lands in config with candidates and a disabled start button', async () => {
  const fetchStub = stubFetch(() => jsonResponse({ ok: true, runs: [] }))
  const runtime = createHookRuntime()
  const DistillView = createDistillView({
    h,
    React: runtime.React,
    services: { loadDistillSource: () => SOURCE },
    t,
  })
  try {
    let tree = runtime.render(DistillView, { workspaceId: 'ws-1' })
    await runtime.flushEffects()
    await tick()
    tree = runtime.render(DistillView, { workspaceId: 'ws-1' })

    const text = textOf(tree)
    assert.ok(text.includes(t('distill.view.title')), 'title key renders')
    assert.ok(text.includes(t('distill.view.subtitle')),
      'the scope subtitle states that only this workspace is listed')
    assert.ok(text.includes(t('distill.view.config.listTitle')), 'session list caption renders')
    assert.ok(text.includes('Refactor store'), 'session titles render from the source')
    assert.ok(text.includes(t('distill.view.config.selectedCount')),
      'the live selection summary renders')
    assert.ok(collectNodes(tree).some((node) => node.props?.tip === t('distill.view.config.materialTip')),
      'the material readout carries the information tooltip')
    assert.ok(text.includes(`2 ${t('distill.view.config.findingsUnit')}`),
      'finding counts render on the candidate row')
    assert.ok(text.includes(`1 ${t('distill.view.config.promptLogsUnit')}`),
      'prompt-log counts render on the candidate row')
    assert.ok(text.includes(t('distill.view.config.noMaterial')),
      'sessions without material render the explicit empty-material label')

    const start = findButtonByText(tree, t('distill.view.config.start'))
    assert.ok(start, 'start button renders')
    assert.equal(start.props.disabled, true, 'start is disabled below the 3-session minimum')
    assert.equal(start.props.tip, t('distill.view.config.startNeedSessions'),
      'the disabled start button explains the 3-session minimum')

    // The primary action lives in the header (top-right), not at the bottom of
    // the batch body: the header is the first child of the container.
    const header = tree.children[0]
    assert.ok(findButtonByText(header, t('distill.view.config.start')),
      'the start button sits in the header actions row')
    assert.ok(findButtonByText(tree.children[1], t('distill.view.config.start')) === undefined,
      'the config body no longer repeats the start button at its bottom')

    assert.ok(fetchStub.calls.some((call) => call.method === 'GET'
      && call.url.includes('distill-run?workspaceId=ws-1')),
    'mount-time GET doubles as refresh recovery')
  } finally {
    runtime.cleanupAll()
    fetchStub.restore()
  }
})

test('DistillView: config peer panels fold from the whole panel head', async () => {
  const fetchStub = stubFetch(() => jsonResponse({ ok: true, runs: [] }))
  const runtime = createHookRuntime()
  const DistillView = createDistillView({
    h,
    React: runtime.React,
    services: { loadDistillSource: () => SOURCE },
    t,
  })
  try {
    let tree = runtime.render(DistillView, { workspaceId: 'ws-1' })
    await runtime.flushEffects()
    await tick()
    const render = () => runtime.render(DistillView, { workspaceId: 'ws-1' })
    const section = key => collectNodes(tree).find(
      (node) => node.props?.['data-distill-section'] === key,
    )

    tree = render()
    assert.ok(section('sessions'), 'the candidate panel head renders as a fold control')
    assert.equal(typeof section('sessions').props.onClick, 'function',
      'the whole candidate panel head toggles the panel')
    assert.ok(textOf(tree).includes('Refactor store'), 'candidate cards start visible')

    section('sessions').props.onClick({})
    tree = render()
    assert.equal(textOf(tree).includes('Refactor store'), false,
      'clicking the candidate title folds the candidate list')

    // The archived toggle inside the head keeps its own click.
    section('sessions').props.onClick({ target: { closest: () => ({ tagName: 'BUTTON' }) } })
    tree = render()
    assert.equal(textOf(tree).includes('Refactor store'), false,
      'inner controls keep their own click and never toggle the panel')

    section('sessions').props.onClick({})
    tree = render()
    assert.ok(textOf(tree).includes('Refactor store'),
      'clicking the title again expands the candidate list')

    // The overview peer panel uses the same whole-head fold behavior.
    assert.ok(textOf(tree).includes(t('distill.overview.totalsEmpty')), 'overview body starts visible')
    section('overview').props.onClick({})
    tree = render()
    assert.equal(textOf(tree).includes(t('distill.overview.totalsEmpty')), false,
      'clicking the overview title folds its body')
  } finally {
    runtime.cleanupAll()
    fetchStub.restore()
  }
})

test('DistillView: history section folds from the whole caption row', async () => {
  const applied = { id: 'run-done', workspaceId: 'ws-1', status: 'applied' }
  const fetchStub = stubFetch(() => jsonResponse({ ok: true, runs: [applied] }))
  const runtime = createHookRuntime()
  const DistillView = createDistillView({
    h,
    React: runtime.React,
    services: { loadDistillSource: () => SOURCE },
    t,
  })
  try {
    let tree = runtime.render(DistillView, { workspaceId: 'ws-1' })
    await runtime.flushEffects()
    await tick()
    tree = runtime.render(DistillView, { workspaceId: 'ws-1' })
    findButtonByText(tree, t('distill.view.history.heading')).props.onClick()

    const render = () => runtime.render(DistillView, { workspaceId: 'ws-1' })
    const section = () => collectNodes(tree).find(
      (node) => node.props?.['data-distill-section'] === 'history',
    )
    tree = render()
    assert.ok(section(), 'the history caption row renders as a fold control')
    assert.ok(textOf(tree).includes(t('distill.view.run.status.applied')),
      'past run rows start visible')

    section().props.onClick({})
    tree = render()
    assert.equal(textOf(tree).includes(t('distill.view.run.status.applied')), false,
      'clicking the history caption folds the run list')

    section().props.onClick({})
    tree = render()
    assert.ok(textOf(tree).includes(t('distill.view.run.status.applied')),
      'clicking the caption again expands the run list')
  } finally {
    runtime.cleanupAll()
    fetchStub.restore()
  }
})

test('DistillView: start stays disabled below 3 selections and unlocks at 3', async () => {
  const fetchStub = stubFetch(() => jsonResponse({ ok: true, runs: [] }))
  const runtime = createHookRuntime()
  const DistillView = createDistillView({
    h,
    React: runtime.React,
    services: { loadDistillSource: () => SOURCE },
    t,
  })
  try {
    await runtime.flushEffects() // no-op render pass to settle the harness
    let tree = runtime.render(DistillView, { workspaceId: 'ws-1' })
    await runtime.flushEffects()
    await tick()
    tree = runtime.render(DistillView, { workspaceId: 'ws-1' })

    const toggle = (sessionId) => {
      const box = findCheckboxFor(tree, sessionId)
      assert.ok(box, `checkbox for ${sessionId} renders`)
      box.props.onChange()
    }

    toggle('s-1')
    tree = runtime.render(DistillView, { workspaceId: 'ws-1' })
    toggle('s-2')
    tree = runtime.render(DistillView, { workspaceId: 'ws-1' })
    const blocked = findButtonByText(tree, t('distill.view.config.start'))
    assert.equal(blocked.props.disabled, true, '2 selected sessions keep the start disabled')
    assert.equal(blocked.props.tip, t('distill.view.config.startNeedSessions'),
      'the primary action explains the 3-session minimum')

    toggle('s-3')
    tree = runtime.render(DistillView, { workspaceId: 'ws-1' })
    const start = findButtonByText(tree, t('distill.view.config.start'))
    assert.equal(start.props.disabled, false, '3 selected sessions enable the start')
    assert.equal(start.props.tip, t('distill.view.config.startHint'),
      'the enabled action advertises what it will do')
    assert.ok(textOf(tree).includes(t('distill.view.config.summaryFindings')),
      'the selection summary reflects the selected findings')
  } finally {
    runtime.cleanupAll()
    fetchStub.restore()
  }
})

test('DistillView: starting a batch POSTs distill-run and enters running', async () => {
  const run = {
    id: 'run-new',
    workspaceId: 'ws-1',
    status: 'queued',
    progress: { stage: 'snapshotting', completed: 0, total: 3 },
  }
  const fetchStub = stubFetch((call) => {
    if (call.method === 'POST' && call.url.includes('distill-run')) {
      return jsonResponse({ ok: true, run })
    }
    return jsonResponse({ ok: true, runs: [] })
  })
  const runtime = createHookRuntime()
  const DistillView = createDistillView({
    h,
    React: runtime.React,
    services: { loadDistillSource: () => SOURCE },
    t,
  })
  try {
    let tree = runtime.render(DistillView, { workspaceId: 'ws-1' })
    await runtime.flushEffects()
    await tick()
    tree = runtime.render(DistillView, { workspaceId: 'ws-1' })

    for (const sessionId of ['s-1', 's-2', 's-3']) {
      findCheckboxFor(tree, sessionId).props.onChange()
      tree = runtime.render(DistillView, { workspaceId: 'ws-1' })
    }

    const start = findButtonByText(tree, t('distill.view.config.start'))
    await start.props.onClick()

    const post = fetchStub.calls.find((call) => call.method === 'POST' && call.url.includes('distill-run'))
    assert.ok(post, 'distill-run POST is issued')
    assert.equal(post.url, 'api/punch-desk/distill-run')
    assert.deepEqual(post.body, { workspaceId: 'ws-1', sessions: ['s-1', 's-2', 's-3'] })

    tree = runtime.render(DistillView, { workspaceId: 'ws-1' })
    const text = textOf(tree)
    assert.ok(text.includes(t('distill.view.running.heading')), 'running heading renders')
    assert.ok(text.includes(t('distill.view.stage.snapshotting')), 'stage label renders')
    assert.ok(text.includes('0/3'), 'progress completed/total renders')
    assert.ok(findButtonByText(tree, t('distill.view.running.cancel')), 'cancel button renders')
  } finally {
    runtime.cleanupAll()
    fetchStub.restore()
  }
})

test('DistillView: a 409 RUN_ALREADY_ACTIVE start response shows the error state and stays in config', async () => {
  const fetchStub = stubFetch((call) => {
    if (call.method === 'POST' && call.url.includes('distill-run')) {
      return jsonResponse({
        ok: false,
        status: 409,
        code: 'RUN_ALREADY_ACTIVE',
        error: 'workspace already has a non-terminal distillation run',
      }, false)
    }
    return jsonResponse({ ok: true, runs: [] })
  })
  const runtime = createHookRuntime()
  const DistillView = createDistillView({
    h,
    React: runtime.React,
    services: { loadDistillSource: () => SOURCE },
    t,
  })
  try {
    let tree = runtime.render(DistillView, { workspaceId: 'ws-1' })
    await runtime.flushEffects()
    await tick()
    tree = runtime.render(DistillView, { workspaceId: 'ws-1' })
    for (const sessionId of ['s-1', 's-2', 's-3']) {
      findCheckboxFor(tree, sessionId).props.onChange()
      tree = runtime.render(DistillView, { workspaceId: 'ws-1' })
    }
    await findButtonByText(tree, t('distill.view.config.start')).props.onClick()

    tree = runtime.render(DistillView, { workspaceId: 'ws-1' })
    const alert = collectNodes(tree).find((node) => node.props?.role === 'alert')
    assert.ok(alert, 'error banner renders')
    const text = textOf(alert)
    assert.ok(text.includes(t('distill.view.error.code.RUN_ALREADY_ACTIVE')),
      'mapped error code key renders')
    assert.ok(text.includes('non-terminal distillation run'), 'host error message is surfaced')

    const text2 = textOf(tree)
    assert.ok(text2.includes(t('distill.view.config.listTitle')), 'view stays in config after the error')
    assert.ok(findButtonByText(tree, t('distill.view.config.start')), 'start button stays available')
  } finally {
    runtime.cleanupAll()
    fetchStub.restore()
  }
})

test('DistillView: a CONTEXT_WINDOW_UNAVAILABLE start response shows its own error key', async () => {
  const fetchStub = stubFetch((call) => {
    if (call.method === 'POST' && call.url.includes('distill-run')) {
      return jsonResponse({
        ok: false,
        status: 503,
        code: 'CONTEXT_WINDOW_UNAVAILABLE',
        error: 'no context window',
      }, false)
    }
    return jsonResponse({ ok: true, runs: [] })
  })
  const runtime = createHookRuntime()
  const DistillView = createDistillView({
    h,
    React: runtime.React,
    services: { loadDistillSource: () => SOURCE },
    t,
  })
  try {
    let tree = runtime.render(DistillView, { workspaceId: 'ws-1' })
    await runtime.flushEffects()
    await tick()
    tree = runtime.render(DistillView, { workspaceId: 'ws-1' })
    for (const sessionId of ['s-1', 's-2', 's-3']) {
      findCheckboxFor(tree, sessionId).props.onChange()
      tree = runtime.render(DistillView, { workspaceId: 'ws-1' })
    }
    await findButtonByText(tree, t('distill.view.config.start')).props.onClick()

    tree = runtime.render(DistillView, { workspaceId: 'ws-1' })
    const alert = collectNodes(tree).find((node) => node.props?.role === 'alert')
    assert.ok(alert, 'error banner renders')
    assert.ok(textOf(alert).includes(t('distill.view.error.code.CONTEXT_WINDOW_UNAVAILABLE')),
      'CONTEXT_WINDOW_UNAVAILABLE gets its dedicated key')
  } finally {
    runtime.cleanupAll()
    fetchStub.restore()
  }
})

test('DistillView: an unmapped Host start error surfaces the host message instead of claiming an active run', async () => {
  // Regression: the start-error fallback used to be RUN_ALREADY_ACTIVE, so a
  // wiring/analyzer failure was reported as「本工作区已有进行中的精炼任务」even
  // though no run existed.
  const fetchStub = stubFetch((call) => {
    if (call.method === 'POST' && call.url.includes('distill-run')) {
      return jsonResponse({
        ok: false,
        code: 'ANALYZER_UNAVAILABLE',
        error: 'distill analyzer is not wired into this Host entry',
      }, false)
    }
    return jsonResponse({ ok: true, runs: [] })
  })
  const runtime = createHookRuntime()
  const DistillView = createDistillView({
    h,
    React: runtime.React,
    services: { loadDistillSource: () => SOURCE },
    t,
  })
  try {
    let tree = runtime.render(DistillView, { workspaceId: 'ws-1' })
    await runtime.flushEffects()
    await tick()
    tree = runtime.render(DistillView, { workspaceId: 'ws-1' })
    for (const sessionId of ['s-1', 's-2', 's-3']) {
      findCheckboxFor(tree, sessionId).props.onChange()
      tree = runtime.render(DistillView, { workspaceId: 'ws-1' })
    }
    await findButtonByText(tree, t('distill.view.config.start')).props.onClick()
    tree = runtime.render(DistillView, { workspaceId: 'ws-1' })

    const alert = collectNodes(tree).find((node) => node.props?.role === 'alert')
    assert.ok(alert, 'error banner renders')
    const banner = textOf(alert)
    assert.ok(banner.includes(t('distill.view.error.code.ANALYZER_UNAVAILABLE')),
      'the analyzer code gets its dedicated label')
    assert.ok(banner.includes('distill analyzer is not wired into this Host entry'),
      'the host message is surfaced verbatim')
    assert.ok(!banner.includes(t('distill.view.error.code.RUN_ALREADY_ACTIVE')),
      'never claim an active run for an unrelated failure')
    assert.ok(banner.includes('(ANALYZER_UNAVAILABLE)'),
      'the raw Host code stays visible for support, even when a label exists')
  } finally {
    runtime.cleanupAll()
    fetchStub.restore()
  }
})

test('DistillView: a live run that lands failed returns to config with the persisted error and code', async () => {
  // Regression: applyRuns used to drop the landed run when its status was not
  // 'applied', so a failed analysis silently bounced back to the config page.
  const live = { id: 'run-live', workspaceId: 'ws-1', status: 'analyzing', progress: { stage: 'stage1', completed: 0, total: 3 } }
  const failed = {
    id: 'run-live',
    workspaceId: 'ws-1',
    status: 'failed',
    error: { code: 'ANALYZER_FINISH_REASON', message: '模型未正常结束（reason.kind=error；ACCOUNT_TOKEN_INVALID: rejected）' },
  }
  const fetchStub = stubFetch(() => jsonResponse({ ok: true, runs: fetchStub.calls.length === 1 ? [live] : [failed] }))
  const runtime = createHookRuntime()
  const DistillView = createDistillView({
    h,
    React: runtime.React,
    services: { loadDistillSource: () => SOURCE },
    t,
  })
  try {
    let tree = runtime.render(DistillView, { workspaceId: 'ws-1' })
    await runtime.flushEffects()
    await tick()
    tree = runtime.render(DistillView, { workspaceId: 'ws-1' })
    assert.ok(textOf(tree).includes(t('distill.view.running.heading')), 'the live run renders as running')

    await new Promise((resolve) => setTimeout(resolve, DISTILL_VIEW_POLL_MS + 350))
    tree = runtime.render(DistillView, { workspaceId: 'ws-1' })

    const alert = collectNodes(tree).find((node) => node.props?.role === 'alert')
    assert.ok(alert, 'the landed failure renders an alert banner')
    const banner = textOf(alert)
    assert.ok(banner.includes(t('distill.view.error.runFailed')), 'the run-failed label renders')
    assert.ok(banner.includes('(ANALYZER_FINISH_REASON)'), 'the persisted failure code is visible')
    assert.ok(banner.includes('ACCOUNT_TOKEN_INVALID'), 'the persisted failure message is visible')
    assert.ok(textOf(tree).includes(t('distill.view.config.listTitle')), 'the user is back on a usable config page')
  } finally {
    runtime.cleanupAll()
    fetchStub.restore()
  }
})

test('DistillView: refresh recovery enters running from a persisted non-terminal run and cancel POSTs distill-cancel', async () => {
  const live = {
    id: 'run-live',
    workspaceId: 'ws-1',
    status: 'analyzing',
    progress: { stage: 'snapshotting', completed: 2, total: 5 },
  }
  const fetchStub = stubFetch((call) => {
    if (call.method === 'POST' && call.url.includes('distill-cancel')) {
      return jsonResponse({ ok: true, status: 'cancelRequested', runStatus: 'analyzing' })
    }
    return jsonResponse({ ok: true, runs: [live] })
  })
  const runtime = createHookRuntime()
  const DistillView = createDistillView({
    h,
    React: runtime.React,
    services: { loadDistillSource: () => SOURCE },
    t,
  })
  try {
    let tree = runtime.render(DistillView, { workspaceId: 'ws-1' })
    await runtime.flushEffects()
    await tick()
    tree = runtime.render(DistillView, { workspaceId: 'ws-1' })

    const text = textOf(tree)
    assert.ok(text.includes(t('distill.view.running.heading')),
      'mount with a non-terminal run recovers straight into running')
    assert.ok(text.includes('2/5'), 'polled progress renders')
    assert.ok(fetchStub.calls.some((call) => call.method === 'GET'
      && call.url.includes('distill-run?workspaceId=ws-1')),
    'recovery read goes through the workspace run list')

    // Cancel is destructive-ish (it abandons analysis), so the first click only
    // opens a confirmation; nothing may hit the Host yet.
    await findButtonByText(tree, t('distill.view.running.cancel')).props.onClick()
    assert.equal(
      fetchStub.calls.filter((call) => call.method === 'POST' && call.url.includes('distill-cancel')).length,
      0,
      'the first cancel click must not issue a POST',
    )
    assert.ok(textOf(runtime.render(DistillView, { workspaceId: 'ws-1' }))
      .includes(t('distill.view.running.cancelConfirm')), 'the confirmation explains what canceling keeps')

    tree = runtime.render(DistillView, { workspaceId: 'ws-1' })
    await findButtonByText(tree, t('distill.view.running.cancelYes')).props.onClick()

    const cancelPost = fetchStub.calls.find(
      (call) => call.method === 'POST' && call.url.includes('distill-cancel'),
    )
    assert.ok(cancelPost, 'confirming issues the cancel POST')
    assert.equal(cancelPost.url, 'api/punch-desk/distill-cancel')
    assert.deepEqual(cancelPost.body, { runId: 'run-live' })

    tree = runtime.render(DistillView, { workspaceId: 'ws-1' })
    assert.ok(textOf(tree).includes(t('distill.lock.cancelRequested')),
      'cancelRequested feedback reuses the existing locale key')
  } finally {
    runtime.cleanupAll()
    fetchStub.restore()
  }
})

test('DistillView: result phase calls the renderSummary slot prop and history lists runs', async () => {
  const applied = {
    id: 'run-done',
    workspaceId: 'ws-1',
    status: 'applied',
  }
  const fetchStub = stubFetch(() => jsonResponse({ ok: true, runs: [applied] }))
  const runtime = createHookRuntime()
  const summaryCalls = []
  const DistillView = createDistillView({
    h,
    React: runtime.React,
    services: { loadDistillSource: () => SOURCE },
    t,
  })
  try {
    let tree = runtime.render(DistillView, {
      workspaceId: 'ws-1',
      renderSummary: (slotProps) => {
        summaryCalls.push(slotProps)
        return h('div', { 'data-slot': 'summary' }, 'SUMMARY-CONTENT')
      },
    })
    await runtime.flushEffects()
    await tick()
    tree = runtime.render(DistillView, {
      workspaceId: 'ws-1',
      renderSummary: (slotProps) => {
        summaryCalls.push(slotProps)
        return h('div', { 'data-slot': 'summary' }, 'SUMMARY-CONTENT')
      },
    })

    // 'applied' is terminal: getActiveRun returns null, so the view stays in
    // config; the result shell is reached through the applied-run landing path.
    assert.equal(summaryCalls.length, 0, 'the slot is not called before the result phase')
    const historyButton = findButtonByText(tree, t('distill.view.history.heading'))
    assert.ok(historyButton, 'history entry button renders in config')
    historyButton.props.onClick()
    tree = runtime.render(DistillView, { workspaceId: 'ws-1' })

    const text = textOf(tree)
    assert.ok(text.includes(t('distill.view.history.heading')), 'history heading renders')
    assert.ok(text.includes('applied'), 'past run status is listed')
    assert.ok(text.includes(t('distill.view.history.back')), 'history offers a way back')
  } finally {
    runtime.cleanupAll()
    fetchStub.restore()
  }
})

// ------------------------------------------------------ locale + desk wiring

test('locale: distill.view.* keys are zh/en paired and cover the distill-view contract', () => {
  const dict = dictionaries()
  const zhKeys = new Set(Object.keys(dict.zh || {}))
  const enKeys = new Set(Object.keys(dict.en || {}))
  const source = fs.readFileSync(new URL('../src/client/ui/distill-view.js', import.meta.url), 'utf8')

  // The module header is the planned key contract (spec §10.1/§10.5), which
  // also covers keys not referenced by the skeleton yet (selectedCount,
  // error.heading).
  const planned = [...source.matchAll(/^\s*\*\s+(distill\.view\.[A-Za-z0-9_.]+)/gm)]
    .map(match => match[1])
  assert.ok(planned.length >= 35, `expected the full planned key list, got ${planned.length}`)

  const referenced = new Set(planned)
  // Every translate('...') call site must resolve in both dictionaries.
  for (const match of source.matchAll(/\btranslate\(\s*'([^']+)'/g)) referenced.add(match[1])
  // Quoted literals: START_ERROR_KEYS / CANCEL_NOTE_KEYS values.
  for (const match of source.matchAll(/'(distill\.(?:view|lock)\.[A-Za-z0-9_.]+)'/g)) referenced.add(match[1])
  // The running-stage label is composed dynamically from these stage keys.
  for (const stage of ['snapshotting', 'stage1', 'stage2', 'validating']) {
    referenced.add(`distill.view.stage.${stage}`)
  }
  // desk.js renders the reviews tab header through the parallel distill keys.
  referenced.add('desk.view.distillTitle')
  referenced.add('desk.view.distillDesc')

  const missing = [...referenced].filter(key => !zhKeys.has(key) || !enKeys.has(key))
  assert.deepEqual(missing, [], `distill-view locale keys must exist in zh and en:\n${missing.join('\n')}`)
})

test('desk wiring: the reviews tab mounts DistillView with the resolved workspace and the ResultContent summary slot', async () => {
  const dict = dictionaries()
  const tDesk = key => dict.zh[key] ?? key
  const runtime = createDeskHookRuntime()
  const store = {
    listWorkspaces: async () => [DRAFTS_WORKSPACE_KEY, 'session:s1', 'session:s2', 'session:s3'],
    listWorkspaceRecords: async () => [
      createWorkspaceRecord({ id: 'ws-distill', name: 'Distill WS', gitBranch: 'main' }),
    ],
    listEntries: async () => [],
    listPromptLog: async () => [],
    getPrefs: async () => ({}),
    subscribe: () => () => {},
  }
  const services = { t: tDesk, store, canOpenSession: () => false }
  const DeskPage = createDeskPage({ h, React: runtime.React, services })

  const view = () => runtime.render(DeskPage, { defaultTab: 'reviews' })
  let tree = view()
  await runtime.runEffects()
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
  const started = Date.now()
  while (deskTextOf(tree).includes(dict.zh['tab.placeholder'])) {
    if (Date.now() - started > 2000) throw new Error('timed out waiting for desk load')
    await delay(5)
    tree = view()
  }

  const distillNode = findDeskNode(tree,
    node => typeof node.type === 'function' && node.type.name === 'DistillView')
  assert.ok(distillNode, 'DistillView is mounted in the reviews tab branch')
  assert.equal(typeof distillNode.props.renderSummary, 'function',
    'the Task 3.2 summary slot is a function forwarding ResultContent')
  assert.equal(distillNode.props.workspaceId, 'ws-distill',
    'the distill workspace id is the desk-resolved lookup workspace')
  assert.equal(findDeskNode(tree,
    node => typeof node.type === 'function' && node.type.name === 'RetrospectiveDiff'), undefined,
    'the legacy RetrospectiveDiff is no longer rendered in the reviews tab')
  const pageText = deskTextOf(tree)
  assert.ok(pageText.includes(dict.zh['desk.tab.reviews']),
    'the tab label keeps the legacy desk.tab.reviews key')
})

test('desk wiring: loadDistillSource snapshots the desk render state into the distill view', () => {
  const source = fs.readFileSync(new URL('../src/client/ui/desk.js', import.meta.url), 'utf8')
  assert.match(source, /import \{ createDistillView \} from '\.\/distill-view\.js'/,
    'desk.js imports the distill view factory')
  assert.match(source, /loadDistillSource/,
    'desk.js provides the loadDistillSource service')
  const snapshot = /distillSourceBox\.current = \{\s*sessions: sessionCards\.map\(session => \(\{\s*\.\.\.session,\s*title: session\.title \|\| sessionTitle\(session\),\s*\}\),?\),\s*findings: allFindings\.filter\(finding => workspaceScopedSessionIds\.has\(finding\.sessionId\)\),\s*promptLogs: allPromptLogs\.filter\(log => workspaceScopedSessionIds\.has\(log\.sessionId\)\),\s*archivedSessionIds: archivedSessionIdSet,\s*\}/.exec(source)
  assert.ok(snapshot, 'the source box snapshots the visible sessions (with resolved titles) and their findings/logs')
  assert.match(source, /const sessionCards = workspaceScopedSessions\.filter\(session => isSessionCardVisible\(session\)\)/,
    'the batch source drops store sessions left without any rows (phantom cards) before snapshotting')
  assert.match(source, /resolveWorkspaceSessionIds\(\{/,
    'the batch source uses the shared workspace-scoping resolver')
  assert.match(source, /const workspaceScopedSessions = sessions\.filter/,
    'the batch source is scoped to the active workspace before it is handed to the view')
  assert.match(source, /workspaceId: resolvedLookupWorkspaceId \|\| workspaceId/,
    'the reviews branch forwards the resolved workspace id')
  assert.match(source, /renderSummary: \(\{ run, runs \}\) => \(run/,
    'the Task 3.2 summary slot forwards the applied run to ResultContent')
  assert.doesNotMatch(source, /renderSummary: null/,
    'the summary slot is no longer null')
})

// ------------------------------------------------- pending confirm (Task 3.2)

/** A ready run as the polled GET list would return it (plan included). */
const READY_RUN = {
  id: 'run-ready',
  workspaceId: 'ws-1',
  status: 'ready',
  plan: {
    runId: 'run-ready',
    summary: 'plan-summary',
    targets: [],
    conflicts: [],
    checks: [],
  },
}

/** Mock confirmation page: records every props pass it receives. */
function makeMockConfirm(renderCalls) {
  return function MockConfirm(props) {
    renderCalls.push(props)
    return h('div', { 'data-mock-confirm': true }, 'MOCK-CONFIRM')
  }
}

test('DistillView: the pending phase renders the injected confirm component with run/plan/workspaceId/onApplied', async () => {
  const fetchStub = stubFetch(() => jsonResponse({ ok: true, runs: [READY_RUN] }))
  const runtime = createHookRuntime()
  const confirmProps = []
  const DistillView = createDistillView({
    h,
    React: runtime.React,
    services: { loadDistillSource: () => SOURCE },
    t,
    createConfirmComponent: () => makeMockConfirm(confirmProps),
  })
  try {
    let tree = runtime.render(DistillView, { workspaceId: 'ws-1' })
    await runtime.flushEffects()
    await tick()
    tree = runtime.render(DistillView, { workspaceId: 'ws-1' })

    assert.ok(confirmProps.length > 0, 'the injected confirm component renders in the ready phase')
    const props = confirmProps[confirmProps.length - 1]
    assert.equal(props.run, READY_RUN, 'the polled ready run is forwarded as run')
    assert.equal(props.plan, READY_RUN.plan,
      'plan prefers the polled run.plan instead of being fabricated')
    assert.equal(props.workspaceId, 'ws-1', 'the view workspaceId is forwarded')
    assert.equal(typeof props.onApplied, 'function', 'onApplied is wired to the state machine')

    const text = textOf(tree)
    assert.ok(text.includes('MOCK-CONFIRM'), 'the confirm page body renders')
    assert.ok(!text.includes(t('distill.view.pending.placeholder')),
      'the placeholder is replaced by the injected confirm page')
  } finally {
    runtime.cleanupAll()
    fetchStub.restore()
  }
})

test('DistillView: onApplied folds the applied status and switches the phase to result', async () => {
  const fetchStub = stubFetch(() => jsonResponse({ ok: true, runs: [READY_RUN] }))
  const runtime = createHookRuntime()
  const confirmProps = []
  const slotCalls = []
  const DistillView = createDistillView({
    h,
    React: runtime.React,
    services: { loadDistillSource: () => SOURCE },
    t,
    createConfirmComponent: () => makeMockConfirm(confirmProps),
  })
  const renderSummary = (slotProps) => {
    slotCalls.push(slotProps)
    return h('div', { 'data-slot': 'summary' }, 'SUMMARY-CONTENT')
  }
  try {
    let tree = runtime.render(DistillView, { workspaceId: 'ws-1', renderSummary })
    await runtime.flushEffects()
    await tick()
    tree = runtime.render(DistillView, { workspaceId: 'ws-1', renderSummary })
    assert.ok(confirmProps.length > 0, 'the confirm page is mounted in pending')

    confirmProps[confirmProps.length - 1].onApplied({ ok: true, runStatus: 'applied' })
    tree = runtime.render(DistillView, { workspaceId: 'ws-1', renderSummary })

    const text = textOf(tree)
    assert.ok(text.includes(t('distill.view.result.heading')),
      'the state machine leaves pending and enters result')
    assert.ok(text.includes('SUMMARY-CONTENT'), 'the renderSummary slot renders the result body')
    // The 200 payload now rides into the result phase so the written-back ledger
    // and post-apply stats stay visible instead of vanishing with the pending view.
    assert.ok(text.includes('MOCK-CONFIRM'), 'the applied ledger stays mounted on the result page')
    assert.equal(confirmProps[confirmProps.length - 1].applied.ok, true,
      'the apply payload is handed to the ledger')

    assert.ok(slotCalls.length > 0, 'the result phase calls the renderSummary slot')
    const slot = slotCalls[slotCalls.length - 1]
    assert.equal(slot.run.id, 'run-ready')
    assert.equal(slot.run.status, 'applied',
      'the applied status from the apply response is folded locally')
    assert.equal(
      slot.runs.find((run) => run.id === 'run-ready')?.status, 'applied',
      'the history list is refreshed to the applied status',
    )
  } finally {
    runtime.cleanupAll()
    fetchStub.restore()
  }
})

test('DistillView: without the confirm injection the pending phase keeps the placeholder fallback', async () => {
  const fetchStub = stubFetch(() => jsonResponse({ ok: true, runs: [READY_RUN] }))
  const runtime = createHookRuntime()
  const DistillView = createDistillView({
    h,
    React: runtime.React,
    services: { loadDistillSource: () => SOURCE },
    t,
  })
  try {
    let tree = runtime.render(DistillView, { workspaceId: 'ws-1' })
    await runtime.flushEffects()
    await tick()
    tree = runtime.render(DistillView, { workspaceId: 'ws-1' })

    const text = textOf(tree)
    assert.ok(text.includes(t('distill.view.pending.heading')),
      'the view-level pending heading renders in the fallback')
    assert.ok(text.includes(t('distill.view.pending.placeholder')),
      'the placeholder renders when no confirm component is injected')
  } finally {
    runtime.cleanupAll()
    fetchStub.restore()
  }
})

test('desk wiring: the confirm page is created once and feeds both the pending phase and the result slot', () => {
  const source = fs.readFileSync(new URL('../src/client/ui/desk.js', import.meta.url), 'utf8')
  assert.match(source, /import \{ createDistillConfirm \} from '\.\/distill-confirm\.js'/,
    'desk.js imports the confirm factory')
  assert.match(source, /const DistillConfirm = createDistillConfirm\(\{ h, React, services, t \}\)/,
    'the factory area creates one shared DistillConfirm instance')
  assert.match(source, /createConfirmComponent: \(\) => DistillConfirm/,
    'the instance is injected into DistillView as a zero-arg factory')
  assert.match(source, /h\(DistillConfirm\.ResultContent, \{ run, onRenew: handleDistillRenew \}\)/,
    'the renderSummary slot renders ResultContent with the renew callback')
  const renew = /const handleDistillRenew = \(\) => \{\s*setTab\('canvas'\)\s*\}/.exec(source)
  assert.ok(renew, 'handleDistillRenew is the minimal setTab(canvas) placeholder for the D17 migration')
})

test('formatRelativeTime: localized relative stamps with an absolute fallback', () => {
  const now = 1_700_000_000_000
  assert.equal(formatRelativeTime(now - 5_000, t, now), t('distill.view.time.justNow'))
  assert.equal(formatRelativeTime(now - 5 * 60_000, t, now), t('distill.view.time.minutesAgo'),
    'templates are substituted by countText at render time (identity t returns the key)')
  assert.equal(formatRelativeTime(now - 3 * 3_600_000, t, now), t('distill.view.time.hoursAgo'))
  assert.equal(formatRelativeTime(now - 2 * 86_400_000, t, now), t('distill.view.time.daysAgo'))
  assert.match(formatRelativeTime(now - 90 * 86_400_000, t, now), /^\d{4}-\d{2}-\d{2}$/,
    'older stamps fall back to the absolute date')
  assert.equal(formatRelativeTime(null, t, now), '')
  assert.equal(formatRelativeTime('not-a-time', t, now), '')
  assert.equal(formatRelativeTime(now / 1000, t, now), t('distill.view.time.justNow'),
    'epoch seconds and milliseconds are both accepted')
})
