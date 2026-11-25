import test from 'node:test'
import assert from 'node:assert/strict'

import { createSessionPane } from '../src/client/ui/session-pane.js'
import { createSubmitService } from '../src/client/platform/submit.js'
import { dictionaries } from '../src/locale.js'

// ---------------------------------------------------------------------------
// Asset-inheritance isolation at the wiring layer (plan P1-1 remainder).
//
// The pure domain function is already covered by tests/inherit.test.js. These
// tests mount the real SessionPane with a fake hook runtime and drive the real
// inherit modal, so a regression that stops resolving the target workspace
// through services.resolveWorkspaceId (or stops passing it to the filter)
// surfaces as a cross-workspace finding in the candidate list.
// ---------------------------------------------------------------------------

const dicts = dictionaries()
const t = key => dicts.zh[key] ?? key

const h = (type, props, ...children) => ({
  type,
  props: props ?? {},
  children: children.flat(Infinity),
})

function createHookRuntime() {
  const states = new Map()
  const refs = new Map()
  const effects = []
  let hookCursor = 0
  let effectCursor = 0

  const sameDeps = (left, right) => left !== undefined && right !== undefined
    && left.length === right.length
    && left.every((value, index) => Object.is(value, right[index]))

  const React = {
    useState(initial) {
      const index = hookCursor++
      if (!states.has(index)) states.set(index, typeof initial === 'function' ? initial() : initial)
      const set = value => states.set(index, typeof value === 'function' ? value(states.get(index)) : value)
      return [states.get(index), set]
    },
    useRef(initial) {
      const index = hookCursor++
      if (!refs.has(index)) refs.set(index, { current: initial })
      return refs.get(index)
    },
    useCallback(fn) {
      return fn
    },
    useMemo(fn, deps) {
      const index = hookCursor++
      const previous = states.get(index)
      if (!previous || !sameDeps(previous.deps, deps)) {
        const value = fn()
        states.set(index, { deps, value })
        return value
      }
      return previous.value
    },
    useEffect(fn, deps) {
      const index = effectCursor++
      const previous = effects[index]
      if (!previous || !sameDeps(previous.deps, deps)) {
        effects[index] = { deps, fn, cleanup: previous?.cleanup ?? null, pending: true }
      } else if (previous.pending) {
        previous.fn = fn
      }
    },
    useLayoutEffect(fn, deps) {
      this.useEffect(fn, deps)
    },
  }

  return {
    React,
    render(Component, props) {
      hookCursor = 0
      effectCursor = 0
      const expand = node => {
        if (!node || typeof node !== 'object') return node
        if (Array.isArray(node)) return node.map(expand)
        if (typeof node.type === 'function') {
          const expandedProps = { ...(node.props || {}) }
          if (node.children?.length) {
            expandedProps.children = node.children.length === 1 ? node.children[0] : node.children
          }
          return expand(node.type(expandedProps))
        }
        return { ...node, children: (node.children || []).map(expand) }
      }
      return expand(Component(props))
    },
    async flushEffects() {
      for (const item of effects) {
        if (item.pending) {
          item.pending = false
          if (typeof item.cleanup === 'function') item.cleanup()
          item.cleanup = await item.fn()
        }
      }
    },
  }
}

function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return (node.children || []).map(textOf).join(' ')
}

function findAll(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, found)
    return found
  }
  if (predicate(node)) found.push(node)
  for (const child of node.children ?? []) findAll(child, predicate, found)
  return found
}

function finding(overrides) {
  return {
    id: 'f-default',
    kind: 'finding',
    status: 'open',
    submissionStatus: 'unsubmitted',
    reviewStatus: 'pending',
    sessionId: 'other',
    workspaceKey: 'session:other',
    workspaceId: 'ws-other',
    severity: 'optimize',
    text: 'Untitled',
    title: 'Untitled',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function createWiringStore(initialEntries) {
  const map = new Map(Object.entries(initialEntries))
  const listCalls = []
  return {
    map,
    listCalls,
    async listWorkspaces() {
      return [...map.keys()]
    },
    async listEntries(key) {
      listCalls.push(key)
      return (map.get(key) ?? []).map(entry => ({ ...entry }))
    },
    async getGroups() {
      return []
    },
    async putEntry(entry) {
      const list = map.get(entry.workspaceKey) ?? []
      map.set(entry.workspaceKey, [...list.filter(item => item.id !== entry.id), { ...entry }])
    },
    async deleteEntry(key, id) {
      map.set(key, (map.get(key) ?? []).filter(item => item.id !== id))
    },
    subscribe() {
      return () => {}
    },
    quotaWarning() {
      return false
    },
  }
}

async function settle(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }
}

/**
 * Mount the real SessionPane without a props.workspaceId so the pane must
 * resolve the target workspace through services.resolveWorkspaceId, exactly
 * like the production sidebar tab does.
 */
function mountPane(entriesByWorkspace, { titles = {}, resolveWorkspaceId = () => 'ws-a' } = {}) {
  const runtime = createHookRuntime()
  const store = createWiringStore(entriesByWorkspace)
  const resolveCalls = []
  const services = {
    t,
    store,
    uuid: () => 'uuid-inherit-1',
    submit: createSubmitService({ remote: { session: {} } }),
    resolveWorkspaceId: sessionId => {
      resolveCalls.push(sessionId)
      return resolveWorkspaceId(sessionId)
    },
    getSessionTitles: () => titles,
    getArchivedSessionIds: () => [],
    subscribeWorkspaceSnapshot: () => () => {},
  }
  const SessionPane = createSessionPane({ h, React: runtime.React, services })
  const render = () => runtime.render(SessionPane, { sessionId: 'curr' })
  return { runtime, store, resolveCalls, render }
}

async function openInheritModal(harness) {
  let tree = harness.render()
  await harness.runtime.flushEffects()
  await settle()
  tree = harness.render()

  const inheritButton = findAll(
    tree,
    node => node.type === 'button' && node.props.title === t('pool.importTitle'),
  )[0]
  assert.ok(inheritButton, 'the toolbar inherit button must be present')
  inheritButton.props.onClick()
  await settle()
  return harness.render()
}

test('cross-workspace findings never enter the inherit candidates (wiring path)', async () => {
  const harness = mountPane({
    'session:curr': [],
    'session:other': [
      finding({
        id: 'f-same-ws',
        thoughtNo: 2,
        workspaceId: 'ws-a',
        title: 'Same workspace pending',
        text: 'Same workspace pending',
      }),
      finding({
        id: 'f-cross-ws',
        thoughtNo: 3,
        workspaceId: 'ws-other',
        title: 'Cross workspace secret',
        text: 'Cross workspace secret',
      }),
    ],
    'session:foreign': [
      finding({
        id: 'f-foreign',
        thoughtNo: 1,
        sessionId: 'foreign',
        workspaceKey: 'session:foreign',
        workspaceId: 'ws-other',
        title: 'Foreign-only secret',
        text: 'Foreign-only secret',
      }),
    ],
  }, {
    titles: { other: { title: 'Source A' }, foreign: { title: 'Foreign B' } },
  })

  let tree = harness.render()
  await harness.runtime.flushEffects()
  await settle()
  tree = harness.render()

  // The empty-pool hint counts only findings that are actually inheritable.
  const hint = t('pool.importPillHint').replace('{count}', '1')
  assert.ok(textOf(tree).includes(hint), 'the hint must count only same-workspace findings')
  assert.ok(!textOf(tree).includes('Cross workspace secret'))
  assert.ok(!textOf(tree).includes('Foreign-only secret'))

  // The target workspace came from services, not from a props.workspaceId.
  assert.ok(harness.resolveCalls.includes('curr'), 'resolveWorkspaceId must be used for the current session')

  // Both other sessions were scanned; the filter did the isolation.
  assert.ok(harness.store.listCalls.includes('session:other'))
  assert.ok(harness.store.listCalls.includes('session:foreign'))

  tree = await openInheritModal(harness)
  const dialog = findAll(tree, node => node.props?.role === 'dialog')[0]
  assert.ok(dialog, 'the inherit modal must open from the toolbar')
  const dialogText = textOf(dialog)
  assert.ok(dialogText.includes('Same workspace pending'), 'same-workspace finding must be offered')
  assert.ok(!dialogText.includes('Cross workspace secret'), 'cross-workspace finding must not be offered')
  assert.ok(!dialogText.includes('Foreign-only secret'), 'a session with only cross-workspace findings must not be listed')

  const options = findAll(dialog, node => node.type === 'option').map(textOf)
  assert.deepEqual(options, ['Source A (1)'])
})

test('Move renumbers inherited thought numbers against the target session (wiring path)', async () => {
  const harness = mountPane({
    'session:curr': [
      finding({
        id: 'c-1',
        sessionId: 'curr',
        workspaceKey: 'session:curr',
        workspaceId: 'ws-a',
        thoughtNo: 1,
        title: 'Current one',
        text: 'Current one',
      }),
      finding({
        id: 'c-5',
        sessionId: 'curr',
        workspaceKey: 'session:curr',
        workspaceId: 'ws-a',
        thoughtNo: 5,
        title: 'Current five',
        text: 'Current five',
      }),
    ],
    'session:other': [
      finding({
        id: 'f-move-me',
        thoughtNo: 2,
        workspaceId: 'ws-a',
        title: 'Move me',
        text: 'Move me',
      }),
    ],
  }, {
    titles: { other: { title: 'Source A' } },
  })

  const tree = await openInheritModal(harness)
  const moveButton = findAll(tree, node => node.type === 'button')
    .find(node => textOf(node).includes(t('pool.importMoveAction')))
  assert.ok(moveButton, 'the Move action must be offered')
  assert.equal(moveButton.props.disabled, false)

  moveButton.props.onClick()
  await settle(20)

  const targetEntries = harness.store.map.get('session:curr') ?? []
  assert.deepEqual(targetEntries.map(entry => entry.thoughtNo).sort((a, b) => a - b), [1, 5, 6])

  const moved = targetEntries.find(entry => entry.id === 'f-move-me')
  assert.ok(moved, 'the moved finding must land in the target session')
  assert.equal(moved.thoughtNo, 6, 'Move must renumber against the target session max (5), not keep source #2')
  assert.equal(moved.sessionId, 'curr')
  assert.equal(moved.workspaceKey, 'session:curr')
  assert.equal(moved.status, 'open')
  assert.equal(moved.submissionStatus, 'unsubmitted')
  assert.equal(new Set(targetEntries.map(entry => entry.thoughtNo)).size, targetEntries.length)

  const sourceEntries = harness.store.map.get('session:other') ?? []
  assert.deepEqual(sourceEntries, [], 'Move must delete the finding from the source session')

  const afterMove = harness.render()
  assert.ok(textOf(afterMove).includes('#6'), 'the inherited row must render the renumbered thought number')
})

test('the inherit modal offers interactive scope toggle defaulting to prefs (dual-entry UX)', async () => {
  const harness = mountPane({
    'session:curr': [],
    'session:other': [
      finding({ id: 'f1', thoughtNo: 1, workspaceId: 'ws-a', title: 'Task 1', text: 'Task 1' }),
    ],
  }, {
    titles: { other: { title: 'Source A' } },
  })

  const tree = await openInheritModal(harness)
  const dialog = findAll(tree, node => node.props?.role === 'dialog')[0]
  assert.ok(dialog, 'dialog must open')

  // Interactive buttons must exist and default to workspace
  const scopeButtons = findAll(dialog, node => node.type === 'button')
    .filter(node => node.props['aria-pressed'] !== undefined)
  assert.equal(scopeButtons.length, 2, 'both workspace and all scope toggle buttons must be rendered')
  assert.equal(scopeButtons[0].props['aria-pressed'], true, 'default scope button should be workspace')
  assert.equal(scopeButtons[1].props['aria-pressed'], false)

  // Clicking 'all' button toggles the scope
  scopeButtons[1].props.onClick()
  await settle(20)
  const updatedTree = harness.render()
  const updatedDialog = findAll(updatedTree, node => node.props?.role === 'dialog')[0]
  const updatedButtons = findAll(updatedDialog, node => node.type === 'button')
    .filter(node => node.props['aria-pressed'] !== undefined)
  assert.equal(updatedButtons[1].props['aria-pressed'], true, 'all button should now be pressed')
})
