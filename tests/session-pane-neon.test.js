import test from 'node:test'
import assert from 'node:assert/strict'
import { createFindingRecord } from '../src/domain/entries.js'
import { createSubmitService } from '../src/client/platform/submit.js'
import { createSessionPane } from '../src/client/ui/session-pane.js'
import { createHookRuntime, h, t } from './helpers/pane-harness.js'

function findTextarea(node) {
  if (!node || typeof node !== 'object') return null
  if (node.type === 'textarea') return node
  for (const child of node.children ?? []) {
    const found = findTextarea(child)
    if (found) return found
  }
  return null
}

function findButtonByLabel(node, label) {
  if (!node || typeof node !== 'object') return null
  if (node.type === 'button' && typeof node.props?.onClick === 'function'
    && String(node.children?.join('') ?? '').includes(label)) return node
  for (const child of node.children ?? []) {
    const found = findButtonByLabel(child, label)
    if (found) return found
  }
  return null
}

function makePane(runtime, entries) {
  const services = {
    t,
    store: {
      listEntries: async () => entries,
      putEntry: async entry => { entries.push(entry) },
      getGroups: async () => [],
      putGroup: async () => {},
      subscribe: () => () => {},
      quotaWarning: () => false,
    },
    index: { listRecent: async () => [], start: () => {}, stop: () => {}, track: async () => {} },
    submit: createSubmitService({
      remote: {
        session: {
          prompt: async () => ({ ok: true, value: { accepted: true } }),
          state: async () => ({ ok: true, value: { queue: [] } }),
        },
      },
      uuid: () => 'req-neon',
    }),
    createFinding: args => createFindingRecord(args),
    uuid: () => 'uuid-neon',
  }
  return createSessionPane({ h, React: runtime.React, services })
}

test('typing the marker alone does not light the composer', async () => {
  const runtime = createHookRuntime()
  const SessionPane = makePane(runtime, [])
  const view = () => runtime.render(SessionPane, { sessionId: 's-1' })
  view()
  await runtime.flushEffects()
  let tree = runtime.render(SessionPane, { sessionId: 's-1' })

  findTextarea(tree).props.onChange({ target: { value: '决定走 A 方案 [AC]', selectionStart: 12 } })
  tree = runtime.render(SessionPane, { sessionId: 's-1' })
  assert.ok(!String(findTextarea(tree).props.className ?? '').includes('pd-neon'),
    'typing must not trigger the glow by itself')
})

test('saving a body with the marker to the pool lights the composer, saving without it does not', async () => {
  const runtime = createHookRuntime()
  const entries = []
  const SessionPane = makePane(runtime, entries)
  const view = () => runtime.render(SessionPane, { sessionId: 's-1' })
  view()
  await runtime.flushEffects()
  let tree = runtime.render(SessionPane, { sessionId: 's-1' })

  // Save without the marker → no glow.
  findTextarea(tree).props.onChange({ target: { value: '普通一条手账', selectionStart: 6 } })
  tree = runtime.render(SessionPane, { sessionId: 's-1' })
  await findButtonByLabel(tree, t('composer.saveToPool')).props.onClick()
  tree = runtime.render(SessionPane, { sessionId: 's-1' })
  assert.ok(!String(findTextarea(tree).props.className ?? '').includes('pd-neon'))

  // Save with the marker → the composer flashes (armed by the save, not typing).
  findTextarea(tree).props.onChange({ target: { value: '决定走 A 方案 [AC]', selectionStart: 12 } })
  tree = runtime.render(SessionPane, { sessionId: 's-1' })
  await findButtonByLabel(tree, t('composer.saveToPool')).props.onClick()
  tree = runtime.render(SessionPane, { sessionId: 's-1' })
  assert.match(String(findTextarea(tree).props.className), /pd-neon/,
    'the saved body carrying the marker arms the glow')
})
