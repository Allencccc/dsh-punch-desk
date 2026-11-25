import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_EXECUTING_GROUPS,
  deriveGroupExecutionStatus,
  sessionElapsedTurns,
  nextGroupNumber,
  createGroupRecord,
  addItemToGroup,
  removeItemFromGroup,
  countExecutingGroups,
  canCreateGroup,
  planGroupWrapUp,
} from '../src/domain/active-group.js'
import { createEntry, createFindingRecord } from '../src/domain/entries.js'
import { createLocalDeskStore } from '../src/store/local.js'
import { createSubmitService } from '../src/client/platform/submit.js'
import { createSessionPane, deriveHarnessProjection, summarizeOpenWork } from '../src/client/ui/session-pane.js'
import { TIP_ATTR } from '../src/client/ui/tooltip-layer.js'
import { dictionaries } from '../src/locale.js'

const dicts = dictionaries()
const t = (key) => dicts.zh[key] ?? key
const tEn = (key) => dicts.en[key] ?? key

const h = (type, props, ...children) => ({
  type,
  props: props ?? {},
  children: children.flat(Infinity),
})

function createMemoryStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    get length() { return map.size },
    key: (i) => Array.from(map.keys())[i] ?? null,
  }
}

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
      const set = value => states.set(index, typeof value === 'function' ? value(states.get(index)) : value)
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
    useLayoutEffect(fn, deps) {
      this.useEffect(fn, deps)
    },
  }

  return {
    React,
    render(Component, props) {
      hookCursor = 0
      effectCursor = 0
      const tree = Component(props)
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
      return expandVNode(tree)
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
  }
}

test('3-group executing limit: canCreateGroup enforces MAX_EXECUTING_GROUPS and frees quota upon completion', () => {
  const f1 = createFindingRecord({ id: 'f-1', sessionId: 's-1', text: 'Issue 1', submissionStatus: 'submitted' })
  const f2 = createFindingRecord({ id: 'f-2', sessionId: 's-1', text: 'Issue 2', submissionStatus: 'submitted' })
  const f3 = createFindingRecord({ id: 'f-3', sessionId: 's-1', text: 'Issue 3', submissionStatus: 'submitted' })

  const findingsMap = new Map([
    [f1.id, f1],
    [f2.id, f2],
    [f3.id, f3],
  ])

  // Group 1: 1 item, executed
  const g1 = createGroupRecord({ id: 'g-1', groupNumber: 1, sessionId: 's-1', workspaceId: 'w-1', items: [{ findingId: 'f-1', order: 1 }] })
  // Group 2: 1 item, executed
  const g2 = createGroupRecord({ id: 'g-2', groupNumber: 2, sessionId: 's-1', workspaceId: 'w-1', items: [{ findingId: 'f-2', order: 1 }] })
  // Group 3: empty group -> counts as executing
  const g3 = createGroupRecord({ id: 'g-3', groupNumber: 3, sessionId: 's-1', workspaceId: 'w-1', items: [] })

  // When projections for f1 and f2 are 'running'
  const runningProjections = () => 'running'
  assert.equal(countExecutingGroups([g1, g2, g3], findingsMap, runningProjections), 3)
  assert.equal(canCreateGroup([g1, g2, g3], findingsMap, runningProjections), false)

  // When projections for f1 and f2 become 'executed':
  // g1 and g2 become 'completed'!
  const executedProjections = (id) => (id === 'f-1' || id === 'f-2' ? 'executed' : 'running')
  assert.equal(deriveGroupExecutionStatus(g1, findingsMap, executedProjections), 'completed')
  assert.equal(deriveGroupExecutionStatus(g2, findingsMap, executedProjections), 'completed')
  assert.equal(deriveGroupExecutionStatus(g3, findingsMap, executedProjections), 'executing')

  // Executing count drops to 1, freeing quota to create new groups without any archive action
  assert.equal(countExecutingGroups([g1, g2, g3], findingsMap, executedProjections), 1)
  assert.equal(canCreateGroup([g1, g2, g3], findingsMap, executedProjections), true)
})

test('Monotonic group numbering: 1..N strictly increasing and never reused', () => {
  assert.equal(nextGroupNumber([]), 1)
  const g1 = createGroupRecord({ id: 'g-1', groupNumber: 1, sessionId: 's-1', workspaceId: 'w-1' })
  const g2 = createGroupRecord({ id: 'g-2', groupNumber: 2, sessionId: 's-1', workspaceId: 'w-1' })
  assert.equal(nextGroupNumber([g1, g2]), 3)

  // Even if g1 was removed or completed, max existing groupNumber determines the next
  assert.equal(nextGroupNumber([g2]), 3)

  const g5 = createGroupRecord({ id: 'g-5', groupNumber: 5, sessionId: 's-1', workspaceId: 'w-1' })
  assert.equal(nextGroupNumber([g1, g5]), 6)
})

test('Session elapsed turns calculation and localized formatting', () => {
  // A persisted group.turns is legacy bookkeeping and must not override the
  // derived session elapsed count.
  const g1 = createGroupRecord({ id: 'g-1', groupNumber: 2, sessionId: 's-1', workspaceId: 'w-1', startTurn: 3, turns: 99 })
  assert.equal(sessionElapsedTurns(g1, 7), 4)
  assert.equal(sessionElapsedTurns(g1, 2), 0)
  assert.equal(sessionElapsedTurns(g1, 30), 27)

  // Chinese badge formatting
  const zhBadge = t('group.turnsBadge').replace('{turns}', String(4)).replace('{groupNumber}', String(g1.groupNumber))
  assert.equal(zhBadge, '会话经过 4 轮 / 2组')

  // English badge formatting
  const enBadge = tEn('group.turnsBadge').replace('{turns}', String(4)).replace('{groupNumber}', String(g1.groupNumber))
  assert.equal(enBadge, '4 session turns / G2')
})

test('deriveHarnessProjection maps live queue and prompt log correctly', () => {
  const unsubmittedFinding = createFindingRecord({ id: 'f-u', sessionId: 's-1', text: 'Unsubmitted', submissionStatus: 'unsubmitted' })
  assert.equal(deriveHarnessProjection(unsubmittedFinding), 'unknown')

  const queuedFinding = createFindingRecord({ id: 'f-q', sessionId: 's-1', text: 'Queued', submissionStatus: 'submitted', requestId: 'req-q' })
  const queue = [{ id: 'item-1', rpcId: 'req-q' }]
  assert.equal(deriveHarnessProjection(queuedFinding, [], queue), 'queued')

  const runningFinding = createFindingRecord({ id: 'f-r', sessionId: 's-1', text: 'Running', submissionStatus: 'submitted', requestId: 'req-r' })
  const logRunning = [{ requestId: 'req-r', status: 'sent' }]
  assert.equal(deriveHarnessProjection(runningFinding, logRunning, []), 'running')

  const executedFinding = createFindingRecord({ id: 'f-e', sessionId: 's-1', text: 'Executed', submissionStatus: 'submitted', requestId: 'req-e' })
  const logExecuted = [{ requestId: 'req-e', status: 'completed' }]
  assert.equal(deriveHarnessProjection(executedFinding, logExecuted, []), 'executed')

  const resolvedFinding = createFindingRecord({ id: 'f-res', sessionId: 's-1', text: 'Resolved', submissionStatus: 'submitted', reviewStatus: 'resolved' })
  assert.equal(deriveHarnessProjection(resolvedFinding), 'executed')

  // A queue snapshot is polled, not subscribed: after delivery the pane stops
  // polling, so the last snapshot can still list an item whose turn has already
  // completed. Completed log evidence must win, or the row stays 「已排队」 and
  // blocks wrap-up until a manual refresh.
  const staleQueue = [{ id: 'item-1', rpcId: 'req-e2', status: 'queued' }]
  const completedRow = [{ requestId: 'req-e2', status: 'completed' }]
  const finishedFinding = createFindingRecord({ id: 'f-e2', sessionId: 's-1', text: 'Finished while queued', submissionStatus: 'submitted', status: 'queued', requestId: 'req-e2' })
  assert.equal(deriveHarnessProjection(finishedFinding, completedRow, staleQueue), 'executed')
  // A delivered row also beats the stale snapshot: the turn started, so the
  // snapshot is behind.
  assert.equal(deriveHarnessProjection(finishedFinding, [{ requestId: 'req-e2', status: 'sent' }], staleQueue), 'running')
  // A tracking placeholder is not delivery evidence; the queue still decides.
  assert.equal(deriveHarnessProjection(finishedFinding, [{ requestId: 'req-e2', status: 'queued' }], staleQueue), 'queued')
})

test('SessionPane keeps the new-group button actionable at the 3-group cap', async () => {
  const { React, render, flushEffects } = createHookRuntime()

  const g1 = createGroupRecord({ id: 'g-1', groupNumber: 1, sessionId: 's-1', workspaceId: 'session:s-1', items: [] })
  const g2 = createGroupRecord({ id: 'g-2', groupNumber: 2, sessionId: 's-1', workspaceId: 'session:s-1', items: [] })
  const g3 = createGroupRecord({ id: 'g-3', groupNumber: 3, sessionId: 's-1', workspaceId: 'session:s-1', items: [] })

  const entriesStore = []
  const groupsStore = [g1, g2, g3]

  const services = {
    t,
    store: {
      listEntries: async () => entriesStore,
      putEntry: async (e) => entriesStore.push(e),
      getGroups: async () => groupsStore,
      putGroup: async (g) => groupsStore.push(g),
      subscribe: () => () => {},
      quotaWarning: () => false,
    },
    index: {
      listRecent: async () => [],
      start: () => {},
      stop: () => {},
    },
    submit: createSubmitService({ remote: { session: {} } }),
    createFinding: (args) => createFindingRecord(args),
    uuid: () => 'uuid-1',
  }

  const SessionPane = createSessionPane({ h, React, services })
  const tree = render(SessionPane, { sessionId: 's-1' })
  await flushEffects()
  const renderedTree = render(SessionPane, { sessionId: 's-1' })

  // Find the button whose tooltip is the locale-provided new-group label
  function findButtons(node) {
    const res = []
    if (!node || typeof node !== 'object') return res
    if (node.type === 'button') res.push(node)
    if (Array.isArray(node.children)) {
      for (const child of node.children) res.push(...findButtons(child))
    }
    return res
  }

  const buttons = findButtons(renderedTree)
  const newGroupBtn = buttons.find(b => b.props?.['aria-label'] === t('group.new') || b.props?.['aria-label'] === t('dock.capTitle'))
  assert.ok(newGroupBtn, 'New group button must exist')
  // UX contract: a disabled "+" is a dead end (no hover tooltip, no action).
  // At the cap it stays clickable and opens an actionable capacity popover.
  assert.notEqual(newGroupBtn.props.disabled, true, 'New group button must stay clickable at the cap')
  assert.equal(newGroupBtn.props['aria-label'], t('dock.capTitle'), 'Label must explain the cap instead of silently disabling')
  assert.equal(newGroupBtn.props.tip, t('dock.capTitle'), 'Capped state must expose the reason as an info tooltip')
  const capUsage = t('dock.capUsage').replace('{used}', '3').replace('{limit}', '3')
  assert.ok(JSON.stringify(renderedTree).includes(capUsage), 'Capacity indicator must be visible')

  await newGroupBtn.props.onClick()
  await flushEffects()
  const opened = render(SessionPane, { sessionId: 's-1' })
  const openedButtons = findButtons(opened)
  const wrapPrefix = t('dock.capWrapUp').split('{')[0]
  const wrapUpBtn = openedButtons.find(b => typeof b.props?.title === 'string' && b.props.title.startsWith(wrapPrefix))
  assert.ok(wrapUpBtn, 'Cap popover must offer a wrap-up action')
  // The cap notice must float ABOVE the dock instead of pushing the submit row.
  const capPanel = (function find(node) {
    if (!node || typeof node !== 'object') return null
    if (node.props?.role === 'dialog' && node.props?.['aria-label'] === t('dock.capTitle')) return node
    for (const child of node.children || []) { const hit = find(child); if (hit) return hit }
    return null
  })(opened)
  assert.ok(capPanel, 'capacity panel must be a dialog surface')
  assert.equal(capPanel.props.style.position, 'absolute', 'capacity panel must not participate in dock flow')
  assert.equal(capPanel.props.style.bottom, '100%', 'capacity panel must be anchored above the dock buttons')
  assert.equal(capPanel.props.style.boxShadow, undefined, 'capacity notice must stay flat (no drop shadow)')
  assert.ok(
    String(capPanel.props.style.background || '').includes('--pd-bg-card'),
    'capacity notice must use the card surface, not a filled grey block',
  )
  assert.ok(
    String(capPanel.props.style.backgroundImage || '').includes('linear-gradient'),
    'capacity notice needs a tinted overlay so it separates from the dock instead of blending into it',
  )
  assert.ok(JSON.stringify(opened).includes(t('dock.capHint')), 'Cap popover must explain how to free a slot')
})

test('Group header shows group turns as the main number and keeps session elapsed in the tooltip', async () => {
  const { React, render, flushEffects } = createHookRuntime()
  // Reproduces the reported G2 case: startTurn 27, stale turns 1, session at 30.
  const g2 = createGroupRecord({
    id: 'g-2', groupNumber: 2, sessionId: 's-1', workspaceId: 'session:s-1',
    startTurn: 27, turns: 1, items: [],
  })
  const groupsStore = [g2]
  const services = {
    t,
    store: {
      listEntries: async () => [],
      putEntry: async () => {},
      getGroups: async () => groupsStore,
      putGroup: async () => {},
      subscribe: () => () => {},
      quotaWarning: () => false,
    },
    index: { listRecent: async () => [], start: () => {}, stop: () => {} },
    submit: createSubmitService({ remote: { session: {} } }),
    createFinding: (args) => createFindingRecord(args),
    uuid: () => 'uuid-1',
  }
  const SessionPane = createSessionPane({ h, React, services })
  render(SessionPane, { sessionId: 's-1', currentTurn: 30 })
  await flushEffects()
  const tree = render(SessionPane, { sessionId: 's-1', currentTurn: 30 })
  function allText(node) {
    if (node === null || node === undefined || node === false) return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(allText).join(' ')
    return (node.children || []).map(allText).join(' ')
  }
  const text = allText(tree)
  // The group's own workload is 0 turns (nothing was submitted for it); the
  // legacy `turns: 1` field is ignored and the session clock never inflates it.
  const mainBadge = t('group.groupTurnsBadge').replace('{turns}', '0')
  assert.ok(text.includes(mainBadge), 'group header must read the attributed group turns')
  assert.ok(text.includes(t('group.triggeredBadge').replace('{count}', '0')), 'header must break out triggered turns')
  assert.ok(text.includes(t('group.attributedBadge').replace('{count}', '0')), 'header must break out direct attribution')
  assert.ok(!text.includes(t('group.shortBadge').replace('{turns}', '3').replace('{groupNumber}', '2')),
    'elapsed must not be the group workload number any more')
  // Session elapsed is still available, but only as session context in the tooltip.
  let tipNode = null
  ;(function walk(node) {
    if (!node || typeof node !== 'object' || tipNode) return
    if (typeof node.props?.[TIP_ATTR] === 'string'
      && node.props[TIP_ATTR].includes(t('group.elapsedTip').replace('{turns}', '3'))) {
      tipNode = node
      return
    }
    for (const child of node.children || []) walk(child)
  })(tree)
  assert.ok(tipNode, 'the group turns tooltip must carry the live session elapsed turns')
})

test('executing finding with a long quote anchor renders an icon-only quote badge', async () => {
  const { React, render, flushEffects } = createHookRuntime()
  const quoteText = '这是一段很长的引用文本用来模拟超长锚点导致顶部行布局被撑坏的情况'.repeat(2)
  const group = createGroupRecord({
    id: 'g-1', groupNumber: 1, sessionId: 's-1', workspaceId: 'session:s-1',
    startTurn: 0, items: [{ findingId: 'f-1', order: 0 }],
  })
  const finding = {
    ...createFindingRecord({
      id: 'f-1', sessionId: 's-1', text: '执行中的手账', submissionStatus: 'submitted',
      assignedGroupId: 'g-1', requestId: 'req-1',
    }),
    status: 'submitted',
    // createFindingRecord is the legacy-shaped constructor and does not carry
    // anchors; the live createEntry path does, so add the anchor explicitly.
    anchors: [{ type: 'quote', text: quoteText, turn: 2, messageId: 'msg-12345678' }],
  }
  const services = {
    t,
    store: {
      listEntries: async () => [finding],
      putEntry: async () => {},
      getGroups: async () => [group],
      putGroup: async () => {},
      subscribe: () => () => {},
      quotaWarning: () => false,
    },
    index: { listRecent: async () => [], start: () => {}, stop: () => {} },
    submit: createSubmitService({ remote: { session: {} } }),
    createFinding: (args) => createFindingRecord(args),
    uuid: () => 'uuid-1',
  }
  const SessionPane = createSessionPane({ h, React, services })
  render(SessionPane, { sessionId: 's-1', currentTurn: 2 })
  await flushEffects()
  let tree = render(SessionPane, { sessionId: 's-1', currentTurn: 2 })

  function walk(node, visit) {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const child of node) walk(child, visit); return }
    visit(node)
    for (const child of node.children || []) walk(child, visit)
  }
  let anchorBadge
  walk(tree, node => {
    if (node.props?.[TIP_ATTR] && node.props[TIP_ATTR].includes('这是一段很长的引用文本')) anchorBadge = node
  })
  assert.ok(anchorBadge, 'expected the quote anchor badge')
  assert.equal(anchorBadge.props.style.maxWidth, 120)
  assert.equal(anchorBadge.props.style.overflow, 'hidden')
  const truncatedText = anchorBadge.children.find(child => child?.props?.style?.textOverflow === 'ellipsis')
  assert.equal(truncatedText, undefined, 'quote badge shows an icon, not truncated text')
  assert.ok(anchorBadge.children.length > 0, 'quote badge must render its icon')
})

test('Sequential submission failure reconciliation: host queue evidence marks submitted', async () => {
  const remote = {
    session: {
      prompt: async () => ({ ok: false, error: { message: 'timeout' } }),
      state: async () => ({
        ok: true,
        value: { queue: [{ id: 'item-1', rpcId: 'req-rec-1' }] },
      }),
    },
  }
  const submit = createSubmitService({ remote })
  const finding = createFindingRecord({ id: 'f-1', sessionId: 's-1', text: 'Issue', requestId: 'req-rec-1' })

  const rec = await submit.reconcileSubmission('s-1', finding, { message: 'timeout' })
  assert.equal(rec.submissionStatus, 'submitted')
  assert.equal(rec.harnessProjection, 'queued')
  assert.equal(rec.retryPending, false)
})

test('Sequential submission failure reconciliation: event evidence marks submitted with running or executed', async () => {
  const remote = {
    session: {
      state: async () => ({ ok: true, value: { queue: [] } }),
      events: async () => ({
        ok: true,
        value: {
          records: [
            { type: 'event', event: { type: 'turn/start', data: { rpcId: 'req-ev-1' } } },
            { type: 'event', event: { type: 'turn/end', data: { rpcId: 'req-ev-1' } } },
          ],
        },
      }),
    },
  }
  const submit = createSubmitService({ remote })
  const finding = createFindingRecord({ id: 'f-1', sessionId: 's-1', text: 'Issue', requestId: 'req-ev-1' })

  const rec = await submit.reconcileSubmission('s-1', finding, { message: 'network down' })
  assert.equal(rec.submissionStatus, 'submitted')
  assert.equal(rec.harnessProjection, 'executed')
  assert.equal(rec.retryPending, false)
})

test('Sequential submission failure reconciliation: no evidence keeps the submission fact with retryPending and preserves requestId', async () => {
  const remote = {
    session: {
      state: async () => ({ ok: true, value: { queue: [] } }),
      events: async () => ({ ok: true, value: { records: [] } }),
    },
  }
  const submit = createSubmitService({ remote })
  const finding = createFindingRecord({ id: 'f-1', sessionId: 's-1', text: 'Issue', requestId: 'req-lost-1' })

  const rec = await submit.reconcileSubmission('s-1', finding, { message: 'connection refused' })
  // Submission is a monotonic fact: a transport failure never rolls it back.
  assert.equal(rec.submissionStatus, 'submitted')
  assert.equal(rec.harnessProjection, 'unknown')
  assert.equal(rec.retryPending, true)
  assert.equal(rec.lastSubmitError, 'connection refused')

  // When retrying, finding strictly reuses original requestId
  const retryFinding = { ...finding, ...rec }
  assert.equal(retryFinding.requestId, 'req-lost-1')
})

test('planGroupWrapUp settles running/executed items and blocks queued or unsettled ones', () => {
  const submitted = (id, over = {}) => createFindingRecord({
    id, sessionId: 's-1', text: id, submissionStatus: 'submitted', requestId: `req-${id}`, ...over,
  })
  const findings = new Map([
    ['f-run', submitted('f-run')],
    ['f-exec', submitted('f-exec')],
    ['f-queued', submitted('f-queued')],
    ['f-retry', submitted('f-retry', { retryPending: true, lastSubmitError: 'connection refused' })],
    ['f-open', createFindingRecord({ id: 'f-open', sessionId: 's-1', text: 'not submitted' })],
  ])
  const projections = new Map([
    ['f-run', 'running'],
    ['f-exec', 'executed'],
    ['f-queued', 'queued'],
  ])
  const group = createGroupRecord({
    id: 'g-1', groupNumber: 1, sessionId: 's-1', workspaceId: 'w-1',
    items: [
      { findingId: 'f-run', order: 1 },
      { findingId: 'f-exec', order: 2 },
      { findingId: 'f-queued', order: 3 },
      { findingId: 'f-retry', order: 4 },
      { findingId: 'f-open', order: 5 },
    ],
  })

  const plan = planGroupWrapUp(group, findings, projections)
  // Wrap-up only settles static rows: a running turn must finish first, exactly
  // like the row-level resolve/dismiss (2026-11-11 decision).
  assert.deepEqual(plan.settleIds, ['f-exec'])
  assert.deepEqual(plan.runningIds, ['f-run'])
  // Only findings that have not started block as "queued".
  assert.deepEqual(plan.queuedIds, ['f-queued'])
  // Unsubmitted / failed submissions are unsettled and block too.
  assert.deepEqual(plan.unsettledIds.sort(), ['f-open', 'f-retry'])
})

test('Submitting selected findings creates Active Group and renders inside group stream', async () => {
  const { React, render, flushEffects } = createHookRuntime()
  const f1 = createFindingRecord({ id: 'f-1', sessionId: 's-1', text: 'Important finding 1', submissionStatus: 'unsubmitted' })
  const entriesStore = [f1]
  const groupsStore = []
  const subscribers = new Set()

  const services = {
    t,
    store: {
      listEntries: async () => entriesStore,
      putEntry: async (e) => {
        const idx = entriesStore.findIndex(x => x.id === e.id)
        if (idx >= 0) entriesStore[idx] = e
        else entriesStore.push(e)
        for (const sub of subscribers) sub()
      },
      getGroups: async (sid) => groupsStore,
      putGroup: async (g) => {
        const idx = groupsStore.findIndex(x => x.id === g.id)
        if (idx >= 0) groupsStore[idx] = g
        else groupsStore.push(g)
        for (const sub of subscribers) sub()
      },
      subscribe: (fn) => {
        subscribers.add(fn)
        return () => subscribers.delete(fn)
      },
      quotaWarning: () => false,
    },
    index: {
      listRecent: async () => [],
      start: () => {},
      stop: () => {},
      track: async () => {},
    },
    submit: {
      submitCombined: async (sid, queued, reqId) => ({ ok: true, accepted: true }),
      submitSequential: async (sid, queued) => ({ ok: true, requests: queued.map(q => ({ entryId: q.id, requestId: q.requestId })) }),
    },
    createFinding: (args) => createFindingRecord(args),
    uuid: () => 'group-generated-id',
  }

  const SessionPane = createSessionPane({ h, React, services })
  render(SessionPane, { sessionId: 's-1' })
  await flushEffects()
  let tree = render(SessionPane, { sessionId: 's-1' })

  // Find checkbox to select f-1
  function findInputs(node) {
    const res = []
    if (!node || typeof node !== 'object') return res
    if (node.type === 'input') res.push(node)
    for (const child of node.children || []) res.push(...findInputs(child))
    return res
  }

  const inputs = findInputs(tree)
  const cardCheckbox = inputs.find(i => i.props?.type === 'checkbox' && i.props?.id !== 'selectAllCheckbox')
  assert.ok(cardCheckbox, 'Card checkbox must exist')
  cardCheckbox.props.onChange()

  // Re-render to reflect selection
  tree = render(SessionPane, { sessionId: 's-1' })

  // Find submit combined button
  function findButtons(node) {
    const res = []
    if (!node || typeof node !== 'object') return res
    if (node.type === 'button') res.push(node)
    for (const child of node.children || []) res.push(...findButtons(child))
    return res
  }

  const buttons = findButtons(tree)
  // The submit button now names its destination ("Submit to X · N"), so match on
  // the localised prefix instead of the old fixed label.
  const submitPrefix = t('dock.submitTo').split('{')[0]
  const submitBtn = buttons.find(b => typeof b.props?.title === 'string' && b.props.title.startsWith(submitPrefix))
  assert.ok(submitBtn, 'Submit combined button must exist and name its target')
  assert.equal(submitBtn.props.disabled, false, 'Submit button should be enabled when card selected')
  assert.ok(submitBtn.props.title.includes(t('dock.targetNew')), 'With no existing group the target is the new group')

  // Click submit combined
  await submitBtn.props.onClick()
  await flushEffects()

  // Verify group was created and saved in groupsStore
  assert.equal(groupsStore.length, 1, 'Group must be saved in store')
  assert.equal(groupsStore[0].groupNumber, 1, 'First group should be Group 1')
  assert.equal(groupsStore[0].items.length, 1, 'Group should contain the submitted finding')
  assert.equal(groupsStore[0].items[0].findingId, 'f-1')

  // Re-render and verify Active Group card is rendered in the tree
  tree = render(SessionPane, { sessionId: 's-1' })

  function getAllText(node) {
    if (!node) return ''
    if (typeof node === 'string') return node
    if (Array.isArray(node)) return node.map(getAllText).join(' ')
    if (typeof node === 'object') return (node.children || []).map(getAllText).join(' ')
    return ''
  }

  const text = getAllText(tree)
  assert.ok(text.includes(t('group.title').replace('{number}', '1')), 'Active group card must be rendered in session pane')
  assert.ok(text.includes('Important finding 1'), 'Finding text must appear inside the group card')
})

test('clearWorkspaceData only clears target workspace data and strictly preserves pinned groups and findings', async () => {
  const store = createLocalDeskStore({ storage: createMemoryStorage() })

  // Workspace A: dsh-plugins
  const gA1 = createGroupRecord({ id: 'ga-1', groupNumber: 1, sessionId: 's-a', workspaceId: 'ws-a', pinned: true, items: [{ findingId: 'fa-1', order: 0 }] })
  const gA2 = createGroupRecord({ id: 'ga-2', groupNumber: 2, sessionId: 's-a', workspaceId: 'ws-a', pinned: false, items: [{ findingId: 'fa-2', order: 0 }] })
  await store.putGroups('s-a', [gA1, gA2])

  const fA1 = createFindingRecord({ id: 'fa-1', sessionId: 's-a', workspaceId: 'ws-a', assignedGroupId: 'ga-1', text: 'Pinned finding' })
  const fA2 = createFindingRecord({ id: 'fa-2', sessionId: 's-a', workspaceId: 'ws-a', assignedGroupId: 'ga-2', text: 'Unpinned finding' })
  const fA3 = createFindingRecord({ id: 'fa-3', sessionId: 's-a', workspaceId: 'ws-a', text: 'Unassigned draft pool finding' })
  await store.putEntries('session:s-a', [fA1, fA2, fA3])

  // Workspace B: xiehe
  const gB1 = createGroupRecord({ id: 'gb-1', groupNumber: 1, sessionId: 's-b', workspaceId: 'ws-b', pinned: false, items: [{ findingId: 'fb-1', order: 0 }] })
  await store.putGroups('s-b', [gB1])
  const fB1 = createFindingRecord({ id: 'fb-1', sessionId: 's-b', workspaceId: 'ws-b', assignedGroupId: 'gb-1', text: 'Other workspace finding' })
  await store.putEntries('session:s-b', [fB1])

  // Clear Workspace A (ws-a) with preservePinned: true
  await store.clearWorkspaceData('ws-a', { preservePinned: true, sessionIds: ['s-a'] })

  // Verify Workspace A results
  const remainingGroupsA = await store.getGroups('s-a')
  assert.equal(remainingGroupsA.length, 1, 'Only pinned group should remain in Workspace A')
  assert.equal(remainingGroupsA[0].id, 'ga-1')
  assert.equal(remainingGroupsA[0].pinned, true)

  const remainingEntriesA = await store.listEntries('session:s-a')
  assert.equal(remainingEntriesA.length, 1, 'Only finding in pinned group should remain in Workspace A')
  assert.equal(remainingEntriesA[0].id, 'fa-1')
  assert.equal(remainingEntriesA[0].text, 'Pinned finding')

  // Verify Workspace B is 100% untouched
  const remainingGroupsB = await store.getGroups('s-b')
  assert.equal(remainingGroupsB.length, 1, 'Workspace B group must remain untouched')
  assert.equal(remainingGroupsB[0].id, 'gb-1')

  const remainingEntriesB = await store.listEntries('session:s-b')
  assert.equal(remainingEntriesB.length, 1, 'Workspace B entries must remain untouched')
  assert.equal(remainingEntriesB[0].id, 'fb-1')

  // Verify workspace index NEVER adds an errant session:ws-a key
  const allWorkspaceKeys = await store.listWorkspaces()
  assert.ok(!allWorkspaceKeys.includes('session:ws-a'), 'Workspace index must never contain session:ws-a')
  assert.ok(!allWorkspaceKeys.includes('ws-a'), 'Workspace index must never contain raw workspace UUID')

  // Clear unpinned Workspace B completely -> its session key should be purged from workspaces index
  await store.clearWorkspaceData('ws-b', { preservePinned: true, sessionIds: ['s-b'] })
  const updatedKeys = await store.listWorkspaces()
  assert.ok(!updatedKeys.includes('session:s-b'), 'Completely cleared session should be removed from workspaces index')
})

test('clearWorkspaceData honors category switches (clearFindings, clearGroups, clearDrafts)', async () => {
  const store = createLocalDeskStore({ storage: createMemoryStorage() })

  // Populate data
  const g1 = createGroupRecord({ id: 'g-cat-1', groupNumber: 1, sessionId: 's-cat', workspaceId: 'ws-cat', pinned: false })
  await store.putGroups('s-cat', [g1])

  const f1 = createFindingRecord({ id: 'f-cat-1', sessionId: 's-cat', workspaceId: 'ws-cat', text: 'Finding to keep' })
  await store.putEntries('session:s-cat', [f1])

  const globalDraft = { id: 'draft-1', kind: 'draft', title: 'Global Spec', body: 'Spec content', status: 'idea' }
  const scopedDraft = {
    id: 'draft-2', kind: 'draft', title: 'Workspace Spec', body: 'Spec content', status: 'idea',
    visibility: 'workspace', workspaceId: 'ws-cat',
  }
  const otherWorkspaceDraft = {
    id: 'draft-3', kind: 'draft', title: 'Other Workspace Spec', body: 'Spec content', status: 'idea',
    visibility: 'workspace', workspaceId: 'ws-other',
  }
  await store.putEntries('draft:global', [globalDraft, scopedDraft, otherWorkspaceDraft])

  // Clear ONLY groups, keep findings and drafts
  await store.clearWorkspaceData('ws-cat', {
    sessionIds: ['s-cat'],
    clearGroups: true,
    clearFindings: false,
    clearDrafts: false,
  })

  const groupsAfter = await store.getGroups('s-cat')
  assert.equal(groupsAfter.length, 0, 'Groups should be cleared')

  const findingsAfter = await store.listEntries('session:s-cat')
  assert.equal(findingsAfter.length, 1, 'Findings should NOT be cleared')
  assert.equal(findingsAfter[0].id, 'f-cat-1')

  const draftsAfter = await store.listEntries('draft:global')
  assert.equal(draftsAfter.length, 3, 'Drafts should NOT be cleared')

  // Now clear drafts explicitly. Only the draft scoped to this workspace goes
  // away; the shared global pool and other workspaces' drafts must survive.
  await store.clearWorkspaceData('ws-cat', {
    sessionIds: ['s-cat'],
    clearGroups: false,
    clearFindings: false,
    clearDrafts: true,
  })

  const draftsCleared = await store.listEntries('draft:global')
  assert.deepEqual(
    draftsCleared.map(draft => draft.id).sort(),
    ['draft-1', 'draft-3'],
    'Only the workspace-scoped draft of this workspace should be cleared',
  )
})




test('Wrap-up archives static rows only: running rows block, ignored rows are untouched', async () => {
  const { React, render, flushEffects } = createHookRuntime()
  const fExec = createFindingRecord({
    id: 'f-exec', sessionId: 's-1', text: 'executed finding',
    submissionStatus: 'submitted', requestId: 'req-exec',
  })
  // Legacy row: only status:'dismissed', no reviewStatus (pre-reviewStatus data).
  const fIgnored = {
    id: 'f-ignored', sessionId: 's-1', text: 'ignored finding',
    submissionStatus: 'submitted', requestId: 'req-ignored', status: 'dismissed',
  }
  const fRun = createFindingRecord({
    id: 'f-run', sessionId: 's-1', text: 'running finding',
    submissionStatus: 'submitted', requestId: 'req-run', assignedGroupId: 'g-2',
  })
  const entriesStore = [fExec, fIgnored, fRun]
  const groupsStore = [
    createGroupRecord({
      id: 'g-1', groupNumber: 1, sessionId: 's-1', workspaceId: 'session:s-1',
      items: [{ findingId: 'f-exec', order: 1 }, { findingId: 'f-ignored', order: 2 }],
    }),
    createGroupRecord({
      id: 'g-2', groupNumber: 2, sessionId: 's-1', workspaceId: 'session:s-1',
      items: [{ findingId: 'f-run', order: 1 }],
    }),
  ]

  const services = {
    t,
    store: {
      listEntries: async () => entriesStore.slice(),
      putEntry: async (entry) => {
        const index = entriesStore.findIndex(item => item.id === entry.id)
        if (index >= 0) entriesStore[index] = entry
        else entriesStore.push(entry)
      },
      getGroups: async () => groupsStore,
      putGroup: async (group) => {
        const index = groupsStore.findIndex(item => item.id === group.id)
        if (index >= 0) groupsStore[index] = group
        else groupsStore.push(group)
      },
      subscribe: () => () => {},
      quotaWarning: () => false,
    },
    index: {
      listRecent: async () => [
        { requestId: 'req-exec', status: 'completed' },
        { requestId: 'req-ignored', status: 'completed' },
        { requestId: 'req-run', status: 'sent' },
      ],
      start: () => {},
      stop: () => {},
    },
    submit: createSubmitService({ remote: { session: {} } }),
    createFinding: (args) => createFindingRecord(args),
    uuid: () => 'uuid-wrap-up',
  }

  const SessionPane = createSessionPane({ h, React, services })
  render(SessionPane, { sessionId: 's-1' })
  await flushEffects()

  function findButtons(node) {
    const res = []
    if (!node || typeof node !== 'object') return res
    if (node.type === 'button') res.push(node)
    for (const child of node.children || []) res.push(...findButtons(child))
    return res
  }
  const textOf = button => (button.children || []).flat(Infinity).filter(c => typeof c === 'string').join('')
  const wrapUpButtons = () => findButtons(render(SessionPane, { sessionId: 's-1' }))
    .filter(button => textOf(button) === t('group.wrapUpAction'))

  // 1. Static batch: one executed + one ignored row. The confirmation must state
  //    the real settle count (1) and that the ignored row stays untouched.
  let tree = render(SessionPane, { sessionId: 's-1' })
  assert.ok(wrapUpButtons().length >= 1, 'Wrap-up button must exist')
  await wrapUpButtons()[0].props.onClick()
  await flushEffects()
  const armedTree = render(SessionPane, { sessionId: 's-1' })
  const confirmText = JSON.stringify(armedTree)
  assert.ok(confirmText.includes(t('group.wrapUpConfirm').includes('{count}') ? t('group.wrapUpConfirm').replace('{count}', '1') : '1'), 'confirmation states 1 resolvable row')
  assert.ok(confirmText.includes(t('group.wrapUpConfirmIgnored').replace('{count}', '1')), 'confirmation names the untouched ignored row')
  const confirmBtn = findButtons(armedTree).find(button => textOf(button) === t('group.wrapUpConfirmYes'))
  assert.ok(confirmBtn, 'Wrap-up must require an explicit confirmation step')
  await confirmBtn.props.onClick()
  await flushEffects()

  const byId = Object.fromEntries(entriesStore.map(entry => [entry.id, entry]))
  assert.equal(byId['f-exec'].reviewStatus, 'resolved')
  assert.equal(byId['f-exec'].completedVia, 'group-wrap-up')
  assert.equal(typeof byId['f-exec'].resolvedAt, 'number')
  assert.equal(byId['f-ignored'].reviewStatus, undefined, 'legacy ignored row must not be rewritten to resolved')
  assert.equal(byId['f-ignored'].status, 'dismissed', 'legacy ignored row keeps its status')
  assert.equal(groupsStore[0].status, 'archived')
  assert.equal(typeof groupsStore[0].archivedAt, 'number')

  // 2. Running row keeps its batch's wrap-up disabled (防误触) until it finishes.
  tree = render(SessionPane, { sessionId: 's-1' })
  const runningWrapUp = findButtons(tree)
    .filter(button => textOf(button) === t('group.wrapUpAction'))
  assert.equal(runningWrapUp.length, 1, 'the remaining batch has one wrap-up button')
  assert.equal(runningWrapUp[0].props.disabled, true, 'wrap-up is disabled while a turn is running')
  assert.ok(
    String(runningWrapUp[0].props.title || '').includes(t('group.wrapUpBlockedRunning').replace('{count}', '1').slice(0, 8)),
    'the disabled button explains why and what to do next (title/aria-label on the button)',
  )
  // Clicking a disabled button must not arm the confirmation or archive anything.
  await runningWrapUp[0].props.onClick()
  await flushEffects()
  assert.equal(groupsStore[1].status, undefined)
  assert.equal(findButtons(render(SessionPane, { sessionId: 's-1' }))
    .some(button => textOf(button) === t('group.wrapUpConfirmYes')), false, 'disabled wrap-up never arms')

  // 3. An empty group has no blockers: wrapping it up only frees the slot, so the
  //    button must stay enabled (it is the only way to release the quota).
  const emptyGroups = [createGroupRecord({ id: 'g-empty', groupNumber: 1, sessionId: 's-1', workspaceId: 'session:s-1', items: [] })]
  const emptyServices = {
    t,
    store: {
      listEntries: async () => [],
      putEntry: async () => {},
      getGroups: async () => emptyGroups,
      putGroup: async () => {},
      subscribe: () => () => {},
      quotaWarning: () => false,
    },
    index: { listRecent: async () => [], start: () => {}, stop: () => {} },
    submit: createSubmitService({ remote: { session: {} } }),
    createFinding: (args) => createFindingRecord(args),
    uuid: () => 'uuid-empty',
  }
  const EmptyPane = createSessionPane({ h, React, services: emptyServices })
  render(EmptyPane, { sessionId: 's-1' })
  await flushEffects()
  const emptyTree = render(EmptyPane, { sessionId: 's-1' })
  const emptyWrap = findButtons(emptyTree).find(button => textOf(button) === t('group.wrapUpAction'))
  assert.ok(emptyWrap, 'empty group still has a wrap-up button')
  assert.notEqual(emptyWrap.props.disabled, true, 'empty group can be wrapped up to release the slot')
})

test('Submitted prompt log section collapses and expands on click', async () => {
  const { React, render, flushEffects } = createHookRuntime()
  const logRows = [{
    messageId: 'm-1', sessionId: 's-1', localDate: '2026-11-06', time: Date.now(),
    status: 'sent', turn: 3, source: 'composer',
    promptText: '已提交的提示词内容\n第二行详情',
    excerpt: '已提交的提示词内容',
  }]
  const services = {
    t,
    store: {
      listEntries: async () => [],
      putEntry: async () => {},
      getGroups: async () => [],
      putGroup: async () => {},
      subscribe: () => () => {},
      quotaWarning: () => false,
    },
    index: {
      listRecent: async () => logRows,
      start: () => {},
      stop: () => {},
    },
    submit: createSubmitService({ remote: { session: {} } }),
    createFinding: (args) => createFindingRecord(args),
    uuid: () => 'uuid-submitted',
  }

  const SessionPane = createSessionPane({ h, React, services })
  render(SessionPane, { sessionId: 's-1' })
  await flushEffects()
  let tree = render(SessionPane, { sessionId: 's-1' })

  function getAllText(node) {
    if (!node) return ''
    if (typeof node === 'string') return node
    if (Array.isArray(node)) return node.map(getAllText).join(' ')
    if (typeof node === 'object') return (node.children || []).map(getAllText).join(' ')
    return ''
  }
  function findToggle(node) {
    if (!node || typeof node !== 'object') return null
    if (node.props && node.props['aria-expanded'] !== undefined) return node
    for (const child of node.children || []) {
      const found = findToggle(child)
      if (found) return found
    }
    return null
  }

  function findSubmittedCard(node) {
    if (!node || typeof node !== 'object') return null
    if (node.props?.style?.marginTop !== undefined && getAllText(node).includes(t('submitted.title'))) return node
    for (const child of node.children || []) {
      const found = findSubmittedCard(child)
      if (found) return found
    }
    return null
  }

  const toggle = findToggle(tree)
  assert.ok(toggle, 'Submitted log toggle must exist')
  assert.equal(toggle.props['aria-expanded'], true)
  assert.ok(getAllText(tree).includes('已提交的提示词内容'))
  assert.equal(findSubmittedCard(tree).props.style.marginTop, 8)

  await toggle.props.onClick()
  tree = render(SessionPane, { sessionId: 's-1' })
  const collapsedToggle = findToggle(tree)
  assert.equal(collapsedToggle.props['aria-expanded'], false)
  assert.equal(getAllText(tree).includes('已提交的提示词内容'), false)
  // Collapsed header docks to the bottom of the stream area (margin-top:auto).
  assert.equal(findSubmittedCard(tree).props.style.marginTop, 'auto')

  await collapsedToggle.props.onClick()
  tree = render(SessionPane, { sessionId: 's-1' })
  assert.equal(findToggle(tree).props['aria-expanded'], true)
  assert.ok(getAllText(tree).includes('已提交的提示词内容'))
  assert.equal(findSubmittedCard(tree).props.style.marginTop, 8)

  function findRowToggle(node) {
    if (!node || typeof node !== 'object') return null
    if (node.props?.['aria-expanded'] !== undefined && getAllText(node).includes('第二行详情')) return node
    for (const child of node.children || []) {
      const found = findRowToggle(child)
      if (found) return found
    }
    return null
  }
  function findTextSpan(node, text) {
    if (!node || typeof node !== 'object') return null
    if (Array.isArray(node.children) && node.children.includes(text) && node.props?.style) return node
    for (const child of node.children || []) {
      const found = findTextSpan(child, text)
      if (found) return found
    }
    return null
  }

  const collapsedRow = findRowToggle(tree)
  assert.ok(collapsedRow, 'Submitted row toggle must exist')
  assert.equal(collapsedRow.props['aria-expanded'], false)
  assert.equal(findTextSpan(tree, '已提交的提示词内容\n第二行详情').props.style.whiteSpace, 'nowrap')

  // Expanding a row reveals the full prompt (pre-wrap) and its turn/source metadata.
  await collapsedRow.props.onClick()
  tree = render(SessionPane, { sessionId: 's-1' })
  const expandedRow = findRowToggle(tree)
  assert.equal(expandedRow.props['aria-expanded'], true)
  assert.equal(findTextSpan(tree, '已提交的提示词内容\n第二行详情').props.style.whiteSpace, 'pre-wrap')
  const rowText = getAllText(tree)
  assert.ok(rowText.includes('轮次 3'))
  assert.ok(rowText.includes('来源 composer'))

  await expandedRow.props.onClick()
  tree = render(SessionPane, { sessionId: 's-1' })
  assert.equal(findRowToggle(tree).props['aria-expanded'], false)
  assert.equal(findTextSpan(tree, '已提交的提示词内容\n第二行详情').props.style.whiteSpace, 'nowrap')
})

test('Header summary keeps completed-but-unwrapped groups visible (9 resolved rows read 9/9, not 0/0)', () => {
  const entries = []
  for (let i = 1; i <= 9; i += 1) {
    entries.push(createFindingRecord({
      id: 'f-' + i,
      sessionId: 's-1',
      text: 'Done ' + i,
      submissionStatus: 'submitted',
      status: 'completed',
      reviewStatus: 'resolved',
      assignedGroupId: 'g-active',
    }))
  }
  const activeGroup = createGroupRecord({
    id: 'g-active', groupNumber: 4, sessionId: 's-1', workspaceId: 'w-1', status: 'active',
    items: entries.map((entry, idx) => ({ findingId: entry.id, order: idx + 1 })),
  })
  const archived = [1, 2, 3].map(n => createGroupRecord({
    id: 'g-archive-' + n, groupNumber: n, sessionId: 's-1', workspaceId: 'w-1', status: 'archived',
  }))
  const findingsMap = new Map(entries.map(entry => [entry.id, entry]))
  const summary = summarizeOpenWork({
    entries,
    groups: [activeGroup, ...archived],
    poolCount: 0,
    findingsMap,
    harnessProjectionsMap: new Map(),
  })

  // The batch finished executing, so wrapping it up is the remaining human action.
  assert.equal(summary.active, 9)
  assert.equal(summary.total, 9)
  assert.equal(summary.awaitingWrapUp, 9)
  assert.equal(summary.needsWrapUp, true)
  assert.ok(String(summary.color).includes('--pd-status-warn'), 'dot must warn about the pending wrap-up (semantic Nord token)')

  // A completed batch whose rows are all dismissed has no actionable row, but it
  // still occupies a slot; the header must keep the wrap-up signal (not 0/0 grey).
  const ignored = [1, 2].map(n => createFindingRecord({
    id: 'f-ig-' + n, sessionId: 's-1', text: 'Ignored ' + n,
    submissionStatus: 'submitted', reviewStatus: 'dismissed', status: 'dismissed',
    assignedGroupId: 'g-ignored',
  }))
  const ignoredGroup = createGroupRecord({
    id: 'g-ignored', groupNumber: 5, sessionId: 's-1', workspaceId: 'w-1', status: 'active',
    items: ignored.map((entry, idx) => ({ findingId: entry.id, order: idx + 1 })),
  })
  const ignoredSummary = summarizeOpenWork({
    entries: ignored,
    groups: [ignoredGroup],
    poolCount: 0,
    findingsMap: new Map(ignored.map(entry => [entry.id, entry])),
    harnessProjectionsMap: new Map(),
  })
  assert.equal(ignoredSummary.total, 0)
  assert.equal(ignoredSummary.awaitingWrapUp, 0)
  assert.equal(ignoredSummary.awaitingGroups, 1)
  assert.equal(ignoredSummary.needsWrapUp, true)
  assert.ok(String(ignoredSummary.color).includes('--pd-status-warn'), 'dismissed-only batch keeps the wrap-up warning instead of turning grey')
  assert.ok(String(ignoredSummary.textColor).includes('--pd-status-warn-text'), 'small text uses the readable warn token')

  // Legacy ignored rows (only status:'dismissed') must count the same as reviewed ones.
  const legacyIgnored = [{ id: 'f-legacy', sessionId: 's-1', text: 'legacy ignored', submissionStatus: 'submitted', status: 'dismissed', assignedGroupId: 'g-legacy' }]
  const legacyGroup = createGroupRecord({
    id: 'g-legacy', groupNumber: 6, sessionId: 's-1', workspaceId: 'w-1', status: 'active',
    items: [{ findingId: 'f-legacy', order: 1 }],
  })
  const legacySummary = summarizeOpenWork({
    entries: legacyIgnored,
    groups: [legacyGroup],
    poolCount: 0,
    findingsMap: new Map(legacyIgnored.map(entry => [entry.id, entry])),
    harnessProjectionsMap: new Map(),
  })
  assert.equal(legacySummary.total, 0, 'legacy ignored rows are excluded from the open count')
  assert.equal(legacySummary.awaitingGroups, 1)
  assert.equal(legacySummary.needsWrapUp, true)
})

test('Header summary counts drafts and in-flight items without pretending a wrap-up is pending', () => {
  const draft = createFindingRecord({ id: 'f-draft', sessionId: 's-1', text: 'Draft', submissionStatus: 'unsubmitted' })
  const inFlight = createFindingRecord({ id: 'f-run', sessionId: 's-1', text: 'Running', submissionStatus: 'submitted', assignedGroupId: 'g-1' })
  const group = createGroupRecord({
    id: 'g-1', groupNumber: 1, sessionId: 's-1', workspaceId: 'w-1', status: 'active',
    items: [{ findingId: 'f-run', order: 1 }],
  })
  const findingsMap = new Map([[draft.id, draft], [inFlight.id, inFlight]])
  const summary = summarizeOpenWork({
    entries: [draft, inFlight],
    groups: [group],
    poolCount: 1,
    findingsMap,
    harnessProjectionsMap: () => 'running',
  })
  assert.equal(summary.active, 1, 'the running group item is still open')
  assert.equal(summary.total, 2, 'plus the unsubmitted draft')
  assert.equal(summary.awaitingWrapUp, 0)
  assert.equal(summary.needsWrapUp, false)
  assert.equal(summary.executing, 1)
  assert.equal(summary.breathing, true)
  assert.ok(String(summary.color).includes('--pd-status-running'), 'in-flight work uses the running (Nord orange) status colour')

  // Regression (2026-11-11): the same batch must not change header counts when it
  // finishes executing (reported: 3/3 while running, then 14/14 after completion).
  const batchEntries = Array.from({ length: 14 }, (_, idx) => createFindingRecord({
    id: 'f-batch-' + idx,
    sessionId: 's-1',
    text: 'Batch ' + idx,
    submissionStatus: 'submitted',
    assignedGroupId: 'g-batch',
    reviewStatus: idx < 11 ? 'resolved' : 'pending',
  }))
  const batchGroup = createGroupRecord({
    id: 'g-batch', groupNumber: 2, sessionId: 's-1', workspaceId: 'w-1', status: 'active',
    items: batchEntries.map((entry, idx) => ({ findingId: entry.id, order: idx + 1 })),
  })
  const findingsOfBatch = new Map(batchEntries.map(entry => [entry.id, entry]))
  const runningProjections = new Map([
    [batchEntries[11].id, 'running'],
    [batchEntries[12].id, 'queued'],
    [batchEntries[13].id, 'queued'],
  ])
  const runningSummary = summarizeOpenWork({
    entries: batchEntries, groups: [batchGroup], poolCount: 0,
    findingsMap: findingsOfBatch, harnessProjectionsMap: runningProjections,
  })
  assert.equal(runningSummary.active, 14, 'all unwrapped batch rows stay in the count while running')
  assert.equal(runningSummary.total, 14)
  assert.equal(runningSummary.executing, 1)
  assert.equal(runningSummary.queued, 2)
  assert.equal(runningSummary.breathing, true)
  assert.equal(runningSummary.needsWrapUp, false)

  const resolvedFindings = new Map(batchEntries.map(entry => [entry.id, { ...entry, reviewStatus: 'resolved' }]))
  const doneSummary = summarizeOpenWork({
    entries: batchEntries, groups: [batchGroup], poolCount: 0,
    findingsMap: resolvedFindings,
    harnessProjectionsMap: new Map(batchEntries.map(entry => [entry.id, 'executed'])),
  })
  assert.equal(doneSummary.total, runningSummary.total, 'header count must not jump when execution finishes')
  assert.equal(doneSummary.awaitingWrapUp, 14)
  assert.equal(doneSummary.needsWrapUp, true)
  assert.equal(doneSummary.breathing, false)
})

test('clearWorkspaceData reconciles group/finding references when only one side is cleared', async () => {
  const store = createLocalDeskStore({ storage: createMemoryStorage() })

  const group = createGroupRecord({
    id: 'g-reconcile', groupNumber: 1, sessionId: 's-reconcile', workspaceId: 'ws-reconcile',
    items: [{ findingId: 'f-reconcile-1', order: 0 }, { findingId: 'f-reconcile-2', order: 1 }],
  })
  await store.putGroups('s-reconcile', [group])
  await store.putEntries('session:s-reconcile', [
    createFindingRecord({ id: 'f-reconcile-1', sessionId: 's-reconcile', workspaceId: 'ws-reconcile', assignedGroupId: 'g-reconcile', text: 'one' }),
    createFindingRecord({ id: 'f-reconcile-2', sessionId: 's-reconcile', workspaceId: 'ws-reconcile', assignedGroupId: 'g-reconcile', text: 'two' }),
  ])

  // Clear groups but keep findings: surviving findings must lose the dangling group id.
  await store.clearWorkspaceData('ws-reconcile', {
    sessionIds: ['s-reconcile'],
    clearGroups: true,
    clearFindings: false,
  })
  assert.equal((await store.getGroups('s-reconcile')).length, 0)
  const kept = await store.listEntries('session:s-reconcile')
  assert.equal(kept.length, 2)
  assert.ok(kept.every(finding => !finding.assignedGroupId), 'surviving findings must be unassigned')

  // Recreate both, then clear findings but keep groups: group items must be pruned.
  await store.putGroups('s-reconcile', [group])
  await store.putEntries('session:s-reconcile', [
    createFindingRecord({ id: 'f-reconcile-1', sessionId: 's-reconcile', workspaceId: 'ws-reconcile', assignedGroupId: 'g-reconcile', text: 'one' }),
    createFindingRecord({ id: 'f-reconcile-2', sessionId: 's-reconcile', workspaceId: 'ws-reconcile', assignedGroupId: 'g-reconcile', text: 'two' }),
  ])
  await store.clearWorkspaceData('ws-reconcile', {
    sessionIds: ['s-reconcile'],
    clearGroups: false,
    clearFindings: true,
  })
  const [remainingGroup] = await store.getGroups('s-reconcile')
  assert.ok(remainingGroup, 'group should survive clearFindings')
  assert.deepEqual(remainingGroup.items, [], 'group items pointing at deleted findings must be removed')
})
