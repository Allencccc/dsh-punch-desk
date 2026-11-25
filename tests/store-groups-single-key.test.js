import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHostDeskStore, groupsKeyFor } from '../src/store/host.js'
import { createLocalDeskStore } from '../src/store/local.js'

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'punch-groups-single-key-'))
}

function baseGroup(overrides = {}) {
  return {
    id: 'g-1',
    groupNumber: 1,
    sessionId: 's-1',
    workspaceId: 'ws-1',
    startTurn: 0,
    items: [{ findingId: 'f-1', order: 0 }],
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  }
}

function stateWithGroups(groups) {
  return {
    version: 2,
    workspaceRecords: [],
    workspaces: [],
    groups,
    entries: {},
    promptLogs: {},
    handoffs: {},
    prefs: {},
  }
}

/** A persisted finding row, defaulting to session `s-1`. */
function finding(id, overrides = {}) {
  return {
    id,
    kind: 'finding',
    sessionId: 's-1',
    workspaceKey: 'session:s-1',
    workspaceId: 'ws-1',
    text: `finding ${id}`,
    body: `finding ${id}`,
    tag: 'optimize',
    status: 'open',
    submissionStatus: 'unsubmitted',
    reviewStatus: 'pending',
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  }
}

function writeStateFile(filePath, state) {
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8')
}

function readStateFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function backupFiles(dir) {
  return fs.readdirSync(dir)
    .filter(name => name.startsWith('punch_desk.json.bak-'))
    .sort()
}

function baseFs(overrides = {}) {
  return {
    existsSync: fs.existsSync,
    readFileSync: fs.readFileSync,
    writeFileSync: fs.writeFileSync,
    mkdirSync: fs.mkdirSync,
    copyFileSync: fs.copyFileSync,
    renameSync: fs.renameSync,
    ...overrides,
  }
}

/** Simulate a storage directory that refuses the final atomic rename. */
function createWriteBlockedFs(filePath) {
  return baseFs({
    renameSync(from, to) {
      if (to === filePath) throw new Error('simulated read-only storage')
      return fs.renameSync(from, to)
    },
  })
}

/** Simulate a corrupted first read-back after the atomic write completed. */
function createTamperingReadBackFs(filePath, tamperedState) {
  let armed = false
  let served = false
  return baseFs({
    readFileSync(target, ...args) {
      if (target === filePath && armed && !served) {
        armed = false
        served = true
        return JSON.stringify(tamperedState)
      }
      return fs.readFileSync(target, ...args)
    },
    renameSync(from, to) {
      fs.renameSync(from, to)
      if (to === filePath) armed = true
    },
  })
}

test('groupsKeyFor normalizes every session identifier variant to one key', () => {
  assert.equal(groupsKeyFor('session-abc'), 'session-abc')
  assert.equal(groupsKeyFor('session:session-abc'), 'session-abc')
  assert.equal(groupsKeyFor('  session:abc  '), 'abc')
  assert.equal(groupsKeyFor(''), '')
  assert.equal(groupsKeyFor(null), '')
  assert.equal(groupsKeyFor(undefined), '')
})

test('putGroup and putGroups persist exactly one canonical groups key', async () => {
  const dir = makeTempDir()
  const filePath = path.join(dir, 'punch_desk.json')
  try {
    const store = createHostDeskStore({ storageFilePath: filePath })
    // putGroup now enforces invariant I2 (Phase 4 / B6), so the referenced
    // finding must already exist in the session bucket.
    await store.putEntry(finding('f-1'))

    await store.putGroup(baseGroup())
    await store.putGroup(baseGroup({ id: 'g-2', groupNumber: 2 }))

    const dump = await store.exportDump()
    assert.deepEqual(Object.keys(dump.groups), ['s-1'])
    assert.equal(dump.groups['s-1'].length, 2)
    assert.deepEqual(Object.keys(readStateFile(filePath).groups), ['s-1'])

    // A prefixed caller spelling must still land on the same canonical key.
    await store.putGroups('session:s-1', [
      baseGroup(),
      baseGroup({ id: 'g-2', groupNumber: 2 }),
    ])
    const rewritten = await store.exportDump()
    assert.deepEqual(Object.keys(rewritten.groups), ['s-1'])
    assert.equal(rewritten.groups['s-1'].length, 2)

    // Empty putGroups clears the canonical key (no alias survives).
    await store.putGroups('s-1', [])
    const cleared = await store.exportDump()
    assert.deepEqual(Object.keys(cleared.groups), [])
    assert.deepEqual(await store.getGroups('s-1'), [])
    assert.deepEqual(Object.keys(readStateFile(filePath).groups), [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('host putGroup rejects orphan and foreign-session items, accepts a valid new write', async () => {
  const dir = makeTempDir()
  const filePath = path.join(dir, 'punch_desk.json')
  try {
    const store = createHostDeskStore({ storageFilePath: filePath })

    // Orphan: the group names a finding that was never persisted in the session.
    await assert.rejects(() => store.putGroup(baseGroup()), /finding not found: f-1/)
    assert.deepEqual(await store.getGroups('s-1'), [], 'a rejected group write must persist nothing')

    // Foreign session: the row sits in this session's bucket but claims another
    // session (corrupt/legacy data), so the relationship must be rejected too.
    await store.putEntry(finding('f-1', { sessionId: 's-2' }))
    await assert.rejects(() => store.putGroup(baseGroup()), /belongs to another session: f-1/)
    assert.deepEqual(await store.getGroups('s-1'), [])

    // Valid new write: persist the finding first (the submission order the
    // Session Pane now uses), then the group that names it.
    await store.putEntry(finding('f-1'))
    await store.putGroup(baseGroup())
    const groups = await store.getGroups('s-1')
    assert.equal(groups.length, 1)
    assert.deepEqual(groups[0].items, [{ findingId: 'f-1', order: 0 }])
    assert.equal(readStateFile(filePath).entries['session:s-1'].length, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a legacy group with orphan items stays readable; only new writes are strict', async () => {
  const dir = makeTempDir()
  const filePath = path.join(dir, 'punch_desk.json')
  const seed = stateWithGroups({ 's-1': [baseGroup()] })
  writeStateFile(filePath, seed)
  try {
    const store = createHostDeskStore({ storageFilePath: filePath })
    // Read compatibility: no findings index on the read path.
    const groups = await store.getGroups('s-1')
    assert.equal(groups.length, 1)
    assert.deepEqual(groups[0].items, [{ findingId: 'f-1', order: 0 }])
    // Migration/import normalization also ignores the index (no findings to check).
    const first = await store.importDump({ groups: { 'session:s-1': [baseGroup({ title: 'legacy' })] } })
    assert.equal(first.ok, true)
    assert.equal(first.verified, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('local putGroup builds the session findings index and rejects invalid links', async () => {
  const store = createLocalDeskStore({ autoHydrate: false })

  // Orphan: no finding in the session bucket yet.
  await assert.rejects(() => store.putGroup(baseGroup()), /finding not found: f-1/)
  assert.deepEqual(await store.getGroups('s-1'), [])

  // Foreign session: the indexed row belongs to another session.
  await store.putEntry(finding('f-1', { sessionId: 's-2' }))
  await assert.rejects(() => store.putGroup(baseGroup()), /belongs to another session: f-1/)
  assert.deepEqual(await store.getGroups('s-1'), [])

  // Valid: persist the referenced finding first, then the group.
  await store.putEntry(finding('f-1'))
  await store.putGroup(baseGroup())
  const groups = await store.getGroups('s-1')
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].items, [{ findingId: 'f-1', order: 0 }])
})

test('legacy multi-key group data is read once, deduped by id with field union', async () => {
  const dir = makeTempDir()
  const filePath = path.join(dir, 'punch_desk.json')
  const older = baseGroup({ title: 'older', updatedAt: 100, pinned: false, legacyFlag: true })
  const newer = baseGroup({ title: 'newer', updatedAt: 250, status: 'archived', freshFlag: 'kept' })
  const seed = stateWithGroups({ 's-1': [older], 'session:s-1': [newer] })
  writeStateFile(filePath, seed)

  try {
    // Block the migration write so getGroups has to use the read-only
    // compatibility merge itself.
    const store = createHostDeskStore({ storageFilePath: filePath, fs: createWriteBlockedFs(filePath) })

    const groups = await store.getGroups('s-1')
    assert.equal(groups.length, 1)
    assert.equal(groups[0].id, 'g-1')
    assert.equal(groups[0].title, 'newer')
    assert.equal(groups[0].status, 'archived')
    assert.equal(groups[0].pinned, false)
    assert.equal(groups[0].legacyFlag, true)
    assert.equal(groups[0].freshFlag, 'kept')
    assert.equal(groups[0].updatedAt, 250)

    const viaPrefixedId = await store.getGroups('session:s-1')
    assert.deepEqual(viaPrefixedId, groups)

    // The failed migration must not have rewritten (or lost) the legacy file.
    assert.deepEqual(readStateFile(filePath), seed)
    assert.equal(store.getGroupsMigrationStatus().status, 'failed')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('groups migration dedupes legacy keys, backs up the file and is idempotent', async () => {
  const dir = makeTempDir()
  const filePath = path.join(dir, 'punch_desk.json')
  const g1Older = baseGroup({ title: 'older', updatedAt: 100, pinned: false })
  const g1Newer = baseGroup({ title: 'newer', updatedAt: 250, status: 'archived' })
  const g2Older = baseGroup({ id: 'g-2', groupNumber: 2, title: 'b-old', updatedAt: 120, pinned: false })
  const g2Newer = baseGroup({ id: 'g-2', groupNumber: 2, title: 'b-new', updatedAt: 180, extra: 'kept' })
  const seed = stateWithGroups({
    's-1': [g1Older, g2Older],
    'session:s-1': [g1Newer, g2Newer],
  })
  writeStateFile(filePath, seed)

  try {
    const store1 = createHostDeskStore({ storageFilePath: filePath })
    const dump1 = await store1.exportDump()

    const status1 = store1.getGroupsMigrationStatus()
    assert.equal(status1.status, 'migrated')
    assert.equal(status1.keys, 1)
    assert.equal(status1.groups, 2)

    assert.deepEqual(Object.keys(dump1.groups), ['s-1'])
    assert.equal(dump1.groups['s-1'].length, 2)
    const migratedG1 = dump1.groups['s-1'].find(group => group.id === 'g-1')
    const migratedG2 = dump1.groups['s-1'].find(group => group.id === 'g-2')
    assert.equal(migratedG1.updatedAt, 250)
    assert.equal(migratedG1.title, 'newer')
    assert.equal(migratedG1.pinned, false)
    assert.equal(migratedG2.updatedAt, 180)
    assert.equal(migratedG2.title, 'b-new')
    assert.equal(migratedG2.extra, 'kept')

    const onDisk = readStateFile(filePath)
    assert.deepEqual(Object.keys(onDisk.groups), ['s-1'])
    assert.equal(onDisk.groups['s-1'].length, 2)

    const backups = backupFiles(dir)
    assert.equal(backups.length, 1)
    assert.deepEqual(readStateFile(path.join(dir, backups[0])), seed)

    // A second startup must see the already-normalized file and write nothing.
    const serializedAfterFirst = fs.readFileSync(filePath, 'utf8')
    const store2 = createHostDeskStore({ storageFilePath: filePath })
    const dump2 = await store2.exportDump()
    assert.deepEqual(dump2, dump1)
    assert.equal(store2.getGroupsMigrationStatus().status, 'skipped')
    assert.equal(fs.readFileSync(filePath, 'utf8'), serializedAfterFirst)
    assert.equal(backupFiles(dir).length, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('groups migration never overwrites an existing .bak backup', async () => {
  const dir = makeTempDir()
  const filePath = path.join(dir, 'punch_desk.json')
  const seed = stateWithGroups({
    's-1': [baseGroup()],
    'session:s-1': [baseGroup({ title: 'alias-copy' })],
  })
  writeStateFile(filePath, seed)

  const fixedNow = 1700000000000
  try {
    const existingBackup = path.join(dir, `punch_desk.json.bak-${fixedNow}`)
    fs.writeFileSync(existingBackup, 'sentinel-backup', 'utf8')

    const store = createHostDeskStore({ storageFilePath: filePath, now: () => fixedNow })
    await store.exportDump()

    assert.equal(fs.readFileSync(existingBackup, 'utf8'), 'sentinel-backup')
    const files = backupFiles(dir)
    const suffixed = files.find(name => name.startsWith(`punch_desk.json.bak-${fixedNow}-`))
    assert.ok(suffixed, 'a suffixed backup must be created when the timestamp name exists')
    assert.deepEqual(readStateFile(path.join(dir, suffixed)), seed)
    assert.equal(store.getGroupsMigrationStatus().backupPath, path.join(dir, suffixed))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('failed read-back verification keeps the old file and retries on the next startup', async () => {
  const dir = makeTempDir()
  const filePath = path.join(dir, 'punch_desk.json')
  const seed = stateWithGroups({
    's-1': [baseGroup({ title: 'older', updatedAt: 100 })],
    'session:s-1': [baseGroup({ title: 'newer', updatedAt: 250 })],
  })
  writeStateFile(filePath, seed)

  try {
    const store = createHostDeskStore({
      storageFilePath: filePath,
      fs: createTamperingReadBackFs(filePath, stateWithGroups({})),
    })

    await store.exportDump()

    const status = store.getGroupsMigrationStatus()
    assert.equal(status.status, 'failed')
    assert.equal(status.restored, true)
    assert.equal(typeof status.reason, 'string')

    // Old data is intact: the failed candidate was rolled back from the backup.
    assert.deepEqual(readStateFile(filePath), seed)
    assert.equal(backupFiles(dir).length, 1)
    assert.deepEqual(readStateFile(path.join(dir, backupFiles(dir)[0])), seed)

    // The failed instance must not retry within the same process; a fresh
    // startup (new store instance) retries and succeeds.
    const store2 = createHostDeskStore({ storageFilePath: filePath })
    const dump = await store2.exportDump()
    assert.equal(store2.getGroupsMigrationStatus().status, 'migrated')
    assert.deepEqual(Object.keys(dump.groups), ['s-1'])
    assert.equal(dump.groups['s-1'].length, 1)
    assert.equal(dump.groups['s-1'][0].title, 'newer')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('importDump writes imported groups to the canonical single key', async () => {
  const dir = makeTempDir()
  const filePath = path.join(dir, 'punch_desk.json')
  try {
    const store = createHostDeskStore({ storageFilePath: filePath })

    const first = await store.importDump({ groups: { 'session:s-1': [baseGroup()] } })
    assert.equal(first.ok, true)
    assert.equal(first.verified, true)

    const dump = await store.exportDump()
    assert.deepEqual(Object.keys(dump.groups), ['s-1'])
    assert.equal(dump.groups['s-1'].length, 1)
    assert.deepEqual(Object.keys(readStateFile(filePath).groups), ['s-1'])

    const second = await store.importDump({
      groups: { 'session:s-1': [baseGroup({ title: 'updated copy', groupNumber: 1 })] },
    })
    assert.equal(second.ok, true)
    const after = await store.exportDump()
    assert.deepEqual(Object.keys(after.groups), ['s-1'])
    assert.equal(after.groups['s-1'].length, 1)
    assert.equal(after.groups['s-1'][0].title, 'updated copy')
    assert.deepEqual(await store.getGroups('session:s-1'), after.groups['s-1'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
