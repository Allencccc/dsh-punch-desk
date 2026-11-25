import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, handleTurnActionsScan } from '../index.js'
import { createHostDeskStore } from '../src/store/host.js'

function makeMockEvents(prefix = 's1') {
  return [
    { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 2000, data: { id: `${prefix}-u1`, role: 'user', content: [{ type: 'text', text: 'Do something' }] } },
    {
      type: 'assistant/message',
      seq: 3,
      time: 3000,
      data: {
        id: `${prefix}-a1`,
        role: 'assistant',
        content: [{ type: 'text', text: '1. 需确认 —— 是否需要继续？\n2. 已修复 —— 修复了bug' }],
      },
    },
    { type: 'turn/end', seq: 4, time: 4000, data: { turn: 1, reason: 'completed' } },
  ]
}

test('handleTurnActionsScan: validates sessionId parameter', async () => {
  const result1 = await handleTurnActionsScan({})
  assert.equal(result1.ok, false)
  assert.equal(result1.status, 400)
  assert.equal(result1.error, 'INVALID_SESSION_ID')

  const result2 = await handleTurnActionsScan({ sessionId: '   ' })
  assert.equal(result2.ok, false)
  assert.equal(result2.status, 400)
  assert.equal(result2.error, 'INVALID_SESSION_ID')

  const result3 = await handleTurnActionsScan({ sessionId: 12345 })
  assert.equal(result3.ok, false)
  assert.equal(result3.status, 400)
  assert.equal(result3.error, 'INVALID_SESSION_ID')
})

test('handleTurnActionsScan: checks sessionQuery service availability', async () => {
  // Context without sessionQuery
  const fakeCtxNoSq = {
    get(name) { return undefined },
  }
  const result = await handleTurnActionsScan({ sessionId: 's-1' }, {}, fakeCtxNoSq)
  assert.equal(result.ok, false)
  assert.equal(result.status, 503)
  assert.equal(result.error, 'SESSION_QUERY_UNAVAILABLE')

  // Context where sessionQuery does not have readSession
  const fakeCtxBrokenSq = {
    get(name) {
      if (name === 'sessionQuery') return {}
      return undefined
    },
  }
  const resultBroken = await handleTurnActionsScan({ sessionId: 's-1' }, {}, fakeCtxBrokenSq)
  assert.equal(resultBroken.ok, false)
  assert.equal(resultBroken.status, 503)
  assert.equal(resultBroken.error, 'SESSION_QUERY_UNAVAILABLE')
})

test('handleTurnActionsScan: handles session not found and read errors', async () => {
  const fakeCtxNotFound = {
    get(name) {
      if (name === 'sessionQuery') {
        return {
          readSession: async (id) => {
            const err = new Error('not found')
            err.code = 'SESSION_QUERY_SESSION_NOT_FOUND'
            throw err
          },
        }
      }
      return undefined
    },
  }
  const notFoundResult = await handleTurnActionsScan({ sessionId: 's-missing' }, {}, fakeCtxNotFound)
  assert.equal(notFoundResult.ok, false)
  assert.equal(notFoundResult.status, 404)
  assert.equal(notFoundResult.error, 'SESSION_NOT_FOUND')

  // readSession returning null
  const fakeCtxNull = {
    get(name) {
      if (name === 'sessionQuery') {
        return { readSession: async (id) => null }
      }
      return undefined
    },
  }
  const nullResult = await handleTurnActionsScan({ sessionId: 's-null' }, {}, fakeCtxNull)
  assert.equal(nullResult.ok, false)
  assert.equal(nullResult.status, 404)
  assert.equal(nullResult.error, 'SESSION_NOT_FOUND')

  // readSession throwing general error
  const fakeCtxThrow = {
    get(name) {
      if (name === 'sessionQuery') {
        return {
          readSession: async () => { throw new Error('disk read failed') },
        }
      }
      return undefined
    },
  }
  const throwResult = await handleTurnActionsScan({ sessionId: 's-err' }, {}, fakeCtxThrow)
  assert.equal(throwResult.ok, false)
  assert.equal(throwResult.status, 500)
  assert.equal(throwResult.error, 'SESSION_READ_FAILED')
})

test('handleTurnActionsScan: strongly validates snapshot structure', async () => {
  // Missing session
  const fakeCtxBad1 = {
    get() {
      return { readSession: async () => ({ events: [] }) }
    },
  }
  const res1 = await handleTurnActionsScan({ sessionId: 's-1' }, {}, fakeCtxBad1)
  assert.equal(res1.ok, false)
  assert.equal(res1.status, 500)
  assert.equal(res1.error, 'SESSION_READ_FAILED')

  // Wrong session.id
  const fakeCtxBad2 = {
    get() {
      return { readSession: async () => ({ session: { id: 's-other' }, events: [] }) }
    },
  }
  const res2 = await handleTurnActionsScan({ sessionId: 's-1' }, {}, fakeCtxBad2)
  assert.equal(res2.ok, false)
  assert.equal(res2.status, 500)
  assert.equal(res2.error, 'SESSION_READ_FAILED')

  // Missing events array
  const fakeCtxBad3 = {
    get() {
      return { readSession: async () => ({ session: { id: 's-1' }, events: 'not-an-array' }) }
    },
  }
  const res3 = await handleTurnActionsScan({ sessionId: 's-1' }, {}, fakeCtxBad3)
  assert.equal(res3.ok, false)
  assert.equal(res3.status, 500)
  assert.equal(res3.error, 'SESSION_READ_FAILED')
})

test('handleTurnActionsScan: successful scan returns TurnDigest items and coverage (read-only)', async () => {
  const events = makeMockEvents('s-success')
  const hostStore = createHostDeskStore()

  // Put a prompt log and finding to verify attribution mapping
  await hostStore.upsertPromptLog('session:s-success', [{
    messageId: 'm-1',
    turn: 1,
    time: Date.now(),
    requestId: 'req-1',
    mode: 'sequential',
    promptText: '1. [bug] Test finding\n   Test details',
  }])
  await hostStore.putEntry({
    id: 'f-1',
    kind: 'finding',
    workspaceKey: 'session:s-success',
    sessionId: 's-success',
    requestId: 'req-1',
    tag: 'bug',
    title: 'Test finding',
    text: 'Test details',
    status: 'submitted',
  })

  const fakeCtx = {
    get(name) {
      if (name === 'sessionQuery') {
        return {
          readSession: async (id) => ({
            session: { id },
            events,
          }),
        }
      }
      return undefined
    },
  }

  const res = await handleTurnActionsScan({
    sessionId: 's-success',
    maxTurns: 10,
  }, { hostStore }, fakeCtx)

  assert.equal(res.ok, true)
  assert.equal(res.status, 200)
  assert.ok(res.value)
  assert.equal(res.value.sessionId, 's-success')
  assert.equal(res.value.scannedThroughSeq, 4)
  assert.equal(res.value.turns.length, 1)

  const turn1 = res.value.turns[0]
  assert.equal(turn1.turn, 1)
  assert.equal(turn1.items.length, 1)
  assert.equal(turn1.items[0].kind, 'confirm')
  assert.equal(turn1.items[0].findingNo, 1)
  assert.equal(turn1.items[0].relatedFindingId, 'f-1')

  assert.deepEqual(res.value.coverage, {
    totalTurns: 1,
    scannedTurns: 1,
    hasMore: false,
  })

  // Confirm route is strictly read-only: no turnActions written to store
  assert.equal(await hostStore.listTurnActions('session:s-success'), null)
})

test('HTTP route /api/punch-desk/turn-actions-scan wired through apply()', async () => {
  const registeredRoutes = []
  const events = makeMockEvents('s-route')
  const fakeCtx = {
    effect(fn) { return fn() },
    get(name) {
      if (name === 'sessionQuery') {
        return {
          readSession: async (id) => ({
            session: { id },
            events,
          }),
        }
      }
      return undefined
    },
    connection: {
      fetch: {
        register(route) {
          registeredRoutes.push(route)
          return () => {}
        },
      },
    },
  }

  apply(fakeCtx)
  const route = registeredRoutes.find(r => r.path === '/api/punch-desk/turn-actions-scan')
  assert.ok(route, 'turn-actions-scan route must be registered')
  assert.deepEqual(route.methods, ['POST'])

  // 1. Success call
  const reqSuccess = new Request('http://localhost/api/punch-desk/turn-actions-scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's-route' }),
  })
  const respSuccess = await route.fetch(reqSuccess)
  assert.equal(respSuccess.status, 200)
  const bodySuccess = await respSuccess.json()
  assert.equal(bodySuccess.ok, true)
  assert.equal(bodySuccess.value.sessionId, 's-route')

  // 2. Bad request (missing sessionId) -> 400
  const reqBad = new Request('http://localhost/api/punch-desk/turn-actions-scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  const respBad = await route.fetch(reqBad)
  assert.equal(respBad.status, 400)
  const bodyBad = await respBad.json()
  assert.equal(bodyBad.ok, false)
  assert.equal(bodyBad.error, 'INVALID_SESSION_ID')

  // 3. Invalid JSON body -> 400
  const reqInvalidJson = new Request('http://localhost/api/punch-desk/turn-actions-scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not-json',
  })
  const respInvalidJson = await route.fetch(reqInvalidJson)
  assert.equal(respInvalidJson.status, 400)
})
