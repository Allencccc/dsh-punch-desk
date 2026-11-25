import test from 'node:test'
import assert from 'node:assert/strict'
import {
  readAcceptedEvidence,
  deriveLatestGroupId,
  latestGroupAt,
  countChargedTurns,
  countAttributedTurns,
  deriveGroupTurnStats,
  freezeGroupTurnStats,
} from '../src/domain/group-turns.js'

const T = Date.UTC(2026, 10, 12, 8, 0, 0)
const at = seconds => T + seconds * 1000

/**
 * @param {string} id
 * @param {number} groupNumber
 * @param {object} [over]
 */
function makeGroup(id, groupNumber, over = {}) {
  return {
    id,
    groupNumber,
    sessionId: 's1',
    workspaceId: 'w1',
    startTurn: 0,
    items: [],
    createdAt: T,
    status: 'active',
    ...over,
  }
}

/**
 * @param {string} id
 * @param {object} [over]
 */
function makeFinding(id, over = {}) {
  return {
    id,
    sessionId: 's1',
    workspaceId: 'w1',
    submissionStatus: 'unsubmitted',
    reviewStatus: 'pending',
    status: 'open',
    createdAt: T,
    updatedAt: T,
    ...over,
  }
}

function acceptedFinding(id, groupId, requestId, { acceptedAt, submissionSeq, ...rest } = {}) {
  return makeFinding(id, {
    submissionStatus: 'submitted',
    status: 'submitted',
    assignedGroupId: groupId,
    requestId,
    acceptedAt,
    submissionSeq,
    ...rest,
  })
}

function promptRow(source, { messageId, requestId, batchId, groupId, time, turn, ...rest }) {
  const row = {
    messageId: messageId ?? `m-${requestId ?? groupId ?? source}-${turn ?? time}`,
    source,
    status: 'sent',
    ...rest,
  }
  if (requestId !== undefined) row.requestId = requestId
  if (batchId !== undefined) row.batchId = batchId
  if (groupId !== undefined) row.groupId = groupId
  if (time !== undefined) row.time = time
  if (turn !== undefined) row.turn = turn
  return row
}

const deskBatchRow = over => promptRow('desk-batch', over)
const composerRow = over => promptRow('composer', over)
const historyRow = over => promptRow('history', over)

function traceRow({ requestId, groupId, findingIds, turn, status = 'complete' }) {
  return {
    id: `${requestId}#${turn}`,
    requestId,
    sessionId: 's1',
    workspaceId: 'w1',
    turn,
    groupIds: groupId ? [groupId] : [],
    findingIds: findingIds ?? [],
    commits: [],
    status,
  }
}

// ---------------------------------------------------------------------------
// T-GTA-01 / T-GTA-02: header metrics move only for the owning group
// ---------------------------------------------------------------------------

test('T-GTA-01 three active groups: a direct turn increments only the latest group', () => {
  const groups = [
    makeGroup('g-1', 1, { startTurn: 0 }),
    makeGroup('g-2', 2, { startTurn: 5 }),
    makeGroup('g-3', 3, { startTurn: 6 }),
  ]
  const findings = []
  const logs = []
  for (let index = 1; index <= 6; index += 1) {
    findings.push(acceptedFinding(`f1-${index}`, 'g-1', `r1-${index}`, { acceptedAt: at(index), submissionSeq: index }))
    logs.push(deskBatchRow({ requestId: `r1-${index}`, batchId: 'g-1', time: at(index), turn: index }))
  }
  findings.push(acceptedFinding('f2-1', 'g-2', 'r2-1', { acceptedAt: at(7), submissionSeq: 7 }))
  findings.push(acceptedFinding('f2-2', 'g-2', 'r2-2', { acceptedAt: at(8), submissionSeq: 8 }))
  logs.push(deskBatchRow({ requestId: 'r2-1', batchId: 'g-2', time: at(7), turn: 7 }))
  logs.push(deskBatchRow({ requestId: 'r2-2', batchId: 'g-2', time: at(8), turn: 8 }))
  findings.push(acceptedFinding('f3-1', 'g-3', 'r3-1', { acceptedAt: at(9), submissionSeq: 9 }))
  logs.push(deskBatchRow({ requestId: 'r3-1', batchId: 'g-3', time: at(9), turn: 9 }))

  const before = groups.map(group => deriveGroupTurnStats(group, { groups, findings, promptLogs: logs, currentTurn: 9 }))
  assert.deepEqual(before.map(stats => stats.groupTurns), [6, 2, 1])

  const withDirect = [...logs, composerRow({ messageId: 'm-direct', time: at(10), turn: 10 })]
  const after = groups.map(group => deriveGroupTurnStats(group, { groups, findings, promptLogs: withDirect, currentTurn: 10 }))
  assert.deepEqual(after.map(stats => stats.charged), [6, 2, 1])
  assert.deepEqual(after.map(stats => stats.attributed), [0, 0, 1])
  assert.deepEqual(after.map(stats => stats.groupTurns), [6, 2, 2])
  // The buggy elapsed view would read 8/3/2: every active group +1. Not here.
  assert.notDeepEqual(after.map(stats => stats.groupTurns), [7, 3, 2])
  assert.equal(after.reduce((sum, stats) => sum + stats.groupTurns, 0), 10)
})

test('T-GTA-02 combined submission charges one turn for the target group only', () => {
  const groups = [makeGroup('g-1', 1), makeGroup('g-2', 2), makeGroup('g-3', 3)]
  const findings = [
    acceptedFinding('f-1', 'g-1', 'r-combined', { acceptedAt: at(10), submissionSeq: 1 }),
    acceptedFinding('f-2', 'g-1', 'r-combined', { acceptedAt: at(10), submissionSeq: 1 }),
  ]
  const logs = [
    deskBatchRow({ requestId: 'r-combined', batchId: 'g-1', time: at(20), turn: 7 }),
    composerRow({ messageId: 'm-direct', time: at(30), turn: 8 }),
  ]
  assert.equal(deriveLatestGroupId({ groups, findings, promptLogs: logs }), 'g-1')
  assert.equal(countChargedTurns(groups[0], { findings, promptLogs: logs }), 1)
  assert.equal(countChargedTurns(groups[1], { findings, promptLogs: logs }), 0)
  assert.equal(countChargedTurns(groups[2], { findings, promptLogs: logs }), 0)
  assert.equal(countAttributedTurns(groups[0], { groups, findings, promptLogs: logs }), 1)
  assert.equal(countAttributedTurns(groups[1], { groups, findings, promptLogs: logs }), 0)
  assert.equal(latestGroupAt(8, { groups, findings, promptLogs: logs }), 'g-1')
})

test('T-GTA-03 sequential submissions charge per distinct requestId, retries dedupe by turn', () => {
  const group = makeGroup('g-1', 1)
  const groups = [group]
  const findings = [
    acceptedFinding('f-1', 'g-1', 'r-1', { acceptedAt: at(1), submissionSeq: 1 }),
    acceptedFinding('f-2', 'g-1', 'r-2', { acceptedAt: at(2), submissionSeq: 2 }),
  ]
  const logs = [
    deskBatchRow({ requestId: 'r-1', batchId: 'g-1', time: at(3), turn: 3 }),
    deskBatchRow({ requestId: 'r-2', batchId: 'g-1', time: at(4), turn: 4 }),
    // A retried submission reuses the requestId; it must not become a second turn.
    deskBatchRow({ requestId: 'r-1', batchId: 'g-1', time: at(5), turn: 5 }),
    composerRow({ messageId: 'm-direct', time: at(6), turn: 6 }),
  ]
  assert.equal(countChargedTurns(group, { findings, promptLogs: logs }), 2)
  assert.equal(countAttributedTurns(group, { groups, findings, promptLogs: logs }), 1)
  assert.equal(deriveLatestGroupId({ groups, findings, promptLogs: logs }), 'g-1')
})

// ---------------------------------------------------------------------------
// T-GTA-04 / T-GTA-05 / T-GTA-06: archive freeze, fallback, stickiness
// ---------------------------------------------------------------------------

test('T-GTA-04 archived group keeps its frozen snapshot while the session moves on', () => {
  const archived = makeGroup('g-3', 3, {
    startTurn: 5,
    status: 'archived',
    archivedAt: at(40),
    archivedTurn: 9,
    archivedElapsed: 4,
    archivedCharged: 1,
    archivedAttributed: 1,
  })
  const groups = [makeGroup('g-1', 1), makeGroup('g-2', 2, { startTurn: 2 }), archived]
  const findings = [
    acceptedFinding('f-2', 'g-2', 'r-2', { acceptedAt: at(10), submissionSeq: 1 }),
    acceptedFinding('f-3', 'g-3', 'r-3', { acceptedAt: at(20), submissionSeq: 2 }),
  ]
  const logs = [
    deskBatchRow({ requestId: 'r-3', batchId: 'g-3', time: at(21), turn: 7 }),
    composerRow({ messageId: 'm-before-archive', time: at(30), turn: 8 }),
    composerRow({ messageId: 'm-after-archive', time: at(50), turn: 10 }),
  ]

  const archivedStats = deriveGroupTurnStats(archived, { groups, findings, promptLogs: logs, currentTurn: 12 })
  assert.equal(archivedStats.source, 'archived')
  assert.equal(archivedStats.frozen, true)
  assert.equal(archivedStats.elapsed, 4)
  assert.equal(archivedStats.charged, 1)
  assert.equal(archivedStats.attributed, 1)
  assert.equal(archivedStats.groupTurns, 2)
  // The session advanced to turn 12 but the archived numbers did not move.
  const later = deriveGroupTurnStats(archived, { groups, findings, promptLogs: logs, currentTurn: 30 })
  assert.equal(later.groupTurns, 2)

  const fallbackStats = deriveGroupTurnStats(groups[1], { groups, findings, promptLogs: logs, currentTurn: 12 })
  assert.equal(fallbackStats.attributed, 1)
  assert.equal(latestGroupAt(8, { groups, findings, promptLogs: logs }), 'g-3')
  assert.equal(latestGroupAt(10, { groups, findings, promptLogs: logs }), 'g-2')
  assert.equal(deriveLatestGroupId({ groups, findings, promptLogs: logs }), 'g-2')
})

test('T-GTA-05 no active accepted group: direct turns stay unattributed', () => {
  const archived = makeGroup('g-1', 1, {
    status: 'archived',
    archivedAt: at(20),
    archivedTurn: 2,
    archivedElapsed: 2,
    archivedCharged: 1,
    archivedAttributed: 0,
  })
  const groups = [archived]
  const findings = [acceptedFinding('f-1', 'g-1', 'r-1', { acceptedAt: at(1), submissionSeq: 1 })]
  const logs = [
    deskBatchRow({ requestId: 'r-1', batchId: 'g-1', time: at(2), turn: 2 }),
    composerRow({ messageId: 'm-direct', time: at(30), turn: 3 }),
  ]
  assert.equal(deriveLatestGroupId({ groups, findings, promptLogs: logs }), null)
  assert.equal(latestGroupAt(3, { groups, findings, promptLogs: logs }), null)
  assert.equal(countAttributedTurns(archived, { groups, findings, promptLogs: logs }), 0)
  const stats = deriveGroupTurnStats(archived, { groups, findings, promptLogs: logs, currentTurn: 30 })
  assert.equal(stats.latestGroupId, null)
  assert.equal(stats.attributed, 0)
  assert.ok(stats.coverage.unattributed >= 1)
  assert.ok(stats.groupTurns < 30)
})

test('T-GTA-06 consecutive direct turns are sticky to one latest group', () => {
  const group = makeGroup('g-1', 1)
  const groups = [group]
  const findings = [acceptedFinding('f-1', 'g-1', 'r-1', { acceptedAt: at(1), submissionSeq: 1 })]
  const logs = [
    deskBatchRow({ requestId: 'r-1', batchId: 'g-1', time: at(1), turn: 1 }),
    composerRow({ messageId: 'm-2', time: at(2), turn: 2 }),
    composerRow({ messageId: 'm-3', time: at(3), turn: 3 }),
    composerRow({ messageId: 'm-4', time: at(4), turn: 4 }),
  ]
  assert.equal(countAttributedTurns(group, { groups, findings, promptLogs: logs }), 3)
  for (const turn of [2, 3, 4]) {
    assert.equal(latestGroupAt(turn, { groups, findings, promptLogs: logs }), 'g-1')
  }
  assert.equal(countAttributedTurns(group, { groups, findings, promptLogs: [logs[0]] }), 0)
})

// ---------------------------------------------------------------------------
// T-GTA-07 / T-GTA-09 / T-GTA-19: PromptLog primary, Trace supplementary
// ---------------------------------------------------------------------------

test('T-GTA-07 trimmed Trace: charged falls back to PromptLog and snapshots only the window', () => {
  const group = makeGroup('g-1', 1)
  const groups = [group]
  const findings = [acceptedFinding('f-1', 'g-1', 'r-1', { acceptedAt: at(1), submissionSeq: 1 })]
  const logs = [deskBatchRow({ requestId: 'r-1', batchId: 'g-1', time: at(4), turn: 4 })]
  assert.equal(countChargedTurns(group, { findings, promptLogs: logs, traces: [] }), 1)

  const stats = deriveGroupTurnStats(group, { groups, findings, promptLogs: logs, traces: [], currentTurn: 4 })
  const frozen = freezeGroupTurnStats(group, stats, 4)
  // Retention drops the row afterwards: the frozen window snapshot survives.
  const afterTrim = deriveGroupTurnStats(frozen, { groups: [frozen], findings: [], promptLogs: [], traces: [], currentTurn: 40 })
  assert.equal(afterTrim.charged, 1)
  assert.equal(afterTrim.elapsed, 4)
  assert.equal(afterTrim.frozen, true)
  // Without a snapshot the same trimmed window yields nothing: history is not rebuilt.
  assert.equal(countChargedTurns(group, { findings: [], promptLogs: [], traces: [] }), 0)
})

test('T-GTA-09 PromptLog evidence without any Trace still charges the turn', () => {
  const groups = [makeGroup('g-1', 1), makeGroup('g-2', 2), makeGroup('g-3', 3)]
  const findings = [
    acceptedFinding('f-1', 'g-1', 'r-1', { acceptedAt: at(1), submissionSeq: 1 }),
    acceptedFinding('f-2', 'g-2', 'r-2', { acceptedAt: at(2), submissionSeq: 2 }),
    acceptedFinding('f-3', 'g-3', 'r-3', { acceptedAt: at(3), submissionSeq: 3 }),
  ]
  const logs = [
    deskBatchRow({ requestId: 'r-1', batchId: 'g-1', time: at(1), turn: 1 }),
    deskBatchRow({ requestId: 'r-2', batchId: 'g-2', time: at(2), turn: 2 }),
    deskBatchRow({ requestId: 'r-3', batchId: 'g-3', time: at(3), turn: 7 }),
  ]
  // Only turn 2 got a trace; turn 7 (G3) is the real-world missing-trace case.
  const traces = [traceRow({ requestId: 'r-2', groupId: 'g-2', turn: 2 })]
  assert.equal(countChargedTurns(groups[2], { findings, promptLogs: logs, traces }), 1)
  assert.equal(deriveGroupTurnStats(groups[2], { findings, promptLogs: logs, traces }).charged, 1)
})

test('T-GTA-19 PromptLog trimmed but Trace kept: charged survives, attributed is lost per bucket', () => {
  const group = makeGroup('g-1', 1)
  const findings = [
    makeFinding('f-1', {
      submissionStatus: 'submitted',
      status: 'submitted',
      assignedGroupId: 'g-1',
      requestId: 'r-1',
    }),
  ]
  const traces = [traceRow({ requestId: 'r-1', groupId: 'g-1', findingIds: ['f-1'], turn: 4 })]
  // PromptLog bucket for this session was trimmed: no rows at all.
  assert.equal(countChargedTurns(group, { findings, promptLogs: [], traces }), 1)
  // Other sessions keep their own buckets: their rows neither add nor remove turns here.
  const otherSessionLogs = [
    deskBatchRow({ requestId: 'r-other', batchId: 'g-other', time: at(9), turn: 9 }),
    deskBatchRow({ requestId: 'r-1', batchId: 'g-1', time: at(1), turn: 4 }),
  ]
  assert.equal(countChargedTurns(group, { findings, promptLogs: otherSessionLogs, traces }), 1)
  const stats = deriveGroupTurnStats(group, {
    groups: [group],
    findings,
    promptLogs: otherSessionLogs,
    traces,
    currentTurn: 9,
  })
  assert.equal(stats.charged, 1)
  assert.equal(stats.attributed, 0)
})

// ---------------------------------------------------------------------------
// T-GTA-08 / T-GTA-12 / T-GTA-13: requestId traps, legacy fields, failures
// ---------------------------------------------------------------------------

test('T-GTA-08 composer message with a host requestId is not a submission and not charged', () => {
  const groups = [makeGroup('g-1', 1), makeGroup('g-2', 2)]
  const findings = [
    acceptedFinding('f-1', 'g-1', 'r-1', { acceptedAt: at(1), submissionSeq: 1 }),
    makeFinding('f-2', {
      submissionStatus: 'submitted',
      status: 'submitted',
      assignedGroupId: 'g-2',
      requestId: 'r-host',
    }),
  ]
  const logs = [
    deskBatchRow({ requestId: 'r-1', batchId: 'g-1', time: at(2), turn: 2 }),
    composerRow({ messageId: 'm-host', requestId: 'r-host', time: at(10), turn: 9 }),
  ]
  assert.equal(countChargedTurns(groups[1], { findings, promptLogs: logs }), 0)
  assert.equal(deriveLatestGroupId({ groups, findings, promptLogs: logs }), 'g-1')
  // It is still a direct turn, so it is attributed (not charged).
  assert.equal(countAttributedTurns(groups[0], { groups, findings, promptLogs: logs }), 1)
  assert.equal(latestGroupAt(9, { groups, findings, promptLogs: logs }), 'g-1')
})

test('T-GTA-12 legacy group.turns is ignored and missing inputs are tolerated', () => {
  const legacy = makeGroup('g-legacy', 1, { startTurn: 2, turns: 99 })
  const stats = deriveGroupTurnStats(legacy, { currentTurn: 7 })
  assert.equal(stats.charged, 0)
  assert.equal(stats.attributed, 0)
  assert.equal(stats.groupTurns, 0)
  assert.equal(stats.elapsed, 5)
  assert.equal('turns' in stats, false)
  assert.equal(deriveGroupTurnStats(null).groupTurns, 0)
  assert.equal(deriveGroupTurnStats(undefined).charged, 0)
  assert.equal(countChargedTurns(null), 0)
  assert.equal(countAttributedTurns(undefined), 0)
  assert.equal(freezeGroupTurnStats(null, { charged: 1, attributed: 1 }, 3), null)
})

test('T-GTA-13 failed / retryPending / half-present evidence never moves latest', () => {
  const groups = [makeGroup('g-1', 1), makeGroup('g-2', 2)]
  const findings = [
    acceptedFinding('f-1', 'g-1', 'r-1', { acceptedAt: at(1), submissionSeq: 1 }),
    makeFinding('f-2', {
      submissionStatus: 'submitted',
      status: 'submitted',
      assignedGroupId: 'g-2',
      requestId: 'r-2',
      submittedAt: at(50),
      retryPending: true,
      lastSubmitError: 'rpc failed',
    }),
    // Half of the accepted pair only: discarded as legacy / no evidence.
    makeFinding('f-3', {
      submissionStatus: 'submitted',
      status: 'submitted',
      assignedGroupId: 'g-2',
      requestId: 'r-3',
      acceptedAt: at(60),
    }),
    makeFinding('f-4', {
      submissionStatus: 'submitted',
      status: 'submitted',
      assignedGroupId: 'g-2',
      requestId: 'r-4',
      submissionSeq: 4,
    }),
  ]
  const logs = [
    deskBatchRow({ requestId: 'r-1', batchId: 'g-1', time: at(2), turn: 2 }),
    composerRow({ messageId: 'm-direct', time: at(70), turn: 5 }),
  ]
  assert.equal(deriveLatestGroupId({ groups, findings, promptLogs: logs }), 'g-1')
  assert.equal(latestGroupAt(5, { groups, findings, promptLogs: logs }), 'g-1')
  assert.equal(countChargedTurns(groups[1], { findings, promptLogs: logs }), 0)
  assert.equal(countAttributedTurns(groups[0], { groups, findings, promptLogs: logs }), 1)
})

// ---------------------------------------------------------------------------
// T-GTA-14 / T-GTA-17 / T-GTA-18 / T-GTA-20: ordering and dedupe
// ---------------------------------------------------------------------------

test('T-GTA-14 same-millisecond acceptances order by submissionSeq, not groupNumber', () => {
  const groups = [makeGroup('g-1', 1), makeGroup('g-2', 2)]
  const findings = [
    acceptedFinding('f-2', 'g-2', 'r-2', { acceptedAt: at(10), submissionSeq: 1 }),
    acceptedFinding('f-1', 'g-1', 'r-1', { acceptedAt: at(10), submissionSeq: 2 }),
  ]
  const logs = [composerRow({ messageId: 'm-direct', time: at(11), turn: 5 })]
  assert.equal(deriveLatestGroupId({ groups, findings, promptLogs: logs }), 'g-1')
  assert.equal(latestGroupAt(5, { groups, findings, promptLogs: logs }), 'g-1')
  assert.equal(countAttributedTurns(groups[0], { groups, findings, promptLogs: logs }), 1)
  assert.equal(countAttributedTurns(groups[1], { groups, findings, promptLogs: logs }), 0)
})

test('T-GTA-17 direct turns replay per turn: G1 then G2, never both to the final latest', () => {
  const groups = [makeGroup('g-1', 1), makeGroup('g-2', 2)]
  const findings = [
    acceptedFinding('f-1', 'g-1', 'r-1', { acceptedAt: at(1), submissionSeq: 1 }),
    acceptedFinding('f-2', 'g-2', 'r-2', { acceptedAt: at(3), submissionSeq: 2 }),
  ]
  const logs = [
    deskBatchRow({ requestId: 'r-1', batchId: 'g-1', time: at(1), turn: 1 }),
    composerRow({ messageId: 'm-direct-1', time: at(2), turn: 2 }),
    deskBatchRow({ requestId: 'r-2', batchId: 'g-2', time: at(3), turn: 3 }),
    composerRow({ messageId: 'm-direct-2', time: at(4), turn: 4 }),
  ]
  assert.equal(latestGroupAt(2, { groups, findings, promptLogs: logs }), 'g-1')
  assert.equal(latestGroupAt(4, { groups, findings, promptLogs: logs }), 'g-2')
  assert.equal(countAttributedTurns(groups[0], { groups, findings, promptLogs: logs }), 1)
  assert.equal(countAttributedTurns(groups[1], { groups, findings, promptLogs: logs }), 1)
})

test('T-GTA-18 same-millisecond submission and direct: submission wins deterministically', () => {
  const groups = [makeGroup('g-1', 1)]
  const findings = [acceptedFinding('f-1', 'g-1', 'r-1', { acceptedAt: at(10), submissionSeq: 1 })]
  // The direct row is listed first on purpose: ordering must come from times + the tie-break.
  const logs = [composerRow({ messageId: 'm-same-ms', time: at(10), turn: 6 })]
  assert.equal(latestGroupAt(6, { groups, findings, promptLogs: logs }), 'g-1')
  assert.equal(countAttributedTurns(groups[0], { groups, findings, promptLogs: logs }), 1)
  // Stable across repeated calls.
  assert.equal(latestGroupAt(6, { groups, findings, promptLogs: logs }), 'g-1')
})

test('T-GTA-20 late desk-batch / history rows dedupe by requestId and cannot steal latest', () => {
  const groups = [makeGroup('g-1', 1), makeGroup('g-2', 2)]
  const findings = [
    acceptedFinding('f-1', 'g-1', 'r-1', { acceptedAt: at(10), submissionSeq: 1 }),
    acceptedFinding('f-2', 'g-2', 'r-2', { acceptedAt: at(20), submissionSeq: 2 }),
  ]
  const logs = [
    deskBatchRow({ requestId: 'r-1', batchId: 'g-1', time: at(30), turn: 1 }),
    historyRow({ requestId: 'r-1', time: at(40), turn: 1 }),
    composerRow({ messageId: 'm-direct', time: at(50), turn: 5 }),
  ]
  assert.equal(deriveLatestGroupId({ groups, findings, promptLogs: logs }), 'g-2')
  assert.equal(latestGroupAt(5, { groups, findings, promptLogs: logs }), 'g-2')
  // The deduped rows remain charged evidence for the accepted group, as one turn.
  assert.equal(countChargedTurns(groups[0], { findings, promptLogs: logs }), 1)
  assert.equal(countChargedTurns(groups[1], { findings, promptLogs: logs }), 0)
})

// ---------------------------------------------------------------------------
// T-GTA-21: archive keeps pre-wrap-up direct turns, falls back only afterwards
// ---------------------------------------------------------------------------

test('T-GTA-21 direct before wrap-up stays on the archived group, later directs fall back', () => {
  const archived = makeGroup('g-3', 3, {
    startTurn: 5,
    status: 'archived',
    archivedAt: at(40),
    archivedTurn: 9,
    archivedElapsed: 4,
    archivedCharged: 1,
    archivedAttributed: 1,
  })
  const groups = [makeGroup('g-2', 2, { startTurn: 2 }), archived, makeGroup('g-1', 1)]
  const findings = [
    acceptedFinding('f-2', 'g-2', 'r-2', { acceptedAt: at(10), submissionSeq: 1 }),
    acceptedFinding('f-3', 'g-3', 'r-3', { acceptedAt: at(20), submissionSeq: 2 }),
  ]
  const logs = [
    deskBatchRow({ requestId: 'r-3', batchId: 'g-3', time: at(21), turn: 7 }),
    composerRow({ messageId: 'm-old', time: at(30), turn: 8 }),
    composerRow({ messageId: 'm-new', time: at(50), turn: 10 }),
  ]
  assert.equal(latestGroupAt(8, { groups, findings, promptLogs: logs }), 'g-3')
  assert.equal(latestGroupAt(10, { groups, findings, promptLogs: logs }), 'g-2')
  assert.equal(countAttributedTurns(archived, { groups, findings, promptLogs: logs }), 1)
  assert.equal(countAttributedTurns(groups[0], { groups, findings, promptLogs: logs }), 1)
  // No duplicate attribution of the pre-wrap-up turn.
  assert.equal(
    countAttributedTurns(archived, { groups, findings, promptLogs: logs })
      + countAttributedTurns(groups[0], { groups, findings, promptLogs: logs }),
    2,
  )
  const stats = deriveGroupTurnStats(archived, { groups, findings, promptLogs: logs, currentTurn: 30 })
  assert.equal(stats.groupTurns, 2)
  assert.equal(stats.frozen, true)
})

// ---------------------------------------------------------------------------
// T-GTA-22 / T-GTA-23: history sources, missing turns
// ---------------------------------------------------------------------------

test('T-GTA-22 history rows classify as legacy submission / inferred direct / unknown', () => {
  const group = makeGroup('g-1', 1)
  const groups = [group]
  const findings = [
    makeFinding('f-1', {
      submissionStatus: 'submitted',
      status: 'submitted',
      assignedGroupId: 'g-1',
      requestId: 'r-sub',
    }),
  ]
  const logs = [
    // requestId hits a submitted finding -> legacy submission (charged, trace missing is fine).
    historyRow({ messageId: 'm-sub', requestId: 'r-sub', time: at(1), turn: 3 }),
    // requestId with no matching submitted finding -> inferred direct.
    historyRow({ messageId: 'm-inferred', requestId: 'r-unknown', time: at(2), turn: 5 }),
    // no requestId -> source unknown, never faked as direct or submission.
    historyRow({ messageId: 'm-unknown', time: at(3), turn: 6 }),
  ]
  assert.equal(countChargedTurns(group, { findings, promptLogs: logs, traces: [] }), 1)
  assert.equal(countAttributedTurns(group, { groups, findings, promptLogs: logs }), 1)
  assert.equal(latestGroupAt(5, { groups, findings, promptLogs: logs }), 'g-1')
  assert.equal(latestGroupAt(6, { groups, findings, promptLogs: logs }), null)
  const stats = deriveGroupTurnStats(group, { groups, findings, promptLogs: logs, currentTurn: 6 })
  assert.equal(stats.charged, 1)
  assert.equal(stats.attributed, 1)
  assert.equal(stats.coverage.inferred, 1)
  assert.ok(stats.coverage.unknown >= 1)
})

test('T-GTA-23 direct without a turn falls back by archivedAt but is never counted', () => {
  const archived = makeGroup('g-3', 3, {
    startTurn: 5,
    status: 'archived',
    archivedAt: at(40),
    archivedTurn: 9,
    archivedElapsed: 4,
    archivedCharged: 1,
    archivedAttributed: 0,
  })
  const groups = [makeGroup('g-2', 2, { startTurn: 2 }), archived]
  const findings = [
    acceptedFinding('f-2', 'g-2', 'r-2', { acceptedAt: at(10), submissionSeq: 1 }),
    acceptedFinding('f-3', 'g-3', 'r-3', { acceptedAt: at(20), submissionSeq: 2 }),
  ]
  const logs = [
    deskBatchRow({ requestId: 'r-3', batchId: 'g-3', time: at(21), turn: 7 }),
    // Turn is missing on both directs; the archive decision uses archivedAt/time.
    composerRow({ messageId: 'm-before', time: at(30) }),
    composerRow({ messageId: 'm-after', time: at(50) }),
    composerRow({ messageId: 'm-after', time: at(51) }),
  ]
  assert.equal(countAttributedTurns(archived, { groups, findings, promptLogs: logs }), 0)
  assert.equal(countAttributedTurns(groups[0], { groups, findings, promptLogs: logs }), 0)
  const stats = deriveGroupTurnStats(groups[0], { groups, findings, promptLogs: logs, currentTurn: 12 })
  assert.equal(stats.attributed, 0)
  assert.ok(stats.coverage.unknown >= 2)
})

test('T-GTA-23 charged needs a turn from PromptLog or Trace, otherwise it is unknown', () => {
  const group = makeGroup('g-2', 2, { startTurn: 2 })
  const groups = [group]
  const findings = [acceptedFinding('f-1', 'g-2', 'r-1', { acceptedAt: at(1), submissionSeq: 1 })]
  const logs = [deskBatchRow({ requestId: 'r-1', batchId: 'g-2', time: at(2) })]
  assert.equal(countChargedTurns(group, { findings, promptLogs: logs, traces: [] }), 0)
  const traces = [traceRow({ requestId: 'r-1', groupId: 'g-2', turn: 7 })]
  assert.equal(countChargedTurns(group, { findings, promptLogs: logs, traces }), 1)
  // Trace alone (PromptLog trimmed) still charges the turn.
  assert.equal(countChargedTurns(group, { findings, promptLogs: [], traces }), 1)
  assert.equal(deriveGroupTurnStats(group, { groups, findings, promptLogs: logs, traces, currentTurn: 7 }).charged, 1)
})

// ---------------------------------------------------------------------------
// T-GTA-15 / T-GTA-16: retention window and legacy replay
// ---------------------------------------------------------------------------

test('T-GTA-15 live metrics are a retention window; freezing only preserves that window', () => {
  const group = makeGroup('g-1', 1)
  const groups = [group]
  const findings = [
    acceptedFinding('f-1', 'g-1', 'r-1', { acceptedAt: at(1), submissionSeq: 1 }),
    acceptedFinding('f-2', 'g-1', 'r-2', { acceptedAt: at(2), submissionSeq: 2 }),
    acceptedFinding('f-3', 'g-1', 'r-3', { acceptedAt: at(3), submissionSeq: 3 }),
  ]
  // Turn 1 already fell out of the 30 day / 1000 row bucket.
  const retained = [
    deskBatchRow({ requestId: 'r-2', batchId: 'g-1', time: at(2), turn: 2 }),
    deskBatchRow({ requestId: 'r-3', batchId: 'g-1', time: at(3), turn: 3 }),
  ]
  const stats = deriveGroupTurnStats(group, { groups, findings, promptLogs: retained, currentTurn: 3 })
  assert.equal(stats.charged, 2)
  const frozen = freezeGroupTurnStats(group, stats, 3)
  const afterTrim = deriveGroupTurnStats(frozen, { groups: [frozen], findings: [], promptLogs: [], currentTurn: 40 })
  assert.equal(afterTrim.charged, 2)
  assert.equal(afterTrim.attributed, 0)
  assert.equal(afterTrim.source, 'archived')
})

test('T-GTA-16 legacy rows replay without accepted evidence; failures and trims are excluded', () => {
  const groups = [makeGroup('g-1', 1), makeGroup('g-2', 2)]
  const findings = [
    makeFinding('f-1', {
      submissionStatus: 'submitted',
      status: 'submitted',
      assignedGroupId: 'g-1',
      requestId: 'r-1',
    }),
    makeFinding('f-2', {
      submissionStatus: 'submitted',
      status: 'submitted',
      assignedGroupId: 'g-2',
      requestId: 'r-2',
    }),
    // Failed submission with no accepted evidence and no PromptLog row: no event at all.
    makeFinding('f-3', {
      submissionStatus: 'submitted',
      status: 'submitted',
      assignedGroupId: 'g-1',
      requestId: 'r-3',
      retryPending: true,
      submittedAt: at(90),
    }),
  ]
  const logs = [
    deskBatchRow({ requestId: 'r-1', batchId: 'g-1', time: at(1), turn: 1 }),
    deskBatchRow({ requestId: 'r-2', batchId: 'g-2', time: at(2), turn: 2 }),
    composerRow({ messageId: 'm-direct', time: at(3), turn: 3 }),
  ]
  assert.equal(deriveLatestGroupId({ groups, findings, promptLogs: logs }), 'g-2')
  assert.equal(latestGroupAt(3, { groups, findings, promptLogs: logs }), 'g-2')
  assert.equal(countChargedTurns(groups[0], { findings, promptLogs: logs }), 1)
  assert.equal(countChargedTurns(groups[1], { findings, promptLogs: logs }), 1)
  assert.equal(countAttributedTurns(groups[1], { groups, findings, promptLogs: logs }), 1)
})

// ---------------------------------------------------------------------------
// T-GTA-24 (domain half): accepted evidence pairing survives a persistence round-trip
// ---------------------------------------------------------------------------

test('T-GTA-24 accepted evidence pairs survive cloning and reject half/invalid pairs', () => {
  const evidence = { acceptedAt: at(5), submissionSeq: 3 }
  const finding = { id: 'f-1', assignedGroupId: 'g-1', requestId: 'r-1', ...evidence }
  assert.deepEqual(readAcceptedEvidence(structuredClone(finding)), { acceptedAt: at(5), submissionSeq: 3 })
  assert.deepEqual(readAcceptedEvidence(JSON.parse(JSON.stringify(finding))), { acceptedAt: at(5), submissionSeq: 3 })
  assert.equal(readAcceptedEvidence({ acceptedAt: at(5) }), null)
  assert.equal(readAcceptedEvidence({ submissionSeq: 3 }), null)
  assert.equal(readAcceptedEvidence({ acceptedAt: at(5), submissionSeq: 0 }), null)
  assert.equal(readAcceptedEvidence({ acceptedAt: at(5), submissionSeq: 1.5 }), null)
  assert.equal(readAcceptedEvidence({ acceptedAt: Number.NaN, submissionSeq: 2 }), null)
  assert.equal(readAcceptedEvidence({ acceptedAt: -1, submissionSeq: 2 }), null)
  assert.equal(readAcceptedEvidence({ acceptedAt: at(5), submissionSeq: 3, retryPending: true }), null)
  assert.equal(readAcceptedEvidence({}), null)
  assert.equal(readAcceptedEvidence(null), null)

  // Replay still resolves latest from the round-tripped fields.
  const groups = [makeGroup('g-1', 1)]
  const logs = [composerRow({ messageId: 'm-direct', time: at(10), turn: 4 })]
  assert.equal(deriveLatestGroupId({ groups, findings: [structuredClone(finding)], promptLogs: logs }), 'g-1')
  assert.equal(latestGroupAt(4, { groups, findings: [structuredClone(finding)], promptLogs: logs }), 'g-1')
})

// ---------------------------------------------------------------------------
// T-GTA-25 (domain half): seq-ordered latest under overlapping acceptances
// ---------------------------------------------------------------------------

test('T-GTA-25 overlapping acceptances keep seq order and the larger seq wins latest', () => {
  const groups = [makeGroup('g-1', 1), makeGroup('g-2', 2)]
  const findings = [
    acceptedFinding('f-1', 'g-1', 'r-1', { acceptedAt: at(10), submissionSeq: 1 }),
    acceptedFinding('f-2', 'g-2', 'r-2', { acceptedAt: at(10), submissionSeq: 2 }),
  ]
  const logs = [composerRow({ messageId: 'm-direct', time: at(20), turn: 6 })]
  assert.equal(deriveLatestGroupId({ groups, findings, promptLogs: logs }), 'g-2')
  assert.equal(latestGroupAt(6, { groups, findings, promptLogs: logs }), 'g-2')
  // Same seq on two groups is still deterministic (groupId tie-break), never groupNumber.
  const sameSeq = [
    acceptedFinding('f-1', 'g-1', 'r-1', { acceptedAt: at(10), submissionSeq: 5 }),
    acceptedFinding('f-2', 'g-2', 'r-2', { acceptedAt: at(10), submissionSeq: 5 }),
  ]
  assert.equal(deriveLatestGroupId({ groups, findings: sameSeq, promptLogs: [] }), 'g-2')
})

// ---------------------------------------------------------------------------
// freezeGroupTurnStats contract
// ---------------------------------------------------------------------------

test('freezeGroupTurnStats is pure and write-once', () => {
  const group = makeGroup('g-1', 1, { startTurn: 3 })
  const snapshot = structuredClone(group)
  const frozen = freezeGroupTurnStats(group, { elapsed: 4, charged: 2, attributed: 1 }, 7)
  assert.deepEqual(group, snapshot)
  assert.notEqual(frozen, group)
  assert.equal(frozen.archivedTurn, 7)
  assert.equal(frozen.archivedElapsed, 4)
  assert.equal(frozen.archivedCharged, 2)
  assert.equal(frozen.archivedAttributed, 1)

  const again = freezeGroupTurnStats(frozen, { elapsed: 99, charged: 40, attributed: 30 }, 80)
  assert.notEqual(again, frozen)
  assert.equal(again.archivedTurn, 7)
  assert.equal(again.archivedElapsed, 4)
  assert.equal(again.archivedCharged, 2)
  assert.equal(again.archivedAttributed, 1)

  // Archived records are resolved from the snapshot, not recomputed.
  const stats = deriveGroupTurnStats(again, { currentTurn: 120 })
  assert.equal(stats.charged, 2)
  assert.equal(stats.attributed, 1)
  assert.equal(stats.groupTurns, 3)
  assert.equal(stats.elapsed, 4)
  assert.equal(stats.source, 'archived')
  assert.equal(stats.frozen, true)
})

test('archived group without a snapshot falls back to live derivation and is marked unfrozen', () => {
  const group = makeGroup('g-1', 1, { status: 'archived', archivedAt: at(20), archivedTurn: 4 })
  const findings = [acceptedFinding('f-1', 'g-1', 'r-1', { acceptedAt: at(1), submissionSeq: 1 })]
  const logs = [deskBatchRow({ requestId: 'r-1', batchId: 'g-1', time: at(2), turn: 2 })]
  const stats = deriveGroupTurnStats(group, { groups: [group], findings, promptLogs: logs, currentTurn: 9 })
  assert.equal(stats.frozen, false)
  assert.equal(stats.source, 'live-unfrozen')
  assert.equal(stats.charged, 1)
  assert.equal(stats.elapsed, 4)
})

test('deriveLatestGroupId falls back to the last submission when no group index is given', () => {
  const findings = [acceptedFinding('f-1', 'g-1', 'r-1', { acceptedAt: at(1), submissionSeq: 1 })]
  assert.equal(deriveLatestGroupId({ findings, promptLogs: [] }), 'g-1')
  assert.equal(deriveLatestGroupId({}), null)
  assert.equal(latestGroupAt(3, {}), null)
  assert.equal(latestGroupAt(undefined, { findings }), null)
})

test('duplicate direct rows dedupe by messageId and untimed rows stay unknown', () => {
  const group = makeGroup('g-1', 1)
  const groups = [group]
  const findings = [acceptedFinding('f-1', 'g-1', 'r-1', { acceptedAt: at(1), submissionSeq: 1 })]
  const logs = [
    deskBatchRow({ requestId: 'r-1', batchId: 'g-1', time: at(2), turn: 2 }),
    composerRow({ messageId: 'm-dup', time: at(3), turn: 3 }),
    composerRow({ messageId: 'm-dup', time: at(4), turn: 4 }),
    composerRow({ messageId: 'm-no-time', turn: 5 }),
    historyRow({ messageId: 'm-history-no-time', requestId: 'r-x', turn: 6 }),
  ]
  assert.equal(countAttributedTurns(group, { groups, findings, promptLogs: logs }), 1)
  assert.equal(latestGroupAt(3, { groups, findings, promptLogs: logs }), 'g-1')
  assert.equal(latestGroupAt(4, { groups, findings, promptLogs: logs }), null)
  const stats = deriveGroupTurnStats(group, { groups, findings, promptLogs: logs, currentTurn: 6 })
  assert.equal(stats.attributed, 1)
  assert.ok(stats.coverage.unknown >= 2)
})

test('latestGroupAt has no attribution for a submission turn', () => {
  const groups = [makeGroup('g-1', 1)]
  const findings = [acceptedFinding('f-1', 'g-1', 'r-1', { acceptedAt: at(1), submissionSeq: 1 })]
  const logs = [deskBatchRow({ requestId: 'r-1', batchId: 'g-1', time: at(2), turn: 2 })]
  assert.equal(latestGroupAt(2, { groups, findings, promptLogs: logs }), null)
})
