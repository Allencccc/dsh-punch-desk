import test from 'node:test'
import assert from 'node:assert/strict'
import { createSubmitService } from '../src/client/platform/submit.js'
import { createSubmissionSeqAllocator } from '../src/client/platform/submission-seq.js'
import { createEntry } from '../src/domain/entries.js'

const deps = { now: () => 1000, uuid: () => 'id-1' }
let seq = 0

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function flush() {
  return new Promise(resolve => setImmediate(resolve))
}

function finding(overrides = {}) {
  return createEntry({
    kind: 'finding', workspaceKey: 'session:s1', sessionId: 's1',
    title: 'title', body: 'body', status: 'open', ...overrides,
  }, { ...deps, uuid: () => `finding-${++seq}` })
}

function createRemote({ prompt, state, updateQueue } = {}) {
  const calls = { prompt: [], state: [], updateQueue: [] }
  return {
    calls,
    remote: {
      session: {
        prompt: async args => {
          calls.prompt.push(args)
          return prompt ? prompt(args) : { ok: true, value: { accepted: true } }
        },
        state: async args => {
          calls.state.push(args)
          return state ? state(args) : { ok: true, value: { queue: [] } }
        },
        updateQueue: async args => {
          calls.updateQueue.push(args)
          return updateQueue ? updateQueue(args) : { ok: true, value: { accepted: true } }
        },
      },
    },
  }
}

test('submitCombined sends exactly one queued prompt and keeps the requestId', async () => {
  const { remote, calls } = createRemote()
  const submit = createSubmitService({ remote })
  const entries = [finding({ title: 'one' }), finding({ title: 'two' })]
  const result = await submit.submitCombined('s1', entries, 'req-1')

  assert.equal(result.ok, true)
  assert.equal(result.requestId, 'req-1')
  assert.equal(calls.prompt.length, 1)
  const sent = calls.prompt[0]
  assert.equal(sent.sessionId, 's1')
  assert.equal(sent.requestId, 'req-1')
  assert.equal(sent.mode, 'queue')
  assert.equal(sent.content.length, 1)
  assert.equal(sent.content[0].type, 'text')
  assert.match(sent.content[0].text, /评审发现 2 条/)
  assert.match(sent.content[0].text, /1\. \[?.*one/)
  assert.match(sent.content[0].text, /2\. \[?.*two/)
})

test('submitCombined validates before touching the remote', async () => {
  const { remote, calls } = createRemote()
  const submit = createSubmitService({ remote })
  const result = await submit.submitCombined('s1', [])
  assert.equal(result.ok, false)
  assert.equal(Array.isArray(result.errors), true)
  assert.ok(result.errors.length > 0)
  assert.equal(calls.prompt.length, 0)
})

test('submitSequential sends one prompt per entry with distinct requestIds', async () => {
  const { remote, calls } = createRemote()
  const submit = createSubmitService({ remote, uuid: () => 'generated-1' })
  const entries = [finding({ title: 'one', requestId: 'r-1' }), finding({ title: 'two', requestId: 'r-2' })]
  const result = await submit.submitSequential('s1', entries)

  assert.equal(result.ok, true)
  assert.deepEqual(result.requests, [
    { entryId: entries[0].id, requestId: 'r-1' },
    { entryId: entries[1].id, requestId: 'r-2' },
  ])
  assert.equal(calls.prompt.length, 2)
  assert.deepEqual(calls.prompt.map(call => call.requestId), ['r-1', 'r-2'])
  assert.notEqual(calls.prompt[0].requestId, calls.prompt[1].requestId)
  assert.match(calls.prompt[0].content[0].text, /1\./)
  assert.match(calls.prompt[1].content[0].text, /1\./) // each single-entry prompt restarts at 1
})

test('submitSequential validates before touching the remote', async () => {
  const { remote, calls } = createRemote()
  const submit = createSubmitService({ remote })
  const result = await submit.submitSequential('s1', [{ id: 'bad', title: 42 }])
  assert.equal(result.ok, false)
  assert.equal(calls.prompt.length, 0)
})

test('submitSequential stops on the first failure and reports what was sent', async () => {
  let calls = 0
  const { remote } = createRemote({
    prompt: async () => {
      calls++
      return calls === 2 ? { ok: false, error: { code: 'session/busy', message: 'busy' } } : { ok: true }
    },
  })
  const submit = createSubmitService({ remote })
  const entries = [finding(), finding(), finding()]
  const result = await submit.submitSequential('s1', entries)

  assert.equal(result.ok, false)
  assert.equal(result.failedEntryId, entries[1].id)
  assert.equal(result.error.message, 'busy')
  assert.equal(result.error.code, 'session/busy')
  assert.equal(result.requests.length, 1)
  assert.equal(calls, 2)
})

test('submit surfaces remote failures instead of throwing', async () => {
  const { remote } = createRemote({
    prompt: async () => { throw new Error('offline') },
  })
  const submit = createSubmitService({ remote })
  const result = await submit.submitCombined('s1', [finding()], 'r-1')
  assert.equal(result.ok, false)
  assert.equal(result.error.message, 'offline')
  assert.equal(result.error.code, 'submit/send-failed')
  assert.equal(result.requestId, 'r-1')
})

test('editQueued only edits the queue item whose rpcId matches exactly', async () => {
  const { remote, calls } = createRemote({
    state: async () => ({
      ok: true,
      value: { queue: [{ id: 'item-1', placement: 'queued' }, { id: 'item-2', rpcId: 'r-1' }] },
    }),
  })
  const submit = createSubmitService({ remote })
  const result = await submit.editQueued('s1', 'r-1', 'Edited text')

  assert.equal(result.ok, true)
  assert.equal(result.method, 'edit')
  assert.deepEqual(calls.updateQueue, [{
    sessionId: 's1',
    itemId: 'item-2',
    action: { kind: 'edit', content: [{ type: 'text', text: 'Edited text' }] },
  }])
})

test('editQueued reports failure and never retracts the item when edit is rejected', async () => {
  const { remote, calls } = createRemote({
    state: async () => ({
      ok: true,
      value: { queue: [{ id: 'item-1', rpcId: 'r-1' }] },
    }),
    updateQueue: async () => ({ ok: false, error: { code: 'queue/edit-unsupported', message: 'edit unsupported' } }),
  })
  const submit = createSubmitService({ remote })
  const result = await submit.editQueued('s1', 'r-1', 'Edited text')

  assert.equal(result.ok, false)
  assert.equal(result.error.message, 'edit unsupported')
  assert.equal(calls.updateQueue.length, 1)
  assert.equal(calls.updateQueue[0].action.kind, 'edit')
  assert.equal(calls.updateQueue.some(call => call.action.kind === 'remove'), false)
})

test('editQueued surfaces a thrown updateQueue as a failure without queue withdrawal', async () => {
  const { remote, calls } = createRemote({
    state: async () => ({
      ok: true,
      value: { queue: [{ id: 'item-1', rpcId: 'r-1' }] },
    }),
    updateQueue: async () => { throw new Error('harness offline') },
  })
  const submit = createSubmitService({ remote })
  const result = await submit.editQueued('s1', 'r-1', 'Edited text')

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'submit/edit-failed')
  assert.equal(calls.updateQueue.length, 1)
  assert.equal(calls.updateQueue[0].action.kind, 'edit')
  assert.equal(typeof submit.undo, 'undefined')
  assert.equal(typeof submit.retractQueued, 'undefined')
})

test('resolve and dismiss stamp resolvedAt and preserve the batch id', () => {
  const submit = createSubmitService({ remote: createRemote().remote, now: () => 2000 })
  const entry = finding({ status: 'sent', batchId: 'b1' })
  const resolved = submit.resolve(entry)
  assert.equal(resolved.status, 'resolved')
  assert.equal(resolved.resolvedAt, 2000)
  assert.equal(resolved.updatedAt, entry.updatedAt)
  assert.equal(resolved.batchId, 'b1')

  const dismissed = submit.dismiss(entry)
  assert.equal(dismissed.status, 'dismissed')
  assert.equal(dismissed.resolvedAt, 2000)
  assert.equal(dismissed.batchId, 'b1')
})

test('fork derives a fresh unsubmitted finding with lineage and leaves original untouched', () => {
  const submit = createSubmitService({
    remote: createRemote().remote,
    now: () => 3000,
    uuid: () => 'fork-uuid-999',
  })
  const entry = finding({
    status: 'resolved',
    resolvedAt: 1500,
    batchId: 'batch-1',
    requestId: 'req-1',
    assignedGroupId: 'grp-1',
  })

  const forked = submit.fork(entry)
  assert.equal(forked.id, 'fork-uuid-999')
  assert.equal(forked.sourceFindingId, entry.id)
  assert.equal(forked.status, 'open')
  assert.equal(forked.submissionStatus, 'unsubmitted')
  assert.equal(forked.reviewStatus, 'pending')
  assert.equal(forked.batchId, undefined)
  assert.equal(forked.requestId, undefined)
  assert.equal(forked.resolvedAt, undefined)
  assert.equal(forked.createdAt, 3000)
  assert.equal(forked.updatedAt, 3000)

  // Original entry remains resolved and unchanged
  assert.equal(entry.status, 'resolved')
  assert.equal(entry.resolvedAt, 1500)
})

// ---------------------------------------------------------------------------
// Acceptance protocol (Group Turn Attribution Phase 2 / T-GTA-25, T-GTA-26)
// ---------------------------------------------------------------------------

test('submitCombined awaits onAccepted before resolving', async () => {
  const gate = deferred()
  let acceptedInfo = null
  const { remote } = createRemote()
  const submit = createSubmitService({
    remote,
    uuid: () => 'req-awaited',
    onAccepted: async info => {
      await gate.promise
      acceptedInfo = info
    },
  })

  let settled = false
  const pending = submit.submitCombined('s1', [finding()], 'req-awaited')
    .then(result => { settled = true; return result })

  await flush()
  assert.equal(settled, false, 'the submit must wait for the acceptance evidence write')
  gate.resolve()
  const result = await pending
  assert.equal(settled, true)
  assert.equal(result.ok, true)
  assert.equal(result.accepted, true)
  assert.equal(acceptedInfo.requestId, 'req-awaited')
})

test('submitCombined reports evidencePending (not a send failure) when onAccepted throws', async () => {
  const { remote, calls } = createRemote()
  const discarded = []
  const submit = createSubmitService({
    remote,
    uuid: () => 'req-evidence-fail',
    onAccepted: async () => { throw new Error('store offline') },
    onDiscard: info => discarded.push(info.requestId),
  })

  const result = await submit.submitCombined('s1', [finding()], 'req-evidence-fail')

  assert.equal(result.ok, true, 'an accepted prompt must never be reported as a send failure')
  assert.equal(result.accepted, true)
  assert.equal(result.evidencePending, true)
  assert.deepEqual(result.evidenceError, { code: 'submit/evidence-failed', message: 'store offline' })
  assert.equal(result.requestId, 'req-evidence-fail')
  assert.equal(result.error, undefined)
  assert.deepEqual(discarded, [], 'evidence failure must not discard the accepted submission')
  assert.equal(calls.prompt.length, 1)
})

test('submitCombined shares one submission seq for the whole batch', async () => {
  const allocator = createSubmissionSeqAllocator({ readMax: () => 0 })
  const accepted = []
  const { remote, calls } = createRemote()
  const submit = createSubmitService({
    remote,
    now: () => 777,
    submissionSeqAllocator: allocator,
    onAccepted: info => { accepted.push(info) },
  })

  const entries = [finding({ title: 'one' }), finding({ title: 'two' })]
  const result = await submit.submitCombined('s1', entries, 'req-combined-seq')

  assert.equal(result.ok, true)
  assert.equal(result.accepted, true)
  assert.equal(result.evidencePending, undefined)
  assert.equal(result.acceptedAt, 777)
  assert.equal(result.submissionSeq, 1)
  assert.equal(accepted.length, 1, 'combined accepts exactly one prompt, so exactly one seq')
  assert.equal(accepted[0].acceptedAt, 777)
  assert.equal(accepted[0].submissionSeq, 1)
  assert.equal(accepted[0].mode, 'combined')
  assert.deepEqual(accepted[0].entries.map(entry => entry.title), ['one', 'two'])
  assert.equal(calls.prompt.length, 1)
  assert.deepEqual(allocator.pendingSeqs('s1'), [])
})

test('submitSequential touches one seq per accepted request, in acceptance order', async () => {
  const allocator = createSubmissionSeqAllocator({ readMax: () => 0 })
  const accepted = []
  const { remote } = createRemote()
  const submit = createSubmitService({
    remote,
    now: () => 500,
    submissionSeqAllocator: allocator,
    onAccepted: info => { accepted.push({ requestId: info.requestId, seq: info.submissionSeq }) },
  })
  const entries = [finding({ requestId: 'r-1' }), finding({ requestId: 'r-2' })]

  const result = await submit.submitSequential('s1', entries)

  assert.equal(result.ok, true)
  assert.deepEqual(result.requests.map(request => request.requestId), ['r-1', 'r-2'])
  assert.deepEqual(result.requests.map(request => request.submissionSeq), [1, 2])
  assert.deepEqual(result.requests.map(request => request.acceptedAt), [500, 500])
  assert.deepEqual(accepted, [{ requestId: 'r-1', seq: 1 }, { requestId: 'r-2', seq: 2 }])
})

test('submitSequential awaits onAccepted for every accepted request', async () => {
  const gate = deferred()
  const order = []
  const { remote } = createRemote()
  const submit = createSubmitService({
    remote,
    onAccepted: async info => {
      order.push(`start:${info.requestId}`)
      if (info.requestId === 'r-1') await gate.promise
      order.push(`end:${info.requestId}`)
    },
  })
  const entries = [finding({ requestId: 'r-1' }), finding({ requestId: 'r-2' })]

  const pending = submit.submitSequential('s1', entries)
  await flush()
  assert.deepEqual(order, ['start:r-1'])
  gate.resolve()
  const result = await pending
  assert.equal(result.ok, true)
  assert.deepEqual(order, ['start:r-1', 'end:r-1', 'start:r-2', 'end:r-2'])
})

test('submitSequential stops sending further entries once an accepted prompt cannot persist evidence', async () => {
  const allocator = createSubmissionSeqAllocator({ readMax: () => 0 })
  const { remote, calls } = createRemote()
  const discarded = []
  const entries = [
    finding({ title: 'one', requestId: 'r-1' }),
    finding({ title: 'two', requestId: 'r-2' }),
    finding({ title: 'three', requestId: 'r-3' }),
  ]
  const submit = createSubmitService({
    remote,
    now: () => 50,
    submissionSeqAllocator: allocator,
    onAccepted: async info => {
      if (info.requestId === 'r-2') throw new Error('write failed')
    },
    onDiscard: info => discarded.push(info.requestId),
  })

  const result = await submit.submitSequential('s1', entries)

  assert.equal(result.ok, true)
  assert.equal(result.accepted, true)
  assert.equal(result.evidencePending, true)
  assert.deepEqual(result.evidenceError, { code: 'submit/evidence-failed', message: 'write failed' })
  assert.deepEqual(result.requests.map(request => request.requestId), ['r-1', 'r-2'])
  assert.deepEqual(result.requests.map(request => request.submissionSeq), [1, 2])
  assert.equal(result.requests[0].evidencePending, undefined)
  assert.equal(result.requests[1].evidencePending, true)
  assert.deepEqual(result.requests[1].evidenceError, { code: 'submit/evidence-failed', message: 'write failed' })
  assert.deepEqual(result.unsentEntryIds, [entries[2].id])
  assert.equal(calls.prompt.length, 2, 'no prompt may be sent once its acceptance could not be attributed')
  assert.deepEqual(discarded, [])
  assert.deepEqual(allocator.pendingSeqs('s1'), [2])
})

test('overlapping combined submissions serialize on the first delayed persistence (seq 1/2)', async () => {
  const allocator = createSubmissionSeqAllocator({ readMax: () => 5 })
  const gate = deferred()
  const order = []
  const { remote } = createRemote()
  const submit = createSubmitService({
    remote,
    now: () => 1000,
    submissionSeqAllocator: allocator,
    onAccepted: async info => {
      order.push(`start:${info.submissionSeq}`)
      if (info.requestId === 'req-first') await gate.promise
      order.push(`end:${info.submissionSeq}`)
    },
  })

  const first = submit.submitCombined('s1', [finding()], 'req-first')
  const second = submit.submitCombined('s1', [finding()], 'req-second')

  await flush()
  assert.deepEqual(order, ['start:6'], 'the second acceptance must wait for the first persistence')
  gate.resolve()
  const [a, b] = await Promise.all([first, second])

  assert.deepEqual(order, ['start:6', 'end:6', 'start:7', 'end:7'])
  assert.equal(a.submissionSeq, 6)
  assert.equal(b.submissionSeq, 7)
  assert.notEqual(a.submissionSeq, b.submissionSeq)
  assert.notEqual(a.requestId, b.requestId)
})

test('a blocked session reports evidencePending without borrowing another submission seq', async () => {
  const allocator = createSubmissionSeqAllocator({ readMax: () => 0 })
  const { remote, calls } = createRemote()
  const discarded = []
  const submit = createSubmitService({
    remote,
    now: () => 42,
    submissionSeqAllocator: allocator,
    onAccepted: async () => { throw new Error('disk full') },
    onDiscard: info => discarded.push(info.requestId),
  })

  const first = await submit.submitCombined('s1', [finding()], 'r-1')
  assert.equal(first.evidencePending, true)
  assert.deepEqual(first.evidenceError, { code: 'submit/evidence-failed', message: 'disk full' })
  assert.equal(first.submissionSeq, 1)
  assert.equal(first.acceptedAt, 42)

  const second = await submit.submitCombined('s1', [finding()], 'r-2')
  assert.equal(second.ok, true)
  assert.equal(second.accepted, true)
  assert.equal(second.evidencePending, true)
  assert.equal(second.evidenceError.code, 'submit/seq-blocked')
  assert.equal(second.submissionSeq, undefined, 'the blocked seq 1 belongs to the first request, never to this one')
  assert.equal(second.acceptedAt, undefined)
  assert.equal(second.requestId, 'r-2')
  assert.deepEqual(allocator.pendingSeqs('s1'), [1])
  assert.deepEqual(discarded, [])
  assert.equal(calls.prompt.length, 2)
})

test('retrying the evidence write unblocks the session and later submissions get the next seq', async () => {
  const allocator = createSubmissionSeqAllocator({ readMax: () => 0 })
  const { remote } = createRemote()
  const acceptedSeqs = []
  let failOnce = true
  const submit = createSubmitService({
    remote,
    now: () => 9,
    submissionSeqAllocator: allocator,
    onAccepted: async info => {
      acceptedSeqs.push(info.submissionSeq)
      if (failOnce) {
        failOnce = false
        throw new Error('transient write failure')
      }
    },
  })

  const first = await submit.submitCombined('s1', [finding()], 'r-1')
  assert.equal(first.evidencePending, true)
  assert.equal(first.submissionSeq, 1)

  const retried = await allocator.retry('s1')
  assert.equal(retried.seq, 1, 'the retried evidence keeps the reserved seq')
  assert.equal(allocator.isBlocked('s1'), false)

  const second = await submit.submitCombined('s1', [finding()], 'r-2')
  assert.equal(second.evidencePending, undefined)
  assert.equal(second.submissionSeq, 2)
  assert.deepEqual(acceptedSeqs, [1, 1, 2])
})
