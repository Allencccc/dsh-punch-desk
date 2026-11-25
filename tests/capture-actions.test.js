import test from 'node:test'
import assert from 'node:assert/strict'
import { registerCaptureActions } from '../src/client/ui/capture-actions.js'
import { captureAnchor } from '../src/client/ui/session-pane.js'

/**
 * Minimal slot harness: `inject` runs its factory immediately and `register`
 * records the component under its slot name, like the live slot tree does
 * when the surface is present.
 */
function createHarness() {
  const seats = new Map()
  const ctx = {
    slots: {
      inject(_name, factory) {
        return factory()
      },
      register(definition, component) {
        seats.set(definition.name, { definition, component })
        return { definition, component }
      },
    },
  }
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children })
  const calls = []
  const services = { openCapture: (...args) => calls.push(args) }
  registerCaptureActions(ctx, { h, t: key => key, NS: 'punch-desk', services })
  return { seats, calls }
}

test('assistant-actions capture reports the message id and session id', () => {
  const { seats, calls } = createHarness()
  const seat = seats.get('conversation.chat.assistant-actions')
  assert.ok(seat)
  assert.equal(seat.definition.id, 'punch-desk-capture')

  const vnode = seat.component({ messageId: 'm1', sessionId: 's1' })
  assert.equal(vnode.type, 'button')
  assert.equal(vnode.props['data-punch-desk-capture'], 'message')
  vnode.props.onClick()

  assert.deepEqual(calls, [['s1', { kind: 'message', messageId: 'm1' }]])
})

test('capture registers only the message toolbar entry', () => {
  const { seats } = createHarness()
  assert.deepEqual([...seats.keys()], ['conversation.chat.assistant-actions'])
})

test('the pane converts capture payloads into finding anchors', () => {
  assert.deepEqual(
    captureAnchor({ kind: 'message', messageId: 'm1' }),
    { type: 'message', messageId: 'm1' },
  )
  assert.deepEqual(
    captureAnchor({ kind: 'turn', turn: 7, seq: 42 }),
    { type: 'turn', turn: 7, seq: 42 },
  )
  assert.equal(captureAnchor(null), null)
  assert.equal(captureAnchor({ kind: 'message' }), null)
})
