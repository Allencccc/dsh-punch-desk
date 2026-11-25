/**
 * DistillView — second UX round (Agent D scope):
 *
 * - the result page is pinned: entering it from the apply callback or from a
 *   history "查看摘要" row must survive the 5s background poll, and the explicit
 *   back action clears the pin; a pinned run that vanished reports
 *   `result.notFound` on a usable config page;
 * - the config page renders the "already distilled" marker aggregated from
 *   applied history runs (badge count + last time + written-back files);
 * - the running timeline defaults to 12 result rows, highlights the newest and
 *   expands/collapses through `running.logMore` / `running.logLess`;
 * - the sticky batch bar carries the selection readout, the blocked-start
 *   reason and the single start action, while the card selection keeps the
 *   plugin-owned idle bar + panel wash (no box shadows, no host accent token).
 *
 * Harness: the same self-contained hook runtime as tests/distill-ux-view.test.js
 * (index-based state/ref slots, memoized deps, explicit effect flush, function
 * components expanded into plain vnodes).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DISTILL_TIMELINE_DEFAULT_ROWS,
  DISTILL_VIEW_POLL_MS,
  createDistillView,
  deriveRefinedMarkers,
  fillLocaleTemplate,
} from '../src/client/ui/distill-view.js'
import { countText } from '../src/client/ui/bits.js'
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

const findCard = (tree, sessionId) => findNode(
  tree,
  (node) => node.type === 'label' && node.props?.key === sessionId,
)

/** Timeline rows: divs whose first child is an `HH:mm` span. */
function countTimelineRows(tree) {
  return collectNodes(tree).filter((node) => (
    node.type === 'div'
    && Array.isArray(node.children)
    && node.children[0]
    && node.children[0].type === 'span'
    && /^\d{2}:\d{2}$/.test(textOf(node.children[0]))
  )).length
}

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
    { sessionId: 's-1', updatedAt: NOW - 4 * 60_000 },
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
    /** Toggle one candidate card through its keyboard handler. */
    toggle(sessionId) {
      const card = findCard(tree, sessionId)
      assert.ok(card, `card for ${sessionId} renders`)
      card.props.onKeyDown({ key: 'Enter', preventDefault() {} })
      tree = runtime.render(DistillView, props)
      return tree
    },
    dispose() {
      runtime.cleanupAll()
      fetchStub.restore()
    },
  }
}

/* ------------------------------------------------------------------- pin */

const READY_RUN = {
  id: 'run-ready',
  workspaceId: 'ws-1',
  status: 'ready',
  sessions: [{ sessionId: 's-1' }, { sessionId: 's-2' }, { sessionId: 's-3' }],
  plan: {
    runId: 'run-ready',
    summary: 'plan-summary',
    targets: [{ file: 'AGENTS.md', changes: [{ id: 'c1' }, { id: 'c2' }] }],
    stats: { targets: 1, changes: 2, byGrade: {} },
    conflicts: [],
    checks: [],
  },
}

const LIVE_RUN = {
  id: 'run-next',
  workspaceId: 'ws-1',
  status: 'analyzing',
  createdAt: NOW - 60_000,
  sessions: [{ sessionId: 's-1' }, { sessionId: 's-2' }, { sessionId: 's-3' }],
  progress: { stage: 'stage1', completed: 1, total: 3, log: [] },
}

test('pin: the apply callback enters the result page and a poll cannot navigate away; back clears the pin', async () => {
  let getCalls = 0
  const view = await mount({
    confirm: makeMockConfirm,
    handler: (call) => {
      if (call.method === 'GET' && call.url.includes('distill-run')) {
        getCalls += 1
        // Mount and the poll right after apply still list the (stale) ready run
        // plus a newer live run. After the explicit back the ready run is gone.
        if (getCalls >= 3) return jsonResponse({ ok: true, runs: [LIVE_RUN] })
        return jsonResponse({ ok: true, runs: [READY_RUN, LIVE_RUN] })
      }
      return jsonResponse({ ok: true, runs: [] })
    },
  })
  try {
    // The ready run opens the injected confirmation page.
    assert.ok(findNode(view.tree, (node) => node.props?.['data-mock-confirm']),
      'the pending phase mounts the injected confirmation page')
    const props = view.confirmCalls[view.confirmCalls.length - 1]
    assert.equal(typeof props.onBack, 'function', 'the pending confirmation receives onBack')

    props.onApplied({
      ok: true,
      runStatus: 'applied',
      appliedAt: NOW - 30_000,
      applied: [{ file: 'AGENTS.md', newHash: 'h1' }],
      selectedChangeIds: ['c1', 'c2'],
      readBackOk: true,
    })
    let tree = view.render()
    let text = textOf(tree)
    assert.ok(text.includes(t('distill.view.result.heading')), 'the result page renders')
    assert.ok(text.includes(t('distill.view.result.pinHint')), 'the pin note explains polling cannot move it')
    assert.ok(findButtonByText(tree, t('distill.view.result.back')), 'the result page has an explicit back entry')
    assert.ok(text.includes(fillLocaleTemplate(t('distill.view.result.batchMeta'), {
      sessions: 3, files: 1, changes: 2,
    })), 'the batch meta renders session/file/change counts')
    assert.ok(text.includes('写回于'), 'the applied-at line renders')
    assert.match(text, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/,
      'the applied-at line carries an absolute local timestamp')
    assert.ok(findNode(tree, (node) => node.props?.['data-mock-confirm']),
      'the written-back ledger stays mounted on the result page')
    const ledgerProps = view.confirmCalls[view.confirmCalls.length - 1]
    assert.equal(ledgerProps.applied.applied.length, 1, 'the ledger receives the apply payload')
    assert.equal(typeof ledgerProps.onBack, 'function', 'the ledger back entry clears the pin')

    // Background poll: a newer live run exists, the pinned result must stay.
    await pollTick()
    tree = view.render()
    text = textOf(tree)
    assert.ok(text.includes(t('distill.view.result.heading')), 'polling does not steal the pinned result page')
    assert.ok(!text.includes(t('distill.view.running.heading')), 'the live run never replaces the pinned record')
    assert.ok(text.includes(t('distill.view.result.pinHint')), 'the pin note stays visible')

    // Explicit back: pin cleared, config restored.
    findButtonByText(tree, t('distill.view.result.back')).props.onClick()
    tree = view.render()
    assert.ok(textOf(tree).includes(t('distill.view.config.listTitle')), 'back returns to the config page')
    assert.ok(!textOf(tree).includes(t('distill.view.result.pinHint')), 'back clears the pinned result shell')

    // With the pin cleared the poll is free again: the live run takes over.
    await pollTick()
    tree = view.render()
    assert.ok(textOf(tree).includes(t('distill.view.running.heading')),
      'after back the background poll may follow the live run')
  } finally {
    view.dispose()
  }
})

test('pin: a history result survives polling, and a vanished run reports notFound on a usable config page', async () => {
  const appliedRun = {
    id: 'run-done',
    workspaceId: 'ws-1',
    status: 'applied',
    appliedAt: NOW - 90_000,
    updatedAt: NOW - 90_000,
    sessions: [{ sessionId: 's-1' }, { sessionId: 's-2' }, { sessionId: 's-3' }],
    applyResult: {
      ok: true,
      appliedAt: NOW - 90_000,
      applied: [{ file: 'AGENTS.md', newHash: 'h1' }],
      selectedChangeIds: ['c1'],
      readBackOk: true,
    },
  }
  let getCalls = 0
  const view = await mount({
    handler: (call) => {
      if (call.method === 'GET' && call.url.includes('distill-run')) {
        getCalls += 1
        if (getCalls === 1) return jsonResponse({ ok: true, runs: [appliedRun] })
        if (getCalls === 2) return jsonResponse({ ok: true, runs: [appliedRun, LIVE_RUN] })
        return jsonResponse({ ok: true, runs: [] })
      }
      return jsonResponse({ ok: true, runs: [] })
    },
  })
  try {
    let tree = view.tree
    findButtonByText(tree, t('distill.view.history.heading')).props.onClick()
    tree = view.render()
    findButtonByText(tree, t('distill.view.history.openResult')).props.onClick()
    tree = view.render()
    assert.ok(textOf(tree).includes(t('distill.view.result.pinHint')),
      'opening a history summary pins the result page')

    // Poll #2 also lists a live run: the pinned record still wins.
    await pollTick()
    tree = view.render()
    assert.ok(textOf(tree).includes(t('distill.view.result.heading')),
      'a history result is not replaced by a newer active run')
    assert.ok(!textOf(tree).includes(t('distill.view.running.heading')),
      'the active run does not steal the history result page')

    // Poll #3: the pinned record disappeared from the Host list.
    await pollTick()
    tree = view.render()
    const text = textOf(tree)
    assert.ok(text.includes(t('distill.view.result.notFound')),
      'a vanished pinned record reports result.notFound')
    assert.ok(text.includes(t('distill.view.config.listTitle')),
      'the user lands on a usable config page')
    assert.ok(!text.includes(t('distill.view.result.pinHint')), 'the pin is released')
  } finally {
    view.dispose()
  }
})

/* -------------------------------------------------------- refined markers */

test('refined: applied history aggregates per-session counts/files/latest and the card renders the marker', async () => {
  const firstApplied = {
    id: 'run-a',
    workspaceId: 'ws-1',
    status: 'applied',
    appliedAt: NOW - 2 * 86_400_000,
    sessions: [{ sessionId: 's-1' }, { sessionId: 's-2' }],
    applyResult: { applied: [{ file: 'a.md' }, { file: 'b.md' }] },
  }
  const secondApplied = {
    id: 'run-b',
    workspaceId: 'ws-1',
    status: 'applied',
    appliedAt: NOW - 3_600_000,
    sessions: [{ sessionId: 's-1' }],
    applyResult: { applied: [{ file: 'c.md' }] },
  }
  const failed = {
    id: 'run-c',
    workspaceId: 'ws-1',
    status: 'failed',
    appliedAt: NOW - 1_000,
    sessions: [{ sessionId: 's-1' }],
    applyResult: { applied: [{ file: 'never.md' }] },
  }

  const markers = deriveRefinedMarkers([firstApplied, secondApplied, failed])
  assert.equal(markers.get('s-1').count, 2, 'only applied runs count')
  assert.equal(markers.get('s-1').files, 3, 'files sum run.applyResult.applied.length')
  assert.equal(markers.get('s-1').lastAt, NOW - 3_600_000, 'the newest appliedAt wins')
  assert.equal(markers.get('s-2').count, 1, 'sessions of the same run are counted once')
  assert.equal(markers.get('s-2').files, 2)
  assert.equal(markers.has('s-3'), false, 'sessions without applied history have no marker')
  assert.equal(deriveRefinedMarkers([]).size, 0)
  assert.equal(deriveRefinedMarkers(null).size, 0)

  const view = await mount({
    handler: () => jsonResponse({ ok: true, runs: [firstApplied, secondApplied, failed] }),
  })
  try {
    const tree = view.tree
    const card = findCard(tree, 's-1')
    const text = textOf(card)
    assert.ok(text.includes(countText(t('distill.view.config.refinedBadge'), 2)),
      'the card shows how many applied batches included the session')
    assert.match(text, /上次 1 小时前/, 'the card shows when it was last distilled')
    assert.ok(text.includes(fillLocaleTemplate(t('distill.view.config.refinedFiles'), { files: 3 })),
      'the card shows how many files that session wrote back')
    const badge = findNode(card, (node) => node.props?.['data-pd-tip'] === t('distill.view.config.refinedBadgeTip'))
    assert.ok(badge, 'the marker explains that the session can still be distilled again')
    assert.equal(findCard(tree, 's-3').props.style.background, 'transparent',
      'a session without applied history keeps the plain card surface')
    assert.equal(findNode(findCard(tree, 's-3'),
      (node) => node.props?.['data-pd-tip'] === t('distill.view.config.refinedBadgeTip')), undefined,
      'no marker is fabricated for an un-distilled session')
  } finally {
    view.dispose()
  }
})

/* --------------------------------------------------------------- timeline */

test('running: the timeline defaults to 12 rows, expands through logMore and collapses through logLess', async () => {
  const logs = Array.from({ length: DISTILL_TIMELINE_DEFAULT_ROWS + 3 }, (_, index) => ({
    at: NOW - (DISTILL_TIMELINE_DEFAULT_ROWS + 3 - index) * 60_000,
    stage: index % 2 === 0 ? 'stage1' : 'stage2',
    message: `narration-${index}`,
  }))
  const live = {
    ...LIVE_RUN,
    createdAt: NOW - 5 * 60_000,
    progress: { stage: 'stage1', completed: 2, total: 4, log: logs },
  }
  const view = await mount({ handler: () => jsonResponse({ ok: true, runs: [live] }) })
  try {
    let tree = view.tree
    assert.equal(countTimelineRows(tree), DISTILL_TIMELINE_DEFAULT_ROWS,
      'at most 12 result rows render before expanding')
    assert.ok(textOf(tree).includes('narration-14'), 'the newest result stays visible')
    assert.ok(!textOf(tree).includes('narration-2'),
      'the oldest results are folded away instead of flooding the page')
    assert.ok(textOf(tree).includes(t('distill.view.running.timelineHint')),
      'the caption says these rows are stage results, not tool names')
    assert.ok(textOf(tree).includes(t('distill.view.running.logLatest')), 'the newest row is highlighted')
    const latestRow = collectNodes(tree).find((node) => (
      node.type === 'div'
      && node.props?.style?.background
      && textOf(node).includes('narration-14')
    ))
    assert.ok(latestRow, 'the newest row carries the panel highlight')

    const more = findButtonByText(tree, fillLocaleTemplate(t('distill.view.running.logMore'), {
      count: logs.length,
    }))
    assert.ok(more, 'the expand entry renders with the total line count')
    more.props.onClick()
    tree = view.render()
    assert.equal(countTimelineRows(tree), logs.length, 'expanding renders the whole log')
    assert.ok(textOf(tree).includes('narration-0'), 'the oldest result is reachable after expanding')
    assert.ok(findButtonByText(tree, t('distill.view.running.logLess')), 'the collapse entry renders when expanded')

    findButtonByText(tree, t('distill.view.running.logLess')).props.onClick()
    tree = view.render()
    assert.equal(countTimelineRows(tree), DISTILL_TIMELINE_DEFAULT_ROWS, 'collapsing restores the 12-row window')
    assert.ok(!textOf(tree).includes('narration-0'), 'collapsing folds the tail away again')
  } finally {
    view.dispose()
  }
})

/* ---------------------------------------------------- config batch + cards */

test('config: the sticky batch bar states the blocked-start reason and card selection uses the idle bar + panel wash', async () => {
  const view = await mount()
  try {
    let tree = view.tree
    const header = tree.children[0]
    assert.equal(header.props?.style?.position, 'sticky', 'the header with the command bar is sticky')
    const start = findButtonByText(header, t('distill.view.config.start'))
    assert.ok(start, 'the single start action lives in the sticky header batch bar')
    assert.equal(findButtonByText(tree.children[1], t('distill.view.config.start')), undefined,
      'the start action is not duplicated inside the scrolling body')
    assert.equal(start.props.disabled, true, 'start stays disabled below the 3-session minimum')

    // One selection: the batch bar states the reason in place.
    tree = view.toggle('s-1')
    const card = findCard(tree, 's-1')
    assert.match(card.props.style.borderLeftColor, /--pd-status-idle/,
      'selection uses the plugin-owned idle token for the left bar')
    assert.match(String(card.props.style.background), /--pd-bg-panel/,
      'selection uses the panel wash')
    assert.match(String(card.props.style.border), /--pd-status-idle/,
      'selection adds a fine idle hairline around the card')
    assert.doesNotMatch(JSON.stringify(card.props.style), /button-primary-fill/,
      'the host accent token never expresses selection')
    assert.equal(JSON.stringify(card.props.style).includes('boxShadow'), false,
      'selection never uses box shadows')
    assert.ok(textOf(tree).includes(t('distill.view.config.startNeedSessions')),
      'the batch bar states why start is blocked')

    // Hover uses the panel wash too, but without the selection bar.
    findCard(tree, 's-2').props.onMouseEnter()
    tree = view.render()
    const hovered = findCard(tree, 's-2')
    assert.match(String(hovered.props.style.background), /--pd-bg-panel/, 'hover uses the panel wash')
    assert.doesNotMatch(String(hovered.props.style.borderLeftColor), /--pd-status-idle/,
      'hover is not rendered as a selection')
    hovered.props.onMouseLeave()
    tree = view.render()
    assert.equal(findCard(tree, 's-2').props.style.background, 'transparent',
      'leaving the card restores the page surface')

    // Three selections unlock start and the bar shows the material readout.
    view.toggle('s-2')
    tree = view.toggle('s-3')
    const enabled = findButtonByText(tree, t('distill.view.config.start'))
    assert.equal(enabled.props.disabled, false, 'three selections unlock start')
    assert.equal(enabled.props.tip, t('distill.view.config.startHint'),
      'the enabled action advertises what it does')
    const headerText = textOf(tree.children[0])
    assert.ok(headerText.includes(countText(t('distill.view.config.selectedCount'), 3)),
      'the batch bar shows the selected session count')
    assert.ok(headerText.includes(countText(t('distill.view.config.summaryFindings'), 3)),
      'the batch bar shows the material total of the selection')
  } finally {
    view.dispose()
  }
})

test('result: an old applied run without an apply record explains the missing stats instead of offering an interactive confirm page', async () => {
  const legacy = {
    id: 'run-legacy',
    workspaceId: 'ws-1',
    status: 'applied',
    appliedAt: NOW - 5 * 86_400_000,
    sessions: [{ sessionId: 's-1' }],
    usage: { calls: 2, totalTokens: 900 },
  }
  const view = await mount({
    confirm: makeMockConfirm,
    handler: (call) => {
      if (call.method === 'GET' && call.url.includes('distill-run')) {
        return jsonResponse({ ok: true, runs: [legacy] })
      }
      return jsonResponse({ ok: true, runs: [] })
    },
  })
  try {
    let tree = view.tree
    findButtonByText(tree, t('distill.view.history.heading')).props.onClick()
    tree = view.render()
    findButtonByText(tree, t('distill.view.history.openResult')).props.onClick()
    tree = view.render()
    const text = textOf(tree)
    assert.ok(text.includes(t('distill.confirm.applied.statsMissing')),
      'the legacy record explains that no write-back stats were persisted')
    assert.ok(!text.includes('MOCK-CONFIRM'),
      'no interactive confirmation page is mounted for an already applied legacy run')
    assert.ok(text.includes(fillLocaleTemplate(t('distill.view.usage.calls'), { count: 2 })),
      'run.usage still renders on the result page')
    assert.ok(text.includes(t('distill.view.result.summaryHeading')),
      'the session summaries section keeps its heading')
    assert.equal(view.confirmCalls.length, 0, 'the ledger component is not mounted without an applied record')
  } finally {
    view.dispose()
  }
})
