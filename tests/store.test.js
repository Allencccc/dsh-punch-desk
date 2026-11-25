import test from 'node:test'
import assert from 'node:assert/strict'
import { createLocalDeskStore } from '../src/store/local.js'
import { DEFAULT_PREFS } from '../src/store/contract.js'

class FakeStorage {
  #data = new Map()
  failKey = null
  getItem(key) { return this.#data.has(key) ? this.#data.get(key) : null }
  setItem(key, value) {
    if (this.failKey === key) {
      const error = new Error('quota exceeded')
      error.name = 'QuotaExceededError'
      throw error
    }
    this.#data.set(key, String(value))
  }
  removeItem(key) { this.#data.delete(key) }
  key(i) { return [...this.#data.keys()][i] ?? null }
  get length() { return this.#data.size }
}

const entry = (over = {}) => ({
  id: over.id ?? 'e1', schemaVersion: 1, workspaceKey: 'w1', kind: 'finding',
  sessionId: 's1', title: 't', body: '', status: 'open',
  createdAt: 1, updatedAt: 1, ...over,
})

test('puts and lists entries by workspace', async () => {
  const store = createLocalDeskStore({ storage: new FakeStorage(), now: () => 1 })
  await store.putEntry(entry())
  assert.equal((await store.listEntries('w1')).length, 1)
  assert.equal((await store.listEntries('w2')).length, 0)
  assert.deepEqual(await store.listWorkspaces(), ['w1'])
})

test('putEntry replaces by id and bumps revision', async () => {
  const storage = new FakeStorage()
  const store = createLocalDeskStore({ storage, now: () => 1 })
  await store.putEntry(entry())
  await store.putEntry(entry({ status: 'queued', updatedAt: 2 }))
  const list = await store.listEntries('w1')
  assert.equal(list.length, 1)
  assert.equal(list[0].status, 'queued')
  assert.ok(store.revision('w1') >= 2)
})

test('upsertPromptLog dedupes by messageId', async () => {
  const store = createLocalDeskStore({ storage: new FakeStorage(), now: () => 1 })
  await store.upsertPromptLog('w1', [{ messageId: 'm1', sessionId: 's1', time: 1, localDate: '2026-11-06', status: 'sent' }])
  await store.upsertPromptLog('w1', [{ messageId: 'm1', sessionId: 's1', time: 2, localDate: '2026-11-06', status: 'completed' }])
  const list = await store.listPromptLog('w1')
  assert.equal(list.length, 1)
  assert.equal(list[0].status, 'completed')
})

test('deletePromptLog removes the row from later reads', async () => {
  const store = createLocalDeskStore({ storage: new FakeStorage(), now: () => 1 })
  await store.upsertPromptLog('w1', [
    { messageId: 'm1', sessionId: 's1', time: 1, localDate: '2026-11-06', status: 'queued' },
    { messageId: 'm2', sessionId: 's1', time: 2, localDate: '2026-11-06', status: 'sent' },
  ])
  await store.deletePromptLog('w1', 'm1')
  assert.deepEqual((await store.listPromptLog('w1')).map(row => row.messageId), ['m2'])
})

test('deletePromptLog hides the row and warns when the write fails', async () => {
  const storage = new FakeStorage()
  const store = createLocalDeskStore({ storage, now: () => 1 })
  await store.upsertPromptLog('w1', [
    { messageId: 'q:r1', sessionId: 's1', time: 1, localDate: '2026-11-06', status: 'queued' },
  ])
  storage.failKey = 'dsh-punch-desk.v1.promptlog.w1'
  await store.deletePromptLog('w1', 'q:r1')
  assert.deepEqual(await store.listPromptLog('w1'), [])
  assert.equal(store.quotaWarning(), true)
})

test('corrupt storage degrades to empty', async () => {
  const storage = new FakeStorage()
  storage.setItem('dsh-punch-desk.v1.entries.w1', '{not json')
  const store = createLocalDeskStore({ storage, now: () => 1 })
  assert.deepEqual(await store.listEntries('w1'), [])
})

test('newer stored entry wins over an older write', async () => {
  const storage = new FakeStorage()
  const store = createLocalDeskStore({ storage, now: () => 1 })
  await store.putEntry(entry({ updatedAt: 1 }))
  const raw = JSON.parse(storage.getItem('dsh-punch-desk.v1.entries.w1'))
  raw.entries = [{ ...entry(), status: 'sent', updatedAt: 2 }]
  raw.rev = 99
  storage.setItem('dsh-punch-desk.v1.entries.w1', JSON.stringify(raw))
  await store.putEntry(entry({ status: 'open', updatedAt: 1 }))
  const list = await store.listEntries('w1')
  assert.equal(list[0].status, 'sent')
})

test('quota failure keeps the entry in memory and warns', async () => {
  const storage = new FakeStorage()
  const store = createLocalDeskStore({ storage, now: () => 1 })
  await store.putEntry(entry())
  storage.failKey = 'dsh-punch-desk.v1.entries.w1'
  await store.putEntry(entry({ id: 'e2', title: 'second' }))
  const list = await store.listEntries('w1')
  assert.ok(list.some(item => item.id === 'e2'))
  assert.equal(store.quotaWarning(), true)
})

test('notifies subscribers', async () => {
  const store = createLocalDeskStore({ storage: new FakeStorage(), now: () => 1 })
  let hits = 0
  const off = store.subscribe(() => { hits += 1 })
  await store.putEntry(entry())
  off()
  await store.putEntry(entry({ id: 'e2' }))
  assert.equal(hits, 1)
})

test('getEntry finds one entry and deleteEntry removes it', async () => {
  const store = createLocalDeskStore({ storage: new FakeStorage(), now: () => 1 })
  await store.putEntry(entry())
  assert.equal((await store.getEntry('w1', 'e1')).id, 'e1')
  assert.equal(await store.getEntry('w1', 'nope'), undefined)
  await store.deleteEntry('w1', 'e1')
  assert.deepEqual(await store.listEntries('w1'), [])
})

test('prefs start at defaults and round-trip', async () => {
  const store = createLocalDeskStore({ storage: new FakeStorage(), now: () => 1 })
  assert.deepEqual(await store.getPrefs(), {
    lastWorkspace: null,
    includeTextHeuristic: false,
    startSessionBehavior: 'prefill',
    inheritScope: 'workspace',
    draftDefaultVisibility: 'workspace',
    sequentialCostHint: 'threshold',
    composerRows: 4,
    archivedHistoryHeight: 'half',
    promptTail: 'standard',
    promptTailTextA: DEFAULT_PREFS.promptTailTextA,
    promptTailTextB: DEFAULT_PREFS.promptTailTextB,
    promptTailTextC: DEFAULT_PREFS.promptTailTextC,
    promptMaxEntryBytes: DEFAULT_PREFS.promptMaxEntryBytes,
    promptMaxBytes: DEFAULT_PREFS.promptMaxBytes,
    promptLogRetentionDays: DEFAULT_PREFS.promptLogRetentionDays,
    promptLogRetentionRows: DEFAULT_PREFS.promptLogRetentionRows,
    findingTags: DEFAULT_PREFS.findingTags,
  })
  await store.setPrefs({ submitMode: 'separate', lastWorkspace: 'w1' })
  assert.deepEqual(await store.getPrefs(), {
    submitMode: 'separate',
    lastWorkspace: 'w1',
    includeTextHeuristic: false,
    startSessionBehavior: 'prefill',
    inheritScope: 'workspace',
    draftDefaultVisibility: 'workspace',
    sequentialCostHint: 'threshold',
    composerRows: 4,
    archivedHistoryHeight: 'half',
    promptTail: 'standard',
    promptTailTextA: DEFAULT_PREFS.promptTailTextA,
    promptTailTextB: DEFAULT_PREFS.promptTailTextB,
    promptTailTextC: DEFAULT_PREFS.promptTailTextC,
    promptMaxEntryBytes: DEFAULT_PREFS.promptMaxEntryBytes,
    promptMaxBytes: DEFAULT_PREFS.promptMaxBytes,
    promptLogRetentionDays: DEFAULT_PREFS.promptLogRetentionDays,
    promptLogRetentionRows: DEFAULT_PREFS.promptLogRetentionRows,
    findingTags: DEFAULT_PREFS.findingTags,
  })
})

test('deleteEntry hides the entry and warns when the write fails', async () => {
  const storage = new FakeStorage()
  const store = createLocalDeskStore({ storage, now: () => 1 })
  await store.putEntry(entry())
  storage.failKey = 'dsh-punch-desk.v1.entries.w1'
  await store.deleteEntry('w1', 'e1')
  assert.deepEqual(await store.listEntries('w1'), [])
  assert.equal(await store.getEntry('w1', 'e1'), undefined)
  assert.equal(store.quotaWarning(), true)
})

test('setPrefs keeps new prefs in memory and warns when the write fails', async () => {
  const storage = new FakeStorage()
  const store = createLocalDeskStore({ storage, now: () => 1 })
  storage.failKey = 'dsh-punch-desk.v1.prefs'
  await store.setPrefs({ submitMode: 'separate', lastWorkspace: 'w2' })
  assert.deepEqual(await store.getPrefs(), {
    submitMode: 'separate',
    lastWorkspace: 'w2',
    includeTextHeuristic: false,
    startSessionBehavior: 'prefill',
    inheritScope: 'workspace',
    draftDefaultVisibility: 'workspace',
    sequentialCostHint: 'threshold',
    composerRows: 4,
    archivedHistoryHeight: 'half',
    promptTail: 'standard',
    promptTailTextA: DEFAULT_PREFS.promptTailTextA,
    promptTailTextB: DEFAULT_PREFS.promptTailTextB,
    promptTailTextC: DEFAULT_PREFS.promptTailTextC,
    promptMaxEntryBytes: DEFAULT_PREFS.promptMaxEntryBytes,
    promptMaxBytes: DEFAULT_PREFS.promptMaxBytes,
    promptLogRetentionDays: DEFAULT_PREFS.promptLogRetentionDays,
    promptLogRetentionRows: DEFAULT_PREFS.promptLogRetentionRows,
    findingTags: DEFAULT_PREFS.findingTags,
  })
  assert.equal(store.quotaWarning(), true)
})

class FakeEventTarget {
  #listeners = new Set()
  addEventListener(type, listener) {
    if (type === 'storage') this.#listeners.add(listener)
  }
  removeEventListener(type, listener) {
    if (type === 'storage') this.#listeners.delete(listener)
  }
  dispatch(event) {
    for (const listener of [...this.#listeners]) listener(event)
  }
}

test('storage events for punch desk keys notify subscribers', () => {
  const eventTarget = new FakeEventTarget()
  const store = createLocalDeskStore({ storage: new FakeStorage(), now: () => 1, eventTarget })
  let hits = 0
  const off = store.subscribe(() => { hits += 1 })

  eventTarget.dispatch({ key: 'other-app.key' })
  eventTarget.dispatch({ key: null })
  assert.equal(hits, 0)

  eventTarget.dispatch({ key: 'dsh-punch-desk.v1.entries.w1' })
  assert.equal(hits, 1)
  eventTarget.dispatch({ key: 'dsh-punch-desk.v1.prefs' })
  assert.equal(hits, 2)

  off()
  eventTarget.dispatch({ key: 'dsh-punch-desk.v1.entries.w1' })
  assert.equal(hits, 2)
})

test('storage events bump the affected workspace revision', () => {
  const eventTarget = new FakeEventTarget()
  const store = createLocalDeskStore({ storage: new FakeStorage(), now: () => 1, eventTarget })

  eventTarget.dispatch({ key: 'dsh-punch-desk.v1.entries.w1' })
  eventTarget.dispatch({ key: 'dsh-punch-desk.v1.promptlog.%2Ftmp%2Fw' })
  eventTarget.dispatch({ key: 'dsh-punch-desk.v1.prefs' })
  assert.equal(store.revision('w1'), 1)
  assert.equal(store.revision('/tmp/w'), 1)
  assert.equal(store.revision('prefs'), 0)
  store.dispose()
})

test('dispose stops cross-tab notifications', () => {
  const eventTarget = new FakeEventTarget()
  const store = createLocalDeskStore({ storage: new FakeStorage(), now: () => 1, eventTarget })
  let hits = 0
  store.subscribe(() => { hits += 1 })
  store.dispose()
  eventTarget.dispatch({ key: 'dsh-punch-desk.v1.entries.w1' })
  assert.equal(hits, 0)
})

test('stores without a storage event target keep working', async () => {
  const store = createLocalDeskStore({ storage: new FakeStorage(), now: () => 1, eventTarget: {} })
  assert.equal(typeof store.dispose, 'function')
  await store.putEntry(entry())
  assert.equal((await store.listEntries('w1')).length, 1)
})
