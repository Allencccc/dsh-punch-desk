import test from 'node:test'
import assert from 'node:assert/strict'
import { createPromptIndex } from '../src/client/platform/prompt-index.js'

const WORKSPACE = 'session:s1'
const NOW = Date.UTC(2026, 10, 6, 3, 0, 0)

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Poll until `predicate` passes; the index streams are fire-and-forget, so a
 * short wait is the only observation point a caller has.
 * @param {() => boolean} predicate
 * @param {string} label
 */
async function waitFor(predicate, label) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 1000) throw new Error(`timed out waiting for ${label}`)
    await delay(2)
  }
}

/**
 * Async iterable fed by the test. Aborting the stream's signal closes it so the
 * index's `for await` terminates like the real remote stream.
 * @param {AbortSignal|undefined} signal
 */
function createChannel(signal) {
  const buffer = []
  const waiters = []
  let closed = false

  const close = () => {
    if (closed) return
    closed = true
    for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true })
  }
  signal?.addEventListener('abort', close, { once: true })

  return {
    push(value) {
      if (closed) return
      const waiter = waiters.shift()
      if (waiter) waiter({ value, done: false })
      else buffer.push(value)
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (buffer.length > 0) return Promise.resolve({ value: buffer.shift(), done: false })
          if (closed) return Promise.resolve({ value: undefined, done: true })
          return new Promise(resolve => waiters.push(resolve))
        },
        return() {
          close()
          return Promise.resolve({ done: true })
        },
      }
    },
  }
}

function createFakeRemote() {
  const channels = {}
  const signals = {}
  return {
    signals,
    channel(name) {
      const channel = channels[name]
      if (!channel) throw new Error(`channel ${name} was not opened`)
      return channel
    },
    remote: {
      session: {
        observeState(_args, signal) {
          signals.state = signal
          channels.state = createChannel(signal)
          return channels.state
        },
        observeEvent(_args, signal) {
          signals.event = signal
          channels.event = createChannel(signal)
          return channels.event
        },
      },
    },
  }
}

/**
 * In-memory desk store with only the prompt-log surface the index uses.
 * Rows are keyed by messageId, like the real store's merge.
 */
function createFakeStore(initial = []) {
  const rows = new Map(initial.map(row => [row.messageId, { ...row }]))
  let writes = 0

  return {
    async listPromptLog() {
      return [...rows.values()].map(row => ({ ...row }))
    },
    async upsertPromptLog(_workspaceKey, entries) {
      writes += 1
      for (const entry of entries) {
        rows.set(entry.messageId, { ...rows.get(entry.messageId), ...entry })
      }
    },
    async deletePromptLog(_workspaceKey, messageId) {
      writes += 1
      rows.delete(messageId)
    },
    rows: () => [...rows.values()].map(row => ({ ...row })),
    writeCount: () => writes,
  }
}

function userMessage(over = {}) {
  return {
    id: 'm1',
    role: 'user',
    source: { kind: 'user', rpcId: 'r1' },
    content: [{ type: 'text', text: '请修复登录问题' }],
    ...over,
  }
}

function directEvent(over = {}) {
  return { type: 'user/message', seq: 1, time: NOW, data: userMessage(), ...over }
}

function wrappedEvent(over = {}) {
  return {
    type: 'user/message',
    seq: 1,
    time: NOW + 1000,
    data: { message: userMessage(), turn: 1 },
    ...over,
  }
}

function eventFrame(event) {
  return { type: 'event', event }
}

function setup() {
  const store = createFakeStore()
  const fake = createFakeRemote()
  const index = createPromptIndex({ remote: fake.remote, store, now: () => NOW, timeZone: 'UTC' })
  return { store, fake, index }
}

test('start backfills history missed while the session was not observed and reconciles the queue placeholder', async () => {
  const queueRow = {
    messageId: 'queue:req-hist', sessionId: 's1', workspaceKey: WORKSPACE,
    time: NOW, localDate: '2026-11-06', excerpt: '', promptText: '',
    source: 'desk-batch', requestId: 'req-hist', status: 'queued',
  }
  const store = createFakeStore([queueRow])
  const remote = createFakeRemote()
  let calls = 0
  const index = createPromptIndex({
    remote: remote.remote,
    store,
    backfill: async ({ store: target, workspaceKey }) => {
      calls += 1
      await target.upsertPromptLog(workspaceKey, [{
        messageId: 'm-historical', sessionId: 's1', workspaceKey,
        time: NOW - 1000, localDate: '2026-11-06',
        excerpt: 'missed prompt', promptText: 'missed prompt',
        source: 'history', requestId: 'req-hist', status: 'sent',
      }])
      return { ok: true, inserted: 1 }
    },
  })
  index.start({ sessionId: 's1', workspaceKey: WORKSPACE })
  await waitFor(() => store.rows().some(row => row.messageId === 'm-historical'), 'backfilled history row')
  await waitFor(() => !store.rows().some(row => row.messageId === 'queue:req-hist'), 'queue placeholder reconciliation')
  assert.equal(calls, 1)
  index.stop('s1')
})

test('indexes the direct user/message shape and completes it on turn/end', async () => {
  const { store, fake, index } = setup()
  index.start({ sessionId: 's1', workspaceKey: WORKSPACE })

  const events = fake.channel('event')
  events.push(eventFrame({ type: 'turn/start', data: { turn: 1 } }))
  events.push(eventFrame(directEvent()))
  events.push(eventFrame({ type: 'turn/end', data: { turn: 1 } }))

  await waitFor(() => store.rows()[0]?.status === 'completed', 'completed direct message')
  const rows = store.rows()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].messageId, 'm1')
  assert.equal(rows[0].requestId, 'r1')
  assert.equal(rows[0].turn, 1)
  assert.equal(rows[0].excerpt, '请修复登录问题')
  index.stop('s1')
})

test('indexes the wrapped {message,turn} shape when turn/start arrives after the message', async () => {
  const { store, fake, index } = setup()
  index.start({ sessionId: 's1', workspaceKey: WORKSPACE })

  const events = fake.channel('event')
  events.push(eventFrame(wrappedEvent()))
  events.push(eventFrame({ type: 'turn/start', data: { turn: 1 } }))
  events.push(eventFrame({ type: 'turn/end', data: { turn: 1 } }))

  await waitFor(() => store.rows()[0]?.status === 'completed', 'completed wrapped message')
  const rows = store.rows()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].messageId, 'm1')
  assert.equal(rows[0].turn, 1)
  index.stop('s1')
})

test('tracking before the message replaces the placeholder with one row', async () => {
  const { store, fake, index } = setup()
  index.start({ sessionId: 's1', workspaceKey: WORKSPACE })

  await index.track({ sessionId: 's1', workspaceKey: WORKSPACE, requestId: 'r1', batchId: 'b1' })
  assert.equal(store.rows()[0].status, 'queued')

  const events = fake.channel('event')
  events.push(eventFrame({ type: 'turn/start', data: { turn: 1 } }))
  events.push(eventFrame(directEvent()))
  events.push(eventFrame({ type: 'turn/end', data: { turn: 1 } }))

  await waitFor(() => store.rows()[0]?.status === 'completed', 'completed tracked message')
  const rows = store.rows()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].messageId, 'm1')
  assert.equal(rows[0].source, 'desk-batch')
  assert.equal(rows[0].batchId, 'b1')
  index.stop('s1')
})

test('expires a queued row only when an idle queue array omits its requestId', async () => {
  const { store, fake, index } = setup()
  index.start({ sessionId: 's1', workspaceKey: WORKSPACE })
  await index.track({ sessionId: 's1', workspaceKey: WORKSPACE, requestId: 'r9', batchId: 'b1' })
  assert.equal(store.rows()[0].status, 'queued')

  const states = fake.channel('state')
  states.push({ running: false, queue: [{ rpcId: 'r9' }] })
  await delay(20)
  assert.equal(store.rows()[0].status, 'queued')

  states.push({ running: false, queue: [{ rpcId: 'other' }] })
  await waitFor(() => store.rows()[0]?.status === 'expired', 'queue expiry')
  index.stop('s1')
})

test('queue: null (passive session) does not expire queued rows', async () => {
  const { store, fake, index } = setup()
  index.start({ sessionId: 's1', workspaceKey: WORKSPACE })
  await index.track({ sessionId: 's1', workspaceKey: WORKSPACE, requestId: 'r10', batchId: 'b1' })

  fake.channel('state').push({ running: false, queue: null })
  await delay(30)

  const rows = store.rows()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'queued')
  index.stop('s1')
})

test('late track after the message keeps one non-expired row', async () => {
  const { store, fake, index } = setup()
  index.start({ sessionId: 's1', workspaceKey: WORKSPACE })

  const events = fake.channel('event')
  events.push(eventFrame(wrappedEvent()))
  events.push(eventFrame({ type: 'turn/end', data: { turn: 1 } }))
  await waitFor(() => store.rows()[0]?.status === 'completed', 'completed before track')
  assert.equal(store.rows().length, 1)

  // The submit RPC resolves after the host event, so tracking happens late.
  const row = await index.track({
    sessionId: 's1', workspaceKey: WORKSPACE, requestId: 'r1', batchId: 'b1',
  })
  assert.equal(row.messageId, 'm1')

  const rows = store.rows()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].messageId, 'm1')
  assert.equal(rows[0].status, 'completed')
  assert.equal(rows[0].source, 'desk-batch')
  assert.equal(rows[0].batchId, 'b1')
  assert.equal(rows[0].messageId.startsWith('queue:'), false)

  // The idle frame that used to expire the duplicate placeholder now has no target.
  fake.channel('state').push({ running: false, queue: [] })
  await delay(30)
  assert.equal(store.rows().length, 1)
  assert.equal(store.rows()[0].status, 'completed')
  index.stop('s1')
})

test('stop aborts both streams and no further writes occur', async () => {
  const { store, fake, index } = setup()
  index.start({ sessionId: 's1', workspaceKey: WORKSPACE })

  assert.equal(fake.signals.state.aborted, false)
  assert.equal(fake.signals.event.aborted, false)
  index.stop('s1')
  assert.equal(fake.signals.state.aborted, true)
  assert.equal(fake.signals.event.aborted, true)

  fake.channel('state').push({ running: false, queue: [] })
  fake.channel('event').push(eventFrame(directEvent()))
  await delay(30)

  assert.deepEqual(store.rows(), [])
  assert.equal(store.writeCount(), 0)
})

test('listRecent prunes rows older than 30 days and returns newest first', async () => {
  const { store, index } = setup()
  const day = 86400000
  await store.upsertPromptLog(WORKSPACE, [
    { messageId: 'old', sessionId: 's1', time: NOW - 40 * day, localDate: '2026-09-27', status: 'sent' },
    { messageId: 'recent', sessionId: 's1', time: NOW - 2 * day, localDate: '2026-11-04', status: 'sent' },
    { messageId: 'newest', sessionId: 's1', time: NOW, localDate: '2026-11-06', status: 'sent' },
  ])

  const rows = await index.listRecent(WORKSPACE)
  assert.deepEqual(rows.map(row => row.messageId), ['newest', 'recent'])
  assert.deepEqual(store.rows().map(row => row.messageId).sort(), ['newest', 'recent'])
})

test('listRecent shows only the newest 20 rows', async () => {
  const { store, index } = setup()
  const seeded = Array.from({ length: 25 }, (_, i) => ({
    messageId: `m${i}`,
    sessionId: 's1',
    time: NOW - i * 1000,
    localDate: '2026-11-06',
    status: 'sent',
  }))
  await store.upsertPromptLog(WORKSPACE, seeded)

  const rows = await index.listRecent(WORKSPACE)
  assert.equal(rows.length, 20)
  assert.equal(rows[0].messageId, 'm0')
  assert.equal(rows[19].messageId, 'm19')
})

test('listRecent accepts a query object and filters rows to the requested session', async () => {
  const { store, index } = setup()
  await store.upsertPromptLog(WORKSPACE, [
    { messageId: 'a', sessionId: 's1', time: NOW, localDate: '2026-11-06', status: 'sent' },
    { messageId: 'b', sessionId: 's2', time: NOW - 1000, localDate: '2026-11-06', status: 'sent' },
    { messageId: 'c', sessionId: 's1', time: NOW - 2000, localDate: '2026-11-06', status: 'sent' },
  ])

  const rows = await index.listRecent({ sessionId: 's1', limit: 10 })
  assert.deepEqual(rows.map(row => row.messageId), ['a', 'c'])
})

test('listRecent honors a custom limit for object queries', async () => {
  const { store, index } = setup()
  await store.upsertPromptLog(WORKSPACE, Array.from({ length: 5 }, (_, i) => ({
    messageId: `m${i}`,
    sessionId: 's1',
    time: NOW - i * 1000,
    localDate: '2026-11-06',
    status: 'sent',
  })))

  const rows = await index.listRecent({ workspaceKey: WORKSPACE, sessionId: 's1', limit: 2 })
  assert.deepEqual(rows.map(row => row.messageId), ['m0', 'm1'])
})
