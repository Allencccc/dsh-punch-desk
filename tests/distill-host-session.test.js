// tests/distill-host-session.test.js
// Task 2.1 — read-only session history adapter (Host).
// Contract: lead adjudication 2026-11-11 — readSessionHistory passes the RAW
// sessionQuery.readSession event stream through ({sessionId, archived, events});
// turn derivation belongs to the material domain (Task 1.1, spec §6.3).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DISTILL_ERROR_CODES,
  DistillHostError,
  assertDistillWorkspaceId,
  resolveDistillWorkspaceDir,
  readSessionHistory,
} from '../src/store/distill-host.js'

const CODES = DISTILL_ERROR_CODES

/* ----------------------------- fixtures ----------------------------- */

function tmpDir(t, prefix = 'pd-distill-session-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Simple ctx mock: services reachable only through ctx.get (AGENTS §4). */
function makeCtx(services) {
  const calls = []
  return {
    calls,
    get(name) {
      calls.push(name)
      return services[name]
    },
  }
}

/**
 * Strict Cordis context mock (mirrors tests/store-host-rpc.test.js): real
 * contexts are Proxies that throw for every service property outside the
 * inject list. Any direct `ctx.sessionQuery` / `ctx.remote` read must fail.
 */
function makeStrictCtx(services) {
  const target = {
    get(name) {
      return services[name]
    },
  }
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === 'string' && !(prop in t)) {
        throw new Error(`cannot get property "${prop}" without inject`)
      }
      return Reflect.get(t, prop, receiver)
    },
  })
}

/** Raw event stream in the verified Host shape (AGENTS §5, SessionEventMap). */
function buildEvents() {
  let seq = 0
  const ev = (type, data) => ({ type, seq: ++seq, time: 1700000000000 + seq, data })
  return [
    ev('turn/start', { turn: 1 }),
    ev('user/message', {
      id: 'm-1', role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: '第一个问题' }],
    }),
    ev('step/start', { turn: 1, step: 1 }),
    ev('assistant/message', {
      turn: 1, step: 1,
      message: { id: 'm-2', role: 'assistant', content: [{ type: 'text', text: '第一个回答' }] },
      stream: [],
    }),
    ev('step/end', { turn: 1, step: 1 }),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ev('turn/start', { turn: 2 }),
    ev('user/message', {
      id: 'm-3', role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: '第二个问题' }],
    }),
    ev('tool/call', { turn: 2, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' }),
    ev('tool/result', {
      turn: 2, step: 1,
      message: { id: 'm-4', role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'file list' }] },
    }),
    ev('assistant/message', {
      turn: 2, step: 1,
      message: { id: 'm-5', role: 'assistant', content: [{ type: 'text', text: '被中断的回答' }] },
      stream: [], interrupted: true,
    }),
    ev('assistant/message', {
      turn: 2, step: 2,
      message: { id: 'm-6', role: 'assistant', content: [{ type: 'text', text: '最终回答' }] },
      stream: [],
    }),
    ev('turn/end', { turn: 2, reason: { kind: 'completed' } }),
  ]
}

function buildSnapshot(sessionId, cwd, events = buildEvents()) {
  return {
    session: { version: 1, id: sessionId, createdAt: 1700000000000, cwd, isSeeded: false },
    inheritedEventCount: 0,
    events,
  }
}

/** sessionQuery mock recording every readSession call. */
function makeSessionQuery(snapshotOrHandler) {
  const calls = []
  return {
    calls,
    async readSession(sessionId) {
      calls.push(sessionId)
      if (typeof snapshotOrHandler === 'function') return snapshotOrHandler(sessionId)
      return snapshotOrHandler
    },
  }
}

function makeRegistry(workspaces, archivedSessionIds = []) {
  const gets = []
  return {
    gets,
    get(id) {
      gets.push(id)
      return workspaces.find(w => w.id === id)
    },
    archivedSessionIds,
  }
}

/** Happy-path setup: one workspace dir, one session belonging to it. */
function setup(t, { archived = false } = {}) {
  const wsDir = tmpDir(t)
  const events = buildEvents()
  const snapshot = buildSnapshot('s-1', wsDir, events)
  const sessionQuery = makeSessionQuery(snapshot)
  const workspaceRegistry = makeRegistry(
    [{ id: 'ws-1', path: wsDir, title: 'Workspace 1', sessionIds: ['s-1'] }],
    archived ? ['s-1'] : [],
  )
  const ctx = makeCtx({ sessionQuery, workspaceRegistry })
  return { wsDir, events, snapshot, sessionQuery, workspaceRegistry, ctx }
}

/* --------------------------- normal reads --------------------------- */

test('readSessionHistory returns {sessionId, archived, events} for a session in the workspace', async (t) => {
  const { ctx, sessionQuery, workspaceRegistry } = setup(t)

  const history = await readSessionHistory(ctx, { workspaceId: 'ws-1', sessionId: 's-1' })

  assert.deepEqual(Object.keys(history).sort(), ['archived', 'events', 'sessionId'])
  assert.equal(history.sessionId, 's-1')
  assert.equal(history.archived, false)
  assert.deepEqual(history.events, buildEvents())
  assert.deepEqual(sessionQuery.calls, ['s-1'], 'readSession called exactly once with the sessionId')
  assert.deepEqual(workspaceRegistry.gets, ['ws-1'])
  assert.ok(ctx.calls.includes('sessionQuery'), 'sessionQuery reached through ctx.get')
  assert.ok(ctx.calls.includes('workspaceRegistry'), 'workspaceRegistry reached through ctx.get')
})

test('event stream is passed through untouched: no flattening, turn/end and tool events preserved', async (t) => {
  const { ctx, events } = setup(t)

  const history = await readSessionHistory(ctx, { workspaceId: 'ws-1', sessionId: 's-1' })

  // Same array reference: the adapter neither copies nor rewrites the stream.
  assert.equal(history.events, events)
  const types = history.events.map(e => e.type)
  assert.deepEqual(types, [
    'turn/start', 'user/message', 'step/start', 'assistant/message', 'step/end', 'turn/end',
    'turn/start', 'user/message', 'tool/call', 'tool/result', 'assistant/message', 'assistant/message', 'turn/end',
  ])
  // AGENTS §5 shapes survive: user/message data IS the UserMessage (no wrapper).
  const userEvent = history.events.find(e => e.type === 'user/message')
  assert.equal(userEvent.data.id, 'm-1')
  assert.equal(userEvent.data.role, 'user')
  assert.equal(userEvent.data.message, undefined)
  // assistant/message keeps turn/step/interrupted on data.
  const interrupted = history.events.find(e => e.type === 'assistant/message' && e.data.interrupted === true)
  assert.equal(interrupted.data.message.id, 'm-5')
  assert.equal(interrupted.data.turn, 2)
  // Every event keeps its raw envelope.
  for (const event of history.events) {
    assert.equal(typeof event.type, 'string')
    assert.equal(typeof event.seq, 'number')
    assert.equal(typeof event.time, 'number')
    assert.ok(event.data && typeof event.data === 'object')
  }
})

test('workspaceId is trimmed before resolution', async (t) => {
  const { ctx, workspaceRegistry } = setup(t)
  const history = await readSessionHistory(ctx, { workspaceId: '  ws-1  ', sessionId: 's-1' })
  assert.equal(history.sessionId, 's-1')
  assert.deepEqual(workspaceRegistry.gets, ['ws-1'])
})

test('a genuinely empty session returns empty events (not an error, not fabricated material)', async (t) => {
  const wsDir = tmpDir(t)
  const sessionQuery = makeSessionQuery(buildSnapshot('s-empty', wsDir, []))
  const workspaceRegistry = makeRegistry([{ id: 'ws-1', path: wsDir }])
  const ctx = makeCtx({ sessionQuery, workspaceRegistry })

  const history = await readSessionHistory(ctx, { workspaceId: 'ws-1', sessionId: 's-empty' })
  assert.deepEqual(history, { sessionId: 's-empty', archived: false, events: [] })
})

/* ------------------------- workspaceId safety ------------------------ */

test('invalid workspaceId is rejected before any session read', async (t) => {
  const { ctx, sessionQuery } = setup(t)
  for (const workspaceId of [undefined, null, '', '   ', 42, {}, []]) {
    await assert.rejects(
      readSessionHistory(ctx, { workspaceId, sessionId: 's-1' }),
      { code: CODES.INVALID_WORKSPACE_ID },
      `workspaceId ${JSON.stringify(workspaceId)} must be rejected`,
    )
  }
  assert.deepEqual(sessionQuery.calls, [], 'no material read may happen before workspace validation')
})

test('the implicit "default" workspaceId is rejected even when the registry knows it', async (t) => {
  const { sessionQuery } = setup(t)
  // Register a real 'default' workspace pointing at a real directory.
  const wsDir = tmpDir(t)
  const registry = makeRegistry([{ id: 'default', path: wsDir }])
  const strictCtx = makeCtx({ sessionQuery, workspaceRegistry: registry })
  for (const workspaceId of ['default', 'DEFAULT', ' Default ']) {
    await assert.rejects(
      readSessionHistory(strictCtx, { workspaceId, sessionId: 's-1' }),
      { code: CODES.INVALID_WORKSPACE_ID },
    )
  }
  assert.deepEqual(sessionQuery.calls, [])
  assert.equal(assertDistillWorkspaceId(' ws-9 '), 'ws-9')
  assert.throws(() => assertDistillWorkspaceId('default'), { code: CODES.INVALID_WORKSPACE_ID })
})

test('no process.cwd() fallback: unresolvable workspace fails even when session cwd equals process.cwd()', async (t) => {
  // The session lives in the process working directory, but no workspace
  // source is supplied. The adapter must NOT resolve via process.cwd().
  const sessionQuery = makeSessionQuery(buildSnapshot('s-1', process.cwd()))
  const ctx = makeCtx({ sessionQuery })
  await assert.rejects(
    readSessionHistory(ctx, { workspaceId: 'ws-1', sessionId: 's-1' }),
    { code: CODES.WORKSPACE_UNAVAILABLE },
  )
  assert.deepEqual(sessionQuery.calls, [], 'history is not read when the workspace cannot be attributed')
})

test('WORKSPACE_UNAVAILABLE for unknown workspace id or missing directory', async (t) => {
  const { ctx, sessionQuery } = setup(t)
  await assert.rejects(
    readSessionHistory(ctx, { workspaceId: 'ws-unknown', sessionId: 's-1' }),
    { code: CODES.WORKSPACE_UNAVAILABLE },
  )

  const goneDir = path.join(tmpDir(t), 'deleted')
  fs.mkdirSync(goneDir)
  const registry = makeRegistry([{ id: 'ws-gone', path: goneDir }])
  fs.rmSync(goneDir, { recursive: true, force: true })
  const ctx2 = makeCtx({ sessionQuery, workspaceRegistry: registry })
  await assert.rejects(
    readSessionHistory(ctx2, { workspaceId: 'ws-gone', sessionId: 's-1' }),
    { code: CODES.WORKSPACE_UNAVAILABLE },
  )
  assert.deepEqual(sessionQuery.calls, [])
})

/* ------------------------ service / read failures ------------------- */

test('missing sessionQuery service → SESSION_QUERY_UNAVAILABLE (no fabricated empty material)', async (t) => {
  const wsDir = tmpDir(t)
  const workspaceRegistry = makeRegistry([{ id: 'ws-1', path: wsDir }])
  const ctx = makeCtx({ workspaceRegistry })
  await assert.rejects(
    readSessionHistory(ctx, { workspaceId: 'ws-1', sessionId: 's-1' }),
    (error) => {
      assert.ok(error instanceof DistillHostError)
      assert.equal(error.code, CODES.SESSION_QUERY_UNAVAILABLE)
      return true
    },
  )
})

test('strict Cordis context without sessionQuery, and a service without readSession, both → SESSION_QUERY_UNAVAILABLE', async (t) => {
  const wsDir = tmpDir(t)
  const workspaceRegistry = makeRegistry([{ id: 'ws-1', path: wsDir }])

  // ctx.get itself throws for unknown services on some builds; the adapter
  // must contain that through try/catch (AGENTS §4).
  const throwingCtx = {
    get(name) {
      if (name === 'workspaceRegistry') return workspaceRegistry
      throw new Error(`cannot get property "${name}" without inject`)
    },
  }
  await assert.rejects(
    readSessionHistory(throwingCtx, { workspaceId: 'ws-1', sessionId: 's-1' }),
    { code: CODES.SESSION_QUERY_UNAVAILABLE },
  )

  const strictCtx = makeStrictCtx({ workspaceRegistry, sessionQuery: {} })
  await assert.rejects(
    readSessionHistory(strictCtx, { workspaceId: 'ws-1', sessionId: 's-1' }),
    { code: CODES.SESSION_QUERY_UNAVAILABLE },
  )
})

test('session not found → SESSION_NOT_FOUND with the platform cause preserved', async (t) => {
  const { ctx, workspaceRegistry } = setup(t)
  const platformError = Object.assign(new Error('session was not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
  const sessionQuery = makeSessionQuery(() => { throw platformError })
  const ctx2 = makeCtx({ sessionQuery, workspaceRegistry })

  await assert.rejects(
    readSessionHistory(ctx2, { workspaceId: 'ws-1', sessionId: 's-missing' }),
    (error) => {
      assert.equal(error.code, CODES.SESSION_NOT_FOUND)
      assert.equal(error.cause, platformError)
      assert.equal(error.details.sessionId, 's-missing')
      return true
    },
  )
})

test('other platform read failures → SESSION_READ_FAILED with cause (never empty material)', async (t) => {
  const { ctx, workspaceRegistry } = setup(t)
  const platformError = Object.assign(new Error('session event history is corrupt'), { code: 'SESSION_QUERY_CORRUPT_SESSION' })
  const sessionQuery = makeSessionQuery(() => { throw platformError })
  const ctx2 = makeCtx({ sessionQuery, workspaceRegistry })

  await assert.rejects(
    readSessionHistory(ctx2, { workspaceId: 'ws-1', sessionId: 's-1' }),
    (error) => {
      assert.equal(error.code, CODES.SESSION_READ_FAILED)
      assert.equal(error.cause, platformError)
      return true
    },
  )
})

test('invalid snapshot shapes → SESSION_READ_FAILED', async (t) => {
  const { workspaceRegistry, wsDir } = setup(t)
  const badSnapshots = [
    undefined,
    null,
    { session: { id: 's-1', cwd: wsDir } }, // events missing
    { session: { id: 's-1', cwd: wsDir }, events: 'not-an-array' },
    { session: { id: 'another-session', cwd: wsDir }, events: [] }, // id mismatch
  ]
  for (const snapshot of badSnapshots) {
    const sessionQuery = makeSessionQuery(snapshot)
    const ctx = makeCtx({ sessionQuery, workspaceRegistry })
    await assert.rejects(
      readSessionHistory(ctx, { workspaceId: 'ws-1', sessionId: 's-1' }),
      { code: CODES.SESSION_READ_FAILED },
    )
  }
})

test('empty or non-string sessionId → INVALID_SESSION_ID', async (t) => {
  const { ctx, sessionQuery } = setup(t)
  for (const sessionId of [undefined, null, '', '   ', 7]) {
    await assert.rejects(
      readSessionHistory(ctx, { workspaceId: 'ws-1', sessionId }),
      { code: CODES.INVALID_SESSION_ID },
    )
  }
  assert.deepEqual(sessionQuery.calls, [])
})

/* ------------------------- attribution checks ----------------------- */

test('session from another workspace → SESSION_WORKSPACE_MISMATCH', async (t) => {
  const { ctx, workspaceRegistry } = setup(t)
  const foreignDir = tmpDir(t, 'pd-distill-foreign-')
  const sessionQuery = makeSessionQuery(buildSnapshot('s-foreign', foreignDir))
  const ctx2 = makeCtx({ sessionQuery, workspaceRegistry })

  await assert.rejects(
    readSessionHistory(ctx2, { workspaceId: 'ws-1', sessionId: 's-foreign' }),
    (error) => {
      assert.equal(error.code, CODES.SESSION_WORKSPACE_MISMATCH)
      assert.deepEqual(error.details, { sessionId: 's-foreign', workspaceId: 'ws-1' })
      return true
    },
  )
})

test('session without cwd cannot be attributed → SESSION_WORKSPACE_MISMATCH (fail closed)', async (t) => {
  const { ctx, workspaceRegistry } = setup(t)
  const snapshot = buildSnapshot('s-1', undefined)
  delete snapshot.session.cwd
  const sessionQuery = makeSessionQuery(snapshot)
  const ctx2 = makeCtx({ sessionQuery, workspaceRegistry })
  await assert.rejects(
    readSessionHistory(ctx2, { workspaceId: 'ws-1', sessionId: 's-1' }),
    { code: CODES.SESSION_WORKSPACE_MISMATCH },
  )
})

test('symlinked workspace path and real session cwd still match (canonical comparison)', async (t) => {
  const realDir = tmpDir(t, 'pd-distill-real-')
  const linkParent = tmpDir(t, 'pd-distill-link-')
  const linkPath = path.join(linkParent, 'workspace-link')
  fs.symlinkSync(realDir, linkPath, 'dir')

  // Registry knows the symlink spelling; the session header uses the real one.
  const workspaceRegistry = makeRegistry([{ id: 'ws-1', path: linkPath }])
  const sessionQuery = makeSessionQuery(buildSnapshot('s-1', realDir))
  const ctx = makeCtx({ sessionQuery, workspaceRegistry })
  const history = await readSessionHistory(ctx, { workspaceId: 'ws-1', sessionId: 's-1' })
  assert.equal(history.sessionId, 's-1')

  // And the reverse spelling.
  const registry2 = makeRegistry([{ id: 'ws-1', path: realDir }])
  const sessionQuery2 = makeSessionQuery(buildSnapshot('s-1', linkPath))
  const ctx2 = makeCtx({ sessionQuery: sessionQuery2, workspaceRegistry: registry2 })
  const history2 = await readSessionHistory(ctx2, { workspaceId: 'ws-1', sessionId: 's-1' })
  assert.equal(history2.sessionId, 's-1')
})

/* --------------------------- archive handling ----------------------- */

test('archived session history stays readable and is flagged archived:true', async (t) => {
  const { ctx, sessionQuery, events } = setup(t, { archived: true })
  const history = await readSessionHistory(ctx, { workspaceId: 'ws-1', sessionId: 's-1' })
  assert.equal(history.archived, true)
  assert.equal(history.events, events)
  assert.deepEqual(sessionQuery.calls, ['s-1'], 'archive state never gates readSession')
})

test('archive projection degrades to false when registry/field is unavailable or hostile', async (t) => {
  const wsDir = tmpDir(t)
  const sessionQuery = makeSessionQuery(buildSnapshot('s-1', wsDir))

  // No registry at all.
  const ctx1 = makeCtx({ sessionQuery })
  const h1 = await readSessionHistory(ctx1, { workspaceId: 'ws-1', sessionId: 's-1' }, {
    workspaces: [{ id: 'ws-1', path: wsDir }],
  })
  assert.equal(h1.archived, false)

  // Registry without the archive field.
  const ctx2 = makeCtx({ sessionQuery, workspaceRegistry: makeRegistry([{ id: 'ws-1', path: wsDir }]) })
  delete ctx2.get('workspaceRegistry').archivedSessionIds
  const h2 = await readSessionHistory(ctx2, { workspaceId: 'ws-1', sessionId: 's-1' })
  assert.equal(h2.archived, false)

  // Throwing getter (registry not initialized yet).
  const hostileRegistry = {
    get: id => ({ id, path: wsDir }),
    get archivedSessionIds() { throw new Error('registry not initialized') },
  }
  const ctx3 = makeCtx({ sessionQuery, workspaceRegistry: hostileRegistry })
  const h3 = await readSessionHistory(ctx3, { workspaceId: 'ws-1', sessionId: 's-1' })
  assert.equal(h3.archived, false)

  // Non-array archive value.
  const ctx4 = makeCtx({
    sessionQuery,
    workspaceRegistry: { get: id => ({ id, path: wsDir }), archivedSessionIds: 's-1' },
  })
  const h4 = await readSessionHistory(ctx4, { workspaceId: 'ws-1', sessionId: 's-1' })
  assert.equal(h4.archived, false)
})

/* ---------------------- workspace resolution paths ------------------ */

test('workspace resolves through hostStore workspaceRecords when the registry is missing', async (t) => {
  const wsDir = tmpDir(t)
  const sessionQuery = makeSessionQuery(buildSnapshot('s-1', wsDir))
  const hostStore = {
    async listWorkspaceRecords() {
      return [{ id: 'ws-1', name: 'WS', path: wsDir, status: 'active' }]
    },
  }
  const ctx = makeCtx({ sessionQuery, hostStore })
  const history = await readSessionHistory(ctx, { workspaceId: 'ws-1', sessionId: 's-1' })
  assert.equal(history.sessionId, 's-1')
  assert.equal(history.archived, false)
})

test('explicit workspaces array resolves; registry takes priority over hostStore records', async (t) => {
  const wsDir = tmpDir(t)
  const otherDir = tmpDir(t, 'pd-distill-other-')
  const sessionQuery = makeSessionQuery(buildSnapshot('s-1', wsDir))

  // Explicit array only (embedded/test callers).
  const ctx1 = makeCtx({ sessionQuery })
  const h1 = await readSessionHistory(ctx1, { workspaceId: 'ws-1', sessionId: 's-1' }, {
    workspaces: [{ id: 'ws-1', path: wsDir }],
  })
  assert.equal(h1.sessionId, 's-1')

  // Registry path wins over a conflicting hostStore record.
  const registry = makeRegistry([{ id: 'ws-1', path: wsDir }])
  const hostStore = { async listWorkspaceRecords() { return [{ id: 'ws-1', path: otherDir }] } }
  const ctx2 = makeCtx({ sessionQuery, workspaceRegistry: registry, hostStore })
  const h2 = await readSessionHistory(ctx2, { workspaceId: 'ws-1', sessionId: 's-1' })
  assert.equal(h2.sessionId, 's-1')
  assert.equal(await resolveDistillWorkspaceDir('ws-1', { workspaceRegistry: registry, hostStore }), wsDir)
})

/* ------------------------- Cordis discipline ------------------------ */

test('full read succeeds on a strict Cordis Proxy context (no direct service property reads)', async (t) => {
  const wsDir = tmpDir(t)
  const events = buildEvents()
  const sessionQuery = makeSessionQuery(buildSnapshot('s-1', wsDir, events))
  const workspaceRegistry = makeRegistry([{ id: 'ws-1', path: wsDir }], ['s-1'])
  const strictCtx = makeStrictCtx({ sessionQuery, workspaceRegistry })

  const history = await readSessionHistory(strictCtx, { workspaceId: 'ws-1', sessionId: 's-1' })
  assert.equal(history.sessionId, 's-1')
  assert.equal(history.archived, true)
  assert.equal(history.events, events)
})

test('module source obeys the Host hard constraints (no ctx?./ctx.remote/child_process/process.cwd)', async () => {
  const modulePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'store', 'distill-host.js')
  const source = fs.readFileSync(modulePath, 'utf8')
  // Strip comments so documentation mentions do not trip the guard.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.equal(/ctx\?\./.test(code), false, 'optional chaining on ctx is forbidden (AGENTS §4)')
  assert.equal(/ctx\.remote/.test(code), false, 'Host half has no remote service')
  assert.equal(/ctx\.(sessionQuery|workspaceRegistry|hostStore)\b/.test(code), false, 'services must go through ctx.get')
  assert.equal(/child_process/.test(code), false, 'distill files never execute commands (spec §16.11)')
  assert.equal(/process\.cwd/.test(code), false, 'no process.cwd() fallback (spec §14.1)')
})
