import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createEntry, validateEntry, workspaceKeyFromCwd,
  findingBatchStatus, reopenFinding, forkFinding, nextThoughtNo, reconcileFindingStatuses,
  SEVERITIES,
  createFindingRecord, migrateFinding, validateFindingRecord,
  normalizeAcceptedEvidence, hasAcceptedEvidence, validateFindingGroupLink,
} from '../src/domain/entries.js'

const deps = { now: () => 1000, uuid: () => 'id-1' }

test('finding requires sessionId', () => {
  assert.throws(() => createEntry({ kind: 'finding', workspaceKey: 'w', title: 'x' }, deps), /sessionId/)
})

test('draft cannot carry sessionId before prefilled', () => {
  assert.throws(() => createEntry({ kind: 'draft', workspaceKey: 'w', title: 'x', sessionId: 's' }, deps), /prefilled/)
  const draft = createEntry({ kind: 'draft', workspaceKey: 'w', title: 'x', sessionId: 's', status: 'prefilled' }, deps)
  assert.equal(draft.sessionId, 's')
})

test('workspaceKey normalizes separators and trailing slashes', () => {
  assert.equal(workspaceKeyFromCwd('C:\\work\\repo\\'), 'C:/work/repo')
  assert.equal(workspaceKeyFromCwd('/Users/a/repo///'), '/Users/a/repo')
  assert.equal(workspaceKeyFromCwd(''), 'unknown')
})

test('validateEntry rejects unknown severity', () => {
  const entry = createEntry({ kind: 'finding', workspaceKey: 'w', sessionId: 's', title: 'x' }, deps)
  assert.equal(validateEntry({ ...entry, severity: 'nope' }).ok, false)
  assert.equal(SEVERITIES.includes('blocker'), true)
})

test('batch status is derived', () => {
  const base = { kind: 'finding', workspaceKey: 'w', sessionId: 's', title: 'x' }
  const mk = (status) => createEntry({ ...base, status }, deps)
  assert.equal(findingBatchStatus([mk('queued')]), 'queued')
  assert.equal(findingBatchStatus([mk('sent'), mk('open')]), 'partially-resolved')
  assert.equal(findingBatchStatus([mk('resolved'), mk('dismissed')]), 'archived')
})

test('mixed submitted and settled batch is partially resolved', () => {
  const base = { kind: 'finding', workspaceKey: 'w', sessionId: 's', title: 'x' }
  const mk = (status) => createEntry({ ...base, status }, deps)
  assert.equal(findingBatchStatus([mk('sent'), mk('resolved')]), 'partially-resolved')
  assert.equal(findingBatchStatus([mk('queued'), mk('dismissed')]), 'partially-resolved')
  assert.equal(findingBatchStatus([mk('sent'), mk('queued')]), 'sent')
})

test('reopenFinding keeps previous batch ids', () => {
  const entry = createEntry({ kind: 'finding', workspaceKey: 'w', sessionId: 's', title: 'x', status: 'sent', batchId: 'b1' }, deps)
  const next = reopenFinding(entry, { now: () => 2000 })
  assert.equal(next.status, 'open')
  assert.equal(next.batchId, undefined)
  assert.deepEqual(next.previousBatchIds, ['b1'])
  assert.equal(next.updatedAt, 2000)
})

const queuedFinding = (over = {}) => createEntry({
  kind: 'finding', workspaceKey: 'w', sessionId: 's', title: 'x',
  status: 'queued', batchId: 'b1', requestId: 'r1', ...over,
}, deps)

const promptRow = (over = {}) => ({
  messageId: 'm1', sessionId: 's', requestId: 'r1', status: 'sent', ...over,
})

test('reconcile turns a queued finding into sent and links the prompt log row', () => {
  const entry = queuedFinding()
  const changed = reconcileFindingStatuses([entry], [promptRow()], { now: () => 2000 })

  assert.equal(changed.length, 1)
  assert.equal(changed[0].status, 'sent')
  assert.equal(changed[0].promptLogId, 'm1')
  assert.equal(changed[0].batchId, 'b1')
  assert.equal(changed[0].requestId, 'r1')
  assert.equal(changed[0].updatedAt, 2000)
  // The stored entry must not be mutated in place.
  assert.equal(entry.status, 'queued')
  assert.equal(entry.promptLogId, undefined)
})

test('reconcile accepts a completed prompt row', () => {
  const [changed] = reconcileFindingStatuses(
    [queuedFinding()],
    [promptRow({ status: 'completed' })],
    { now: () => 3000 },
  )
  assert.equal(changed.status, 'sent')
  assert.equal(changed.promptLogId, 'm1')
  assert.equal(changed.updatedAt, 3000)
})

test('reconcile returns an expired prompt finding to open without batch or request ids', () => {
  const [changed] = reconcileFindingStatuses(
    [queuedFinding()],
    [promptRow({ status: 'expired' })],
    { now: () => 4000 },
  )
  assert.equal(changed.status, 'open')
  assert.equal(changed.batchId, undefined)
  assert.equal(changed.requestId, undefined)
  assert.equal('batchId' in changed, false)
  assert.equal('requestId' in changed, false)
  assert.equal(changed.updatedAt, 4000)
})

test('reconcile ignores non-queued findings even when the log row matches', () => {
  const sent = queuedFinding({ status: 'sent' })
  const resolved = queuedFinding({ status: 'resolved' })
  assert.deepEqual(
    reconcileFindingStatuses([sent, resolved], [promptRow({ status: 'expired' })]),
    [],
  )
})

test('reconcile ignores queued findings without a requestId and queued log rows', () => {
  assert.deepEqual(
    reconcileFindingStatuses([queuedFinding({ requestId: undefined })], [promptRow()]),
    [],
  )
  assert.deepEqual(
    reconcileFindingStatuses([queuedFinding()], [promptRow({ status: 'queued' })]),
    [],
  )
})

test('reconcile prefers a delivered row over a stale queue placeholder', () => {
  const [changed] = reconcileFindingStatuses(
    [queuedFinding()],
    [
      promptRow({ messageId: 'queue:r1', status: 'queued' }),
      promptRow({ messageId: 'm1', status: 'sent' }),
    ],
    { now: () => 5000 },
  )
  assert.equal(changed.status, 'sent')
  assert.equal(changed.promptLogId, 'm1')
})

test('reopenFinding clears resolvedAt and clones previousBatchIds', () => {
  const previousBatchIds = ['b0']
  const entry = createEntry({
    kind: 'finding', workspaceKey: 'w', sessionId: 's', title: 'x',
    status: 'resolved', resolvedAt: 1500, previousBatchIds,
  }, deps)
  const next = reopenFinding(entry, { now: () => 2000 })
  assert.equal(next.resolvedAt, undefined)
  assert.equal('resolvedAt' in next, false)
  assert.deepEqual(next.previousBatchIds, ['b0'])
  assert.notEqual(next.previousBatchIds, previousBatchIds)
  // A later edit of the returned array must not mutate the stored entry's array.
  next.previousBatchIds.push('b2')
  assert.deepEqual(previousBatchIds, ['b0'])
})

test('forkFinding forks resolved/executed finding into fresh open finding with lineage', () => {
  const original = createEntry({
    kind: 'finding',
    workspaceKey: 'ws-1',
    sessionId: 'session-1',
    sessionTitle: 'Feature Session',
    title: 'Original Title',
    text: 'Refactor database queries',
    tags: ['refactor'],
    severity: 'major',
    thoughtNo: 3,
    anchors: [{ type: 'quote', text: 'SELECT * FROM users' }],
    status: 'resolved',
    resolvedAt: 1200,
    submittedAt: 1100,
    batchId: 'batch-99',
    requestId: 'req-99',
    assignedGroupId: 'grp-1',
  }, deps)

  const forked = forkFinding(original, { now: () => 5000, idGenerator: () => 'forked-id-123' })

  // 1. New identity and explicit lineage
  assert.equal(forked.id, 'forked-id-123')
  assert.equal(forked.sourceFindingId, original.id)

  // 2. State initialized to binary initial state
  assert.equal(forked.status, 'open')
  assert.equal(forked.submissionStatus, 'unsubmitted')
  assert.equal(forked.reviewStatus, 'pending')

  // 3. Inherited core metadata
  assert.equal(forked.text, 'Refactor database queries')
  assert.equal(forked.body, 'Refactor database queries')
  assert.equal(forked.sessionId, 'session-1')
  assert.equal(forked.sessionTitle, 'Feature Session')
  assert.equal(forked.severity, 'major')
  assert.equal(forked.tag, 'refactor')
  assert.deepEqual(forked.anchors, [{ type: 'quote', text: 'SELECT * FROM users' }])
  // Display numbers are reassigned by the caller; lineage does not copy them.
  assert.equal('thoughtNo' in forked, false)

  // 4. Batch and scheduling traces are completely wiped
  assert.equal(forked.batchId, undefined)
  assert.equal(forked.requestId, undefined)
  assert.equal(forked.submittedAt, undefined)
  assert.equal(forked.resolvedAt, undefined)
  assert.equal(forked.assignedGroupId, undefined)
  assert.equal(forked.submittedVia, undefined)
  assert.equal(forked.reopenedAt, undefined)

  // 5. Timestamps
  assert.equal(forked.createdAt, 5000)
  assert.equal(forked.updatedAt, 5000)

  // 6. Original finding is completely immutable and preserved
  assert.equal(original.status, 'resolved')
  assert.equal(original.resolvedAt, 1200)
  assert.equal(original.batchId, 'batch-99')
})

test('nextThoughtNo assigns the next per-session display number', () => {
  assert.equal(nextThoughtNo([{ thoughtNo: 1 }, { thoughtNo: 7 }, { thoughtNo: 3 }]), 8)
  assert.equal(nextThoughtNo([]), 1)
  assert.equal(nextThoughtNo(null), 1)
  assert.equal(nextThoughtNo([{}, { thoughtNo: 'x' }, { thoughtNo: 0 }]), 1)
})

test('forkFinding preserves read-only compatibility for historical reopenedAt and rejects non-findings', () => {
  const legacyReopened = createEntry({
    kind: 'finding',
    workspaceKey: 'ws-1',
    sessionId: 'session-1',
    title: 'Legacy',
    status: 'open',
    reopenedAt: 9999,
  }, deps)
  assert.equal(legacyReopened.reopenedAt, 9999)

  const forked = forkFinding(legacyReopened, { now: () => 6000, idGenerator: () => 'f2' })
  assert.equal(forked.reopenedAt, undefined)
  assert.equal(legacyReopened.reopenedAt, 9999)

  assert.throws(() => forkFinding(null), /entry must be an object/)
  assert.throws(() => forkFinding({ kind: 'draft' }), /not a finding/)
})

// --- Group-turn attribution Phase 1: acceptance evidence (T-GTA-24) ---

const accepted = { acceptedAt: 1700000000123, submissionSeq: 3 }

test('acceptance evidence survives createEntry round trip as a pair', () => {
  const created = createEntry({
    kind: 'finding', workspaceKey: 'w', sessionId: 's', title: 'x', ...accepted,
  }, deps)
  assert.equal(created.acceptedAt, accepted.acceptedAt)
  assert.equal(created.submissionSeq, accepted.submissionSeq)

  // A re-save through the same factory (the persistence path) must not lose it.
  const roundTrip = createEntry({ ...created }, deps)
  assert.equal(roundTrip.acceptedAt, accepted.acceptedAt)
  assert.equal(roundTrip.submissionSeq, accepted.submissionSeq)
  assert.deepEqual(normalizeAcceptedEvidence(roundTrip), accepted)
  assert.equal(hasAcceptedEvidence(roundTrip), true)
})

test('new UI-created findings get no acceptance evidence by default', () => {
  const finding = createEntry({ kind: 'finding', workspaceKey: 'w', sessionId: 's', title: 'x' }, deps)
  assert.equal('acceptedAt' in finding, false)
  assert.equal('submissionSeq' in finding, false)
  assert.equal(normalizeAcceptedEvidence(finding).submissionSeq, undefined)
  assert.equal(hasAcceptedEvidence(finding), false)
})

test('createFindingRecord and migrateFinding preserve acceptance evidence across round trips', () => {
  const record = createFindingRecord({
    sessionId: 's', workspaceId: 'w', text: 't', ...accepted,
  }, deps)
  assert.equal(record.acceptedAt, accepted.acceptedAt)
  assert.equal(record.submissionSeq, accepted.submissionSeq)
  assert.equal(validateFindingRecord(record).ok, true)

  const recreated = createFindingRecord({ ...record }, deps)
  assert.equal(recreated.acceptedAt, accepted.acceptedAt)
  assert.equal(recreated.submissionSeq, accepted.submissionSeq)

  const migrated = migrateFinding({
    id: 'f-1', sessionId: 's', workspaceKey: 'w', text: 't', status: 'sent', ...accepted,
  })
  assert.equal(migrated.acceptedAt, accepted.acceptedAt)
  assert.equal(migrated.submissionSeq, accepted.submissionSeq)

  const remigrated = migrateFinding({ ...migrated })
  assert.equal(remigrated.acceptedAt, accepted.acceptedAt)
  assert.equal(remigrated.submissionSeq, accepted.submissionSeq)
})

test('partial or invalid acceptance evidence degrades to legacy (pair dropped)', () => {
  const invalidPairs = [
    { acceptedAt: 1000 },
    { submissionSeq: 2 },
    { acceptedAt: Number.NaN, submissionSeq: 2 },
    { acceptedAt: Number.POSITIVE_INFINITY, submissionSeq: 2 },
    { acceptedAt: '1000', submissionSeq: 2 },
    { acceptedAt: -1, submissionSeq: 2 },
    { acceptedAt: 1000, submissionSeq: 0 },
    { acceptedAt: 1000, submissionSeq: -2 },
    { acceptedAt: 1000, submissionSeq: 1.5 },
    { acceptedAt: 1000, submissionSeq: '2' },
  ]

  for (const bad of invalidPairs) {
    assert.deepEqual(normalizeAcceptedEvidence(bad), {}, `normalize ${JSON.stringify(bad)}`)

    const entry = createEntry({
      kind: 'finding', workspaceKey: 'w', sessionId: 's', title: 'x', ...bad,
    }, deps)
    assert.equal('acceptedAt' in entry, false, `createEntry ${JSON.stringify(bad)}`)
    assert.equal('submissionSeq' in entry, false, `createEntry ${JSON.stringify(bad)}`)

    const record = createFindingRecord({ sessionId: 's', text: 't', ...bad }, deps)
    assert.equal('acceptedAt' in record, false, `createFindingRecord ${JSON.stringify(bad)}`)
    assert.equal('submissionSeq' in record, false, `createFindingRecord ${JSON.stringify(bad)}`)

    const migrated = migrateFinding({ id: 'f-1', sessionId: 's', text: 't', ...bad })
    assert.equal('acceptedAt' in migrated, false, `migrateFinding ${JSON.stringify(bad)}`)
    assert.equal('submissionSeq' in migrated, false, `migrateFinding ${JSON.stringify(bad)}`)
  }

  // The complete, valid pair is the only accepted form.
  assert.deepEqual(normalizeAcceptedEvidence(accepted), accepted)
  assert.deepEqual(normalizeAcceptedEvidence({ acceptedAt: 0, submissionSeq: 1 }), { acceptedAt: 0, submissionSeq: 1 })
  assert.deepEqual(normalizeAcceptedEvidence(null), {})
})

test('validateFindingRecord rejects a partial or invalid acceptance pair', () => {
  const base = createFindingRecord({ sessionId: 's', text: 't' }, deps)
  assert.equal(validateFindingRecord({ ...base, acceptedAt: 1000 }).ok, false)
  assert.equal(validateFindingRecord({ ...base, submissionSeq: 1 }).ok, false)
  assert.equal(validateFindingRecord({ ...base, acceptedAt: Number.POSITIVE_INFINITY, submissionSeq: 1 }).ok, false)
  assert.equal(validateFindingRecord({ ...base, acceptedAt: 1000, submissionSeq: 0 }).ok, false)
  assert.equal(validateFindingRecord({ ...base, ...accepted }).ok, true)
  // Absent pair stays valid for every legacy record already on disk.
  assert.equal(validateFindingRecord({ ...base }).ok, true)
})

test('acceptance evidence is cleared when a submission cycle ends or is inherited', () => {
  const submitted = createEntry({
    kind: 'finding', workspaceKey: 'w', sessionId: 's', title: 'x', status: 'submitted', ...accepted,
  }, deps)

  const reopened = reopenFinding(submitted, { now: () => 2000 })
  assert.equal('acceptedAt' in reopened, false)
  assert.equal('submissionSeq' in reopened, false)

  const forked = forkFinding(submitted, { now: () => 2000, idGenerator: () => 'fork-1' })
  assert.equal('acceptedAt' in forked, false)
  assert.equal('submissionSeq' in forked, false)

  const queued = createEntry({
    kind: 'finding', workspaceKey: 'w', sessionId: 's', title: 'x', status: 'queued', requestId: 'r1', ...accepted,
  }, deps)
  const [expired] = reconcileFindingStatuses([queued], [promptRow({ status: 'expired' })], { now: () => 3000 })
  assert.equal(expired.status, 'open')
  assert.equal('acceptedAt' in expired, false)
  assert.equal('submissionSeq' in expired, false)
})

// --- Group-turn attribution Phase 4: relationship invariants (I1/I2, B6) ---

test('validateFindingRecord rejects a malformed assignedGroupId but keeps legacy rows readable', () => {
  const base = createFindingRecord({ sessionId: 's', workspaceId: 'w', text: 't' }, deps)
  assert.equal(validateFindingRecord({ ...base, assignedGroupId: 'g-1' }).ok, true)
  assert.equal(validateFindingRecord({ ...base }).ok, true)
  // `null` is an explicit "unassigned" legacy value; absent is also fine.
  assert.equal(validateFindingRecord({ ...base, assignedGroupId: null }).ok, true)

  for (const bad of ['', '   ', 42, {}, []]) {
    const result = validateFindingRecord({ ...base, assignedGroupId: bad })
    assert.equal(result.ok, false, `assignedGroupId=${JSON.stringify(bad)}`)
    assert.match(result.errors.join('; '), /assignedGroupId/)
  }
})

test('validateFindingGroupLink rejects orphans, cross-session links and group mismatch', () => {
  const finding = createFindingRecord({
    id: 'f-1', sessionId: 's-1', workspaceId: 'w-1', text: 't', assignedGroupId: 'g-1',
  }, deps)
  const group = { id: 'g-1', sessionId: 's-1', workspaceId: 'w-1', items: [{ findingId: 'f-1', order: 1 }] }
  assert.equal(validateFindingGroupLink(finding, group).ok, true)

  const orphan = validateFindingGroupLink(finding, { ...group, items: [] })
  assert.equal(orphan.ok, false)
  assert.match(orphan.errors.join('; '), /not an item/)

  const crossSession = validateFindingGroupLink(finding, { ...group, sessionId: 's-2' })
  assert.equal(crossSession.ok, false)
  assert.match(crossSession.errors.join('; '), /different sessions/)

  const mismatch = validateFindingGroupLink({ ...finding, assignedGroupId: 'g-2' }, group)
  assert.equal(mismatch.ok, false)
  assert.match(mismatch.errors.join('; '), /does not match group g-1/)

  // A legacy finding that was never assigned is still a valid group item.
  const legacy = { ...finding }
  delete legacy.assignedGroupId
  assert.equal(validateFindingGroupLink(legacy, group).ok, true)

  // Missing operands are reported, not thrown.
  assert.equal(validateFindingGroupLink(null, group).ok, false)
  assert.equal(validateFindingGroupLink(finding, null).ok, false)
})

test('createEntry rejects a malformed assignedGroupId for findings (new writes strict)', () => {
  const base = { kind: 'finding', workspaceKey: 'w', sessionId: 's', title: 'x' }
  assert.throws(() => createEntry({ ...base, assignedGroupId: '' }, deps), /assignedGroupId/)
  assert.throws(() => createEntry({ ...base, assignedGroupId: '   ' }, deps), /assignedGroupId/)
  assert.throws(() => createEntry({ ...base, assignedGroupId: 42 }, deps), /assignedGroupId/)

  const assigned = createEntry({ ...base, assignedGroupId: 'g-1' }, deps)
  assert.equal(assigned.assignedGroupId, 'g-1')
  // Legacy omissions stay valid.
  assert.equal('assignedGroupId' in createEntry(base, deps), false)
  assert.equal(createEntry({ ...base, assignedGroupId: null }, deps).assignedGroupId, null)
})
