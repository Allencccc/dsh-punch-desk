import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createSessionPane, dedupeEntriesById, upsertEntryState,
} from '../src/client/ui/session-pane.js'
import { dictionaries } from '../src/locale.js'

const dicts = dictionaries()
const t = key => dicts.zh[key] ?? key

const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) })

function createHookRuntime() {
  const states = new Map()
  const refs = new Map()
  const effects = []
  let hookCursor = 0
  let effectCursor = 0
  const sameDeps = (left, right) => left !== undefined && right !== undefined
    && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))

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
    useCallback(fn) { return fn },
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
    useLayoutEffect(fn, deps) { this.useEffect(fn, deps) },
  }

  const expand = node => {
    if (!node || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map(expand)
    if (typeof node.type === 'function') {
      const props = { ...(node.props || {}) }
      if (node.children?.length) props.children = node.children.length === 1 ? node.children[0] : node.children
      return expand(node.type(props))
    }
    return { ...node, children: (node.children || []).map(expand) }
  }

  return {
    React,
    render(Component, props) { hookCursor = 0; effectCursor = 0; return expand(Component(props)) },
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

function findNode(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findNode(child, predicate)
      if (found) return found
    }
    return undefined
  }
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    const found = findNode(child, predicate)
    if (found) return found
  }
  return undefined
}

function createStore({ entries = [], workspaces = ['session:curr'], groups = [] } = {}) {
  const map = new Map(Object.entries(entries))
  return {
    map,
    async listWorkspaces() { return [...map.keys(), ...workspaces.filter(key => !map.has(key))] },
    async listEntries(key) { return (map.get(key) ?? []).map(entry => ({ ...entry })) },
    async getGroups() { return groups },
    async putEntry(entry) {
      const list = map.get(entry.workspaceKey) ?? []
      map.set(entry.workspaceKey, [...list.filter(item => item.id !== entry.id), { ...entry }])
    },
    async deleteEntry(key, id) { map.set(key, (map.get(key) ?? []).filter(item => item.id !== id)) },
    subscribe() { return () => {} },
  }
}

function finding(over = {}) {
  return {
    id: 'f-1', kind: 'finding', sessionId: 'curr', workspaceKey: 'session:curr', workspaceId: 'ws-a',
    text: 'Pool finding', body: 'Pool finding', title: 'Pool finding',
    severity: 'optimize', tag: 'optimize', status: 'open', submissionStatus: 'unsubmitted', reviewStatus: 'pending',
    createdAt: 1, updatedAt: 1, thoughtNo: 1, ...over,
  }
}

function mountPane({ store, archived = [], props = {} }) {
  const runtime = createHookRuntime()
  const SessionPane = createSessionPane({
    h,
    React: runtime.React,
    services: {
      t,
      store,
      uuid: () => 'uuid-1',
      getArchivedSessionIds: () => archived,
      subscribeWorkspaceSnapshot: () => () => {},
    },
  })
  const render = () => runtime.render(SessionPane, { sessionId: 'curr', workspaceId: 'ws-a', ...props })
  return { runtime, render, SessionPane }
}

test('dedupeEntriesById keeps one entry per id and drops the ghost copy', () => {
  const entries = [
    { id: 'a', updatedAt: 1 },
    { id: 'b', updatedAt: 1 },
    { id: 'a', updatedAt: 2 },
    null,
  ]
  assert.deepEqual(dedupeEntriesById(entries).map(entry => entry.id), ['a', 'b'])
  assert.equal(dedupeEntriesById(entries)[0].updatedAt, 2)
  assert.deepEqual(dedupeEntriesById(null), [])
})

test('upsertEntryState never duplicates an id', () => {
  const current = [{ id: 'a', n: 1 }, { id: 'b', n: 1 }]
  const replaced = upsertEntryState(current, { id: 'a', n: 2 })
  assert.equal(replaced.length, 2)
  assert.equal(replaced.find(entry => entry.id === 'a').n, 2)
  const inserted = upsertEntryState(current, { id: 'c', n: 1 })
  assert.deepEqual(inserted.map(entry => entry.id), ['c', 'a', 'b'])
  assert.deepEqual(upsertEntryState(null, { id: 'a' }), [{ id: 'a' }])
})

test('an archived current session shows the archived badge and locks submission', async () => {
  const store = createStore({ entries: { 'session:curr': [finding()] } })
  const { runtime, render } = mountPane({ store, archived: ['curr'] })

  render()
  await runtime.flushEffects()
  let view = render()
  await runtime.flushEffects()
  view = render()

  assert.ok(textOf(view).includes(t('session.archivedBadge')), 'the pane must project the Harness archive state')

  // Select the single pool item, then the submit buttons must stay disabled
  // because the host gate rejects every step of an archived session.
  const checkbox = findNode(view, node => node.type === 'input' && node.props?.id === 'selectAllCheckbox')
  assert.ok(checkbox, 'expected the pool select-all checkbox')
  checkbox.props.onChange()
  view = render()

  const sequenceButton = findNode(view, node => typeof node.props?.onClick === 'function'
    && textOf(node).includes(dicts.zh['dock.submitSequential']))
  assert.ok(sequenceButton, 'expected the sequential submit button')
  assert.equal(sequenceButton.props.disabled, true)
})

test('inheritance still lists unsubmitted findings from archived sessions', async () => {
  const archivedFinding = finding({
    id: 'f-archived', sessionId: 'archived-src', workspaceKey: 'session:archived-src',
    text: 'Rescue this archived finding', body: 'Rescue this archived finding', title: 'Rescue this archived finding',
  })
  const store = createStore({
    entries: { 'session:curr': [], 'session:archived-src': [archivedFinding] },
    workspaces: ['session:curr', 'session:archived-src'],
  })
  const { runtime, render } = mountPane({
    store,
    archived: ['archived-src'],
    props: { useSessions: { byId: { 'archived-src': { title: 'Archived session' } } } },
  })

  render()
  await runtime.flushEffects()
  let view = render()
  await runtime.flushEffects()
  view = render()

  // Open the inheritance modal from the pool toolbar.
  const inheritButton = findNode(view, node => typeof node.props?.onClick === 'function'
    && node.props?.title === dicts.zh['pool.importTitle'])
  assert.ok(inheritButton, 'expected the inherit toolbar button')
  inheritButton.props.onClick()
  view = render()

  assert.match(textOf(view), /Rescue this archived finding/,
    'archived sessions must stay available as inheritance sources')
})

test('forking a finding assigns a fresh display number from the current pool', async () => {
  const resolved = finding({
    id: 'f-resolved', thoughtNo: 7, status: 'resolved', submissionStatus: 'submitted',
    reviewStatus: 'resolved', submittedAt: 1, resolvedAt: 1, assignedGroupId: 'g-archived',
  })
  const store = createStore({
    entries: {
      'session:curr': [
        resolved,
        finding({ id: 'f-1', thoughtNo: 1 }),
        finding({ id: 'f-2', thoughtNo: 2 }),
      ],
    },
    groups: [{
      id: 'g-archived', groupNumber: 1, sessionId: 'curr', workspaceId: 'ws-a',
      status: 'archived', items: [{ findingId: 'f-resolved', order: 0 }], createdAt: 1,
    }],
  })
  const { runtime, render } = mountPane({ store })

  render()
  await runtime.flushEffects()
  let view = render()
  await runtime.flushEffects()
  view = render()

  const forkButton = findNode(view, node => typeof node.props?.onClick === 'function'
    && node.props?.title === dicts.zh['entry.forkRound'].replace('{round}', '2'))
  assert.ok(forkButton, 'expected the fork action on the resolved finding')
  await forkButton.props.onClick()

  const current = store.map.get('session:curr') || []
  const forked = current.find(entry => entry.id !== 'f-resolved' && entry.id !== 'f-1' && entry.id !== 'f-2')
  assert.ok(forked, 'expected a forked finding in the store')
  assert.equal(forked.thoughtNo, 8, 'the fork must be renumbered from the current pool, not copy #7')
  assert.equal(current.filter(entry => entry.thoughtNo === 8).length, 1)
  assert.equal(forked.reviewRound, 2, 'the fork starts round 2')
  assert.ok(forked.text.startsWith(dicts.zh['entry.forkRoundNote'].replace('{round}', '2') + '\n'), 'the fork carries a round note')
})


test('collapsing one archived group keeps sibling groups expanded', async () => {
  const store = createStore({
    entries: {
      'session:curr': [
        finding({ id: 'f-a', text: 'alpha finding', title: 'alpha finding', assignedGroupId: 'g-a', status: 'resolved', submissionStatus: 'submitted' }),
        finding({ id: 'f-b', text: 'beta finding', title: 'beta finding', assignedGroupId: 'g-b', status: 'resolved', submissionStatus: 'submitted' }),
      ],
    },
    groups: [
      { id: 'g-a', groupNumber: 1, sessionId: 'curr', workspaceId: 'ws-a', status: 'archived', items: [{ findingId: 'f-a', order: 0 }], createdAt: 1 },
      { id: 'g-b', groupNumber: 2, sessionId: 'curr', workspaceId: 'ws-a', status: 'archived', items: [{ findingId: 'f-b', order: 0 }], createdAt: 2 },
    ],
  })
  const { runtime, render } = mountPane({ store })

  render()
  await runtime.flushEffects()
  let view = render()
  await runtime.flushEffects()
  view = render()

  assert.match(textOf(view), /alpha finding/)
  assert.match(textOf(view), /beta finding/)

  const header = findNode(view, node => node.type === 'div'
    && typeof node.props?.onClick === 'function'
    && textOf(node).includes(t('group.title').replace('{number}', '1')))
  assert.ok(header, 'expected the archived group #1 header toggle')

  header.props.onClick()
  view = render()

  assert.ok(!textOf(view).includes('alpha finding'), 'collapsing a group hides only its own findings')
  assert.match(textOf(view), /beta finding/, 'sibling archived groups must stay expanded')
})
