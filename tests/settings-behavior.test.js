import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessionPane } from '../src/client/ui/session-pane.js'
import { createSubmitService } from '../src/client/platform/submit.js'
import { DEFAULT_PREFS } from '../src/client/prefs.js'
import { dictionaries } from '../src/locale.js'

const dicts = dictionaries()
const t = key => dicts.zh[key] ?? key

const h = (type, props, ...children) => {
  if (typeof type === 'function') {
    return type({ ...(props ?? {}), children: children.flat(Infinity) })
  }
  return {
    type,
    props: props ?? {},
    children: children.flat(Infinity),
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

function mountPaneWithPrefs(prefsOverride = {}, initialEntries = [], initialGroups = []) {
  const runtime = createHookRuntime()
  const currentPrefs = { ...DEFAULT_PREFS, ...prefsOverride }
  const store = {
    async getPrefs() { return { ...currentPrefs } },
    async setPrefs(p) { Object.assign(currentPrefs, p) },
    async listWorkspaces() { return ['session:curr'] },
    async listEntries(key) { return key === 'session:curr' ? initialEntries : [] },
    async listPromptLog() { return [] },
    async getGroups() { return initialGroups },
    subscribe() { return () => {} },
    quotaWarning() { return false },
  }
  const services = {
    t,
    store,
    uuid: () => 'uuid-1',
    submit: createSubmitService({ remote: { session: {} } }),
    resolveWorkspaceId: () => 'ws-curr',
    getSessionTitles: () => ({}),
    getArchivedSessionIds: () => [],
    subscribeWorkspaceSnapshot: () => () => {},
  }
  const SessionPane = createSessionPane({ h, React: runtime.React, services })
  const render = () => runtime.render(SessionPane, { sessionId: 'curr' })
  return { runtime, render, store }
}

test('SessionPane composer rows adapts to composerRows preference (Gate B)', async () => {
  const harness = mountPaneWithPrefs({ composerRows: 5 })
  let tree = harness.render()
  await harness.runtime.flushEffects()
  tree = harness.render()

  const composerTextarea = findAll(tree, node => node.type === 'textarea' && node.props.placeholder === t('composer.placeholder'))[0]
  assert.ok(composerTextarea, 'composer textarea must be found')
  assert.equal(composerTextarea.props.rows, 5, 'composer rows must reflect preference')
})

test('SessionPane sequential cost hint respects sequentialCostHint preference (Gate B)', async () => {
  const entries = [
    { id: 'f1', kind: 'finding', status: 'open', submissionStatus: 'unsubmitted', title: 'T1', text: 'T1', createdAt: 1, updatedAt: 1 },
  ]

  // When sequentialCostHint is 'always', 1 item is enough to show cost hint
  const harnessAlways = mountPaneWithPrefs({ sequentialCostHint: 'always' }, entries)
  let treeAlways = harnessAlways.render()
  await harnessAlways.runtime.flushEffects()
  treeAlways = harnessAlways.render()

  // Select the item
  const checkboxes = findAll(treeAlways, n => n.type === 'input' && n.props.type === 'checkbox')
  assert.ok(checkboxes.length > 0)
  checkboxes[checkboxes.length - 1].props.onChange({ target: { checked: true } })
  treeAlways = harnessAlways.render()

  const costAlways = findAll(treeAlways, n => n.props?.id === 'dockSequentialCost')[0]
  assert.ok(costAlways, 'sequential cost hint must be visible when set to always and 1 item is selected')

  // When sequentialCostHint is 'off', cost hint must NOT show even with 2 items
  const twoEntries = [
    { id: 'f1', kind: 'finding', status: 'open', submissionStatus: 'unsubmitted', title: 'T1', text: 'T1', createdAt: 1, updatedAt: 1 },
    { id: 'f2', kind: 'finding', status: 'open', submissionStatus: 'unsubmitted', title: 'T2', text: 'T2', createdAt: 2, updatedAt: 2 },
  ]
  const harnessOff = mountPaneWithPrefs({ sequentialCostHint: 'off' }, twoEntries)
  let treeOff = harnessOff.render()
  await harnessOff.runtime.flushEffects()
  treeOff = harnessOff.render()

  // Select all items
  const selectAll = findAll(treeOff, n => n.type === 'button' && textOf(n).includes(t('pool.selectAll')))[0]
  if (selectAll) {
    selectAll.props.onClick()
    treeOff = harnessOff.render()
  }
  const costOff = findAll(treeOff, n => n.props?.id === 'dockSequentialCost')[0]
  assert.equal(costOff, undefined, 'sequential cost hint must be hidden when set to off')
})

test('SessionPane archived history section maxHeight respects archivedHistoryHeight preference (Gate B)', async () => {
  const groups = [
    { id: 'g1', name: 'Group 1', status: 'archived', items: [], createdAt: 1, updatedAt: 1 },
  ]

  const harnessCompact = mountPaneWithPrefs({ archivedHistoryHeight: 'compact' }, [], groups)
  let tree = harnessCompact.render()
  await harnessCompact.runtime.flushEffects()
  tree = harnessCompact.render()

  const section = findAll(tree, n => n.props?.id === 'archivedSectionContainer')[0]
  assert.ok(section, 'archived section container must be rendered')
  assert.equal(section.props.style.maxHeight, 240, 'compact maxHeight must be 240px')

  const harnessTall = mountPaneWithPrefs({ archivedHistoryHeight: 'tall' }, [], groups)
  let treeTall = harnessTall.render()
  await harnessTall.runtime.flushEffects()
  treeTall = harnessTall.render()
  const sectionTall = findAll(treeTall, n => n.props?.id === 'archivedSectionContainer')[0]
  assert.equal(sectionTall.props.style.maxHeight, 360, 'tall maxHeight must be 360px')
})
