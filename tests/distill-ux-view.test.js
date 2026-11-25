/**
 * UX rework of DistillView (config card grid / debounced material pre-check /
 * semantic running timeline / two-step cancel / history delete / retry / usage).
 *
 * Harness: same self-contained hook runtime as tests/distill-view.test.js —
 * index-based state/ref slots, memoized deps, effects with explicit flush, and
 * function components expanded into plain vnodes so button/row lookups work.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  DISTILL_ESTIMATE_DEBOUNCE_MS,
  DISTILL_TIMELINE_MAX_ROWS,
  createDistillView,
  fillLocaleTemplate,
  formatElapsedDuration,
  normalizeRunSessionIds,
} from '../src/client/ui/distill-view.js'
import { countText, formatLocalTime } from '../src/client/ui/bits.js'
import { dictionaries } from '../src/locale.js'

// Real zh dictionary: the UX copy assertions below are the shipped strings, not
// just key echoes (the module's key contract is covered by the existing
// tests/distill-view.test.js pairing test).
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

const findButtonByAria = (tree, label) => findNode(
  tree,
  (node) => node.type === 'button' && (node.props?.['aria-label'] === label || node.props?.title === label),
)

const findCard = (tree, sessionId) => findNode(
  tree,
  (node) => node.type === 'label' && node.props?.key === sessionId,
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

/** globalThis.fetch stub in the shape of tests/distill-view.test.js. */
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

const NOW = Date.now()

const SOURCE = {
  sessions: [
    { sessionId: 's-1', title: 'Refactor store', updatedAt: NOW - 5 * 60_000 },
    { sessionId: 's-2', title: 'Fix queue bug', updatedAt: NOW - 2 * 3_600_000 },
    { sessionId: 's-3', title: 'Write docs', updatedAt: NOW - 3 * 86_400_000 },
    { sessionId: 's-4', title: 'Archived work', updatedAt: NOW - 10 * 60_000 },
  ],
  findings: [
    { sessionId: 's-1', updatedAt: NOW - 5 * 60_000 },
    { sessionId: 's-1', updatedAt: NOW - 4 * 60_000 },
    { sessionId: 's-3', updatedAt: NOW - 3 * 86_400_000 },
  ],
  promptLogs: [{ sessionId: 's-1', updatedAt: NOW - 4 * 60_000 }],
  archivedSessionIds: ['s-4'],
}

const ESTIMATE = {
  sessions: [
    { sessionId: 's-1', title: 'Refactor store', findings: 2, promptLogs: 1 },
    { sessionId: 's-2', title: 'Fix queue bug', findings: 0, promptLogs: 0 },
    { sessionId: 's-3', title: 'Write docs', findings: 1, promptLogs: 0 },
  ],
  totalMaterials: 4,
  totalTokens: 19200,
  contextWindow: 128000,
  model: 'deepseek-chat',
  budget: { maxTokens: 90000, usedTokens: 19200, truncated: false },
  stage1Calls: 3,
  stage2Calls: 1,
}

/** Render the view, flush the mount effects and return the settled tree. */
async function mount(options = {}) {
  const handler = typeof options === 'function' ? options : options.handler
  const props = (typeof options === 'function' ? {} : options.props) ?? {}
  const fetchStub = stubFetch(handler || (() => jsonResponse({ ok: true, runs: [] })))
  const runtime = createHookRuntime()
  const DistillView = createDistillView({
    h,
    React: runtime.React,
    services: { loadDistillSource: () => SOURCE },
    t,
  })
  const viewProps = { workspaceId: 'ws-1', ...props }
  let tree = runtime.render(DistillView, viewProps)
  await runtime.flushEffects()
  await tick()
  tree = runtime.render(DistillView, viewProps)
  return {
    runtime,
    DistillView,
    props: viewProps,
    fetchStub,
    get tree() { return tree },
    render() {
      tree = runtime.render(DistillView, viewProps)
      return tree
    },
    /** Toggle one candidate card through its keyboard handler. */
    toggle(sessionId) {
      const card = findCard(tree, sessionId)
      assert.ok(card, `card for ${sessionId} renders`)
      card.props.onKeyDown({ key: 'Enter', preventDefault() {} })
      tree = runtime.render(DistillView, viewProps)
      return tree
    },
    dispose() {
      runtime.cleanupAll()
      fetchStub.restore()
    },
  }
}

// ------------------------------------------------------------------- config

test('config: the batch list is an auto-fill card grid with hairline cards and token-owned selection', async () => {
  const view = await mount()
  try {
    const tree = view.tree
    const grid = findNode(tree, (node) => (
      node.type === 'div'
      && node.props?.style?.display === 'grid'
      && String(node.props.style.gridTemplateColumns).includes('minmax(260px, 1fr)')
    ))
    assert.ok(grid, 'the candidate list renders as an auto-fill grid')
    assert.ok(String(grid.props.style.gridTemplateColumns).includes('repeat(auto-fill'),
      'columns use repeat(auto-fill, minmax(260px, 1fr))')
    assert.equal(grid.props.style.boxShadow, undefined, 'cards never use box-shadow')

    const plain = findCard(tree, 's-1')
    assert.ok(plain, 'candidate cards render')
    assert.equal(textOf(plain).includes('Refactor store'), true, 'the session title renders')
    assert.ok(textOf(plain).includes(`2 ${t('distill.view.config.findingsUnit')}`),
      'finding counts render on the card')
    assert.ok(textOf(plain).includes(`1 ${t('distill.view.config.promptLogsUnit')}`),
      'prompt-log counts render on the card')
    assert.match(textOf(plain), /\d+ 分钟前/,
      'the relative time is right-aligned on the card footer')
    assert.equal(plain.props.style.background, 'transparent',
      'an unselected card keeps the page surface')

    // Archived sessions stay hidden until the toggle is used.
    assert.equal(findCard(tree, 's-4'), undefined, 'archived cards stay folded by default')
    const archivedToggle = findNode(tree, (node) => (
      node.type === 'button'
      && (node.props?.tip === t('distill.view.config.showArchivedHint')
        || node.props?.['data-pd-tip'] === t('distill.view.config.showArchivedHint'))
    ))
    assert.ok(archivedToggle, 'the archived toggle renders when archived candidates exist')
    archivedToggle.props.onClick()
    const expanded = view.render()
    const archivedCard = findCard(expanded, 's-4')
    assert.ok(archivedCard, 'the archived card appears after the toggle')
    assert.ok(textOf(archivedCard).includes(t('distill.view.config.archivedBadge')),
      'the archived badge renders on the card')

    // Selection: --pd-status-idle left bar + --pd-bg-panel wash, no accent token.
    const toggled = view.toggle('s-1')
    const selectedCard = findCard(toggled, 's-1')
    assert.match(selectedCard.props.style.borderLeftColor, /--pd-status-idle/,
      'selection uses the plugin-owned idle token, not the host accent token')
    assert.match(String(selectedCard.props.style.background), /--pd-bg-panel/,
      'selection uses the panel wash')
    assert.doesNotMatch(JSON.stringify(selectedCard.props.style), /button-primary-fill/,
      'the host accent token is never used for selection')
    assert.equal(selectedCard.props.tabIndex, 0, 'the card is keyboard reachable')
    const checkbox = findNode(selectedCard, (node) => node.type === 'input' && node.props?.type === 'checkbox')
    assert.equal(checkbox.props.checked, true, 'the a11y checkbox mirrors the selection')
  } finally {
    view.dispose()
  }
})

test('config: an empty source renders the shared empty state', async () => {
  const fetchStub = stubFetch(() => jsonResponse({ ok: true, runs: [] }))
  const runtime = createHookRuntime()
  const DistillView = createDistillView({
    h,
    React: runtime.React,
    services: { loadDistillSource: () => ({ sessions: [], findings: [], promptLogs: [], archivedSessionIds: [] }) },
    t,
  })
  try {
    let tree = runtime.render(DistillView, { workspaceId: 'ws-1' })
    await runtime.flushEffects()
    await tick()
    tree = runtime.render(DistillView, { workspaceId: 'ws-1' })
    assert.ok(textOf(tree).includes(t('distill.view.config.empty')), 'empty label renders')
    assert.ok(textOf(tree).includes(t('distill.view.config.emptyHint')), 'empty hint renders')
    assert.equal(findNode(tree, (node) => node.type === 'div'
      && node.props?.style?.display === 'grid'), undefined, 'no grid is rendered without candidates')
  } finally {
    runtime.cleanupAll()
    fetchStub.restore()
  }
})

// ----------------------------------------------------------------- estimate

test('estimate: 3~7 selected sessions trigger one debounced GET and render the pre-check lines', async () => {
  const view = await mount((call) => {
    if (call.url.includes('distill-estimate')) return jsonResponse({ ok: true, estimate: ESTIMATE })
    return jsonResponse({ ok: true, runs: [] })
  })
  try {
    view.toggle('s-1')
    await view.runtime.flushEffects()
    view.toggle('s-2')
    await view.runtime.flushEffects()
    view.toggle('s-3')
    await view.runtime.flushEffects()
    await view.render()

    assert.equal(view.fetchStub.calls.filter((call) => call.url.includes('distill-estimate')).length, 0,
      'no estimate request before the debounce window elapses')

    await delay(DISTILL_ESTIMATE_DEBOUNCE_MS + 60)
    const tree = view.render()

    const estimateCalls = view.fetchStub.calls.filter((call) => call.url.includes('distill-estimate'))
    assert.equal(estimateCalls.length, 1, 'the three quick toggles coalesce into one request')
    const url = estimateCalls[0].url
    assert.ok(url.startsWith('api/punch-desk/distill-estimate?'), 'the estimate route is used')
    assert.ok(url.includes('workspaceId=ws-1'), 'the workspace is forwarded')
    assert.ok(url.includes('sessions=s-1,s-2,s-3'), 'the batch is forwarded as a comma list')
    assert.ok(estimateCalls[0].signal, 'the request carries an AbortSignal')

    const text = textOf(tree)
    assert.ok(text.includes(fillLocaleTemplate(t('distill.view.config.estimate'), {
      materials: ESTIMATE.totalMaterials,
      tokens: ESTIMATE.totalTokens,
    })), 'the material/token estimate renders')
    assert.ok(text.includes(fillLocaleTemplate(t('distill.view.config.estimatePercent'), {
      percent: Math.round((ESTIMATE.totalTokens / ESTIMATE.contextWindow) * 100),
    })), 'the context-window percentage renders')
    assert.ok(text.includes(fillLocaleTemplate(t('distill.view.config.estimateModel'), {
      model: ESTIMATE.model,
    })), 'the probed model renders')
    assert.ok(text.includes(fillLocaleTemplate(t('distill.view.config.estimateCalls'), {
      stage1: ESTIMATE.stage1Calls,
      stage2: ESTIMATE.stage2Calls,
    })), 'the call count renders')
    assert.ok(!text.includes(t('distill.view.config.estimateFailed')),
      'a successful pre-check does not show the failure line')
  } finally {
    view.dispose()
  }
})

test('estimate: a truncated budget shows the warn line', async () => {
  const view = await mount((call) => {
    if (call.url.includes('distill-estimate')) {
      return jsonResponse({
        ok: true,
        estimate: { ...ESTIMATE, budget: { maxTokens: 9000, usedTokens: 19200, truncated: true } },
      })
    }
    return jsonResponse({ ok: true, runs: [] })
  })
  try {
    view.toggle('s-1')
    await view.runtime.flushEffects()
    view.toggle('s-2')
    await view.runtime.flushEffects()
    view.toggle('s-3')
    await view.runtime.flushEffects()

    await delay(DISTILL_ESTIMATE_DEBOUNCE_MS + 60)
    const text = textOf(view.render())
    assert.ok(text.includes(fillLocaleTemplate(t('distill.view.config.estimateTruncated'), {
      tokens: 9000,
    })), 'the truncated budget line renders with the budget limit')
  } finally {
    view.dispose()
  }
})

test('estimate: shrinking the batch cancels the pending debounce and the next legal batch re-requests', async () => {
  const view = await mount((call) => {
    if (call.url.includes('distill-estimate')) return jsonResponse({ ok: true, estimate: ESTIMATE })
    return jsonResponse({ ok: true, runs: [] })
  })
  try {
    view.toggle('s-1')
    await view.runtime.flushEffects()
    view.toggle('s-2')
    await view.runtime.flushEffects()
    view.toggle('s-3')
    await view.runtime.flushEffects()

    // Back below the minimum inside the debounce window: the pending request
    // must be cancelled by the effect cleanup, never fired for a stale batch.
    await delay(120)
    view.toggle('s-2')
    await view.runtime.flushEffects()
    await delay(DISTILL_ESTIMATE_DEBOUNCE_MS + 60)
    view.render()
    assert.equal(view.fetchStub.calls.filter((call) => call.url.includes('distill-estimate')).length, 0,
      'a superseded batch never reaches the Host')

    // A new legal batch re-arms the pre-check.
    view.toggle('s-2')
    await view.runtime.flushEffects()
    await delay(DISTILL_ESTIMATE_DEBOUNCE_MS + 60)
    view.render()
    const calls = view.fetchStub.calls.filter((call) => call.url.includes('distill-estimate'))
    assert.equal(calls.length, 1, 'the next legal batch issues exactly one estimate request')
    assert.ok(calls[0].url.includes('sessions=s-1,s-2,s-3'),
      'the request carries the current batch only')
  } finally {
    view.dispose()
  }
})

test('estimate: a failed or empty pre-check shows estimateFailed and never blocks starting', async () => {
  const run = { id: 'run-1', workspaceId: 'ws-1', status: 'queued', sessions: [], progress: { stage: 'snapshotting', completed: 0, total: 3 } }
  const view = await mount((call) => {
    if (call.method === 'POST' && call.url.includes('distill-run')) return jsonResponse({ ok: true, run })
    if (call.url.includes('distill-estimate')) return jsonResponse({ ok: true })
    return jsonResponse({ ok: true, runs: [] })
  })
  try {
    view.toggle('s-1')
    await view.runtime.flushEffects()
    view.toggle('s-2')
    await view.runtime.flushEffects()
    view.toggle('s-3')
    await view.runtime.flushEffects()
    await delay(DISTILL_ESTIMATE_DEBOUNCE_MS + 60)
    const tree = view.render()

    assert.ok(textOf(tree).includes(t('distill.view.config.estimateFailed')),
      'the failed pre-check reports itself honestly')

    const start = findButtonByText(tree, t('distill.view.config.start'))
    assert.equal(start.props.disabled, false, 'the estimate failure never blocks the start action')
    assert.equal(start.props.tip, t('distill.view.config.startHint'),
      'the start action keeps its shipped enabled hint')
    await start.props.onClick()
    assert.ok(view.fetchStub.calls.some((call) => call.method === 'POST' && call.url.includes('distill-run')),
      'starting still posts the batch')
    assert.deepEqual(
      view.fetchStub.calls.find((call) => call.method === 'POST' && call.url.includes('distill-run')).body,
      { workspaceId: 'ws-1', sessions: ['s-1', 's-2', 's-3'] },
      'the start body is unchanged',
    )
  } finally {
    view.dispose()
  }
})

// ------------------------------------------------------------------ running

const liveRun = (progressLog) => ({
  id: 'run-live',
  workspaceId: 'ws-1',
  status: 'analyzing',
  createdAt: NOW - 3_600_000 - 5 * 60_000,
  sessions: [
    { sessionId: 's-1', title: 'Refactor store', archived: false },
    { sessionId: 's-2', title: 'Fix queue bug', archived: false },
    { sessionId: 's-3', title: 'Write docs', archived: false },
  ],
  progress: {
    stage: 'stage1',
    completed: 2,
    total: 4,
    log: progressLog,
  },
})

test('running: progress.log becomes a newest-first HH:mm timeline capped by DISTILL_TIMELINE_MAX_ROWS, with elapsed time', async () => {
  const logs = Array.from({ length: DISTILL_TIMELINE_MAX_ROWS + 2 }, (_, index) => ({
    at: NOW - (DISTILL_TIMELINE_MAX_ROWS + 2 - index) * 60_000,
    stage: index % 2 === 0 ? 'stage1' : 'stage2',
    message: `narration-${index}`,
  }))
  const view = await mount(() => jsonResponse({ ok: true, runs: [liveRun(logs)] }))
  try {
    const tree = view.tree
    const rows = collectNodes(tree).filter((node) => (
      node.type === 'div'
      && Array.isArray(node.children)
      && node.children[0]
      && node.children[0].type === 'span'
      && /^\d{2}:\d{2}$/.test(textOf(node.children[0]))
    ))
    assert.equal(rows.length, DISTILL_TIMELINE_MAX_ROWS, 'the timeline renders at most the configured row budget')
    assert.ok(textOf(tree).includes(`narration-${logs.length - 1}`),
      'the newest narration is kept')
    assert.ok(!textOf(tree).includes('narration-0'),
      'the oldest narration is dropped from the visible timeline')
    assert.ok(textOf(tree).includes(formatLocalTime(logs[logs.length - 1].at)),
      'timeline rows render HH:mm timestamps')
    assert.ok(textOf(tree).includes(t('distill.view.stage.stage2')),
      'timeline rows and the stage line use localized stage labels')
    assert.match(textOf(tree), /1:05:\d\d/,
      'the elapsed time renders from the run creation stamp')
    assert.ok(textOf(tree).includes('2/4'), 'the thin bar keeps its completed/total counter')
    assert.ok(!textOf(tree).includes(t('distill.view.running.progress')),
      'the bare progress label is gone')
  } finally {
    view.dispose()
  }
})

test('running: an empty progress log shows logEmpty instead of a fabricated timeline', async () => {
  const view = await mount(() => jsonResponse({ ok: true, runs: [liveRun([])] }))
  try {
    const text = textOf(view.tree)
    assert.ok(text.includes(t('distill.view.running.logTitle')), 'the timeline caption renders')
    assert.ok(text.includes(t('distill.view.running.logEmpty')), 'the empty narration label renders')
    assert.ok(text.includes(t('distill.view.running.heading')), 'the running heading stays')
  } finally {
    view.dispose()
  }
})

test('running: cancel is a two-step confirmation and the first click writes nothing', async () => {
  const view = await mount((call) => {
    if (call.method === 'POST' && call.url.includes('distill-cancel')) {
      return jsonResponse({ ok: true, status: 'cancelRequested', runStatus: 'analyzing' })
    }
    return jsonResponse({ ok: true, runs: [liveRun([])] })
  })
  try {
    let tree = view.tree
    const cancel = findButtonByText(tree, t('distill.view.running.cancel'))
    assert.ok(cancel, 'the cancel entry renders while running')
    cancel.props.onClick()
    tree = view.render()

    assert.equal(view.fetchStub.calls.filter((call) => call.url.includes('distill-cancel')).length, 0,
      'the first click does not write to the Host')
    const text = textOf(tree)
    assert.ok(text.includes(t('distill.view.running.cancelConfirm')), 'the consequence is explained')
    assert.ok(text.includes(t('distill.view.running.cancelYes')), 'the confirm action renders')
    assert.ok(text.includes(t('distill.view.running.cancelNo')), 'the keep-waiting action renders')

    findButtonByText(tree, t('distill.view.running.cancelNo')).props.onClick()
    tree = view.render()
    assert.equal(view.fetchStub.calls.filter((call) => call.url.includes('distill-cancel')).length, 0,
      'declining the confirmation writes nothing either')
    assert.ok(textOf(tree).includes(t('distill.view.running.cancel')), 'the cancel entry returns')

    findButtonByText(tree, t('distill.view.running.cancel')).props.onClick()
    tree = view.render()
    await findButtonByText(tree, t('distill.view.running.cancelYes')).props.onClick()
    tree = view.render()

    const cancelPost = view.fetchStub.calls.find((call) => call.url.includes('distill-cancel'))
    assert.ok(cancelPost, 'the confirmed cancel posts distill-cancel')
    assert.equal(cancelPost.url, 'api/punch-desk/distill-cancel')
    assert.deepEqual(cancelPost.body, { runId: 'run-live' })
    assert.ok(textOf(tree).includes(t('distill.lock.cancelRequested')),
      'cancel feedback reuses the shipped lock key')
  } finally {
    view.dispose()
  }
})

// ------------------------------------------------------------ retry + result

test('retry: a failed run keeps the start-over entry and re-posts the SAME batch', async () => {
  const failedRun = {
    ...liveRun([]),
    status: 'failed',
    error: { code: 'ANALYZER_TIMEOUT', message: 'model call timed out' },
  }
  const restarted = { ...liveRun([]), id: 'run-2', status: 'queued' }
  const view = await mount((call) => {
    if (call.method === 'POST' && call.url.includes('distill-run')) return jsonResponse({ ok: true, run: restarted })
    return jsonResponse({ ok: true, runs: [failedRun] })
  })
  try {
    let tree = view.tree
    const alert = findNode(tree, (node) => node.props?.role === 'alert')
    assert.ok(alert, 'the persisted failure renders an alert banner')
    assert.ok(textOf(alert).includes(t('distill.view.error.runFailed')), 'the failure label renders')
    assert.ok(textOf(alert).includes('(ANALYZER_TIMEOUT)'), 'the persisted code stays visible')

    const retry = findButtonByText(tree, t('distill.view.running.retry'))
    assert.ok(retry, 'the start-over entry renders on a failed run')
    await retry.props.onClick()

    const post = view.fetchStub.calls.find((call) => call.method === 'POST' && call.url.includes('distill-run'))
    assert.ok(post, 'the retry posts distill-run again')
    assert.deepEqual(post.body, {
      workspaceId: 'ws-1',
      sessions: ['s-1', 's-2', 's-3'],
    }, 'the retry reuses run.sessions instead of an empty config')
    tree = view.render()
    assert.ok(!findButtonByText(tree, t('distill.view.running.retry')),
      'the retry entry disappears while the new run is live')
  } finally {
    view.dispose()
  }
})

test('result: run.usage renders its rows and omits missing fields', async () => {
  const applied = {
    id: 'run-done',
    workspaceId: 'ws-1',
    status: 'applied',
    appliedAt: NOW - 60_000,
    sessions: [{ sessionId: 's-1' }, { sessionId: 's-2' }, { sessionId: 's-3' }],
    usage: { calls: 4, inputTokens: 12000, totalTokens: 15000 },
  }
  const view = await mount(() => jsonResponse({ ok: true, runs: [applied] }))
  try {
    let tree = view.tree
    const history = findButtonByText(tree, t('distill.view.history.heading'))
    history.props.onClick()
    tree = view.render()

    const openResult = findButtonByText(tree, t('distill.view.history.openResult'))
    assert.ok(openResult, 'an applied history row keeps the summary entry')
    openResult.props.onClick()
    tree = view.render()

    const text = textOf(tree)
    assert.ok(text.includes(t('distill.view.result.heading')), 'the result page renders')
    assert.ok(text.includes(t('distill.view.usage.title')), 'the usage block title renders')
    assert.ok(text.includes(fillLocaleTemplate(t('distill.view.usage.calls'), { count: 4 })),
      'the model call count renders')
    assert.ok(text.includes(fillLocaleTemplate(t('distill.view.usage.tokensIn'), { tokens: 12000 })),
      'the input token row renders')
    assert.ok(text.includes(fillLocaleTemplate(t('distill.view.usage.total'), { tokens: 15000 })),
      'the total token row renders')
    assert.ok(!text.includes(fillLocaleTemplate(t('distill.view.usage.tokensOut'), { tokens: 0 })),
      'a missing output-token field omits its row')
  } finally {
    view.dispose()
  }
})

// ------------------------------------------------------------------ history

const finishedRun = {
  id: 'run-failed',
  workspaceId: 'ws-1',
  status: 'failed',
  createdAt: NOW - 2 * 86_400_000,
  sessions: [{ sessionId: 's-1' }, { sessionId: 's-2' }, { sessionId: 's-3' }],
  error: { code: 'ANALYZER_TIMEOUT', message: 'timeout' },
}

async function openHistory(view) {
  const history = findButtonByText(view.tree, t('distill.view.history.heading'))
  assert.ok(history, 'the history entry renders in config')
  history.props.onClick()
  return view.render()
}

test('history: delete is a two-step confirmation, removes the row and reports the success note', async () => {
  const view = await mount((call) => {
    if (call.method === 'POST' && call.url.includes('distill-delete')) return jsonResponse({ ok: true })
    return jsonResponse({ ok: true, runs: [finishedRun] })
  })
  try {
    let tree = await openHistory(view)
    assert.ok(textOf(tree).includes(t('distill.view.run.status.failed')),
      'the localized status badge renders on the history row')
    assert.ok(textOf(tree).includes(countText(t('distill.view.history.sessions'), 3)),
      'the session count renders on the history row')

    const deleteButton = findButtonByAria(tree, t('distill.view.history.delete'))
    assert.ok(deleteButton, 'the icon-only delete button renders')
    deleteButton.props.onClick()
    tree = view.render()

    assert.equal(view.fetchStub.calls.filter((call) => call.url.includes('distill-delete')).length, 0,
      'the first click only enters the confirmation state')
    assert.ok(textOf(tree).includes(t('distill.view.history.deleteConfirm')),
      'the irreversible consequence is explained')
    assert.ok(textOf(tree).includes(t('distill.view.history.deleteYes')), 'the confirm action renders')
    assert.ok(textOf(tree).includes(t('distill.view.history.deleteNo')), 'the keep action renders')

    await findButtonByText(tree, t('distill.view.history.deleteYes')).props.onClick()
    tree = view.render()

    const post = view.fetchStub.calls.find((call) => call.method === 'POST' && call.url.includes('distill-delete'))
    assert.ok(post, 'the confirmed delete posts distill-delete')
    assert.equal(post.url, 'api/punch-desk/distill-delete')
    assert.deepEqual(post.body, { runId: 'run-failed' })
    assert.ok(textOf(tree).includes(t('distill.view.history.deleted')), 'the success note renders')
    assert.ok(!textOf(tree).includes('run-failed'), 'the deleted row leaves the local list')
    assert.ok(textOf(tree).includes(t('distill.view.history.empty')), 'the list falls back to its empty state')
  } finally {
    view.dispose()
  }
})

test('history: a rejected delete keeps the row and maps RUN_NOT_READY through the error-code locale', async () => {
  const view = await mount((call) => {
    if (call.method === 'POST' && call.url.includes('distill-delete')) {
      return jsonResponse({ ok: false, error: { code: 'RUN_NOT_READY', message: 'not finished' } })
    }
    return jsonResponse({ ok: true, runs: [finishedRun] })
  })
  try {
    let tree = await openHistory(view)
    findButtonByAria(tree, t('distill.view.history.delete')).props.onClick()
    tree = view.render()
    await findButtonByText(tree, t('distill.view.history.deleteYes')).props.onClick()
    tree = view.render()

    const text = textOf(tree)
    assert.ok(text.includes(t('distill.view.history.deleteFailed')), 'the failure note renders')
    assert.ok(text.includes(t('distill.view.error.code.RUN_NOT_READY')),
      'the Host code resolves through the distill.view.error.code.* label')
    assert.ok(text.includes(t('distill.view.run.status.failed')), 'the rejected row stays in the list')
  } finally {
    view.dispose()
  }
})

test('history: the delete and open-result affordances follow the run status', () => {
  const source = fs.readFileSync(new URL('../src/client/ui/distill-view.js', import.meta.url), 'utf8')
  assert.match(source, /DELETABLE_RUN_STATUSES = new Set\(\['applied', 'failed', 'canceled', 'stale', 'superseded'\]\)/,
    'only terminal runs are deletable')
  assert.match(source, /distill\.view\.error\.code\.RUN_NOT_READY/,
    'a non-deletable row explains itself with the RUN_NOT_READY label')
  assert.match(source, /api\/punch-desk\/distill-delete/,
    'the delete action posts the distill-delete route')
  assert.doesNotMatch(source, /boxShadow/,
    'the UX rework never introduces box shadows')
  assert.doesNotMatch(source, /\p{Extended_Pictographic}/u,
    'no emoji are introduced')
})

// -------------------------------------------------------------------- pure

test('formatElapsedDuration: locale-free minute/second stamps', () => {
  assert.equal(formatElapsedDuration(0), '0:00')
  assert.equal(formatElapsedDuration(65_000), '1:05')
  assert.equal(formatElapsedDuration(3_600_000 + 5 * 60_000 + 9_000), '1:05:09')
  assert.equal(formatElapsedDuration(-1), '')
  assert.equal(formatElapsedDuration(Number.NaN), '')
  assert.equal(formatElapsedDuration('nope'), '')
})

test('normalizeRunSessionIds: accepts domain session objects and bare ids', () => {
  assert.deepEqual(
    normalizeRunSessionIds({ sessions: [{ sessionId: 'a' }, 'b', null, { title: 'no id' }] }),
    ['a', 'b'],
  )
  assert.deepEqual(normalizeRunSessionIds({}), [])
  assert.deepEqual(normalizeRunSessionIds(null), [])
})
