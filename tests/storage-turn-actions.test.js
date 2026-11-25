import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HOST_STATE_VERSION } from '../src/store/contract.js'
import { createHostDeskStore } from '../src/store/host.js'
import { createLocalDeskStore } from '../src/store/local.js'
import { pruneTurnActionItems } from '../src/domain/turn-actions.js'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-turn-actions-test-'))
}

function makeActionItem(over = {}) {
  const id = over.id || `item-${Math.random().toString(36).slice(2)}`
  return {
    id,
    sessionId: 's-1',
    workspaceKey: 'session:s-1',
    turn: 1,
    source: 'prompt-tail',
    kind: 'confirm',
    confidence: 'high',
    title: 'Confirm item',
    body: 'Details of confirm',
    quote: 'Quote',
    evidenceSeq: 10,
    status: 'open',
    createdAt: 1000,
    ...over,
  }
}

test('v3 to v4 migration: loads v3 state and upgrades version to 4 with turnActions bucket', async () => {
  const tmp = tempDir()
  const filePath = path.join(tmp, 'punch_desk.json')
  fs.writeFileSync(filePath, JSON.stringify({
    version: 3,
    workspaceRecords: [],
    workspaces: ['session:s-legacy'],
    groups: {},
    entries: {
      'session:s-legacy': [{ id: 'f-1', kind: 'finding', text: 'finding 1' }],
    },
    promptLogs: {},
    commitTraces: {},
    distillRuns: {},
    distillPlans: {},
    distillFingerprints: {},
    handoffs: {},
    prefs: {},
  }), 'utf8')

  const store = createHostDeskStore({ storageFilePath: filePath })
  const stateVer = await store.getStateVersionInfo?.()
  assert.equal(stateVer?.version, HOST_STATE_VERSION)
  assert.equal(stateVer?.readOnly, false)

  // Trigger write to persist migrated version
  await store.putTurnActions('session:s-legacy', {
    version: 1,
    sessionId: 's-legacy',
    scannedThroughSeq: 5,
    scannedAt: 12345,
    items: [makeActionItem({ sessionId: 's-legacy', workspaceKey: 'session:s-legacy' })],
  })

  const diskState = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  assert.equal(diskState.version, 4)
  assert.ok(diskState.turnActions)
  assert.ok(diskState.turnActions['session:s-legacy'])
  assert.equal(diskState.turnActions['session:s-legacy'].scannedThroughSeq, 5)
  assert.equal(diskState.turnActions['session:s-legacy'].items.length, 1)
  assert.equal(diskState.entries['session:s-legacy'].length, 1)
})

test('future version guard: v5 file is guarded as read-only and never overwritten', async () => {
  const tmp = tempDir()
  const filePath = path.join(tmp, 'punch_desk.json')
  const futureState = {
    version: 5,
    workspaceRecords: [],
    workspaces: ['session:s-future'],
    groups: {},
    entries: {},
    promptLogs: {},
    commitTraces: {},
    distillRuns: {},
    distillPlans: {},
    distillFingerprints: {},
    turnActions: {
      'session:s-future': {
        version: 1,
        sessionId: 's-future',
        scannedThroughSeq: 100,
        scannedAt: 99999,
        items: [{ id: 'future-item' }],
      },
    },
    handoffs: {},
    prefs: {},
  }
  fs.writeFileSync(filePath, JSON.stringify(futureState), 'utf8')

  const store = createHostDeskStore({ storageFilePath: filePath })
  const stateVer = await store.getStateVersionInfo?.()
  assert.equal(stateVer?.version, 5)
  assert.equal(stateVer?.readOnly, true)

  // Attempt write
  await store.putTurnActions('session:s-future', {
    version: 1,
    sessionId: 's-future',
    scannedThroughSeq: 200,
    scannedAt: 100000,
    items: [],
  })

  // Verify file on disk was NOT overwritten or downgraded
  const diskState = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  assert.equal(diskState.version, 5)
  assert.equal(diskState.turnActions['session:s-future'].scannedThroughSeq, 100)
})

test('Host store listTurnActions, putTurnActions, deleteTurnActions with notifications', async () => {
  const tmp = tempDir()
  const filePath = path.join(tmp, 'punch_desk.json')
  const store = createHostDeskStore({ storageFilePath: filePath })

  let notified = 0
  const unsubscribe = store.subscribe(() => { notified++ })

  // List on empty session returns null
  const empty = await store.listTurnActions('session:s-test')
  assert.equal(empty, null)

  const item1 = makeActionItem({ id: 'item-1', sessionId: 's-test' })
  await store.putTurnActions('session:s-test', {
    version: 1,
    sessionId: 's-test',
    scannedThroughSeq: 42,
    scannedAt: 1000,
    items: [item1],
  })

  assert.ok(notified > 0)
  const stored = await store.listTurnActions('session:s-test')
  assert.equal(stored.sessionId, 's-test')
  assert.equal(stored.scannedThroughSeq, 42)
  assert.equal(stored.items.length, 1)
  assert.equal(stored.items[0].id, 'item-1')

  // Supports bare sessionId without 'session:' prefix
  const storedBare = await store.listTurnActions('s-test')
  assert.equal(storedBare.sessionId, 's-test')
  assert.equal(storedBare.items.length, 1)

  // Delete
  const prevNotified = notified
  await store.deleteTurnActions('session:s-test')
  assert.ok(notified > prevNotified)
  assert.equal(await store.listTurnActions('session:s-test'), null)

  unsubscribe()
})

test('Local store listTurnActions, putTurnActions, deleteTurnActions', async () => {
  const store = createLocalDeskStore()
  await store.whenHydrated()

  let notified = 0
  const unsubscribe = store.subscribe(() => { notified++ })

  assert.equal(await store.listTurnActions('s-local'), null)

  const item1 = makeActionItem({ id: 'local-1', sessionId: 's-local' })
  await store.putTurnActions('s-local', {
    version: 1,
    sessionId: 's-local',
    scannedThroughSeq: 10,
    scannedAt: 2000,
    items: [item1],
  })

  assert.ok(notified > 0)
  const stored = await store.listTurnActions('session:s-local')
  assert.equal(stored.sessionId, 's-local')
  assert.equal(stored.items.length, 1)
  assert.equal(stored.items[0].id, 'local-1')

  await store.deleteTurnActions('s-local')
  assert.equal(await store.listTurnActions('s-local'), null)

  unsubscribe()
})

test('500-item safe pruning: prioritizes closed items and never prunes open items', () => {
  // Case 1: 400 open + 200 closed = 600 items. Should prune 100 oldest closed, keeping 400 open + 100 newest closed = 500
  const openItems = []
  for (let i = 0; i < 400; i++) {
    openItems.push(makeActionItem({ id: `open-${i}`, status: 'open', createdAt: 1000 + i }))
  }
  const closedItems = []
  for (let i = 0; i < 200; i++) {
    closedItems.push(makeActionItem({
      id: `closed-${i}`,
      status: i % 2 === 0 ? 'converted' : 'dismissed',
      createdAt: 500 + i,
      decidedAt: 2000 + i,
    }))
  }

  const pruned1 = pruneTurnActionItems([...openItems, ...closedItems], 500)
  assert.equal(pruned1.length, 500)
  const openCount1 = pruned1.filter(it => it.status === 'open').length
  assert.equal(openCount1, 400, 'All 400 open items must be kept')
  const closedCount1 = pruned1.filter(it => it.status !== 'open').length
  assert.equal(closedCount1, 100, '100 newest closed items kept')

  // Case 2: 600 open items + 100 closed items = 700 items.
  // Rule: NEVER drop open items. Prunes all 100 closed items, retains all 600 open items!
  const manyOpen = []
  for (let i = 0; i < 600; i++) {
    manyOpen.push(makeActionItem({ id: `open-many-${i}`, status: 'open', createdAt: 1000 + i }))
  }
  const pruned2 = pruneTurnActionItems([...manyOpen, ...closedItems], 500)
  assert.equal(pruned2.length, 600, 'All 600 open items must be preserved even if > 500')
  assert.ok(pruned2.every(it => it.status === 'open'), 'Only open items remain')
})

test('exportDump and importDump: turnActions round-trip in merge and replace modes', async () => {
  const tmp = tempDir()
  const filePath = path.join(tmp, 'punch_desk.json')
  const store = createHostDeskStore({ storageFilePath: filePath })

  const itemA = makeActionItem({ id: 'item-a', sessionId: 's-dump', status: 'open', createdAt: 100 })
  await store.putTurnActions('session:s-dump', {
    version: 1,
    sessionId: 's-dump',
    scannedThroughSeq: 15,
    scannedAt: 1500,
    items: [itemA],
  })

  // Export
  const dump = await store.exportDump()
  assert.ok(dump.turnActions)
  assert.ok(dump.turnActions['session:s-dump'])
  assert.equal(dump.turnActions['session:s-dump'].items.length, 1)

  // Import in merge mode into another store
  const tmp2 = tempDir()
  const filePath2 = path.join(tmp2, 'punch_desk.json')
  const store2 = createHostDeskStore({ storageFilePath: filePath2 })

  const itemExisting = makeActionItem({ id: 'item-b', sessionId: 's-dump', status: 'open', createdAt: 200 })
  await store2.putTurnActions('session:s-dump', {
    version: 1,
    sessionId: 's-dump',
    scannedThroughSeq: 10,
    scannedAt: 1000,
    items: [itemExisting],
  })

  const importResult = await store2.importDump(dump, { mode: 'merge' })
  assert.equal(importResult.ok, true)

  const merged = await store2.listTurnActions('session:s-dump')
  assert.equal(merged.items.length, 2)
  assert.equal(merged.scannedThroughSeq, 15)

  // Import in replace mode
  const replaceDump = {
    entries: {},
    promptLogs: {},
    commitTraces: {},
    distillRuns: {},
    distillPlans: {},
    distillFingerprints: {},
    groups: {},
    workspaceRecords: [],
    handoffs: {},
    prefs: {},
    turnActions: {
      'session:s-replaced': {
        version: 1,
        sessionId: 's-replaced',
        scannedThroughSeq: 99,
        scannedAt: 9900,
        items: [makeActionItem({ id: 'item-replaced', sessionId: 's-replaced' })],
      },
    },
  }
  const replaceResult = await store2.importDump(replaceDump, { mode: 'replace' })
  assert.equal(replaceResult.ok, true)
  assert.equal(await store2.listTurnActions('session:s-dump'), null)
  const replaced = await store2.listTurnActions('session:s-replaced')
  assert.equal(replaced.sessionId, 's-replaced')
  assert.equal(replaced.items.length, 1)
})

test('clearWorkspaceData: clears turnActions for targeted session', async () => {
  const tmp = tempDir()
  const filePath = path.join(tmp, 'punch_desk.json')
  const store = createHostDeskStore({ storageFilePath: filePath })

  await store.putTurnActions('session:s-target', {
    version: 1,
    sessionId: 's-target',
    scannedThroughSeq: 10,
    scannedAt: 1000,
    items: [makeActionItem({ id: 't-1', sessionId: 's-target' })],
  })
  await store.putTurnActions('session:s-keep', {
    version: 1,
    sessionId: 's-keep',
    scannedThroughSeq: 10,
    scannedAt: 1000,
    items: [makeActionItem({ id: 'k-1', sessionId: 's-keep' })],
  })

  await store.clearWorkspaceData('session:s-target')
  assert.equal(await store.listTurnActions('session:s-target'), null)
  assert.ok(await store.listTurnActions('session:s-keep') !== null)
})
