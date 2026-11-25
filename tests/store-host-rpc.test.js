import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  apply,
  handleStoreRpc,
} from '../index.js'
import { createHostDeskStore } from '../src/store/host.js'
import { createDeskStore } from '../src/store/local.js'
import { createWorkspaceRecord } from '../src/domain/workspace.js'

test('handleStoreRpc GET dump returns full state dump', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'punch-rpc-test-'))
  const filePath = path.join(tmpDir, 'punch_desk.json')

  try {
    const hostStore = createHostDeskStore({ storageFilePath: filePath })
    await hostStore.putEntry({ id: 'e1', workspaceKey: 'ws1', title: 'Test Entry', status: 'open' })

    const res = await handleStoreRpc({ action: 'dump' }, { hostStore })
    assert.equal(res.ok, true)
    assert.equal(res.status, 200)
    assert.ok(res.state)
    assert.equal(res.state.entries.ws1?.length, 1)
    assert.equal(res.state.entries.ws1[0].id, 'e1')

    // Default action without action parameter also dumps
    const resDefault = await handleStoreRpc({}, { hostStore })
    assert.equal(resDefault.ok, true)
    assert.equal(resDefault.state.entries.ws1?.length, 1)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('handleStoreRpc POST actions dispatch correctly to hostStore', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'punch-rpc-test-'))
  const filePath = path.join(tmpDir, 'punch_desk.json')

  try {
    const hostStore = createHostDeskStore({ storageFilePath: filePath })

    // 1. putEntry
    const putRes = await handleStoreRpc({
      action: 'putEntry',
      entry: { id: 'entry-1', workspaceKey: 'ws1', sessionId: 'ws1', title: 'Task 1', status: 'open' },
    }, { hostStore })
    assert.equal(putRes.ok, true)
    assert.equal((await hostStore.listEntries('ws1')).length, 1)

    // 2. putEntries
    const putEntriesRes = await handleStoreRpc({
      action: 'putEntries',
      workspaceKey: 'ws1',
      entries: [
        { id: 'entry-1', workspaceKey: 'ws1', sessionId: 'ws1', title: 'Task 1 Updated', status: 'open' },
        { id: 'entry-2', workspaceKey: 'ws1', sessionId: 'ws1', title: 'Task 2', status: 'open' },
      ],
    }, { hostStore })
    assert.equal(putEntriesRes.ok, true)
    assert.equal((await hostStore.listEntries('ws1')).length, 2)

    // 3. deleteEntry
    const delRes = await handleStoreRpc({
      action: 'deleteEntry',
      workspaceKey: 'ws1',
      id: 'entry-1',
    }, { hostStore })
    assert.equal(delRes.ok, true)
    assert.equal((await hostStore.listEntries('ws1')).length, 1)
    assert.equal((await hostStore.listEntries('ws1'))[0].id, 'entry-2')

    // 4. upsertPromptLog & deletePromptLog
    const now = Date.now()
    const logRes = await handleStoreRpc({
      action: 'upsertPromptLog',
      workspaceKey: 'ws1',
      entries: [{ messageId: 'm1', time: now, text: 'hello' }],
    }, { hostStore })
    assert.equal(logRes.ok, true)
    assert.equal((await hostStore.listPromptLog('ws1')).length, 1)

    const delLogRes = await handleStoreRpc({
      action: 'deletePromptLog',
      workspaceKey: 'ws1',
      messageId: 'm1',
    }, { hostStore })
    assert.equal(delLogRes.ok, true)
    assert.equal((await hostStore.listPromptLog('ws1')).length, 0)

    // 5. putGroup & getGroups
    const grpRes = await handleStoreRpc({
      action: 'putGroup',
      group: {
        id: 'g1',
        // putGroup enforces the group→finding link (Phase 4 / B6): the session
        // must name the bucket the item's finding lives in.
        sessionId: 'ws1',
        workspaceId: 'ws1',
        groupNumber: 1,
        title: 'Group 1',
        startTurn: 0,
        items: [{ findingId: 'entry-2', order: 0 }],
        createdAt: now,
      },
    }, { hostStore })
    assert.equal(grpRes.ok, true)
    assert.equal((await hostStore.getGroups('ws1')).length, 1)

    // 6. setHandoff & deleteHandoff
    const handoffRes = await handleStoreRpc({
      action: 'setHandoff',
      sessionId: 's1',
      value: { text: 'draft prefill' },
    }, { hostStore })
    assert.equal(handoffRes.ok, true)
    assert.deepEqual(await hostStore.getHandoff('s1'), { text: 'draft prefill' })

    const delHandoffRes = await handleStoreRpc({
      action: 'deleteHandoff',
      sessionId: 's1',
    }, { hostStore })
    assert.equal(delHandoffRes.ok, true)
    assert.equal(await hostStore.getHandoff('s1'), null)

    // 7. setPrefs
    const prefsRes = await handleStoreRpc({
      action: 'setPrefs',
      prefs: { submitMode: 'sequential' },
    }, { hostStore })
    assert.equal(prefsRes.ok, true)
    const currentPrefs = await hostStore.getPrefs()
    assert.equal(currentPrefs.submitMode, 'sequential')

    // 8. putWorkspaceRecord
    const wsRecordRes = await handleStoreRpc({
      action: 'putWorkspaceRecord',
      record: createWorkspaceRecord({ id: 'rec-1', name: 'My Project', path: '/path/to/project' }),
    }, { hostStore })
    assert.equal(wsRecordRes.ok, true)
    assert.equal((await hostStore.listWorkspaceRecords()).length, 1)

    // 9. clearWorkspaceData
    const clearRes = await handleStoreRpc({
      action: 'clearWorkspaceData',
      workspaceId: 'ws1',
    }, { hostStore })
    assert.equal(clearRes.ok, true)
    assert.equal((await hostStore.listEntries('ws1')).length, 0)

    // 10. unknown action returns 400
    const unknownRes = await handleStoreRpc({ action: 'nonexistent' }, { hostStore })
    assert.equal(unknownRes.ok, false)
    assert.equal(unknownRes.status, 400)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('Registered /api/punch-desk/store route responds to GET and POST via connection.fetch', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'punch-route-test-'))
  const filePath = path.join(tmpDir, 'punch_desk.json')

  try {
    const hostStore = createHostDeskStore({ storageFilePath: filePath })
    const routes = new Map()

    const fakeCtx = {
      connection: {
        fetch: {
          register(route) {
            routes.set(route.path, route)
          },
        },
      },
      effect(fn) { fn() },
      get() { return null },
    }

    apply(fakeCtx, { hostStore })
    const storeRoute = routes.get('/api/punch-desk/store')
    assert.ok(storeRoute, 'Route /api/punch-desk/store must be registered')
    assert.deepEqual(storeRoute.methods, ['GET', 'POST'])

    // Test GET /api/punch-desk/store?action=dump
    const getReq = {
      method: 'GET',
      url: 'http://localhost/api/punch-desk/store?action=dump',
    }
    const getRes = await storeRoute.fetch(getReq)
    assert.equal(getRes.status, 200)
    const getData = await getRes.json()
    assert.equal(getData.ok, true)
    assert.ok(getData.state)

    // Test POST /api/punch-desk/store
    const postReq = {
      method: 'POST',
      url: 'http://localhost/api/punch-desk/store',
      json: async () => ({
        action: 'putEntry',
        entry: { id: 'rpc-entry-1', workspaceKey: 'ws-rpc', title: 'RPC Created', status: 'open' },
      }),
    }
    const postRes = await storeRoute.fetch(postReq)
    assert.equal(postRes.status, 200)
    const postData = await postRes.json()
    assert.equal(postData.ok, true)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('createDeskStore client operates in-memory and syncs to Host store without localStorage', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'punch-client-sync-'))
  const filePath = path.join(tmpDir, 'punch_desk.json')

  try {
    const hostStore = createHostDeskStore({ storageFilePath: filePath })

    // Simulate mock fetch connecting client to handleStoreRpc
    const mockFetch = async (url, options = {}) => {
      const urlObj = new URL(url, 'http://localhost')
      if (options.method === 'POST') {
        const body = JSON.parse(options.body)
        const result = await handleStoreRpc(body, { hostStore })
        return {
          ok: result.ok,
          status: result.status || 200,
          json: async () => result,
        }
      }
      const params = Object.fromEntries(urlObj.searchParams.entries())
      const result = await handleStoreRpc(params, { hostStore })
      return {
        ok: result.ok,
        status: result.status || 200,
        json: async () => result,
      }
    }

    // 1. Initialize client store #1 without localStorage
    const clientStore1 = createDeskStore({
      storage: null, // Zero localStorage
      fetch: mockFetch,
    })

    // Write entries and groups into clientStore1
    await clientStore1.putEntry({
      id: 'f-101',
      workspaceKey: 'session:s101',
      sessionId: 's101',
      title: 'Finding 101',
      status: 'open',
    })
    await clientStore1.putGroup({
      id: 'grp-1',
      sessionId: 's101',
      workspaceId: 'session:s101',
      groupNumber: 1,
      title: 'Batch 1',
      startTurn: 0,
      items: [{ findingId: 'f-101', order: 0 }],
      createdAt: Date.now(),
    })
    await clientStore1.setPrefs({ submitMode: 'sequential' })

    // Reads in clientStore1 are immediate and synchronous
    const entries1 = await clientStore1.listEntries('session:s101')
    assert.equal(entries1.length, 1)
    assert.equal(entries1[0].id, 'f-101')

    const groups1 = await clientStore1.getGroups('s101')
    assert.equal(groups1.length, 1)
    assert.equal(groups1[0].id, 'grp-1')

    const prefs1 = await clientStore1.getPrefs()
    assert.equal(prefs1.submitMode, 'sequential')

    // Verify host disk file received the mutations
    const hostEntries = await hostStore.listEntries('session:s101')
    assert.equal(hostEntries.length, 1)
    assert.equal(hostEntries[0].id, 'f-101')

    // 2. Initialize a fresh client store #2 (simulating page refresh / new session)
    const clientStore2 = createDeskStore({
      storage: null, // Zero localStorage
      fetch: mockFetch,
    })

    // Await hydration
    const hydrated = await clientStore2.hydrate()
    assert.equal(hydrated, true)

    // clientStore2 now has all data from Host disk file!
    const entries2 = await clientStore2.listEntries('session:s101')
    assert.equal(entries2.length, 1)
    assert.equal(entries2[0].id, 'f-101')

    const groups2 = await clientStore2.getGroups('s101')
    assert.equal(groups2.length, 1)
    assert.equal(groups2[0].id, 'grp-1')

    const prefs2 = await clientStore2.getPrefs()
    assert.equal(prefs2.submitMode, 'sequential')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('apply activates on a strict Cordis context: undeclared service reads must not abort the Host half', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'punch-strict-ctx-'))
  const filePath = path.join(tmpDir, 'punch_desk.json')

  try {
    const routes = new Map()
    const connection = {
      fetch: {
        register(route) {
          routes.set(route.path, route)
        },
      },
    }
    // Real Cordis contexts are Proxies that throw for every service property
    // outside the plugin's inject list. Reading `ctx.hostStore` directly threw
    // `cannot get property "hostStore" without inject`, left the Host entry in
    // fiberPhase: failed, and silently emptied the desk. Mirror that trap here.
    const declared = new Set(['connection', 'effect', 'get'])
    const strictCtx = new Proxy({
      connection,
      effect(fn) { fn() },
      get() { return undefined },
    }, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && !(prop in target) && !declared.has(prop)) {
          throw new Error(`cannot get property "${prop}" without inject`)
        }
        return Reflect.get(target, prop, receiver)
      },
    })

    assert.doesNotThrow(() => apply(strictCtx, { storeOptions: { storageFilePath: filePath } }))
    assert.ok(routes.has('/api/punch-desk/store'), 'store route must register on activation')
    assert.ok(routes.has('/api/punch-desk/store-migrate'), 'migrate route must register on activation')

    const dumpRes = await routes.get('/api/punch-desk/store').fetch({
      method: 'POST',
      url: 'http://localhost/api/punch-desk/store',
      json: async () => ({ action: 'dump' }),
    })
    assert.equal(dumpRes.status, 200)
    const dump = await dumpRes.json()
    assert.equal(dump.ok, true)
    assert.ok(dump.state)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
