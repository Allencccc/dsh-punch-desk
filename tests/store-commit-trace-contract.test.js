import test from 'node:test'
import assert from 'node:assert/strict'
import { createDeskStore } from '../src/store/local.js'

test('local deskStore forwards commit trace RPC through the existing fetch bridge', async () => {
  const calls = []
  const fetch = async (endpoint, init) => {
    calls.push({ endpoint, action: JSON.parse(init.body).action })
    return { ok: true, json: async () => ({ ok: true, value: [] }) }
  }
  const store = createDeskStore({ fetch, autoHydrate: false })
  await store.putCommitTraces('session:s1', [{ id: 'tr1' }])
  assert.equal(calls.at(-1).action, 'putCommitTraces')
  const list = await store.listCommitTraces('session:s1')
  assert.ok(Array.isArray(list))
})

test('local deskStore memory mirrors and notifies subscribers on putCommitTraces', async () => {
  let notified = 0
  const store = createDeskStore({ autoHydrate: false })
  store.subscribe(() => { notified++ })
  await store.putCommitTraces('session:s1', [{ id: 'tr1', status: 'complete', capturedAt: 100 }])
  assert.equal(notified, 1)
  const list = await store.listCommitTraces('session:s1')
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'tr1')

  // Normalization check: reading with 's1' returns the same traces as 'session:s1'
  const listByCleanId = await store.listCommitTraces('s1')
  assert.equal(listByCleanId.length, 1)
  assert.equal(listByCleanId[0].id, 'tr1')

  // exportDump includes commitTraces
  const dump = await store.exportDump()
  assert.ok(dump.commitTraces)
  assert.ok(dump.commitTraces['session:s1'])

  // clearWorkspaceData drops matching session commit traces
  await store.clearWorkspaceData('session:s1', { clearCommitTraces: true })
  const cleared = await store.listCommitTraces('session:s1')
  assert.equal(cleared.length, 0)
})

test('local deskStore in-memory lookupCommitTraces fallback finds matches by prefix', async () => {
  const store = createDeskStore({ autoHydrate: false })
  const hash = 'abcdef0123456789abcdef0123456789abcdef01'
  await store.putCommitTraces('session:s1', [{
    id: 'tr1',
    requestId: 'r1',
    sessionId: 's1',
    workspaceId: 'ws1',
    mode: 'sequential',
    turn: 1,
    groupIds: ['g1'],
    findingIds: ['f1'],
    commits: [{ hash, shortHash: hash.slice(0, 7), subject: 'fix: test', time: 100 }],
    status: 'complete',
    capturedAt: 100,
  }])

  const res = await store.lookupCommitTraces({ workspaceId: 'ws1', hash: 'abcdef0' })
  assert.equal(res.matches.length, 1)
  assert.equal(res.matches[0].traceId, 'tr1')
  assert.equal(res.matches[0].commit.shortHash, 'abcdef0')

  const none = await store.lookupCommitTraces({ workspaceId: 'ws1', hash: '9999999' })
  assert.deepEqual(none.matches, [])
})
