import test from 'node:test'
import assert from 'node:assert/strict'
import {
  openSessionPane, TAB_ID, PANEL_ID, CONVERSATION_VIEW_ID,
} from '../src/client/platform/register.js'

function makeCtx(services) {
  return { get: (name) => services[name] }
}

test('openSessionPane prefers the right sidebar tab when the tab type can register', () => {
  const calls = []
  const ctx = makeCtx({
    sidebarRightTabs: { register: () => {} },
    sidebarRight: { openTab: (id) => calls.push(['openTab', id]) },
    layout: { selectPanel: (id) => calls.push(['selectPanel', id]) },
  })

  assert.equal(openSessionPane(ctx), true)
  assert.deepEqual(calls, [['openTab', TAB_ID]])
})

test('openSessionPane falls back to the conversation view, not the Desk placeholder', () => {
  const calls = []
  const ctx = makeCtx({
    layout: { selectPanel: (id) => calls.push(['selectPanel', id]) },
  })

  assert.equal(openSessionPane(ctx), true)
  assert.deepEqual(calls, [['selectPanel', CONVERSATION_VIEW_ID]])
  assert.equal(CONVERSATION_VIEW_ID, 'conversation')
  assert.notEqual(CONVERSATION_VIEW_ID, PANEL_ID)
})

test('openSessionPane treats a missing tab type as the fallback even with sidebarRight', () => {
  const calls = []
  const ctx = makeCtx({
    sidebarRight: { openTab: (id) => calls.push(['openTab', id]) },
    layout: { selectPanel: (id) => calls.push(['selectPanel', id]) },
  })

  assert.equal(openSessionPane(ctx), true)
  assert.deepEqual(calls, [['selectPanel', CONVERSATION_VIEW_ID]])
})

test('openSessionPane returns false when neither seat exists', () => {
  assert.equal(openSessionPane(makeCtx({})), false)
})
