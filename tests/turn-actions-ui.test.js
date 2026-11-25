import test from 'node:test'
import assert from 'node:assert/strict'
import { createFindingRecord } from '../src/domain/entries.js'
import { createGroupRecord } from '../src/domain/active-group.js'
import { itemOriginKey } from '../src/domain/turn-actions.js'
import { TONE_COLORS } from '../src/client/ui/bits.js'
import { makePaneHarness, flattenButtons, textOfNode, t } from './helpers/pane-harness.js'

function createTurnActionItem(props = {}) {
  return {
    id: props.id || 'act-' + Math.random().toString(36).slice(2, 8),
    turn: props.turn ?? 1,
    evidenceSeq: props.evidenceSeq ?? 1,
    kind: props.kind || 'confirm',
    confidence: props.confidence || 'high',
    title: props.title || 'Turn Action Item',
    quote: props.quote || 'Quote snippet',
    status: props.status || 'open',
    callId: props.callId,
    findingId: props.findingId || null,
    createdAt: props.createdAt || Date.now(),
    updatedAt: props.updatedAt || Date.now(),
    ...props,
  }
}

function findNodeByTestId(node, testId) {
  if (!node || typeof node !== 'object') return null
  if (node.props?.['data-testid'] === testId) return node
  for (const child of node.children || []) {
    const found = findNodeByTestId(child, testId)
    if (found) return found
  }
  return null
}

function findNodesByClass(node, className, acc = []) {
  if (!node || typeof node !== 'object') return acc
  if (typeof node.props?.className === 'string' && node.props.className.includes(className)) {
    acc.push(node)
  }
  for (const child of node.children || []) {
    findNodesByClass(child, className, acc)
  }
  return acc
}

function setupTurnActionsHarness({
  entries = [],
  groups = [],
  turnActions = [],
  promptLogRows = [],
  revealedQuestions = [],
} = {}) {
  const harness = makePaneHarness({ entries, groups, promptLogRows })
  const turnActionsMap = new Map()
  if (turnActions.length) {
    turnActionsMap.set('s-1', { items: [...turnActions] })
  }

  const subscribers = new Set()
  const origSubscribe = harness.services.store.subscribe
  harness.services.store.subscribe = (fn) => {
    subscribers.add(fn)
    const unsub = origSubscribe(fn)
    return () => {
      subscribers.delete(fn)
      unsub()
    }
  }
  const notifySubscribers = async () => {
    for (const fn of [...subscribers]) {
      await fn()
    }
  }

  harness.services.store.listTurnActions = async (sessionId) => {
    return turnActionsMap.get(sessionId) || { items: [] }
  }
  harness.services.store.putTurnActions = async (sessionId, actions) => {
    const state = actions && Array.isArray(actions.items) ? actions : { items: Array.isArray(actions) ? actions : [] }
    turnActionsMap.set(sessionId, state)
  }
  harness.services.userQuestionPanels = {
    reveal: (sessionId, callId) => {
      revealedQuestions.push({ sessionId, callId })
    },
  }

  let resyncCalledWith = null
  harness.services.turnActionsTracker = {
    resync: async (sessionId) => {
      resyncCalledWith = sessionId
    },
  }

  return {
    ...harness,
    turnActionsMap,
    revealedQuestions,
    notifySubscribers,
    getResyncCalledWith: () => resyncCalledWith,
  }
}

test('T-TAI-P4-2: Conditional Tab matrix: 0 actions & 0 submitted -> hidden', async () => {
  const { render, flushEffects, SessionPane } = setupTurnActionsHarness({
    entries: [],
    groups: [],
    turnActions: [],
  })
  render(SessionPane, { sessionId: 's-1' })
  await flushEffects()
  const tree = render(SessionPane, { sessionId: 's-1' })

  const tabsHeader = findNodeByTestId(tree, 'turn-actions-tabs')
  assert.equal(tabsHeader, null, 'Tab header must not exist when both are empty')
  const submittedSection = findNodeByTestId(tree, 'submitted-log-section')
  assert.equal(submittedSection, null, 'Submitted section must not exist')
})

test('T-TAI-P4-2: Conditional Tab matrix: 0 actions & M>0 submitted -> single submitted accordion', async () => {
  const { render, flushEffects, SessionPane, getResyncCalledWith } = setupTurnActionsHarness({
    entries: [],
    groups: [],
    turnActions: [],
    promptLogRows: [{ requestId: 'req-1', turn: 1, promptText: 'hello' }],
  })
  render(SessionPane, { sessionId: 's-1' })
  await flushEffects()
  const tree = render(SessionPane, { sessionId: 's-1' })

  const tabsHeader = findNodeByTestId(tree, 'turn-actions-tabs')
  assert.equal(tabsHeader, null, 'Dual Tab header must not appear for single section')
  const treeStr = JSON.stringify(tree)
  assert.ok(treeStr.includes(t('submitted.title')), 'Must show submitted section title')

  // Rescan button exists on submitted section header for old sessions
  const rescanBtn = flattenButtons(tree).find(b => b.props?.title === t('turnActions.action.rescan'))
  assert.ok(rescanBtn, 'Rescan button must exist on submitted section header for old sessions')
  await rescanBtn.props.onClick({ stopPropagation: () => {} })
  await flushEffects()
  assert.equal(getResyncCalledWith(), 's-1', 'resync must be invoked with sessionId')
})

test('T-TAI-P4-2: Conditional Tab matrix: N>0 actions & 0 submitted -> single actions accordion', async () => {
  const actionItem = createTurnActionItem({
    id: 'act-1',
    turn: 1,
    evidenceSeq: 10,
    kind: 'confirm',
    confidence: 'high',
    title: 'Need review',
    quote: 'Please confirm step 1',
    status: 'open',
  })
  const { render, flushEffects, SessionPane } = setupTurnActionsHarness({
    entries: [],
    groups: [],
    turnActions: [actionItem],
  })
  render(SessionPane, { sessionId: 's-1' })
  await flushEffects()
  const tree = render(SessionPane, { sessionId: 's-1' })

  const tabsHeader = findNodeByTestId(tree, 'turn-actions-tabs')
  assert.equal(tabsHeader, null, 'Dual Tab header must not appear for single actions section')
  const actionCards = findNodesByClass(tree, 'pd-turn-action-card')
  assert.equal(actionCards.length, 1, 'Action card must be rendered in single section')
})

test('T-TAI-P4-2: Conditional Tab matrix: N>0 actions & M>0 submitted -> dual tabs, actions selected by default', async () => {
  const actionItem = createTurnActionItem({
    id: 'act-1',
    turn: 2,
    evidenceSeq: 20,
    kind: 'approval-pending',
    confidence: 'high',
    title: 'File write permission',
    quote: 'Antigravity wants to write file',
    status: 'open',
  })
  const { render, flushEffects, SessionPane } = setupTurnActionsHarness({
    entries: [],
    groups: [],
    turnActions: [actionItem],
    promptLogRows: [{ requestId: 'req-1', turn: 1, promptText: 'hello' }],
  })
  render(SessionPane, { sessionId: 's-1' })
  await flushEffects()
  await new Promise(r => setTimeout(r, 20))
  let tree = render(SessionPane, { sessionId: 's-1' })

  const tabsHeader = findNodeByTestId(tree, 'turn-actions-tabs')
  assert.ok(tabsHeader, 'Dual tab switcher must exist')

  const tabButtons = flattenButtons(tabsHeader)
  assert.equal(tabButtons.length >= 2, true, 'Must have at least two tab buttons')
  const actionsTab = tabButtons.find(b => textOfNode(b).includes(t('turnActions.tabActions')))
  const submittedTab = tabButtons.find(b => textOfNode(b).includes(t('turnActions.tabSubmitted')))
  assert.ok(actionsTab, 'Actions tab button must exist')
  assert.ok(submittedTab, 'Submitted tab button must exist')

  // Actions card is shown by default
  let actionCards = findNodesByClass(tree, 'pd-turn-action-card')
  assert.equal(actionCards.length, 1, 'Actions card must be visible by default')

  // Switch to submitted tab
  submittedTab.props.onClick()
  tree = render(SessionPane, { sessionId: 's-1' })
  actionCards = findNodesByClass(tree, 'pd-turn-action-card')
  assert.equal(actionCards.length, 0, 'Action cards must not be visible on submitted tab')

  // Toggle chevron to collapse
  const collapseBtn = tabButtons.find(b => b.props?.title === t('finding.collapse') || b.props?.title === t('finding.expand'))
  assert.ok(collapseBtn, 'Chevron collapse button must exist')
  await collapseBtn.props.onClick()
  tree = render(SessionPane, { sessionId: 's-1' })
  assert.equal(tree.children?.some(c => c && c.props?.id === 'turnActionsContent'), false, 'Content must be hidden when collapsed')
})

test('T-TAI-P4-3: Pending pill in draft pool header shows open+high count', async () => {
  const itemHigh = createTurnActionItem({
    id: 'act-1',
    turn: 1,
    evidenceSeq: 1,
    kind: 'confirm',
    confidence: 'high',
    status: 'open',
  })
  const itemMedium = createTurnActionItem({
    id: 'act-2',
    turn: 1,
    evidenceSeq: 2,
    kind: 'text-question',
    confidence: 'medium', // Not high, not counted in badge
    status: 'open',
  })
  const { render, flushEffects, SessionPane } = setupTurnActionsHarness({
    entries: [],
    groups: [],
    turnActions: [itemHigh, itemMedium],
  })
  render(SessionPane, { sessionId: 's-1' })
  await flushEffects()
  const tree = render(SessionPane, { sessionId: 's-1' })

  const pillText = t('turnActions.pillPendingCount').replace('{n}', '1')
  assert.ok(JSON.stringify(tree).includes(pillText), 'Pill must display exactly 1 pending action')
})

test('T-TAI-P4-4: Confirm action creates finding with provenance and marks item converted; re-confirm is idempotent', async () => {
  const actionItem = createTurnActionItem({
    id: 'act-1',
    turn: 3,
    evidenceSeq: 15,
    kind: 'confirm',
    confidence: 'high',
    title: 'Action Item 1',
    quote: 'Step 3 must be checked',
    status: 'open',
  })
  const { render, flushEffects, SessionPane, entriesStore, turnActionsMap } = setupTurnActionsHarness({
    entries: [],
    groups: [],
    turnActions: [actionItem],
  })
  render(SessionPane, { sessionId: 's-1' })
  await flushEffects()
  await new Promise(r => setTimeout(r, 20))
  let tree = render(SessionPane, { sessionId: 's-1' })

  const confirmBtn = flattenButtons(tree).find(b => b.props?.title === t('turnActions.action.createFinding'))
  assert.ok(confirmBtn, 'Create finding button must exist on action card')

  await confirmBtn.props.onClick()
  await flushEffects()

  // Finding created in store
  assert.equal(entriesStore.length, 1, 'Draft finding must be created in entriesStore')
  const createdFinding = entriesStore[0]
  assert.equal(createdFinding.origin, 'turn-action')
  assert.equal(createdFinding.sourceTurn, 3)
  assert.equal(createdFinding.sourceSeq, 15)
  assert.equal(createdFinding.originKey, itemOriginKey(actionItem))

  // Turn action marked converted
  const savedState = turnActionsMap.get('s-1')
  assert.equal(savedState.items[0].status, 'converted')
  assert.equal(savedState.items[0].findingId, createdFinding.id)

  // Re-render and check converted card layout
  tree = render(SessionPane, { sessionId: 's-1' })
  const treeStr = JSON.stringify(tree)
  assert.ok(treeStr.includes(t('turnActions.statusConverted')), 'Must display statusConverted badge (已确认)')
  assert.ok(treeStr.includes(t('turnActions.confidenceHigh')), 'Must display confidence badge')
  assert.ok(treeStr.includes(t('turnActions.evidenceSeq').replace('{seq}', '15')), 'Must display evidenceSeq badge')

  // Converted card is collapsed by default (quote excerpt not rendered)
  assert.equal(treeStr.includes('Step 3 must be checked'), false, 'Quote must be collapsed by default')

  const convertedCard = findNodesByClass(tree, 'pd-turn-action-card-converted')[0]
  assert.ok(convertedCard, 'Converted card must exist with pd-turn-action-card-converted class')

  // Click header to expand
  convertedCard.children[0].props.onClick()
  tree = render(SessionPane, { sessionId: 's-1' })
  assert.ok(JSON.stringify(tree).includes('Step 3 must be checked'), 'Quote must be visible when expanded')

  // Click header again to collapse
  const expandedCard = findNodesByClass(tree, 'pd-turn-action-card-converted')[0]
  expandedCard.children[0].props.onClick()
  tree = render(SessionPane, { sessionId: 's-1' })
  assert.equal(JSON.stringify(tree).includes('Step 3 must be checked'), false, 'Quote must be collapsed again')

  // View finding button exists on the top row with green success styling and "查看" label
  const viewFindingBtn = flattenButtons(tree).find(b => b.props?.title === t('turnActions.action.viewFinding'))
  assert.ok(viewFindingBtn, 'View finding button must appear when converted')
  assert.equal(textOfNode(viewFindingBtn), t('turnActions.action.viewFinding'))
  assert.equal(viewFindingBtn.props.style?.color, TONE_COLORS.success)
  assert.equal(viewFindingBtn.props.style?.borderColor, TONE_COLORS.success)
})

test('T-TAI-P4-3: turn header previews the submitted prompt', async () => {
  const actionItem = createTurnActionItem({
    id: 'act-preview',
    turn: 7,
    evidenceSeq: 41,
    kind: 'confirm',
    confidence: 'high',
    title: 'Turn 7 · 需确认 #1: Card title',
    status: 'open',
  })
  const { render, flushEffects, SessionPane } = setupTurnActionsHarness({
    entries: [],
    groups: [],
    turnActions: [actionItem],
    promptLogRows: [{
      turn: 7,
      promptText: '[会话手账 · 评审发现 1 条]\n1. [blocker] 修复 Action 分组头定位',
      excerpt: '修复 Action 分组头定位',
    }],
  })
  render(SessionPane, { sessionId: 's-1' })
  await flushEffects()
  await new Promise(r => setTimeout(r, 20))
  const tree = render(SessionPane, { sessionId: 's-1' })
  const preview = findNodeByTestId(tree, 'turn-action-preview')
  assert.ok(preview, 'turn header must render a prompt preview')
  const previewText = textOfNode(preview)
  assert.ok(previewText.includes('修复 Action 分组头定位'))
  assert.ok(!previewText.includes('[会话手账'))
})

test('T-TAI-P4-4: Draft deletion reversion: deleting finding reverts converted item to open', async () => {
  const finding = createFindingRecord({
    id: 'f-converted',
    sessionId: 's-1',
    text: 'Converted finding',
    origin: 'turn-action',
    originKey: 't:1:s:5:k:confirm',
  })
  const actionItem = createTurnActionItem({
    id: 'act-1',
    turn: 1,
    evidenceSeq: 5,
    kind: 'confirm',
    confidence: 'high',
    status: 'converted',
    findingId: 'f-converted',
  })
  const { render, flushEffects, SessionPane, entriesStore, turnActionsMap, notifySubscribers } = setupTurnActionsHarness({
    entries: [finding],
    groups: [],
    turnActions: [actionItem],
  })
  render(SessionPane, { sessionId: 's-1' })
  await flushEffects()

  // Now delete finding from entriesStore and notify subscribers to trigger load()
  entriesStore.splice(0, entriesStore.length)
  await notifySubscribers()
  await flushEffects()
  render(SessionPane, { sessionId: 's-1' })
  await flushEffects()

  const savedState = turnActionsMap.get('s-1')
  assert.equal(savedState.items[0].status, 'open', 'Action item must revert to open when linked finding is deleted')
  assert.equal(savedState.items[0].findingId == null, true, 'findingId must be cleared')
})

test('T-TAI-P4-4: Dismiss and Undo flow', async () => {
  const actionItem = createTurnActionItem({
    id: 'act-dismiss',
    turn: 2,
    evidenceSeq: 8,
    kind: 'unaddressed',
    confidence: 'high',
    title: 'Review this finding',
    quote: 'Important excerpt that should be collapsed when dismissed',
    status: 'open',
  })
  const { render, flushEffects, SessionPane, turnActionsMap } = setupTurnActionsHarness({
    entries: [],
    groups: [],
    turnActions: [actionItem],
  })
  render(SessionPane, { sessionId: 's-1' })
  await flushEffects()
  await new Promise(r => setTimeout(r, 20))
  let tree = render(SessionPane, { sessionId: 's-1' })

  const dismissBtn = flattenButtons(tree).find(b => b.props?.title === t('turnActions.action.dismiss'))
  assert.ok(dismissBtn, 'Dismiss button must exist')

  await dismissBtn.props.onClick()
  await flushEffects()

  let savedState = turnActionsMap.get('s-1')
  assert.equal(savedState.items[0].status, 'dismissed', 'Item status must be dismissed')

  // Render dismissed card
  tree = render(SessionPane, { sessionId: 's-1' })
  const treeStr = JSON.stringify(tree)

  // 1. Must display '已忽略' status badge, confidence, and evidence seq
  assert.ok(treeStr.includes(t('turnActions.statusDismissed')), 'Must render statusDismissed badge')
  assert.ok(treeStr.includes(t('turnActions.confidenceHigh')), 'Must render high confidence badge')
  assert.ok(treeStr.includes(t('turnActions.evidenceSeq').replace('{seq}', '8')), 'Must render evidenceSeq badge')

  // 2. Default collapsed: the quote should NOT be rendered
  assert.equal(treeStr.includes('Important excerpt that should be collapsed when dismissed'), false, 'Quote must be collapsed by default')

  // 3. Find the dismissed card and click header to expand
  const dismissedCard = findNodesByClass(tree, 'pd-turn-action-card-dismissed')[0]
  assert.ok(dismissedCard, 'Dismissed card must exist with pd-turn-action-card-dismissed class')
  const headerRow = dismissedCard.children[0]
  assert.ok(headerRow?.props?.onClick, 'Header row must be clickable for expand/collapse')
  headerRow.props.onClick()

  // Re-render: quote should now be visible
  tree = render(SessionPane, { sessionId: 's-1' })
  const expandedTreeStr = JSON.stringify(tree)
  assert.ok(expandedTreeStr.includes('Important excerpt that should be collapsed when dismissed'), 'Quote must be visible when expanded')

  // 4. Click header row again to collapse
  const expandedCard = findNodesByClass(tree, 'pd-turn-action-card-dismissed')[0]
  expandedCard.children[0].props.onClick()
  tree = render(SessionPane, { sessionId: 's-1' })
  assert.equal(JSON.stringify(tree).includes('Important excerpt that should be collapsed when dismissed'), false, 'Quote must be collapsed again')

  // 5. Click Undo button to restore to open state
  const undoBtn = flattenButtons(tree).find(b => b.props?.title === t('turnActions.action.undo'))
  assert.ok(undoBtn, 'Undo button must exist on dismissed item')

  await undoBtn.props.onClick()
  await flushEffects()

  savedState = turnActionsMap.get('s-1')
  assert.equal(savedState.items[0].status, 'open', 'Item status must be restored to open after undo')
})

test('T-TAI-P4-4: Question Pending reveals question panel', async () => {
  const questionItem = createTurnActionItem({
    id: 'act-q',
    turn: 4,
    evidenceSeq: 12,
    kind: 'question-pending',
    confidence: 'high',
    callId: 'call-1234',
    status: 'open',
  })
  const { render, flushEffects, SessionPane, revealedQuestions } = setupTurnActionsHarness({
    entries: [],
    groups: [],
    turnActions: [questionItem],
  })
  render(SessionPane, { sessionId: 's-1' })
  await flushEffects()
  const tree = render(SessionPane, { sessionId: 's-1' })

  const revealBtn = flattenButtons(tree).find(b => b.props?.title === t('turnActions.action.revealQuestion'))
  assert.ok(revealBtn, 'Reveal question button must exist for question-pending')

  revealBtn.props.onClick()
  assert.equal(revealedQuestions.length, 1)
  assert.equal(revealedQuestions[0].sessionId, 's-1')
  assert.equal(revealedQuestions[0].callId, 'call-1234')
})

test('T-TAI-P4-3: question-error has its own badge instead of Confirm', async () => {
  const actionItem = createTurnActionItem({
    id: 'act-q-error',
    turn: 5,
    evidenceSeq: 21,
    kind: 'question-error',
    confidence: 'high',
    status: 'open',
  })
  const { render, flushEffects, SessionPane } = setupTurnActionsHarness({
    entries: [],
    groups: [],
    turnActions: [actionItem],
  })
  render(SessionPane, { sessionId: 's-1' })
  await flushEffects()
  const tree = render(SessionPane, { sessionId: 's-1' })
  const text = textOfNode(tree)
  assert.ok(text.includes(t('turnActions.kind.questionError')), 'question-error badge must use its own locale key')
  assert.ok(!text.includes(t('turnActions.kind.confirm')), 'question-error must not fall back to the confirm label')
})

test('T-TAI-P4-3: stale action stays dismissible', async () => {
  const actionItem = createTurnActionItem({
    id: 'act-stale',
    turn: 2,
    evidenceSeq: 9,
    kind: 'turn-failed',
    confidence: 'high',
    status: 'stale',
  })
  const { render, flushEffects, SessionPane, turnActionsMap } = setupTurnActionsHarness({
    entries: [],
    groups: [],
    turnActions: [actionItem],
  })
  render(SessionPane, { sessionId: 's-1' })
  await flushEffects()
  const tree = render(SessionPane, { sessionId: 's-1' })
  const dismissBtn = flattenButtons(tree).find(b => b.props?.title === t('turnActions.action.dismiss'))
  assert.ok(dismissBtn, 'Stale action must still expose dismiss')
  await dismissBtn.props.onClick()
  await flushEffects()
  assert.equal(turnActionsMap.get('s-1').items[0].status, 'dismissed')
})

test('T-TAI-P4-4: Fork conversion carries the round note and review round', async () => {
  const parent = createFindingRecord({
    id: 'parent-round',
    sessionId: 's-1',
    workspaceId: 'ws-1',
    text: 'Parent body',
    title: 'Parent title',
    status: 'resolved',
    reviewStatus: 'resolved',
    reviewRound: 1,
  })
  const actionItem = createTurnActionItem({
    id: 'act-round',
    turn: 6,
    evidenceSeq: 31,
    kind: 'confirm',
    confidence: 'high',
    title: 'Round action',
    body: 'Round action body',
    quote: 'Round action body',
    relatedFindingId: 'parent-round',
    status: 'open',
  })
  const { render, flushEffects, SessionPane, entriesStore } = setupTurnActionsHarness({
    entries: [parent],
    groups: [],
    turnActions: [actionItem],
  })
  render(SessionPane, { sessionId: 's-1' })
  await flushEffects()
  await new Promise(r => setTimeout(r, 20))
  const tree = render(SessionPane, { sessionId: 's-1' })
  const confirmBtn = flattenButtons(tree).find(b => b.props?.title === t('turnActions.action.createFinding'))
  assert.ok(confirmBtn)
  await confirmBtn.props.onClick()
  await flushEffects()

  const forked = entriesStore.find(e => e.sourceFindingId === 'parent-round')
  assert.ok(forked, 'Forked finding must be created')
  assert.equal(forked.reviewRound, 2)
  assert.equal(forked.roundNote, t('entry.forkRoundNote').replace('{round}', '2'))
  assert.ok(forked.body.startsWith(forked.roundNote + '\n'))
})

