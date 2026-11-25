import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createSubmissionSeqAllocator,
  SubmissionSeqBlockedError,
  SubmissionSeqInvalidationError,
  SubmissionSeqReadError,
  SubmissionSeqStateError,
} from '../src/client/platform/submission-seq.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

test('allocates from the persisted max + 1 and reads that max once per session', async () => {
  const reads = []
  const claims = []
  const allocator = createSubmissionSeqAllocator({
    readMax: async sessionId => {
      reads.push(sessionId)
      return 4
    },
  })

  const first = await allocator.allocate('s1', claim => {
    claims.push({ ...claim })
    return 'one'
  })
  const second = await allocator.allocate('s1', claim => {
    claims.push({ ...claim })
    return 'two'
  })

  assert.equal(first.seq, 5)
  assert.equal(first.value, 'one')
  assert.equal(second.seq, 6)
  assert.deepEqual(reads, ['s1'])
  assert.deepEqual(claims, [{ sessionId: 's1', seq: 5 }, { sessionId: 's1', seq: 6 }])
  assert.deepEqual(allocator.pendingSeqs('s1'), [])
  assert.equal(allocator.isBlocked('s1'), false)
})

test('starts at 1 when the persisted max is missing or zero', async () => {
  for (const readMax of [() => 0, () => undefined, () => null, () => '2']) {
    const allocator = createSubmissionSeqAllocator({ readMax })
    const expected = readMax() === '2' ? 3 : 1
    const result = await allocator.allocate('s1', claim => claim.seq)
    assert.equal(result.seq, expected)
  }
})

test('a slow first persistence keeps its seq and makes the next allocation wait', async () => {
  const gate = deferred()
  const firstStarted = deferred()
  const order = []
  const allocator = createSubmissionSeqAllocator({ readMax: async () => 10 })

  const first = allocator.allocate('s1', async claim => {
    order.push(`start:${claim.seq}`)
    firstStarted.resolve()
    await gate.promise
    order.push(`end:${claim.seq}`)
    return claim.seq
  })
  const second = allocator.allocate('s1', claim => {
    order.push(`start:${claim.seq}`)
    return claim.seq
  })

  await firstStarted.promise
  assert.deepEqual(order, ['start:11'])
  assert.deepEqual(allocator.pendingSeqs('s1'), [11])

  gate.resolve()
  const [a, b] = await Promise.all([first, second])
  assert.deepEqual(order, ['start:11', 'end:11', 'start:12'])
  assert.equal(a.seq, 11)
  assert.equal(b.seq, 12)
  assert.deepEqual(allocator.pendingSeqs('s1'), [])
})

test('a delayed persisted-max read does not let a later acceptance allocate first', async () => {
  const reads = deferred()
  const allocator = createSubmissionSeqAllocator({
    readMax: async () => {
      await reads.promise
      return 0
    },
  })
  const order = []
  const first = allocator.allocate('s1', claim => {
    order.push(claim.seq)
    return claim.seq
  })
  const second = allocator.allocate('s1', claim => {
    order.push(claim.seq)
    return claim.seq
  })

  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(order, [])
  reads.resolve()
  const [a, b] = await Promise.all([first, second])
  assert.deepEqual(order, [1, 2])
  assert.equal(a.seq, 1)
  assert.equal(b.seq, 2)
})

test('a persistence failure keeps the reservation and blocks the session', async () => {
  let attempts = 0
  const allocator = createSubmissionSeqAllocator({ readMax: () => 0 })

  await assert.rejects(
    allocator.allocate('s1', () => {
      attempts++
      throw new Error('disk full')
    }),
    error => {
      assert.equal(error instanceof SubmissionSeqBlockedError, true)
      assert.equal(error.name, 'SubmissionSeqBlockedError')
      assert.equal(error.code, 'submit/seq-blocked')
      assert.equal(error.sessionId, 's1')
      assert.equal(error.seq, 1)
      assert.equal(error.message.includes('disk full'), true)
      assert.equal(error.cause.message, 'disk full')
      return true
    },
  )
  assert.equal(attempts, 1)
  assert.equal(allocator.isBlocked('s1'), true)
  assert.equal(allocator.blockedSeq('s1'), 1)
  assert.deepEqual(allocator.pendingSeqs('s1'), [1])
  assert.equal(allocator.lastError('s1').message, 'disk full')

  await assert.rejects(
    allocator.allocate('s1', () => { attempts++ }),
    error => error.code === 'submit/seq-blocked' && error.seq === 1,
  )
  assert.equal(attempts, 1, 'a blocked allocation must not run its task')
})

test('retry reuses the blocked seq, unblocks, and the next allocation continues above it', async () => {
  let failOnce = true
  const seqs = []
  const allocator = createSubmissionSeqAllocator({ readMax: () => 0 })

  await assert.rejects(
    allocator.allocate('s1', claim => {
      seqs.push(claim.seq)
      if (failOnce) {
        failOnce = false
        throw new Error('flaky store')
      }
      return claim.seq
    }),
    error => error.code === 'submit/seq-blocked',
  )

  const retried = await allocator.retry('s1')
  assert.equal(retried.seq, 1)
  assert.equal(retried.retried, true)
  assert.equal(allocator.isBlocked('s1'), false)
  assert.deepEqual(allocator.pendingSeqs('s1'), [])

  const next = await allocator.allocate('s1', claim => {
    seqs.push(claim.seq)
    return claim.seq
  })
  assert.equal(next.seq, 2)
  assert.deepEqual(seqs, [1, 1, 2])
})

test('a failed retry keeps the reservation and the block', async () => {
  const allocator = createSubmissionSeqAllocator({ readMax: () => 0 })
  await assert.rejects(
    allocator.allocate('s1', () => { throw new Error('disk full') }),
    error => error.code === 'submit/seq-blocked',
  )
  await assert.rejects(
    allocator.retry('s1'),
    error => {
      assert.equal(error instanceof SubmissionSeqBlockedError, true)
      assert.equal(error.seq, 1)
      return true
    },
  )
  assert.equal(allocator.isBlocked('s1'), true)
  assert.equal(allocator.blockedSeq('s1'), 1)
  assert.deepEqual(allocator.pendingSeqs('s1'), [1])
})

test('explicit invalidation lifts the block without ever reusing the seq', async () => {
  const allocator = createSubmissionSeqAllocator({ readMax: () => 0 })
  await assert.rejects(
    allocator.allocate('s1', () => { throw new Error('disk full') }),
    error => error.code === 'submit/seq-blocked',
  )

  const released = await allocator.invalidate('s1')
  assert.deepEqual(released, { sessionId: 's1', seq: 1, invalidated: true })
  assert.equal(allocator.isBlocked('s1'), false)
  assert.deepEqual(allocator.pendingSeqs('s1'), [])

  const next = await allocator.allocate('s1', claim => claim.seq)
  assert.equal(next.seq, 2, 'the invalidated seq 1 must not be reissued')
})

test('invalidation rejects a mismatched seq or a session with no blocked reservation', async () => {
  const allocator = createSubmissionSeqAllocator({ readMax: () => 0 })
  await assert.rejects(
    allocator.invalidate('s1'),
    error => error instanceof SubmissionSeqInvalidationError && error.code === 'submit/seq-invalidation',
  )

  await assert.rejects(
    allocator.allocate('s1', () => { throw new Error('disk full') }),
    error => error.code === 'submit/seq-blocked',
  )
  await assert.rejects(
    allocator.invalidate('s1', 2),
    error => error instanceof SubmissionSeqInvalidationError && error.seq === 2,
  )
  assert.equal(allocator.isBlocked('s1'), true)
})

test('an unreadable persisted max consumes no seq and does not block the session', async () => {
  let reads = 0
  const allocator = createSubmissionSeqAllocator({
    readMax: async () => {
      reads++
      if (reads === 1) throw new Error('store offline')
      return 3
    },
  })

  await assert.rejects(
    allocator.allocate('s1', () => { throw new Error('must not run') }),
    error => {
      assert.equal(error instanceof SubmissionSeqReadError, true)
      assert.equal(error.code, 'submit/seq-unreadable')
      assert.equal(error.cause.message, 'store offline')
      return true
    },
  )
  assert.equal(allocator.isBlocked('s1'), false)
  assert.deepEqual(allocator.pendingSeqs('s1'), [])

  const next = await allocator.allocate('s1', claim => claim.seq)
  assert.equal(next.seq, 4)
  assert.equal(reads, 2)
})

test('rejects an invalid persisted max value', async () => {
  for (const readMax of [() => -1, () => Number.NaN, () => Number.POSITIVE_INFINITY, () => 'abc']) {
    const allocator = createSubmissionSeqAllocator({ readMax })
    await assert.rejects(
      allocator.allocate('s1', () => 'unused'),
      error => error instanceof SubmissionSeqReadError,
    )
    assert.equal(allocator.isBlocked('s1'), false)
  }
})

test('sessions are isolated: one blocked session never blocks another', async () => {
  const allocator = createSubmissionSeqAllocator({ readMax: () => 0 })
  await assert.rejects(
    allocator.allocate('s1', () => { throw new Error('disk full') }),
    error => error.code === 'submit/seq-blocked',
  )
  const other = await allocator.allocate('s2', claim => claim.seq)
  assert.equal(other.seq, 1)
  assert.equal(allocator.isBlocked('s1'), true)
  assert.equal(allocator.isBlocked('s2'), false)
})

test('the persist hook is the default reservation task', async () => {
  const claims = []
  const allocator = createSubmissionSeqAllocator({
    readMax: () => 0,
    persist: async claim => {
      claims.push({ ...claim })
      return 'persisted'
    },
  })

  const result = await allocator.allocate('s1')
  assert.equal(result.seq, 1)
  assert.equal(result.value, 'persisted')
  assert.deepEqual(claims, [{ sessionId: 's1', seq: 1 }])
})

test('retry needs a failed reservation and allocate needs a task', async () => {
  const allocator = createSubmissionSeqAllocator({ readMax: () => 0 })
  await assert.rejects(
    allocator.retry('s1'),
    error => error instanceof SubmissionSeqStateError && error.code === 'submit/seq-no-failure',
  )
  await assert.rejects(allocator.allocate('s1'), error => error instanceof TypeError)
  await assert.rejects(allocator.allocate('', () => {}), error => error instanceof TypeError)
})

test('snapshot reports the in-memory reservation state', async () => {
  const gate = deferred()
  const allocator = createSubmissionSeqAllocator({ readMax: () => 2 })
  assert.deepEqual(allocator.snapshot('s1'), {
    sessionId: 's1', loaded: false, persistedMax: 0, highWater: 0, pendingSeqs: [], blockedSeq: null,
  })

  const run = allocator.allocate('s1', async claim => {
    await gate.promise
    return claim.seq
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(allocator.snapshot('s1'), {
    sessionId: 's1', loaded: true, persistedMax: 2, highWater: 3, pendingSeqs: [3], blockedSeq: null,
  })
  gate.resolve()
  await run
  assert.deepEqual(allocator.snapshot('s1').pendingSeqs, [])
})

test('createSubmissionSeqAllocator validates its deps', () => {
  assert.throws(() => createSubmissionSeqAllocator(), error => error instanceof TypeError)
  assert.throws(() => createSubmissionSeqAllocator({}), error => error instanceof TypeError)
  assert.throws(
    () => createSubmissionSeqAllocator({ readMax: () => 0, persist: 'nope' }),
    error => error instanceof TypeError,
  )
})
