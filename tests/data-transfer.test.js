
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHostDeskStore } from '../src/store/host.js'
import { createLocalDeskStore } from '../src/store/local.js'
import { handleStoreRpc } from '../index.js'

function tempStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-import-'))
  return path.join(dir, 'punch_desk.json')
}

function entry(id, over = {}) {
  return {
    id,
    sessionId: 's-1',
    workspaceKey: 'session:s-1',
    text: 'finding ' + id,
    status: 'open',
    submissionStatus: 'unsubmitted',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

test('merge import upserts by id and keeps the newest row', async () => {
  const store = createHostDeskStore({ storageFilePath: tempStorage() })
  await store.importDump({ entries: { 'session:s-1': [entry('e1', { text: 'old', updatedAt: 1 })] } })
  const result = await store.importDump({
    entries: {
      'session:s-1': [
        entry('e1', { text: 'new', updatedAt: 5 }),
        entry('e2', { updatedAt: 2 }),
      ],
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'merge')
  assert.equal(result.verified, true)
  assert.equal(result.counts.entries, 2)
  assert.equal(result.backupPath, undefined, 'merge must not create a backup')

  const list = await store.listEntries('session:s-1')
  const byId = new Map(list.map(item => [item.id, item]))
  assert.equal(byId.get('e1').text, 'new', 'newer updatedAt wins')
  assert.ok(byId.has('e2'))
})

test('replace import backs up the old file first and drops rows outside the dump', async () => {
  const filePath = tempStorage()
  const store = createHostDeskStore({ storageFilePath: filePath })
  await store.importDump({ entries: { 'session:s-1': [entry('old-row')] } })

  const result = await store.importDump(
    { entries: { 'session:s-2': [entry('new-row', { sessionId: 's-2', workspaceKey: 'session:s-2' })] } },
    { mode: 'replace' },
  )
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'replace')
  assert.equal(result.verified, true)
  assert.ok(result.backupPath, 'replace must report a backup path')
  assert.ok(fs.existsSync(result.backupPath), 'backup file must exist on disk')

  assert.deepEqual(await store.listEntries('session:s-1'), [], 'replace drops old rows')
  const fresh = await store.listEntries('session:s-2')
  assert.equal(fresh.length, 1)
  assert.equal(fresh[0].id, 'new-row')
})

test('store route exposes the import action with mode validation', async () => {
  const store = createHostDeskStore({ storageFilePath: tempStorage() })
  const ok = await handleStoreRpc({ action: 'import', dump: { entries: { 'session:s-1': [entry('r1')] } }, mode: 'merge' }, { hostStore: store })
  assert.equal(ok.ok, true)
  assert.equal(ok.mode, 'merge')
  assert.equal(ok.counts.entries, 1)

  const replace = await handleStoreRpc({ action: 'import', dump: { entries: {} }, mode: 'replace' }, { hostStore: store })
  assert.equal(replace.ok, true)
  assert.equal(replace.mode, 'replace')
  assert.ok(replace.backupPath, 'replace through the route must back up')

  const missing = await handleStoreRpc({ action: 'import' }, { hostStore: store })
  assert.equal(missing.ok, false)
  assert.equal(missing.status, 400)
})

test('client store delegates importDump to the host bridge and normalises the mode', async () => {
  const calls = []
  const hostStore = {
    importDump: async (dump, options) => {
      calls.push({ dump, options })
      return { ok: true, mode: options.mode, counts: { entries: 1 } }
    },
  }
  const client = createLocalDeskStore({ hostStore, autoHydrate: false })
  const merged = await client.importDump({ entries: {} }, 'merge')
  assert.equal(merged.ok, true)
  assert.equal(calls[0].options.mode, 'merge')

  const unknown = await client.importDump({ entries: {} }, 'bogus')
  assert.equal(unknown.mode, 'merge', 'unknown modes must fall back to merge')

  const replaced = await client.importDump({ entries: {} }, 'replace')
  assert.equal(replaced.mode, 'replace')
})
