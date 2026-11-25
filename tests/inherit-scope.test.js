
import test from 'node:test'
import assert from 'node:assert/strict'
import { inheritScopeOf, persistInheritScope } from '../src/client/inherit-scope.js'
import { createLocalDeskStore } from '../src/store/local.js'
import { DEFAULT_PREFS, INHERIT_SCOPES } from '../src/store/contract.js'

test('inheritScopeOf normalises persisted prefs to a supported scope', () => {
  assert.equal(inheritScopeOf({ inheritScope: 'all' }), 'all')
  assert.equal(inheritScopeOf({ inheritScope: 'workspace' }), 'workspace')
  assert.equal(inheritScopeOf({ inheritScope: 'bogus' }), 'workspace', 'unknown values fall back to the safe default')
  assert.equal(inheritScopeOf(null), 'workspace')
  assert.equal(inheritScopeOf(undefined), 'workspace')
  assert.ok(INHERIT_SCOPES.includes('workspace') && INHERIT_SCOPES.includes('all'))
  assert.equal(DEFAULT_PREFS.inheritScope, 'workspace', 'default must stay inside the workspace')
})

test('persistInheritScope keeps every other preference intact', async () => {
  const state = { submitMode: 'separate', lastWorkspace: 'ws-1', startSessionBehavior: 'auto', inheritScope: 'workspace' }
  const store = {
    getPrefs: async () => ({ ...state }),
    setPrefs: async prefs => { Object.assign(state, prefs) },
  }
  const next = await persistInheritScope(store, 'all')
  assert.equal(next, 'all')
  assert.deepEqual(state, {
    submitMode: 'separate',
    lastWorkspace: 'ws-1',
    startSessionBehavior: 'auto',
    inheritScope: 'all',
  })
})

test('persistInheritScope degrades gracefully without prefs support', async () => {
  assert.equal(await persistInheritScope(null, 'all'), 'all')
  assert.equal(await persistInheritScope({}, 'workspace'), 'workspace')
  assert.equal(await persistInheritScope({ getPrefs: async () => ({}) }, 'all'), 'all', 'read-only store still reports the value')
  assert.equal(await persistInheritScope({ setPrefs: async () => {} }, 'bogus'), 'workspace', 'unknown scopes normalise to workspace')
})

test('local store sanitises a hand-edited inheritScope on read', async () => {
  const store = createLocalDeskStore({ autoHydrate: false })
  await store.setPrefs({ ...DEFAULT_PREFS, inheritScope: 'bogus' })
  assert.equal((await store.getPrefs()).inheritScope, 'workspace')
  await store.setPrefs({ ...DEFAULT_PREFS, inheritScope: 'all' })
  assert.equal((await store.getPrefs()).inheritScope, 'all')
})
