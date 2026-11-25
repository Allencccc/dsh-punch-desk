import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  apply,
  sanitizePathSegment,
  resolveWorkspaceDir,
  handleStoreMigrate,
} from '../index.js'
import { createHostDeskStore } from '../src/store/host.js'
import {
  dumpLocalStorage,
  clearLegacyLocalStorage,
  isLocalStorageMigrated,
  migrateLocalStorageIfNeeded,
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
  clear() {
    this.map.clear()
  }
}

test('sanitizePathSegment prevents directory traversal and cleans invalid characters', () => {
  assert.equal(sanitizePathSegment(null), 'workspace')
  assert.equal(sanitizePathSegment(''), 'workspace')
  assert.equal(sanitizePathSegment('.'), 'workspace')
  assert.equal(sanitizePathSegment('..'), 'workspace')
  assert.equal(sanitizePathSegment('../../etc/passwd'), '.._.._etc_passwd')
  assert.equal(sanitizePathSegment('valid-name'), 'valid-name')
  assert.equal(sanitizePathSegment('project/sub'), 'project_sub')
})

test('resolveWorkspaceDir safely rejects path traversal and null bytes in workspaceId', async () => {
  const rejected1 = await resolveWorkspaceDir('../../etc/passwd')
  assert.equal(rejected1, null)

  const rejected2 = await resolveWorkspaceDir('valid\0bad')
  assert.equal(rejected2, null)

  const rejected3 = await resolveWorkspaceDir('../relative')
  assert.equal(rejected3, null)
})

test('createHostDeskStore creates backup and recovers safely from corrupted storage file', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'punch-corrupt-test-'))
  const filePath = path.join(tmpDir, 'punch_desk.json')

  try {
    // 1. Write corrupted JSON
    fs.writeFileSync(filePath, '{ invalid json: broken contents !!!', 'utf8')

    const store = createHostDeskStore({ storageFilePath: filePath })
    // 2. Reading entries should not throw, should return empty default state
    const entries = await store.listEntries('draft:global')
    assert.deepEqual(entries, [])

    // 3. A .corrupt backup file must have been created preserving the bad data
    const files = fs.readdirSync(tmpDir)
    const corruptBackup = files.find(f => f.startsWith('punch_desk.json.corrupt.'))
    assert.ok(corruptBackup, 'A .corrupt.<timestamp> backup file must exist')
    const corruptContent = fs.readFileSync(path.join(tmpDir, corruptBackup), 'utf8')
    assert.equal(corruptContent, '{ invalid json: broken contents !!!')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('dumpLocalStorage extracts complete dataset and clearLegacyLocalStorage cleans data keys', () => {
  const storage = new MemoryStorage()

  // Populate mock localStorage keys
  storage.setItem(`${PREFIX}entries.${encodeURIComponent('ws-1')}`, JSON.stringify([
    { id: 'f-1', title: 'Task 1', status: 'open', updatedAt: 100 },
  ]))
  storage.setItem(`${PREFIX}prompt-log.${encodeURIComponent('ws-1')}`, JSON.stringify([
    { messageId: 'msg-1', time: 100, promptText: 'hello' },
  ]))
  storage.setItem(`${PREFIX}groups.sess-1`, JSON.stringify([
    { id: 'grp-1', sessionId: 'sess-1', groupNumber: 1, title: 'Group 1' },
  ]))
  storage.setItem(`${PREFIX}workspace-records`, JSON.stringify([
    { id: 'ws-1', name: 'WS One', path: '/tmp/ws-1' },
  ]))
  storage.setItem(`${PREFIX}handoff.sess-1`, JSON.stringify({ draftId: 'd-1' }))
  storage.setItem(`${PREFIX}prefs`, JSON.stringify({ submitMode: 'sequential' }))

  assert.equal(isLocalStorageMigrated(storage), false)

  // 1. Dump
  const dump = dumpLocalStorage(storage)
  assert.equal(dump.entries['ws-1']?.length, 1)
  assert.equal(dump.promptLogs['ws-1']?.length, 1)
  assert.equal(dump.groups['sess-1']?.length, 1)
  assert.equal(dump.workspaceRecords.length, 1)
  assert.deepEqual(dump.handoffs['sess-1'], { draftId: 'd-1' })
  assert.equal(dump.prefs.submitMode, 'sequential')

  // 2. Clear
  clearLegacyLocalStorage(storage)
  assert.equal(isLocalStorageMigrated(storage), true)
  assert.equal(storage.getItem(`${PREFIX}entries.${encodeURIComponent('ws-1')}`), null)
  assert.equal(storage.getItem(`${PREFIX}groups.sess-1`), null)
  assert.ok(storage.getItem(MIGRATED_FLAG_KEY))
})

test('hostStore.importDump merges data atomically with conflict resolution and read-back verification', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'punch-import-test-'))
  const filePath = path.join(tmpDir, 'punch_desk.json')

  try {
    const store = createHostDeskStore({ storageFilePath: filePath })

    // Existing entry with older timestamp
    await store.putEntry({ id: 'f-1', workspaceKey: 'ws-1', title: 'Old Title', updatedAt: 50 })

    const futureTime = Date.now() + 10000
    const dump = {
      entries: {
        'ws-1': [
          { id: 'f-1', workspaceKey: 'ws-1', title: 'New Title', updatedAt: futureTime },
          { id: 'f-2', workspaceKey: 'ws-1', title: 'Second Finding', updatedAt: futureTime },
        ],
      },
      promptLogs: {
        'ws-1': [
          { messageId: 'm-1', time: Date.now(), promptText: 'Full prompt text' },
        ],
      },
      groups: {
        'sess-1': [
          {
            id: 'grp-1',
            sessionId: 'sess-1',
            workspaceId: 'ws-1',
            groupNumber: 1,
            startTurn: 0,
            items: [],
            createdAt: 100,
          },
        ],
      },
      workspaceRecords: [
        { id: 'ws-1', name: 'WS 1', path: '/path/ws1' },
      ],
      handoffs: {
        'sess-1': { draftId: 'd-1' },
      },
      prefs: {
        startSessionBehavior: 'auto',
      },
    }

    const result = await store.importDump(dump)
    assert.equal(result.ok, true)
    assert.equal(result.verified, true)
    assert.equal(result.counts.entries, 2)
    assert.equal(result.counts.promptLogs, 1)
    assert.equal(result.counts.groups, 1)

    // Verify disk persisted items
    const entries = await store.listEntries('ws-1')
    assert.equal(entries.length, 2)
    const f1 = entries.find(e => e.id === 'f-1')
    assert.equal(f1.title, 'New Title')

    const logs = await store.listPromptLog('ws-1')
    assert.equal(logs.length, 1)
    assert.equal(logs[0].promptText, 'Full prompt text')

    const groups = await store.getGroups('sess-1')
    assert.equal(groups.length, 1)
    assert.equal(groups[0].groupNumber, 1)

    const handoff = await store.getHandoff('sess-1')
    assert.deepEqual(handoff, { draftId: 'd-1' })

    const prefs = await store.getPrefs()
    assert.equal(prefs.startSessionBehavior, 'auto')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('migrateLocalStorageIfNeeded end-to-end via direct hostStore and route', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'punch-e2e-migrate-'))
  const filePath = path.join(tmpDir, 'punch_desk.json')

  try {
    const storage = new MemoryStorage()
    storage.setItem(`${PREFIX}entries.w1`, JSON.stringify([{ id: 'f-10', title: 'E2E Finding', updatedAt: 10 }]))

    const hostStore = createHostDeskStore({ storageFilePath: filePath })

    // Direct migration
    const res = await migrateLocalStorageIfNeeded({ storage, hostStore })
    assert.equal(res.ok, true)
    assert.equal(res.migrated, true)
    assert.equal(isLocalStorageMigrated(storage), true)

    // Verify imported
    const imported = await hostStore.listEntries('w1')
    assert.equal(imported.length, 1)
    assert.equal(imported[0].title, 'E2E Finding')

    // Second run should be skipped
    const secondRun = await migrateLocalStorageIfNeeded({ storage, hostStore })
    assert.equal(secondRun.ok, true)
    assert.equal(secondRun.skipped, true)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('Registered /api/punch-desk/store-migrate route receives POST dump and imports successfully', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'punch-route-migrate-'))
  const filePath = path.join(tmpDir, 'punch_desk.json')

  try {
    const hostStore = createHostDeskStore({ storageFilePath: filePath })
    const registeredRoutes = []
    const fakeCtx = {
      effect(execute) { return execute() },
      get() { return undefined },
      connection: {
        fetch: {
          register(route) {
            registeredRoutes.push(route)
            return () => {}
          },
        },
      },
    }

    const plugin = apply(fakeCtx, { hostStore })
    const route = registeredRoutes.find(r => r.path === '/api/punch-desk/store-migrate')
    assert.ok(route, 'store-migrate route must be registered')
    assert.deepEqual(route.methods, ['POST'])

    const dump = {
      entries: {
        'ws-net': [{ id: 'f-net', title: 'Network Finding', updatedAt: 1 }],
      },
    }

    const response = await route.fetch(
      new Request('http://localhost/api/punch-desk/store-migrate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dump }),
      }),
    )
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.verified, true)
    assert.equal(body.counts.entries, 1)

    // Bad JSON or missing dump returns 400
    const badRes = await route.fetch(
      new Request('http://localhost/api/punch-desk/store-migrate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    )
    assert.equal(badRes.status, 400)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('hostStore.clearWorkspaceData cleans workspace findings while preserving pinned groups and findings', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'punch-host-clear-'))
  const filePath = path.join(tmpDir, 'punch_desk.json')

  try {
    const store = createHostDeskStore({ storageFilePath: filePath })

    // Put findings first: putGroup enforces the group→finding link at write
    // time (plan Phase 4 / B6), so an item may only name an existing finding.
    await store.putEntry({ id: 'f-pinned', sessionId: 's-1', workspaceKey: 'session:s-1', assignedGroupId: 'grp-pinned', title: 'Pinned Task' })
    await store.putEntry({ id: 'f-unpinned', sessionId: 's-1', workspaceKey: 'session:s-1', assignedGroupId: 'grp-unpinned', title: 'Unpinned Task' })
    await store.putEntry({ id: 'f-draft', sessionId: 's-1', workspaceKey: 'session:s-1', title: 'Draft pool Task' })

    // Setup pinned and unpinned groups
    await store.putGroup({
      id: 'grp-pinned',
      sessionId: 's-1',
      workspaceId: 'ws-test',
      groupNumber: 1,
      startTurn: 0,
      pinned: true,
      items: [{ findingId: 'f-pinned', order: 0 }],
      createdAt: 100,
    })
    await store.putGroup({
      id: 'grp-unpinned',
      sessionId: 's-1',
      workspaceId: 'ws-test',
      groupNumber: 2,
      startTurn: 1,
      pinned: false,
      items: [{ findingId: 'f-unpinned', order: 0 }],
      createdAt: 200,
    })

    // Clear with preservePinned: true
    await store.clearWorkspaceData('ws-test', { preservePinned: true, sessionIds: ['s-1'] })

    // Verify pinned group remains, unpinned group removed
    const remainingGroups = await store.getGroups('s-1')
    assert.equal(remainingGroups.length, 1)
    assert.equal(remainingGroups[0].id, 'grp-pinned')
    assert.equal(remainingGroups[0].pinned, true)

    // Verify pinned finding remains, unpinned findings removed
    const remainingEntries = await store.listEntries('session:s-1')
    assert.equal(remainingEntries.length, 1)
    assert.equal(remainingEntries[0].id, 'f-pinned')
    assert.equal(remainingEntries[0].title, 'Pinned Task')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})


test('hostStore.clearWorkspaceData clears only the workspace-scoped drafts of that workspace', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'punch-host-clear-drafts-'))
  const filePath = path.join(tmpDir, 'punch_desk.json')

  try {
    const store = createHostDeskStore({ storageFilePath: filePath })
    await store.putEntry({
      id: 'd-global', kind: 'draft', workspaceKey: 'draft:global', title: 'Shared', visibility: 'global',
    })
    await store.putEntry({
      id: 'd-a', kind: 'draft', workspaceKey: 'draft:global', title: 'Alpha',
      visibility: 'workspace', workspaceId: 'ws-a',
    })
    await store.putEntry({
      id: 'd-b', kind: 'draft', workspaceKey: 'draft:global', title: 'Beta',
      visibility: 'workspace', workspaceId: 'ws-b',
    })

    await store.clearWorkspaceData('ws-a', { clearDrafts: true })

    const remaining = await store.listEntries('draft:global')
    assert.deepEqual(
      remaining.map(draft => draft.id).sort(),
      ['d-b', 'd-global'],
      'the global draft and the other workspace draft must survive',
    )
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('hostStore.clearWorkspaceData reconciles dangling group/finding references', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'punch-host-clear-reconcile-'))
  const filePath = path.join(tmpDir, 'punch_desk.json')

  try {
    const store = createHostDeskStore({ storageFilePath: filePath })
    const group = {
      id: 'grp-reconcile', sessionId: 's-host', workspaceId: 'ws-host', groupNumber: 1,
      startTurn: 0, pinned: false, items: [{ findingId: 'f-host-1', order: 0 }], createdAt: 100,
    }
    await store.putEntry({ id: 'f-host-1', sessionId: 's-host', workspaceKey: 'session:s-host', workspaceId: 'ws-host', assignedGroupId: 'grp-reconcile', title: 'Host finding' })
    await store.putGroup(group)

    await store.clearWorkspaceData('ws-host', {
      sessionIds: ['s-host'], clearGroups: true, clearFindings: false,
    })
    assert.equal((await store.getGroups('s-host')).length, 0)
    const [kept] = await store.listEntries('session:s-host')
    assert.ok(kept)
    assert.equal(kept.assignedGroupId, undefined, 'surviving finding must not reference a deleted group')

    await store.putEntry({ id: 'f-host-1', sessionId: 's-host', workspaceKey: 'session:s-host', workspaceId: 'ws-host', assignedGroupId: 'grp-reconcile', title: 'Host finding' })
    await store.putGroup(group)
    await store.clearWorkspaceData('ws-host', {
      sessionIds: ['s-host'], clearGroups: false, clearFindings: true,
    })
    const [remainingGroup] = await store.getGroups('s-host')
    assert.ok(remainingGroup)
    assert.deepEqual(remainingGroup.items, [], 'surviving group must not reference deleted findings')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
