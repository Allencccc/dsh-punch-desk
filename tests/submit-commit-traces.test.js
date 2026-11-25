import test from 'node:test'
import assert from 'node:assert/strict'
import { createSubmitService } from '../src/client/platform/submit.js'

test('submit awaits onPrepare before prompt and calls onAccepted after', async () => {
  const order = []
  let sent = false
  const remote = {
    session: {
      async prompt(input) {
        order.push('prompt')
        assert.equal(sent, true, 'onPrepare must have executed before prompt')
        return { accepted: true }
      },
    },
  }
  const service = createSubmitService({
    remote,
    now: () => 1,
    uuid: () => 'req-1',
    onPrepare: async () => { order.push('prepare'); sent = true },
    onAccepted: () => { order.push('accepted') },
  })
  const res = await service.submitSequential('s1', [{ id: 'f1', text: 'x', severity: 'P1', tag: 'code', requestId: 'req-1' }])
  assert.equal(res.ok, true)
  assert.deepEqual(order, ['prepare', 'prompt', 'accepted'])
})

test('submitCombined calls onPrepare before prompt and onAccepted after', async () => {
  const order = []
  let preparedArg = null
  let acceptedArg = null
  const remote = {
    session: {
      async prompt(input) {
        order.push('prompt')
        return { ok: true, value: { accepted: true } }
      },
    },
  }
  const service = createSubmitService({
    remote,
    now: () => 100,
    uuid: () => 'req-comb',
    onPrepare: async (arg) => { order.push('prepare'); preparedArg = arg },
    onAccepted: (arg) => { order.push('accepted'); acceptedArg = arg },
  })
  const entries = [
    { id: 'f1', text: 'one', severity: 'P1', tag: 'code' },
    { id: 'f2', text: 'two', severity: 'P2', tag: 'arch' },
  ]
  const res = await service.submitCombined('s1', entries, 'req-comb')
  assert.equal(res.ok, true)
  assert.deepEqual(order, ['prepare', 'prompt', 'accepted'])
  assert.equal(preparedArg.requestId, 'req-comb')
  assert.equal(preparedArg.mode, 'combined')
  assert.equal(preparedArg.sessionId, 's1')
  assert.equal(acceptedArg.requestId, 'req-comb')
})

test('submitCombined calls onDiscard when prompt is rejected', async () => {
  const order = []
  let discardedArg = null
  const remote = {
    session: {
      async prompt() {
        order.push('prompt')
        return { ok: false, error: { message: 'queue full' } }
      },
    },
  }
  const service = createSubmitService({
    remote,
    uuid: () => 'req-comb-fail',
    onPrepare: async () => { order.push('prepare') },
    onAccepted: () => { order.push('accepted') },
    onDiscard: (arg) => { order.push('discard'); discardedArg = arg },
  })
  const entries = [{ id: 'f1', text: 'one', severity: 'P1', tag: 'code' }]
  const res = await service.submitCombined('s1', entries, 'req-comb-fail')
  assert.equal(res.ok, false)
  assert.deepEqual(order, ['prepare', 'prompt', 'discard'])
  assert.equal(discardedArg.requestId, 'req-comb-fail')
})

test('submitSequential calls onDiscard for failed entry and stops', async () => {
  const order = []
  const discarded = []
  let count = 0
  const remote = {
    session: {
      async prompt() {
        count++
        if (count === 1) return { accepted: true }
        return { ok: false, error: { message: 'model overloaded' } }
      },
    },
  }
  const service = createSubmitService({
    remote,
    uuid: () => `req-${count + 1}`,
    onPrepare: async (arg) => { order.push(`prepare:${arg.requestId}`) },
    onAccepted: (arg) => { order.push(`accepted:${arg.requestId}`) },
    onDiscard: (arg) => { order.push(`discard:${arg.requestId}`); discarded.push(arg.requestId) },
  })
  const entries = [
    { id: 'f1', text: 'one', severity: 'P1', tag: 'code', requestId: 'r1' },
    { id: 'f2', text: 'two', severity: 'P2', tag: 'code', requestId: 'r2' },
  ]
  const res = await service.submitSequential('s1', entries)
  assert.equal(res.ok, false)
  assert.deepEqual(order, ['prepare:r1', 'accepted:r1', 'prepare:r2', 'discard:r2'])
  assert.deepEqual(discarded, ['r2'])
})
