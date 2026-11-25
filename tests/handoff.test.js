import test from 'node:test'
import assert from 'node:assert/strict'
import { createLocalDeskStore } from '../src/store/local.js'

class FakeStorage {
  #data = new Map()
  failKey = null
  failRemoveKey = null
  getItem(key) { return this.#data.has(key) ? this.#data.get(key) : null }
  setItem(key, value) {
    if (this.failKey === key) {
      const error = new Error('quota exceeded')
      error.name = 'QuotaExceededError'
      throw error
    }
    this.#data.set(key, String(value))
  }
  removeItem(key) {
    if (this.failRemoveKey === key) {
      const error = new Error('remove failed')
      error.name = 'QuotaExceededError'
      throw error
    }
    this.#data.delete(key)
  }
  key(i) { return [...this.#data.keys()][i] ?? null }
  get length() { return this.#data.size }
}

const HANDOFF_KEY = 'dsh-punch-desk.v1.handoff.session-abc'
const draftHandoff = { body: '把草稿变成首轮 prompt', draftId: 'draft-1' }

test('setHandoff writes the session-keyed value and getHandoff reads it back', async () => {
  const storage = new FakeStorage()
  const store = createLocalDeskStore({ storage, now: () => 1 })
  await store.setHandoff('session-abc', draftHandoff)
  assert.deepEqual(JSON.parse(storage.getItem(HANDOFF_KEY)), draftHandoff)
  assert.deepEqual(await store.getHandoff('session-abc'), draftHandoff)
  assert.equal(await store.getHandoff('session-other'), null)
})

test('setHandoff overwrites the previous value for the same session', async () => {
  const storage = new FakeStorage()
  const store = createLocalDeskStore({ storage, now: () => 1 })
  await store.setHandoff('session-abc', { body: 'first' })
  await store.setHandoff('session-abc', { body: 'second' })
  assert.deepEqual(await store.getHandoff('session-abc'), { body: 'second' })
})

test('getHandoff does not consume the value; deleteHandoff clears it', async () => {
  const storage = new FakeStorage()
  const store = createLocalDeskStore({ storage, now: () => 1 })
  await store.setHandoff('session-abc', draftHandoff)
  assert.deepEqual(await store.getHandoff('session-abc'), draftHandoff)
  assert.deepEqual(await store.getHandoff('session-abc'), draftHandoff)
  await store.deleteHandoff('session-abc')
  assert.equal(await store.getHandoff('session-abc'), null)
  assert.equal(storage.getItem(HANDOFF_KEY), null)
})

test('deleteHandoff is idempotent for an unknown session', async () => {
  const store = createLocalDeskStore({ storage: new FakeStorage(), now: () => 1 })
  await store.deleteHandoff('session-missing')
  assert.equal(await store.getHandoff('session-missing'), null)
})

test('corrupt handoff JSON degrades to null and stays writable', async () => {
  const storage = new FakeStorage()
  storage.setItem(HANDOFF_KEY, '{not json')
  const store = createLocalDeskStore({ storage, now: () => 1 })
  assert.equal(await store.getHandoff('session-abc'), null)
  await store.setHandoff('session-abc', draftHandoff)
  assert.deepEqual(await store.getHandoff('session-abc'), draftHandoff)
})

test('quota failure keeps the handoff in memory and warns', async () => {
  const storage = new FakeStorage()
  const store = createLocalDeskStore({ storage, now: () => 1 })
  storage.failKey = HANDOFF_KEY
  await store.setHandoff('session-abc', draftHandoff)
  assert.deepEqual(await store.getHandoff('session-abc'), draftHandoff)
  assert.equal(storage.getItem(HANDOFF_KEY), null)
  assert.equal(store.quotaWarning(), true)
})

test('a failed handoff delete hides the value and warns', async () => {
  const storage = new FakeStorage()
  const store = createLocalDeskStore({ storage, now: () => 1 })
  await store.setHandoff('session-abc', draftHandoff)
  storage.failRemoveKey = HANDOFF_KEY
  await store.deleteHandoff('session-abc')
  assert.equal(await store.getHandoff('session-abc'), null)
  assert.equal(store.quotaWarning(), true)
})

test('prefs default to the prefill session-start behavior', async () => {
  const store = createLocalDeskStore({ storage: new FakeStorage(), now: () => 1 })
  const prefs = await store.getPrefs()
  assert.equal(prefs.startSessionBehavior, 'prefill')
  assert.equal(prefs.draftDefaultVisibility, 'workspace')
})

test('setPrefs persists the session-start behavior across store instances', async () => {
  const storage = new FakeStorage()
  const store = createLocalDeskStore({ storage, now: () => 1 })
  await store.setPrefs({ submitMode: 'combined', startSessionBehavior: 'auto' })
  assert.equal((await store.getPrefs()).startSessionBehavior, 'auto')
  const reopened = createLocalDeskStore({ storage, now: () => 1 })
  assert.equal((await reopened.getPrefs()).startSessionBehavior, 'auto')
})

test('a partial prefs write keeps the default session-start behavior', async () => {
  const storage = new FakeStorage()
  const store = createLocalDeskStore({ storage, now: () => 1 })
  await store.setPrefs({ lastWorkspace: 'w1' })
  const prefs = await store.getPrefs()
  assert.equal(prefs.startSessionBehavior, 'prefill')
  assert.equal(prefs.lastWorkspace, 'w1')
})

test('an unknown stored session-start behavior falls back to prefill', async () => {
  const storage = new FakeStorage()
  storage.setItem('dsh-punch-desk.v1.prefs', JSON.stringify({ startSessionBehavior: 'nonsense' }))
  const store = createLocalDeskStore({ storage, now: () => 1 })
  assert.equal((await store.getPrefs()).startSessionBehavior, 'prefill')
})

test('corrupt prefs JSON degrades to defaults', async () => {
  const storage = new FakeStorage()
  storage.setItem('dsh-punch-desk.v1.prefs', '{not json')
  const store = createLocalDeskStore({ storage, now: () => 1 })
  assert.equal((await store.getPrefs()).startSessionBehavior, 'prefill')
})

test('prefs quota failure keeps the behavior in memory and warns', async () => {
  const storage = new FakeStorage()
  const store = createLocalDeskStore({ storage, now: () => 1 })
  storage.failKey = 'dsh-punch-desk.v1.prefs'
  await store.setPrefs({ startSessionBehavior: 'auto' })
  assert.equal((await store.getPrefs()).startSessionBehavior, 'auto')
  assert.equal(store.quotaWarning(), true)
})
