import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createWorkspaceRecord,
  validateWorkspaceRecord,
  updateWorkspaceRecord,
  WORKSPACE_STATUSES,
  SPEC_SYNC_STATUSES,
} from '../src/domain/workspace.js'
import {
  createGroupRecord,
  validateGroupRecord,
  deriveGroupExecutionStatus,
  sessionElapsedTurns,
  nextGroupNumber,
  addItemToGroup,
  removeItemFromGroup,
  canCreateGroup,
  countExecutingGroups,
  MAX_EXECUTING_GROUPS,
} from '../src/domain/active-group.js'
import {
  createFindingRecord,
  validateFindingRecord,
  migrateFinding,
  reopenFinding,
  forkFinding,
  filterInheritableFindings,
  findingStatus,
  FINDING_TAGS,
  SUBMISSION_STATUSES,
  REVIEW_STATUSES,
} from '../src/domain/entries.js'
import { createLocalDeskStore } from '../src/store/local.js'
import { PREFIX } from '../src/store/contract.js'

// --- WorkspaceRecord Domain Tests ---

test('WorkspaceRecord validation accepts valid record and rejects invalid properties', () => {
  const valid = {
    id: 'ws-1',
    name: 'Workspace 1',
    path: '/path/to/ws',
    gitBranch: 'main',
    status: 'active',
    specSyncStatus: 'synced',
    createdAt: 1000,
    updatedAt: 1000,
  }
  assert.equal(validateWorkspaceRecord(valid).ok, true)

  // Empty id
  assert.equal(validateWorkspaceRecord({ ...valid, id: '' }).ok, false)
  // Invalid status
  assert.equal(validateWorkspaceRecord({ ...valid, status: 'invalid' }).ok, false)
  // Invalid specSyncStatus
  assert.equal(validateWorkspaceRecord({ ...valid, specSyncStatus: 'unknown' }).ok, false)
  // Non-number timestamps
  assert.equal(validateWorkspaceRecord({ ...valid, createdAt: '1000' }).ok, false)
})

test('createWorkspaceRecord sets default fields and validates input', () => {
  const ws = createWorkspaceRecord({ id: 'ws-100' }, { now: () => 5000 })
  assert.equal(ws.id, 'ws-100')
  assert.equal(ws.name, 'ws-100')
  assert.equal(ws.path, '')
  assert.equal(ws.gitBranch, '')
  assert.equal(ws.status, 'active')
  assert.equal(ws.specSyncStatus, 'synced')
  assert.equal(ws.createdAt, 5000)
  assert.equal(ws.updatedAt, 5000)

  assert.throws(() => createWorkspaceRecord({ id: '' }), /id is required/)
})

test('updateWorkspaceRecord merges updates and refreshes updatedAt', () => {
  const ws = createWorkspaceRecord({ id: 'ws-1', status: 'init' }, { now: () => 1000 })
  const updated = updateWorkspaceRecord(ws, { status: 'active', gitBranch: 'feat/v2' }, { now: () => 2000 })
  assert.equal(updated.id, 'ws-1')
  assert.equal(updated.status, 'active')
  assert.equal(updated.gitBranch, 'feat/v2')
  assert.equal(updated.updatedAt, 2000)
  assert.equal(updated.createdAt, 1000)
})

// --- GroupRecord Domain Tests ---

test('GroupRecord validation and creation', () => {
  const group = createGroupRecord({
    sessionId: 's-1',
    workspaceId: 'ws-1',
    groupNumber: 1,
    startTurn: 2,
    items: [{ findingId: 'f-1', order: 1 }],
  }, { now: () => 3000 })

  assert.equal(group.id, 'g-1')
  assert.equal(group.groupNumber, 1)
  assert.equal(group.sessionId, 's-1')
  assert.equal(group.workspaceId, 'ws-1')
  assert.equal(group.startTurn, 2)
  assert.deepEqual(group.items, [{ findingId: 'f-1', order: 1 }])
  assert.equal(group.createdAt, 3000)

  assert.equal(validateGroupRecord(group).ok, true)
  assert.equal(validateGroupRecord({ ...group, groupNumber: 0 }).ok, false)
  assert.equal(validateGroupRecord({ ...group, items: 'not-array' }).ok, false)
})

test('nextGroupNumber generates monotonic 1..N numbers and never reuses numbers', () => {
  assert.equal(nextGroupNumber([]), 1)
  assert.equal(nextGroupNumber([{ groupNumber: 1 }, { groupNumber: 2 }]), 3)
  // Even if group 2 was deleted/skipped, next is max + 1
  assert.equal(nextGroupNumber([{ groupNumber: 1 }, { groupNumber: 4 }]), 5)
})

test('sessionElapsedTurns computes Math.max(0, currentTurn - startTurn) and ignores stale group.turns', () => {
  const group = { startTurn: 3 }
  assert.equal(sessionElapsedTurns(group, 7), 4)
  assert.equal(sessionElapsedTurns(group, 3), 0)
  assert.equal(sessionElapsedTurns(group, 1), 0)
  assert.equal(sessionElapsedTurns(group, null), 0)
  // A legacy persisted counter must never freeze the badge at a stale value.
  assert.equal(sessionElapsedTurns({ startTurn: 3, turns: 99 }, 7), 4)
})

test('deriveGroupExecutionStatus: empty group placeholder is executing', () => {
  const emptyGroup = { id: 'g-1', items: [] }
  assert.equal(deriveGroupExecutionStatus(emptyGroup, {}, {}), 'executing')
})

test('deriveGroupExecutionStatus: executing if any finding unsubmitted or not executed', () => {
  const group = {
    id: 'g-1',
    items: [
      { findingId: 'f-1', order: 1 },
      { findingId: 'f-2', order: 2 },
    ],
  }

  // Case A: f-1 submitted and executed, but f-2 unsubmitted
  const findingsMapA = {
    'f-1': { id: 'f-1', submissionStatus: 'submitted' },
    'f-2': { id: 'f-2', submissionStatus: 'unsubmitted' },
  }
  const projectionsA = { 'f-1': 'executed', 'f-2': 'unknown' }
  assert.equal(deriveGroupExecutionStatus(group, findingsMapA, projectionsA), 'executing')

  // Case B: both submitted, but f-2 is running in harness
  const findingsMapB = {
    'f-1': { id: 'f-1', submissionStatus: 'submitted' },
    'f-2': { id: 'f-2', submissionStatus: 'submitted' },
  }
  const projectionsB = { 'f-1': 'executed', 'f-2': 'running' }
  assert.equal(deriveGroupExecutionStatus(group, findingsMapB, projectionsB), 'executing')

  // Case C: both submitted, but f-2 is queued in harness
  const projectionsC = { 'f-1': 'executed', 'f-2': 'queued' }
  assert.equal(deriveGroupExecutionStatus(group, findingsMapB, projectionsC), 'executing')
})

test('deriveGroupExecutionStatus: completed only when all items are submitted AND executed', () => {
  const group = {
    id: 'g-1',
    items: [
      { findingId: 'f-1', order: 1 },
      { findingId: 'f-2', order: 2 },
    ],
  }
  const findingsMap = new Map([
    ['f-1', { id: 'f-1', submissionStatus: 'submitted' }],
    ['f-2', { id: 'f-2', submissionStatus: 'submitted' }],
  ])
  const projectionsMap = new Map([
    ['f-1', 'executed'],
    ['f-2', 'executed'],
  ])
  assert.equal(deriveGroupExecutionStatus(group, findingsMap, projectionsMap), 'completed')
  assert.equal(deriveGroupExecutionStatus({ ...group, status: 'archived' }, findingsMap, projectionsMap), 'archived')
})

test('3-group executing cap and completed group quota release', () => {
  assert.equal(MAX_EXECUTING_GROUPS, 3)

  const g1 = { id: 'g-1', items: [{ findingId: 'f-1', order: 1 }] }
  const g2 = { id: 'g-2', items: [{ findingId: 'f-2', order: 1 }] }
  const g3 = { id: 'g-3', items: [{ findingId: 'f-3', order: 1 }] }

  const findings = {
    'f-1': { id: 'f-1', submissionStatus: 'submitted' },
    'f-2': { id: 'f-2', submissionStatus: 'submitted' },
    'f-3': { id: 'f-3', submissionStatus: 'submitted' },
  }

  // All 3 executing
  const projections1 = { 'f-1': 'running', 'f-2': 'queued', 'f-3': 'running' }
  assert.equal(countExecutingGroups([g1, g2, g3], findings, projections1), 3)
  assert.equal(canCreateGroup([g1, g2, g3], findings, projections1), false)

  // g1 completes in harness -> releases quota, now only 2 executing
  const projections2 = { 'f-1': 'executed', 'f-2': 'queued', 'f-3': 'running' }
  assert.equal(countExecutingGroups([g1, g2, g3], findings, projections2), 2)
  assert.equal(canCreateGroup([g1, g2, g3], findings, projections2), true)
})

test('addItemToGroup and removeItemFromGroup operations', () => {
  const group = { id: 'g-1', items: [{ findingId: 'f-1', order: 1 }] }
  const withF2 = addItemToGroup(group, 'f-2', { batchId: 'b-1' })
  assert.equal(withF2.items.length, 2)
  assert.equal(withF2.items[1].findingId, 'f-2')
  assert.equal(withF2.items[1].batchId, 'b-1')

  // Adding duplicate is no-op
  const dup = addItemToGroup(withF2, 'f-2')
  assert.equal(dup.items.length, 2)

  // Remove f-1
  const removed = removeItemFromGroup(withF2, 'f-1')
  assert.equal(removed.items.length, 1)
  assert.equal(removed.items[0].findingId, 'f-2')
})

// --- FindingRecord Domain Tests ---

test('FindingRecord binary submissionStatus and independent reviewStatus', () => {
  const finding = createFindingRecord({
    sessionId: 's-1',
    workspaceId: 'ws-1',
    text: 'Optimize query performance',
    tag: 'optimize',
    severity: 'major',
  }, { now: () => 1000 })

  assert.equal(finding.submissionStatus, 'unsubmitted')
  assert.equal(finding.reviewStatus, 'pending')
  assert.equal(finding.status, 'open')

  // Set submitted
  finding.submissionStatus = 'submitted'
  assert.equal(finding.status, 'submitted')

  // Review resolved
  finding.reviewStatus = 'resolved'
  assert.equal(finding.status, 'resolved')

  // Review dismissed
  finding.reviewStatus = 'dismissed'
  assert.equal(finding.status, 'dismissed')
})

test('reopenFinding starts new submission cycle and clears cycle artifacts', () => {
  const finding = createFindingRecord({
    sessionId: 's-1',
    workspaceId: 'ws-1',
    text: 'Bug in auth',
    tag: 'blocker',
    severity: 'blocker',
    submissionStatus: 'submitted',
    reviewStatus: 'resolved',
    batchId: 'batch-1',
    requestId: 'req-1',
    assignedGroupId: 'g-1',
    resolvedAt: 2000,
  }, { now: () => 1000 })

  assert.equal(finding.status, 'resolved')

  const reopened = reopenFinding(finding, { now: () => 3000 })
  assert.equal(reopened.submissionStatus, 'unsubmitted')
  assert.equal(reopened.reviewStatus, 'pending')
  assert.equal(reopened.status, 'open')
  assert.equal(reopened.assignedGroupId, undefined)
  assert.equal(reopened.batchId, undefined)
  assert.equal(reopened.requestId, undefined)
  assert.equal(reopened.resolvedAt, undefined)
  assert.deepEqual(reopened.previousBatchIds, ['batch-1'])
  assert.equal(reopened.reopenedAt, 3000)
  assert.equal(reopened.updatedAt, 3000)
})

test('forkFinding preserves Schema v2 compliance and dynamic status getter', () => {
  const original = createFindingRecord({
    sessionId: 's-1',
    workspaceId: 'ws-1',
    text: 'Refactor finding lifecycle',
    tag: 'refactor',
    severity: 'major',
    submissionStatus: 'submitted',
    reviewStatus: 'resolved',
    batchId: 'b-old',
    requestId: 'r-old',
    assignedGroupId: 'g-old',
    submittedAt: 1500,
    resolvedAt: 2000,
  }, { now: () => 1000 })

  const forked = forkFinding(original, { now: () => 5000, idGenerator: () => 'fork-v2-1' })

  // Schema validation
  assert.equal(validateFindingRecord(forked).ok, true)
  assert.equal(forked.id, 'fork-v2-1')
  assert.equal(forked.sourceFindingId, original.id)
  assert.equal(forked.submissionStatus, 'unsubmitted')
  assert.equal(forked.reviewStatus, 'pending')
  assert.equal(forked.status, 'open')

  // Dynamic getter reflects status transitions
  forked.submissionStatus = 'submitted'
  assert.equal(forked.status, 'submitted')
  forked.reviewStatus = 'resolved'
  assert.equal(forked.status, 'resolved')

  // Cleared execution traces
  assert.equal(forked.batchId, undefined)
  assert.equal(forked.requestId, undefined)
  assert.equal(forked.assignedGroupId, undefined)
  assert.equal(forked.submittedAt, undefined)
  assert.equal(forked.resolvedAt, undefined)
})

test('filterInheritableFindings isolates findings by targetWorkspaceId', () => {
  const findings = [
    { id: 'f-ws1-1', kind: 'finding', workspaceId: 'ws-alpha', status: 'open', submissionStatus: 'unsubmitted' },
    { id: 'f-ws1-2', kind: 'finding', workspaceId: 'ws-alpha', status: 'open', submissionStatus: 'unsubmitted' },
    { id: 'f-ws2-1', kind: 'finding', workspaceId: 'ws-beta', status: 'open', submissionStatus: 'unsubmitted' },
    { id: 'f-ws2-2', kind: 'finding', workspaceId: 'ws-beta', status: 'resolved', reviewStatus: 'resolved' }, // resolved, ineligible
  ]

  // Without targetWorkspaceId: returns all eligible findings across all workspaces
  const allInheritable = filterInheritableFindings(findings)
  assert.equal(allInheritable.length, 3)

  // With targetWorkspaceId = 'ws-alpha': strictly returns findings from ws-alpha
  const alphaInheritable = filterInheritableFindings(findings, 'ws-alpha')
  assert.equal(alphaInheritable.length, 2)
  assert.deepEqual(alphaInheritable.map(f => f.id), ['f-ws1-1', 'f-ws1-2'])

  // With targetWorkspaceId = 'ws-beta': strictly returns open findings from ws-beta
  const betaInheritable = filterInheritableFindings(findings, 'ws-beta')
  assert.equal(betaInheritable.length, 1)
  assert.equal(betaInheritable[0].id, 'f-ws2-1')

  // With non-existent workspace: returns empty array
  const emptyInheritable = filterInheritableFindings(findings, 'ws-gamma')
  assert.equal(emptyInheritable.length, 0)
})

test('migrateFinding translates legacy statuses correctly', () => {
  // Legacy 'sent'
  const legacySent = { id: 'f-1', sessionId: 's-1', workspaceKey: 'ws-1', title: 'Task 1', status: 'sent' }
  const m1 = migrateFinding(legacySent)
  assert.equal(m1.submissionStatus, 'submitted')
  assert.equal(m1.reviewStatus, 'pending')
  assert.equal(m1.status, 'submitted')

  // Legacy 'open'
  const legacyOpen = { id: 'f-2', sessionId: 's-1', workspaceKey: 'ws-1', title: 'Task 2', status: 'open' }
  const m2 = migrateFinding(legacyOpen)
  assert.equal(m2.submissionStatus, 'unsubmitted')
  assert.equal(m2.reviewStatus, 'pending')
  assert.equal(m2.status, 'open')

  // Legacy 'resolved'
  const legacyResolved = { id: 'f-3', sessionId: 's-1', workspaceKey: 'ws-1', title: 'Task 3', status: 'resolved' }
  const m3 = migrateFinding(legacyResolved)
  assert.equal(m3.submissionStatus, 'submitted')
  assert.equal(m3.reviewStatus, 'resolved')
  assert.equal(m3.status, 'resolved')

  // Legacy 'dismissed'
  const legacyDismissed = { id: 'f-4', sessionId: 's-1', workspaceKey: 'ws-1', title: 'Task 4', status: 'dismissed' }
  const m4 = migrateFinding(legacyDismissed)
  assert.equal(m4.submissionStatus, 'submitted')
  assert.equal(m4.reviewStatus, 'dismissed')
  assert.equal(m4.status, 'dismissed')
})

// --- Store Schema v2 Integration Tests ---

function createMockStorage() {
  const store = new Map()
  return {
    getItem: (key) => store.has(key) ? store.get(key) : null,
    setItem: (key, val) => store.set(key, String(val)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
  }
}

test('store manages WorkspaceRecords with listWorkspaceRecords and putWorkspaceRecord', async () => {
  const storage = createMockStorage()
  const store = createLocalDeskStore({ storage, now: () => 1000 })

  const initial = await store.listWorkspaceRecords()
  assert.equal(initial.length, 0)

  const ws1 = createWorkspaceRecord({ id: 'ws-1', name: 'Alpha' })
  await store.putWorkspaceRecord(ws1)

  const listed = await store.listWorkspaceRecords()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].id, 'ws-1')
  assert.equal(listed[0].name, 'Alpha')

  // listWorkspaces backward compatibility
  const wsKeys = await store.listWorkspaces()
  assert.equal(wsKeys.includes('ws-1'), true)
})

test('store manages groups per session with getGroups and putGroup', async () => {
  const storage = createMockStorage()
  const store = createLocalDeskStore({ storage, now: () => 1000 })

  assert.deepEqual(await store.getGroups('s-1'), [])

  const g1 = createGroupRecord({
    sessionId: 's-1',
    workspaceId: 'ws-1',
    groupNumber: 1,
    startTurn: 0,
  })
  const g2 = createGroupRecord({
    sessionId: 's-1',
    workspaceId: 'ws-1',
    groupNumber: 2,
    startTurn: 2,
  })

  await store.putGroup(g1)
  await store.putGroup(g2)

  const groups = await store.getGroups('s-1')
  assert.equal(groups.length, 2)
  assert.equal(groups[0].id, 'g-1')
  assert.equal(groups[1].id, 'g-2')

  // Updating group replaces it. putGroup enforces invariant I2 (Phase 4 / B6),
  // so the referenced finding has to exist in the session bucket first.
  await store.putEntry({ id: 'f-1', sessionId: 's-1', workspaceKey: 'session:s-1', text: 'linked finding' })
  const g1Updated = { ...g1, items: [{ findingId: 'f-1', order: 1 }] }
  await store.putGroup(g1Updated)
  const afterUpdate = await store.getGroups('s-1')
  assert.equal(afterUpdate.length, 2)
  assert.deepEqual(afterUpdate[0].items, [{ findingId: 'f-1', order: 1 }])

  // Does not have archiveGroup
  assert.equal(typeof store.archiveGroup, 'undefined')
})

test('listEntries falls back to legacy session:<sessionId> keys when new workspace key has no entries', async () => {
  const storage = createMockStorage()
  const store = createLocalDeskStore({ storage, now: () => 1000 })

  // Write entry under legacy key `session:s-10`
  await store.putEntry({
    id: 'f-legacy-1',
    workspaceKey: 'session:s-10',
    workspaceId: 'ws-target',
    kind: 'finding',
    title: 'Legacy Finding',
    status: 'open',
  })

  // 1. Direct query with sessionId 's-10' (without 'session:') falls back and finds it
  const foundBySessionId = await store.listEntries('s-10')
  assert.equal(foundBySessionId.length, 1)
  assert.equal(foundBySessionId[0].id, 'f-legacy-1')

  // 2. Query with workspaceId 'ws-target' falls back across legacy session keys and finds it
  const foundByWs = await store.listEntries('ws-target')
  assert.equal(foundByWs.length, 1)
  assert.equal(foundByWs[0].id, 'f-legacy-1')
})
