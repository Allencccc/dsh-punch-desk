import test from 'node:test'
import assert from 'node:assert/strict'
import { createTurnActionsTracker } from '../src/client/platform/turn-actions.js'

function createMockStore(initialState = {}) {
  const turnActionsMap = new Map()
  const promptLogs = new Map()
  const entriesMap = new Map()
  let prefs = { includeTextHeuristic: false }

  return {
    turnActionsMap,
    async listTurnActions(key) {
      return turnActionsMap.get(key) || null
    },
    async putTurnActions(key, state) {
      turnActionsMap.set(key, state)
    },
    async listPromptLog(workspaceKey) {
      return promptLogs.get(workspaceKey) || []
    },
    async listEntries(workspaceKey) {
      return entriesMap.get(workspaceKey) || []
    },
    async listFindings(workspaceKey) {
      return entriesMap.get(workspaceKey) || []
    },
    async getPrefs() {
      return prefs
    },
    async setPrefs(next) {
      prefs = { ...prefs, ...next }
    },
  }
}

function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test('live event streaming: collects turn buffer and settles on turn/end', async () => {
  const store = createMockStore()
  const queue = []
  let notify
  let streamClosed = false

  const remote = {
    session: {
      async *observeEvent({ address }, signal) {
        while (!signal.aborted && !streamClosed) {
          if (queue.length > 0) {
            yield queue.shift()
          } else {
            await new Promise(r => { notify = r })
          }
        }
      },
    },
  }

  const tracker = createTurnActionsTracker({
    remote,
    store,
    fetchRoute: async () => ({ ok: false }),
  })

  tracker.ensureObserver('s-live-1')
  assert.equal(tracker.isActive('s-live-1'), true)

  // Push turn/start
  queue.push({
    type: 'event',
    event: { type: 'turn/start', data: { turn: 1 }, seq: 1 },
  })
  // Push assistant/message with Section A disposition
  queue.push({
    type: 'event',
    event: {
      type: 'assistant/message',
      data: {
        turn: 1,
        message: { content: '1. 测试用例 —— 需确认（需要先确认规范）' },
      },
      seq: 2,
    },
  })
  // Push turn/end
  queue.push({
    type: 'event',
    event: { type: 'turn/end', data: { turn: 1 }, seq: 3 },
  })
  notify?.()

  // Wait for turn/end processing
  await new Promise(r => setTimeout(r, 50))

  const saved = await store.listTurnActions('session:s-live-1')
  assert.ok(saved, 'turnActions should have been saved to store')
  assert.equal(saved.sessionId, 's-live-1')
  assert.equal(saved.items.length, 1)
  assert.equal(saved.items[0].kind, 'confirm')
  assert.equal(saved.items[0].status, 'open')
  assert.ok(saved.items[0].title.includes('测试用例'))

  tracker.close('s-live-1')
  assert.equal(tracker.isActive('s-live-1'), false)
  tracker.dispose()
})

test('identity guard: stream exit cleans up only if controller matches', async () => {
  const store = createMockStore()
  const deferred = createDeferred()

  const remote = {
    session: {
      async *observeEvent({ address }, signal) {
        yield { type: 'ready' }
        await deferred.promise
      },
    },
  }

  const tracker = createTurnActionsTracker({
    remote,
    store,
  })

  tracker.ensureObserver('s-guard-1')
  assert.equal(tracker.isActive('s-guard-1'), true)

  // End the stream naturally
  deferred.resolve()
  await new Promise(r => setTimeout(r, 50))

  assert.equal(tracker.isActive('s-guard-1'), false, 'Should clean up when stream ends')

  // Race condition: old stream finishes after new observer took over
  const deferredOld = createDeferred()
  const deferredNew = createDeferred()
  let callCount = 0

  const raceRemote = {
    session: {
      async *observeEvent({ address }, signal) {
        callCount++
        if (callCount === 1) {
          yield { type: 'ready' }
          await deferredOld.promise
        } else {
          yield { type: 'ready' }
          await deferredNew.promise
        }
      },
    },
  }

  const raceTracker = createTurnActionsTracker({
    remote: raceRemote,
    store,
  })

  raceTracker.ensureObserver('s-race')
  // Force abort the first controller and start a second observer
  raceTracker.close('s-race')
  raceTracker.ensureObserver('s-race')
  assert.equal(raceTracker.isActive('s-race'), true)

  // Now let the first stream's finally block run
  deferredOld.resolve()
  await new Promise(r => setTimeout(r, 50))

  // The second observer must still be active!
  assert.equal(raceTracker.isActive('s-race'), true, 'Second observer must remain active despite first stream finishing')

  raceTracker.dispose()
  deferredNew.resolve()

  tracker.dispose()
})

test('late mount with empty buffer triggers resync', async () => {
  const store = createMockStore()
  let resyncCalled = false

  const remote = {
    session: {
      async *observeEvent({ address }, signal) {
        // Observer mounts late and immediately sees turn/end without turn/start
        yield {
          type: 'event',
          event: { type: 'turn/end', data: { turn: 5 }, seq: 10 },
        }
      },
    },
  }

  const tracker = createTurnActionsTracker({
    remote,
    store,
    fetchRoute: async (path, init) => {
      resyncCalled = true
      return {
        ok: true,
        value: {
          sessionId: 's-late-1',
          scannedThroughSeq: 10,
          turns: [
            {
              turn: 5,
              items: [
                {
                  id: 's-late-1|5|disposition|8|1',
                  sessionId: 's-late-1',
                  turn: 5,
                  source: 'disposition',
                  kind: 'confirm',
                  confidence: 'high',
                  evidenceSeq: 8,
                  findingNo: 1,
                  title: 'Turn 5 · 需确认: 补齐缺失测试',
                  body: '需确认',
                  status: 'open',
                  createdAt: 1000,
                },
              ],
            },
          ],
        },
      }
    },
  })

  tracker.ensureObserver('s-late-1')

  await new Promise(r => setTimeout(r, 50))
  assert.ok(resyncCalled, 'resync should have been triggered by empty buffer turn/end')

  const saved = await store.listTurnActions('session:s-late-1')
  assert.ok(saved, 'turnActions should have been saved')
  assert.equal(saved.items.length, 1)
  assert.equal(saved.items[0].kind, 'confirm')

  tracker.dispose()
})

test('resync falls back to remote.session.events.page when HTTP scan fails', async () => {
  const store = createMockStore()

  const remote = {
    session: {
      events: {
        page: async ({ address, limit }, signal) => {
          return {
            ok: true,
            records: [
              {
                seq: 1,
                event: { type: 'turn/start', data: { turn: 1 }, seq: 1 },
              },
              {
                seq: 2,
                event: {
                  type: 'assistant/message',
                  data: {
                    turn: 1,
                    message: { content: '1. 需确认：数据库迁移计划' },
                  },
                  seq: 2,
                },
              },
              {
                seq: 3,
                event: { type: 'turn/end', data: { turn: 1 }, seq: 3 },
              },
            ],
          }
        },
      },
    },
  }

  const tracker = createTurnActionsTracker({
    remote,
    store,
    fetchRoute: async () => {
      throw new Error('503 Service Unavailable')
    },
  })

  const result = await tracker.resync('s-fallback-1')
  assert.equal(result.ok, true)
  assert.equal(result.source, 'events-fallback')
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].kind, 'confirm')
  assert.ok(result.items[0].title.includes('数据库迁移计划'))

  const saved = await store.listTurnActions('session:s-fallback-1')
  assert.ok(saved)
  assert.equal(saved.items.length, 1)

  tracker.dispose()
})

test('mergeTurnActionItems preserves dismissed and converted items across resync', async () => {
  const store = createMockStore()

  // Pre-seed an existing item marked as dismissed
  const existingItem = {
    id: 's-merge-1|1|disposition|2|1',
    sessionId: 's-merge-1',
    turn: 1,
    source: 'disposition',
    kind: 'confirm',
    confidence: 'high',
    evidenceSeq: 2,
    findingNo: 1,
    title: '需确认项',
    body: '需确认',
    status: 'dismissed',
    dismissedAt: 12345,
    createdAt: 1000,
  }
  await store.putTurnActions('session:s-merge-1', {
    version: 1,
    sessionId: 's-merge-1',
    scannedThroughSeq: 2,
    scannedAt: 1000,
    items: [existingItem],
  })

  const remote = {
    session: {
      async *observeEvent() {},
    },
  }

  const tracker = createTurnActionsTracker({
    remote,
    store,
    fetchRoute: async () => ({
      ok: true,
      value: {
        sessionId: 's-merge-1',
        scannedThroughSeq: 3,
        turns: [
          {
            turn: 1,
            items: [
              {
                ...existingItem,
                status: 'open', // fresh scan re-derived as open
              },
            ],
          },
        ],
      },
    }),
  })

  const result = await tracker.resync('s-merge-1')
  assert.equal(result.ok, true)
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].status, 'dismissed', 'dismissed status must be preserved')
  assert.equal(result.items[0].dismissedAt, 12345)

  tracker.dispose()
})

test('close and closeAll clear observers and abort controllers', async () => {
  const store = createMockStore()
  let abortedCount = 0

  const remote = {
    session: {
      async *observeEvent({ address }, signal) {
        signal.addEventListener('abort', () => {
          abortedCount++
        })
        while (!signal.aborted) {
          await new Promise(r => setTimeout(r, 100))
        }
      },
    },
  }

  const tracker = createTurnActionsTracker({
    remote,
    store,
  })

  tracker.ensureObserver('s-multi-1')
  tracker.ensureObserver('s-multi-2')
  assert.equal(tracker.isActive('s-multi-1'), true)
  assert.equal(tracker.isActive('s-multi-2'), true)

  tracker.close('s-multi-1')
  assert.equal(tracker.isActive('s-multi-1'), false)
  assert.equal(tracker.isActive('s-multi-2'), true)
  assert.equal(abortedCount, 1)

  tracker.closeAll()
  assert.equal(tracker.isActive('s-multi-2'), false)
  assert.equal(abortedCount, 2)

  tracker.dispose()
})
