import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHostDeskStore, pruneCommitTraces } from '../src/store/host.js'
import { handleStoreRpc } from '../index.js'
import { verifyStateContainsDump } from '../src/store/migrate.js'

const DAY = 24 * 3600 * 1000
const trace = (id, workspaceId, capturedAt, sessionId = 's1') => ({
  id,
  requestId: id.split('#')[0],
  sessionId,
  workspaceId,
  mode: 'sequential',
  turn: 1,
  groupIds: [],
  findingIds: [],
  commits: [],
  status: 'complete',
  capturedAt,
  updatedAt: capturedAt,
})

test('pruneCommitTraces enforces 30 days and 1000 items', () => {
  const now = 1_700_000_000_000
  const traces = [
    trace('r0#1', 'ws1', now - 31 * DAY),
    trace('r1#1', 'ws1', now - 10 * DAY),
    trace('r2#1', 'ws1', now - 1 * DAY),
  ]
  assert.deepEqual(pruneCommitTraces(traces, { now, maxCount: 1000, maxAgeMs: 30 * DAY }).map(t => t.id), ['r1#1', 'r2#1'])

  const many = Array.from({ length: 1005 }, (_, i) => trace(`r${i}#1`, 'ws1', now - i))
  assert.equal(pruneCommitTraces(many, { now, maxCount: 1000, maxAgeMs: 30 * DAY }).length, 1000)

  const legacy = { id: 'legacy#1', sessionId: 's1', status: 'complete', commits: [] }
  assert.deepEqual(pruneCommitTraces([legacy], { now, maxCount: 1000, maxAgeMs: 30 * DAY }).map(t => t.id), ['legacy#1'])
})

test('hostStore persists traces, imports, exports and clears unresolved traces', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-store-trace-test-'))
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const store = createHostDeskStore({ storageRoot: tmpDir })

  await store.putCommitTraces('session:s1', [trace('r2#1', 'ws1', Date.now()), trace('r1#1', 'ws1', Date.now())])
  assert.deepEqual((await store.listCommitTraces('session:s1')).map(t => t.turn), [1, 1])
  await store.putCommitTraces('session:s1', [trace('r1#1', 'ws1', Date.now())])
  assert.equal((await store.listCommitTraces('session:s1')).length, 2)

  // import merge / replace both carry commitTraces
  await store.importDump({ commitTraces: { 'session:s2': [trace('r2#1', 'ws1', Date.now())] } }, { mode: 'merge' })
  assert.equal((await store.listCommitTraces('session:s2')).length, 1)
  await store.importDump({ commitTraces: { 'session:s3': [trace('r3#1', 'ws1', Date.now())] } }, { mode: 'replace' })
  assert.equal((await store.listCommitTraces('session:s1')).length, 0)
  assert.equal((await store.listCommitTraces('session:s3')).length, 1)

  // workspace-unresolved trace (empty workspaceId) is cleared via sessionIds fallback
  await store.putCommitTraces('session:s4', [trace('r4#1', '', Date.now(), 's4')])
  await store.clearWorkspaceData('ws1', { sessionIds: ['s1', 's4'] })
  assert.equal((await store.listCommitTraces('session:s4')).length, 0)

  const dump = await store.exportDump()
  assert.ok(Object.prototype.hasOwnProperty.call(dump, 'commitTraces'))
})

test('handleStoreRpc dispatches listCommitTraces and putCommitTraces', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-rpc-trace-test-'))
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const hostStore = createHostDeskStore({ storageRoot: tmpDir })

  const putRes = await handleStoreRpc({
    action: 'putCommitTraces',
    sessionKey: 'session:s1',
    traces: [trace('r1#1', 'ws1', Date.now())],
  }, { hostStore })
  assert.equal(putRes.ok, true)

  const listRes = await handleStoreRpc({
    action: 'listCommitTraces',
    sessionKey: 'session:s1',
  }, { hostStore })
  assert.equal(listRes.ok, true)
  assert.equal(listRes.traces.length, 1)
  assert.equal(listRes.traces[0].id, 'r1#1')
})

test('verifyStateContainsDump verifies commitTraces rows', () => {
  const t1 = trace('t1', 'ws1', Date.now())
  const state = { commitTraces: { 'session:s1': [t1] } }
  assert.equal(verifyStateContainsDump(state, { commitTraces: { 'session:s1': [t1] } }), true)
  assert.equal(verifyStateContainsDump(state, { commitTraces: { 'session:s1': [trace('t2', 'ws1', Date.now())] } }), false)
})

test('pruneCommitTraces edge cases and fallback timestamps', () => {
  assert.deepEqual(pruneCommitTraces(null), [])
  assert.deepEqual(pruneCommitTraces([]), [])
  assert.deepEqual(pruneCommitTraces([null, undefined]), [])

  const now = 100_000
  const itemWithUpdatedAt = { id: 'u1', updatedAt: now }
  const itemWithTime = { id: 't1', time: now - 10 }
  const itemExpired = { id: 'e1', capturedAt: now - 35 * DAY }

  const res = pruneCommitTraces([itemWithUpdatedAt, itemWithTime, itemExpired], { now, maxAgeMs: 30 * DAY })
  assert.equal(res.length, 2)
  assert.deepEqual(res.map(i => i.id), ['u1', 't1'])
})

test('clearWorkspaceData preserves traces when clearCommitTraces is false', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-clear-opt-test-'))
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const store = createHostDeskStore({ storageRoot: tmpDir })

  await store.putCommitTraces('session:s1', [trace('r1#1', 'ws1', Date.now(), 's1')])
  await store.clearWorkspaceData('ws1', { clearCommitTraces: false })
  assert.equal((await store.listCommitTraces('session:s1')).length, 1)
})

test('handleStoreRpc validates required fields for commit trace actions', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-rpc-val-test-'))
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const hostStore = createHostDeskStore({ storageRoot: tmpDir })

  const listMissing = await handleStoreRpc({ action: 'listCommitTraces' }, { hostStore })
  assert.equal(listMissing.ok, false)
  assert.equal(listMissing.status, 400)

  const putMissing = await handleStoreRpc({ action: 'putCommitTraces', sessionKey: 'session:s1' }, { hostStore })
  assert.equal(putMissing.ok, false)
  assert.equal(putMissing.status, 400)
})
