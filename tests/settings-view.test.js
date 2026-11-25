import test from 'node:test'
import assert from 'node:assert/strict'
import { createSettingsView } from '../src/client/ui/settings-view.js'
import { DEFAULT_PREFS } from '../src/client/prefs.js'
import { dictionaries } from '../src/locale.js'

const dict = dictionaries()
const t = key => dict.zh[key] ?? key

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
  return (node.children ?? []).map(textOf).join(' ')
}

function collectNodes(node, out = []) {
  if (!node || typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children ?? []) collectNodes(child, out)
  return out
}

function createHookRuntime() {
  const states = new Map()
  const refs = new Map()
  let hookCursor = 0

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
    useEffect() {
      // In synchronous unit tests, effect registrations are no-ops
    },
    resetCursor() {
      hookCursor = 0
    },
  }
  return React
}

test('SettingsView renders 5 categories and the retention sliders', () => {
  const React = createHookRuntime()
  const services = { t }
  const SettingsView = createSettingsView({ h, React, services })

  const mockStore = {
    getPrefs: async () => ({ ...DEFAULT_PREFS }),
    setPrefs: async () => {},
  }

  const vnode = SettingsView({ store: mockStore, prefs: DEFAULT_PREFS })
  const renderedText = textOf(vnode)

  // Verify 3 categories
  assert.ok(renderedText.includes(t('settings.category.submit')))
  assert.ok(renderedText.includes(t('settings.category.session')))
  assert.ok(renderedText.includes(t('settings.category.draft')))
  assert.ok(renderedText.includes(t('settings.category.ui')))
  assert.ok(renderedText.includes(t('settings.category.tags')))
  assert.ok(renderedText.includes(t('settings.category.retention')))
  assert.ok(renderedText.includes(t('settings.retentionDays')))
  assert.ok(renderedText.includes(t('settings.retentionRows')))
  assert.ok(
    renderedText.indexOf(t('settings.category.submit')) < renderedText.indexOf(t('settings.category.session')),
    'Submission & Prompts must be the first category',
  )

  // Verify all 7 settings labels
  assert.ok(renderedText.includes(t('settings.startBehavior')))
  assert.ok(renderedText.includes(t('settings.sequentialCostHint')))
  assert.ok(renderedText.includes(t('settings.includeTextHeuristic')))
  assert.ok(renderedText.includes(t('settings.draftVisibility')))
  assert.ok(renderedText.includes(t('settings.inheritScope')))
  assert.ok(renderedText.includes(t('settings.composerRows')))
  assert.ok(renderedText.includes(t('settings.archivedHeight')))
  // Reply-contract tail controls live in the Session & Submission category.
  assert.ok(renderedText.includes(t('settings.promptTail')))
  assert.ok(renderedText.includes(t('settings.promptTailTextA')))
  assert.ok(renderedText.includes(t('settings.promptTailTextB')))
  assert.ok(renderedText.includes(t('settings.promptTailTextC')))

  // Presets stay a single radiogroup; A/B/C are free-text textareas.
  const allNodes = collectNodes(vnode)
  const radiogroups = allNodes.filter(n => n.props?.role === 'radiogroup')
  assert.equal(radiogroups.length, 8)

  // Verify default selections match DEFAULT_PREFS
  const checkedRadios = allNodes.filter(n => n.props?.role === 'radio' && n.props['aria-checked'] === true)
  assert.equal(checkedRadios.length, 8)

  // 3 reply-contract sections + one guidance box per tag (4 presets by default).
  const textareas = allNodes.filter(n => n.type === 'textarea')
  assert.equal(textareas.length, 7)
  const numberInputs = allNodes.filter(n => n.type === 'input' && n.props?.type === 'number')
  assert.equal(numberInputs.length, 2)
  const rangeInputs = allNodes.filter(n => n.type === 'input' && n.props?.type === 'range')
  assert.equal(rangeInputs.length, 2)
  assert.deepEqual(rangeInputs.map(n => n.props.value), [
    DEFAULT_PREFS.promptLogRetentionDays, DEFAULT_PREFS.promptLogRetentionRows,
  ])
  assert.deepEqual(numberInputs.map(n => n.props['aria-label']), [
    t('settings.promptMaxEntryBytes'), t('settings.promptMaxBytes'),
  ])
  assert.equal(numberInputs[0].props.value, String(DEFAULT_PREFS.promptMaxEntryBytes))
  assert.equal(numberInputs[1].props.value, String(DEFAULT_PREFS.promptMaxBytes))
  assert.deepEqual(textareas.slice(0, 3).map(n => n.props['aria-label']), [
    t('settings.promptTailTextA'), t('settings.promptTailTextB'), t('settings.promptTailTextC'),
  ])
  assert.deepEqual(textareas.slice(3).map(n => n.props['aria-label']), DEFAULT_PREFS.findingTags.map(tag => `${t('settings.tagGuidance')} ${tag.key}`))
  for (const area of textareas.slice(0, 3)) assert.equal(area.props.maxLength, 2000)
  for (const area of textareas.slice(3)) assert.equal(area.props.maxLength, 200)
  assert.equal(textareas[0].props.value, DEFAULT_PREFS.promptTailTextA)
})

test('SettingsView renders reset button and calls resetPrefs', async () => {
  const React = createHookRuntime()
  const services = { t }
  const SettingsView = createSettingsView({ h, React, services })

  let resetCalled = false
  const mockStore = {
    getPrefs: async () => ({
      ...DEFAULT_PREFS,
      composerRows: 5,
      lastWorkspace: 'saved-ws',
    }),
    setPrefs: async next => {
      resetCalled = true
      assert.equal(next.composerRows, 4)
      assert.equal(next.lastWorkspace, 'saved-ws')
    },
  }

  const vnode = SettingsView({ store: mockStore })
  const allNodes = collectNodes(vnode)

  const resetButton = allNodes.find(n => n.type === 'button' && textOf(n).includes(t('settings.reset')))
  assert.ok(resetButton, 'Reset button must be rendered')

  await resetButton.props.onClick()
  assert.ok(resetCalled, 'Clicking reset button must invoke reset on store')
})

test('SettingsView option clicking triggers updatePrefs with optimistic update', async () => {
  const React = createHookRuntime()
  const services = { t }
  const SettingsView = createSettingsView({ h, React, services })

  let savedPatch = null
  const mockStore = {
    getPrefs: async () => ({ ...DEFAULT_PREFS }),
    setPrefs: async next => {
      savedPatch = next
    },
  }

  const vnode = SettingsView({ store: mockStore })
  const allNodes = collectNodes(vnode)

  // Find the 'auto' radio option for startSessionBehavior
  const autoOption = allNodes.find(n => n.props?.role === 'radio' && textOf(n).includes(t('settings.startBehavior.auto')))
  assert.ok(autoOption, 'Auto option button must exist')

  await autoOption.props.onClick()
  assert.ok(savedPatch, 'Store setPrefs should have been called')
  assert.equal(savedPatch.startSessionBehavior, 'auto')
})

test('SettingsView includeTextHeuristic option clicking triggers updatePrefs', async () => {
  const React = createHookRuntime()
  const services = { t }
  const SettingsView = createSettingsView({ h, React, services })

  let savedPatch = null
  const mockStore = {
    getPrefs: async () => ({ ...DEFAULT_PREFS }),
    setPrefs: async next => {
      savedPatch = next
    },
  }

  const vnode = SettingsView({ store: mockStore, prefs: DEFAULT_PREFS })
  const allNodes = collectNodes(vnode)

  const onOption = allNodes.find(n => n.props?.role === 'radio' && textOf(n).includes(t('settings.includeTextHeuristic.on')))
  assert.ok(onOption, 'includeTextHeuristic ON option button must exist')

  await onOption.props.onClick()
  assert.ok(savedPatch, 'Store setPrefs should have been called')
  assert.equal(savedPatch.includeTextHeuristic, true)
})

test('SettingsView disables controls when store is unavailable', () => {
  const React = createHookRuntime()
  const services = { t }
  const SettingsView = createSettingsView({ h, React, services })

  const vnode = SettingsView({ store: null })
  const renderedText = textOf(vnode)

  assert.ok(renderedText.includes(t('settings.unavailable')))
  const allNodes = collectNodes(vnode)
  const radioButtons = allNodes.filter(n => n.props?.role === 'radio')
  assert.ok(radioButtons.length > 0)
  for (const btn of radioButtons) {
    assert.equal(btn.props.disabled, true)
  }
})
test('settings sections never shrink and controls never force horizontal overflow', () => {
  const React = createHookRuntime()
  const services = { t }
  const SettingsView = createSettingsView({ h, React, services })
  const mockStore = {
    getPrefs: async () => ({ ...DEFAULT_PREFS }),
    setPrefs: async () => {},
  }
  const vnode = SettingsView({ store: mockStore, prefs: DEFAULT_PREFS })
  const allNodes = collectNodes(vnode)

  // The page is a flex column scroll container: without flex-shrink:0 the
  // sections collapse and overflow:hidden clips their rows (unreachable
  // fields). Regression guard for the 2026-11-13 layout fix.
  const sections = allNodes.filter(n => n.props?.style?.borderRadius === 8
    && n.props.style.flexDirection === 'column')
  assert.ok(sections.length >= 4, 'expected all settings categories')
  for (const section of sections) assert.equal(section.props.style.flexShrink, 0)

  const textareas = allNodes.filter(n => n.type === 'textarea')
  const numbers = allNodes.filter(n => n.type === 'input' && n.props?.type === 'number')
  for (const control of [...textareas, ...numbers]) {
    assert.equal(control.props.style.maxWidth, '100%', 'controls must shrink inside narrow panes')
  }

  // Segmented pill groups wrap instead of clipping their last option.
  const pillGroups = allNodes.filter(n => n.props?.style?.borderRadius === 6
    && n.props.style.display === 'inline-flex'
    && n.props.style.alignItems === 'stretch')
  assert.ok(pillGroups.length > 0)
  for (const group of pillGroups) assert.equal(group.props.style.flexWrap, 'wrap')
})
test('category headers collapse their section while item rows stay flat', () => {
  const React = createHookRuntime()
  const services = { t }
  const SettingsView = createSettingsView({ h, React, services })
  const mockStore = {
    getPrefs: async () => ({ ...DEFAULT_PREFS }),
    setPrefs: async () => {},
  }
  const vnode = SettingsView({ store: mockStore, prefs: DEFAULT_PREFS })
  const allNodes = collectNodes(vnode)

  // Only the category headers are collapsible; item rows are always shown.
  const headers = allNodes.filter(n => n.props?.role === 'button' && n.props['aria-expanded'] !== undefined)
  assert.equal(headers.length, 5, `expected 5 category headers, got ${headers.length}`)
  for (const header of headers) assert.equal(header.props['aria-expanded'], true, 'categories default to expanded')

  // A/B/C is a responsive auto-fit grid; tags are exactly four columns that
  // fill the span and share one row height.
  const grids = allNodes.filter(n => typeof n.props?.style?.gridTemplateColumns === 'string')
  assert.ok(grids.some(grid => /auto-fit/.test(grid.props.style.gridTemplateColumns)), 'expected the A/B/C auto-fit grid')
  const tagGrid = grids.find(grid => /max\(180px/.test(grid.props.style.gridTemplateColumns))
  assert.ok(tagGrid, 'expected the min-width tag grid')
  assert.match(tagGrid.props.style.gridTemplateColumns, /auto-fit/, 'cards wrap instead of shrinking below 180px')
  assert.match(tagGrid.props.style.gridTemplateColumns, /calc\(25% - 7\.5px\)/, 'four per row at most')
  assert.equal(tagGrid.props.style.gridAutoRows, '1fr', 'tag rows share one height')
})