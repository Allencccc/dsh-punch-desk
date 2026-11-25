import test, { mock } from 'node:test'
import assert from 'node:assert/strict'

import { createFactory } from '../src/client/factory.js'
import {
  registerSeats,
  TAB_ID,
  PANEL_ID,
  CONVERSATION_VIEW_ID,
} from '../src/client/platform/register.js'
import { registerCaptureActions } from '../src/client/ui/capture-actions.js'
import { dictionaries, NS } from '../src/locale.js'

// ---------------------------------------------------------------------------
// Startup wiring guards (plan P2-1 remainder).
//
// These tests exercise the activation path that produced the historical
// "entry did not activate" / "right pane tab silently disappeared" failures:
// a missing service must never be read through the Cordis property proxy, the
// right-sidebar tab must be registered through ctx.inject (which may resolve
// after apply), and every seat must still be attempted when the host is bare.
// ---------------------------------------------------------------------------

const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) })
const fakeReact = { createElement: h }
const dicts = dictionaries()
const t = key => dicts.zh[key] ?? key

function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.children || []).map(textOf).join('')
}

/**
 * Minimal stand-in for a Cordis client context. `strict` mirrors the real
 * service-access proxy: reading an undeclared property throws instead of
 * returning undefined, so a direct `ctx.sidebarRightTabs` access fails loudly
 * exactly like it did in the host boot log.
 */
function createFakeContext({ services = {}, strict = false, deferInject = false } = {}) {
  const calls = {
    get: [],
    inject: [],
    effects: [],
    slotsInject: [],
    slotsRegister: [],
    localeRegister: [],
  }
  const disposers = []
  const pendingInjections = []

  const slots = {
    inject(name, callback) {
      calls.slotsInject.push(name)
      if (typeof callback === 'function') callback()
    },
    register(seat, component) {
      calls.slotsRegister.push({ seat, component })
    },
  }

  const scope = () => ({
    get(name) {
      return services[name]
    },
    effect(fn, label) {
      calls.effects.push('scope:' + label)
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    slots,
  })

  const target = {
    get(name) {
      calls.get.push(name)
      return services[name]
    },
    inject(names, callback) {
      calls.inject.push([...names])
      if (deferInject || names.some(name => !services[name])) {
        pendingInjections.push({ names: [...names], callback })
        return
      }
      callback(scope())
    },
    effect(fn, label) {
      calls.effects.push(label)
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    locale: {
      register(name) {
        calls.localeRegister.push(name)
      },
      bind() {
        return key => t(key)
      },
    },
    remote: {},
    slots,
  }

  const ctx = strict
    ? new Proxy(target, {
        get(source, prop, receiver) {
          if (typeof prop === 'string' && !(prop in source)) {
            throw new Error('cannot get property "' + prop + '" without inject')
          }
          return Reflect.get(source, prop, receiver)
        },
      })
    : target

  return {
    ctx,
    calls,
    disposers,
    pendingInjections,
    services,
    scope,
    cleanup() {
      for (const dispose of disposers.splice(0)) {
        try { dispose() } catch {}
      }
    },
  }
}

/** The client store hydrates through window.fetch in the browser; Node has no window. */
async function withBrowserFetch(fn) {
  const previous = globalThis.window
  globalThis.window = {
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, state: {} }) }),
  }
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete globalThis.window
    else globalThis.window = previous
  }
}

const seats = {
  h,
  t,
  NS,
  SessionPane: function SessionPane() { return null },
  DeskPage: function DeskPage() { return null },
  PanelIcon: function PanelIcon() { return null },
  DeskIcon: function DeskIcon() { return null },
  DrawerIcon: function DrawerIcon() { return null },
}

test('factory declares the services the client half actually reads', () => {
  const factory = createFactory(() => fakeReact)
  assert.equal(typeof factory.apply, 'function')
  assert.deepEqual(factory.inject, ['slots', 'locale', 'remote', 'remote.session'])
})

test('apply survives a strict Cordis context with every host service missing', async () => {
  const harness = createFakeContext({ services: {}, strict: true, deferInject: true })
  const factory = createFactory(() => fakeReact)

  await withBrowserFetch(() => {
    assert.doesNotThrow(() => factory.apply(harness.ctx))
  })

  // Missing right-sidebar services must be awaited through inject, never read
  // directly from the service proxy (the historical "entry did not activate").
  assert.deepEqual(harness.calls.inject, [['sidebarRightTabs', 'sidebarRight']])
  assert.equal(harness.pendingInjections.length, 1)
  assert.ok(!harness.calls.get.includes('sidebarRightTabs'), 'sidebarRightTabs must not be read through ctx.get')
  assert.ok(harness.calls.effects.includes('punch-desk: fallback timer'), 'the 2.5s conversation.view fallback must stay armed')

  const registered = harness.calls.slotsRegister.map(entry => entry.seat.name)
  assert.ok(registered.includes('main'), 'main slot must still be attempted')
  assert.ok(registered.includes('sidebar.panellist'), 'left panellist must still be attempted')
  assert.ok(registered.includes('conversation.chat.assistant-actions'), 'capture entry must still be attempted')
  assert.ok(registered.includes('conversation.input.dock'), 'composer bridge must still be attempted')
  assert.ok(!registered.includes('sidebar.right.pane.tab'), 'right pane tab must wait for inject')

  harness.cleanup()
})

test('right-sidebar services arriving after apply still register the right pane tab', async () => {
  const harness = createFakeContext({ services: {}, deferInject: true })
  const factory = createFactory(() => fakeReact)

  await withBrowserFetch(() => factory.apply(harness.ctx))
  assert.equal(harness.pendingInjections.length, 1)
  const injection = harness.pendingInjections[0]
  assert.deepEqual(injection.names, ['sidebarRightTabs', 'sidebarRight'])

  // The Web shell mounts these later; resolve the pending inject like Cordis does.
  const tabRegistrations = []
  harness.services.sidebarRightTabs = {
    register: seat => {
      tabRegistrations.push(seat)
      return () => {}
    },
  }
  harness.services.sidebarRight = { openTab() {} }
  injection.callback(harness.scope())

  assert.equal(tabRegistrations.length, 1, 'the tab type must be registered once the services arrive')
  const tab = tabRegistrations[0]
  assert.equal(tab.id, TAB_ID)
  assert.equal(tab.kind, TAB_ID)
  assert.equal(tab.keepMounted, true)
  assert.equal(tab.title(), t('tab.title'))
  assert.equal(typeof tab.icon, 'function', 'the tab must carry the drawer icon component')
  assert.deepEqual(tab.guide.map(item => item.id), ['open'])

  const registered = harness.calls.slotsRegister.map(entry => entry.seat.name)
  assert.ok(registered.includes('sidebar.right.pane.tab'), 'pane body slot must be registered')
  assert.ok(registered.includes('sidebar.right.pane.tab.title'), 'pane tab title slot must be registered')
  assert.equal(
    harness.calls.slotsRegister.find(entry => entry.seat.name === 'sidebar.right.pane.tab').seat.key,
    TAB_ID,
  )

  harness.cleanup()
})

test('registerSeats attempts the right tab, main panel and panellist with stable ids', () => {
  const harness = createFakeContext({
    services: {
      sidebarRightTabs: { register: () => () => {} },
      sidebarRight: { openTab() {} },
    },
  })

  registerSeats(harness.ctx, seats)

  assert.deepEqual(harness.calls.inject, [['sidebarRightTabs', 'sidebarRight']])
  assert.deepEqual(harness.calls.slotsInject, [
    'sidebar.right.pane.tab',
    'sidebar.right.pane.tab.title',
    'main',
    'sidebar.panellist',
  ])

  const registered = harness.calls.slotsRegister
  assert.deepEqual(registered.map(entry => entry.seat.name), [
    'sidebar.right.pane.tab',
    'sidebar.right.pane.tab.title',
    'main',
    'sidebar.panellist',
  ])
  assert.equal(registered.find(entry => entry.seat.name === 'main').seat.key, PANEL_ID)
  assert.equal(registered.find(entry => entry.seat.name === 'sidebar.panellist').seat.id, PANEL_ID)
  assert.equal(registered.find(entry => entry.seat.name === 'sidebar.panellist').seat.order, 7)

  harness.cleanup()
})

test('registerCaptureActions registers the assistant-actions entry as an icon-only 24x24 button', () => {
  const harness = createFakeContext()
  const captures = []

  registerCaptureActions(harness.ctx, {
    h,
    t,
    NS,
    services: { openCapture: (...args) => captures.push(args) },
  })

  assert.deepEqual(harness.calls.slotsInject, ['conversation.chat.assistant-actions'])
  const registration = harness.calls.slotsRegister.find(
    entry => entry.seat.name === 'conversation.chat.assistant-actions',
  )
  assert.ok(registration, 'capture entry must be registered on the message toolbar')
  assert.equal(registration.seat.id, 'punch-desk-capture')
  assert.equal(registration.seat.order, 30)

  const node = registration.component({ messageId: 'msg-1', sessionId: 'session-1' })
  assert.equal(node.type, 'button')
  assert.equal(node.props.title, t('capture.add'))
  assert.equal(node.props['aria-label'], t('capture.add'))
  assert.equal(node.props.style.width, 24)
  assert.equal(node.props.style.height, 24)
  assert.equal(textOf(node), '', 'the capture entry must not mix text into the message toolbar')

  node.props.onClick()
  assert.deepEqual(captures, [['session-1', { kind: 'message', messageId: 'msg-1' }]])
})

test('registerSeats falls back to conversation.view after 2.5s when the right sidebar never mounts', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const harness = createFakeContext({ services: {}, deferInject: true })
    registerSeats(harness.ctx, seats)

    assert.ok(!harness.calls.slotsInject.includes('conversation.view'))

    mock.timers.tick(2499)
    assert.ok(!harness.calls.slotsInject.includes('conversation.view'), 'fallback must not fire early')

    mock.timers.tick(1)
    assert.ok(harness.calls.slotsInject.includes('conversation.view'), 'fallback must register the pane view')

    const fallback = harness.calls.slotsRegister.find(entry => entry.seat.name === 'conversation.view')
    assert.ok(fallback)
    assert.equal(fallback.seat.id, TAB_ID)
    assert.equal(fallback.seat.name, 'conversation.view')
    assert.equal(CONVERSATION_VIEW_ID, 'conversation')

    harness.cleanup()
  } finally {
    mock.timers.reset()
  }
})
