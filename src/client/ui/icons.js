/**
 * Phosphor Icons Unified SVG Library (viewBox="0 0 256 256")
 *
 * Implements standard Phosphor inline SVG icons for Punch Desk v2.0.
 * Strictly NO Emoji or pseudo-ASCII characters (●, ○, ✓, ->) allowed.
 *
 * Default className: 'ph-icon'
 * Standard stroke: stroke="currentColor" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"
 */

/**
 * Definition of the 29 required Phosphor icons:
 * View/Nav: Folder, FolderPlus, ChatTeardropText, Kanban, Gauge, Brain, GitDiff, GitBranch, ChartBar, Faders, MagnifyingGlass
 * Action/Status: Plus, Trash, PencilSimple, Play, CheckCircle, CircleNotch, Circle, Clock,
 *                ArrowRight, ArrowCounterClockwise, CaretDown, CaretRight, Prohibit, DotsThree, X
 * Data transfer: DownloadSimple, UploadSimple
 */
export const ICON_DEFINITIONS = Object.freeze({
  // View / Nav Icons
  Folder: [
    { tag: 'path', props: { d: 'M32 80a8 8 0 0 1 8-8h51.7a8 8 0 0 1 5.9 2.6L124.7 104H216a8 8 0 0 1 8 8v88a8 8 0 0 1-8 8H40a8 8 0 0 1-8-8Z' } },
    { tag: 'line', props: { x1: '32', y1: '104', x2: '224', y2: '104' } },
  ],
  FolderPlus: [
    { tag: 'path', props: { d: 'M32 80a8 8 0 0 1 8-8h51.7a8 8 0 0 1 5.9 2.6L124.7 104H216a8 8 0 0 1 8 8v88a8 8 0 0 1-8 8H40a8 8 0 0 1-8-8Z' } },
    { tag: 'line', props: { x1: '128', y1: '136', x2: '128', y2: '184' } },
    { tag: 'line', props: { x1: '104', y1: '160', x2: '152', y2: '160' } },
  ],
  ChatTeardropText: [
    { tag: 'path', props: { d: 'M132 216H48a8 8 0 0 1-8-8V124a92 92 0 1 1 92 92Z' } },
    { tag: 'line', props: { x1: '96', y1: '112', x2: '160', y2: '112' } },
    { tag: 'line', props: { x1: '96', y1: '144', x2: '144', y2: '144' } },
  ],
  BookBookmark: [
    { tag: 'path', props: { d: 'M48 208a8 8 0 0 1-8-8V56a16 16 0 0 1 16-16h136a16 16 0 0 1 16 16v144a8 8 0 0 1-8 8Z' } },
    { tag: 'path', props: { d: 'M96 40v80l32-24 32 24V40' } },
  ],
  GitCommit: [
    { tag: 'line', props: { x1: '32', y1: '128', x2: '96', y2: '128' } },
    { tag: 'circle', props: { cx: '128', cy: '128', r: '32' } },
    { tag: 'line', props: { x1: '160', y1: '128', x2: '224', y2: '128' } },
  ],
  PushPinSimple: [
    { tag: 'path', props: { d: 'M195.31 164.69l-40-40V64H168a8 8 0 0 0 0-16H88a8 8 0 0 0 0 16h12.69v60.69l-40 40A8 8 0 0 0 66.34 176H120v48a8 8 0 0 0 16 0V176h53.66a8 8 0 0 0 5.65-11.31z' } },
  ],
  Kanban: [
    { tag: 'rect', props: { x: '40', y: '40', width: '48', height: '176', rx: '8' } },
    { tag: 'rect', props: { x: '104', y: '40', width: '48', height: '120', rx: '8' } },
    { tag: 'rect', props: { x: '168', y: '40', width: '48', height: '152', rx: '8' } },
  ],
  Gauge: [
    { tag: 'path', props: { d: 'M38.2 186.2a96 96 0 1 1 179.6 0' } },
    { tag: 'circle', props: { cx: '128', cy: '160', r: '16' } },
    { tag: 'line', props: { x1: '128', y1: '144', x2: '168', y2: '96' } },
  ],
  Brain: [
    { tag: 'path', props: { d: 'M128 48a40 40 0 0 0-40-16 48 48 0 0 0-48 48 44 44 0 0 0-8 44 48 48 0 0 0 24 76 40 40 0 0 0 72 8' } },
    { tag: 'path', props: { d: 'M128 48a40 40 0 0 1 40-16 48 48 0 0 1 48 48 44 44 0 0 1 8 44 48 48 0 0 1-24 76 40 40 0 0 1-72 8' } },
    { tag: 'line', props: { x1: '128', y1: '48', x2: '128', y2: '208' } },
  ],
  GitDiff: [
    { tag: 'circle', props: { cx: '64', cy: '80', r: '24' } },
    { tag: 'circle', props: { cx: '64', cy: '176', r: '24' } },
    { tag: 'circle', props: { cx: '192', cy: '176', r: '24' } },
    { tag: 'line', props: { x1: '64', y1: '104', x2: '64', y2: '152' } },
    { tag: 'path', props: { d: 'M88 80h48a32 32 0 0 1 32 32v40' } },
  ],
  GitBranch: [
    { tag: 'circle', props: { cx: '64', cy: '64', r: '24' } },
    { tag: 'circle', props: { cx: '64', cy: '192', r: '24' } },
    { tag: 'circle', props: { cx: '192', cy: '112', r: '24' } },
    { tag: 'line', props: { x1: '64', y1: '88', x2: '64', y2: '168' } },
    { tag: 'path', props: { d: 'M168 112h-40a48 48 0 0 0-48 48' } },
  ],
  ChartBar: [
    { tag: 'line', props: { x1: '216', y1: '208', x2: '40', y2: '208' } },
    { tag: 'rect', props: { x: '64', y: '128', width: '32', height: '80', rx: '4' } },
    { tag: 'rect', props: { x: '112', y: '80', width: '32', height: '128', rx: '4' } },
    { tag: 'rect', props: { x: '160', y: '48', width: '32', height: '160', rx: '4' } },
  ],
  Faders: [
    { tag: 'line', props: { x1: '64', y1: '32', x2: '64', y2: '52' } },
    { tag: 'circle', props: { cx: '64', cy: '80', r: '28' } },
    { tag: 'line', props: { x1: '64', y1: '108', x2: '64', y2: '224' } },
    { tag: 'line', props: { x1: '128', y1: '32', x2: '128', y2: '148' } },
    { tag: 'circle', props: { cx: '128', cy: '176', r: '28' } },
    { tag: 'line', props: { x1: '128', y1: '204', x2: '128', y2: '224' } },
    { tag: 'line', props: { x1: '192', y1: '32', x2: '192', y2: '92' } },
    { tag: 'circle', props: { cx: '192', cy: '120', r: '28' } },
    { tag: 'line', props: { x1: '192', y1: '148', x2: '192', y2: '224' } },
  ],
  MagnifyingGlass: [
    { tag: 'circle', props: { cx: '112', cy: '112', r: '80' } },
    { tag: 'line', props: { x1: '168.57', y1: '168.57', x2: '224', y2: '224' } },
  ],
  Tag: [
    { tag: 'path', props: { d: 'M132.7 32H48a16 16 0 0 0-16 16v84.7a16 16 0 0 0 4.7 11.3l112 112a16 16 0 0 0 22.6 0l84.7-84.7a16 16 0 0 0 0-22.6l-112-112A16 16 0 0 0 132.7 32Z' } },
    { tag: 'circle', props: { cx: '84', cy: '84', r: '12' } },
  ],

  // Action / Status Icons
  Plus: [
    { tag: 'line', props: { x1: '40', y1: '128', x2: '216', y2: '128' } },
    { tag: 'line', props: { x1: '128', y1: '40', x2: '128', y2: '216' } },
  ],
  Trash: [
    { tag: 'line', props: { x1: '32', y1: '64', x2: '224', y2: '64' } },
    { tag: 'path', props: { d: 'M200 64v144a8 8 0 0 1-8 8H64a8 8 0 0 1-8-8V64' } },
    { tag: 'line', props: { x1: '104', y1: '104', x2: '104', y2: '168' } },
    { tag: 'line', props: { x1: '152', y1: '104', x2: '152', y2: '168' } },
    { tag: 'path', props: { d: 'M88 64V40a8 8 0 0 1 8-8h64a8 8 0 0 1 8 8v24' } },
  ],
  PencilSimple: [
    { tag: 'path', props: { d: 'M96 224H40a8 8 0 0 1-8-8v-56L164 28a16 16 0 0 1 22.6 0l41.4 41.4a16 16 0 0 1 0 22.6Z' } },
    { tag: 'line', props: { x1: '140', y1: '52', x2: '204', y2: '116' } },
  ],
  Play: [
    { tag: 'path', props: { d: 'M228.2 121.2 76.2 33.2a8 8 0 0 0-12.2 6.8v176a8 8 0 0 0 12.2 6.8l152-88a8 8 0 0 0 0-13.6Z' } },
  ],
  CheckCircle: [
    { tag: 'circle', props: { cx: '128', cy: '128', r: '96' } },
    { tag: 'polyline', props: { points: '88 128 116 156 168 104' } },
  ],
  CircleNotch: [
    { tag: 'path', props: { d: 'M168 40a96 96 0 1 1-80 0' } },
  ],
  Circle: [
    { tag: 'circle', props: { cx: '128', cy: '128', r: '96' } },
  ],
  Clock: [
    { tag: 'circle', props: { cx: '128', cy: '128', r: '96' } },
    { tag: 'polyline', props: { points: '128 72 128 128 168 152' } },
  ],
  ArrowRight: [
    { tag: 'line', props: { x1: '40', y1: '128', x2: '216', y2: '128' } },
    { tag: 'polyline', props: { points: '144 56 216 128 144 200' } },
  ],
  ArrowCounterClockwise: [
    { tag: 'path', props: { d: 'M33.4 168a96 96 0 1 0 15.1-90.5' } },
    { tag: 'polyline', props: { points: '32 32 32 80 80 80' } },
  ],
  CaretDown: [
    { tag: 'polyline', props: { points: '208 96 128 176 48 96' } },
  ],
  CaretRight: [
    { tag: 'polyline', props: { points: '96 48 176 128 96 208' } },
  ],
  ArrowsDownUp: [
    { tag: 'line', props: { x1: '64', y1: '208', x2: '64', y2: '48' } },
    { tag: 'polyline', props: { points: '40 72 64 48 88 72' } },
    { tag: 'line', props: { x1: '192', y1: '48', x2: '192', y2: '208' } },
    { tag: 'polyline', props: { points: '168 184 192 208 216 184' } },
  ],
  Prohibit: [
    { tag: 'circle', props: { cx: '128', cy: '128', r: '96' } },
    { tag: 'line', props: { x1: '60.1', y1: '60.1', x2: '195.9', y2: '195.9' } },
  ],
  X: [
    { tag: 'line', props: { x1: '200', y1: '56', x2: '56', y2: '200' } },
    { tag: 'line', props: { x1: '200', y1: '200', x2: '56', y2: '56' } },
  ],
  DownloadSimple: [
    { tag: 'line', props: { x1: '128', y1: '32', x2: '128', y2: '176' } },
    { tag: 'polyline', props: { points: '80 128 128 176 176 128' } },
    { tag: 'line', props: { x1: '32', y1: '216', x2: '224', y2: '216' } },
  ],
  UploadSimple: [
    { tag: 'line', props: { x1: '128', y1: '224', x2: '128', y2: '80' } },
    { tag: 'polyline', props: { points: '80 128 128 80 176 128' } },
    { tag: 'line', props: { x1: '32', y1: '32', x2: '224', y2: '32' } },
  ],
  DotsThree: [
    { tag: 'circle', props: { cx: '128', cy: '128', r: '12', fill: 'currentColor', stroke: 'none' } },
    { tag: 'circle', props: { cx: '64', cy: '128', r: '12', fill: 'currentColor', stroke: 'none' } },
    { tag: 'circle', props: { cx: '192', cy: '128', r: '12', fill: 'currentColor', stroke: 'none' } },
  ],
})

export const ICON_NAMES = Object.freeze(Object.keys(ICON_DEFINITIONS))

let globalH = null

/**
 * Configure default `h` (React.createElement) implementation.
 * @param {Function} h
 */
export function setDefaultH(h) {
  globalH = h
}

/**
 * Render a single Phosphor icon with the given createElement factory.
 * @param {Function} h React.createElement implementation
 * @param {string} iconName
 * @param {object} [props]
 * @param {number} [props.size=16]
 * @param {string} [props.className]
 * @param {string} [props.color='currentColor']
 * @param {object} [props.style]
 * @returns {any} VNode
 */
export function renderIcon(h, iconName, props = {}) {
  const elements = ICON_DEFINITIONS[iconName]
  if (!elements) {
    throw new Error(`Unknown Phosphor icon: "${iconName}"`)
  }

  const {
    size = 16,
    className = '',
    color = 'currentColor',
    style = {},
    filled = false,
    weight,
    ...rest
  } = props

  const isFilled = filled || weight === 'fill'
  const isSpin = iconName === 'CircleNotch'
  const classes = ['ph-icon', isSpin ? 'ph-spin' : null, className].filter(Boolean).join(' ')

  const spinStyle = isSpin ? {
    animation: 'ph-spin 1s linear infinite',
    transformOrigin: 'center',
  } : {}

  const mergedStyle = {
    display: 'inline-block',
    verticalAlign: 'middle',
    flexShrink: 0,
    ...spinStyle,
    ...style,
  }

  if (iconName === 'CheckCircle' && isFilled) {
    return h('svg', {
      ...rest,
      viewBox: '0 0 256 256',
      width: size,
      height: size,
      fill: 'none',
      className: classes,
      style: mergedStyle,
    },
      h('circle', { cx: '128', cy: '128', r: '96', fill: color === 'currentColor' ? '#a3be8c' : color, stroke: 'none' }),
      h('polyline', { points: '88 128 116 156 168 104', stroke: '#ffffff', strokeWidth: '22', strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' }))
  }

  const svgProps = {
    ...rest,
    viewBox: '0 0 256 256',
    width: size,
    height: size,
    fill: 'none',
    stroke: color,
    strokeWidth: 16,
    'stroke-width': 16,
    strokeLinecap: 'round',
    'stroke-linecap': 'round',
    strokeLinejoin: 'round',
    'stroke-linejoin': 'round',
    className: classes,
    style: mergedStyle,
  }

  const children = elements.map((item, idx) => {
    return h(item.tag, {
      key: idx,
      ...item.props,
    })
  })

  return h('svg', svgProps, ...children)
}

/**
 * Build the full set of Phosphor icon components bound to a `h` implementation.
 * @param {Function} h React.createElement implementation
 * @returns {Record<string, Function>}
 */
export function createIcons(h) {
  /** @type {Record<string, Function>} */
  const icons = {}
  for (const name of ICON_NAMES) {
    icons[name] = function PhosphorIcon(props = {}) {
      return renderIcon(h, name, props)
    }
  }
  return icons
}

// Direct functional exports for convenient usage
export function Folder(props) { return renderIcon(props?.h ?? globalH, 'Folder', props) }
export function FolderPlus(props) { return renderIcon(props?.h ?? globalH, 'FolderPlus', props) }
export function ChatTeardropText(props) { return renderIcon(props?.h ?? globalH, 'ChatTeardropText', props) }
export function BookBookmark(props) { return renderIcon(props?.h ?? globalH, 'BookBookmark', props) }
export function GitCommit(props) { return renderIcon(props?.h ?? globalH, 'GitCommit', props) }
export function Kanban(props) { return renderIcon(props?.h ?? globalH, 'Kanban', props) }
export function Gauge(props) { return renderIcon(props?.h ?? globalH, 'Gauge', props) }
export function Brain(props) { return renderIcon(props?.h ?? globalH, 'Brain', props) }
export function GitDiff(props) { return renderIcon(props?.h ?? globalH, 'GitDiff', props) }
export function GitBranch(props) { return renderIcon(props?.h ?? globalH, 'GitBranch', props) }
export function ChartBar(props) { return renderIcon(props?.h ?? globalH, 'ChartBar', props) }
export function Faders(props) { return renderIcon(props?.h ?? globalH, 'Faders', props) }
export function MagnifyingGlass(props) { return renderIcon(props?.h ?? globalH, 'MagnifyingGlass', props) }
export function Tag(props) { return renderIcon(props?.h ?? globalH, 'Tag', props) }
export const FadersIcon = Faders
export const Gear = Faders
export const GearIcon = Faders
export const GearSix = Faders

export function Plus(props) { return renderIcon(props?.h ?? globalH, 'Plus', props) }
export function Trash(props) { return renderIcon(props?.h ?? globalH, 'Trash', props) }
export function PencilSimple(props) { return renderIcon(props?.h ?? globalH, 'PencilSimple', props) }
export function Play(props) { return renderIcon(props?.h ?? globalH, 'Play', props) }
export function CheckCircle(props) { return renderIcon(props?.h ?? globalH, 'CheckCircle', props) }
export function CircleNotch(props) { return renderIcon(props?.h ?? globalH, 'CircleNotch', props) }
export function Circle(props) { return renderIcon(props?.h ?? globalH, 'Circle', props) }
export function Clock(props) { return renderIcon(props?.h ?? globalH, 'Clock', props) }
export function ArrowRight(props) { return renderIcon(props?.h ?? globalH, 'ArrowRight', props) }
export function ArrowCounterClockwise(props) { return renderIcon(props?.h ?? globalH, 'ArrowCounterClockwise', props) }
export function CaretDown(props) { return renderIcon(props?.h ?? globalH, 'CaretDown', props) }
export function CaretRight(props) { return renderIcon(props?.h ?? globalH, 'CaretRight', props) }
export function ArrowsDownUp(props) { return renderIcon(props?.h ?? globalH, 'ArrowsDownUp', props) }
export function Prohibit(props) { return renderIcon(props?.h ?? globalH, 'Prohibit', props) }
export function DotsThree(props) { return renderIcon(props?.h ?? globalH, 'DotsThree', props) }

// Additional Phosphor icons for Mockup alignment (preserves ICON_NAMES.length === 33)
export function ClockCounterClockwise(props = {}) {
  const { size = 16, color = 'currentColor', style = {}, className = '' } = props
  const h = props?.h ?? globalH
  return h('svg', {
    viewBox: '0 0 256 256',
    width: size,
    height: size,
    fill: 'none',
    stroke: color,
    strokeWidth: 16,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    className: `ph-icon ${className}`.trim(),
    style: { display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, ...style },
  },
    h('path', { d: 'M33.4 168a96 96 0 1 0 15.1-90.5' }),
    h('polyline', { points: '32 32 32 80 80 80' }),
    h('polyline', { points: '128 72 128 128 168 152' }))
}

export function BookmarkSimple(props = {}) {
  const { size = 16, color = 'currentColor', style = {}, className = '' } = props
  const h = props?.h ?? globalH
  return h('svg', {
    viewBox: '0 0 256 256',
    width: size,
    height: size,
    fill: 'none',
    stroke: color,
    strokeWidth: 16,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    className: `ph-icon ${className}`.trim(),
    style: { display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, ...style },
  }, h('path', { d: 'M192 224l-64-40-64 40V48a16 16 0 0 1 16-16h96a16 16 0 0 1 16 16Z' }))
}

export function DotsSixVertical(props = {}) {
  const { size = 16, color = 'currentColor', style = {}, className = '' } = props
  const h = props?.h ?? globalH
  return h('svg', {
    viewBox: '0 0 256 256',
    width: size,
    height: size,
    fill: color,
    stroke: 'none',
    className: `ph-icon ${className}`.trim(),
    style: { display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, ...style },
  },
    h('circle', { cx: 96, cy: 60, r: 16 }),
    h('circle', { cx: 96, cy: 128, r: 16 }),
    h('circle', { cx: 96, cy: 196, r: 16 }),
    h('circle', { cx: 160, cy: 60, r: 16 }),
    h('circle', { cx: 160, cy: 128, r: 16 }),
    h('circle', { cx: 160, cy: 196, r: 16 }))
}

export function PaperPlaneRight(props = {}) {
  const { size = 16, color = 'currentColor', style = {}, className = '' } = props
  const h = props?.h ?? globalH
  return h('svg', {
    viewBox: '0 0 256 256',
    width: size,
    height: size,
    fill: 'none',
    stroke: color,
    strokeWidth: 16,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    className: `ph-icon ${className}`.trim(),
    style: { display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, ...style },
  },
    h('polygon', { points: '224 32 32 104 112 144 152 224 224 32' }),
    h('line', { x1: 224, y1: 32, x2: 112, y2: 144 }))
}

export function Sliders(props = {}) {
  const { size = 16, color = 'currentColor', style = {}, className = '' } = props
  const h = props?.h ?? globalH
  return h('svg', {
    viewBox: '0 0 256 256',
    width: size,
    height: size,
    fill: 'none',
    stroke: color,
    strokeWidth: 16,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    className: `ph-icon ${className}`.trim(),
    style: { display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, ...style },
  },
    h('circle', { cx: 128, cy: 128, r: 96 }),
    h('circle', { cx: 128, cy: 128, r: 32 }))
}

export function ArrowsOut(props = {}) {
  const { size = 16, color = 'currentColor', style = {}, className = '' } = props
  const h = props?.h ?? globalH
  return h('svg', {
    viewBox: '0 0 256 256',
    width: size,
    height: size,
    fill: 'none',
    stroke: color,
    strokeWidth: 16,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    className: `ph-icon ${className}`.trim(),
    style: { display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, ...style },
  },
    h('polyline', { points: '160 48 208 48 208 96' }),
    h('line', { x1: 144, y1: 112, x2: 208, y2: 48 }),
    h('polyline', { points: '96 208 48 208 48 160' }),
    h('line', { x1: 112, y1: 144, x2: 48, y2: 208 }))
}

export function List(props = {}) {
  const { size = 16, color = 'currentColor', style = {}, className = '' } = props
  const h = props?.h ?? globalH
  return h('svg', {
    viewBox: '0 0 256 256',
    width: size,
    height: size,
    fill: 'none',
    stroke: color,
    strokeWidth: 16,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    className: `ph-icon ${className}`.trim(),
    style: { display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, ...style },
  },
    h('line', { x1: 40, y1: 64, x2: 216, y2: 64 }),
    h('line', { x1: 40, y1: 128, x2: 216, y2: 128 }),
    h('line', { x1: 40, y1: 192, x2: 216, y2: 192 }))
}

export function PushPin(props = {}) {
  const { size = 16, color = 'currentColor', style = {}, className = '', filled = false } = props
  const h = props?.h ?? globalH
  return h('svg', {
    viewBox: '0 0 256 256',
    width: size,
    height: size,
    fill: filled ? color : 'none',
    stroke: color,
    strokeWidth: 16,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    className: `ph-icon ${className}`.trim(),
    style: { display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, ...style },
  },
    h('path', { d: 'M136 128l56-56a8 8 0 0 0 0-11.31l-32.69-32.69a8 8 0 0 0-11.31 0L92 84' }),
    h('path', { d: 'M136 128l-40 40' }),
    h('line', { x1: 56, y1: 200, x2: 96, y2: 168 }),
    h('line', { x1: 96, y1: 168, x2: 92, y2: 84 }),
    h('line', { x1: 32, y1: 224, x2: 56, y2: 200 }))
}

export function PushPinSimple(props = {}) {
  const { size = 16, color = 'currentColor', style = {}, className = '', filled = false } = props
  const h = props?.h ?? globalH
  return h('svg', {
    viewBox: '0 0 256 256',
    width: size,
    height: size,
    fill: filled ? color : 'none',
    stroke: color,
    strokeWidth: 16,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    className: `ph-icon ${className}`.trim(),
    style: { display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, ...style },
  },
    h('path', { d: 'M195.31 164.69l-40-40V64H168a8 8 0 0 0 0-16H88a8 8 0 0 0 0 16h12.69v60.69l-40 40A8 8 0 0 0 66.34 176H120v48a8 8 0 0 0 16 0V176h53.66a8 8 0 0 0 5.65-11.31z' }))
}

export function Paperclip(props = {}) {
  const { size = 16, color = 'currentColor', style = {}, className = '' } = props
  const h = props?.h ?? globalH
  return h('svg', {
    viewBox: '0 0 256 256',
    width: size,
    height: size,
    fill: 'none',
    stroke: color,
    strokeWidth: 16,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    className: `ph-icon ${className}`.trim(),
    style: { display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, ...style },
  },
    h('path', { d: 'M216 112v40a56 56 0 0 1-112 0V80a40 40 0 0 1 80 0v72a24 24 0 0 1-48 0V88' }))
}

export function Copy(props = {}) {
  const { size = 16, color = 'currentColor', style = {}, className = '' } = props
  const h = props?.h ?? globalH
  return h('svg', {
    viewBox: '0 0 256 256',
    width: size,
    height: size,
    fill: 'none',
    stroke: color,
    strokeWidth: 16,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    className: `ph-icon ${className}`.trim(),
    style: { display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, ...style },
  },
    h('rect', { x: '88', y: '88', width: '128', height: '128', rx: '8' }),
    h('path', { d: 'M168 88V40a8 8 0 0 0-8-8H48a8 8 0 0 0-8 8v120a8 8 0 0 0 8 8h40' }))
}

export function PunchDeskLogoColor(props = {}) {
  const { size = 18, style = {}, className = '' } = props
  const h = props?.h ?? globalH
  return h('svg', {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    className: `pd-logo-color ${className}`.trim(),
    style: { display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, ...style },
  },
    h('defs', null,
      h('linearGradient', { id: 'pdCoverGrad', x1: '0%', y1: '0%', x2: '100%', y2: '100%' },
        h('stop', { offset: '0%', stopColor: '#3B4252' }),
        h('stop', { offset: '100%', stopColor: '#2E3440' })),
      h('linearGradient', { id: 'pdRibbonGrad', x1: '0%', y1: '0%', x2: '0%', y2: '100%' },
        h('stop', { offset: '0%', stopColor: '#EBCB8B' }),
        h('stop', { offset: '100%', stopColor: '#D08770' }))),
    h('rect', { x: 3.5, y: 2.5, width: 17, height: 19, rx: 3, fill: 'url(#pdCoverGrad)', stroke: '#4C566A', strokeWidth: 1.25 }),
    h('line', { x1: 8, y1: 2.5, x2: 8, y2: 21.5, stroke: '#88C0D0', strokeWidth: 1.25, strokeDasharray: '1.5 1.5' }),
    h('circle', { cx: 5.75, cy: 6.5, r: 0.9, fill: '#81A1C1' }),
    h('circle', { cx: 5.75, cy: 12, r: 0.9, fill: '#81A1C1' }),
    h('circle', { cx: 5.75, cy: 17.5, r: 0.9, fill: '#81A1C1' }),
    h('path', { d: 'M14 2.5v6l1.75-1.25 1.75 1.25V2.5', fill: 'url(#pdRibbonGrad)', stroke: '#D08770', strokeWidth: 1, strokeLinejoin: 'round' }),
    h('path', { d: 'M11 11.5l1.5 1.5 3.5-3.5', stroke: '#A3BE8C', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round' }),
    h('line', { x1: 11, y1: 15.5, x2: 17.5, y2: 15.5, stroke: '#ECEFF4', strokeWidth: 1.3, strokeLinecap: 'round' }),
    h('line', { x1: 11, y1: 18.5, x2: 15, y2: 18.5, stroke: '#88C0D0', strokeWidth: 1.3, strokeLinecap: 'round' }))
}

export function PunchDeskLogoMono(props = {}) {
  const { size = 18, color = 'currentColor', style = {}, className = '' } = props
  const h = props?.h ?? globalH
  return h('svg', {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: color,
    strokeWidth: 1.5,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    className: `pd-logo-mono ${className}`.trim(),
    style: { display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, ...style },
  },
    h('rect', { x: 3.5, y: 2.5, width: 17, height: 19, rx: 3, strokeWidth: 1.5 }),
    h('line', { x1: 8, y1: 2.5, x2: 8, y2: 21.5, strokeWidth: 1.25, strokeDasharray: '1.5 1.5' }),
    h('circle', { cx: 5.75, cy: 6.5, r: 0.9, fill: color, stroke: 'none' }),
    h('circle', { cx: 5.75, cy: 12, r: 0.9, fill: color, stroke: 'none' }),
    h('circle', { cx: 5.75, cy: 17.5, r: 0.9, fill: color, stroke: 'none' }),
    h('path', { d: 'M14 2.5v6l1.75-1.25 1.75 1.25V2.5', fill: color, fillOpacity: 0.2, strokeWidth: 1.2 }),
    h('path', { d: 'M11 11.5l1.5 1.5 3.5-3.5', strokeWidth: 1.75 }),
    h('line', { x1: 11, y1: 15.5, x2: 17.5, y2: 15.5, strokeWidth: 1.3, strokeOpacity: 0.75 }),
    h('line', { x1: 11, y1: 18.5, x2: 15, y2: 18.5, strokeWidth: 1.3, strokeOpacity: 0.5 }))
}
