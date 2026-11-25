import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BACKFILL_LIMIT, backfillSession, entriesFromEvents,
} from '../src/client/platform/backfill.js'

const WORKSPACE = 'session:s1'
const NOW = Date.UTC(2026, 10, 6, 3, 0, 0)

/**
 * @param {string} type
 * @param {number} seq
 * @param {object} data
 * @returns {object} one SessionWireEvent
 */
function event(type, seq, data) {
  return { type, seq, time: NOW + seq * 1000, data }
}

/**
 * @param {string} id
 * @param {object} [over]
 * @returns {object}
 */
function message(id, over = {}) {
  return {
    id,
    role: 'user',
    source: { kind: 'user', rpcId: `rpc-${id}` },
    content: [{ type: 'text', text: `text ${id}` }],
    ...over,
  }
}

/** @param {object} ev @returns {object} the shipped `{ type: 'event', event }` record */
function record(ev) {
  return { type: 'event', event: ev }
}

/** @param {...object} events @returns {object} a successful `session.events` RemoteResult */
function page(...events) {
  return { ok: true, value: { cursor: 42, records: events.map(record), hasMore: false } }
}

/** @param {...object} events @returns {object} a raw page for older hosts/test doubles */
function rawPage(...events) {
  return { cursor: 42, records: events.map(record), hasMore: false }
}

/**
 * In-memory desk store limited to the prompt-log surface the backfill uses.
 * @param {object[]} [initial]
 */
function createFakeStore(initial = []) {
  const rows = new Map(initial.map(row => [row.messageId, { ...row }]))
  const calls = []
  return {
    async listPromptLog(workspaceKey) {
      calls.push(['list', workspaceKey])
      return [...rows.values()].map(row => ({ ...row }))
    },
    async upsertPromptLog(workspaceKey, entries) {
      calls.push(['upsert', workspaceKey, entries])
      for (const entry of entries) {
        rows.set(entry.messageId, { ...rows.get(entry.messageId), ...entry })
      }
    },
    rows: () => [...rows.values()]
      .map(row => ({ ...row }))
      .sort((left, right) => left.time - right.time),
    upserts: () => calls.filter(call => call[0] === 'upsert'),
    calls,
  }
}

/**
 * Fake remote exposing only the history method under test.
 * @param {{ events?: object|Error|Function, follow?: Function }} [options]
 */
function createRemote({ events, follow } = {}) {
  const calls = []
  const session = {}
  if (events !== undefined) {
    session.events = async (request, signal) => {
      calls.push(['events', request, signal])
      if (events instanceof Error) throw events
      return typeof events === 'function' ? events(request, signal) : events
    }
  }
  if (follow !== undefined) {
    session.follow = (request, signal) => {
      calls.push(['follow', request, signal])
      return follow(request, signal)
    }
  }
  return { remote: { session }, calls }
}

function run(store, remote, over = {}) {
  return backfillSession({
    sessionId: 's1',
    workspaceKey: WORKSPACE,
    remote,
    store,
    timeZone: 'UTC',
    ...over,
  })
}

test('backfills direct and wrapped user messages, inheriting the turn from turn/start', async () => {
  const store = createFakeStore()
  const { remote, calls } = createRemote({
    events: page(
      event('turn/start', 1, { turn: 3 }),
      event('user/message', 2, message('m1')),
      event('user/message', 3, { message: message('m2'), turn: 3 }),
      event('turn/end', 4, { turn: 3 }),
    ),
  })

  const result = await run(store, remote)
  assert.equal(result.ok, true)
  assert.equal(result.fetched, 2)
  assert.equal(result.inserted, 2)
  assert.equal(result.updated, 0)
  assert.equal(result.skipped, 0)
  assert.equal(result.cursor, 42)

  const rows = store.rows()
  assert.deepEqual(rows.map(row => row.messageId), ['m1', 'm2'])
  assert.deepEqual(rows.map(row => row.turn), [3, 3])
  assert.deepEqual(rows.map(row => row.status), ['completed', 'completed'])
  assert.equal(rows[0].excerpt, 'text m1')
  assert.equal(rows[0].localDate, '2026-11-06')
  assert.equal(rows[0].clientTimeZone, 'UTC')
  assert.equal(rows[0].source, 'history')
  assert.equal(rows[0].requestId, 'rpc-m1')
  assert.equal(rows[0].workspaceKey, WORKSPACE)

  assert.deepEqual(calls[0], ['events', {
    address: { kind: 'session', sessionId: 's1' },
    maxMessages: BACKFILL_LIMIT,
  }, undefined])
})

test('unwraps the generated RemoteResult envelope', async () => {
  const store = createFakeStore()
  const { remote } = createRemote({
    events: {
      ok: true,
      value: {
        cursor: 11,
        records: [
          record(event('turn/start', 1, { turn: 2 })),
          record(event('user/message', 2, message('m1'))),
        ],
        hasMore: false,
      },
    },
  })

  const result = await run(store, remote)
  assert.equal(result.ok, true)
  assert.equal(result.cursor, 11)
  assert.equal(result.fetched, 1)
  assert.deepEqual(store.rows().map(row => row.messageId), ['m1'])
})

test('a failed RemoteResult is a history failure, not an empty success', async () => {
  const store = createFakeStore([{
    messageId: 'old',
    sessionId: 's1',
    workspaceKey: WORKSPACE,
    time: NOW,
    localDate: '2026-11-06',
    excerpt: 'old row',
    status: 'completed',
  }])
  const warnings = []
  const { remote } = createRemote({
    events: { ok: false, error: { code: 'unavailable', message: 'gateway down' } },
  })

  let result
  await assert.doesNotReject(async () => {
    result = await run(store, remote, { onWarn: (message, error) => warnings.push([message, error]) })
  })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'history-failed')
  assert.equal(result.fetched, 0)
  assert.deepEqual(store.rows().map(row => row.messageId), ['old'])
  assert.equal(store.upserts().length, 0)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0][0], /history read failed/)
  assert.equal(warnings[0][1].message, 'gateway down')
})

test('an empty or missing RemoteResult is a failure rather than a silent no-op', async () => {
  const store = createFakeStore()
  for (const events of [null, () => undefined]) {
    const { remote } = createRemote({ events })
    const result = await run(store, remote, { onWarn: () => {} })
    assert.equal(result.ok, false, `events=${String(events)}`)
    assert.equal(result.error, 'history-failed')
    assert.equal(result.fetched, 0)
  }
})

test('accepts a raw page shape for older hosts', async () => {
  const store = createFakeStore()
  const { remote } = createRemote({
    events: rawPage(
      event('turn/start', 1, { turn: 1 }),
      event('user/message', 2, message('m1')),
    ),
  })

  const result = await run(store, remote)
  assert.equal(result.ok, true)
  assert.equal(result.cursor, 42)
  assert.equal(result.fetched, 1)
  assert.deepEqual(store.rows().map(row => row.messageId), ['m1'])
})

test('passes the caller signal to the history request', async () => {
  const store = createFakeStore()
  const controller = new AbortController()
  let seen
  const { remote } = createRemote({
    events: (request, signal) => {
      seen = signal
      return rawPage(event('user/message', 1, message('m1')))
    },
  })

  const result = await run(store, remote, { signal: controller.signal })
  assert.equal(result.ok, true)
  assert.equal(seen, controller.signal)
})

test('an aborted read reports aborted and does not warn', async () => {
  const store = createFakeStore()
  const controller = new AbortController()
  controller.abort()
  const warnings = []
  const { remote, calls } = createRemote({
    events: () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    },
  })

  const result = await run(store, remote, {
    signal: controller.signal,
    onWarn: (...args) => warnings.push(args),
  })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'aborted')
  assert.equal(result.aborted, true)
  assert.deepEqual(calls, [])
  assert.deepEqual(warnings, [])
})

test('accepts raw event records and indexes only genuine user-authored messages', async () => {
  const store = createFakeStore()
  const { remote } = createRemote({
    events: {
      cursor: 9,
      records: [
        event('turn/start', 1, { turn: 1 }),
        event('user/message', 2, message('m1')),
        event('assistant/message', 3, { message: { id: 'a1', role: 'assistant', content: [] } }),
        event('user/message', 4, message('synthetic', { source: { kind: 'synthetic' } })),
        event('user/message', 5, message('subagent', { source: { kind: 'subagent' } })),
        event('user/message', 6, message('command', { source: { kind: 'command' } })),
        event('user/message', 7, { message: { source: { kind: 'user' }, content: [] } }),
        null,
        { type: 'event' },
        { type: 'user/message' },
      ],
    },
  })

  const result = await run(store, remote)
  assert.equal(result.ok, true)
  assert.equal(result.fetched, 1)
  assert.deepEqual(store.rows().map(row => row.messageId), ['m1'])
})

test('skips a single malformed user message instead of throwing the whole page', async () => {
  const store = createFakeStore()
  const { remote } = createRemote({
    events: page(
      event('turn/start', 1, { turn: 1 }),
      event('user/message', 2, message('bad', { content: 'not-an-array' })),
      event('user/message', 3, message('good')),
      event('user/message', 4, { message: { id: 'no-content', role: 'user', source: { kind: 'user' }, content: 42 } }),
      event('turn/end', 5, { turn: 1 }),
    ),
  })

  let result
  await assert.doesNotReject(async () => { result = await run(store, remote) })
  assert.equal(result.ok, true)
  assert.equal(result.fetched, 1)
  assert.deepEqual(store.rows().map(row => row.messageId), ['good'])
  assert.equal(store.rows()[0].status, 'completed')
})

test('entriesFromEvents never throws on a malformed user message', () => {
  const entries = entriesFromEvents({
    events: [
      event('user/message', 1, message('bad', { content: 'not-an-array' })),
      event('user/message', 2, message('good')),
    ],
    sessionId: 's1',
    workspaceKey: WORKSPACE,
    timeZone: 'UTC',
  })
  assert.deepEqual(entries.map(entry => entry.messageId), ['good'])
})

test('repeated backfill is idempotent by messageId', async () => {
  const store = createFakeStore()
  const { remote } = createRemote({
    events: page(
      event('turn/start', 1, { turn: 1 }),
      event('user/message', 2, message('m1')),
      event('turn/end', 3, { turn: 1 }),
    ),
  })

  const first = await run(store, remote)
  assert.equal(first.inserted, 1)

  const second = await run(store, remote)
  assert.equal(second.ok, true)
  assert.equal(second.inserted, 0)
  assert.equal(second.updated, 0)
  assert.equal(second.skipped, 1)
  assert.equal(store.rows().length, 1)
  // The unchanged re-read does not write again.
  assert.equal(store.upserts().length, 1)
})

test('keeps only the newest limit rows', async () => {
  const store = createFakeStore()
  const events = [
    event('turn/start', 0, { turn: 1 }),
    ...Array.from({ length: 5 }, (_, index) => event('user/message', index + 1, message(`m${index + 1}`))),
    event('turn/end', 6, { turn: 1 }),
  ]
  const { remote } = createRemote({ events: page(...events) })

  const result = await run(store, remote, { limit: 2 })
  assert.equal(result.fetched, 2)
  assert.deepEqual(store.rows().map(row => row.messageId), ['m4', 'm5'])
  assert.deepEqual(store.rows().map(row => row.status), ['completed', 'completed'])
})

test('caps entries at the default limit for a very large page', () => {
  const events = [
    event('turn/start', 0, { turn: 1 }),
    ...Array.from({ length: BACKFILL_LIMIT + 5 }, (_, index) => event(
      'user/message',
      index + 1,
      message(`m${index + 1}`),
    )),
  ]
  const entries = entriesFromEvents({
    events,
    sessionId: 's1',
    workspaceKey: WORKSPACE,
    timeZone: 'UTC',
  })
  assert.equal(entries.length, BACKFILL_LIMIT)
  assert.equal(entries[0].messageId, 'm6')
  assert.equal(entries.at(-1).messageId, `m${BACKFILL_LIMIT + 5}`)
})

test('a failed history call is a no-op that keeps already-indexed rows', async () => {
  const existing = {
    messageId: 'old',
    sessionId: 's1',
    workspaceKey: WORKSPACE,
    time: NOW,
    localDate: '2026-11-06',
    excerpt: 'old row',
    source: 'composer',
    status: 'completed',
  }
  const store = createFakeStore([existing])
  const { remote } = createRemote({ events: new Error('gateway down') })

  let result
  await assert.doesNotReject(async () => { result = await run(store, remote, { onWarn: () => {} }) })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'history-failed')
  assert.deepEqual(store.rows().map(row => row.messageId), ['old'])
  assert.equal(store.upserts().length, 0)
})

test('falls back to the follow opening when events is unavailable', async () => {
  const store = createFakeStore()
  let signal
  async function* follow(_request, streamSignal) {
    signal = streamSignal
    yield {
      type: 'snapshot',
      cursor: 7,
      header: { id: 's1' },
      records: [
        record(event('turn/start', 1, { turn: 1 })),
        record(event('user/message', 2, message('m1'))),
      ],
      hasMore: false,
    }
    // A live tail must never be consumed: the backfill reads one opening only.
    yield { type: 'event', event: event('user/message', 3, message('m2')) }
  }
  const { remote, calls } = createRemote({ follow })

  const result = await run(store, remote)
  assert.equal(result.ok, true)
  assert.equal(result.cursor, 7)
  assert.deepEqual(store.rows().map(row => row.messageId), ['m1'])
  assert.equal(signal.aborted, true)
  assert.equal(calls[0][0], 'follow')
  assert.equal(calls[0][1].maxMessages, BACKFILL_LIMIT)
})

test('a failed follow stream leaves previously backfilled rows intact', async () => {
  const store = createFakeStore([{
    messageId: 'old',
    sessionId: 's1',
    workspaceKey: WORKSPACE,
    time: NOW,
    localDate: '2026-11-06',
    excerpt: 'old row',
    status: 'sent',
  }])
  async function* follow() {
    throw new Error('stream failed')
  }
  const { remote } = createRemote({ follow })

  let result
  await assert.doesNotReject(async () => { result = await run(store, remote, { onWarn: () => {} }) })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'history-failed')
  assert.deepEqual(store.rows().map(row => row.messageId), ['old'])
  assert.equal(store.upserts().length, 0)
})

test('degrades to a no-op when the host exposes no history API', async () => {
  const store = createFakeStore()
  const result = await run(store, { session: {} })
  assert.equal(result.ok, true)
  assert.equal(result.unavailable, true)
  assert.equal(result.fetched, 0)
  assert.equal(store.upserts().length, 0)
})

test('does not downgrade a completed live row or erase its provenance', async () => {
  const store = createFakeStore([{
    messageId: 'm1',
    sessionId: 's1',
    workspaceKey: WORKSPACE,
    time: NOW + 2000,
    localDate: '2026-11-06',
    clientTimeZone: 'UTC',
    turn: 1,
    excerpt: 'old excerpt',
    source: 'desk-batch',
    requestId: 'rpc-m1',
    batchId: 'b1',
    status: 'completed',
  }])
  const { remote } = createRemote({
    events: page(
      event('turn/start', 1, { turn: 1 }),
      event('user/message', 2, message('m1')),
    ),
  })

  const result = await run(store, remote)
  assert.equal(result.ok, true)
  assert.equal(result.updated, 1)
  const row = store.rows()[0]
  assert.equal(row.status, 'completed')
  assert.equal(row.source, 'desk-batch')
  assert.equal(row.batchId, 'b1')
  assert.equal(row.turn, 1)
})

test('rejects missing identifiers and unavailable stores without throwing', async () => {
  await assert.doesNotReject(async () => {
    assert.equal((await run(createFakeStore(), null, { sessionId: '' })).error, 'invalid-arguments')
    assert.equal((await backfillSession()).error, 'invalid-arguments')
    assert.equal((await run(null, { session: {} })).error, 'store-unavailable')
  })
})
