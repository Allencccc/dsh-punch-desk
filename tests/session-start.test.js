import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTO_READY_TIMEOUT_MS, activeWorkspaceIdOf, findPrefilledDraft, gatedUserMessageId, handoffPayload,
  markDraftPrefilled, markDraftStarted, persistStartBehavior, resolveTargetWorkspace, sessionStateReady,
  startBehaviorOf, startFromDraft,
} from '../src/client/platform/session-start.js'
import { createComposerBridge, registerComposerBridge } from '../src/client/ui/composer-bridge.js'
import { startNotice } from '../src/client/ui/draft-editor.js'

const now = () => 5000

function makeDraft(overrides = {}) {
  return {
    id: 'draft-1',
    schemaVersion: 1,
    workspaceKey: 'draft:global',
    kind: 'draft',
    title: 'Plan',
    body: 'Outline the next session',
    status: 'idea',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

function makeStore(drafts = [makeDraft()]) {
  const entries = drafts.slice()
  const handoffs = new Map()
  return {
    entries,
    handoffs,
    async listEntries() { return entries.slice() },
    async putEntry(entry) {
      const index = entries.findIndex(item => item.id === entry.id)
      if (index === -1) entries.push(entry)
      else entries[index] = entry
    },
    async setHandoff(sessionId, value) { handoffs.set(sessionId, value) },
    async getHandoff(sessionId) { return handoffs.get(sessionId) ?? null },
    async deleteHandoff(sessionId) { handoffs.delete(sessionId) },
    subscribe() { return () => {} },
  }
}

function makeWorkspace({ connect, start, open = true, currentWorkspaceId = 'ws-1' } = {}) {
  const calls = []
  const workspace = {
    calls,
    currentWorkspaceId,
    async connectWorkspace(workspaceId) {
      calls.push(['connectWorkspace', workspaceId])
      if (connect) return connect(workspaceId)
      return 'session-1'
    },
    startSession(workspaceId) {
      calls.push(['startSession', workspaceId])
      if (start) return start(workspaceId)
      return undefined
    },
  }
  if (open) workspace.openSession = sessionId => calls.push(['openSession', sessionId])
  return workspace
}

/**
 * Flow B fake: `observeState` yields the given SessionState frames. `hold`
 * keeps the stream open after the last frame so a not-ready session can hit
 * the deadline; `prompt` overrides the host acknowledgement.
 */
function makeStateRemote({ frames = [], hold = false, prompt } = {}) {
  const calls = { state: [], prompt: [] }
  return {
    calls,
    session: {
      observeState(input, signal) {
        calls.state.push({ input, signal })
        return (async function* () {
          for (const frame of frames) {
            if (signal?.aborted) return
            yield frame
          }
          if (hold) await new Promise(() => {})
        })()
      },
      async prompt(input) {
        calls.prompt.push(input)
        if (typeof prompt === 'function') return prompt(input)
        return { accepted: true }
      },
    },
  }
}

test('startFromDraft resolves the workspace, parks the handoff, and marks the draft prefilled', async () => {
  const store = makeStore()
  const workspace = makeWorkspace()
  const draft = store.entries[0]

  const result = await startFromDraft({ draft, uiWorkspace: workspace, store, now })

  assert.deepEqual(result, {
    ok: true, sessionId: 'session-1', mode: 'prefill', manual: false, opened: true,
  })
  assert.deepEqual(workspace.calls, [
    ['connectWorkspace', 'ws-1'],
    ['openSession', 'session-1'],
  ])
  assert.deepEqual(await store.getHandoff('session-1'), {
    draftId: 'draft-1',
    body: 'Outline the next session',
  })
  const saved = store.entries.find(entry => entry.id === 'draft-1')
  assert.equal(saved.status, 'prefilled')
  assert.equal(saved.sessionId, 'session-1')
  assert.equal(saved.updatedAt, 5000)
  assert.equal(saved.title, 'Plan')
  assert.equal(saved.createdAt, 1000)
  // The caller's draft is never mutated.
  assert.equal(draft.status, 'idea')
  assert.equal(draft.sessionId, undefined)
})

test('startFromDraft honours an explicit workspace id', async () => {
  const store = makeStore()
  const workspace = makeWorkspace({ currentWorkspaceId: 'ignored' })

  await startFromDraft({ draft: store.entries[0], uiWorkspace: workspace, store, now, workspaceId: 'ws-explicit' })

  assert.deepEqual(workspace.calls[0], ['connectWorkspace', 'ws-explicit'])
})

test('startFromDraft falls back to startSession when connectWorkspace rejects', async () => {
  const store = makeStore()
  const workspace = makeWorkspace({ connect: () => { throw new Error('connect failed') } })

  const result = await startFromDraft({ draft: store.entries[0], uiWorkspace: workspace, store, now })

  assert.deepEqual(result, {
    ok: false, sessionId: null, mode: 'prefill', manual: true, reason: 'manual-fallback',
  })
  assert.deepEqual(workspace.calls, [
    ['connectWorkspace', 'ws-1'],
    ['startSession', 'ws-1'],
  ])
  assert.equal(store.handoffs.size, 0)
  assert.equal(store.entries[0].status, 'idea')
})

test('startFromDraft falls back when connectWorkspace returns no session id', async () => {
  const store = makeStore()
  const workspace = makeWorkspace({ connect: () => undefined })

  const result = await startFromDraft({ draft: store.entries[0], uiWorkspace: workspace, store, now })

  assert.equal(result.manual, true)
  assert.equal(result.reason, 'manual-fallback')
  assert.equal(result.sessionId, null)
  assert.deepEqual(workspace.calls, [
    ['connectWorkspace', 'ws-1'],
    ['startSession', 'ws-1'],
  ])
  assert.equal(store.handoffs.size, 0)
})

test('startFromDraft uses startSession when connectWorkspace is unavailable', async () => {
  const store = makeStore()
  const calls = []
  const workspace = {
    currentWorkspaceId: 'ws-1',
    startSession(workspaceId) { calls.push(['startSession', workspaceId]) },
  }

  const result = await startFromDraft({ draft: store.entries[0], uiWorkspace: workspace, store, now })

  assert.deepEqual(result, {
    ok: false, sessionId: null, mode: 'prefill', manual: true, reason: 'manual-fallback',
  })
  assert.deepEqual(calls, [['startSession', 'ws-1']])
  assert.equal(store.handoffs.size, 0)
})

test('startFromDraft without a uiWorkspace degrades to a manual start', async () => {
  const store = makeStore()

  const result = await startFromDraft({ draft: store.entries[0], uiWorkspace: null, store, now })

  assert.deepEqual(result, {
    ok: false, sessionId: null, mode: 'prefill', manual: true, reason: 'no-ui-workspace',
  })
  assert.equal(store.handoffs.size, 0)
  assert.equal(store.entries[0].status, 'idea')
})

test('startFromDraft still succeeds when openSession is unavailable', async () => {
  const store = makeStore()
  const workspace = makeWorkspace({ open: false })

  const result = await startFromDraft({ draft: store.entries[0], uiWorkspace: workspace, store, now })

  assert.equal(result.ok, true)
  assert.equal(result.opened, false)
  assert.deepEqual(await store.getHandoff('session-1'), {
    draftId: 'draft-1',
    body: 'Outline the next session',
  })
  assert.equal(store.entries[0].status, 'prefilled')
})

test('startFromDraft clears the handoff when the draft write fails', async () => {
  const store = makeStore()
  store.putEntry = async () => { throw new Error('quota exceeded') }
  const workspace = makeWorkspace()

  const result = await startFromDraft({ draft: store.entries[0], uiWorkspace: workspace, store, now })

  assert.deepEqual(result, {
    ok: false, sessionId: 'session-1', mode: 'prefill', manual: false, reason: 'store-failed',
  })
  assert.equal(await store.getHandoff('session-1'), null)
  assert.deepEqual(workspace.calls, [['connectWorkspace', 'ws-1']])
})

test('startFromDraft rejects an empty body before touching the platform', async () => {
  const store = makeStore([makeDraft({ body: '   ' })])
  const workspace = makeWorkspace()

  const result = await startFromDraft({ draft: store.entries[0], uiWorkspace: workspace, store, now })

  assert.deepEqual(result, {
    ok: false, sessionId: null, mode: 'prefill', manual: false, reason: 'empty-body',
  })
  assert.deepEqual(workspace.calls, [])
  assert.equal(store.handoffs.size, 0)
})

test('handoffPayload contains only the draft id and body', () => {
  assert.deepEqual(handoffPayload(makeDraft()), { draftId: 'draft-1', body: 'Outline the next session' })
})

// ---------------------------------------------------------------------------
// Flow B: auto-start preference, readiness wait, and prefill fallback.
// ---------------------------------------------------------------------------

test('sessionStateReady accepts any complete session state and rejects unrelated frames', () => {
  assert.equal(AUTO_READY_TIMEOUT_MS, 3000)
  assert.equal(sessionStateReady({ active: true, running: false, queue: [] }), true)
  assert.equal(sessionStateReady({ active: true, running: true, queue: [] }), true)
  assert.equal(sessionStateReady({ state: { active: true, queue: [] } }), true)
  // A fresh session may still be passive; prompt resumes it, so this counts as
  // ready and must not burn the 3-second deadline.
  assert.equal(sessionStateReady({ active: false, running: false, queue: null }), true)
  assert.equal(sessionStateReady({ cursor: 4, active: false, queue: null }), true)
  // A future host may expose an explicit readiness flag.
  assert.equal(sessionStateReady({ ready: true }), true)
  // Unrelated/empty objects are not states.
  assert.equal(sessionStateReady({}), false)
  assert.equal(sessionStateReady({ type: 'ack' }), false)
  assert.equal(sessionStateReady(null), false)
})

test('startFromDraft auto waits for ready, queues the body once, and marks the draft started', async () => {
  const store = makeStore()
  // `connectWorkspace` may reuse a blank session that still carries a stale
  // Flow A handoff; auto success must clear it, not leave it for the bridge.
  store.handoffs.set('session-1', { draftId: 'older-draft', body: 'stale body' })
  const workspace = makeWorkspace()
  const remote = makeStateRemote({
    frames: [
      { active: false, running: false, queue: null },
      { active: true, running: false, queue: [] },
    ],
  })

  const result = await startFromDraft({
    draft: store.entries[0], uiWorkspace: workspace, store, remote,
    behavior: 'auto', uuid: () => 'request-1', now,
  })

  assert.deepEqual(result, {
    ok: true, sessionId: 'session-1', mode: 'auto', manual: false, opened: true, requestId: 'request-1',
  })
  assert.equal(remote.calls.state.length, 1)
  assert.deepEqual(remote.calls.state[0].input, { sessionId: 'session-1' })
  assert.equal(remote.calls.state[0].signal.aborted, true)
  assert.deepEqual(remote.calls.prompt, [{
    requestId: 'request-1',
    sessionId: 'session-1',
    mode: 'queue',
    content: [{ type: 'text', text: 'Outline the next session' }],
  }])
  assert.equal(remote.calls.prompt.length, 1)

  const started = store.entries.find(entry => entry.id === 'draft-1')
  assert.equal(started.status, 'started')
  assert.equal(started.promptLogId, 'request-1')
  assert.equal(started.requestId, 'request-1')
  assert.equal(started.sessionId, 'session-1')
  assert.equal(started.updatedAt, 5000)
  // Auto success must not park a handoff, or the bridge would prefill the same
  // body into the composer on top of the already-sent prompt.
  assert.equal(store.handoffs.size, 0)
  assert.deepEqual(workspace.calls, [
    ['connectWorkspace', 'ws-1'],
    ['openSession', 'session-1'],
  ])
})

test('startFromDraft auto falls back to prefill when the state never becomes ready', async () => {
  const store = makeStore()
  // A stale Flow A handoff must be cleared before the wait, then re-parked by
  // the fallback so the current draft body is what the bridge sees.
  store.handoffs.set('session-1', { draftId: 'older-draft', body: 'stale body' })
  const workspace = makeWorkspace()
  // No frame at all: the stream is open but the controller never answers.
  const remote = makeStateRemote({ frames: [], hold: true })

  const result = await startFromDraft({
    draft: store.entries[0], uiWorkspace: workspace, store, remote,
    behavior: 'auto', uuid: () => 'request-1', now, readyTimeoutMs: 10,
  })

  assert.deepEqual(result, {
    ok: true,
    sessionId: 'session-1',
    mode: 'prefill',
    manual: false,
    opened: true,
    reason: 'auto-fallback',
    autoFailure: 'timeout',
  })
  assert.equal(remote.calls.prompt.length, 0)
  // The deadline aborted the state stream instead of leaking it.
  assert.equal(remote.calls.state.length, 1)
  assert.equal(remote.calls.state[0].signal.aborted, true)
  assert.deepEqual(await store.getHandoff('session-1'), {
    draftId: 'draft-1',
    body: 'Outline the next session',
  })
  assert.equal(store.entries[0].status, 'prefilled')
  assert.equal(store.entries[0].sessionId, 'session-1')
})

test('startFromDraft auto clears a stale handoff before waiting for readiness', async () => {
  const store = makeStore()
  store.handoffs.set('session-1', { draftId: 'older-draft', body: 'stale body' })
  const workspace = makeWorkspace()
  /** @type {object|null|undefined} what the bridge would have read mid-wait */
  let handoffDuringWait
  const remote = {
    session: {
      observeState() {
        handoffDuringWait = store.handoffs.get('session-1')
        return (async function* () {
          yield { active: true, running: false, queue: [] }
        })()
      },
      async prompt() { return { accepted: true } },
    },
  }

  const result = await startFromDraft({
    draft: store.entries[0], uiWorkspace: workspace, store, remote,
    behavior: 'auto', uuid: () => 'request-1', now,
  })

  assert.equal(result.ok, true)
  assert.equal(result.mode, 'auto')
  assert.equal(handoffDuringWait ?? null, null)
  assert.equal(store.handoffs.size, 0)
  assert.equal(store.entries[0].status, 'started')
})

test('startFromDraft auto falls back to prefill when the prompt is refused', async () => {
  const store = makeStore()
  const workspace = makeWorkspace()
  const remote = makeStateRemote({
    frames: [{ active: true, running: false, queue: [] }],
    prompt: () => ({ accepted: false }),
  })

  const result = await startFromDraft({
    draft: store.entries[0], uiWorkspace: workspace, store, remote,
    behavior: 'auto', uuid: () => 'request-1', now,
  })

  assert.equal(result.ok, true)
  assert.equal(result.mode, 'prefill')
  assert.equal(result.reason, 'auto-fallback')
  assert.equal(result.autoFailure, 'prompt-failed')
  // An explicit refusal is final: retrying it would only repeat the refusal.
  assert.equal(remote.calls.prompt.length, 1)
  assert.deepEqual(await store.getHandoff('session-1'), {
    draftId: 'draft-1',
    body: 'Outline the next session',
  })
  assert.equal(store.entries[0].status, 'prefilled')
})

test('startFromDraft auto retries a thrown prompt once with the same request id', async () => {
  const store = makeStore()
  const workspace = makeWorkspace()
  let attempts = 0
  const remote = makeStateRemote({
    frames: [{ active: true, running: false, queue: [] }],
    prompt: () => {
      attempts += 1
      // A transport error can surface after the host admitted the prompt.
      if (attempts === 1) throw new Error('connection reset after admission')
      return { accepted: true }
    },
  })

  const result = await startFromDraft({
    draft: store.entries[0], uiWorkspace: workspace, store, remote,
    behavior: 'auto', uuid: () => 'request-1', now,
  })

  assert.deepEqual(result, {
    ok: true, sessionId: 'session-1', mode: 'auto', manual: false, opened: true, requestId: 'request-1',
  })
  assert.equal(remote.calls.prompt.length, 2)
  // Deduping relies on the retry reusing the id of the first attempt.
  assert.deepEqual(remote.calls.prompt.map(input => input.requestId), ['request-1', 'request-1'])
  // The retry started the draft, so no handoff may be parked for a second copy.
  assert.equal(store.handoffs.size, 0)
  const started = store.entries.find(entry => entry.id === 'draft-1')
  assert.equal(started.status, 'started')
  assert.equal(started.promptLogId, 'request-1')
  assert.deepEqual(workspace.calls, [
    ['connectWorkspace', 'ws-1'],
    ['openSession', 'session-1'],
  ])
})

test('startFromDraft auto falls back only when the retried prompt also throws', async () => {
  const store = makeStore()
  const workspace = makeWorkspace()
  const remote = makeStateRemote({
    frames: [{ active: true, running: false, queue: [] }],
    prompt: () => { throw new Error('offline') },
  })

  const result = await startFromDraft({
    draft: store.entries[0], uiWorkspace: workspace, store, remote,
    behavior: 'auto', uuid: () => 'request-1', now,
  })

  assert.equal(result.ok, true)
  assert.equal(result.mode, 'prefill')
  assert.equal(result.reason, 'auto-fallback')
  assert.equal(result.autoFailure, 'prompt-failed')
  assert.equal(remote.calls.prompt.length, 2)
  assert.deepEqual(remote.calls.prompt.map(input => input.requestId), ['request-1', 'request-1'])
  assert.deepEqual(await store.getHandoff('session-1'), {
    draftId: 'draft-1',
    body: 'Outline the next session',
  })
  assert.equal(store.entries[0].status, 'prefilled')
})

test('startFromDraft auto treats a missing or throwing state stream as unavailable, not a timeout', async () => {
  for (const observeState of [undefined, () => { throw new Error('no state stream') }]) {
    const store = makeStore()
    const workspace = makeWorkspace()
    const promptCalls = []
    const remote = {
      session: {
        ...(observeState ? { observeState } : {}),
        async prompt(input) {
          promptCalls.push(input)
          return { accepted: true }
        },
      },
    }

    const result = await startFromDraft({
      draft: store.entries[0], uiWorkspace: workspace, store, remote,
      behavior: 'auto', uuid: () => 'request-1', now, readyTimeoutMs: 10,
    })

    assert.equal(result.ok, true)
    assert.equal(result.mode, 'prefill')
    assert.equal(result.reason, 'auto-fallback')
    // An unusable stream never becomes ready, but the 3-second copy would lie.
    assert.equal(result.autoFailure, 'unavailable')
    assert.equal(promptCalls.length, 0)
    assert.equal(store.entries[0].status, 'prefilled')
  }
})

test('startFromDraft auto falls back when the host has no prompt API', async () => {
  const store = makeStore()
  const workspace = makeWorkspace()

  const result = await startFromDraft({
    draft: store.entries[0], uiWorkspace: workspace, store, remote: { session: {} },
    behavior: 'auto', uuid: () => 'request-1', now,
  })

  assert.equal(result.ok, true)
  assert.equal(result.mode, 'prefill')
  assert.equal(result.reason, 'auto-fallback')
  assert.equal(result.autoFailure, 'unavailable')
  assert.equal(store.entries[0].status, 'prefilled')
})

test('an accepted auto prompt reports success when only the started write fails', async () => {
  const store = makeStore()
  store.putEntry = async () => { throw new Error('quota exceeded') }
  const workspace = makeWorkspace()
  const remote = makeStateRemote({ frames: [{ active: true, running: false, queue: [] }] })

  const result = await startFromDraft({
    draft: store.entries[0], uiWorkspace: workspace, store, remote,
    behavior: 'auto', uuid: () => 'request-1', now,
  })

  // The body is already queued; a generic failure would make the user retry
  // and send it twice. The specific flag drives the `startedPersistFailed` copy.
  assert.deepEqual(result, {
    ok: true,
    sessionId: 'session-1',
    mode: 'auto',
    manual: false,
    opened: true,
    requestId: 'request-1',
    startedPersistFailed: true,
  })
  assert.equal(remote.calls.prompt.length, 1)
  assert.equal(store.handoffs.size, 0)
  assert.deepEqual(workspace.calls, [
    ['connectWorkspace', 'ws-1'],
    ['openSession', 'session-1'],
  ])
})

test('startBehaviorOf defaults to prefill and accepts only the explicit auto value', () => {
  assert.equal(startBehaviorOf(null), 'prefill')
  assert.equal(startBehaviorOf({}), 'prefill')
  assert.equal(startBehaviorOf({ startSessionBehavior: 'prefill' }), 'prefill')
  assert.equal(startBehaviorOf({ startSessionBehavior: 'auto' }), 'auto')
  assert.equal(startBehaviorOf({ startSessionBehavior: 'nonsense' }), 'prefill')
})

test('persistStartBehavior merges the choice into the stored preferences', async () => {
  const writes = []
  const store = {
    async getPrefs() {
      return { submitMode: 'separate', lastWorkspace: 'ws-1', startSessionBehavior: 'prefill' }
    },
    async setPrefs(prefs) { writes.push(prefs) },
  }

  assert.equal(await persistStartBehavior(store, 'auto'), 'auto')
  assert.deepEqual(writes, [
    { submitMode: 'separate', lastWorkspace: 'ws-1', startSessionBehavior: 'auto' },
  ])

  // Unknown/omitted values normalize to the safe default.
  assert.equal(await persistStartBehavior(store, 'nonsense'), 'prefill')
  assert.equal(writes[1].startSessionBehavior, 'prefill')

  // A store without setPrefs is a no-op, not a crash.
  assert.equal(await persistStartBehavior(null, 'auto'), 'auto')
})

test('markDraftPrefilled and markDraftStarted clone with the derived status fields', () => {
  const draft = makeDraft()

  const prefilled = markDraftPrefilled(draft, 'session-1', now)
  assert.equal(prefilled.status, 'prefilled')
  assert.equal(prefilled.sessionId, 'session-1')
  assert.equal(prefilled.updatedAt, 5000)
  assert.notEqual(prefilled, draft)
  assert.equal(draft.status, 'idea')

  const started = markDraftStarted(prefilled, 'message-9', now)
  assert.equal(started.status, 'started')
  assert.equal(started.promptLogId, 'message-9')
  assert.equal(started.sessionId, 'session-1')
  assert.equal(started.updatedAt, 5000)
  assert.equal(prefilled.status, 'prefilled')
})

test('findPrefilledDraft keeps only the newest prefilled draft for the session', () => {
  const entries = [
    { id: 'old', kind: 'draft', status: 'prefilled', sessionId: 's1', updatedAt: 1 },
    { id: 'other-session', kind: 'draft', status: 'prefilled', sessionId: 's2', updatedAt: 9 },
    { id: 'not-prefilled', kind: 'draft', status: 'idea', sessionId: 's1', updatedAt: 9 },
    { id: 'new', kind: 'draft', status: 'prefilled', sessionId: 's1', updatedAt: 3 },
    { id: 'finding', kind: 'finding', status: 'prefilled', sessionId: 's1', updatedAt: 9 },
  ]

  assert.equal(findPrefilledDraft(entries, 's1')?.id, 'new')
  assert.equal(findPrefilledDraft(entries, 's3'), null)
  assert.equal(findPrefilledDraft(null, 's1'), null)
})

test('gatedUserMessageId accepts the direct and wrapped user-message shapes', () => {
  const message = { id: 'm1', role: 'user', source: { kind: 'user' } }

  // The shipped host puts the UserMessage directly in `data`; there is no turn
  // on this event (turns live on turn/start and assistant/message).
  assert.equal(gatedUserMessageId({ type: 'user/message', data: message }), 'm1')
  // Older hosts wrap it as { message, turn }; still accepted, turn optional.
  assert.equal(gatedUserMessageId({ type: 'user/message', data: { message, turn: 2 } }), 'm1')
  assert.equal(gatedUserMessageId({ type: 'user/message', data: { message } }), 'm1')
  assert.equal(gatedUserMessageId({ type: 'user/message', data: { ...message, source: { kind: 'synthetic' } } }), null)
  assert.equal(gatedUserMessageId({ type: 'assistant/message', data: message }), null)
  assert.equal(gatedUserMessageId({ type: 'user/message', data: { ...message, id: '' } }), null)
  assert.equal(gatedUserMessageId({ type: 'user/message', data: { ...message, id: 7 } }), null)
  assert.equal(gatedUserMessageId(undefined), null)
})

test('resolveTargetWorkspace prefers the current session workspace, then recent activity', () => {
  const items = [
    { workspaceId: 'w-old', sessionIds: ['s-old'], createdAt: '2026-01-01T00:00:00.000Z' },
    { workspaceId: 'w-live', sessionIds: ['s-live'], createdAt: '2026-01-02T00:00:00.000Z' },
  ]
  const withCurrent = {
    workspaces: { list: { getSnapshot: () => ({ items, phase: 'ready' }) } },
    sessions: {
      list: {
        getSnapshot: () => ({
          phase: 'ready',
          byId: { 's-old': { updatedAt: 100 }, 's-live': { updatedAt: 1 } },
        }),
      },
    },
    mainReference: { sessionId: 's-live' },
  }
  assert.equal(resolveTargetWorkspace(withCurrent), 'w-live')

  const recent = {
    workspaces: { list: { getSnapshot: () => ({ items, phase: 'ready' }) } },
    sessions: {
      list: {
        getSnapshot: () => ({
          phase: 'ready',
          byId: { 's-old': { updatedAt: 500 }, 's-live': { updatedAt: 1 } },
        }),
      },
    },
  }
  assert.equal(resolveTargetWorkspace(recent), 'w-old')

  // The host refuses to guess while either stream is still loading.
  const pending = {
    workspaces: { list: { getSnapshot: () => ({ items, phase: 'ready' }) } },
    sessions: { list: { getSnapshot: () => ({ phase: 'pending', byId: {} }) } },
  }
  assert.equal(resolveTargetWorkspace(pending), undefined)
  assert.equal(resolveTargetWorkspace({
    workspaces: { list: { getSnapshot: () => ({ items, phase: 'pending' }) } },
    sessions: { list: { getSnapshot: () => ({ phase: 'ready', byId: {} }) } },
  }), undefined)

  // A session-less workspace is ranked by its creation time, like the host.
  assert.equal(resolveTargetWorkspace({
    workspaces: {
      list: {
        getSnapshot: () => ({
          items: [
            { workspaceId: 'w-new', sessionIds: [], createdAt: '2026-02-01T00:00:00.000Z' },
            { workspaceId: 'w-old', sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z' },
          ],
          phase: 'ready',
        }),
      },
    },
    sessions: { list: { getSnapshot: () => ({ phase: 'ready', byId: {} }) } },
  }), 'w-new')

  assert.equal(resolveTargetWorkspace({
    workspaces: { list: { getSnapshot: () => ({ items: [], phase: 'ready' }) } },
  }), undefined)
  assert.equal(resolveTargetWorkspace({ currentWorkspaceId: 'direct' }), 'direct')
  assert.equal(resolveTargetWorkspace({ workspaces: { list: { getSnapshot: () => { throw new Error('boom') } } } }), undefined)
  assert.equal(resolveTargetWorkspace(null), undefined)
})

test('activeWorkspaceIdOf only trusts an explicit selection field', () => {
  assert.equal(activeWorkspaceIdOf({ activeWorkspaceId: 'ws-a', items: [] }), 'ws-a')
  assert.equal(activeWorkspaceIdOf({ selectedWorkspaceId: 'ws-b' }), 'ws-b')
  assert.equal(activeWorkspaceIdOf({ activeWorkspace: { workspaceId: 'ws-c' } }), 'ws-c')
  assert.equal(activeWorkspaceIdOf({ selection: { workspaceId: 'ws-d' } }), 'ws-d')
  // The shipped snapshot is items-only; never invent a target from items[0].
  assert.equal(activeWorkspaceIdOf({ items: [{ workspaceId: 'ws-a' }], phase: 'ready' }), undefined)
  assert.equal(activeWorkspaceIdOf({ activeWorkspaceId: '' }), undefined)
  assert.equal(activeWorkspaceIdOf(null), undefined)
})

test('startNotice checks the failure reason before the manual flag', () => {
  assert.deepEqual(startNotice({ ok: true }), { key: 'desk.draft.startPrefilled', error: false })
  assert.deepEqual(startNotice({ ok: true, mode: 'prefill' }), { key: 'desk.draft.startPrefilled', error: false })
  assert.deepEqual(startNotice({ ok: true, mode: 'auto' }), { key: 'desk.draft.startAutoSent', error: false })
  assert.deepEqual(
    startNotice({ ok: true, mode: 'auto', requestId: 'r1', startedPersistFailed: true }),
    { key: 'desk.draft.startAutoPersistFailed', error: false },
  )
  assert.deepEqual(
    startNotice({ ok: true, mode: 'prefill', reason: 'auto-fallback', autoFailure: 'timeout' }),
    { key: 'desk.draft.startAutoTimeout', error: false },
  )
  assert.deepEqual(
    startNotice({ ok: true, mode: 'prefill', reason: 'auto-fallback', autoFailure: 'prompt-failed' }),
    { key: 'desk.draft.startAutoFallback', error: false },
  )
  assert.deepEqual(
    startNotice({ ok: true, mode: 'prefill', reason: 'auto-fallback', autoFailure: 'unavailable' }),
    { key: 'desk.draft.startAutoFallback', error: false },
  )
  assert.deepEqual(startNotice({ ok: false, manual: true, reason: 'no-workspace' }), { key: 'desk.draft.startNoWorkspace', error: true })
  assert.deepEqual(startNotice({ ok: false, manual: true, reason: 'no-ui-workspace' }), { key: 'desk.draft.startNoWorkspace', error: true })
  assert.deepEqual(startNotice({ ok: false, manual: true, reason: 'empty-body' }), { key: 'desk.draft.startEmpty', error: true })
  assert.deepEqual(startNotice({ ok: false, manual: true, reason: 'manual-fallback' }), { key: 'desk.draft.startManual', error: false })
  assert.deepEqual(startNotice({ ok: false, manual: false, reason: 'store-failed' }), { key: 'desk.draft.startError', error: true })
  assert.deepEqual(startNotice({ ok: false, manual: true }), { key: 'desk.draft.startManual', error: false })
  assert.deepEqual(startNotice(undefined), { key: 'desk.draft.startError', error: true })
})

test('registerComposerBridge targets the session-scoped composer dock', () => {
  const registered = []
  const ctx = {
    slots: {
      inject(name, factory) {
        assert.equal(name, 'conversation.input.dock')
        factory()
      },
      register(entry, component) {
        registered.push({ entry, component })
        return () => {}
      },
    },
  }
  const ComposerBridge = () => null

  registerComposerBridge(ctx, { NS: 'punch-desk', ComposerBridge })

  assert.equal(registered.length, 1)
  assert.equal(registered[0].entry.name, 'conversation.input.dock')
  assert.equal(registered[0].entry.id, 'punch-desk-bridge')
  assert.equal(registered[0].entry.order, 30)
  assert.equal(registered[0].entry.locale, 'punch-desk')
  assert.equal(registered[0].component, ComposerBridge)
})

test('createComposerBridge builds a render-less component from the factory deps', () => {
  const React = { useRef: () => ({}), useLayoutEffect: () => {} }
  const component = createComposerBridge({ h: () => null, React, services: {} })
  assert.equal(typeof component, 'function')
})

// ---------------------------------------------------------------------------
// Composer bridge test harness: fake React hooks, fake store, fake event stream.
// ---------------------------------------------------------------------------

/** Drain the microtask queue so the bridge's async reads/observers settle. */
function flush() {
  return new Promise(resolve => setImmediate(resolve))
}

function prefilledDraft(overrides = {}) {
  return {
    id: 'draft-1',
    schemaVersion: 1,
    workspaceKey: 'draft:global',
    kind: 'draft',
    title: 'Plan',
    body: 'Hello',
    status: 'prefilled',
    sessionId: 'session-1',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

function makeBridgeStore({ entries = [], handoffs = new Map() } = {}) {
  const listeners = new Set()
  const store = {
    entries: entries.slice(),
    handoffs,
    writes: [],
    deleted: [],
    listenerCount: () => listeners.size,
    async getHandoff(sessionId) {
      return store.handoffs.get(sessionId) ?? null
    },
    async deleteHandoff(sessionId) {
      store.deleted.push(sessionId)
      store.handoffs.delete(sessionId)
      store.notify()
    },
    async listEntries() {
      return store.entries.slice()
    },
    async putEntry(entry) {
      store.writes.push(entry)
      const index = store.entries.findIndex(item => item.id === entry.id)
      if (index === -1) store.entries.push(entry)
      else store.entries[index] = entry
      store.notify()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    notify() {
      for (const listener of [...listeners]) listener()
    },
  }
  return store
}

/** `observeEvent` that yields the given frames immediately. */
function makeEventRemote(frames = []) {
  const calls = []
  return {
    calls,
    session: {
      observeEvent(input, signal) {
        calls.push({ input, signal })
        return (async function* () {
          for (const frame of frames) {
            if (signal?.aborted) return
            yield frame
          }
        })()
      },
    },
  }
}

/** `observeEvent` that blocks until `release()` is called, simulating a live stream. */
function makeGatedRemote() {
  const calls = []
  let release
  const gate = new Promise(resolve => { release = resolve })
  return {
    calls,
    release: () => release(),
    remote: {
      session: {
        observeEvent(input, signal) {
          calls.push({ input, signal })
          return (async function* () {
            await gate
            yield { type: 'event', event: { type: 'user/message', data: { id: 'late', source: { kind: 'user' } } } }
          })()
        },
      },
    },
  }
}

/**
 * Render the render-less component once and run its layout effects, like React
 * does after a mount. `unmount()` runs the recorded cleanups in reverse.
 */
function mountBridge(services, props) {
  const records = []
  const React = {
    useRef(initial) { return { current: initial } },
    useLayoutEffect(effect) { records.push({ effect, cleanup: null }) },
  }
  const Component = createComposerBridge({ h: () => null, React, services })
  Component(props)
  for (const record of records) {
    const cleanup = record.effect()
    record.cleanup = typeof cleanup === 'function' ? cleanup : null
  }
  return {
    records,
    unmount() {
      for (let index = records.length - 1; index >= 0; index -= 1) {
        records[index].cleanup?.()
        records[index].cleanup = null
      }
    },
  }
}

test('composer bridge prefills once, deletes the handoff, and does not re-apply on remount', async () => {
  const store = makeBridgeStore({
    entries: [prefilledDraft()],
    handoffs: new Map([['session-1', handoffPayload(makeDraft({ body: 'Hello' }))]]),
  })
  const remote = makeEventRemote()
  const setDraft = []
  const props = { sessionId: 'session-1', inputActions: { setDraft: body => setDraft.push(body) } }

  const first = mountBridge({ store, remote }, props)
  await flush()

  assert.deepEqual(setDraft, ['Hello'])
  assert.deepEqual(store.deleted, ['session-1'])
  assert.equal(await store.getHandoff('session-1'), null)
  first.unmount()

  const second = mountBridge({ store, remote }, props)
  await flush()
  assert.deepEqual(setDraft, ['Hello'])
  assert.deepEqual(store.deleted, ['session-1'])
  second.unmount()
})

test('composer bridge marks the draft started from a direct-shape user/message', async () => {
  const store = makeBridgeStore({ entries: [prefilledDraft()] })
  const remote = makeEventRemote([
    { type: 'event', event: { type: 'user/message', data: { id: 'm-1', role: 'user', source: { kind: 'user' } } } },
  ])

  const mounted = mountBridge({ store, remote }, { sessionId: 'session-1', inputActions: { setDraft: () => {} } })
  await flush()

  const started = store.entries.find(entry => entry.id === 'draft-1')
  assert.equal(started.status, 'started')
  assert.equal(started.promptLogId, 'm-1')
  assert.deepEqual(store.writes.map(entry => entry.status), ['started'])
  assert.equal(remote.calls.length, 1)
  assert.equal(remote.calls[0].signal.aborted, true)

  mounted.unmount()
  assert.equal(store.listenerCount(), 0)
})

test('composer bridge unsubscribes on unmount and never writes after the abort', async () => {
  const store = makeBridgeStore({ entries: [prefilledDraft()] })
  const gated = makeGatedRemote()

  const mounted = mountBridge({ store, remote: gated.remote }, {
    sessionId: 'session-1',
    inputActions: { setDraft: () => {} },
  })
  await flush()
  assert.equal(gated.calls.length, 1)
  const signal = gated.calls[0].signal

  mounted.unmount()
  assert.equal(signal.aborted, true)
  assert.equal(store.listenerCount(), 0)

  gated.release()
  await flush()
  assert.deepEqual(store.writes, [])
  assert.equal(store.entries[0].status, 'prefilled')
})

test('a handoff parked after an empty read applies on the next store write', async () => {
  const store = makeBridgeStore()
  const setDraft = []
  const mounted = mountBridge({ store, remote: makeEventRemote() }, {
    sessionId: 'session-1',
    inputActions: { setDraft: body => setDraft.push(body) },
  })
  await flush()
  assert.deepEqual(setDraft, [])
  assert.equal(store.handoffs.size, 0)

  // `startFromDraft` parks the handoff after the host reused an already-open
  // blank session; the bridge is already mounted with nothing to read.
  store.handoffs.set('session-1', handoffPayload(makeDraft({ body: 'Later' })))
  store.notify()
  await flush()

  assert.deepEqual(setDraft, ['Later'])
  assert.equal(store.handoffs.has('session-1'), false)
  mounted.unmount()
})
