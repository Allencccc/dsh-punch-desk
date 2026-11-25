import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NORD,
  POLAR_NIGHT,
  SNOW_STORM,
  FROST,
  AURORA,
  SEMANTIC_TOKENS,
  TAG_COLORS,
  SEVERITY_COLORS,
  STATUS_COLORS,
  getSeverityColor,
  getTagColor,
  getStatusColor,
  getThemeToken,
  getTagStyle,
  getSeverityStyle,
  formatTagText,
  normalizeTagKey,
  PUNCH_DESK_STYLE_ID,
  PUNCH_DESK_THEME_CSS,
  injectPunchDeskStyles,
} from '../src/client/ui/nord.js'
import {
  createIcons,
  renderIcon,
  setDefaultH,
  ICON_NAMES,
  ICON_DEFINITIONS,
  Folder,
  FolderPlus,
  ChatTeardropText,
  Kanban,
  Gauge,
  Brain,
  GitDiff,
  ChartBar,
  Plus,
  Trash,
  PencilSimple,
  Play,
  CheckCircle,
  CircleNotch,
  Circle,
  Clock,
  ArrowRight,
  ArrowCounterClockwise,
  CaretDown,
  CaretRight,
  Prohibit,
  DotsThree,
  MagnifyingGlass,
} from '../src/client/ui/icons.js'
import { countText, createBits, TONE_COLORS } from '../src/client/ui/bits.js'
import { dictionaries } from '../src/locale.js'

/**
 * Standard test h (hyperscript / createElement) implementation.
 */
const h = (type, props, ...children) => ({
  type,
  props: props ?? {},
  children: children.flat(Infinity),
})

test('Nord palette constants and structure', () => {
  // Polar Night
  assert.equal(NORD.nord0, '#2e3440')
  assert.equal(NORD.nord1, '#3b4252')
  assert.equal(NORD.nord2, '#434c5e')
  assert.equal(NORD.nord3, '#4c566a')

  // Snow Storm
  assert.equal(NORD.nord4, '#d8dee9')
  assert.equal(NORD.nord5, '#e5e9f0')
  assert.equal(NORD.nord6, '#eceff4')

  // Frost
  assert.equal(NORD.nord7, '#8fbcbb')
  assert.equal(NORD.nord8, '#88c0d0')
  assert.equal(NORD.nord9, '#81a1c1')
  assert.equal(NORD.nord10, '#5e81ac')

  // Aurora
  assert.equal(NORD.nord11, '#bf616a')
  assert.equal(NORD.nord12, '#d08770')
  assert.equal(NORD.nord13, '#ebcb8b')
  assert.equal(NORD.nord14, '#a3be8c')
  assert.equal(NORD.nord15, '#b48ead')

  // Palette groups
  assert.equal(POLAR_NIGHT.length, 4)
  assert.equal(SNOW_STORM.length, 3)
  assert.equal(FROST.length, 4)
  assert.equal(AURORA.length, 5)

  // Immutability
  assert.throws(() => {
    // @ts-ignore
    NORD.nord0 = '#000000'
  })
})

test('Nord semantic token mappings to --dsw-alias-*', () => {
  assert.match(SEMANTIC_TOKENS.surfaceCanvas, /--dsw-alias-bg-base/)
  assert.match(SEMANTIC_TOKENS.surfaceCard, /--dsw-alias-bg-layer-1/)
  assert.match(SEMANTIC_TOKENS.surfacePanel, /--dsw-alias-bg-layer-2/)
  assert.match(SEMANTIC_TOKENS.borderDefault, /--dsw-alias-border-l1/)
  assert.match(SEMANTIC_TOKENS.borderSubtle, /--dsw-alias-border-l2/)
  assert.match(SEMANTIC_TOKENS.textPrimary, /--dsw-alias-label-primary/)
  assert.match(SEMANTIC_TOKENS.buttonPrimaryFill, /--dsw-alias-button-primary-fill/)
  assert.match(SEMANTIC_TOKENS.success, /--dsw-alias-state-success-primary/)
  assert.match(SEMANTIC_TOKENS.warning, /--dsw-alias-state-warn-primary/)
  assert.match(SEMANTIC_TOKENS.danger, /--dsw-alias-state-error-primary/)
})

test('Nord tag category mappings and helpers', () => {
  assert.equal(TAG_COLORS.optimize, NORD.nord8)
  assert.equal(TAG_COLORS.refactor, NORD.nord15)
  assert.equal(TAG_COLORS.context, NORD.nord13)
  assert.equal(TAG_COLORS.blocker, NORD.nord11)

  assert.equal(getTagColor('optimize'), NORD.nord8)
  assert.equal(getTagColor('#optimize'), NORD.nord8)
  assert.equal(getTagColor('refactor'), NORD.nord15)
  assert.equal(getTagColor('context'), NORD.nord13)
  assert.equal(getTagColor('blocker'), NORD.nord11)
  assert.equal(getTagColor('unknown'), NORD.nord8) // default fallback

  const tagStyle = getTagStyle('refactor')
  assert.match(tagStyle.color, /--pd-tag-refactor-fg/)
  assert.match(tagStyle.background, /--pd-tag-refactor-bg/)
  assert.match(tagStyle.borderColor, /--pd-tag-refactor-border/)

  // formatTagText prevents accidental ## prefixing
  const mockT = key => {
    const dict = {
      'tag.optimize': '#优化',
      'tag.blocker': '#问题',
      'tag.refactor': '#重构',
      'tag.context': '#上下文',
    }
    return dict[key] || key
  }
  assert.equal(formatTagText('optimize', mockT), '#优化')
  assert.equal(formatTagText('#optimize', mockT), '#优化')
  assert.equal(formatTagText('##优化', mockT), '#优化')
  assert.equal(formatTagText('blocker', mockT), '#问题')
  assert.equal(formatTagText('refactor', mockT), '#重构')
  assert.equal(formatTagText('context', mockT), '#上下文')
  assert.equal(formatTagText('卡点', mockT), '#问题')
})

test('Nord severity color mappings and helpers', () => {
  assert.equal(SEVERITY_COLORS.blocker, NORD.nord11)
  assert.equal(SEVERITY_COLORS.major, NORD.nord12)
  assert.equal(SEVERITY_COLORS.minor, NORD.nord14)
  assert.equal(SEVERITY_COLORS.question, NORD.nord13)
  assert.equal(SEVERITY_COLORS.idea, NORD.nord13)

  assert.equal(getSeverityColor('blocker'), NORD.nord11)
  assert.equal(getSeverityColor('major'), NORD.nord12)
  assert.equal(getSeverityColor('minor'), NORD.nord14)
  assert.equal(getSeverityColor('question'), NORD.nord13)
  assert.equal(getSeverityColor('idea'), NORD.nord13)
  assert.equal(getSeverityColor('invalid'), NORD.nord4) // fallback

  const severityStyle = getSeverityStyle('blocker')
  assert.equal(severityStyle.color, NORD.nord11)
  assert.match(severityStyle.borderColor, /#bf616a/)
})

test('Nord status color mappings and helpers', () => {
  assert.equal(STATUS_COLORS.running, NORD.nord12)
  assert.equal(STATUS_COLORS.queued, NORD.nord13)
  assert.equal(STATUS_COLORS.executed, NORD.nord14)
  assert.equal(STATUS_COLORS.resolved, NORD.nord14)
  assert.equal(STATUS_COLORS.dismissed, NORD.nord3)

  assert.equal(getStatusColor('running'), NORD.nord12)
  assert.equal(getStatusColor('queued'), NORD.nord13)
  assert.equal(getStatusColor('executed'), NORD.nord14)
  assert.equal(getStatusColor('resolved'), NORD.nord14)
  assert.equal(getStatusColor('dismissed'), NORD.nord3)
  assert.equal(getStatusColor('unknown'), NORD.nord3)

  assert.equal(getThemeToken('primary'), SEMANTIC_TOKENS.primary)
  assert.equal(getThemeToken('nonexistent', '#123456'), '#123456')
})

test('Phosphor icon definitions contain all required icons', () => {
  const expectedIcons = [
    // View / Nav (11)
    'Folder', 'FolderPlus', 'ChatTeardropText', 'BookBookmark', 'Kanban', 'Gauge', 'Brain', 'GitDiff', 'GitBranch', 'GitCommit', 'ChartBar', 'Faders', 'MagnifyingGlass',
    // Action / Status (15)
    'Plus', 'Trash', 'PencilSimple', 'Play', 'CheckCircle', 'CircleNotch', 'Circle', 'Clock',
    'ArrowRight', 'ArrowCounterClockwise', 'CaretDown', 'CaretRight', 'ArrowsDownUp', 'Prohibit', 'DotsThree', 'X',
    // Data transfer (2)
    'DownloadSimple', 'UploadSimple',
  ]

  assert.equal(ICON_NAMES.length, 33)
  for (const name of expectedIcons) {
    assert.ok(ICON_NAMES.includes(name), `Missing icon definition: ${name}`)
    assert.ok(ICON_DEFINITIONS[name].length > 0, `Empty icon definition: ${name}`)
  }
})

test('renderIcon renders SVG element with Phosphor attributes', () => {
  const vnode = renderIcon(h, 'Plus', { size: 20, className: 'my-custom-plus', color: '#ff0000' })

  assert.equal(vnode.type, 'svg')
  assert.equal(vnode.props.viewBox, '0 0 256 256')
  assert.equal(vnode.props.width, 20)
  assert.equal(vnode.props.height, 20)
  assert.equal(vnode.props.stroke, '#ff0000')
  assert.equal(vnode.props.fill, 'none')
  assert.equal(vnode.props.strokeWidth, 16)
  assert.match(vnode.props.className, /ph-icon/)
  assert.match(vnode.props.className, /my-custom-plus/)
  assert.equal(vnode.children.length, 2) // two lines for Plus
})

test('CircleNotch icon has spinning animation and ph-spin class', () => {
  const vnode = renderIcon(h, 'CircleNotch', { size: 16 })
  assert.match(vnode.props.className, /ph-spin/)
  assert.match(vnode.props.style.animation, /ph-spin 1s linear infinite/)
  assert.equal(vnode.props.style.transformOrigin, 'center')
})

test('createIcons builds bound components for all icons', () => {
  const icons = createIcons(h)
  assert.equal(Object.keys(icons).length, ICON_NAMES.length)

  for (const name of ICON_NAMES) {
    const Component = icons[name]
    assert.equal(typeof Component, 'function')
    const vnode = Component({ size: 18 })
    assert.equal(vnode.type, 'svg')
    assert.equal(vnode.props.width, 18)
    assert.equal(vnode.props.height, 18)
    assert.match(vnode.props.className, /ph-icon/)
  }
})

test('Direct icon function exports with setDefaultH', () => {
  setDefaultH(h)

  const folderNode = Folder({ size: 14 })
  assert.equal(folderNode.type, 'svg')
  assert.equal(folderNode.props.width, 14)

  const trashNode = Trash({ color: NORD.nord11 })
  assert.equal(trashNode.type, 'svg')
  assert.equal(trashNode.props.stroke, NORD.nord11)

  const diffNode = GitDiff()
  assert.equal(diffNode.type, 'svg')
  assert.equal(diffNode.props.width, 16) // default size

  const searchNode = MagnifyingGlass({ size: 16 })
  assert.equal(searchNode.type, 'svg')
  assert.equal(searchNode.props.width, 16)
})

test('commit trace and git lookup locale keys are paired in zh and en without emojis', () => {
  const dicts = dictionaries()
  const requiredKeys = [
    'finding.commitTrace.badge',
    'finding.commitTrace.badgeZero',
    'finding.commitTrace.turnHeader',
    'finding.commitTrace.failedBadge',
    'finding.commitTrace.failedReason',
    'finding.commitTrace.retry',
    'finding.commitTrace.retryDone',
    'finding.commitTrace.truncatedHint',
    'finding.gitFootprint.secondary',
    'group.commitTrace.badge',
    'group.commitTrace.expandedTitle',
    'desk.gitLookup.title',
    'desk.gitLookup.placeholder',
    'desk.gitLookup.empty',
    'desk.gitLookup.invalid',
    'desk.gitLookup.failed',
    'desk.gitLookup.resultMeta',
    'desk.gitLookup.openHint',
    'commitTrace.error.noPreHead',
    'commitTrace.error.noPostHead',
    'commitTrace.error.notARepo',
    'commitTrace.error.rangeFailed',
    'commitTrace.error.workspaceUnresolved',
    'commitTrace.error.badRange',
  ]
  const emojiRe = /\p{Extended_Pictographic}/u
  for (const key of requiredKeys) {
    for (const [lang, dict] of [['zh', dicts.zh], ['en', dicts.en]]) {
      const val = dict[key]
      assert.equal(typeof val, 'string', `${lang} missing key: ${key}`)
      assert.ok(val.trim().length > 0, `${lang} empty value for key: ${key}`)
      assert.ok(!emojiRe.test(val), `${lang} value contains emoji for key: ${key}`)
    }
  }
})

test('renderIcon throws for unknown icon', () => {
  assert.throws(() => {
    // @ts-ignore
    renderIcon(h, 'NonExistentIcon')
  }, /Unknown Phosphor icon/)
})

test('countText handles singular, plural and single-form templates', () => {
  assert.equal(countText('{count} item|{count} items', 1), '1 item')
  assert.equal(countText('{count} item|{count} items', 2), '2 items')
  assert.equal(countText('{count} 条记录', 5), '5 条记录')
  assert.equal(countText('', 0), '')
})

test('Button component supports Icon-First and variant styling', () => {
  const { Button } = createBits(h)

  // Standard default button
  const defaultBtn = Button({ children: 'Click me' })
  assert.equal(defaultBtn.type, 'button')
  assert.match(defaultBtn.props.style.background, /--dsw-alias-bg-layer-2/)
  assert.equal(defaultBtn.props['aria-label'], 'Click me')

  // Primary button
  const primaryBtn = Button({ variant: 'primary', children: 'Submit' })
  assert.match(primaryBtn.props.style.background, /--dsw-alias-button-primary-fill/)

  // Icon-only button with mandatory title/aria-label and 28x28 hit area
  const iconOnlyBtn = Button({
    variant: 'icon',
    icon: Plus,
    title: 'Add new item',
  })
  assert.equal(iconOnlyBtn.props.title, 'Add new item')
  assert.equal(iconOnlyBtn.props['aria-label'], 'Add new item')
  assert.equal(iconOnlyBtn.props.style.minWidth, 28)
  assert.equal(iconOnlyBtn.props.style.minHeight, 28)
  assert.equal(iconOnlyBtn.props.style.padding, 4)

  // Icon + text button with fixed 6px gap
  const iconTextBtn = Button({
    variant: 'default',
    icon: Plus,
    children: 'Add item',
  })
  assert.equal(iconTextBtn.props.style.gap, 6)
  assert.equal(iconTextBtn.props.style.display, 'inline-flex')
  assert.equal(iconTextBtn.children.length, 2) // icon + text child

  // Disabled button
  const disabledBtn = Button({ disabled: true, children: 'Disabled' })
  assert.equal(disabledBtn.props.disabled, true)
  assert.equal(disabledBtn.props.style.cursor, 'not-allowed')
  assert.equal(disabledBtn.props.style.opacity, 0.55)
})

test('Badge component supports tone and icon integration', () => {
  const { Badge } = createBits(h)

  const neutralBadge = Badge({ tone: 'neutral', children: 'Neutral' })
  assert.equal(neutralBadge.type, 'span')
  assert.match(neutralBadge.props.style.color, /--dsw-alias-label-secondary/)

  const dangerBadge = Badge({ tone: 'danger', children: 'Blocker' })
  assert.match(dangerBadge.props.style.color, /--dsw-alias-state-error-primary/)

  const successBadge = Badge({ tone: 'success', icon: CheckCircle, children: 'Done' })
  assert.match(successBadge.props.style.color, /--dsw-alias-state-success-primary/)
  assert.equal(successBadge.children.length, 2) // icon + label
})

test('Card component implements Borderless Fluid list aesthetic', () => {
  const { Card } = createBits(h)

  // Default fluid card: no box border, subtle bottom line, 8-10px padding
  const fluidCard = Card({ children: 'Finding item' })
  assert.equal(fluidCard.type, 'div')
  assert.equal(fluidCard.props.style.border, 'none')
  assert.match(fluidCard.props.style.borderBottom, /--dsw-alias-border-l2/)
  assert.equal(fluidCard.props.style.padding, '8px 10px')
  assert.equal(fluidCard.props.style.background, 'transparent')

  // Last item in list: bottom border removed
  const lastCard = Card({ last: true, children: 'Last finding' })
  assert.equal(lastCard.props.style.borderBottom, 'none')

  // Boxed card variant for explicit dashboard cards
  const boxedCard = Card({ variant: 'boxed', children: 'Dashboard stat' })
  assert.equal(boxedCard.props.style.borderRadius, 8)
  assert.match(boxedCard.props.style.border, /--dsw-alias-border-l1/)
  assert.match(boxedCard.props.style.background, /--dsw-alias-bg-layer-1/)
})

test('Empty component renders message and optional icon', () => {
  const { Empty } = createBits(h)

  const emptyText = Empty({ children: 'No findings' })
  assert.equal(emptyText.type, 'div')
  assert.match(emptyText.props.style.color, /--dsw-alias-label-tertiary/)

  const emptyWithIcon = Empty({ icon: Brain, children: 'No brainstorm ideas' })
  assert.equal(emptyWithIcon.children.length, 2)
  assert.equal(emptyWithIcon.children[0].type, Brain)
  assert.equal(emptyWithIcon.children[0].props.size, 28)
})

test('createBits exposes all Phosphor icons directly on returned object', () => {
  const bits = createBits(h)

  assert.ok(bits.icons)
  assert.equal(typeof bits.Folder, 'function')
  assert.equal(typeof bits.CircleNotch, 'function')
  assert.equal(typeof bits.Plus, 'function')
  assert.equal(typeof bits.Trash, 'function')

  const iconVNode = bits.Folder({ size: 16 })
  assert.equal(iconVNode.type, 'svg')
  assert.equal(iconVNode.props.width, 16)
})

test('Punch Desk adaptive theme CSS defines dual-mode variables and injects idempotently', () => {
  assert.equal(PUNCH_DESK_STYLE_ID, 'dsh-punch-desk-theme-styles')
  assert.match(PUNCH_DESK_THEME_CSS, /--pd-text-primary/)
  assert.match(PUNCH_DESK_THEME_CSS, /--pd-bg-base/)
  assert.match(PUNCH_DESK_THEME_CSS, /--pd-border-default/)
  assert.match(PUNCH_DESK_THEME_CSS, /--pd-card-focused-bg/)
  assert.match(PUNCH_DESK_THEME_CSS, /--pd-merge-btn-solid-bg/)
  assert.match(PUNCH_DESK_THEME_CSS, /body\[data-ds-dark-theme\]/)
  assert.match(PUNCH_DESK_THEME_CSS, /@keyframes pd-breathe/)
  assert.match(PUNCH_DESK_THEME_CSS, /--pd-status-running: #0e9f4f/)
  assert.match(PUNCH_DESK_THEME_CSS, /--pd-status-running: #22c55e/)
  assert.match(PUNCH_DESK_THEME_CSS, /--pd-status-warn: #ebcb8b/)
  assert.match(PUNCH_DESK_THEME_CSS, /--pd-status-idle: #5e81ac/)
  assert.match(PUNCH_DESK_THEME_CSS, /--pd-status-running-text: #0a6b36/)
  assert.match(PUNCH_DESK_THEME_CSS, /--pd-status-running-text: #22c55e/)
  assert.match(PUNCH_DESK_THEME_CSS, /--pd-status-warn-text: #7a5a00/)
  assert.match(PUNCH_DESK_THEME_CSS, /--pd-status-warn-text: #ebcb8b/)
  assert.match(PUNCH_DESK_THEME_CSS, /--pd-status-muted: #4c566a/)
  assert.match(PUNCH_DESK_THEME_CSS, /--pd-status-muted: #81a1c1/)
  // The old Aurora-orange fallback would flash when the theme CSS is missing.
  const paneSource = fs.readFileSync(path.join(process.cwd(), 'src/client/ui/session-pane.js'), 'utf8')
  assert.doesNotMatch(paneSource, /--pd-status-running,\s*#d08770/, 'running fallback must not keep the old Aurora orange')
  assert.match(PUNCH_DESK_THEME_CSS, /\.pd-breathe \{ animation: pd-breathe/)
  assert.match(PUNCH_DESK_THEME_CSS, /@keyframes ph-spin/)

  // SSR safety: calling injectPunchDeskStyles when document is undefined should not throw
  assert.doesNotThrow(() => {
    injectPunchDeskStyles()
  })

  // Simulated browser environment
  const elements = []
  const mockDocument = {
    getElementById(id) {
      return elements.find(el => el.id === id) || null
    },
    createElement(tag) {
      return { tagName: tag, id: '', textContent: '' }
    },
    head: {
      appendChild(el) {
        elements.push(el)
      },
    },
  }

  // @ts-ignore
  globalThis.document = mockDocument
  try {
    injectPunchDeskStyles()
    assert.equal(elements.length, 1)
    assert.equal(elements[0].id, PUNCH_DESK_STYLE_ID)
    assert.equal(elements[0].textContent, PUNCH_DESK_THEME_CSS)

    // Idempotent: repeated calls must not add duplicate elements
    injectPunchDeskStyles()
    assert.equal(elements.length, 1)

    // Regression (2026-11-11): a stale stylesheet from a previous bundle/HMR
    // remount must be refreshed in place, otherwise new keyframes never apply.
    elements[0].textContent = '/* stale css without pd-breathe */'
    injectPunchDeskStyles()
    assert.equal(elements.length, 1, 'must update the existing <style> instead of adding another')
    assert.equal(elements[0].textContent, PUNCH_DESK_THEME_CSS)
    assert.match(elements[0].textContent, /@keyframes pd-breathe/)
  } finally {
    // @ts-ignore
    delete globalThis.document
  }
})

test('Punch Desk reactive theme sync detects body[data-ds-dark-theme]', () => {
  const elements = []
  const attributes = new Set()
  const mockDocument = {
    getElementById(id) {
      return elements.find(el => el.id === id) || null
    },
    createElement(tag) {
      return { tagName: tag, id: '', textContent: '' }
    },
    head: {
      appendChild(el) {
        elements.push(el)
      },
    },
    body: {
      hasAttribute(attr) {
        return attributes.has(attr)
      },
      getAttribute(attr) {
        return attributes.has(attr) ? '' : null
      },
    },
    documentElement: {
      style: { colorScheme: '' },
      toggleAttribute(attr, force) {
        if (force) attributes.add(attr)
        else attributes.delete(attr)
        return attributes.has(attr)
      },
    },
  }

  // @ts-ignore
  globalThis.document = mockDocument
  // @ts-ignore
  globalThis.window = { __pd_theme_observer_attached__: false }
  // @ts-ignore
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  }

  try {
    // When body has data-ds-dark-theme (DSH dark mode)
    attributes.add('data-ds-dark-theme')
    injectPunchDeskStyles()
    assert.ok(attributes.has('data-pd-dark'), 'documentElement should have data-pd-dark when body is dark')

    // When body does not have data-ds-dark-theme and scheme is light
    attributes.delete('data-ds-dark-theme')
    mockDocument.documentElement.style.colorScheme = 'light'
    // @ts-ignore
    globalThis.window.__pd_theme_observer_attached__ = false
    injectPunchDeskStyles()
    assert.ok(!attributes.has('data-pd-dark'), 'documentElement should not have data-pd-dark in light mode')
  } finally {
    // @ts-ignore
    delete globalThis.document
    // @ts-ignore
    delete globalThis.window
    // @ts-ignore
    delete globalThis.MutationObserver
  }
})

test('client source keeps zero Tailwind slate hex fallbacks (Nord only)', () => {
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap(item => item.isDirectory() ? walk(path.join(dir, item.name)) : [path.join(dir, item.name)])
  const files = walk(new URL('../src', import.meta.url).pathname).filter(file => file.endsWith('.js'))
  // Tailwind slate scale + the two generic greens that used to leak into fallbacks.
  const forbidden = /#(f8fafc|f1f5f9|e2e8f0|cbd5e1|94a3b8|64748b|475569|334155|1e293b|0f172a|020617|2e7d32)/i
  const offenders = []
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, index) => {
      if (forbidden.test(line)) offenders.push(path.relative(process.cwd(), file) + ':' + (index + 1) + ' ' + line.trim().slice(0, 80))
    })
  }
  assert.deepEqual(offenders, [], 'replace Tailwind slate fallbacks with Nord values:\n' + offenders.join('\n'))
})
test('explicit custom tag colors override the indexed palette', () => {
  assert.equal(getTagColor('custom-1', 0, '#88C0D0'), '#88c0d0')
  assert.equal(getTagColor('custom-1', 3, '#88C0D0'), '#88c0d0')
  assert.match(getTagStyle('custom-1', 0, '#88C0D0').color, /#88c0d0/)
  // Presets keep their design-system color even if a color is passed.
  assert.equal(getTagColor('optimize', 0, '#88C0D0'), NORD.nord8)
})