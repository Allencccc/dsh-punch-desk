/**
 * DistillView — third UX round (config hierarchy / return paths / run layout).
 *
 * - config is TWO PEER PANELS on one grid: the session builder on the left and
 *   the read-only 「精炼概览」 on the right. The overview is not a sticky banner
 *   above the page anymore; an empty workspace says 「还没有精炼记录」.
 * - every explicit back path (result header, applied ledger `onBack`) lands on
 *   the config home page, clears the pin and survives the next background poll;
 *   viewing a summary from history stays an explicit, unsuppressed action.
 * - running is a two-column page: stage / progress / cancel on the left and the
 *   result timeline filling the whole right column (no narrow capped box).
 *
 * Harness: the same self-contained hook runtime as tests/distill-ux2-view.test.js.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DISTILL_VIEW_POLL_MS,
  createDistillView,
  deriveDistillOverview,
  fillLocaleTemplate,
} from '../src/client/ui/distill-view.js'
import { dictionaries } from '../src/locale.js'

const ZH = dictionaries().zh
const t = (key) => ZH[key] ?? key

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

const findData = (tree, attribute) => findNode(
  tree,
  (node) => node.props?.[attribute] !== undefined,
)

/** Minimal hook runtime (index-based, memo deps, explicit effect flush). */
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

function stubFetch(handler) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    const call = {
      url: String(url),
      method: options.method || 'GET',
      signal: options.signal,
      body: typeof options.body === 'string' ? JSON.parse(options.body) : (options.body ?? null),
    }
    calls.push(call)
    return handler(call)
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

const jsonResponse = (payload, ok = true) => ({ ok, json: async () => payload })
const tick = () => new Promise((resolve) => setImmediate(resolve))
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const pollTick = () => delay(DISTILL_VIEW_POLL_MS + 350)

const NOW = Date.now()

const SOURCE = {
  sessions: [
    { sessionId: 's-1', title: 'Refactor store', updatedAt: NOW - 5 * 60_000 },
    { sessionId: 's-2', title: 'Fix queue bug', updatedAt: NOW - 2 * 3_600_000 },
    { sessionId: 's-3', title: 'Write docs', updatedAt: NOW - 3 * 86_400_000 },
  ],
  findings: [
    { sessionId: 's-1', updatedAt: NOW - 5 * 60_000 },
    { sessionId: 's-2', updatedAt: NOW - 2 * 3_600_000 },
    { sessionId: 's-3', updatedAt: NOW - 3 * 86_400_000 },
  ],
  promptLogs: [{ sessionId: 's-1', updatedAt: NOW - 4 * 60_000 }],
  archivedSessionIds: [],
}

/** Mock confirmation page: records every props pass it receives. */
function makeMockConfirm(renderCalls) {
  return function MockConfirm(props) {
    renderCalls.push(props)
    return h('div', { 'data-mock-confirm': true }, 'MOCK-CONFIRM')
  }
}

async function mount(options = {}) {
  const fetchStub = stubFetch(options.handler || (() => jsonResponse({ ok: true, runs: [] })))
  const runtime = createHookRuntime()
  const confirmCalls = []
  const deps = {
    h,
    React: runtime.React,
    services: { loadDistillSource: () => options.source ?? SOURCE },
    t,
  }
  if (options.confirm) deps.createConfirmComponent = () => options.confirm(confirmCalls)
  const DistillView = createDistillView(deps)
  const props = { workspaceId: 'ws-1', ...(options.props ?? {}) }
  let tree = runtime.render(DistillView, props)
  await runtime.flushEffects()
  await tick()
  tree = runtime.render(DistillView, props)
  return {
    runtime,
    DistillView,
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

/* ------------------------------------------------------ overview fixtures */

const APPLIED_A = {
  id: 'run-a',
  workspaceId: 'ws-1',
  status: 'applied',
  appliedAt: NOW - 3_600_000,
  sessions: [{ sessionId: 's-1' }, { sessionId: 's-2' }],
  applyResult: {
    ok: true,
    applied: [{ file: 'AGENTS.md' }, { file: 'docs/arch/README.md' }],
    selectedChangeIds: ['c1', 'c2'],
  },
  usage: { calls: 3, totalTokens: 1234 },
}

const APPLIED_B = {
  id: 'run-b',
  workspaceId: 'ws-1',
  status: 'applied',
  appliedAt: NOW - 2 * 86_400_000,
  sessions: [{ sessionId: 's-1' }, { sessionId: 's-2' }, { sessionId: 's-3' }],
  // Legacy run without an apply record: the overview falls back to plan.stats.
  plan: { stats: { targets: 1, changes: 3 } },
}

const FAILED_RUN = {
  id: 'run-c',
  workspaceId: 'ws-1',
  status: 'failed',
  updatedAt: NOW - 10 * 60_000,
  sessions: [{ sessionId: 's-3' }],
  error: { code: 'ANALYZER_TIMEOUT', message: 'model timed out' },
}

/* ---------------------------------------------------- config peer panels */

test('config: 精炼概览 and the session builder are sibling panels of the wide grid', async () => {
  const view = await mount({
    handler: () => jsonResponse({ ok: true, runs: [APPLIED_A, APPLIED_B, FAILED_RUN] }),
  })
  try {
    const tree = view.tree
    const grid = findData(tree, 'data-distill-config-grid')
    assert.ok(grid, 'the config body builds one shared grid')
    assert.equal(grid.props.style.display, 'grid', 'the config hierarchy is a grid')
    assert.equal(grid.props.style.gridTemplateColumns, 'minmax(0, 1fr) minmax(260px, 320px)',
      'the session panel is the flexible column and the overview is the 260–320px side panel')
    assert.equal(grid.props.style.gap, 10, 'the two peer panels share the 10px panel gap')

    assert.equal(grid.children.length, 2, 'exactly two peer panels render in the grid')
    const sessionsPanel = grid.children[0]
    const overviewPanel = grid.children[1]
    assert.equal(sessionsPanel.type, 'section')
    assert.equal(sessionsPanel.props['data-distill-panel'], 'sessions')
    assert.equal(overviewPanel.type, 'section')
    assert.equal(overviewPanel.props['data-distill-panel'], 'overview')
    assert.equal(overviewPanel.props['data-distill-overview'], 'true')
    assert.equal(grid.children[0], sessionsPanel, 'the session panel is the first grid child')
    assert.equal(grid.children[1], overviewPanel, 'the overview is the second grid child, not a banner above')

    // The overview must not be sticky and must not be a full-width horizontal bar.
    assert.equal(overviewPanel.props.style.position, undefined, 'the overview panel is not sticky')
    assert.equal(overviewPanel.props.style.width, undefined, 'the overview is a grid peer, not a full-width bar')

    // Same panel-head language on both peers: icon + title + count.
    const sessionHead = findData(sessionsPanel, 'data-pd-panel-head')
    const overviewHead = findData(overviewPanel, 'data-pd-panel-head')
    assert.ok(sessionHead && overviewHead, 'both panels use the shared panel head')
    assert.equal(sessionHead.props.style, overviewHead.props.style, 'both heads share the same style object')
    assert.equal(sessionHead.props.style.display, 'flex')
    assert.equal(sessionHead.children[0]?.type, 'svg',
      'the panel head starts with a vector icon')
    assert.equal(overviewHead.children[0]?.type, 'svg',
      'the overview head also starts with a vector icon')
    assert.match(textOf(sessionHead), new RegExp(`${t('distill.view.config.listTitle')}\\s+3`),
      'the session head carries its title and count')
    assert.match(textOf(overviewHead), new RegExp(`${t('distill.overview.title')}\\s+3`),
      'the overview head carries its title and batch count')

    // Page title stays the sticky page header, above the two peers.
    const header = tree.children[0]
    assert.equal(header.props.style.position, 'sticky', 'the page header stays sticky')
    assert.ok(textOf(header).includes(t('distill.view.title')), 'page title is 手账精炼')

    // Cumulative facts: 2 files from the apply record + 1 from the legacy plan.
    const totals = findData(overviewPanel, 'data-distill-overview-totals')
    assert.ok(totals, 'the overview renders a cumulative readout')
    assert.equal(textOf(totals), fillLocaleTemplate(t('distill.overview.totals'), {
      batches: 3,
      files: 3,
      changes: 5,
    }))

    // Recent three batches, newest first, each with status/sessions/files/tokens/time.
    const rows = collectNodes(overviewPanel)
      .filter((node) => node.props?.['data-distill-overview-row'])
    assert.deepEqual(rows.map((row) => row.props['data-distill-overview-row']),
      ['run-c', 'run-a', 'run-b'], 'the overview shows the three newest batches')

    const appliedRow = rows.find((row) => row.props['data-distill-overview-row'] === 'run-a')
    const appliedText = textOf(appliedRow)
    assert.ok(appliedText.includes(t('distill.view.run.status.applied')),
      'an applied batch keeps its localized status badge')
    assert.ok(appliedText.includes(fillLocaleTemplate(t('distill.overview.applied'), { files: 2 })),
      'the applied batch reports the files it actually wrote back')
    assert.ok(appliedText.includes(fillLocaleTemplate(t('distill.overview.tokens'), { tokens: 1234 })),
      'persisted usage tokens render when present')
    assert.match(appliedText, /1 小时前/, 'each recent batch carries a relative timestamp')

    const legacyRow = rows.find((row) => row.props['data-distill-overview-row'] === 'run-b')
    assert.ok(textOf(legacyRow).includes(fillLocaleTemplate(t('distill.overview.applied'), { files: 1 })),
      'a legacy applied run falls back to plan.stats for its file count')

    const failedRow = rows.find((row) => row.props['data-distill-overview-row'] === 'run-c')
    assert.ok(textOf(failedRow).includes(t('distill.overview.notApplied')),
      'a non-applied batch is explicitly marked as not written back')

    // The pure derivation is exported and honest about missing data.
    const derived = deriveDistillOverview([APPLIED_A, APPLIED_B, FAILED_RUN])
    assert.equal(derived.batches, 3)
    assert.equal(derived.appliedCount, 2)
    assert.equal(derived.files, 3)
    assert.equal(derived.changes, 5)
    assert.equal(derived.tokens, 1234)
    assert.deepEqual(deriveDistillOverview(null), {
      batches: 0, appliedCount: 0, files: 0, changes: 0, tokens: 0, recent: [],
    })

    // The scoped responsive rule collapses the peer grid on narrow screens.
    const responsive = findData(tree, 'data-pd-distill-responsive')
    assert.ok(responsive, 'the view injects its scoped responsive rule')
    assert.match(textOf(responsive), /@media \(max-width: 880px\)/)
    assert.match(textOf(responsive), /pd-distill-config-grid/)
  } finally {
    view.dispose()
  }
})

test('config: an empty overview says 还没有精炼记录 instead of fabricating batches', async () => {
  const view = await mount({
    source: { sessions: [], findings: [], promptLogs: [], archivedSessionIds: [] },
  })
  try {
    const tree = view.tree
    const overviewPanel = findData(tree, 'data-distill-overview')
    assert.ok(overviewPanel, 'the overview peer panel still renders without history')
    assert.equal(textOf(findData(overviewPanel, 'data-distill-overview-totals')),
      t('distill.overview.totalsEmpty'), 'the totals row states 0 files written back')
    const empty = findData(overviewPanel, 'data-distill-overview-empty')
    assert.ok(empty, 'an empty overview renders its empty state')
    assert.equal(textOf(empty), t('distill.overview.empty'),
      'the empty state is 还没有精炼记录')
    assert.equal(collectNodes(overviewPanel)
      .filter((node) => node.props?.['data-distill-overview-row']).length, 0,
    'no recent-batch rows are fabricated')
    assert.ok(textOf(overviewPanel).includes(t('distill.overview.hint')),
      'the read-only hint still renders')
    assert.ok(textOf(tree).includes(t('distill.view.config.empty')),
      'the session panel keeps its own empty state')
  } finally {
    view.dispose()
  }
})

/* ------------------------------------------------------- back to config */

test('back: result header and ledger onBack return to config and the poll cannot bounce them back', async () => {
  const applied = {
    ...APPLIED_A,
    applyResult: {
      ...APPLIED_A.applyResult,
      appliedAt: NOW - 30_000,
      readBackOk: true,
    },
  }
  const view = await mount({
    confirm: makeMockConfirm,
    handler: (call) => {
      if (call.method === 'GET' && call.url.includes('distill-run')) {
        return jsonResponse({ ok: true, runs: [applied] })
      }
      return jsonResponse({ ok: true, runs: [] })
    },
  })
  try {
    // Mount lands on config (an applied run is not an active landing).
    let tree = view.tree
    assert.ok(textOf(tree).includes(t('distill.view.config.listTitle')),
      'the page starts on the config home')

    // Open the summary explicitly from history.
    findButtonByText(tree, t('distill.view.history.heading')).props.onClick()
    tree = view.render()
    findButtonByText(tree, t('distill.view.history.openResult')).props.onClick()
    tree = view.render()
    assert.ok(textOf(tree).includes(t('distill.view.result.heading')),
      'viewing a summary is allowed explicitly')
    assert.ok(textOf(tree).includes(t('distill.view.result.pinHint')), 'the result page is pinned')

    // Back through the applied ledger's onBack.
    const ledger = view.confirmCalls[view.confirmCalls.length - 1]
    assert.equal(typeof ledger.onBack, 'function', 'the applied ledger receives onBack')
    ledger.onBack()
    tree = view.render()
    assert.ok(textOf(tree).includes(t('distill.view.config.listTitle')),
      'the ledger onBack lands on the config home page')
    assert.ok(!textOf(tree).includes(t('distill.view.result.pinHint')), 'the pin is cleared')

    // The background poll still reports the same applied run: it must not land
    // the user back on the result page.
    await pollTick()
    tree = view.render()
    assert.ok(textOf(tree).includes(t('distill.view.config.listTitle')),
      'the poll keeps the config home page after an explicit back')
    assert.ok(!textOf(tree).includes(t('distill.view.result.heading')),
      'the applied run is not re-landed after back')
    assert.ok(textOf(tree).includes(t('distill.overview.title')),
      'the overview still refreshes its data on config')

    // Explicitly viewing the summary again is not suppressed.
    findButtonByText(tree, t('distill.view.history.heading')).props.onClick()
    tree = view.render()
    findButtonByText(tree, t('distill.view.history.openResult')).props.onClick()
    tree = view.render()
    assert.ok(textOf(tree).includes(t('distill.view.result.heading')),
      'an explicit summary view bypasses the landing suppression')

    // Back through the result header this time, then poll again.
    findButtonByText(tree, t('distill.view.result.back')).props.onClick()
    tree = view.render()
    assert.ok(textOf(tree).includes(t('distill.view.config.listTitle')),
      'the result header back lands on config')
    await pollTick()
    tree = view.render()
    assert.ok(!textOf(tree).includes(t('distill.view.result.heading')),
      'the header back is not bounced back by the next poll either')
    assert.ok(textOf(tree).includes(t('distill.view.config.listTitle')))
  } finally {
    view.dispose()
  }
})

/* ------------------------------------------------------ running layout */

test('running: stage/progress/cancel sit on the left and the timeline fills the right column', async () => {
  const logs = Array.from({ length: 4 }, (_, index) => ({
    at: NOW - (4 - index) * 60_000,
    stage: index % 2 === 0 ? 'stage1' : 'stage2',
    message: `会话「Refactor store」：${index} 条候选，其中 ${index} 条有提交证据；仍缺 2 个会话，正在取：Fix queue bug`,
  }))
  const live = {
    id: 'run-live',
    workspaceId: 'ws-1',
    status: 'analyzing',
    createdAt: NOW - 5 * 60_000,
    sessions: [{ sessionId: 's-1' }, { sessionId: 's-2' }, { sessionId: 's-3' }],
    progress: { stage: 'stage1', completed: 2, total: 4, log: logs },
  }
  const view = await mount({ handler: () => jsonResponse({ ok: true, runs: [live] }) })
  try {
    const tree = view.tree
    const grid = findData(tree, 'data-distill-running-grid')
    assert.ok(grid, 'the running page builds a two-column grid')
    assert.equal(grid.props.style.display, 'grid')
    assert.equal(grid.props.style.gridTemplateColumns, 'minmax(220px, 300px) minmax(0, 1fr)',
      'the left column is the stage lane and the right column is flexible')
    assert.equal(grid.children.length, 2, 'running renders exactly two columns')
    const left = grid.children[0]
    const timelinePanel = grid.children[1]
    assert.equal(left.props['data-distill-running-left'], 'true')
    assert.equal(timelinePanel.props['data-distill-running-timeline'], 'true')

    const leftText = textOf(left)
    assert.ok(leftText.includes(t('distill.view.running.heading')), 'the heading lives in the left column')
    assert.ok(leftText.includes(t('distill.view.running.stage')), 'the stage label lives in the left column')
    assert.ok(leftText.includes('2/4'), 'the progress count lives in the left column')
    assert.ok(leftText.includes(t('distill.view.running.cancel')), 'the cancel action lives in the left column')
    assert.ok(leftText.includes('已用时'), 'elapsed time is kept')

    // The timeline owns the full right column; no 560px/420px capped box.
    assert.equal(timelinePanel.props.style.width, '100%', 'the timeline panel fills its column')
    const timeline = findNode(timelinePanel, (node) => (
      node.type === 'div'
      && node.props?.style?.display === 'flex'
      && node.props?.style?.width === '100%'
      && node.children?.some((child) => /^\d{2}:\d{2}$/.test(textOf(child?.children?.[0] ?? '')))
    ))
    assert.ok(timeline, 'the timeline list is a full-width flex column')
    assert.equal(collectNodes(timelinePanel)
      .some((node) => node.props?.style?.maxWidth !== undefined), false,
    'nothing in the running right column caps the timeline to a narrow width')

    // Every row may wrap; the newest row stays highlighted.
    const rows = collectNodes(timelinePanel).filter((node) => (
      node.type === 'div'
      && Array.isArray(node.children)
      && node.children[0]?.type === 'span'
      && /^\d{2}:\d{2}$/.test(textOf(node.children[0]))
    ))
    assert.equal(rows.length, logs.length, 'all timeline rows render')
    for (const row of rows) {
      assert.equal(row.props.style.flexWrap, undefined)
      assert.equal(row.props.style.flexDirection, undefined)
      const message = row.children.find((child) => (
        child?.props?.style?.overflowWrap === 'anywhere'
      ))
      assert.ok(message, 'each timeline row wraps its message')
      assert.equal(message.props.style.flex, 1, 'the message takes the row width')
      assert.equal(message.props.style.minWidth, 0)
    }
    assert.ok(textOf(timelinePanel).includes(t('distill.view.running.logLatest')),
      'the newest progress row is still highlighted')
    assert.ok(textOf(timelinePanel).includes(t('distill.view.running.timelineHint')),
      'the result-narration hint is kept')

    // The narrow-screen rule collapses the running grid too.
    const responsive = findData(tree, 'data-pd-distill-responsive')
    assert.ok(responsive)
    assert.match(textOf(responsive), /@media \(max-width: 760px\)/)
    assert.match(textOf(responsive), /pd-distill-running-grid/)
  } finally {
    view.dispose()
  }
})
