import { createFindingRecord } from '../../src/domain/entries.js'
import { createSessionPane } from '../../src/client/ui/session-pane.js'
import { dictionaries } from '../../src/locale.js'

const dicts = dictionaries()
export const t = key => dicts.zh[key] ?? key

export const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) })

export function createHookRuntime() {
  const states = new Map()
  const refs = new Map()
  const effects = []
  let hookCursor = 0
  let effectCursor = 0
  const sameDeps = (left, right) => {
    if (left === undefined || right === undefined) return false
    if (left.length !== right.length) return false
    return left.every((value, index) => Object.is(value, right[index]))
  }
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
      const prev = states.get(index)
      if (!prev || !sameDeps(prev.deps, deps)) { const val = fn(); states.set(index, { deps, val }); return val }
      return prev.val
    },
    useEffect(fn, deps) {
      const index = effectCursor++
      const previous = effects[index]
      if (!previous || !sameDeps(previous.deps, deps)) effects[index] = { deps, fn, cleanup: previous?.cleanup ?? null, pending: true }
    },
    useLayoutEffect(fn, deps) { this.useEffect(fn, deps) },
  }
  return {
    React,
    render(Component, props) {
      hookCursor = 0
      effectCursor = 0
      const tree = Component(props)
      function expandVNode(node) {
        if (!node || typeof node !== 'object') return node
        if (Array.isArray(node)) return node.map(expandVNode)
        if (typeof node.type === 'function') {
          const p = { ...(node.props || {}) }
          if (node.children?.length) p.children = node.children.length === 1 ? node.children[0] : node.children
          return expandVNode(node.type(p))
        }
        return { ...node, children: (node.children || []).map(expandVNode) }
      }
      return expandVNode(tree)
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

export function flattenButtons(node, acc = []) {
  if (!node || typeof node !== 'object') return acc
  if (node.type === 'button') acc.push(node)
  for (const child of node.children || []) flattenButtons(child, acc)
  return acc
}

export function textOfNode(node) {
  if (!node) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOfNode).join('')
  if (typeof node === 'object') return (node.children || []).map(textOfNode).join('')
  return ''
}

export function findButtonByLabel(node, pattern) {
  const regex = pattern instanceof RegExp ? pattern : new RegExp(String(pattern), 'i')
  const matches = flattenButtons(node).filter(b => {
    const candidates = [
      textOfNode(b),
      b.props?.['aria-label'],
      b.props?.title,
      b.props?.['data-action'],
      b.props?.['data-label'],
    ].filter(s => typeof s === 'string')
    return candidates.some(s => regex.test(s))
  })
  if (matches.length > 1) {
    const findingBtn = matches.find(b => b.props?.['data-action'] === 'finding-commit-trace')
    if (findingBtn) return findingBtn
  }
  return matches[0] || null
}

export function makePaneHarness({ groups = [], entries = [], traces = [], promptLogRows = [] } = {}) {
  const { React, render, flushEffects } = createHookRuntime()
  const groupsStore = groups
  const entriesStore = entries
  const tracesStore = [...traces]
  const deleted = []
  const retryCalls = []
  const subscribers = new Set()

  const notifySubscribers = () => {
    for (const fn of [...subscribers]) {
      fn()
    }
  }

  const services = {
    t,
    store: {
      listEntries: async () => entriesStore,
      putEntry: async (e) => {
        const idx = entriesStore.findIndex(x => x.id === e.id)
        if (idx >= 0) entriesStore[idx] = e
        else entriesStore.push(e)
      },
      getGroups: async () => groupsStore,
      putGroup: async (g) => {
        const idx = groupsStore.findIndex(x => x.id === g.id)
        if (idx >= 0) groupsStore[idx] = g
        else groupsStore.push(g)
      },
      deleteEntry: async (workspaceKey, id) => {
        deleted.push(id)
        const idx = entriesStore.findIndex(item => item.id === id)
        if (idx >= 0) entriesStore.splice(idx, 1)
      },
      listCommitTraces: () => tracesStore,
      putCommitTraces: async (_key, next) => {
        tracesStore.splice(0, tracesStore.length, ...(Array.isArray(next) ? next : []))
        notifySubscribers()
      },
      subscribe: (fn) => {
        if (typeof fn === 'function') subscribers.add(fn)
        return () => subscribers.delete(fn)
      },
      quotaWarning: () => false,
    },
    commitTraces: {
      retryTrace: async ({ sessionId, traceId }) => {
        retryCalls.push({ sessionId, traceId })
        return { ok: true }
      },
    },
    index: { listRecent: async () => promptLogRows, start: () => {}, stop: () => {}, track: async () => {} },
    submit: {
      submitCombined: async () => ({ ok: true, accepted: true }),
      submitSequential: async () => ({ ok: true, requests: [] }),
    },
    createFinding: (args) => createFindingRecord(args),
    uuid: () => 'uuid-ux',
  }

  const setTraces = (nextTraces) => {
    tracesStore.splice(0, tracesStore.length, ...(Array.isArray(nextTraces) ? nextTraces : []))
    notifySubscribers()
  }

  const SessionPane = createSessionPane({ h, React, services })
  return {
    React,
    render,
    flushEffects,
    SessionPane,
    groupsStore,
    entriesStore,
    tracesStore,
    deleted,
    retryCalls,
    setTraces,
    services,
  }
}
