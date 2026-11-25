import test from 'node:test'
import assert from 'node:assert/strict'
import { registerQuoteInteraction } from '../src/client/ui/quote-interaction.js'
import { createSessionPane } from '../src/client/ui/session-pane.js'
import { createLocalDeskStore } from '../src/store/local.js'
import { dictionaries } from '../src/locale.js'
import { setDefaultH } from '../src/client/ui/icons.js'

const dicts = dictionaries()
const t = (k) => dicts.zh[k] ?? k

const h = (type, props, ...children) => ({
  type,
  props: {
    ...(props || {}),
    children: children.flat(),
  },
})
setDefaultH(h)

const React = {
  createElement: h,
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (init) => ({ current: init }),
}

test('quote-interaction decorates native surface safely without throwing', () => {
  let captured = null
  const services = {
    getActiveSessionId: () => 'session-123',
    openCapture: (sid, payload) => {
      captured = { sid, payload }
    },
  }

  const ctx = {
    effect: (fn) => fn(),
  }

  // Running in non-browser Node environment gracefully degrades
  registerQuoteInteraction(ctx, { h, t, NS: 'test', services })
  assert.equal(captured, null)
})

test('session-pane consumes quote pending capture and instantiates without errors', async () => {
  const store = createLocalDeskStore()
  let pendingHandoff = {
    kind: 'quote',
    text: 'const a = 1\nconst b = 2',
    turn: 3,
    messageId: 'msg-456',
  }

  const services = {
    t,
    store,
    createFinding: (input) => ({ id: 'f-1', ...input }),
    takePendingCapture: (sid) => {
      const val = pendingHandoff
      pendingHandoff = null
      return val
    },
    subscribePendingCapture: (fn) => () => {},
  }

  const SessionPane = createSessionPane({ h, React, services })
  const element = SessionPane({ sessionId: 'session-quote-test' })
  assert.ok(element)
})

test('session-pane composer handles slash commands and context mentions autocomplete downward', async () => {
  let hookIndex = 0
  const stateValues = []

  const mockReact = {
    createElement: h,
    useState: (init) => {
      const currentIdx = hookIndex++
      if (stateValues.length <= currentIdx) {
        stateValues[currentIdx] = typeof init === 'function' ? init() : init
      }
      const setter = (next) => {
        stateValues[currentIdx] = typeof next === 'function' ? next(stateValues[currentIdx]) : next
      }
      return [stateValues[currentIdx], setter]
    },
    useEffect: (fn) => fn(),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (init) => ({ current: init }),
  }

  const store = createLocalDeskStore()
  const services = {
    t,
    store,
    createFinding: (input) => ({ id: 'f-1', ...input }),
    takePendingCapture: () => null,
    subscribePendingCapture: () => () => {},
    listCommands: async () => [
      { name: 'plan', label: '/plan', description: '分步规划', insert: '/plan ' },
      { name: 'goal', label: '/goal', description: '设定长任务目标', insert: '/goal ' },
    ],
    listSkills: async () => [
      { name: 'modern-web-guidance', label: '/modern-web-guidance', description: '现代化 Web 最佳实践', insert: '/modern-web-guidance ' },
    ],
    listFilesAndSessions: async () => ({
      files: [
        { name: 'AGENTS.md', path: 'AGENTS.md', description: '协作规范', insert: '@AGENTS.md ' },
        { name: 'session-pane.js', path: 'src/client/ui/session-pane.js', description: '会话抽屉 UI', insert: '@src/client/ui/session-pane.js ' },
      ],
      sessions: [{ id: 's-1', title: '会话 1' }],
    }),
  }

  const SessionPane = createSessionPane({ h, React: mockReact, services })
  hookIndex = 0
  let vdom = SessionPane({ sessionId: 'session-autocomplete-test' })
  assert.ok(vdom)

  function findChild(node, predicate) {
    if (!node) return null
    if (predicate(node)) return node
    const ch = node.props?.children
    if (Array.isArray(ch)) {
      for (const c of ch) {
        const found = findChild(c, predicate)
        if (found) return found
      }
    } else if (ch && typeof ch === 'object') {
      return findChild(ch, predicate)
    }
    return null
  }

  const textareaNode = findChild(vdom, n => n.type === 'textarea')
  assert.ok(textareaNode)
  assert.equal(typeof textareaNode.props.onChange, 'function')
  assert.equal(typeof textareaNode.props.onKeyDown, 'function')
  assert.equal(typeof textareaNode.props.onClick, 'function')

  // Trigger slash command popover
  await textareaNode.props.onChange({ target: { value: '/p', selectionStart: 2 } })
  hookIndex = 0
  vdom = SessionPane({ sessionId: 'session-autocomplete-test' })
  const slashPopover = findChild(vdom, n => n.props?.id === 'composerAutocompletePopover')
  assert.ok(slashPopover, 'Slash popover should be open')
  assert.equal(slashPopover.props.style.top, 'calc(100% + 4px)', 'Must pop downward')
  assert.equal(slashPopover.props.style.bottom, 'auto', 'Must not pop upward')

  // Trigger slash skill matching
  await textareaNode.props.onChange({ target: { value: '/modern', selectionStart: 7 } })
  hookIndex = 0
  vdom = SessionPane({ sessionId: 'session-autocomplete-test' })
  const skillPopover = findChild(vdom, n => n.props?.id === 'composerAutocompletePopover')
  assert.ok(skillPopover, 'Slash skill popover should be open')

  // Trigger bare @ mention popover
  await textareaNode.props.onChange({ target: { value: '@', selectionStart: 1 } })
  hookIndex = 0
  vdom = SessionPane({ sessionId: 'session-autocomplete-test' })
  const bareAtPopover = findChild(vdom, n => n.props?.id === 'composerAutocompletePopover')
  assert.ok(bareAtPopover, 'Bare @ popover should open immediately')
  assert.equal(bareAtPopover.props.style.top, 'calc(100% + 4px)', 'Must pop downward')

  // Trigger @ mention with query
  await textareaNode.props.onChange({ target: { value: '@AGE', selectionStart: 4 } })
  hookIndex = 0
  vdom = SessionPane({ sessionId: 'session-autocomplete-test' })
  const atPopover = findChild(vdom, n => n.props?.id === 'composerAutocompletePopover')
  assert.ok(atPopover, '@AGE popover should be open')
  assert.equal(atPopover.props.style.top, 'calc(100% + 4px)', 'Must pop downward')

  // Trigger @ mention with deep nested directory path query (@ui)
  await textareaNode.props.onChange({ target: { value: '@ui', selectionStart: 3 } })
  hookIndex = 0
  vdom = SessionPane({ sessionId: 'session-autocomplete-test' })
  const deepAtPopover = findChild(vdom, n => n.props?.id === 'composerAutocompletePopover')
  assert.ok(deepAtPopover, '@ui popover should match nested files')
  const deepItem = findChild(deepAtPopover, it => it.props?.key?.includes('session-pane.js'))
  assert.ok(deepItem, 'Should find nested src/client/ui/session-pane.js by directory name')

  // Trigger dollar $ skill popover
  await textareaNode.props.onChange({ target: { value: '$', selectionStart: 1 } })
  hookIndex = 0
  vdom = SessionPane({ sessionId: 'session-autocomplete-test' })
  const dollarPopover = findChild(vdom, n => n.props?.id === 'composerAutocompletePopover')
  assert.ok(dollarPopover, '$ skill popover should be open')
})
