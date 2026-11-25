/**
 * Shared test harness for DeskPage (`src/client/ui/desk.js`).
 * Extracted from `tests/desk-page.test.js` hook runtime pattern.
 */

export const h = (type, props, ...children) => ({
  type,
  props: props ?? {},
  children: children.flat(Infinity),
})

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
      return Component(props)
    },
    async runEffects() {
      for (const effect of effects) {
        if (!effect?.pending) continue
        effect.pending = false
        if (typeof effect.cleanup === 'function') effect.cleanup()
        const cleanup = await effect.fn()
        effect.cleanup = typeof cleanup === 'function' ? cleanup : null
      }
    },
    unmount() {
      for (const effect of effects) {
        if (typeof effect?.cleanup === 'function') effect.cleanup()
        if (effect) effect.cleanup = null
      }
    },
  }
}

export function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return (node.children ?? []).map(textOf).join(' ')
}

export function findNode(node, predicate) {
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

export function findButtonByAria(node, ariaLabel) {
  return findNode(node, item => {
    const isButtonLike = item.type === 'button' || typeof item.props?.onClick === 'function'
    if (!isButtonLike) return false
    return item.props?.['aria-label'] === ariaLabel || item.props?.title === ariaLabel
  })
}

export function findInputByPlaceholder(node, placeholder) {
  return findNode(node, item => item.type === 'input' && item.props?.placeholder === placeholder)
}

export function findButtonByLabel(node, pattern) {
  const matchFn = pattern instanceof RegExp
    ? text => pattern.test(text)
    : text => text.includes(String(pattern))
  return findNode(node, item => {
    const isButtonLike = item.type === 'button' || typeof item.props?.onClick === 'function'
    if (!isButtonLike) return false
    const candidates = [
      textOf(item),
      item.props?.['aria-label'],
      item.props?.title,
    ].filter(s => typeof s === 'string')
    return candidates.some(matchFn)
  })
}

export function createDeskHarness({ services } = {}) {
  const runtime = createHookRuntime()
  const flush = async () => {
    await runtime.runEffects()
    await new Promise(resolve => setTimeout(resolve, 10))
    await runtime.runEffects()
  }
  return {
    h,
    React: runtime.React,
    runtime,
    flush,
    services,
  }
}
