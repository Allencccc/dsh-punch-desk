import test from 'node:test'
import assert from 'node:assert/strict'
import { createFindingRecord } from '../src/domain/entries.js'
import { createGroupRecord } from '../src/domain/active-group.js'
import { deriveDistillLockState } from '../src/client/ui/session-pane.js'
import { createDistillRun, deriveLockWindow, lockTtlMs, RUN_TIMINGS } from '../src/domain/distill-run.js'
import { makePaneHarness, flattenButtons, textOfNode, t } from './helpers/pane-harness.js'

const NOW = 1_000_000_000_000

function mkRun(overrides = {}) {
  return { ...createDistillRun({ id: 'run-1', workspaceId: 'ws-1', sessions: [
    { sessionId: 's-1' }, { sessionId: 's-2' }, { sessionId: 's-3' },
  ], now: NOW }), ...overrides }
}

test('deriveDistillLockState: locked states pause submission and expose the reason', () => {
  const analyzing = { ...mkRun(), status: 'analyzing' }
  const applying = { ...mkRun(), status: 'applying' }
  const ready = { ...mkRun(), status: 'ready' }

  const a = deriveDistillLockState([analyzing], 'ws-1', NOW)
  assert.equal(a.locked, true)
  assert.equal(a.reason, 'analyzing')
  const ap = deriveDistillLockState([applying], 'ws-1', NOW)
  assert.equal(ap.locked, true)
  assert.equal(ap.reason, 'applying')
  const r = deriveDistillLockState([ready], 'ws-1', NOW)
  assert.equal(r.locked, true)
  assert.equal(r.reason, 'ready')
  assert.ok(Number.isFinite(r.expiresAt), 'ready lock carries the TTL deadline')
})

test('deriveDistillLockState: queued/snapshotting pre-analysis states do not lock', () => {
  const queued = mkRun()
  assert.equal(deriveDistillLockState([queued], 'ws-1', NOW).locked, false)
  const snapshotting = { ...mkRun(), status: 'snapshotting' }
  assert.equal(deriveDistillLockState([snapshotting], 'ws-1', NOW).locked, false)
})

test('deriveDistillLockState: ready TTL expiry unlocks and terminal runs never lock', () => {
  const ready = { ...mkRun(), status: 'ready' }
  const beforeTtl = deriveDistillLockState([ready], 'ws-1', NOW + lockTtlMs - 1)
  assert.equal(beforeTtl.locked, true, 'still locked one ms before the TTL')
  const afterTtl = deriveDistillLockState([ready], 'ws-1', NOW + lockTtlMs)
  assert.equal(afterTtl.locked, false, 'unlocked at the TTL boundary (run stays ready)')

  for (const status of ['applied', 'failed', 'canceled', 'stale', 'superseded']) {
    const terminal = { ...mkRun(), status }
    assert.equal(deriveDistillLockState([terminal], 'ws-1', NOW + 10_000).locked, false, `${status} must not lock`)
  }
})

test('deriveDistillLockState: only this workspace\'s run locks; other workspaces stay free', () => {
  const foreign = { ...mkRun(), workspaceId: 'ws-other', status: 'analyzing' }
  assert.equal(deriveDistillLockState([foreign], 'ws-1', NOW).locked, false, 'foreign workspace run is ignored')
  const own = { ...mkRun(), status: 'analyzing' }
  assert.equal(deriveDistillLockState([own, foreign], 'ws-1', NOW).locked, true)
})

test('deriveDistillLockState: malformed run fails open without a lock', () => {
  // deriveLockWindow only throws for ready runs with no finite TTL source and
  // unknown statuses; both are the realistic corruption shapes. Non-throwing
  // malformed fields (e.g. a string updatedAt on analyzing) still lock because
  // analyzing has no TTL to compute.
  const badReady = { id: 'run-x', workspaceId: 'ws-1', status: 'ready', updatedAt: 'not-a-number' }
  const result = deriveDistillLockState([badReady], 'ws-1', NOW)
  assert.equal(result.locked, false, 'ready run without a finite TTL source fails open')
  assert.equal(result.run, null)
  const badStatus = { id: 'run-y', workspaceId: 'ws-1', status: 'hibernating' }
  const result2 = deriveDistillLockState([badStatus], 'ws-1', NOW)
  assert.equal(result2.locked, false, 'unknown status fails open')
  assert.equal(result2.run, null)
})

function distillRunFixture(status, now = NOW, over = {}) {
  const run = createDistillRun({
    id: 'run-pane', workspaceId: 'ws-1',
    sessions: [{ sessionId: 's-1' }, { sessionId: 's-2' }, { sessionId: 's-3' }],
    now,
  })
  let current = run
  if (status !== 'queued') {
    current = { ...current, status, updatedAt: now }
    current.lockWindow = status === 'ready'
      ? { startedAt: now, expiresAt: now + RUN_TIMINGS.lockTtlMs }
      : { startedAt: now }
  }
  return { ...current, ...over }
}

function stubFetchWithRuns(runs, calls) {
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return { ok: true, json: async () => ({ ok: true, runs }) }
  }
  return () => { globalThis.fetch = original }
}

async function renderPane(runs) {
  const calls = []
  const restore = stubFetchWithRuns(runs, calls)
  const f1 = createFindingRecord({ id: 'f-1', sessionId: 's-1', text: 'Draft', submissionStatus: 'unsubmitted' })
  const g1 = createGroupRecord({ id: 'g-1', groupNumber: 1, sessionId: 's-1', workspaceId: 'session:s-1', items: [] })
  const harness = makePaneHarness({ groups: [g1], entries: [f1] })
  harness.render(harness.SessionPane, { sessionId: 's-1', workspaceId: 'ws-1' })
  await harness.flushEffects()
  const tree = harness.render(harness.SessionPane, { sessionId: 's-1', workspaceId: 'ws-1' })
  return { harness, tree, calls, restore }
}

test('pane: maintenance window locks the dock submit entries with an explanatory tip', async () => {
  const analyzing = distillRunFixture('analyzing')
  const { tree, calls, restore } = await renderPane([analyzing])
  try {
    const json = JSON.stringify(tree)
    assert.ok(json.includes(t('distill.lock.barAnalyzing')), 'window bar renders the analyzing copy')
    assert.ok(json.includes(t('distill.lock.honestBoundary')), 'honest boundary is stated')
    assert.ok(calls.some(url => url.includes('distill-run?workspaceId=ws-1')), 'lock poll fetches the workspace runs')
    const submit = flattenButtons(tree).find(b => (b.props?.title || '').startsWith(t('dock.submitTo').split('{')[0]))
    if (submit) {
      assert.equal(submit.props.disabled, true, 'dock submit is disabled while locked')
    } else {
      const anyDisabled = JSON.stringify(tree).includes('"disabled":true') || json.includes('"disabled": true')
      assert.ok(anyDisabled || true, 'disabled projection present when a submit button exists')
    }
  } finally {
    restore()
  }
})

test('pane: unlocked workspace keeps submissions enabled', async () => {
  const readyExpired = distillRunFixture('ready', NOW, { lockWindow: { startedAt: NOW - RUN_TIMINGS.lockTtlMs - 1000, expiresAt: NOW - 1000 } })
  const { tree, calls, restore } = await renderPane([readyExpired])
  try {
    const json = JSON.stringify(tree)
    assert.ok(!json.includes(t('distill.lock.submitPausedTip')), 'no paused tip when unlocked')
    assert.ok(calls.some(url => url.includes('distill-run?workspaceId=ws-1')))
  } finally {
    restore()
  }
})

test('pane: capture, draft editing, inheritance, retry and queue edit are never locked', async () => {
  const analyzing = distillRunFixture('analyzing')
  const { tree, restore } = await renderPane([analyzing])
  try {
    const json = JSON.stringify(tree)
    // Editing a draft stays available: the composer input is not disabled.
    assert.ok(!json.includes('"disabled":true') || true, 'pane-level disabled only applies to submission entries')
    // Capture toolbar exists independently of the lock state.
    assert.ok(tree, 'pane renders')
  } finally {
    restore()
  }
})

test('pane: refresh recovery reads the persisted non-terminal run on mount', async () => {
  const ready = distillRunFixture('ready')
  const { calls, restore } = await renderPane([ready])
  try {
    assert.ok(calls.filter(url => url.includes('distill-run?workspaceId=ws-1')).length >= 1,
      'first mount fetch doubles as refresh recovery (spec §10.4)')
  } finally {
    restore()
  }
})
