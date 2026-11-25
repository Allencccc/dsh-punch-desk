import test from 'node:test'
import assert from 'node:assert/strict'
import { createCommitTraceTracker } from '../src/client/platform/commit-traces.js'
import { createGitApi } from '../src/client/platform/git-api.js'

function eventStream(events) {
  return function observeEvent() {
    return (async function* () {
      for (const event of events) yield { type: 'event', event }
    })()
  }
}

test('tracker samples admission before accepted and completes on turn/end', async () => {
  const saved = []
  const store = {
    async putCommitTraces(key, traces) { saved.push({ key, traces }) },
    async listCommitTraces() { return [] },
  }
  const git = {
    async head() { return { isRepo: true, gitHead: '0000000000000000000000000000000000000001' } },
    async range() { return { ok: true, truncated: false, commits: [] } },
  }
  const remote = { session: {
    observeEvent: eventStream([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { turn: 1, message: { source: { rpcId: 'r1' } } } },
      { type: 'turn/end', data: { turn: 1 } },
    ]),
  } }
  const tracker = createCommitTraceTracker({
    remote, git, store, resolveWorkspaceId: () => 'ws1',
  })

  await tracker.prepareSubmission({ requestId: 'r1', sessionId: 's1', mode: 'sequential', entries: [{ id: 'f1' }] })
  tracker.noteAccepted({ requestId: 'r1', sessionId: 's1', mode: 'sequential', entries: [{ id: 'f1' }] })
  await tracker.whenIdle() // 测试钩子：等待当前事件流处理完；生产 dispose 不依赖它

  assert.equal(saved.length, 1)
  assert.equal(saved[0].key, 'session:s1')
  assert.equal(saved[0].traces[0].id, 'r1#1')
  assert.equal(saved[0].traces[0].status, 'complete')
  assert.deepEqual(saved[0].traces[0].findingIds, ['f1'])
  assert.equal(saved[0].traces[0].preHeadSource, 'turn')
})

test('Combined mode uses admissionHead as preHead when turn/start is missing', async () => {
  const saved = []
  const store = {
    async putCommitTraces(key, traces) { saved.push({ key, traces }) },
    async listCommitTraces() { return [] },
  }
  const git = {
    async head() { return { isRepo: true, gitHead: '0000000000000000000000000000000000000002' } },
    async range() { return { ok: true, truncated: false, commits: [] } },
  }
  const remote = { session: {
    observeEvent: eventStream([
      { type: 'user/message', data: { turn: 2, message: { source: { rpcId: 'rc' } } } },
      { type: 'turn/end', data: { turn: 2 } },
    ]),
  } }
  const tracker = createCommitTraceTracker({
    remote, git, store, resolveWorkspaceId: () => 'ws1',
  })

  await tracker.prepareSubmission({ requestId: 'rc', sessionId: 's1', mode: 'combined', entries: [{ id: 'f1' }, { id: 'f2' }] })
  tracker.noteAccepted({ requestId: 'rc', sessionId: 's1', mode: 'combined', entries: [{ id: 'f1' }, { id: 'f2' }] })
  await tracker.whenIdle()

  assert.equal(saved.length, 1)
  const trace = saved[0].traces[0]
  assert.equal(trace.id, 'rc#2')
  assert.equal(trace.preHeadSource, 'admission')
  assert.equal(trace.preHead, '0000000000000000000000000000000000000002')
  assert.equal(trace.postHead, '0000000000000000000000000000000000000002')
  assert.equal(trace.status, 'complete')
})

test('Sequential subsequent turn uses previous-post chaining when turn/start is missing', async () => {
  const saved = []
  const existingTraces = [
    {
      id: 'r1#1',
      turn: 1,
      postHead: '1111111111111111111111111111111111111111',
      status: 'complete',
    },
  ]
  const store = {
    async putCommitTraces(key, traces) { saved.push({ key, traces }) },
    async listCommitTraces() { return existingTraces },
  }
  const git = {
    async head() { return { isRepo: true, gitHead: '2222222222222222222222222222222222222222' } },
    async range(wsId, from, to) {
      assert.equal(from, '1111111111111111111111111111111111111111')
      assert.equal(to, '2222222222222222222222222222222222222222')
      return {
        ok: true,
        truncated: false,
        commits: [
          { hash: '2222222222222222222222222222222222222222', shortHash: '2222222', subject: 'feat 2', time: 100 },
        ],
      }
    },
  }
  const remote = { session: {
    observeEvent: eventStream([
      { type: 'user/message', data: { turn: 3, message: { source: { rpcId: 'r2' } } } },
      { type: 'turn/end', data: { turn: 3 } },
    ]),
  } }
  const tracker = createCommitTraceTracker({
    remote, git, store, resolveWorkspaceId: () => 'ws1',
  })

  await tracker.prepareSubmission({ requestId: 'r2', sessionId: 's1', mode: 'sequential', entries: [{ id: 'f2' }] })
  tracker.noteAccepted({ requestId: 'r2', sessionId: 's1', mode: 'sequential', entries: [{ id: 'f2' }] })
  await tracker.whenIdle()

  assert.equal(saved.length, 1)
  const trace = saved[0].traces[0]
  assert.equal(trace.id, 'r2#3')
  assert.equal(trace.preHeadSource, 'previous-post')
  assert.equal(trace.preHead, '1111111111111111111111111111111111111111')
  assert.equal(trace.postHead, '2222222222222222222222222222222222222222')
  assert.equal(trace.status, 'complete')
  assert.equal(trace.commits.length, 1)
})

test('Short-circuit: workspaceId unresolved -> failed workspace-unresolved', async () => {
  const saved = []
  const store = {
    async putCommitTraces(key, traces) { saved.push({ key, traces }) },
    async listCommitTraces() { return [] },
  }
  let gitCalled = false
  const git = {
    async head() { gitCalled = true; return { isRepo: true, gitHead: '1111111111111111111111111111111111111111' } },
    async range() { return { ok: true, commits: [] } },
  }
  const remote = { session: {
    observeEvent: eventStream([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { turn: 1, message: { source: { rpcId: 'r-noworkspace' } } } },
      { type: 'turn/end', data: { turn: 1 } },
    ]),
  } }
  const tracker = createCommitTraceTracker({
    remote, git, store, resolveWorkspaceId: () => undefined,
  })

  await tracker.prepareSubmission({ requestId: 'r-noworkspace', sessionId: 's1', mode: 'sequential', entries: [{ id: 'f1' }] })
  tracker.noteAccepted({ requestId: 'r-noworkspace', sessionId: 's1', mode: 'sequential', entries: [{ id: 'f1' }] })
  await tracker.whenIdle()

  assert.equal(saved.length, 1)
  const trace = saved[0].traces[0]
  assert.equal(trace.id, 'r-noworkspace#1')
  assert.equal(trace.status, 'failed')
  assert.equal(trace.error, 'workspace-unresolved')
  assert.deepEqual(trace.commits, [])
})

test('Short-circuit: not a repo -> failed not-a-repo', async () => {
  const saved = []
  const store = {
    async putCommitTraces(key, traces) { saved.push({ key, traces }) },
    async listCommitTraces() { return [] },
  }
  const git = {
    async head() { return { isRepo: false } },
    async range() { throw new Error('should not call range') },
  }
  const remote = { session: {
    observeEvent: eventStream([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { turn: 1, message: { source: { rpcId: 'r-norepo' } } } },
      { type: 'turn/end', data: { turn: 1 } },
    ]),
  } }
  const tracker = createCommitTraceTracker({
    remote, git, store, resolveWorkspaceId: () => 'ws1',
  })

  await tracker.prepareSubmission({ requestId: 'r-norepo', sessionId: 's1', mode: 'sequential', entries: [{ id: 'f1' }] })
  tracker.noteAccepted({ requestId: 'r-norepo', sessionId: 's1', mode: 'sequential', entries: [{ id: 'f1' }] })
  await tracker.whenIdle()

  assert.equal(saved.length, 1)
  const trace = saved[0].traces[0]
  assert.equal(trace.id, 'r-norepo#1')
  assert.equal(trace.status, 'failed')
  assert.equal(trace.error, 'not-a-repo')
})

test('Range failure records failed range-failed and preserves endpoints for retry', async () => {
  const saved = []
  const store = {
    async putCommitTraces(key, traces) { saved.push({ key, traces }) },
    async listCommitTraces() { return saved.flatMap(s => s.traces) },
  }
  let call = 0
  const git = {
    async head() {
      call++
      return {
        isRepo: true,
        gitHead: call <= 2 ? '1111111111111111111111111111111111111111' : '2222222222222222222222222222222222222222',
      }
    },
    async range() {
      return { ok: false, error: 'git rev-list crashed' }
    },
  }
  const remote = { session: {
    observeEvent: eventStream([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { turn: 1, message: { source: { rpcId: 'r-fail' } } } },
      { type: 'turn/end', data: { turn: 1 } },
    ]),
  } }
  const tracker = createCommitTraceTracker({
    remote, git, store, resolveWorkspaceId: () => 'ws1',
  })

  await tracker.prepareSubmission({ requestId: 'r-fail', sessionId: 's1', mode: 'sequential', entries: [{ id: 'f1' }] })
  tracker.noteAccepted({ requestId: 'r-fail', sessionId: 's1', mode: 'sequential', entries: [{ id: 'f1' }] })
  await tracker.whenIdle()

  assert.equal(saved.length, 1)
  const failedTrace = saved[0].traces[0]
  assert.equal(failedTrace.status, 'failed')
  assert.equal(failedTrace.error, 'range-failed')
  assert.equal(failedTrace.preHead, '1111111111111111111111111111111111111111')
  assert.equal(failedTrace.postHead, '2222222222222222222222222222222222222222')

  // Retry succeeds when git.range is fixed
  git.range = async () => ({
    ok: true,
    truncated: false,
    commits: [{ hash: '2222222222222222222222222222222222222222', shortHash: '2222222', subject: 'recovered', time: 100 }],
  })
  const retryResult = await tracker.retryTrace({ sessionId: 's1', traceId: failedTrace.id })
  assert.equal(retryResult.ok, true)
  assert.equal(retryResult.trace.status, 'complete')
  assert.equal(retryResult.trace.commits.length, 1)
})

test('retryTrace rejects non-retryable errors like not-a-repo and workspace-unresolved', async () => {
  const store = {
    async putCommitTraces() {},
    async listCommitTraces() {
      return [
        { id: 't1', status: 'failed', error: 'not-a-repo', preHead: '111', postHead: '222' },
        { id: 't2', status: 'failed', error: 'workspace-unresolved' },
      ]
    },
  }
  const tracker = createCommitTraceTracker({
    remote: { session: {} },
    git: {},
    store,
    resolveWorkspaceId: () => 'ws1',
  })

  const r1 = await tracker.retryTrace({ sessionId: 's1', traceId: 't1' })
  assert.equal(r1.ok, false)
  assert.equal(r1.error, 'not-retryable')

  const r2 = await tracker.retryTrace({ sessionId: 's1', traceId: 't2' })
  assert.equal(r2.ok, false)
  assert.equal(r2.error, 'not-retryable')
})

test('discard cleans up pending submission so no trace is created on turn/end', async () => {
  const saved = []
  const store = {
    async putCommitTraces(key, traces) { saved.push({ key, traces }) },
    async listCommitTraces() { return [] },
  }
  const git = {
    async head() { return { isRepo: true, gitHead: '1111111111111111111111111111111111111111' } },
  }
  const remote = { session: {
    observeEvent: eventStream([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { turn: 1, message: { source: { rpcId: 'r-discard' } } } },
      { type: 'turn/end', data: { turn: 1 } },
    ]),
  } }
  const tracker = createCommitTraceTracker({
    remote, git, store, resolveWorkspaceId: () => 'ws1',
  })

  await tracker.prepareSubmission({ requestId: 'r-discard', sessionId: 's1', mode: 'sequential', entries: [{ id: 'f1' }] })
  tracker.discard('r-discard')
  tracker.noteAccepted({ requestId: 'r-discard', sessionId: 's1', mode: 'sequential', entries: [{ id: 'f1' }] })
  await tracker.whenIdle()

  assert.equal(saved.length, 0)
})

test('git-api client fetches git-head, git-commit-range and commit-trace-lookup', async () => {
  const fetchCalls = []
  const mockFetch = async (url) => {
    fetchCalls.push(url)
    if (url.includes('/git-head')) {
      return {
        ok: true,
        status: 200,
        async json() { return { ok: true, isRepo: true, gitHead: '0000000000000000000000000000000000000001' } },
      }
    }
    if (url.includes('/git-commit-range')) {
      return {
        ok: true,
        status: 200,
        async json() { return { ok: true, commits: [{ hash: 'abc', shortHash: 'abc', subject: 'test', time: 1 }], truncated: false } },
      }
    }
    if (url.includes('/commit-trace-lookup')) {
      return {
        ok: true,
        status: 200,
        async json() { return { ok: true, matches: [{ traceId: 't1' }] } },
      }
    }
    return { ok: false, status: 404, statusText: 'Not found', async json() { return { ok: false } } }
  }

  const git = createGitApi({ fetch: mockFetch })
  const head = await git.head('ws-test')
  assert.equal(head.isRepo, true)
  assert.equal(head.gitHead, '0000000000000000000000000000000000000001')

  const range = await git.range('ws-test', '0000000000000000000000000000000000000001', '0000000000000000000000000000000000000002')
  assert.equal(range.ok, true)
  assert.equal(range.commits.length, 1)

  const lookup = await git.lookup('ws-test', '1234567')
  assert.equal(lookup.ok, true)
  assert.equal(lookup.matches.length, 1)
})

test('user/message without data.turn falls back to the current turn from turn/start', async () => {
  const saved = []
  const store = {
    async putCommitTraces(key, traces) { saved.push({ key, traces }) },
    async listCommitTraces() { return [] },
  }
  const git = {
    async head() { return { isRepo: true, gitHead: '0000000000000000000000000000000000000001' } },
    async range() { return { ok: true, truncated: false, commits: [] } },
  }
  const remote = {
    session: {
      observeEvent: eventStream([
        { type: 'turn/start', data: { turn: 4 } },
        { type: 'user/message', data: { message: { source: { rpcId: 'r-fallback' } } } },
        { type: 'turn/end', data: { turn: 4 } },
      ]),
    },
  }
  const tracker = createCommitTraceTracker({
    remote, git, store, resolveWorkspaceId: () => 'ws1',
  })
  await tracker.prepareSubmission({ requestId: 'r-fallback', sessionId: 's1', mode: 'sequential', entries: [{ id: 'f1' }] })
  tracker.noteAccepted({ requestId: 'r-fallback', sessionId: 's1', mode: 'sequential', entries: [{ id: 'f1' }] })
  await tracker.whenIdle()

  assert.equal(saved.length, 1)
  assert.equal(saved[0].traces[0].id, 'r-fallback#4')
  assert.equal(saved[0].traces[0].turn, 4)
})

test('settling the last pending request aborts the idle session observer', async () => {
  let signal = null
  const store = {
    async putCommitTraces() {},
    async listCommitTraces() { return [] },
  }
  const git = {
    async head() { return { isRepo: true, gitHead: '0000000000000000000000000000000000000001' } },
    async range() { return { ok: true, truncated: false, commits: [] } },
  }
  const remote = {
    session: {
      observeEvent(_request, abortSignal) {
        signal = abortSignal
        return (async function* () {
          yield { type: 'event', event: { type: 'turn/start', data: { turn: 1 } } }
          yield { type: 'event', event: { type: 'user/message', data: { turn: 1, message: { source: { rpcId: 'r1' } } } } }
          yield { type: 'event', event: { type: 'turn/end', data: { turn: 1 } } }
          await new Promise(resolve => abortSignal.addEventListener('abort', resolve, { once: true }))
        })()
      },
    },
  }
  const tracker = createCommitTraceTracker({ remote, git, store, resolveWorkspaceId: () => 'ws1' })
  await tracker.prepareSubmission({ requestId: 'r1', sessionId: 's1', mode: 'sequential', entries: [{ id: 'f1' }] })
  tracker.noteAccepted({ requestId: 'r1', sessionId: 's1', mode: 'sequential', entries: [{ id: 'f1' }] })
  await tracker.whenIdle()

  assert.ok(signal)
  assert.equal(signal.aborted, true)
})


test('discarding a requestId does not block a later retry that reuses it', async () => {
  const saved = []
  const store = {
    async putCommitTraces(key, traces) { saved.push({ key, traces }) },
    async listCommitTraces() { return [] },
  }
  const git = {
    async head() { return { isRepo: true, gitHead: '0000000000000000000000000000000000000001' } },
    async range() { return { ok: true, truncated: false, commits: [] } },
  }
  const remote = {
    session: {
      observeEvent: eventStream([
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'user/message', data: { turn: 1, message: { source: { rpcId: 'r-retry' } } } },
        { type: 'turn/end', data: { turn: 1 } },
      ]),
    },
  }
  const tracker = createCommitTraceTracker({ remote, git, store, resolveWorkspaceId: () => 'ws1' })
  await tracker.prepareSubmission({ requestId: 'r-retry', sessionId: 's1', mode: 'sequential', entries: [{ id: 'f1' }] })
  tracker.discard('r-retry')
  await tracker.whenIdle()
  assert.equal(saved.length, 0)

  await tracker.prepareSubmission({ requestId: 'r-retry', sessionId: 's1', mode: 'sequential', entries: [{ id: 'f1' }] })
  tracker.noteAccepted({ requestId: 'r-retry', sessionId: 's1', mode: 'sequential', entries: [{ id: 'f1' }] })
  await tracker.whenIdle()
  assert.equal(saved.length, 1)
  assert.equal(saved[0].traces[0].id, 'r-retry#1')
})

test('late observer replays recent events so a missed turn/start or turn/end still settles', async () => {
  const saved = []
  const store = {
    async putCommitTraces(key, traces) { saved.push({ key, traces }) },
    async listCommitTraces() { return [] },
  }
  const git = {
    async head() { return { isRepo: true, gitHead: '0000000000000000000000000000000000000001' } },
    async range() { return { ok: true, truncated: false, commits: [] } },
  }
  const remote = {
    session: {
      async events() {
        return {
          ok: true,
          value: {
            records: [
              { type: 'event', event: { type: 'turn/start', data: { turn: 7 } } },
              { type: 'event', event: { type: 'user/message', data: { turn: 7, message: { source: { rpcId: 'r-late' } } } } },
              { type: 'event', event: { type: 'turn/end', data: { turn: 7 } } },
            ],
          },
        }
      },
      observeEvent() {
        return (async function* () {})()
      },
    },
  }
  const tracker = createCommitTraceTracker({ remote, git, store, resolveWorkspaceId: () => 'ws1' })
  await tracker.prepareSubmission({ requestId: 'r-late', sessionId: 's1', mode: 'sequential', entries: [{ id: 'f1' }] })
  tracker.noteAccepted({ requestId: 'r-late', sessionId: 's1', mode: 'sequential', entries: [{ id: 'f1' }] })
  await tracker.whenIdle()

  assert.equal(saved.length, 1)
  assert.equal(saved[0].traces[0].id, 'r-late#7')
  assert.equal(saved[0].traces[0].turn, 7)
  assert.equal(saved[0].traces[0].status, 'complete')
})
