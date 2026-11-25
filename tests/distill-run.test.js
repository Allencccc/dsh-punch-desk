import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHostDeskStore, sha256Hex, withWorkspaceLock } from '../src/store/host.js'
import {
  createDistillLifecycle,
  readNavigation,
  collectTargetSurface,
  distillErrorStatus,
  RUN_CONTROL_FINISHED_TTL_MS,
  RECOVERY_WORKSPACE_MAX_RETRIES,
} from '../src/store/distill-host.js'
import {
  lockTtlMs, staleTtlMs, planExpireMs, RUN_TIMINGS,
  MIN_BATCH_SESSIONS, MAX_BATCH_SESSIONS,
  RUN_STATUSES, TERMINAL_RUN_STATUSES, RUN_TRANSITIONS, PROGRESS_STAGES, EVIDENCE_GRADES,
  isTerminalRunStatus, canTransitionRun, transitionRun,
  createDistillRun, getActiveRun, canCreateDistillRun,
  validateSnapshot, freezeSnapshot, attachSnapshot, checkAnalyzingReadiness,
  updateRunProgress,
  detectMaterialDrift, markDriftDetected,
  deriveLockWindow, evaluateStaleRun, isPlanExpired,
  resolveCancelByStatus, markRunSuperseded,
} from '../src/domain/distill-run.js'

const T0 = 1_700_000_000_000
const SESSIONS = [
  { sessionId: 's1' },
  { sessionId: 's2', title: 'beta' },
  { sessionId: 's3', archived: true },
]
const HASHES = {
  's1:m1': 'a'.repeat(64),
  's2:m2': 'b'.repeat(64),
  's3:m3': 'c'.repeat(64),
}
const BY_GRADE = { resolved: 2, commit: 1, submitted: 1, dismissed: 1 }
const MODEL = { provider: 'prov', model: 'model-x' }
const BUDGET = { maxTokens: 100_000, truncated: false }

const mkRun = (over = {}) => ({
  ...createDistillRun({ id: 'run-1', workspaceId: 'ws-1', sessions: SESSIONS, now: T0 }),
  ...over,
})
const mkSnapshot = (over = {}) => freezeSnapshot({
  takenAt: T0, materialCount: 5, byGrade: BY_GRADE, contentHashes: HASHES, ...over,
})

/** Walk the real transition path up to ready (snapshot + model + budget complete). */
function buildReadyRun(readyAt = T0) {
  let run = createDistillRun({ id: 'run-1', workspaceId: 'ws-1', sessions: SESSIONS, now: T0 })
  run = transitionRun(run, 'snapshotting', { now: T0 + 1 })
  run = attachSnapshot(run, mkSnapshot(), T0 + 2)
  run = transitionRun(run, 'analyzing', { now: T0 + 3, patch: { model: MODEL, budget: BUDGET, progress: { stage: 'stage1', completed: 0, total: 3 } } })
  run = transitionRun(run, 'validating', { now: T0 + 4, patch: { progress: { stage: 'validating', completed: 0, total: 1 } } })
  run = transitionRun(run, 'ready', { now: readyAt, patch: { planId: 'plan-1' } })
  return run
}

// ---------------------------------------------------------------- constants

test('timing constants match spec §4.2 (30min / 2h / 24h)', () => {
  assert.equal(lockTtlMs, 30 * 60 * 1000)
  assert.equal(staleTtlMs, 2 * 60 * 60 * 1000)
  assert.equal(planExpireMs, 24 * 60 * 60 * 1000)
  assert.deepEqual(RUN_TIMINGS, { lockTtlMs, staleTtlMs, planExpireMs })
  assert.equal(Object.isFrozen(RUN_TIMINGS), true)
})

test('status enumeration covers the 11 spec statuses and 5 terminals', () => {
  assert.equal(RUN_STATUSES.length, 11)
  assert.deepEqual([...TERMINAL_RUN_STATUSES].sort(), ['applied', 'canceled', 'failed', 'stale', 'superseded'])
  for (const status of TERMINAL_RUN_STATUSES) assert.equal(isTerminalRunStatus(status), true)
  for (const status of ['queued', 'snapshotting', 'analyzing', 'validating', 'ready', 'applying']) {
    assert.equal(isTerminalRunStatus(status), false)
  }
  assert.equal(isTerminalRunStatus('bogus'), false)
  assert.deepEqual([...EVIDENCE_GRADES], ['resolved', 'commit', 'submitted', 'dismissed'])
  assert.deepEqual([...PROGRESS_STAGES], ['snapshotting', 'stage1', 'stage2', 'validating'])
})

// ---------------------------------------------------------------- transition table

test('legal main path walks queued→snapshotting→analyzing→validating→ready→applying→applied', () => {
  let run = buildReadyRun()
  assert.equal(run.status, 'ready')
  run = transitionRun(run, 'applying', { now: T0 + 10 })
  assert.equal(run.status, 'applying')
  run = transitionRun(run, 'applied', { now: T0 + 11, patch: { appliedAt: T0 + 11 } })
  assert.equal(run.status, 'applied')
  assert.equal(run.appliedAt, T0 + 11)
})

test('transition table accepts exactly the spec edges', () => {
  const legal = [
    ['queued', 'snapshotting'], ['queued', 'failed'], ['queued', 'canceled'], ['queued', 'stale'],
    ['snapshotting', 'analyzing'], ['snapshotting', 'failed'], ['snapshotting', 'canceled'], ['snapshotting', 'stale'],
    ['analyzing', 'validating'], ['analyzing', 'failed'], ['analyzing', 'canceled'], ['analyzing', 'stale'],
    ['validating', 'ready'], ['validating', 'failed'], ['validating', 'canceled'], ['validating', 'stale'],
    ['ready', 'applying'], ['ready', 'superseded'], ['ready', 'failed'], ['ready', 'canceled'], ['ready', 'stale'],
    ['applying', 'applied'], ['applying', 'failed'], ['applying', 'canceled'],
  ]
  for (const [from, to] of legal) assert.equal(canTransitionRun(from, to), true, `${from} -> ${to}`)
  const illegal = [
    ['queued', 'ready'], ['queued', 'analyzing'], ['snapshotting', 'ready'], ['snapshotting', 'applying'],
    ['analyzing', 'ready'], ['analyzing', 'applied'], ['validating', 'applying'], ['ready', 'analyzing'],
    ['ready', 'queued'], ['applying', 'ready'], ['applying', 'stale'], ['applying', 'superseded'],
    ['queued', 'superseded'], ['snapshotting', 'superseded'], ['analyzing', 'superseded'], ['validating', 'superseded'],
  ]
  for (const [from, to] of illegal) assert.equal(canTransitionRun(from, to), false, `${from} -> ${to}`)
  for (const status of RUN_STATUSES) assert.equal(canTransitionRun(status, status), false, `self ${status}`)
  assert.equal(canTransitionRun('bogus', 'ready'), false)
  assert.equal(canTransitionRun('ready', 'bogus'), false)
})

test('every terminal status has no outgoing edge (exhaustive)', () => {
  for (const terminal of TERMINAL_RUN_STATUSES) {
    assert.deepEqual(RUN_TRANSITIONS[terminal], [])
    for (const target of RUN_STATUSES) {
      assert.equal(canTransitionRun(terminal, target), false, `${terminal} -> ${target}`)
    }
  }
})

test('illegal transition throws and leaves the input untouched', () => {
  const run = mkRun()
  assert.throws(() => transitionRun(run, 'ready', { now: T0 + 1 }), /illegal run transition: queued -> ready/)
  assert.throws(() => transitionRun(run, 'analyzing', { now: T0 + 1 }), /queued -> analyzing/)
  assert.equal(run.status, 'queued')
  assert.equal(run.updatedAt, T0)
})

test('unknown status is rejected by transitionRun', () => {
  assert.throws(() => transitionRun(mkRun({ status: 'bogus' }), 'ready', { now: T0 }), /unknown run status/)
})

// ---------------------------------------------------------------- terminal irreversibility

test('terminal runs are irreversible: late progress cannot overwrite canceled (§4.2)', () => {
  const canceled = mkRun({ status: 'canceled', updatedAt: T0 + 5 })
  for (const target of ['ready', 'analyzing', 'applying', 'queued', 'snapshotting', 'validating', 'applied', 'failed', 'stale', 'superseded', 'canceled']) {
    assert.throws(
      () => transitionRun(canceled, target, { now: T0 + 99 }),
      (err) => err.code === 'TERMINAL_IRREVERSIBLE' && /terminal \(canceled\)/.test(err.message),
      `canceled -> ${target}`,
    )
  }
  assert.equal(canceled.status, 'canceled')
  assert.equal(canceled.updatedAt, T0 + 5)
})

test('all five terminals reject resurrection to any status', () => {
  for (const terminal of TERMINAL_RUN_STATUSES) {
    const run = mkRun({ status: terminal })
    for (const target of RUN_STATUSES) {
      assert.throws(() => transitionRun(run, target, { now: T0 + 1 }), /terminal/, `${terminal} -> ${target}`)
    }
  }
})

// ---------------------------------------------------------------- single batch per workspace

test('createDistillRun builds a queued run without fabricated snapshot/model/budget', () => {
  const run = createDistillRun({ id: 'r', workspaceId: 'ws-1', sessions: SESSIONS, scope: { sinceTs: 42 }, now: T0 })
  assert.equal(run.status, 'queued')
  assert.equal(run.createdAt, T0)
  assert.equal(run.updatedAt, T0)
  assert.equal(run.workspaceId, 'ws-1')
  assert.deepEqual(run.scope, { sinceTs: 42 })
  assert.deepEqual(run.progress, { stage: 'snapshotting', completed: 0, total: 3 })
  assert.equal('snapshot' in run, false)
  assert.equal('model' in run, false)
  assert.equal('budget' in run, false)
  assert.deepEqual(run.sessions[2], { sessionId: 's3', archived: true })
  assert.deepEqual(run.sessions[1], { sessionId: 's2', archived: false, title: 'beta' })
})

test('createDistillRun enforces workspaceId and 3~7 unique sessions (D2/§14.1)', () => {
  const base = { id: 'r', workspaceId: 'ws-1', sessions: SESSIONS, now: T0 }
  assert.throws(() => createDistillRun({ ...base, workspaceId: '' }), /workspaceId/)
  assert.throws(() => createDistillRun({ ...base, workspaceId: 'default' }), /default/)
  assert.throws(() => createDistillRun({ ...base, workspaceId: undefined }), /workspaceId/)
  assert.throws(() => createDistillRun({ ...base, id: '' }), /id/)
  assert.throws(() => createDistillRun({ ...base, sessions: SESSIONS.slice(0, 2) }), /3~7/)
  assert.throws(() => createDistillRun({ ...base, sessions: Array.from({ length: 8 }, (_, i) => ({ sessionId: `s${i}` })) }), /3~7/)
  assert.throws(() => createDistillRun({ ...base, sessions: [{ sessionId: 's1' }, { sessionId: 's1' }, { sessionId: 's2' }] }), /duplicate/)
  assert.throws(() => createDistillRun({ ...base, sessions: [{ sessionId: 's1' }, { sessionId: '' }, { sessionId: 's3' }] }), /sessionId/)
  assert.throws(() => createDistillRun({ ...base, now: Number.NaN }), /now/)
  assert.equal(MIN_BATCH_SESSIONS, 3)
  assert.equal(MAX_BATCH_SESSIONS, 7)
  const seven = Array.from({ length: 7 }, (_, i) => ({ sessionId: `s${i}` }))
  assert.equal(createDistillRun({ ...base, sessions: seven }).sessions.length, 7)
})

test('getActiveRun finds the single non-terminal run of the workspace only', () => {
  const active = mkRun({ status: 'analyzing' })
  const runs = [
    mkRun({ id: 'other-ws', workspaceId: 'ws-2', status: 'analyzing' }),
    mkRun({ id: 'done', status: 'applied' }),
    active,
  ]
  assert.equal(getActiveRun(runs, 'ws-1'), active)
  assert.equal(getActiveRun(runs, 'ws-2').id, 'other-ws')
  assert.equal(getActiveRun(runs, 'ws-3'), null)
  assert.equal(getActiveRun([], 'ws-1'), null)
  assert.equal(getActiveRun(null, 'ws-1'), null)
})

test('single-batch constraint: every non-terminal occupies the slot, every terminal releases it', () => {
  for (const status of RUN_STATUSES) {
    const runs = [mkRun({ status })]
    const terminal = isTerminalRunStatus(status)
    assert.equal(canCreateDistillRun(runs, 'ws-1'), terminal, `status ${status}`)
  }
  const runs = [mkRun({ status: 'ready' })]
  assert.equal(canCreateDistillRun(runs, 'ws-1'), false)
  assert.equal(canCreateDistillRun(runs, 'ws-other'), true)
  const superseded = transitionRun(runs[0], 'superseded', { now: T0 + 1, patch: { supersededBy: 'run-2' } })
  assert.equal(canCreateDistillRun([superseded], 'ws-1'), true)
})

// ---------------------------------------------------------------- snapshot freeze & analyzing guard

test('freezeSnapshot validates and clones; byGrade must include dismissed', () => {
  const snap = mkSnapshot()
  assert.deepEqual(snap.byGrade, BY_GRADE)
  assert.deepEqual(snap.contentHashes, HASHES)
  assert.notEqual(snap.contentHashes, HASHES)
  assert.equal(validateSnapshot(snap).ok, true)
  assert.throws(() => freezeSnapshot({ takenAt: T0, materialCount: 1, byGrade: { resolved: 1, commit: 0, submitted: 0 }, contentHashes: {} }), /dismissed/)
  assert.throws(() => freezeSnapshot({ takenAt: T0, materialCount: -1, byGrade: BY_GRADE, contentHashes: {} }), /materialCount/)
  assert.throws(() => freezeSnapshot({ takenAt: Number.NaN, materialCount: 0, byGrade: BY_GRADE, contentHashes: {} }), /takenAt/)
  assert.throws(() => freezeSnapshot({ takenAt: T0, materialCount: 0, byGrade: { ...BY_GRADE, resolved: 1.5 }, contentHashes: {} }), /resolved/)
  assert.throws(() => freezeSnapshot({ takenAt: T0, materialCount: 0, byGrade: BY_GRADE, contentHashes: { 's1:m1': '' } }), /contentHashes/)
  assert.throws(() => freezeSnapshot(null), /snapshot/)
  assert.equal(validateSnapshot({}).ok, false)
})

test('attachSnapshot only during snapshotting (§6.1 freeze timing)', () => {
  let run = transitionRun(mkRun(), 'snapshotting', { now: T0 + 1 })
  run = attachSnapshot(run, mkSnapshot(), T0 + 2)
  assert.equal(run.status, 'snapshotting')
  assert.equal(run.updatedAt, T0 + 2)
  assert.deepEqual(run.snapshot.byGrade, BY_GRADE)
  // re-freeze while still snapshotting is allowed
  const again = attachSnapshot(run, mkSnapshot({ materialCount: 6 }), T0 + 3)
  assert.equal(again.snapshot.materialCount, 6)
  for (const status of ['queued', 'analyzing', 'validating', 'ready', 'applying', 'applied', 'canceled']) {
    assert.throws(() => attachSnapshot(mkRun({ status }), mkSnapshot(), T0 + 4), /snapshotting/, status)
  }
})

test('checkAnalyzingReadiness reports missing snapshot/model/budget', () => {
  assert.deepEqual(checkAnalyzingReadiness(mkRun()), { ok: false, missing: ['snapshot', 'model', 'budget'] })
  const partial = mkRun({ snapshot: mkSnapshot(), model: MODEL })
  assert.deepEqual(checkAnalyzingReadiness(partial), { ok: false, missing: ['budget'] })
  const complete = mkRun({ snapshot: mkSnapshot(), model: MODEL, budget: BUDGET })
  assert.deepEqual(checkAnalyzingReadiness(complete), { ok: true, missing: [] })
  assert.deepEqual(checkAnalyzingReadiness(mkRun({ snapshot: mkSnapshot(), model: { provider: '', model: 'm' }, budget: BUDGET })).missing, ['model'])
  assert.deepEqual(checkAnalyzingReadiness(mkRun({ snapshot: mkSnapshot(), model: MODEL, budget: { maxTokens: 0, truncated: false } })).missing, ['budget'])
  assert.deepEqual(checkAnalyzingReadiness(mkRun({ snapshot: mkSnapshot(), model: MODEL, budget: { maxTokens: 10, truncated: 'no' } })).missing, ['budget'])
})

test('entering analyzing is refused until snapshot/model/budget are complete (§5.1)', () => {
  const snapshotting = attachSnapshot(transitionRun(mkRun(), 'snapshotting', { now: T0 + 1 }), mkSnapshot(), T0 + 2)
  assert.throws(
    () => transitionRun(snapshotting, 'analyzing', { now: T0 + 3 }),
    (err) => err.code === 'ANALYZING_PREREQUISITES_MISSING' && /model, budget/.test(err.message),
  )
  assert.throws(
    () => transitionRun(snapshotting, 'analyzing', { now: T0 + 3, patch: { model: MODEL } }),
    /missing: budget/,
  )
  const noSnapshot = transitionRun(mkRun(), 'snapshotting', { now: T0 + 1 })
  assert.throws(
    () => transitionRun(noSnapshot, 'analyzing', { now: T0 + 3, patch: { model: MODEL, budget: BUDGET } }),
    /missing: snapshot/,
  )
  const ok = transitionRun(snapshotting, 'analyzing', { now: T0 + 3, patch: { model: MODEL, budget: BUDGET } })
  assert.equal(ok.status, 'analyzing')
  assert.deepEqual(ok.model, MODEL)
  assert.deepEqual(ok.budget, BUDGET)
})

test('patch cannot override identity, clocks or lockWindow', () => {
  const run = mkRun()
  for (const key of ['status', 'id', 'workspaceId', 'createdAt', 'updatedAt', 'lockWindow']) {
    assert.throws(() => transitionRun(run, 'snapshotting', { now: T0 + 1, patch: { [key]: 'x' } }), /patch must not override/, key)
  }
  assert.throws(() => transitionRun(run, 'snapshotting', { now: T0 + 1, patch: [] }), /patch/)
})

// ---------------------------------------------------------------- progress

test('updateRunProgress enforces stage/status consistency and bounds', () => {
  const snapshotting = transitionRun(mkRun(), 'snapshotting', { now: T0 + 1 })
  const p = updateRunProgress(snapshotting, { stage: 'snapshotting', completed: 2, total: 3 }, T0 + 2)
  assert.deepEqual(p.progress, { stage: 'snapshotting', completed: 2, total: 3 })
  assert.equal(p.updatedAt, T0 + 2)
  assert.throws(() => updateRunProgress(snapshotting, { stage: 'stage1', completed: 0, total: 3 }, T0 + 2), /does not match/)
  const analyzing = mkRun({ status: 'analyzing' })
  assert.equal(updateRunProgress(analyzing, { stage: 'stage2', completed: 1, total: 2 }, T0 + 2).progress.stage, 'stage2')
  assert.throws(() => updateRunProgress(analyzing, { stage: 'validating', completed: 0, total: 1 }, T0 + 2), /does not match/)
  assert.throws(() => updateRunProgress(analyzing, { stage: 'stage1', completed: 4, total: 3 }, T0 + 2), /completed <= total/)
  assert.throws(() => updateRunProgress(analyzing, { stage: 'stage1', completed: -1, total: 3 }, T0 + 2), /non-negative/)
  assert.throws(() => updateRunProgress(mkRun({ status: 'ready' }), { stage: 'stage1', completed: 0, total: 1 }, T0 + 2), /does not carry progress/)
  assert.throws(() => updateRunProgress(mkRun({ status: 'canceled' }), { stage: 'stage1', completed: 0, total: 1 }, T0 + 2), /does not carry progress/)
})

// ---------------------------------------------------------------- drift

test('detectMaterialDrift compares frozen hashes: changed/removed flagged, added ignored', () => {
  const run = mkRun({ status: 'ready', snapshot: mkSnapshot() })
  assert.equal(detectMaterialDrift(run, { ...HASHES }, T0 + 1), null)
  const drift = detectMaterialDrift(run, { ...HASHES, 's2:m2': 'f'.repeat(64), 's9:m9': 'new' }, T0 + 1)
  assert.deepEqual(drift, { at: T0 + 1, changed: ['s2:m2'] })
  const removed = detectMaterialDrift(run, { 's1:m1': HASHES['s1:m1'] }, T0 + 2)
  assert.deepEqual(removed.changed, ['s2:m2', 's3:m3'])
  const multi = detectMaterialDrift(run, {}, T0 + 3)
  assert.deepEqual(multi.changed, ['s1:m1', 's2:m2', 's3:m3'])
  assert.throws(() => detectMaterialDrift(mkRun(), HASHES, T0), /no frozen snapshot/)
  assert.throws(() => detectMaterialDrift(run, null, T0), /currentHashes/)
})

test('markDriftDetected only annotates: status stays, never stale, TTL clocks untouched', () => {
  const ready = buildReadyRun(T0 + 100)
  const before = { updatedAt: ready.updatedAt, lockWindow: { ...ready.lockWindow } }
  const drifted = markDriftDetected(ready, { ...HASHES, 's1:m1': 'e'.repeat(64) }, T0 + 200)
  assert.equal(drifted.status, 'ready')
  assert.deepEqual(drifted.driftDetected, { at: T0 + 200, changed: ['s1:m1'] })
  assert.equal(drifted.updatedAt, before.updatedAt)
  assert.deepEqual(drifted.lockWindow, before.lockWindow)
  assert.equal(ready.driftDetected, undefined)
  // no drift -> same reference, no write
  assert.equal(markDriftDetected(ready, { ...HASHES }, T0 + 300), ready)
  // drift on an analyzing run also never changes status
  const analyzing = mkRun({ status: 'analyzing', snapshot: mkSnapshot() })
  const marked = markDriftDetected(analyzing, {}, T0 + 400)
  assert.equal(marked.status, 'analyzing')
  assert.equal(marked.driftDetected.changed.length, 3)
  assert.notEqual(marked.status, 'stale')
})

// ---------------------------------------------------------------- lock window

test('deriveLockWindow: pre-analysis unlocked, analyzing/validating/applying locked, terminals unlocked', () => {
  for (const status of ['queued', 'snapshotting']) {
    const win = deriveLockWindow(mkRun({ status }), T0 + 10 * staleTtlMs)
    assert.deepEqual(win, { locked: false, reason: 'pre-analysis', expiresAt: null }, status)
  }
  for (const status of ['analyzing', 'validating', 'applying']) {
    // even far beyond every TTL these stay locked (stale handling is recovery's job)
    const win = deriveLockWindow(mkRun({ status, updatedAt: T0 }), T0 + 10 * staleTtlMs)
    assert.deepEqual(win, { locked: true, reason: status, expiresAt: null }, status)
  }
  for (const status of TERMINAL_RUN_STATUSES) {
    const win = deriveLockWindow(mkRun({ status }), T0)
    assert.deepEqual(win, { locked: false, reason: 'terminal', expiresAt: null }, status)
  }
})

test('ready locks for exactly lockTtlMs then auto-unlocks while staying ready (D20)', () => {
  const readyAt = T0 + 1000
  const ready = buildReadyRun(readyAt)
  assert.equal(ready.status, 'ready')
  assert.equal(ready.lockWindow.expiresAt, readyAt + lockTtlMs)
  const at = (offset) => deriveLockWindow(ready, readyAt + offset)
  assert.equal(at(0).locked, true)
  assert.equal(at(0).reason, 'ready')
  assert.equal(at(lockTtlMs - 1).locked, true)
  assert.equal(at(lockTtlMs).locked, false)
  assert.equal(at(lockTtlMs).reason, 'ready-ttl-expired')
  assert.equal(at(lockTtlMs + 1).locked, false)
  assert.equal(at(lockTtlMs).expiresAt, readyAt + lockTtlMs)
  // derivation never mutates or re-statuses the run
  assert.equal(ready.status, 'ready')
  assert.equal(ready.updatedAt, readyAt)
})

test('ready TTL prefers persisted lockWindow.expiresAt, falls back to updatedAt', () => {
  const persisted = mkRun({ status: 'ready', updatedAt: T0, lockWindow: { startedAt: T0 - 5000, expiresAt: T0 + 1234 } })
  assert.equal(deriveLockWindow(persisted, T0 + 1233).locked, true)
  assert.equal(deriveLockWindow(persisted, T0 + 1234).locked, false)
  assert.equal(deriveLockWindow(persisted, T0 + 1234).expiresAt, T0 + 1234)
  const bare = mkRun({ status: 'ready', updatedAt: T0 })
  assert.equal(deriveLockWindow(bare, T0 + lockTtlMs - 1).locked, true)
  assert.equal(deriveLockWindow(bare, T0 + lockTtlMs).locked, false)
})

test('apply re-locks even after the ready TTL expired; terminals close the window', () => {
  const ready = buildReadyRun(T0)
  const late = T0 + lockTtlMs + 60_000
  assert.equal(deriveLockWindow(ready, late).locked, false)
  const applying = transitionRun(ready, 'applying', { now: late })
  assert.deepEqual(deriveLockWindow(applying, late), { locked: true, reason: 'applying', expiresAt: null })
  assert.equal(applying.lockWindow.startedAt, ready.lockWindow.startedAt)
  const applied = transitionRun(applying, 'applied', { now: late + 10 })
  assert.equal(applied.lockWindow.endedAt, late + 10)
  assert.equal(deriveLockWindow(applied, late + 10).locked, false)
  const failed = transitionRun(mkRun({ status: 'analyzing', lockWindow: { startedAt: T0, expiresAt: T0 + 1 } }), 'failed', { now: T0 + 2, patch: { error: { code: 'X', message: 'x' } } })
  assert.equal(failed.lockWindow.endedAt, T0 + 2)
  assert.equal(failed.error.code, 'X')
})

test('lockWindow opens at analyzing and keeps its startedAt through ready', () => {
  let run = transitionRun(mkRun(), 'snapshotting', { now: T0 + 1 })
  assert.equal('lockWindow' in run, false)
  run = attachSnapshot(run, mkSnapshot(), T0 + 2)
  run = transitionRun(run, 'analyzing', { now: T0 + 3, patch: { model: MODEL, budget: BUDGET } })
  assert.equal(run.lockWindow.startedAt, T0 + 3)
  run = transitionRun(run, 'validating', { now: T0 + 4 })
  assert.equal(run.lockWindow.startedAt, T0 + 3)
  run = transitionRun(run, 'ready', { now: T0 + 5 })
  assert.equal(run.lockWindow.startedAt, T0 + 3)
  assert.equal(run.lockWindow.expiresAt, T0 + 5 + lockTtlMs)
})

// ---------------------------------------------------------------- stale TTL & applying recovery

test('evaluateStaleRun: TTL-eligible statuses go stale only past staleTtlMs', () => {
  for (const status of ['queued', 'snapshotting', 'analyzing', 'validating', 'ready']) {
    const run = mkRun({ status, updatedAt: T0 })
    assert.deepEqual(evaluateStaleRun(run, T0 + staleTtlMs), { action: 'none', reason: 'within-ttl' }, `${status} at boundary`)
    assert.deepEqual(evaluateStaleRun(run, T0 + staleTtlMs + 1), { action: 'stale', reason: 'stale-ttl' }, `${status} past TTL`)
    assert.deepEqual(evaluateStaleRun(run, T0), { action: 'none', reason: 'within-ttl' }, `${status} fresh`)
  }
})

test('applying is NEVER TTL-staled: recovery must follow the transaction intent (§16.16)', () => {
  const applying = mkRun({ status: 'applying', updatedAt: T0 })
  assert.deepEqual(evaluateStaleRun(applying, T0 + 10 * staleTtlMs), { action: 'recover-tx', reason: 'applying-requires-transaction-recovery' })
  assert.deepEqual(evaluateStaleRun(applying, T0), { action: 'recover-tx', reason: 'applying-requires-transaction-recovery' })
  // and the transition table itself refuses applying -> stale
  assert.throws(() => transitionRun(applying, 'stale', { now: T0 + 10 * staleTtlMs }), /illegal run transition: applying -> stale/)
  // while the five TTL-eligible statuses can be transitioned to stale by the Host
  for (const status of ['queued', 'snapshotting', 'analyzing', 'validating', 'ready']) {
    assert.equal(transitionRun(mkRun({ status }), 'stale', { now: T0 + 3 * staleTtlMs }).status, 'stale')
  }
})

test('evaluateStaleRun: terminal runs are a no-op', () => {
  for (const status of TERMINAL_RUN_STATUSES) {
    assert.deepEqual(evaluateStaleRun(mkRun({ status, updatedAt: T0 }), T0 + 10 * staleTtlMs), { action: 'none', reason: 'terminal' })
  }
})

// ---------------------------------------------------------------- plan expiry

test('isPlanExpired hints after planExpireMs on ready only; drift does not shift the clock', () => {
  const ready = buildReadyRun(T0)
  assert.equal(isPlanExpired(ready, T0 + planExpireMs), false)
  assert.equal(isPlanExpired(ready, T0 + planExpireMs + 1), true)
  assert.equal(isPlanExpired(ready, T0), false)
  const drifted = markDriftDetected(ready, {}, T0 + planExpireMs + 500)
  assert.equal(drifted.status, 'ready')
  assert.equal(isPlanExpired(drifted, T0 + planExpireMs + 501), true)
  for (const status of RUN_STATUSES.filter(s => s !== 'ready')) {
    assert.equal(isPlanExpired(mkRun({ status, updatedAt: T0 }), T0 + 10 * planExpireMs), false, status)
  }
})

// ---------------------------------------------------------------- cancel arbitration (pure decision)

test('resolveCancelByStatus: direct cancel for the five pre-apply non-terminals', () => {
  for (const status of ['queued', 'snapshotting', 'analyzing', 'validating', 'ready']) {
    assert.deepEqual(resolveCancelByStatus(mkRun({ status })), { outcome: 'cancel', nextStatus: 'canceled', runStatus: status })
  }
})

test('resolveCancelByStatus: applying recovers first; canceled idempotent; other terminals too-late', () => {
  assert.deepEqual(resolveCancelByStatus(mkRun({ status: 'applying' })), { outcome: 'recover-first', runStatus: 'applying' })
  assert.deepEqual(resolveCancelByStatus(mkRun({ status: 'canceled' })), { outcome: 'idempotent', runStatus: 'canceled' })
  for (const status of ['applied', 'failed', 'stale', 'superseded']) {
    assert.deepEqual(resolveCancelByStatus(mkRun({ status })), { outcome: 'too-late', runStatus: status })
  }
  assert.throws(() => resolveCancelByStatus(mkRun({ status: 'bogus' })), /unknown run status/)
  // after recovery the Host can legally write canceled from applying
  assert.equal(transitionRun(mkRun({ status: 'applying' }), 'canceled', { now: T0 + 1 }).status, 'canceled')
})

// ---------------------------------------------------------------- supersede (rerun)

test('markRunSuperseded replaces an old ready run and keeps the new run id', () => {
  const ready = buildReadyRun()
  const next = markRunSuperseded(ready, 'run-2', T0 + 10)
  assert.equal(next.status, 'superseded')
  assert.equal(next.supersededBy, 'run-2')
  assert.equal(next.updatedAt, T0 + 10)
  assert.equal(next.planId, 'plan-1')
  assert.equal(ready.status, 'ready')
  assert.equal(canCreateDistillRun([next], 'ws-1'), true)
  assert.throws(() => markRunSuperseded(ready, '', T0 + 10), /supersededBy/)
  assert.throws(() => markRunSuperseded(ready, 'run-1', T0 + 10), /itself/)
  for (const status of ['queued', 'snapshotting', 'analyzing', 'validating', 'applying']) {
    assert.throws(() => markRunSuperseded(mkRun({ status }), 'run-2', T0 + 10), /illegal run transition/, status)
  }
})

// ---------------------------------------------------------------- purity & time discipline

test('helpers never mutate the input run (clone-on-write)', () => {
  const run = buildReadyRun()
  const frozenCopy = JSON.parse(JSON.stringify(run))
  transitionRun(run, 'applying', { now: T0 + 10 })
  markDriftDetected(run, {}, T0 + 10)
  deriveLockWindow(run, T0 + 10)
  evaluateStaleRun(run, T0 + 10)
  isPlanExpired(run, T0 + 10)
  resolveCancelByStatus(run)
  assert.deepEqual(JSON.parse(JSON.stringify(run)), frozenCopy)
})

test('time is always injected: missing or non-finite now is rejected', () => {
  const run = mkRun()
  const snap = mkSnapshot()
  assert.throws(() => transitionRun(run, 'snapshotting', {}), /now/)
  assert.throws(() => transitionRun(run, 'snapshotting', { now: Number.NaN }), /now/)
  assert.throws(() => transitionRun(run, 'snapshotting'), /now/)
  assert.throws(() => createDistillRun({ id: 'r', workspaceId: 'w', sessions: SESSIONS }), /now/)
  assert.throws(() => attachSnapshot(mkRun({ status: 'snapshotting' }), snap, undefined), /now/)
  assert.throws(() => updateRunProgress(mkRun({ status: 'analyzing' }), { stage: 'stage1', completed: 0, total: 1 }, 'later'), /now/)
  assert.throws(() => detectMaterialDrift(mkRun({ snapshot: snap }), HASHES), /now/)
  assert.throws(() => deriveLockWindow(run), /now/)
  assert.throws(() => evaluateStaleRun(run, Number.POSITIVE_INFINITY), /now/)
  assert.throws(() => isPlanExpired(run), /now/)
  assert.throws(() => markRunSuperseded(mkRun({ status: 'ready' }), 'run-2'), /now/)
})

// ==================================================================
// Task 2.4 — Host orchestration (lifecycle, RunControl, lazy recovery,
// target-surface collection). Pure-domain cases above stay untouched.
// ==================================================================

const WS = 'ws-1'
const SESSION_IDS = ['s1', 's2', 's3']
// createDistillRun (domain factory) requires object sessions; string
// normalization is the lifecycle's job, so direct seeds use objects.
const SESSION_OBJS = SESSION_IDS.map(sessionId => ({ sessionId }))

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function waitFor(predicate, { timeout = 4000, interval = 5 } = {}) {
  const start = Date.now()
  while (!(await predicate())) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await new Promise(r => setTimeout(r, interval))
  }
}

function sessionEvents(prefix) {
  return [
    { type: 'turn/start', seq: 1, time: T0 - 5000, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: T0 - 4000, data: { id: `${prefix}-u1`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `question ${prefix}` }] } },
    { type: 'assistant/message', seq: 3, time: T0 - 3000, data: { id: `${prefix}-a1`, role: 'assistant', content: [{ type: 'text', text: `answer ${prefix}` }] } },
    { type: 'turn/end', seq: 4, time: T0 - 2000, data: { turn: 1 } },
  ]
}

function findingFor(sessionId, over = {}) {
  return {
    id: `f-${sessionId}`,
    kind: 'finding',
    sessionId,
    workspaceKey: `session:${sessionId}`,
    title: 'rule candidate',
    body: 'body',
    submissionStatus: 'submitted',
    reviewStatus: 'resolved',
    completedVia: 'group-wrap-up',
    anchors: [{ kind: 'message', messageId: `${sessionId}-a1` }],
    submittedAt: T0 - 3000,
    ...over,
  }
}

function makeWorkspaceDir(t, { navigation = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-orch-ws-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  if (navigation) {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'),
      '# Repo\n\n## 0. 工程文档体系与导航 (Project Documentation Navigation)\n\n```text\n├── AGENTS.md\n└── docs/\n    └── guide.md\n```\n\n## 1. Other\n\ntext\n')
  }
  fs.mkdirSync(path.join(dir, 'docs'))
  fs.writeFileSync(path.join(dir, 'docs', 'guide.md'), '# Guide\n\n## Section A\n\noriginal body\n')
  return dir
}

function makeCtx({ workspaceDir, sessions, archived = [], resolveWorkspace = true }) {
  return {
    get(name) {
      if (name === 'sessionQuery') {
        return {
          readSession: async (id) => {
            if (!sessions[id]) {
              const err = new Error(`no session ${id}`)
              err.code = 'SESSION_QUERY_SESSION_NOT_FOUND'
              throw err
            }
            return { session: { id, cwd: sessions[id].cwd || workspaceDir }, inheritedEventCount: 0, events: sessions[id].events || sessions[id] }
          },
        }
      }
      if (name === 'workspaceRegistry') {
        return {
          get: id => (resolveWorkspace && id === WS ? { path: workspaceDir } : undefined),
          archivedSessionIds: archived,
        }
      }
      throw new Error(`cannot get property "${name}" without inject`)
    },
  }
}

function makePlan(runId, workspaceDir, over = {}) {
  const content = fs.readFileSync(path.join(workspaceDir, 'docs', 'guide.md'), 'utf8')
  return {
    schemaVersion: 1,
    runId,
    workspaceId: WS,
    summary: 'test plan',
    navigation: { source: 'AGENTS.md#0', mode: 'tree', fallback: false },
    targets: [{
      file: 'docs/guide.md',
      action: 'update',
      navRef: 'AGENTS.md > docs/',
      fileBaseHash: sha256Hex(content),
      changes: [{
        id: 'c1',
        kind: 'insert-into-section',
        sectionAnchor: '## Section A',
        proposedText: '- new rule\n',
        rationale: 'because',
        evidenceSnippet: 'snippet',
        evidence: [{ sessionId: 's1', messageId: 's1-a1', turn: 1, grade: 'resolved' }],
        dependsOn: [],
      }],
    }],
    conflicts: [],
    stats: { targets: 1, changes: 1, byGrade: { resolved: 3, commit: 0, submitted: 0 } },
    truncated: false,
    ...over,
  }
}

function makeAnalyzer({ store, workspaceDir, calls, probeImpl, stage1Impl, stage2Impl }) {
  return {
    probeContextWindow: probeImpl || (async () => ({ ok: true, contextWindow: 200000, model: { provider: 'p', model: 'm' } })),
    runStage1: stage1Impl || (async ({ sessionId, materials, signal }) => {
      calls.stage1.push({ sessionId, count: materials.length, signal })
      return { ok: true, candidates: [{ rule: `rule-${sessionId}`, evidenceRefs: [], suggestedTargets: ['docs/guide.md'] }], usage: { usedTokens: 10, truncated: false } }
    }),
    runStage2: stage2Impl || (async ({ run, stage1Results, navigation, signal }) => {
      calls.stage2.push({ runId: run.id, stage1Results, navigation, signal })
      const plan = { ...makePlan(run.id, workspaceDir), rawResponseRef: 'raw-ref-1' }
      await store.putDistillPlan(plan)
      return {
        ok: true,
        plan,
        summaries: stage1Results.map(r => ({ sessionId: r.sessionId, markdown: `# summary ${r.sessionId}`, source: 'llm' })),
        usage: { usedTokens: 20, truncated: false },
      }
    }),
  }
}

async function makeHarness(t, { navigation = true, archived = [], resolveWorkspace = true, probeImpl, stage1Impl, stage2Impl, gateSession = null, sessionOverrides = {} } = {}) {
  const clock = { now: T0 }
  const workspaceDir = makeWorkspaceDir(t, { navigation })
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-orch-store-'))
  t.after(() => fs.rmSync(storageDir, { recursive: true, force: true }))
  const store = createHostDeskStore({ storageRoot: storageDir, now: () => clock.now })
  const sessions = {}
  for (const id of SESSION_IDS) sessions[id] = sessionEvents(id)
  Object.assign(sessions, sessionOverrides)
  const gate = gateSession ? deferred() : null
  const baseCtx = makeCtx({ workspaceDir, sessions, archived, resolveWorkspace })
  const ctx = {
    get(name) {
      if (name === 'sessionQuery' && gate) {
        const inner = baseCtx.get(name)
        return {
          readSession: async (id) => {
            if (id === gateSession) await gate.promise
            return inner.readSession(id)
          },
        }
      }
      return baseCtx.get(name)
    },
  }
  for (const id of SESSION_IDS) await store.putEntry(findingFor(id))
  const calls = { stage1: [], stage2: [] }
  const analyzer = makeAnalyzer({ store, workspaceDir, calls, probeImpl, stage1Impl, stage2Impl })
  let seq = 0
  const lifecycle = createDistillLifecycle({
    ctx,
    store,
    analyzer,
    now: () => clock.now,
    uuid: () => `run-${++seq}`,
  })
  const start = (over = {}) => lifecycle.startRun({ workspaceId: WS, sessions: SESSION_IDS, ...over })
  const statusOf = async (id) => (await store.getDistillRun(id))?.status
  return { clock, workspaceDir, store, ctx, analyzer, calls, lifecycle, start, statusOf, gate }
}

test('orchestration: full pipeline reaches ready with frozen snapshot, checks, summaries and lock', async (t) => {
  const h = await makeHarness(t)
  const started = await h.start()
  assert.equal(started.ok, true)
  assert.equal(started.run.status, 'queued')
  assert.equal('snapshot' in started.run, false)
  await h.lifecycle.awaitRun(started.run.id)
  const { run, plan, lock } = await h.lifecycle.getRun({ id: started.run.id })
  assert.equal(run.status, 'ready')
  assert.equal(run.planId, run.id)
  assert.equal(run.snapshot.materialCount, 3)
  assert.deepEqual(run.snapshot.byGrade, { resolved: 3, commit: 0, submitted: 0, dismissed: 0 })
  assert.deepEqual(Object.keys(run.snapshot.contentHashes).sort(), ['s1:s1-a1', 's2:s2-a1', 's3:s3-a1'])
  assert.equal(run.snapshot.contentHashes['s1:s1-a1'], sha256Hex('[user]\nquestion s1\n\n[assistant]\nanswer s1'))
  assert.deepEqual(run.model, { provider: 'p', model: 'm' })
  assert.equal(run.budget.maxTokens, 200000 - 8000)
  assert.equal(run.budget.truncated, false)
  assert.equal(run.summaries.length, 3)
  assert.equal(run.progress.stage, 'validating')
  assert.deepEqual(lock, { locked: true, reason: 'ready', expiresAt: run.updatedAt + lockTtlMs })
  // analyzer consumed materials per session and received them in stage 2
  assert.equal(h.calls.stage1.length, 3)
  assert.ok(h.calls.stage1.every(c => c.count >= 1))
  assert.equal(h.calls.stage2.length, 1)
  assert.ok(h.calls.stage2[0].stage1Results.every(r => Array.isArray(r.materials) && r.materials.length >= 1))
  assert.equal(h.calls.stage2[0].navigation.mode, 'tree')
  // plan: checks attached, rawResponseRef preserved (read-modify-write)
  assert.ok(Array.isArray(plan.checks))
  assert.equal(plan.rawResponseRef, 'raw-ref-1')
  assert.equal(plan.runId, run.id)
})

test('orchestration: probe failure refuses run creation (§16.17)', async (t) => {
  for (const [code, status] of [['CONTEXT_WINDOW_UNAVAILABLE', 409], ['ANALYZER_UNAVAILABLE', 503]]) {
    const h = await makeHarness(t, { probeImpl: async () => ({ ok: false, error: { code, message: 'no' } }) })
    const result = await h.start()
    assert.equal(result.ok, false)
    assert.equal(result.status, status)
    assert.equal(result.code, code)
    assert.deepEqual(await h.store.listDistillRuns(WS), [])
    assert.equal(h.calls.stage1.length, 0)
  }
})

test('orchestration: budget failure after creation fails the run without any model call', async (t) => {
  const h = await makeHarness(t, { probeImpl: async () => ({ ok: true, contextWindow: 100, model: { provider: 'p', model: 'm' } }) })
  const started = await h.start()
  assert.equal(started.ok, true)
  await h.lifecycle.awaitRun(started.run.id)
  const run = await h.store.getDistillRun(started.run.id)
  assert.equal(run.status, 'failed')
  assert.equal(run.error.code, 'CONTEXT_WINDOW_UNAVAILABLE')
  assert.equal(h.calls.stage1.length, 0)
  assert.equal(h.calls.stage2.length, 0)
  assert.ok(run.snapshot, 'snapshot frozen before the budget gate')
})

test('orchestration: single-batch invariant rejects a second active run', async (t) => {
  const gate = deferred()
  const h = await makeHarness(t, { stage1Impl: async ({ sessionId }) => { await gate.promise; return { ok: true, candidates: [] } } })
  const first = await h.start()
  await waitFor(async () => (await h.statusOf(first.run.id)) === 'analyzing')
  const second = await h.start()
  assert.equal(second.ok, false)
  assert.equal(second.status, 409)
  assert.equal(second.code, 'RUN_ALREADY_ACTIVE')
  assert.equal(second.activeRunId, first.run.id)
  gate.resolve()
  await h.lifecycle.awaitRun(first.run.id)
  assert.equal((await h.store.getDistillRun(first.run.id)).status, 'ready')
  // §12.5 rerun: the old ready plan is superseded in place — its plan and the
  // human's selections stay untouched, but it can no longer be applied; the
  // new run takes the single-batch slot.
  const rerun = await h.start()
  assert.equal(rerun.ok, true)
  assert.notEqual(rerun.run.id, first.run.id)
  assert.deepEqual(rerun.supersededRunIds, [first.run.id])
  const superseded = await h.store.getDistillRun(first.run.id)
  assert.equal(superseded.status, 'superseded')
  assert.equal(superseded.supersededBy, rerun.run.id)
  await h.lifecycle.awaitRun(rerun.run.id)
  assert.equal(await h.statusOf(rerun.run.id), 'ready')
  // Cancel still releases the slot for the next run.
  await h.lifecycle.cancelRun({ runId: rerun.run.id })
  const third = await h.start()
  assert.equal(third.ok, true)
  await h.lifecycle.awaitRun(third.run.id)
})

test('orchestration: concurrent starts create exactly one run (atomic check)', async (t) => {
  const h = await makeHarness(t)
  const [a, b] = await Promise.all([h.start(), h.start()])
  const oks = [a, b].filter(r => r.ok)
  const conflicts = [a, b].filter(r => !r.ok)
  assert.equal(oks.length, 1)
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].code, 'RUN_ALREADY_ACTIVE')
  await h.lifecycle.awaitRun(oks[0].run.id)
  assert.equal((await h.store.listDistillRuns(WS)).length, 1)
})

test('orchestration: active cancel during snapshotting stops at the checkpoint', async (t) => {
  const h = await makeHarness(t, { gateSession: 's2' })
  const started = await h.start()
  await waitFor(async () => (await h.statusOf(started.run.id)) === 'snapshotting')
  const cancel = await h.lifecycle.cancelRun({ runId: started.run.id })
  assert.equal(cancel.ok, true)
  assert.equal(cancel.status, 'cancelRequested')
  h.gate.resolve()
  await h.lifecycle.awaitRun(started.run.id)
  assert.equal(await h.statusOf(started.run.id), 'canceled')
  assert.equal(h.lifecycle.getRunControl(started.run.id).state, 'finished')
  assert.equal(h.calls.stage1.length, 0)
})

test('orchestration: active cancel during analyzing aborts the signal and writes canceled', async (t) => {
  const h = await makeHarness(t, {
    stage1Impl: async ({ signal }) => {
      await new Promise(res => signal.addEventListener('abort', res, { once: true }))
      return { ok: false, error: { code: 'ABORTED', message: 'aborted' } }
    },
  })
  const started = await h.start()
  await waitFor(async () => (await h.statusOf(started.run.id)) === 'analyzing')
  const control = h.lifecycle.getRunControl(started.run.id)
  const cancel = await h.lifecycle.cancelRun({ runId: started.run.id })
  assert.equal(cancel.status, 'cancelRequested')
  assert.equal(control.abort.signal.aborted, true)
  await h.lifecycle.awaitRun(started.run.id)
  assert.equal(await h.statusOf(started.run.id), 'canceled')
})

test('orchestration: active cancel during validating never reaches ready', async (t) => {
  const h = await makeHarness(t)
  const gate = deferred()
  const originalPutPlan = h.store.putDistillPlan.bind(h.store)
  let planWrites = 0
  h.store.putDistillPlan = async (plan) => {
    planWrites += 1
    if (planWrites === 2) await gate.promise
    return originalPutPlan(plan)
  }
  const started = await h.start()
  await waitFor(async () => (await h.statusOf(started.run.id)) === 'validating')
  const cancel = await h.lifecycle.cancelRun({ runId: started.run.id })
  assert.equal(cancel.status, 'cancelRequested')
  gate.resolve()
  await h.lifecycle.awaitRun(started.run.id)
  assert.equal(await h.statusOf(started.run.id), 'canceled')
})

test('orchestration: active cancel never waits for the workspace lock (§11.2.7)', async (t) => {
  const stageGate = deferred()
  const h = await makeHarness(t, { stage1Impl: async () => { await stageGate.promise; return { ok: true, candidates: [] } } })
  const started = await h.start()
  await waitFor(async () => (await h.statusOf(started.run.id)) === 'analyzing')
  const lockGate = deferred()
  const held = withWorkspaceLock(fs.realpathSync(h.workspaceDir), () => lockGate.promise)
  const cancel = await h.lifecycle.cancelRun({ runId: started.run.id })
  assert.equal(cancel.status, 'cancelRequested')
  lockGate.resolve()
  await held
  stageGate.resolve()
  await h.lifecycle.awaitRun(started.run.id)
  assert.equal(await h.statusOf(started.run.id), 'canceled')
})

test('orchestration: ready run without active control cancels under the lock; repeats idempotent', async (t) => {
  const h = await makeHarness(t)
  const started = await h.start()
  await h.lifecycle.awaitRun(started.run.id)
  assert.equal(await h.statusOf(started.run.id), 'ready')
  const first = await h.lifecycle.cancelRun({ runId: started.run.id })
  assert.deepEqual(first, { ok: true, status: 'canceled', runStatus: 'canceled' })
  const second = await h.lifecycle.cancelRun({ runId: started.run.id })
  assert.deepEqual(second, { ok: true, status: 'canceled', runStatus: 'canceled' })
  assert.equal(await h.statusOf(started.run.id), 'canceled')
})

test('orchestration: repeated cancel during cancelRequested is idempotent', async (t) => {
  const gate = deferred()
  const h = await makeHarness(t, { stage1Impl: async ({ signal }) => { await gate.promise; return { ok: false, error: { code: 'ABORTED', message: 'x' } } } })
  const started = await h.start()
  await waitFor(async () => (await h.statusOf(started.run.id)) === 'analyzing')
  const a = await h.lifecycle.cancelRun({ runId: started.run.id })
  const b = await h.lifecycle.cancelRun({ runId: started.run.id })
  assert.equal(a.status, 'cancelRequested')
  assert.equal(b.status, 'cancelRequested')
  gate.resolve()
  await h.lifecycle.awaitRun(started.run.id)
  assert.equal(await h.statusOf(started.run.id), 'canceled')
})

test('orchestration: terminal applied/failed/stale/superseded cancels return too_late', async (t) => {
  const h = await makeHarness(t)
  for (const status of ['applied', 'failed', 'stale', 'superseded']) {
    const run = { ...createDistillRun({ id: `seed-${status}`, workspaceId: WS, sessions: SESSION_OBJS, now: T0 }), status, updatedAt: T0 }
    await h.store.putDistillRun(run)
    const result = await h.lifecycle.cancelRun({ runId: run.id })
    assert.equal(result.ok, true)
    assert.equal(result.status, 'too_late')
    assert.equal(result.tooLate, true)
    assert.equal(result.runStatus, status)
  }
})

test('orchestration: applying cancel without control recovers via the hook first', async (t) => {
  const h = await makeHarness(t)
  const seed = { ...createDistillRun({ id: 'applying-1', workspaceId: WS, sessions: SESSION_OBJS, now: T0 }), status: 'applying', updatedAt: T0, tx: { startedAt: T0, files: [], done: [], fingerprintIds: [] } }
  await h.store.putDistillRun(seed)
  // no handler registered yet: honest recoveryPending, run untouched
  const pending = await h.lifecycle.cancelRun({ runId: 'applying-1' })
  assert.equal(pending.status, 'too_late')
  assert.equal(pending.recoveryPending, true)
  assert.equal(await h.statusOf('applying-1'), 'applying')
  // handler writes canceled → idempotent cancel success
  let received = null
  h.lifecycle.registerApplyRecovery(async (input) => {
    received = input
    await h.store.putDistillRun({ ...(await h.store.getDistillRun('applying-1')), status: 'canceled', tx: null, updatedAt: input.now })
    return { runStatus: 'canceled', rolledBack: true }
  })
  const canceled = await h.lifecycle.cancelRun({ runId: 'applying-1' })
  assert.deepEqual(canceled, { ok: true, status: 'canceled', runStatus: 'canceled' })
  assert.equal(received.run.id, 'applying-1')
  assert.equal(received.workspaceDir, h.workspaceDir)
  assert.equal(received.store, h.store)
  assert.equal(received.now, T0)
  // handler writes failed with reason → too_late carries the error
  await h.store.putDistillRun({ ...seed, id: 'applying-2', status: 'applying' })
  h.lifecycle.registerApplyRecovery(async ({ run, now }) => {
    await h.store.putDistillRun({ ...(await h.store.getDistillRun(run.id)), status: 'failed', error: { code: 'RECOVERY_CONFLICT', message: 'external change' }, updatedAt: now })
    return { runStatus: 'failed', error: { code: 'RECOVERY_CONFLICT', message: 'external change' }, rolledBack: false }
  })
  const failed = await h.lifecycle.cancelRun({ runId: 'applying-2' })
  assert.equal(failed.status, 'too_late')
  assert.equal(failed.runStatus, 'failed')
  assert.equal(failed.error.code, 'RECOVERY_CONFLICT')
})

test('orchestration: late executor writes never overwrite a canceled run', async (t) => {
  const h = await makeHarness(t, { gateSession: 's2' })
  const started = await h.start()
  await waitFor(async () => (await h.statusOf(started.run.id)) === 'snapshotting')
  await h.lifecycle.cancelRun({ runId: started.run.id })
  const canceledAt = (await h.store.getDistillRun(started.run.id)).updatedAt
  h.gate.resolve()
  await h.lifecycle.awaitRun(started.run.id)
  const run = await h.store.getDistillRun(started.run.id)
  assert.equal(run.status, 'canceled')
  assert.equal(run.updatedAt, canceledAt)
})

test('orchestration: lazy recovery stales TTL-expired runs, skips active controls, never TTL-stales applying', async (t) => {
  const stageGate = deferred()
  const h = await makeHarness(t, { stage1Impl: async () => { await stageGate.promise; return { ok: true, candidates: [] } } })
  const active = await h.start()
  await waitFor(async () => (await h.statusOf(active.run.id)) === 'analyzing')
  const old = T0 - 3 * staleTtlMs
  for (const status of ['analyzing', 'ready']) {
    await h.store.putDistillRun({ ...createDistillRun({ id: `old-${status}`, workspaceId: WS, sessions: SESSION_OBJS, now: old }), status, updatedAt: old })
  }
  await h.store.putDistillRun({ ...createDistillRun({ id: 'old-applying', workspaceId: WS, sessions: SESSION_OBJS, now: old }), status: 'applying', updatedAt: old, tx: { startedAt: old, files: [], done: [], fingerprintIds: [] } })
  let hookCalls = 0
  h.lifecycle.registerApplyRecovery(async ({ run, now }) => {
    hookCalls += 1
    await h.store.putDistillRun({ ...(await h.store.getDistillRun(run.id)), status: 'failed', error: { code: 'RECOVERY_CONFLICT', message: 'crash' }, updatedAt: now })
    return { runStatus: 'failed', rolledBack: false }
  })
  const listed = await h.lifecycle.getRun({ workspaceId: WS })
  assert.equal(listed.ok, true)
  assert.equal(await h.statusOf('old-analyzing'), 'stale')
  assert.equal(await h.statusOf('old-ready'), 'stale')
  assert.equal(await h.statusOf('old-applying'), 'failed')
  assert.equal(hookCalls, 1)
  assert.equal(await h.statusOf(active.run.id), 'analyzing')
  stageGate.resolve()
  await h.lifecycle.awaitRun(active.run.id)
})

test('orchestration: WORKSPACE_UNAVAILABLE stays non-terminal, retries, fails only after the threshold', async (t) => {
  const h = await makeHarness(t, { resolveWorkspace: false })
  await h.store.putDistillRun({ ...createDistillRun({ id: 'stranded', workspaceId: WS, sessions: SESSION_OBJS, now: T0 }), status: 'analyzing', updatedAt: T0 })
  for (let i = 1; i < RECOVERY_WORKSPACE_MAX_RETRIES; i += 1) {
    await h.lifecycle.recoverWorkspace(WS)
    const run = await h.store.getDistillRun('stranded')
    assert.equal(run.status, 'analyzing')
    assert.equal(run.error.code, 'WORKSPACE_UNAVAILABLE')
    assert.equal(run.updatedAt, T0, 'annotation must not reset the TTL clock')
  }
  await h.lifecycle.recoverWorkspace(WS)
  const failed = await h.store.getDistillRun('stranded')
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error.code, 'WORKSPACE_UNAVAILABLE')
})

test('orchestration: session read failures fail the run with adapter codes', async (t) => {
  const missing = await makeHarness(t, { sessionOverrides: { s3: undefined } })
  // remove s3 from the session map entirely
  const started = await missing.start()
  await missing.lifecycle.awaitRun(started.run.id)
  const run = await missing.store.getDistillRun(started.run.id)
  assert.equal(run.status, 'failed')
  assert.equal(run.error.code, 'SESSION_NOT_FOUND')

  const foreignDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-orch-foreign-'))
  t.after(() => fs.rmSync(foreignDir, { recursive: true, force: true }))
  const mismatch = await makeHarness(t, { sessionOverrides: { s2: { cwd: foreignDir, events: sessionEvents('s2') } } })
  const started2 = await mismatch.start()
  await mismatch.lifecycle.awaitRun(started2.run.id)
  const run2 = await mismatch.store.getDistillRun(started2.run.id)
  assert.equal(run2.status, 'failed')
  assert.equal(run2.error.code, 'SESSION_WORKSPACE_MISMATCH')
})

test('orchestration: analyzer failure codes land on run.error; cancel wins over ABORTED', async (t) => {
  const h = await makeHarness(t, { stage1Impl: async () => ({ ok: false, error: { code: 'ANALYZER_TIMEOUT', message: 'stage1 timeout' } }) })
  const started = await h.start()
  await h.lifecycle.awaitRun(started.run.id)
  const run = await h.store.getDistillRun(started.run.id)
  assert.equal(run.status, 'failed')
  assert.equal(run.error.code, 'ANALYZER_TIMEOUT')
})

test('orchestration: stage2 bare ChangePlan payload is accepted and persisted', async (t) => {
  const h = await makeHarness(t, {
    stage2Impl: async ({ run }) => ({ ok: true, ...makePlan(run.id, h.workspaceDir) }),
  })
  const started = await h.start()
  await h.lifecycle.awaitRun(started.run.id)
  assert.equal(await h.statusOf(started.run.id), 'ready')
  const plan = await h.store.getDistillPlan(started.run.id)
  assert.equal(plan.runId, started.run.id)
  assert.ok(Array.isArray(plan.checks))
})

test('orchestration: invalid requests are rejected before the probe', async (t) => {
  let probes = 0
  const h = await makeHarness(t, { probeImpl: async () => { probes += 1; return { ok: true, contextWindow: 200000, model: { provider: 'p', model: 'm' } } } })
  const tooFew = await h.lifecycle.startRun({ workspaceId: WS, sessions: ['s1', 's2'] })
  assert.equal(tooFew.status, 400)
  const badWs = await h.lifecycle.startRun({ workspaceId: 'default', sessions: SESSION_IDS })
  assert.equal(badWs.status, 400)
  assert.equal(badWs.code, 'INVALID_WORKSPACE_ID')
  const noSessions = await h.lifecycle.startRun({ workspaceId: WS })
  assert.equal(noSessions.status, 400)
  assert.equal(probes, 0)
})

test('orchestration: finished control purged after TTL; late cancel still arbitrates correctly', async (t) => {
  const h = await makeHarness(t)
  const started = await h.start()
  await h.lifecycle.awaitRun(started.run.id)
  assert.equal(h.lifecycle.getRunControl(started.run.id).state, 'finished')
  h.clock.now += RUN_CONTROL_FINISHED_TTL_MS + 1
  const cancel = await h.lifecycle.cancelRun({ runId: started.run.id })
  assert.equal(cancel.status, 'canceled')
  assert.equal(h.lifecycle.getRunControl(started.run.id), null)
})

test('orchestration: committing control returns too_late without touching the run', async (t) => {
  const gate = deferred()
  const h = await makeHarness(t, { stage1Impl: async () => { await gate.promise; return { ok: true, candidates: [] } } })
  const started = await h.start()
  await waitFor(async () => (await h.statusOf(started.run.id)) === 'analyzing')
  assert.equal(h.lifecycle.casRunControl(started.run.id, 'active', 'committing'), true)
  const cancel = await h.lifecycle.cancelRun({ runId: started.run.id })
  assert.equal(cancel.status, 'too_late')
  assert.equal(cancel.tooLate, true)
  assert.equal(h.lifecycle.casRunControl(started.run.id, 'active', 'cancelRequested'), false)
  gate.resolve()
  await h.lifecycle.awaitRun(started.run.id)
})

test('target surface: §9 fields collected with shared anchors and honest rejections', async (t) => {
  const h = await makeHarness(t)
  const guidePath = path.join(h.workspaceDir, 'docs', 'guide.md')
  fs.writeFileSync(guidePath, '# Guide\n\n## Section A\n\n```md\n# fake heading\n```\n\nbody\n')
  const content = fs.readFileSync(guidePath, 'utf8')
  const plan = {
    targets: [
      { file: 'docs/guide.md', action: 'update' },
      { file: 'docs/new.md', action: 'create' },
      { file: '../escape.md', action: 'update' },
      { file: 'docs/unlisted.md', action: 'update' },
    ],
  }
  const navigation = readNavigation(h.workspaceDir)
  const surface = collectTargetSurface(h.workspaceDir, plan, navigation)
  assert.equal(surface.navigation.mode, 'tree')
  const [guide, created, rejected, unlisted] = surface.targets
  assert.equal(guide.exists, true)
  assert.equal(guide.content, content)
  assert.equal(guide.fileBaseHash, sha256Hex(content))
  assert.equal(guide.navRegistered, true)
  assert.deepEqual(guide.anchors.map(a => a.text), ['Guide', 'Section A'])
  assert.equal(guide.anchors[1].level, 2)
  assert.equal(created.exists, false)
  assert.equal(created.fileBaseHash, null)
  assert.deepEqual(surface.plannedFiles, ['docs/new.md'])
  assert.equal(rejected.pathRejected, true)
  assert.equal(unlisted.navRegistered, false)
})

test('readNavigation: tree mode requires §0 with document references; otherwise fallback', async (t) => {
  const h = await makeHarness(t)
  const tree = readNavigation(h.workspaceDir)
  assert.equal(tree.mode, 'tree')
  assert.ok(tree.content.includes('## 0.'))
  assert.ok(!tree.content.includes('## 1.'))
  fs.unlinkSync(path.join(h.workspaceDir, 'AGENTS.md'))
  assert.deepEqual(readNavigation(h.workspaceDir), { content: '', mode: 'fallback' })
  fs.writeFileSync(path.join(h.workspaceDir, 'AGENTS.md'), '# Repo\n\n## 1. No navigation\n')
  assert.equal(readNavigation(h.workspaceDir).mode, 'fallback')
  fs.writeFileSync(path.join(h.workspaceDir, 'AGENTS.md'), '# Repo\n\n## 0. 工程文档体系与导航\n\nempty section\n\n## 1. Next\n')
  assert.equal(readNavigation(h.workspaceDir).mode, 'fallback')
})

test('distillErrorStatus maps §13.3 codes and analyzer extensions', () => {
  assert.equal(distillErrorStatus('CONTEXT_WINDOW_UNAVAILABLE'), 409)
  assert.equal(distillErrorStatus('ANALYZER_UNAVAILABLE'), 503)
  assert.equal(distillErrorStatus('WORKSPACE_UNAVAILABLE'), 409)
  assert.equal(distillErrorStatus('CAS_CONFLICT'), 409)
  assert.equal(distillErrorStatus('RECOVERY_CONFLICT'), 409)
  assert.equal(distillErrorStatus('BACKUP_CORRUPT'), 409)
  assert.equal(distillErrorStatus('BACKUP_MISSING'), 409)
  assert.equal(distillErrorStatus('ANALYZER_TIMEOUT'), 504)
  assert.equal(distillErrorStatus('SESSION_NOT_FOUND'), 404)
  assert.equal(distillErrorStatus('SESSION_WORKSPACE_MISMATCH'), 403)
  assert.equal(distillErrorStatus('INVALID_WORKSPACE_ID'), 400)
  assert.equal(distillErrorStatus('SOMETHING_ELSE'), 500)
})

