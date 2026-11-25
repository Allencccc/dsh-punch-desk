import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_EXECUTING_GROUPS,
  addItemToGroup,
  canCreateGroup,
  createGroupRecord,
  deriveGroupExecutionStatus,
  nextGroupNumber,
  planGroupWrapUp,
  removeItemFromGroup,
  sessionElapsedTurns,
  validateGroupFindings,
  validateGroupRecord,
} from '../src/domain/active-group.js'

const deps = { now: () => 3000 }

const finding = (id, over = {}) => ({
  id,
  sessionId: 's-1',
  workspaceId: 'w-1',
  text: id,
  ...over,
})

function groupInput(over = {}) {
  return {
    sessionId: 's-1',
    workspaceId: 'w-1',
    groupNumber: 1,
    startTurn: 0,
    items: [{ findingId: 'f-1', order: 1 }],
    ...over,
  }
}

// --- Phase 4 invariants (I2): group item ↔ finding link validation ---

test('validateGroupRecord keeps legacy groups readable without a findings index', () => {
  // Old groups may reference findings that are no longer in the store; reading
  // them must not fail, only new writes with context are strict.
  const group = createGroupRecord(groupInput({ items: [{ findingId: 'ghost', order: 1 }] }), deps)
  assert.equal(group.id, 'g-1')
  assert.equal(validateGroupRecord(group).ok, true)
  assert.equal(validateGroupFindings(group).ok, true)
  // Structural validation is unchanged.
  assert.equal(validateGroupRecord({ ...group, groupNumber: 0 }).ok, false)
})

test('validateGroupRecord rejects orphan and cross-session items when a findings index is supplied', () => {
  const group = createGroupRecord(groupInput(), deps)

  assert.equal(validateGroupRecord(group, new Map([['f-1', finding('f-1')]])).ok, true)
  // Every supported index shape resolves the same way.
  assert.equal(validateGroupRecord(group, { 'f-1': finding('f-1') }).ok, true)
  assert.equal(validateGroupRecord(group, [finding('f-1')]).ok, true)
  assert.equal(validateGroupRecord(group, { findingsById: new Map([['f-1', finding('f-1')]]) }).ok, true)

  const orphan = validateGroupRecord(group, new Map())
  assert.equal(orphan.ok, false)
  assert.match(orphan.errors.join('; '), /item\[0\] finding not found: f-1/)

  const crossSession = validateGroupRecord(
    group,
    new Map([['f-1', finding('f-1', { sessionId: 's-2' })]]),
  )
  assert.equal(crossSession.ok, false)
  assert.match(crossSession.errors.join('; '), /item\[0\] finding belongs to another session: f-1/)
})

test('createGroupRecord validates items against an optional findings index', () => {
  assert.throws(
    () => createGroupRecord(groupInput(), { ...deps, findingsById: new Map() }),
    /finding not found: f-1/,
  )
  const created = createGroupRecord(
    groupInput(),
    { ...deps, findingsById: new Map([['f-1', finding('f-1')]]) },
  )
  assert.equal(created.id, 'g-1')
  assert.deepEqual(created.items, [{ findingId: 'f-1', order: 1 }])
})

test('validateGroupFindings only checks link invariants, not item shape', () => {
  const group = {
    id: 'g-1',
    groupNumber: 1,
    sessionId: 's-1',
    workspaceId: 'w-1',
    items: [{ findingId: 'f-1', order: 1 }],
  }

  assert.equal(validateGroupFindings(group, [finding('f-1')]).ok, true)
  assert.equal(validateGroupFindings(group, []).ok, false)
  assert.equal(validateGroupFindings(group).ok, true)

  // Shape problems stay validateGroupRecord's job; a malformed id is skipped
  // here instead of being reported twice or crashing the lookup.
  const malformedItem = { ...group, items: [{ findingId: '', order: 1 }] }
  assert.equal(validateGroupFindings(malformedItem, []).ok, true)
  assert.equal(validateGroupRecord(malformedItem, []).ok, false)

  assert.equal(validateGroupFindings(null).ok, false)
  assert.equal(validateGroupFindings({ ...group, items: 'nope' }).ok, false)
})

test('a group item pointing at the same session passes even before assignedGroupId is written', () => {
  // Ordering compatibility: submit writes the group item and the finding's
  // `assignedGroupId` in separate steps; the group link must be valid in the
  // intermediate state as long as membership and session agree.
  const group = createGroupRecord(groupInput(), deps)
  const unassigned = finding('f-1')
  assert.equal(validateGroupRecord(group, new Map([['f-1', unassigned]])).ok, true)
  assert.equal(validateGroupRecord(group, new Map([['f-1', finding('f-1', { assignedGroupId: 'g-1' })]])).ok, true)
})

// --- Existing group behavior guards (unchanged public behavior) ---

test('addItemToGroup clones, appends, and never duplicates a finding', () => {
  const group = createGroupRecord(groupInput(), deps)
  const next = addItemToGroup(group, 'f-2', { batchId: 'b-1' })
  assert.deepEqual(group.items, [{ findingId: 'f-1', order: 1 }])
  assert.deepEqual(next.items, [
    { findingId: 'f-1', order: 1 },
    { findingId: 'f-2', order: 2, batchId: 'b-1' },
  ])
  assert.equal(addItemToGroup(next, 'f-2'), next)
  assert.deepEqual(removeItemFromGroup(next, 'f-1').items, [{ findingId: 'f-2', order: 2, batchId: 'b-1' }])
})

test('nextGroupNumber stays monotonic and never reuses numbers', () => {
  assert.equal(nextGroupNumber([]), 1)
  assert.equal(nextGroupNumber([{ groupNumber: 1 }, { groupNumber: 2 }]), 3)
  assert.equal(nextGroupNumber([{ groupNumber: 1 }, { groupNumber: 4 }]), 5)
})

test('group status derivation and capacity helpers stay unchanged', () => {
  const group = createGroupRecord(groupInput(), deps)
  assert.equal(deriveGroupExecutionStatus({ ...group, items: [] }), 'executing')
  assert.equal(MAX_EXECUTING_GROUPS, 3)
  assert.equal(canCreateGroup([], {}, {}), true)
  assert.equal(sessionElapsedTurns({ startTurn: 3, turns: 99 }, 7), 4)
})

test('planGroupWrapUp keeps blocking unresolved rows (unchanged public behavior)', () => {
  const group = createGroupRecord(groupInput(), deps)
  const plan = planGroupWrapUp(
    group,
    { 'f-1': { id: 'f-1', submissionStatus: 'submitted' } },
    { 'f-1': 'executed' },
  )
  assert.deepEqual(plan, { settleIds: ['f-1'], queuedIds: [], runningIds: [], unsettledIds: [] })

  const queued = planGroupWrapUp(
    group,
    { 'f-1': { id: 'f-1', submissionStatus: 'submitted' } },
    { 'f-1': 'queued' },
  )
  assert.deepEqual(queued, { settleIds: [], queuedIds: ['f-1'], runningIds: [], unsettledIds: [] })
})
