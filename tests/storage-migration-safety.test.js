import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHostDeskStore } from '../src/store/host.js'
import { createDeskStore } from '../src/store/local.js'
import {
  dumpLocalStorage,
  listLegacyDataKeys,
  hasLegacyLocalStorageData,
  verifyStateContainsDump,
  migrateLocalStorageIfNeeded,
  isLocalStorageMigrated,
  MIGRATED_FLAG_KEY,
} from '../src/store/migrate.js'
import { PREFIX } from '../src/store/contract.js'

class MemoryStorage {
  constructor() {
    this.map = new Map()
  }
  get length() {
    return this.map.size
  }
  key(i) {
    return [...this.map.keys()][i] ?? null
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null
  }
  setItem(k, v) {
    this.map.set(k, String(v))
  }
  removeItem(k) {
    this.map.delete(k)
  }
}

function seededStorage() {
  const storage = new MemoryStorage()
  storage.setItem(`${PREFIX}entries.session%3As1`, JSON.stringify({
    version: 1,
    entries: [{ id: 'f-1', workspaceKey: 'session:s1', kind: 'finding', title: 'local finding', updatedAt: 10 }],
  }))
  storage.setItem(`${PREFIX}groups.s1`, JSON.stringify({
    version: 1,
    groups: [{
      id: 'g-1', sessionId: 's1', workspaceId: 'ws-1', groupNumber: 1, startTurn: 0, items: [], createdAt: 10,
    }],
  }))
  return storage
}

/** Fake browser fetch backed by a real Host store instance. */
function makeHostFetch(hostStore, overrides = {}) {
  return async (url, init = {}) => {
    const target = String(url)
    const body = init.body ? JSON.parse(init.body) : {}
    if (overrides.throwOnMigrate && target.includes('store-migrate')) {
      throw new Error('network down')
    }
    if (target.includes('store-migrate')) {
      const payload = overrides.migrateResponse ?? await hostStore.importDump(body.dump)
      return jsonRes(payload)
    }
    if (target.includes('punch-desk/store') && body.action === 'dump') {
      const payload = overrides.dumpResponse ?? { ok: true, status: 200, state: await hostStore.exportDump() }
      return jsonRes(payload)
    }
    return jsonRes({ ok: false, status: 404, error: 'not found' })
  }
}

function jsonRes(payload, ok = true) {
  return {
    ok,
    status: ok ? 200 : 400,
    async json() { return payload },
  }
}

test('failed HTTP migration keeps every legacy key and writes no migrated flag', async () => {
  const storage = seededStorage()
  const result = await migrateLocalStorageIfNeeded({
    storage,
    fetch: async () => { throw new Error('network down') },
  })

  assert.equal(result.ok, false)
  assert.equal(isLocalStorageMigrated(storage), false)
  assert.equal(hasLegacyLocalStorageData(storage), true)
  assert.equal(storage.getItem(`${PREFIX}entries.session%3As1`) !== null, true)
  assert.equal(storage.getItem(MIGRATED_FLAG_KEY), null)
})

test('a host that accepts the dump but cannot read it back never clears legacy data', async () => {
  const storage = seededStorage()
  const fetch = async (url, init = {}) => {
    const target = String(url)
    const body = init.body ? JSON.parse(init.body) : {}
    if (target.includes('store-migrate')) {
      return jsonRes({ ok: true, status: 200, verified: true, counts: { entries: 1 } })
    }
    if (target.includes('punch-desk/store') && body.action === 'dump') {
      return jsonRes({ ok: true, status: 200, state: { entries: {}, promptLogs: {}, groups: {}, workspaceRecords: [], handoffs: {} } })
    }
    return jsonRes({ ok: false, status: 404, error: 'not found' }, false)
  }
  const result = await migrateLocalStorageIfNeeded({ storage, fetch })
  assert.equal(result.ok, false)
  assert.match(result.error, /read-back|verified/i)
  assert.equal(hasLegacyLocalStorageData(storage), true)
  assert.equal(isLocalStorageMigrated(storage), false)
})

test('a stale migrated flag with surviving payload still retries and clears after a verified import', async () => {
  const storage = seededStorage()
  storage.setItem(MIGRATED_FLAG_KEY, String(Date.now()))
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'punch-stale-flag-'))
  const hostStore = createHostDeskStore({ storageFilePath: path.join(tmpDir, 'punch_desk.json') })
  try {
    assert.equal(hasLegacyLocalStorageData(storage), true)
    const result = await migrateLocalStorageIfNeeded({ storage, hostStore })
    assert.equal(result.ok, true)
    assert.equal(result.migrated, true)
    assert.equal(isLocalStorageMigrated(storage), true)
    assert.equal(storage.getItem(`${PREFIX}entries.session%3As1`), null)
    const imported = await hostStore.listEntries('session:s1')
    assert.equal(imported.length, 1)
    assert.equal(imported[0].title, 'local finding')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('HTTP migration clears legacy data only after a verified read-back', async () => {
  const storage = seededStorage()
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'punch-http-success-'))
  const hostStore = createHostDeskStore({ storageFilePath: path.join(tmpDir, 'punch_desk.json') })
  try {
    const result = await migrateLocalStorageIfNeeded({ storage, fetch: makeHostFetch(hostStore) })
    assert.equal(result.ok, true)
    assert.equal(result.migrated, true)
    assert.equal(hasLegacyLocalStorageData(storage), false)
    assert.equal(await hostStore.listEntries('session:s1').then(list => list.length), 1)
    assert.equal(await hostStore.getGroups('s1').then(list => list.length), 1)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dumpLocalStorage understands the store spellings promptlog. and workspace_records', () => {
  const storage = new MemoryStorage()
  storage.setItem(`${PREFIX}promptlog.${encodeURIComponent('session:s1')}`, JSON.stringify({
    entries: [{ messageId: 'm-1', time: 100, promptText: 'audit row' }],
  }))
  storage.setItem(`${PREFIX}workspace_records`, JSON.stringify([
    { id: 'ws-1', name: 'WS', path: '/tmp/ws', gitBranch: '', status: 'active', specSyncStatus: 'synced', createdAt: 1, updatedAt: 2 },
  ]))

  const dump = dumpLocalStorage(storage)
  assert.equal(dump.promptLogs['session:s1']?.length, 1)
  assert.equal(dump.promptLogs['session:s1'][0].messageId, 'm-1')
  assert.equal(dump.workspaceRecords.length, 1)
  assert.equal(dump.workspaceRecords[0].id, 'ws-1')
})

test('listLegacyDataKeys excludes the migration flag and hasLegacyLocalStorageData tracks payload', () => {
  const storage = new MemoryStorage()
  assert.equal(hasLegacyLocalStorageData(storage), false)
  storage.setItem(MIGRATED_FLAG_KEY, '1')
  assert.deepEqual(listLegacyDataKeys(storage), [])
  storage.setItem(`${PREFIX}prefs`, JSON.stringify({ submitMode: 'auto' }))
  assert.deepEqual(listLegacyDataKeys(storage), [`${PREFIX}prefs`])
  assert.equal(hasLegacyLocalStorageData(storage), true)
})

test('verifyStateContainsDump rejects missing entries, groups, records and handoffs', () => {
  const dump = {
    entries: { 'session:s1': [{ id: 'f-1' }] },
    promptLogs: { 'session:s1': [{ messageId: 'm-1', time: Date.now() }] },
    groups: { s1: [{ id: 'g-1' }] },
    workspaceRecords: [{ id: 'ws-1' }],
    handoffs: { s1: { draftId: 'd-1' } },
  }
  const goodState = {
    entries: { 'session:s1': [{ id: 'f-1' }] },
    promptLogs: { 'session:s1': [{ messageId: 'm-1' }] },
    groups: { s1: [{ id: 'g-1' }] },
    workspaceRecords: [{ id: 'ws-1' }],
    handoffs: { s1: { draftId: 'd-1' } },
  }
  assert.equal(verifyStateContainsDump(goodState, dump), true)
  assert.equal(verifyStateContainsDump({ ...goodState, entries: {} }, dump), false)
  assert.equal(verifyStateContainsDump({ ...goodState, groups: {} }, dump), false)
  assert.equal(verifyStateContainsDump({ ...goodState, workspaceRecords: [] }, dump), false)
  assert.equal(verifyStateContainsDump({ ...goodState, handoffs: {} }, dump), false)
  // Old prompt rows may be pruned by the Host retention window.
  const oldLogDump = { ...dump, promptLogs: { 'session:s1': [{ messageId: 'm-old', time: 1 }] } }
  assert.equal(verifyStateContainsDump({ ...goodState, promptLogs: {} }, oldLogDump), true)
})

test('importDump normalizes legacy workspace records instead of dropping them', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'punch-legacy-record-'))
  const hostStore = createHostDeskStore({ storageFilePath: path.join(tmpDir, 'punch_desk.json') })
  try {
    const result = await hostStore.importDump({
      workspaceRecords: [{ id: 'ws-legacy', name: 'Legacy', path: '/tmp/legacy' }],
    })
    assert.equal(result.ok, true)
    assert.equal(result.verified, true)
    assert.equal(result.counts.workspaceRecords, 1)
    const records = await hostStore.listWorkspaceRecords()
    assert.equal(records.length, 1)
    assert.equal(records[0].id, 'ws-legacy')
    assert.equal(records[0].status, 'active')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('client store attachLegacyStorage keeps local data readable while Host is unavailable', async () => {
  const storage = seededStorage()
  const store = createDeskStore({
    fetch: async () => { throw new Error('host offline') },
    autoHydrate: true,
  })
  try {
    assert.equal(await store.whenHydrated(), false)
    assert.deepEqual(await store.listEntries('session:s1'), [])
    assert.equal(store.attachLegacyStorage(storage), true)
    const entries = await store.listEntries('session:s1')
    assert.equal(entries.length, 1)
    assert.equal(entries[0].id, 'f-1')
    const groups = await store.getGroups('s1')
    assert.equal(groups.length, 1)
    assert.equal(store.detachLegacyStorage(), true)
    assert.deepEqual(await store.listEntries('session:s1'), [])
  } finally {
    store.dispose()
  }
})

test('invalid legacy group rows are normalized so migration can complete', async () => {
  const storage = new MemoryStorage()
  storage.setItem(`${PREFIX}groups.s1`, JSON.stringify({
    groups: [{ id: 'g-legacy', sessionId: 's1', workspaceId: 'ws-1', groupNumber: 1, items: [] }],
  }))
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'punch-group-normalize-'))
  const hostStore = createHostDeskStore({ storageFilePath: path.join(tmpDir, 'punch_desk.json') })
  try {
    const result = await migrateLocalStorageIfNeeded({ storage, hostStore })
    assert.equal(result.ok, true)
    assert.equal(result.migrated, true)
    assert.equal(hasLegacyLocalStorageData(storage), false)
    const groups = await hostStore.getGroups('s1')
    assert.equal(groups.length, 1)
    assert.equal(groups[0].id, 'g-legacy')
    assert.equal(groups[0].startTurn, 0)
    assert.equal(typeof groups[0].createdAt, 'number')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('unimportable legacy group rows keep the source data instead of claiming success', async () => {
  const storage = new MemoryStorage()
  storage.setItem(`${PREFIX}groups.s1`, JSON.stringify({
    groups: [{ id: 'g-bad', sessionId: 's1', items: [] }],
  }))
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'punch-bad-group-'))
  const hostStore = createHostDeskStore({ storageFilePath: path.join(tmpDir, 'punch_desk.json') })
  try {
    const result = await migrateLocalStorageIfNeeded({ storage, hostStore })
    assert.equal(result.ok, false)
    assert.equal(hasLegacyLocalStorageData(storage), true)
    assert.equal(isLocalStorageMigrated(storage), false)
    // The Host itself must not report a false success either.
    const raw = await hostStore.importDump({ groups: { s1: [{ id: 'g-bad', sessionId: 's1', items: [] }] } })
    assert.equal(raw.ok, false)
    assert.equal(raw.verified, false)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('verified migration purges only consumed keys and preserves unknown/unparseable leftovers', async () => {
  const storage = seededStorage()
  storage.setItem(`${PREFIX}entries.bad`, 'this is not json')
  storage.setItem(`${PREFIX}legacy-orphan`, JSON.stringify({ keep: true }))
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'punch-orphan-'))
  const hostStore = createHostDeskStore({ storageFilePath: path.join(tmpDir, 'punch_desk.json') })
  try {
    const result = await migrateLocalStorageIfNeeded({ storage, hostStore })
    assert.equal(result.ok, true)
    assert.equal(result.migrated, true)
    assert.equal(storage.getItem(`${PREFIX}entries.bad`), 'this is not json')
    assert.equal(storage.getItem(`${PREFIX}legacy-orphan`), JSON.stringify({ keep: true }))
    assert.equal(storage.getItem(`${PREFIX}entries.session%3As1`), null)
    assert.equal(storage.getItem(MIGRATED_FLAG_KEY) !== null, true)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('prefs-only legacy payloads still migrate instead of being treated as empty', async () => {
  const storage = new MemoryStorage()
  storage.setItem(`${PREFIX}prefs`, JSON.stringify({ submitMode: 'sequential' }))
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'punch-prefs-only-'))
  const hostStore = createHostDeskStore({ storageFilePath: path.join(tmpDir, 'punch_desk.json') })
  try {
    const result = await migrateLocalStorageIfNeeded({ storage, hostStore })
    assert.equal(result.ok, true)
    assert.equal(result.migrated, true)
    assert.equal(hasLegacyLocalStorageData(storage), false)
    const prefs = await hostStore.getPrefs()
    assert.equal(prefs.submitMode, 'sequential')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('workspace record timestamps stay stable across idempotent recovery imports', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'punch-record-idempotent-'))
  const hostStore = createHostDeskStore({ storageFilePath: path.join(tmpDir, 'punch_desk.json') })
  const dump = { workspaceRecords: [{ id: 'ws-legacy', name: 'Legacy', path: '/tmp/legacy' }] }
  try {
    const first = await hostStore.importDump(dump)
    assert.equal(first.ok, true)
    const [recordBefore] = await hostStore.listWorkspaceRecords()
    const second = await hostStore.importDump(dump)
    assert.equal(second.ok, true)
    const [recordAfter] = await hostStore.listWorkspaceRecords()
    assert.equal(recordAfter.createdAt, recordBefore.createdAt)
    assert.equal(recordAfter.updatedAt, recordBefore.updatedAt)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('legacy fallback mirrors writes back into localStorage while Host is unavailable', async () => {
  const storage = seededStorage()
  const store = createDeskStore({
    fetch: async () => { throw new Error('host offline') },
    autoHydrate: true,
  })
  try {
    await store.whenHydrated()
    store.attachLegacyStorage(storage)
    await store.putEntry({
      id: 'f-new',
      workspaceKey: 'session:s1',
      kind: 'finding',
      title: 'written while offline',
      updatedAt: Date.now(),
    })
    const raw = JSON.parse(storage.getItem(`${PREFIX}entries.session%3As1`))
    assert.equal(raw.entries.some(entry => entry.id === 'f-new'), true)
    const listed = await store.listEntries('session:s1')
    assert.equal(listed.some(entry => entry.id === 'f-new'), true)
  } finally {
    store.dispose()
  }
})
