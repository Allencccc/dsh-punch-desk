import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHostDeskStore } from '../src/store/host.js'
import { handleCommitTraceLookup } from '../index.js'

test('lookupCommitTraces matches short prefixes, isolates workspace, caps 20 and ignores failed traces', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-lookup-test-'))
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const store = createHostDeskStore({ storageRoot: tmpDir, now: () => 100 })
  const hash = 'abcdef0123456789abcdef0123456789abcdef01'
  const mk = (id, workspaceId, status, capturedAt) => ({
    id, requestId: id, sessionId: 's1', workspaceId, mode: 'combined', turn: 1,
    groupIds: [], findingIds: ['f1'], commits: [{ hash, shortHash: hash.slice(0, 7), subject: 'x', time: 1 }],
    status, capturedAt, updatedAt: capturedAt,
  })

  await store.putCommitTraces('session:s1', [
    mk('t1', 'ws1', 'complete', 1),
    mk('t2', 'ws1', 'complete', 2),
    mk('t3', 'ws2', 'complete', 3),
    mk('t4', 'ws1', 'failed', 4),
  ])
  for (let i = 0; i < 25; i += 1) {
    await store.putCommitTraces(`session:s${i + 2}`, [mk(`t${i + 10}`, 'ws1', 'complete', i)])
  }

  const res = await store.lookupCommitTraces({ workspaceId: 'ws1', hash: 'abcdef0' })
  assert.equal(res.matches.length, 20)
  assert.equal(res.matches[0].traceId, 't34') // newest capturedAt among capped (i=24, capturedAt=24)
  assert.equal(res.matches[0].capturedAt, 24)
  assert.ok(res.matches.every(m => m.findingIds.includes('f1')))

  const capped = await store.lookupCommitTraces({ workspaceId: 'ws1', hash: 'abcdef0', limit: 500 })
  assert.equal(capped.matches.length, 20)

  const none = await store.lookupCommitTraces({ workspaceId: 'ws1', hash: 'fffffff' })
  assert.deepEqual(none.matches, [])

  // Case-insensitivity check (ABCDEF0 matches abcdef0)
  const upper = await store.lookupCommitTraces({ workspaceId: 'ws1', hash: 'ABCDEF0', limit: 5 })
  assert.equal(upper.matches.length, 5)
  assert.equal(upper.matches[0].commit.shortHash, 'abcdef0')
})

test('lookupCommitTraces validates workspaceId and hash', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-lookup-val-'))
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const store = createHostDeskStore({ storageRoot: tmpDir })

  await assert.rejects(
    () => store.lookupCommitTraces({ workspaceId: '', hash: 'abcdef0' }),
    /Missing or invalid workspaceId/
  )
  await assert.rejects(
    () => store.lookupCommitTraces({ workspaceId: 'ws1', hash: 'short' }),
    /Invalid hash: must be 7-40 hex characters/
  )
})

test('handleCommitTraceLookup validates inputs and calls store.lookupCommitTraces', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-lookup-test2-'))
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const store = createHostDeskStore({ storageRoot: tmpDir })

  // 400 on missing workspaceId
  const badWs = await handleCommitTraceLookup({ hash: 'abcdef0' }, { hostStore: store })
  assert.equal(badWs.ok, false)
  assert.equal(badWs.status, 400)

  // 400 on invalid hash
  const badHash = await handleCommitTraceLookup({ workspaceId: 'ws1', hash: '123' }, { hostStore: store })
  assert.equal(badHash.ok, false)
  assert.equal(badHash.status, 400)

  // 200 on valid lookup
  const ok = await handleCommitTraceLookup({ workspaceId: 'ws1', hash: 'abcdef0' }, { hostStore: store })
  assert.equal(ok.ok, true)
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.matches, [])
})
