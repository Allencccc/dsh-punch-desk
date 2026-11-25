import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  createHostDeskStore,
  pruneDistillRuns,
  pruneDistillFingerprints,
  distillRunBucketKey,
  distillPlanKeyFor,
} from '../src/store/host.js'
import { createDeskStore } from '../src/store/local.js'
import { verifyStateContainsDump } from '../src/store/migrate.js'
import { HOST_STATE_VERSION, DISTILL_RETENTION } from '../src/store/contract.js'
import { handleStoreRpc } from '../index.js'

const DAY = 24 * 3600 * 1000

function makeDir(t, prefix = 'pd-distill-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function makeRun(id, workspaceId, at, overrides = {}) {
  return {
    id,
    workspaceId,
    status: 'ready',
    createdAt: at,
    updatedAt: at,
    sessions: [],
    scope: {},
    progress: { stage: 'stage1', completed: 0, total: 0 },
    ...overrides,
  }
}

function makeFingerprint(id, workspaceId, at, runId = 'r1') {
  return {
    id,
    workspaceId,
    targetFile: 'docs/arch/README.md',
    changeKind: 'append-section',
    normalizedHash: `hash-${id}`,
    sourceRefs: [],
    runId,
    appliedAt: at,
    appliedFileHash: `applied-${id}`,
  }
}

test('pruneDistillRuns enforces 90 days / 100 runs and keeps legacy rows', () => {
  const now = 1_700_000_000_000
  const runs = [
    makeRun('old', 'ws1', now - 91 * DAY),
    makeRun('fresh', 'ws1', now - 1 * DAY),
    makeRun('middle', 'ws1', now - 89 * DAY),
  ]
  assert.deepEqual(
    pruneDistillRuns(runs, { now }).map(run => run.id).sort(),
    ['fresh', 'middle'],
  )

  const many = Array.from({ length: 105 }, (_, i) => makeRun(`r${i}`, 'ws1', now - i))
  const pruned = pruneDistillRuns(many, { now })
  assert.equal(pruned.length, DISTILL_RETENTION.runs.maxCount)
  assert.ok(pruned.some(run => run.id === 'r0'))
  assert.ok(!pruned.some(run => run.id === 'r104'))

  const legacy = { id: 'legacy', workspaceId: 'ws1', status: 'ready' }
  assert.deepEqual(pruneDistillRuns([legacy], { now }).map(run => run.id), ['legacy'])
  assert.deepEqual(pruneDistillRuns(null), [])
  assert.deepEqual(pruneDistillRuns([null, undefined]), [])
})

test('pruneDistillFingerprints enforces 365 days / 5000 records', () => {
  const now = 1_700_000_000_000
  const fingerprints = [
    makeFingerprint('old', 'ws1', now - 366 * DAY),
    makeFingerprint('fresh', 'ws1', now - 1 * DAY),
  ]
  assert.deepEqual(
    pruneDistillFingerprints(fingerprints, { now }).map(fp => fp.id),
    ['fresh'],
  )

  const many = Array.from({ length: 5003 }, (_, i) => makeFingerprint(`f${i}`, 'ws1', now - i))
  const pruned = pruneDistillFingerprints(many, { now })
  assert.equal(pruned.length, DISTILL_RETENTION.fingerprints.maxCount)
  assert.ok(pruned.some(fp => fp.id === 'f0'))
  assert.ok(!pruned.some(fp => fp.id === 'f5002'))
})

test('bucket key helpers are canonical', () => {
  assert.equal(distillRunBucketKey('  /ws/a  '), 'ws:/ws/a')
  assert.equal(distillRunBucketKey(''), '')
  assert.equal(distillPlanKeyFor(' run-1 '), 'run:run-1')
  assert.equal(distillPlanKeyFor(null), '')
})

test('host store persists the three buckets and verifies the write by re-reading disk', async (t) => {
  const dir = makeDir(t)
  const now = Date.now()
  const store = createHostDeskStore({ storageRoot: dir })
  const run = makeRun('r1', '/ws/a', now)
  await store.putDistillRun(run)
  await store.putDistillPlan({ runId: 'r1', workspaceId: '/ws/a', summary: 'plan summary', changes: [] })
  await store.putDistillFingerprints('/ws/a', [makeFingerprint('f1', '/ws/a', now)])

  // Independent instance reads the same file (real disk read-back).
  const reader = createHostDeskStore({ storageRoot: dir })
  assert.equal((await reader.getDistillRun('r1'))?.id, 'r1')
  assert.equal((await reader.getDistillPlan('r1'))?.summary, 'plan summary')
  assert.deepEqual((await reader.listDistillFingerprints('/ws/a')).map(fp => fp.id), ['f1'])

  // The file on disk really carries the new buckets + bumped schema version.
  const raw = JSON.parse(fs.readFileSync(reader.filePath, 'utf8'))
  assert.equal(raw.version, HOST_STATE_VERSION)
  assert.equal(raw.distillRuns['ws:/ws/a'][0].id, 'r1')
  assert.equal(raw.distillPlans['run:r1'].summary, 'plan summary')
  assert.equal(raw.distillFingerprints['ws:/ws/a'][0].id, 'f1')
})

test('host store enforces run retention and drops plans for pruned runs', async (t) => {
  const dir = makeDir(t)
  const now = Date.now()
  const store = createHostDeskStore({ storageRoot: dir, now: () => now })
  for (let i = 0; i < 101; i += 1) {
    await store.putDistillRun(makeRun(`run-${i}`, '/ws/a', now - i * 1000))
  }
  await store.putDistillPlan({ runId: 'run-100', workspaceId: '/ws/a', summary: 'stale plan' })
  await store.putDistillRun(makeRun('run-newest', '/ws/a', now + 1000))

  const runs = await store.listDistillRuns('/ws/a')
  assert.equal(runs.length, DISTILL_RETENTION.runs.maxCount)
  assert.ok(runs.some(run => run.id === 'run-newest'))
  assert.ok(!runs.some(run => run.id === 'run-100'))
  assert.equal(await store.getDistillPlan('run-100'), null, 'plan follows its pruned run')
})

test('host store enforces fingerprint retention on write', async (t) => {
  const dir = makeDir(t)
  const now = Date.now()
  const store = createHostDeskStore({ storageRoot: dir, now: () => now })
  const expired = makeFingerprint('expired', '/ws/a', now - 400 * DAY)
  const fresh = Array.from({ length: 5001 }, (_, i) => makeFingerprint(`f${i}`, '/ws/a', now - i))
  await store.putDistillFingerprints('/ws/a', [expired, ...fresh])

  const listed = await store.listDistillFingerprints('/ws/a')
  assert.equal(listed.length, DISTILL_RETENTION.fingerprints.maxCount)
  assert.ok(!listed.some(fp => fp.id === 'expired'))
})

test('host store prunes runs/fingerprints/plans via pruneDistillData (lazy recovery point)', async (t) => {
  const dir = makeDir(t)
  const now = Date.now()
  // Seed the file directly: writes already prune, so only a raw file can hold
  // the expired rows that lazy recovery is responsible for.
  fs.writeFileSync(path.join(dir, 'punch_desk.json'), JSON.stringify({
    version: HOST_STATE_VERSION,
    workspaceRecords: [],
    workspaces: [],
    groups: {},
    entries: {},
    promptLogs: {},
    commitTraces: {},
    distillRuns: {
      'ws:/ws/a': [makeRun('keep', '/ws/a', now)],
      'ws:/ws/b': [makeRun('expire', '/ws/b', now - 120 * DAY)],
    },
    distillPlans: { 'run:expire': { runId: 'expire', workspaceId: '/ws/b', summary: 'orphan' } },
    distillFingerprints: { 'ws:/ws/b': [makeFingerprint('old-fp', '/ws/b', now - 400 * DAY)] },
    handoffs: {},
    prefs: {},
  }), 'utf8')
  const store = createHostDeskStore({ storageRoot: dir, now: () => now })

  const counts = await store.pruneDistillData()
  assert.deepEqual(counts, { runs: 1, plans: 1, fingerprints: 1 })
  assert.equal((await store.getDistillRun('keep'))?.id, 'keep')
  assert.equal(await store.getDistillRun('expire'), null)
  assert.deepEqual(await store.listDistillFingerprints('/ws/b'), [])
  assert.equal(await store.getDistillPlan('expire'), null)
})

test('exportDump / importDump carry the three buckets in merge and replace modes', async (t) => {
  const sourceDir = makeDir(t, 'pd-distill-src-')
  const now = Date.now()
  const source = createHostDeskStore({ storageRoot: sourceDir })
  await source.putDistillRun(makeRun('r1', '/ws/a', now))
  await source.putDistillPlan({ runId: 'r1', workspaceId: '/ws/a', summary: 's1', changes: [] })
  await source.putDistillFingerprints('/ws/a', [makeFingerprint('f1', '/ws/a', now)])
  const dump = await source.exportDump()
  assert.ok(dump.distillRuns && dump.distillPlans && dump.distillFingerprints)

  const targetDir = makeDir(t, 'pd-distill-dst-')
  const target = createHostDeskStore({ storageRoot: targetDir })
  const merged = await target.importDump(dump, { mode: 'merge' })
  assert.equal(merged.ok, true)
  assert.equal(merged.counts.distillRuns, 1)
  assert.equal(merged.counts.distillPlans, 1)
  assert.equal(merged.counts.distillFingerprints, 1)
  assert.equal((await target.getDistillRun('r1'))?.id, 'r1')
  assert.equal((await target.getDistillPlan('r1'))?.summary, 's1')

  // Replace clears rows missing from the dump.
  const replaced = await target.importDump({ distillRuns: { 'ws:/ws/b': [makeRun('r2', '/ws/b', now)] } }, { mode: 'replace' })
  assert.equal(replaced.ok, true)
  assert.equal(await target.getDistillRun('r1'), null)
  assert.equal((await target.getDistillRun('r2'))?.id, 'r2')
  assert.equal(await target.getDistillPlan('r1'), null)
  assert.deepEqual(await target.listDistillFingerprints('/ws/a'), [])
})

test('clearWorkspaceData clears targeted distillation rows and preserves other workspaces', async (t) => {
  const dir = makeDir(t)
  const now = Date.now()
  const store = createHostDeskStore({ storageRoot: dir })
  await store.putDistillRun(makeRun('a1', '/ws/a', now))
  await store.putDistillRun(makeRun('b1', '/ws/b', now))
  await store.putDistillPlan({ runId: 'a1', workspaceId: '/ws/a', summary: 'a' })
  await store.putDistillPlan({ runId: 'b1', workspaceId: '/ws/b', summary: 'b' })
  await store.putDistillFingerprints('/ws/a', [makeFingerprint('fa', '/ws/a', now, 'a1')])
  await store.putDistillFingerprints('/ws/b', [makeFingerprint('fb', '/ws/b', now, 'b1')])

  await store.clearWorkspaceData('/ws/a')
  assert.deepEqual(await store.listDistillRuns('/ws/a'), [])
  assert.equal(await store.getDistillPlan('a1'), null)
  assert.deepEqual(await store.listDistillFingerprints('/ws/a'), [])
  assert.equal((await store.getDistillRun('b1'))?.id, 'b1')
  assert.equal((await store.getDistillPlan('b1'))?.summary, 'b')

  // Opt-out flags keep rows.
  await store.clearWorkspaceData('/ws/b', { clearDistillRuns: false, clearDistillFingerprints: false })
  assert.equal((await store.getDistillRun('b1'))?.id, 'b1')
  assert.equal((await store.listDistillFingerprints('/ws/b')).length, 1)
})

test('schema version bump: v2 upgrades on write and future versions become read-only', async (t) => {
  const dir = makeDir(t)
  const filePath = path.join(dir, 'punch_desk.json')
  fs.writeFileSync(filePath, JSON.stringify({
    version: 2,
    entries: { 'session:s1': [{ id: 'e1', workspaceKey: 'session:s1', text: 'legacy' }] },
  }), 'utf8')

  const store = createHostDeskStore({ storageRoot: dir })
  assert.equal((await store.getStateVersionInfo()).version, HOST_STATE_VERSION)
  assert.deepEqual((await store.listEntries('session:s1')).map(item => item.id), ['e1'])
  await store.putDistillRun(makeRun('r-upgrade', '/ws/a', Date.now()))
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).version, HOST_STATE_VERSION)

  const futureDir = makeDir(t, 'pd-distill-future-')
  const futurePath = path.join(futureDir, 'punch_desk.json')
  fs.writeFileSync(futurePath, JSON.stringify({
    version: HOST_STATE_VERSION + 1,
    entries: {},
    distillRuns: { 'ws:/ws/a': [makeRun('future-run', '/ws/a', Date.now())] },
  }), 'utf8')
  const futureStore = createHostDeskStore({ storageRoot: futureDir })
  assert.deepEqual(await futureStore.getStateVersionInfo(), { version: HOST_STATE_VERSION + 1, readOnly: true })
  assert.equal((await futureStore.getDistillRun('future-run'))?.id, 'future-run', 'future rows stay readable')
  await assert.rejects(
    () => futureStore.putDistillRun(makeRun('r-new', '/ws/a', Date.now())),
    /read-only|not persisted/,
  )
  assert.equal(JSON.parse(fs.readFileSync(futurePath, 'utf8')).version, HOST_STATE_VERSION + 1, 'no downgrade write')
})

test('putDistillRun fails loudly when the read-back no longer contains the row', async (t) => {
  const dir = makeDir(t)
  const writableFs = { ...fs }
  const store = createHostDeskStore({
    storageRoot: dir,
    fs: {
      ...writableFs,
      // Simulate a partially-persisted state: the write succeeds but silently
      // drops the distillRuns bucket (the exact failure the read-back guard exists for).
      writeFileSync: (filePath, data, ...rest) => {
        try {
          const parsed = JSON.parse(data)
          if (parsed && typeof parsed === 'object' && 'distillRuns' in parsed) delete parsed.distillRuns
          return writableFs.writeFileSync(filePath, JSON.stringify(parsed), ...rest)
        } catch {
          return writableFs.writeFileSync(filePath, data, ...rest)
        }
      },
    },
  })
  await assert.rejects(() => store.putDistillRun(makeRun('r-lost', '/ws/a', Date.now())), /read-back|not persisted/)
})

test('verifyStateContainsDump verifies distillation rows and follows plans', () => {
  const now = Date.now()
  const run = makeRun('r1', '/ws/a', now)
  const plan = { runId: 'r1', workspaceId: '/ws/a', summary: 'x' }
  const fingerprint = makeFingerprint('f1', '/ws/a', now)
  const state = {
    distillRuns: { 'ws:/ws/a': [run] },
    distillPlans: { 'run:r1': plan },
    distillFingerprints: { 'ws:/ws/a': [fingerprint] },
  }
  assert.equal(verifyStateContainsDump(state, {
    distillRuns: { 'ws:/ws/a': [run] },
    distillPlans: { 'run:r1': plan },
    distillFingerprints: { 'ws:/ws/a': [fingerprint] },
  }, { now }), true)

  assert.equal(verifyStateContainsDump(state, {
    distillRuns: { 'ws:/ws/a': [makeRun('missing', '/ws/a', now)] },
  }, { now }), false)
  assert.equal(verifyStateContainsDump(state, {
    distillFingerprints: { 'ws:/ws/a': [makeFingerprint('missing-fp', '/ws/a', now)] },
  }, { now }), false)
  assert.equal(verifyStateContainsDump(state, {
    distillPlans: { 'run:r1': { runId: 'r1', summary: 'different' } },
  }, { now }), true)

  // A plan whose run was retention-pruned is not expected back.
  const expiredRun = makeRun('r-old', '/ws/a', now - 400 * DAY)
  assert.equal(verifyStateContainsDump(
    { distillRuns: {}, distillPlans: {} },
    { distillRuns: { 'ws:/ws/a': [expiredRun] }, distillPlans: { 'run:r-old': { runId: 'r-old' } } },
    { now },
  ), true)
})

test('store dump/import RPC carries distillation buckets', async (t) => {
  const dir = makeDir(t, 'pd-distill-rpc-')
  const now = Date.now()
  const hostStore = createHostDeskStore({ storageRoot: dir })
  await hostStore.putDistillRun(makeRun('r1', '/ws/a', now))
  await hostStore.putDistillFingerprints('/ws/a', [makeFingerprint('f1', '/ws/a', now)])

  const dumpRes = await handleStoreRpc({ action: 'dump' }, { hostStore })
  assert.equal(dumpRes.ok, true)
  assert.equal(dumpRes.state.distillRuns['ws:/ws/a'][0].id, 'r1')
  assert.equal(dumpRes.state.distillFingerprints['ws:/ws/a'][0].id, 'f1')

  const targetDir = makeDir(t, 'pd-distill-rpc-dst-')
  const target = createHostDeskStore({ storageRoot: targetDir })
  const importRes = await handleStoreRpc({ action: 'import', dump: dumpRes.state, mode: 'merge' }, { hostStore: target })
  assert.equal(importRes.ok, true)
  assert.equal((await target.getDistillRun('r1'))?.id, 'r1')
})

test('client store hydrates, exports and clears distillation buckets', async (t) => {
  const dir = makeDir(t, 'pd-distill-client-')
  const now = Date.now()
  const hostStore = createHostDeskStore({ storageRoot: dir })
  await hostStore.putDistillRun(makeRun('r1', '/ws/a', now))
  await hostStore.putDistillPlan({ runId: 'r1', workspaceId: '/ws/a', summary: 'client plan' })
  await hostStore.putDistillFingerprints('/ws/a', [makeFingerprint('f1', '/ws/a', now)])

  const client = createDeskStore({ hostStore, autoHydrate: true })
  await client.hydrate()
  assert.equal((await client.getDistillRun('r1'))?.id, 'r1')
  assert.equal((await client.getDistillPlan('r1'))?.summary, 'client plan')
  assert.deepEqual((await client.listDistillFingerprints('/ws/a')).map(fp => fp.id), ['f1'])
  assert.deepEqual((await client.listDistillRuns('/ws/a')).map(run => run.id), ['r1'])

  const dump = await client.exportDump()
  assert.ok(dump.distillRuns['ws:/ws/a'])
  assert.ok(dump.distillPlans['run:r1'])
  assert.ok(dump.distillFingerprints['ws:/ws/a'])

  await client.clearWorkspaceData('/ws/a')
  assert.equal(await client.getDistillRun('r1'), null)
  assert.equal(await client.getDistillPlan('r1'), null)
  assert.deepEqual(await client.listDistillFingerprints('/ws/a'), [])
  // Clear is forwarded to the Host store as well.
  assert.equal((await hostStore.getDistillRun('r1')), null)
  assert.deepEqual(await hostStore.listDistillFingerprints('/ws/a'), [])
})
