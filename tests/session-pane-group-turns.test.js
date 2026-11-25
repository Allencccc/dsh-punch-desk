/**
 * Session Pane: group turn attribution (plan 2026-11-12 Phase 2) and
 * BUG-2026-11-13-01 (queued rows must not stay 已排队 after the queue consumed
 * them).
 *
 * Covered here:
 * - three groups 7/2/1 + one direct input -> 7/2/2 (only the latest group grows);
 * - a combined submission charges only its target group;
 * - the wrap-up flow freezes `archivedTurn` + `archivedCharged`/`archivedAttributed`
 *   in the SAME putGroup upsert that writes `status:'archived'`;
 * - an archived group without a snapshot falls back to the live derivation with
 *   the 未冻结 label instead of pretending it froze;
 * - accepting a prompt whose evidence write fails keeps 已提交, never sets
 *   retryPending, never resends, and only retries the evidence;
 * - a persisted queued row whose queue item is gone never reads 已排队 again.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createFindingRecord } from '../src/domain/entries.js'
import { createSubmitService } from '../src/client/platform/submit.js'
import { createAcceptanceEvidenceWiring } from '../src/client/factory.js'
import { deriveGroupTurnStats, deriveLatestGroupId } from '../src/domain/group-turns.js'
import {
  deriveHarnessProjection,
  describeGroupTurns,
  summarizeOpenWork,
  summarizeGroupStatusCounts,
  formatGroupCountBadge,
  createSessionPane,
} from '../src/client/ui/session-pane.js'
import { dictionaries } from '../src/locale.js'
import { TIP_ATTR } from '../src/client/ui/tooltip-layer.js'
import { createHookRuntime, flattenButtons, textOfNode, h, t } from './helpers/pane-harness.js'

const dicts = dictionaries()

// ---------------------------------------------------------------------------
// Fixtures: a session whose three groups carry 7 / 2 / 1 charged turns and one
// direct composer turn that must only grow the latest group (7/2/2).
// ---------------------------------------------------------------------------

/**
 * @param {{ groupId: string, groupNumber: number, startTurn: number, charged: number,
 *   firstFinding: number, archived?: object }} input
 */
function buildGroup({ groupId, groupNumber, startTurn, charged, firstFinding, archived }) {
  const group = {
    id: groupId,
    groupNumber,
    sessionId: 's-1',
    workspaceId: 'ws-a',
    startTurn,
    status: archived ? 'archived' : 'active',
    items: [],
    createdAt: 1,
    ...(archived ?? {}),
  }
  const findings = []
  const promptLogs = []
  for (let index = 0; index < charged; index += 1) {
    const number = firstFinding + index
    const findingId = `f-${number}`
    const requestId = `r-${number}`
    const seq = number
    const turn = number
    const acceptedAt = 1000 + seq
    group.items.push({ findingId, order: index + 1 })
    findings.push({
      id: findingId,
      kind: 'finding',
      sessionId: 's-1',
      workspaceKey: 'session:s-1',
      workspaceId: 'ws-a',
      text: `finding ${number}`,
      body: `finding ${number}`,
      title: `finding ${number}`,
      tag: 'optimize',
      status: 'queued',
      submissionStatus: 'submitted',
      reviewStatus: 'pending',
      assignedGroupId: groupId,
      requestId,
      batchId: groupId,
      submittedAt: acceptedAt,
      acceptedAt,
      submissionSeq: seq,
      createdAt: 1,
      updatedAt: acceptedAt,
      thoughtNo: number,
    })
    promptLogs.push({
      messageId: `m-${number}`,
      sessionId: 's-1',
      requestId,
      batchId: groupId,
      turn,
      time: acceptedAt,
      source: 'desk-batch',
      status: 'completed',
      excerpt: `finding ${number}`,
      promptText: `finding ${number}`,
    })
  }
  return { group, findings, promptLogs }
}

/** The 7/2/1 session before the direct input. */
function threeGroupSession() {
  const g1 = buildGroup({ groupId: 'g-1', groupNumber: 1, startTurn: 0, charged: 7, firstFinding: 1 })
  const g2 = buildGroup({ groupId: 'g-2', groupNumber: 2, startTurn: 8, charged: 2, firstFinding: 8 })
  const g3 = buildGroup({ groupId: 'g-3', groupNumber: 3, startTurn: 9, charged: 1, firstFinding: 10 })
  return {
    groups: [g1.group, g2.group, g3.group],
    findings: [...g1.findings, ...g2.findings, ...g3.findings],
    promptLogs: [...g1.promptLogs, ...g2.promptLogs, ...g3.promptLogs],
  }
}

/** One direct composer row (no batchId): turn 11, after every accepted submission. */
function directInputRow(over = {}) {
  return {
    messageId: 'm-direct-11',
    sessionId: 's-1',
    turn: 11,
    time: 2000,
    source: 'composer',
    status: 'completed',
    excerpt: 'direct input',
    promptText: 'direct input',
    ...over,
  }
}

// ---------------------------------------------------------------------------
// Pane harness (local): the shared helper has a fixed submit service, and this
// suite needs to drive the acceptance-evidence and queued transitions.
// ---------------------------------------------------------------------------

/**
 * @param {{ groups?: object[], entries?: object[], promptLogs?: object[], traces?: object[],
 *   currentTurn?: number, submit?: object, services?: object }} [input]
 */
function makePaneHarness({ groups = [], entries = [], promptLogs = [], traces = [], currentTurn = 0, submit, services: extra } = {}) {
  const { React, render, flushEffects } = createHookRuntime()
  const groupsStore = [...groups]
  const entriesStore = [...entries]
  const promptLogStore = [...promptLogs]
  const tracesStore = [...traces]
  let putGroupCalls = 0
  const writeOrder = []

  const services = {
    t,
    store: {
      listEntries: async () => entriesStore,
      putEntry: async entry => {
        writeOrder.push(`putEntry:${entry.id}`)
        const index = entriesStore.findIndex(item => item.id === entry.id)
        if (index >= 0) entriesStore[index] = entry
        else entriesStore.push(entry)
      },
      deleteEntry: async (_key, id) => {
        const index = entriesStore.findIndex(item => item.id === id)
        if (index >= 0) entriesStore.splice(index, 1)
      },
      getGroups: async () => groupsStore,
      putGroup: async group => {
        // Mirror the real store's Phase 4 / B6 invariant: every item must
        // resolve to a persisted finding of the same session, so the pane's
        // write order is exercised against the same rule as production.
        for (const item of group.items ?? []) {
          const found = entriesStore.find(row => row.id === item.findingId)
          if (!found) {
            throw new Error(`Invalid GroupRecord: item[] finding not found: ${item.findingId}`)
          }
          if (found.sessionId !== group.sessionId) {
            throw new Error(`Invalid GroupRecord: item[] finding belongs to another session: ${item.findingId}`)
          }
        }
        writeOrder.push(`putGroup:${group.id}`)
        putGroupCalls += 1
        const index = groupsStore.findIndex(item => item.id === group.id)
        if (index >= 0) groupsStore[index] = group
        else groupsStore.push(group)
      },
      subscribe: () => () => {},
      listCommitTraces: () => tracesStore,
      quotaWarning: () => false,
    },
    commitTraces: { retryTrace: async () => ({ ok: true }) },
    index: {
      listRecent: async () => promptLogStore,
      start: () => {},
      stop: () => {},
      getTurn: () => 0,
    },
    submit: submit ?? createSubmitService({ remote: { session: {} } }),
    createFinding: args => createFindingRecord(args),
    uuid: () => 'uuid-test',
    ...extra,
  }

  const SessionPane = createSessionPane({ h, React, services })
  return {
    React,
    render,
    flushEffects,
    SessionPane,
    services,
    groupsStore,
    entriesStore,
    promptLogStore,
    getPutGroupCalls: () => putGroupCalls,
    writeOrder,
    async renderPane(props = {}) {
      render(SessionPane, { sessionId: 's-1', currentTurn, ...props })
      await flushEffects()
      let tree = render(SessionPane, { sessionId: 's-1', currentTurn, ...props })
      await flushEffects()
      tree = render(SessionPane, { sessionId: 's-1', currentTurn, ...props })
      return tree
    },
  }
}

/** Every tooltip-ish string carried by any node (tip prop or the drawn layer attr). */
function collectTips(node, acc = []) {
  if (!node || typeof node !== 'object') return acc
  const tip = node.props?.tip ?? node.props?.[TIP_ATTR]
  if (typeof tip === 'string' && tip !== '') acc.push(tip)
  for (const child of node.children || []) collectTips(child, acc)
  return acc
}

// ---------------------------------------------------------------------------

test('three groups 7/2/1 with one direct input read 7/2/2 instead of the shared session clock', async () => {
  const session = threeGroupSession()
  const harness = makePaneHarness({
    ...session,
    promptLogs: [...session.promptLogs, directInputRow()],
    currentTurn: 11,
  })
  const tree = await harness.renderPane()
  const text = textOfNode(tree)
  assert.equal(tree.props.style.minWidth, 320, 'session pane keeps a usable minimum width')
  assert.equal(tree.props.style.overflowX, 'auto', 'narrow panes scroll horizontally')

  const badge = (turns) => t('group.groupTurnsBadge').replace('{turns}', String(turns))
  const triggered = (count) => t('group.triggeredBadge').replace('{count}', String(count))
  const direct = (count) => t('group.attributedBadge').replace('{count}', String(count))
  const occurrences = (needle) => text.split(needle).length - 1

  assert.ok(text.includes(badge(7)), 'G1 keeps its own 7 charged turns')
  assert.ok(text.indexOf(t('group.title').replace('{number}', '1')) < text.indexOf(badge(7)), 'group name precedes turn metrics')
  assert.ok(text.includes(triggered(7)))
  assert.equal(occurrences(badge(2)), 2, 'G2 and G3 both read 2 group turns (G2 did not grow, G3 gained the direct turn)')
  assert.ok(text.includes(triggered(2)), 'G2 charged turns stay at 2')
  assert.ok(text.includes(triggered(1)), 'G3 charged turns stay at 1')
  assert.ok(text.includes(direct(0)), 'G1/G2 have no direct attribution')
  assert.equal(occurrences(direct(1)), 1, 'exactly one group (the latest) owns the direct turn')

  // The buggy elapsed view would have shown the same session clock for every
  // group: 11/3/2 here. None of those numbers may be the group workload.
  const elapsedBadge = (turns, groupNumber) => t('group.shortBadge')
    .replace('{turns}', String(turns)).replace('{groupNumber}', String(groupNumber))
  assert.ok(!text.includes(elapsedBadge(11, 1)), 'session elapsed must not be shown as G1 workload')
  assert.ok(!text.includes(elapsedBadge(3, 2)), 'session elapsed must not be shown as G2 workload')
  assert.ok(!text.includes(elapsedBadge(2, 3)), 'session elapsed must not be shown as G3 workload')
  assert.ok(!text.includes(badge(8)) && !text.includes(triggered(3)), 'no group may absorb the session clock')

  // The tooltip carries the session context and the retention-window semantics.
  const collapsedMetricSpans = []
  const collectMetricSpans = node => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const child of node) collectMetricSpans(child); return }
    if (node.props?.style?.maxWidth === 0) collapsedMetricSpans.push(node)
    for (const child of node.children || []) collectMetricSpans(child)
  }
  collectMetricSpans(tree)
  assert.ok(collapsedMetricSpans.length >= 3, 'group turn detail spans default collapsed')
  const countButtons = flattenButtons(tree).filter(button => button.props?.['data-action'] === 'group-status-counts')
  assert.ok(countButtons.length >= 3, 'each group exposes a clickable total-count badge')
  await countButtons[0].props.onClick({ stopPropagation() {} })
  const countExpandedTree = await harness.renderPane()
  const countDetailSpans = []
  const collectCountDetails = node => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const child of node) collectCountDetails(child); return }
    if (node.props?.style?.maxWidth === 360) countDetailSpans.push(node)
    for (const child of node.children || []) collectCountDetails(child)
  }
  collectCountDetails(countExpandedTree)
  assert.ok(countDetailSpans.length >= 1, 'clicking total count expands per-status badges')
  const metricsButton = flattenButtons(tree).find(button => button.props?.['data-action'] === 'group-turn-metrics')
  assert.ok(metricsButton, 'turn metrics chip is clickable')
  await metricsButton.props.onClick({ stopPropagation() {} })
  const expandedTree = await harness.renderPane()
  const expandedSpans = []
  const collectExpanded = node => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const child of node) collectExpanded(child); return }
    if (node.props?.style?.maxWidth === 220) expandedSpans.push(node)
    for (const child of node.children || []) collectExpanded(child)
  }
  collectExpanded(expandedTree)
  assert.ok(expandedSpans.length >= 1, 'clicking the chip expands the direct-attribution details to the right')
  const elapsedTip = (turns) => t('group.elapsedTip').replace('{turns}', String(turns))
  const tips = collectTips(tree)
  assert.ok(tips.some(tip => tip.includes(elapsedTip(11))), 'G1 tooltip keeps session elapsed as context')
  assert.ok(tips.some(tip => tip.includes(elapsedTip(3))), 'G2 tooltip keeps its own session elapsed')
  assert.ok(tips.some(tip => tip.includes(t('group.turnsTip'))), 'group turns tooltip must explain the window semantics')
})

test('combined submission charges only the target group and moves latest to it', () => {
  const session = threeGroupSession()
  const input = { ...session, traces: [], currentTurn: 11 }
  const before = {
    g1: deriveGroupTurnStats(session.groups[0], input),
    g2: deriveGroupTurnStats(session.groups[1], input),
    g3: deriveGroupTurnStats(session.groups[2], input),
  }
  assert.deepEqual([before.g1.charged, before.g2.charged, before.g3.charged], [7, 2, 1])
  assert.equal(deriveLatestGroupId(input), 'g-3')

  // One combined submission of two findings to G1: one requestId, one turn 12.
  const combinedFindings = [
    { id: 'f-c1', sessionId: 's-1', assignedGroupId: 'g-1', requestId: 'r-combined', submissionStatus: 'submitted', acceptedAt: 3000, submissionSeq: 12 },
    { id: 'f-c2', sessionId: 's-1', assignedGroupId: 'g-1', requestId: 'r-combined', submissionStatus: 'submitted', acceptedAt: 3000, submissionSeq: 12 },
  ]
  const next = {
    groups: session.groups,
    findings: [...session.findings, ...combinedFindings],
    promptLogs: [...session.promptLogs, {
      messageId: 'm-combined', sessionId: 's-1', requestId: 'r-combined', batchId: 'g-1',
      turn: 12, time: 3000, source: 'desk-batch', status: 'completed',
    }],
    traces: [],
    currentTurn: 12,
  }
  const after = {
    g1: deriveGroupTurnStats(session.groups[0], next),
    g2: deriveGroupTurnStats(session.groups[1], next),
    g3: deriveGroupTurnStats(session.groups[2], next),
  }
  assert.equal(after.g1.charged, 8, 'combined adds exactly one charged turn to the target group')
  assert.equal(after.g2.charged, 2, 'other groups are untouched by a combined submission')
  assert.equal(after.g3.charged, 1)
  assert.equal(deriveLatestGroupId(next), 'g-1', 'the latest accepted submission moves latest to the target')
  // The next direct turn follows the new latest group.
  const withDirect = {
    ...next,
    promptLogs: [...next.promptLogs, directInputRow({ messageId: 'm-direct-13', turn: 13, time: 4000 })],
  }
  assert.equal(deriveGroupTurnStats(session.groups[0], withDirect).attributed, 1,
    'the direct turn after the combined submission belongs to the target group')
})

test('wrap-up freezes archivedTurn and the charged/attributed window snapshot in one putGroup upsert', async () => {
  const g1 = buildGroup({ groupId: 'g-1', groupNumber: 1, startTurn: 0, charged: 2, firstFinding: 1 })
  const harness = makePaneHarness({
    groups: [g1.group],
    entries: g1.findings,
    promptLogs: [...g1.promptLogs, directInputRow({ messageId: 'm-direct-3', turn: 3, time: 2500 })],
    currentTurn: 3,
  })
  let tree = await harness.renderPane()
  // Two clicks: arm the inline confirmation, then confirm (write-once).
  const armButton = flattenButtons(tree).find(button => button.props?.['aria-label'] === t('group.wrapUpAria'))
  assert.ok(armButton, 'wrap-up action must be available for a finished batch')
  assert.notEqual(armButton.props.disabled, true, 'executed rows must not block wrap-up')
  armButton.props.onClick()
  tree = harness.render(harness.SessionPane, { sessionId: 's-1', currentTurn: 3 })
  const confirmButton = flattenButtons(tree)
    .find(button => button.props?.['aria-label'] === t('group.wrapUpConfirmYes'))
  assert.ok(confirmButton, 'wrap-up requires the two-step confirmation')
  await confirmButton.props.onClick()
  await harness.flushEffects()

  const archived = harness.groupsStore.find(group => group.id === 'g-1')
  assert.equal(archived.status, 'archived')
  assert.equal(archived.archivedTurn, 3, 'the wrap-up turn is frozen')
  assert.equal(archived.archivedElapsed, 3, 'elapsed is frozen as session context')
  assert.equal(archived.archivedCharged, 2, 'charged window snapshot is frozen')
  assert.equal(archived.archivedAttributed, 1, 'attributed window snapshot is frozen (direct turn before wrap-up)')
  assert.equal(harness.getPutGroupCalls(), 1, 'status + snapshot must land in the same putGroup upsert')
})

test('an archived group without a snapshot falls back to live values and is labelled 未冻结', async () => {
  const g1 = buildGroup({
    groupId: 'g-1', groupNumber: 1, startTurn: 0, charged: 2, firstFinding: 1,
    archived: { archivedAt: 3000 },
  })
  const harness = makePaneHarness({
    groups: [g1.group],
    entries: g1.findings,
    promptLogs: [...g1.promptLogs, directInputRow({ messageId: 'm-direct-3', turn: 3, time: 2500 })],
    currentTurn: 40,
  })
  const tree = await harness.renderPane({ currentTurn: 40 })
  const text = textOfNode(tree)

  const archivedBadge = t('group.archivedAtBadge').replace('{turns}', '3') + ' · ' + t('group.unfrozenBadge')
  assert.ok(text.includes(archivedBadge), 'a missing snapshot must read 归档时 N 轮 · 未冻结')
  assert.ok(text.includes(t('group.triggeredBadge').replace('{count}', '2')), 'fallback uses the live charged derivation')
  assert.ok(text.includes(t('group.attributedBadge').replace('{count}', '1')), 'fallback uses the live attributed derivation')
  assert.ok(collectTips(tree).some(tip => tip.includes(t('group.unfrozenTip'))), 'the tooltip must explain the missing freeze')
})

test('archived window snapshot does not grow when the session advances', async () => {
  const g1 = buildGroup({
    groupId: 'g-1', groupNumber: 1, startTurn: 0, charged: 2, firstFinding: 1,
    archived: {
      archivedAt: 3000, archivedTurn: 3, archivedElapsed: 3, archivedCharged: 2, archivedAttributed: 1,
    },
  })
  const harness = makePaneHarness({
    groups: [g1.group],
    entries: g1.findings,
    promptLogs: [
      ...g1.promptLogs,
      directInputRow({ messageId: 'm-direct-3', turn: 3, time: 2500 }),
      directInputRow({ messageId: 'm-direct-39', turn: 39, time: 9000 }),
    ],
    currentTurn: 40,
  })
  const tree = await harness.renderPane({ currentTurn: 40 })
  const text = textOfNode(tree)
  assert.ok(text.includes(t('group.archivedAtBadge').replace('{turns}', '3')), 'the frozen main number stays at wrap-up time')
  assert.ok(text.includes(t('group.triggeredBadge').replace('{count}', '2')))
  assert.ok(text.includes(t('group.attributedBadge').replace('{count}', '1')), 'direct turns after the wrap-up never join a frozen snapshot')
  assert.ok(!text.includes(t('group.unfrozenBadge')), 'a frozen snapshot is not labelled 未冻结')
  assert.ok(collectTips(tree).some(tip => tip.includes(t('group.archivedFrozenTip'))), 'the tooltip explains the freeze')
})

test('evidencePending keeps the submission fact, never marks it failed, and never resends the prompt', async () => {
  const poolFinding = createFindingRecord({
    id: 'f-pool', sessionId: 's-1', text: 'Needs submission', submissionStatus: 'unsubmitted',
  })
  const g1 = {
    id: 'g-1', groupNumber: 1, sessionId: 's-1', workspaceId: 'ws-a', startTurn: 0,
    status: 'active', items: [], createdAt: 1,
  }
  const prompts = []
  const submit = {
    queryQueue: async () => ({ ok: true, value: [] }),
    submitCombined: async (sessionId, entries, requestId) => {
      prompts.push({ sessionId, entries, requestId })
      return {
        ok: true,
        accepted: true,
        requestId,
        evidencePending: true,
        evidenceError: { code: 'submit/evidence-failed', message: 'store unavailable' },
      }
    },
    submitSequential: async () => ({ ok: true, requests: [] }),
    fork: finding => finding,
  }
  const harness = makePaneHarness({ groups: [g1], entries: [poolFinding], promptLogs: [], submit })
  let tree = await harness.renderPane()
  const checkbox = (function find(node) {
    if (!node || typeof node !== 'object') return null
    if (node.type === 'input' && node.props?.type === 'checkbox' && node.props?.id !== 'selectAllCheckbox') return node
    for (const child of node.children || []) { const found = find(child); if (found) return found }
    return null
  })(tree)
  assert.ok(checkbox, 'the pool finding must be selectable')
  checkbox.props.onChange()
  tree = harness.render(harness.SessionPane, { sessionId: 's-1', currentTurn: 0 })
  const submitPrefix = t('dock.submitTo').split('{')[0]
  const submitButton = flattenButtons(tree).find(button => typeof button.props?.title === 'string'
    && (button.props.title.startsWith(submitPrefix) || button.props.title === t('dock.submitCombined1Turn')))
  assert.ok(submitButton, 'combined submit button must exist')
  await submitButton.props.onClick()
  await harness.flushEffects()
  tree = harness.render(harness.SessionPane, { sessionId: 's-1', currentTurn: 0 })

  const stored = harness.entriesStore.find(entry => entry.id === 'f-pool')
  assert.equal(stored.submissionStatus, 'submitted', 'an accepted prompt keeps the submitted fact')
  assert.ok(typeof stored.requestId === 'string' && stored.requestId !== '', 'the original requestId is preserved')
  assert.ok(!stored.retryPending, 'evidencePending must not set retryPending')
  assert.ok(!stored.lastSubmitError, 'evidencePending must not record a submit failure')
  assert.equal(prompts.length, 1, 'the prompt must never be resent')
  assert.equal(prompts[0].requestId, stored.requestId, 'the retry/evidence path reuses the same requestId')

  const text = textOfNode(tree)
  assert.ok(text.includes(t('group.evidencePending')), 'the pane must show 已提交 · 归属证据待补')
  assert.ok(
    collectTips(tree).some(tip => tip === t('group.evidencePendingTip')),
    'the pending notice must explain that only the evidence write is retried',
  )
  assert.ok(!text.includes(t('finding.reconciledFailed')), 'evidencePending is not a submit failure')
  assert.ok(
    !flattenButtons(tree).some(button => button.props?.title === t('finding.retry')),
    'no retry-submit entry may be offered for evidencePending',
  )
})

test('a consumed queue item with a completed PromptLog row reads executed, not queued (BUG-2026-11-13-01)', async () => {
  const queued = {
    id: 'f-23',
    kind: 'finding',
    sessionId: 's-1',
    workspaceKey: 'session:s-1',
    workspaceId: 'ws-a',
    text: 'submission 23',
    body: 'submission 23',
    title: 'submission 23',
    tag: 'optimize',
    // Persisted last-known state: the queue consumed it but nothing rewrote the status.
    status: 'queued',
    submissionStatus: 'submitted',
    reviewStatus: 'pending',
    assignedGroupId: 'g-1',
    requestId: 'req-23',
    batchId: 'g-1',
    submittedAt: 1000,
    acceptedAt: 1000,
    submissionSeq: 1,
    createdAt: 1,
    updatedAt: 1000,
    thoughtNo: 23,
  }
  const g1 = {
    id: 'g-1', groupNumber: 1, sessionId: 's-1', workspaceId: 'ws-a', startTurn: 0,
    status: 'active', items: [{ findingId: 'f-23', order: 1 }], createdAt: 1,
  }
  const completedRows = [{
    messageId: 'm-23', sessionId: 's-1', requestId: 'req-23', batchId: 'g-1',
    turn: 7, time: 1100, source: 'desk-batch', status: 'completed',
  }]
  const submit = {
    queryQueue: async () => ({ ok: true, value: [] }),
    submitCombined: async () => ({ ok: true, accepted: true }),
    submitSequential: async () => ({ ok: true, requests: [] }),
    fork: finding => finding,
  }
  const harness = makePaneHarness({
    groups: [g1], entries: [queued], promptLogs: completedRows, currentTurn: 7, submit,
  })
  const tree = await harness.renderPane({ currentTurn: 7 })
  const text = textOfNode(tree)

  assert.equal(deriveHarnessProjection(queued, completedRows, []), 'executed')
  assert.ok(text.includes(t('finding.badge.executed')), 'the row must read 已执行 after execution')
  assert.ok(collectTips(tree).some(tip => tip.includes(t('finding.badge.executedTip'))), 'the row tooltip keeps 待结项 context')
  assert.ok(!text.includes(t('status.queued')), 'a consumed queue item must never keep reading 已排队')
  // The group header badge agrees with the row (same projection source).
  assert.ok(text.includes(t('group.status.completed')), 'group badge must follow the row into completed')
  const wrapUp = flattenButtons(tree).find(button => button.props?.['aria-label'] === t('group.wrapUpAria'))
  assert.ok(wrapUp, 'wrap-up must be offered once the batch is static')
  assert.notEqual(wrapUp.props.disabled, true, 'a stale queued row must not block wrap-up any more')

  // Header counters: the stale queued projection no longer counts as queued.
  const summary = summarizeOpenWork({
    entries: [queued],
    groups: [g1],
    poolCount: 0,
    findingsMap: new Map([[queued.id, queued]]),
    harnessProjectionsMap: (id, finding) => deriveHarnessProjection(finding, completedRows, []),
  })
  assert.equal(summary.queued, 0, 'group header queued count must drop to zero')
  assert.equal(summary.needsWrapUp, true)
})

test('a persisted queued row whose queue item is gone never echoes queued, and never fakes execution', () => {
  const finding = {
    id: 'f-25', submissionStatus: 'submitted', status: 'queued', requestId: 'req-25',
  }
  // Queue read and the item is absent -> the prompt left the queue; execution is
  // unproven, so it must be unknown (not queued, not executed).
  assert.equal(deriveHarnessProjection(finding, [], []), 'unknown')
  // A delivered PromptLog row proves a turn started but not that it finished.
  assert.equal(deriveHarnessProjection(finding, [{ requestId: 'req-25', status: 'sent' }], []), 'running')
  // Terminal evidence claims execution.
  assert.equal(deriveHarnessProjection(finding, [{ requestId: 'req-25', status: 'completed' }], []), 'executed')
  assert.equal(deriveHarnessProjection(finding, [{ requestId: 'req-25', status: 'executed' }], []), 'executed')
  // A queue placeholder is not turn evidence.
  assert.equal(deriveHarnessProjection(finding, [{ requestId: 'req-25', status: 'queued' }], []), 'unknown')
  // Still in the live queue: queued (running when the host says so).
  assert.equal(deriveHarnessProjection(finding, [], [{ rpcId: 'req-25' }]), 'queued')
  assert.equal(deriveHarnessProjection(finding, [], [{ rpcId: 'req-25', status: 'running' }]), 'running')
  // Queue not read (null) proves nothing: keep the last known persisted value.
  assert.equal(deriveHarnessProjection(finding, [], null), 'queued')
  // A resolved review is execution evidence regardless of the persisted status.
  assert.equal(deriveHarnessProjection({ ...finding, reviewStatus: 'resolved' }, [], []), 'executed')
})

test('acceptance evidence: overlapping acceptances get serial sequence numbers and are persisted before the next allocation', async () => {
  const store = {
    rows: new Map(),
    async listEntries(key) { return [...(this.rows.get(key) ?? [])] },
    async putEntry(entry) {
      const list = this.rows.get(entry.workspaceKey) ?? []
      const index = list.findIndex(item => item.id === entry.id)
      if (index >= 0) list[index] = entry
      else list.push(entry)
      this.rows.set(entry.workspaceKey, list)
    },
  }
  const wiring = createAcceptanceEvidenceWiring({ store })
  const events = []
  const writable = {
    ...store,
    async putEntry(entry) {
      events.push(`write:${entry.id}:${entry.submissionSeq}`)
      if (entry.id === 'f-1') await new Promise(resolve => setTimeout(resolve, 20))
      return store.putEntry(entry)
    },
  }
  const wiringWithDelay = createAcceptanceEvidenceWiring({ store: writable })
  assert.equal(typeof wiring.onAccepted, 'function')

  const submit = createSubmitService({
    remote: { session: { prompt: async () => ({ ok: true, accepted: true }) } },
    now: () => 5000,
    submissionSeqAllocator: wiringWithDelay.submissionSeqAllocator,
    onAccepted: args => wiringWithDelay.onAccepted(args),
  })
  const findingOne = { id: 'f-1', workspaceKey: 'session:s-1', sessionId: 's-1', assignedGroupId: 'g-1' }
  const findingTwo = { id: 'f-2', workspaceKey: 'session:s-1', sessionId: 's-1', assignedGroupId: 'g-1' }

  // Two overlapping acceptances: the second must wait for the first write.
  const first = submit.submitCombined('s-1', [findingOne])
  const second = submit.submitCombined('s-1', [findingTwo])
  const [firstResult, secondResult] = await Promise.all([first, second])

  assert.equal(firstResult.ok, true)
  assert.equal(firstResult.accepted, true)
  assert.equal(firstResult.submissionSeq, 1)
  assert.equal(secondResult.submissionSeq, 2, 'the overlapping acceptance must not reuse seq 1')
  assert.deepEqual(events, ['write:f-1:1', 'write:f-2:2'], 'the second reservation waits for the first write to land')

  const persisted = await store.listEntries('session:s-1')
  const storedOne = persisted.find(entry => entry.id === 'f-1')
  const storedTwo = persisted.find(entry => entry.id === 'f-2')
  assert.equal(storedOne.acceptedAt, 5000)
  assert.equal(storedOne.submissionSeq, 1)
  assert.equal(storedTwo.acceptedAt, 5000)
  assert.equal(storedTwo.submissionSeq, 2)

  // A third acceptance continues above the persisted max (no persisted counter).
  const third = await submit.submitCombined('s-1', [{ id: 'f-3', workspaceKey: 'session:s-1', sessionId: 's-1', assignedGroupId: 'g-2' }])
  assert.equal(third.submissionSeq, 3)

  const latest = deriveLatestGroupId({
    groups: [{ id: 'g-1', status: 'active' }, { id: 'g-2', status: 'active' }],
    findings: await store.listEntries('session:s-1'),
    promptLogs: [],
  })
  assert.equal(latest, 'g-2', 'latest follows the highest accepted submissionSeq')
})

test('acceptance evidence write failure reports evidencePending and is retried with the same sequence', async () => {
  let failNext = true
  const store = {
    rows: new Map(),
    async listEntries(key) { return [...(this.rows.get(key) ?? [])] },
    async putEntry(entry) {
      if (failNext) {
        failNext = false
        throw new Error('disk full')
      }
      const list = this.rows.get(entry.workspaceKey) ?? []
      const index = list.findIndex(item => item.id === entry.id)
      if (index >= 0) list[index] = entry
      else list.push(entry)
      this.rows.set(entry.workspaceKey, list)
    },
  }
  const wiring = createAcceptanceEvidenceWiring({ store })
  let prompts = 0
  const submit = createSubmitService({
    remote: { session: { prompt: async () => { prompts += 1; return { ok: true, accepted: true } } } },
    now: () => 7000,
    submissionSeqAllocator: wiring.submissionSeqAllocator,
    onAccepted: args => wiring.onAccepted(args),
  })
  const finding = { id: 'f-lost', workspaceKey: 'session:s-1', sessionId: 's-1', assignedGroupId: 'g-1' }
  const result = await submit.submitCombined('s-1', [finding], 'req-lost')

  assert.equal(result.ok, true, 'the prompt was accepted: not a send failure')
  assert.equal(result.accepted, true)
  assert.equal(result.evidencePending, true)
  assert.equal(result.requestId, 'req-lost', 'the original requestId is preserved')
  assert.equal(result.submissionSeq, 1, 'the reserved sequence is reported for the evidence retry')
  assert.equal(prompts, 1, 'the prompt is never resent')
  assert.equal((await store.listEntries('session:s-1')).length, 0, 'nothing was persisted yet')
  assert.equal(wiring.submissionSeqAllocator.isBlocked('s-1'), true, 'the reservation stays blocked')

  // The block is explicit: a new acceptance cannot silently reuse or skip the seq.
  const blocked = await submit.submitCombined('s-1', [{ id: 'f-other', workspaceKey: 'session:s-1', sessionId: 's-1', assignedGroupId: 'g-1' }])
  assert.equal(blocked.evidencePending, true)
  assert.equal(blocked.submissionSeq, undefined, 'another request must not inherit the blocked reservation')

  const retried = await wiring.submissionSeqAllocator.retry('s-1')
  assert.equal(retried.seq, 1)
  assert.equal(wiring.submissionSeqAllocator.isBlocked('s-1'), false)
  const persisted = await store.listEntries('session:s-1')
  const stored = persisted.find(entry => entry.id === 'f-lost')
  assert.equal(stored.submissionSeq, 1, 'the retry reuses the original reserved sequence')
  assert.equal(stored.acceptedAt, 7000)
})

test('describeGroupTurns is zh/en paired and carries the window tooltip', () => {
  const stats = { groupTurns: 3, charged: 2, attributed: 1, elapsed: 5, source: 'live', frozen: false }
  const zh = describeGroupTurns(stats, key => dicts.zh[key] ?? key)
  assert.equal(zh.turns, '本组 3 轮')
  assert.equal(zh.triggered, '触发 2')
  assert.equal(zh.attributed, '直输归属 1')
  assert.ok(zh.turnsTip.includes(dicts.zh['group.turnsTip']))
  assert.ok(zh.turnsTip.includes(dicts.zh['group.elapsedTip'].replace('{turns}', '5')))
  assert.ok(zh.triggeredTip.length > 0 && zh.attributedTip.length > 0)

  const en = describeGroupTurns(stats, key => dicts.en[key] ?? key)
  assert.equal(en.turns, '3 group turns')
  assert.equal(en.triggered, '2 triggered')
  assert.equal(en.attributed, '1 direct turns')
  assert.ok(!en.turns.includes('session turns'), 'English must not call group turns "session turns"')

  const archived = describeGroupTurns(
    { groupTurns: 3, charged: 2, attributed: 1, elapsed: 4, source: 'archived', frozen: true },
    key => dicts.zh[key] ?? key,
  )
  assert.equal(archived.turns, '归档时 3 轮')
  assert.ok(archived.turnsTip.includes(dicts.zh['group.archivedFrozenTip']))

  const unfrozen = describeGroupTurns(
    { groupTurns: 3, charged: 2, attributed: 1, elapsed: 4, source: 'live-unfrozen', frozen: false },
    key => dicts.zh[key] ?? key,
  )
  assert.equal(unfrozen.turns, '归档时 3 轮 · 未冻结')
  assert.ok(unfrozen.turnsTip.includes(dicts.zh['group.unfrozenTip']))
  // Malformed stats must never throw while rendering a header.
  assert.equal(describeGroupTurns(null, key => dicts.zh[key] ?? key).turns, '本组 0 轮')
})

// ---------------------------------------------------------------------------
// B6 / plan Phase 4: the pane must persist referenced findings before the group
// that names them, and a rejected group write must roll the assignment back
// instead of leaving a silent orphan.
// ---------------------------------------------------------------------------

/** The pooled finding's selection checkbox (not the select-all box). */
function findPoolCheckbox(node) {
  if (!node || typeof node !== 'object') return null
  if (node.type === 'input' && node.props?.type === 'checkbox' && node.props?.id !== 'selectAllCheckbox') return node
  for (const child of node.children || []) {
    const found = findPoolCheckbox(child)
    if (found) return found
  }
  return null
}

/** Select the pooled finding, then click the combined-submit dock button. */
async function submitCombinedViaDock(harness, tree, currentTurn = 0) {
  const checkbox = findPoolCheckbox(tree)
  assert.ok(checkbox, 'the pool finding must be selectable')
  checkbox.props.onChange()
  const withSelection = harness.render(harness.SessionPane, { sessionId: 's-1', currentTurn })
  const submitPrefix = t('dock.submitTo').split('{')[0]
  const submitButton = flattenButtons(withSelection).find(button => typeof button.props?.title === 'string'
    && (button.props.title.startsWith(submitPrefix) || button.props.title === t('dock.submitCombined1Turn')))
  assert.ok(submitButton, 'combined submit button must exist')
  await submitButton.props.onClick()
  await harness.flushEffects()
  return harness.render(harness.SessionPane, { sessionId: 's-1', currentTurn })
}

/** The drop target wrapping the group card whose header carries `title`. */
function findGroupDropNode(node, title) {
  if (!node || typeof node !== 'object') return null
  if (typeof node.props?.onDrop === 'function' && textOfNode(node).includes(title)) return node
  for (const child of node.children || []) {
    const found = findGroupDropNode(child, title)
    if (found) return found
  }
  return null
}

/** A group harness fixture with an empty active G1. */
function emptyGroup() {
  return {
    id: 'g-1', groupNumber: 1, sessionId: 's-1', workspaceId: 'ws-a', startTurn: 0,
    status: 'active', items: [], createdAt: 1,
  }
}

function dragSubmitStub(prompts = []) {
  return {
    queryQueue: async () => ({ ok: true, value: [] }),
    submitCombined: async (sessionId, entries, requestId) => {
      prompts.push({ sessionId, requestId })
      return { ok: true, accepted: true, requestId }
    },
    submitSequential: async () => ({ ok: true, requests: [] }),
    fork: finding => finding,
  }
}

test('submission persists every referenced finding before the group that names them', async () => {
  const poolFinding = createFindingRecord({
    id: 'f-pool', sessionId: 's-1', text: 'Needs submission', submissionStatus: 'unsubmitted',
  })
  const prompts = []
  const harness = makePaneHarness({
    groups: [emptyGroup()],
    entries: [poolFinding],
    promptLogs: [],
    submit: dragSubmitStub(prompts),
  })
  const tree = await harness.renderPane()
  await submitCombinedViaDock(harness, tree)

  const groupWriteIndex = harness.writeOrder.indexOf('putGroup:g-1')
  const entryWriteIndex = harness.writeOrder.indexOf('putEntry:f-pool')
  assert.notEqual(entryWriteIndex, -1, 'the referenced finding must be written')
  assert.notEqual(groupWriteIndex, -1, 'the group write must happen')
  assert.ok(entryWriteIndex < groupWriteIndex, 'findings must land before the group that names them')

  const group = harness.groupsStore.find(item => item.id === 'g-1')
  assert.deepEqual(group.items.map(item => item.findingId), ['f-pool'], 'the group names the persisted finding')
  const stored = harness.entriesStore.find(item => item.id === 'f-pool')
  assert.equal(stored.assignedGroupId, 'g-1', 'the assignment points at a group that names it')
  assert.equal(stored.submissionStatus, 'submitted')
  assert.equal(prompts.length, 1, 'the prompt is still sent once the writes succeeded')
})

test('a rejected group write during submission rolls the queued findings back', async () => {
  const poolFinding = createFindingRecord({
    id: 'f-pool', sessionId: 's-1', text: 'Needs submission', submissionStatus: 'unsubmitted',
  })
  const prompts = []
  const harness = makePaneHarness({
    groups: [emptyGroup()],
    entries: [poolFinding],
    promptLogs: [],
    submit: dragSubmitStub(prompts),
  })
  const tree = await harness.renderPane()
  // Simulate the store refusing the relationship (e.g. a concurrently deleted
  // finding): the pane must undo the queued rows and never send the prompt.
  harness.services.store.putGroup = async () => {
    throw new Error('Invalid GroupRecord: item[0] finding not found: f-pool')
  }
  const after = await submitCombinedViaDock(harness, tree)

  const stored = harness.entriesStore.find(item => item.id === 'f-pool')
  assert.equal(stored.submissionStatus, 'unsubmitted', 'the rollback restores the unsubmitted fact')
  assert.equal(stored.assignedGroupId, undefined, 'no orphan assignment may survive the rejected group write')
  assert.equal(stored.batchId, undefined, 'the failed batch id is rolled back too')
  assert.equal(harness.groupsStore.find(item => item.id === 'g-1').items.length, 0, 'the group was never mutated')
  assert.equal(prompts.length, 0, 'nothing may be sent to Harness after a rejected group write')
  assert.ok(textOfNode(after).includes(t('store.error')), 'the failure is surfaced, not swallowed')
})

test('drag assigns the finding first, then the group, and reaches a valid relationship', async () => {
  const poolFinding = createFindingRecord({
    id: 'f-pool', sessionId: 's-1', text: 'Drag me', submissionStatus: 'unsubmitted',
  })
  const prompts = []
  const harness = makePaneHarness({
    groups: [emptyGroup()],
    entries: [poolFinding],
    promptLogs: [],
    submit: dragSubmitStub(prompts),
  })
  const tree = await harness.renderPane()
  const dropNode = findGroupDropNode(tree, t('group.title').replace('{number}', '1'))
  assert.ok(dropNode, 'the group card must be a drop target')
  await dropNode.props.onDrop({
    preventDefault: () => {},
    dataTransfer: { getData: () => 'f-pool', setData: () => {}, dropEffect: 'move' },
  })
  await harness.flushEffects()

  const entryWriteIndex = harness.writeOrder.indexOf('putEntry:f-pool')
  const groupWriteIndex = harness.writeOrder.indexOf('putGroup:g-1')
  assert.ok(entryWriteIndex !== -1 && groupWriteIndex !== -1, 'both writes must happen')
  assert.ok(entryWriteIndex < groupWriteIndex, 'the finding must be persisted before the group')

  const group = harness.groupsStore.find(item => item.id === 'g-1')
  assert.deepEqual(group.items.map(item => item.findingId), ['f-pool'])
  const stored = harness.entriesStore.find(item => item.id === 'f-pool')
  assert.equal(stored.assignedGroupId, 'g-1')
  assert.equal(stored.submissionStatus, 'submitted')
  assert.equal(prompts.length, 1)
})

test('a rejected group write during drag restores the unassigned finding', async () => {
  const poolFinding = createFindingRecord({
    id: 'f-pool', sessionId: 's-1', text: 'Drag me', submissionStatus: 'unsubmitted',
  })
  const prompts = []
  const harness = makePaneHarness({
    groups: [emptyGroup()],
    entries: [poolFinding],
    promptLogs: [],
    submit: dragSubmitStub(prompts),
  })
  const tree = await harness.renderPane()
  const dropNode = findGroupDropNode(tree, t('group.title').replace('{number}', '1'))
  assert.ok(dropNode, 'the group card must be a drop target')
  harness.services.store.putGroup = async () => {
    throw new Error('Invalid GroupRecord: item[0] finding not found: f-pool')
  }
  await dropNode.props.onDrop({
    preventDefault: () => {},
    dataTransfer: { getData: () => 'f-pool', setData: () => {}, dropEffect: 'move' },
  })
  await harness.flushEffects()

  const stored = harness.entriesStore.find(item => item.id === 'f-pool')
  assert.equal(stored.submissionStatus, 'unsubmitted')
  assert.equal(stored.assignedGroupId, undefined)
  assert.equal(harness.groupsStore.find(item => item.id === 'g-1').items.length, 0)
  assert.equal(prompts.length, 0, 'the drag submission never reaches Harness after a rejected group write')
})

test('header status categories separate submitted, awaiting wrap-up and completed findings', () => {
  const entries = [
    { id: 'f-1', sessionId: 's-1', assignedGroupId: 'g-1', reviewStatus: 'pending', submissionStatus: 'submitted' },
    { id: 'f-2', sessionId: 's-1', assignedGroupId: 'g-1', reviewStatus: 'pending', submissionStatus: 'submitted' },
    { id: 'f-3', sessionId: 's-1', assignedGroupId: 'g-1', reviewStatus: 'resolved', submissionStatus: 'submitted' },
  ]
  const groups = [{ id: 'g-1', groupNumber: 1, sessionId: 's-1', status: 'active', items: entries.map((entry, index) => ({ findingId: entry.id, order: index })) }]
  const summary = summarizeOpenWork({
    entries,
    groups,
    poolCount: 0,
    findingsMap: new Map(entries.map(entry => [entry.id, entry])),
    harnessProjectionsMap: { 'f-1': 'queued', 'f-2': 'executed', 'f-3': 'executed' },
  })
  assert.deepEqual(summary.statusCounts, { submitted: 1, awaitingReview: 1, completed: 1 })
})


test('group count badge: total 13 expands to completed 2 + awaiting wrap-up 11', () => {
  const findings = []
  for (let i = 0; i < 13; i += 1) {
    findings.push({ id: `f-${i}`, reviewStatus: i < 2 ? 'resolved' : 'pending' })
  }
  const counts = summarizeGroupStatusCounts(findings, () => 'executed')
  assert.deepEqual(counts, { completed: 2, awaitingWrapUp: 11, submitted: 0, ignored: 0, total: 13 })
  assert.equal(formatGroupCountBadge(counts), '11/13', 'total badge reads awaiting/total')
})
