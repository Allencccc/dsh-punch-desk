/**
 * Small presentational bits. No external CSS: theme tokens and Nord mappings only.
 *
 * Implements:
 * - Borderless Fluid Cards (zero visual noise, border-bottom subtle separator, 8-10px padding)
 * - Icon-First Button patterns (icon-only with tooltip, icon + text with 6px gap)
 * - Semantic Nord tokens integration
 */

import { NORD, SEMANTIC_TOKENS } from './nord.js'
import { TIP_ATTR, markTipHost } from './tooltip-layer.js'
import {
  createIcons,
  setDefaultH,
  ClockCounterClockwise,
  BookmarkSimple,
  DotsSixVertical,
  PaperPlaneRight,
  Sliders,
  ArrowsOut,
  List,
  PushPin,
  PushPinSimple,
  Paperclip,
  Copy,
  GitBranch,
  PunchDeskLogoColor,
  PunchDeskLogoMono,
} from './icons.js'

/**
 * @typedef {'neutral'|'info'|'success'|'warn'|'danger'} BadgeTone
 * @typedef {'default'|'primary'|'ghost'|'icon'|'danger'} ButtonVariant
 */

/** @type {Record<BadgeTone, string>} */
export const TONE_COLORS = Object.freeze({
  neutral: `var(--pd-text-secondary, var(--dsw-alias-label-secondary, ${NORD.nord4}))`,
  info: `var(--pd-accent, var(--dsw-alias-state-business-primary, ${NORD.nord9}))`,
  success: `var(--dsw-alias-state-success-primary, ${NORD.nord14})`,
  warn: `var(--dsw-alias-state-warn-primary, ${NORD.nord12})`,
  danger: `var(--dsw-alias-state-error-primary, ${NORD.nord11})`,
})

/**
 * Interactive descendants of an expandable row. A click that lands on one of
 * them belongs to the inner control (button, checkbox, editable field, link)
 * and must NOT toggle the surrounding row.
 */
export const ROW_TOGGLE_IGNORE_SELECTOR = 'button, input, textarea, select, a, [contenteditable="true"], [role="button"]'

/**
 * Gate a row-level expand/collapse click.
 *
 * The whole row is a click target so the hit area stays equally wide in the
 * collapsed and the expanded state; the handler must however stay silent when
 * the click belongs to an inner control or is the tail of a text selection
 * (otherwise copy/select inside an expanded body would fold the row away).
 *
 * Tolerates a missing event so unit tests may invoke handlers directly.
 *
 * @param {any} event DOM or React synthetic click event
 * @returns {boolean} true when the row must ignore this click
 */
export function suppressesRowToggle(event) {
  if (!event || typeof event !== 'object') return false
  const target = event.target
  if (target && typeof target.closest === 'function' && target.closest(ROW_TOGGLE_IGNORE_SELECTOR)) return true
  if (typeof window !== 'undefined' && typeof window.getSelection === 'function') {
    const selection = window.getSelection()
    if (selection && String(selection).length > 0) return true
  }
  return false
}

/**
 * Fill a locale `{count}` template. A template may carry a singular and a
 * plural form separated by `|` (`{count} finding|{count} findings`); a single
 * form keeps working for locales without grammatical number.
 * @param {string} template
 * @param {number} count
 * @returns {string}
 */
export function countText(template, count) {
  const forms = typeof template === 'string' ? template.split('|') : []
  const use = forms.length > 1 ? (count === 1 ? forms[0] : forms[1]) : (forms[0] ?? '')
  return use.split('{count}').join(String(count))
}

/**
 * Format an epoch timestamp (seconds if < 1e12, milliseconds otherwise) in the
 * user's local timezone as `HH:mm`.
 * @param {number|string} epochOrMs
 * @returns {string}
 */
export function formatLocalTime(epochOrMs) {
  const n = Number(epochOrMs)
  if (epochOrMs === null || epochOrMs === undefined || epochOrMs === '') return ''
  if (Number.isFinite(n) && n <= 0) return ''
  try {
    const ms = Number.isFinite(n)
      ? (n < 1e12 ? n * 1000 : n)
      : new Date(epochOrMs).getTime()
    const d = new Date(ms)
    if (!Number.isFinite(ms) || Number.isNaN(d.getTime())) return ''
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    return `${hh}:${mm}`
  } catch {
    return ''
  }
}

/**
 * Format an epoch timestamp (seconds if < 1e12, milliseconds otherwise) in the
 * user's local timezone as `YYYY-MM-DD HH:mm:ss`.
 * @param {number|string} epochOrMs
 * @returns {string}
 */
export function formatLocalDateTime(epochOrMs) {
  const n = Number(epochOrMs)
  if (epochOrMs === null || epochOrMs === undefined || epochOrMs === '') return ''
  if (Number.isFinite(n) && n <= 0) return ''
  try {
    const ms = Number.isFinite(n)
      ? (n < 1e12 ? n * 1000 : n)
      : new Date(epochOrMs).getTime()
    const d = new Date(ms)
    if (!Number.isFinite(ms) || Number.isNaN(d.getTime())) return ''
    const yyyy = d.getFullYear()
    const mo = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    const ss = String(d.getSeconds()).padStart(2, '0')
    return `${yyyy}-${mo}-${dd} ${hh}:${mm}:${ss}`
  } catch {
    return ''
  }
}

const pendingCommitFocusBySession = new Map()
const commitFocusListeners = new Set()

/**
 * Park a commit-attribution focus target for a session and wake any mounted
 * SessionPane for that session so it expands and scrolls to the matched
 * finding(s) and commit trace.
 * @param {string} sessionId
 * @param {object} payload
 */
export function setPendingCommitFocus(sessionId, payload) {
  if (typeof sessionId !== 'string' || sessionId === '' || !payload || typeof payload !== 'object') return
  pendingCommitFocusBySession.set(sessionId, payload)
  for (const listener of commitFocusListeners) {
    try {
      listener(sessionId)
    } catch {
      // ignore listener error
    }
  }
}

/**
 * Consume the pending commit-attribution focus target for a session, if any.
 * @param {string} sessionId
 * @returns {object|null}
 */
export function takePendingCommitFocus(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  const val = pendingCommitFocusBySession.get(sessionId) ?? null
  pendingCommitFocusBySession.delete(sessionId)
  return val
}

/**
 * Subscribe to commit-attribution focus handoffs for already-mounted panes.
 * @param {(sessionId: string) => void} listener
 * @returns {() => void}
 */
export function subscribePendingCommitFocus(listener) {
  if (typeof listener !== 'function') return () => {}
  commitFocusListeners.add(listener)
  return () => {
    commitFocusListeners.delete(listener)
  }
}

/**
 * Build the shared UI components against a `createElement` implementation.
 * The factory receives `h` from `require('react')`; this module never imports React directly.
 * @param {Function} h React.createElement implementation
 * @returns {{ Button: Function, Badge: Function, Card: Function, Empty: Function, icons: object, [key: string]: any }}
 */
export function createBits(h) {
  setDefaultH(h)
  const icons = createIcons(h)

  /**
   * Icon-First Button component.
   * Supports:
   * - Icon-only buttons with mandatory tooltip/aria-label and 28x28 min hit area.
   * - Icon + text button combinations with fixed 6px gap.
   * - Semantic variants: 'default', 'primary', 'ghost', 'icon', 'danger'.
   *
   * @param {object} props
   * @param {ButtonVariant} [props.variant='default']
   * @param {Function} [props.icon] Phosphor icon component
   * @param {boolean} [props.iconOnly=false]
   * @param {boolean} [props.disabled=false]
   * @param {string} [props.title]
   * @param {string} [props['aria-label']]
   * @param {object} [props.style]
   * @param {string} [props.type='button']
   * @param {any} [props.children]
   */
  function Button({
    variant = 'default',
    icon,
    iconOnly = false,
    disabled = false,
    title,
    'aria-label': ariaLabel,
    style,
    children,
    type = 'button',
    ...rest
  }) {
    const isIconOnly = iconOnly || variant === 'icon' || (Boolean(icon) && (!children || (Array.isArray(children) && children.length === 0)))
    const effectiveAriaLabel = ariaLabel || title || (typeof children === 'string' ? children : undefined)

    let palette
    switch (variant) {
      case 'primary':
        palette = {
          background: `var(--pd-accent, var(--dsw-alias-button-primary-fill, ${NORD.nord8}))`,
          color: `var(--pd-accent-fg, var(--dsw-alias-label-primary-inverted, ${NORD.nord0}))`,
          border: '1px solid transparent',
        }
        break
      case 'ghost':
      case 'icon':
        palette = {
          background: 'transparent',
          color: `var(--pd-text-secondary, var(--dsw-alias-label-secondary, ${NORD.nord4}))`,
          border: '1px solid transparent',
        }
        break
      case 'danger':
        palette = {
          background: 'transparent',
          color: `var(--dsw-alias-state-error-primary, ${NORD.nord11})`,
          border: `1px solid var(--pd-border-default, var(--dsw-alias-border-l1, ${NORD.nord2}))`,
        }
        break
      case 'default':
      default:
        palette = {
          background: `var(--pd-bg-panel, var(--dsw-alias-bg-layer-2, ${NORD.nord1}))`,
          color: `var(--pd-text-primary, var(--dsw-alias-label-primary, ${NORD.nord6}))`,
          border: `1px solid var(--pd-border-default, var(--dsw-alias-border-l1, ${NORD.nord2}))`,
        }
        break
    }

    const baseStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      borderRadius: isIconOnly ? 4 : 6,
      fontFamily: 'inherit',
      fontSize: 13,
      fontWeight: 500,
      lineHeight: 1.4,
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.55 : 1,
      minWidth: isIconOnly ? 28 : undefined,
      minHeight: isIconOnly ? 28 : undefined,
      padding: isIconOnly ? 4 : '5px 12px',
      ...palette,
      ...style,
    }

    const content = []
    if (icon) {
      content.push(h(icon, { key: '__btn_icon__', size: isIconOnly ? 16 : 14 }))
    }
    if (children !== undefined && children !== null && !isIconOnly) {
      if (Array.isArray(children)) {
        content.push(...children)
      } else {
        content.push(children)
      }
    }

    return h('button', {
      ...rest,
      type,
      disabled,
      title,
      'aria-label': effectiveAriaLabel,
      style: baseStyle,
    }, ...content)
  }

  /**
   * Badge component for labels, severities, and status tags.
   *
   * @param {object} props
   * @param {BadgeTone} [props.tone='neutral']
   * @param {Function} [props.icon]
   * @param {object} [props.style]
   * @param {string} [props.title]
   * @param {any} [props.children]
   */
  function Badge({ tone = 'neutral', icon, style, title, tip, children, 'aria-label': ariaLabel, [TIP_ATTR]: dataTip }) {
    const content = []
    if (icon) {
      content.push(h(icon, { key: '__badge_icon__', size: 12 }))
    }
    if (children !== undefined && children !== null) {
      if (Array.isArray(children)) {
        content.push(...children)
      } else {
        content.push(children)
      }
    }

    return h('span', {
      title,
      [TIP_ATTR]: dataTip || tip,
      'aria-label': ariaLabel || tip || title,
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '1px 6px',
        borderRadius: 4,
        fontSize: 11,
        lineHeight: '16px',
        whiteSpace: 'nowrap',
        color: TONE_COLORS[tone] ?? TONE_COLORS.neutral,
        background: `var(--pd-bg-panel, var(--dsw-alias-bg-layer-2, ${NORD.nord1}))`,
        border: `1px solid var(--pd-border-default, var(--dsw-alias-border-l1, ${NORD.nord2}))`,
        ...style,
      },
    }, ...content)
  }

  /**
   * Borderless Fluid Card Component (v2.0 Spec).
   *
   * Replaces enclosed box-in-box card frames with minimal, fluid list rows
   * separated solely by a subtle 1px bottom border.
   *
   * @param {object} props
   * @param {'fluid'|'boxed'} [props.variant='fluid']
   * @param {boolean} [props.last=false] When true, removes bottom border
   * @param {object} [props.style]
   * @param {any} [props.children]
   */
  markTipHost(Button)
  markTipHost(Badge)

  function Card({ variant = 'fluid', last = false, style, children, ...rest }) {
    const isBoxed = variant === 'boxed'

    const cardStyle = isBoxed ? {
      padding: 10,
      borderRadius: 8,
      background: `var(--pd-bg-card, var(--dsw-alias-bg-layer-1, ${NORD.nord0}))`,
      border: `1px solid var(--pd-border-default, var(--dsw-alias-border-l1, ${NORD.nord2}))`,
    } : {
      padding: '8px 10px',
      borderRadius: 0,
      background: 'transparent',
      border: 'none',
      borderBottom: last ? 'none' : `1px solid var(--pd-border-subtle, var(--dsw-alias-border-l2, ${NORD.nord3}))`,
    }

    return h('div', {
      ...rest,
      style: {
        ...cardStyle,
        ...style,
      },
    }, children)
  }

  /**
   * Empty state display with optional icon and message.
   *
   * @param {object} props
   * @param {Function} [props.icon]
   * @param {object} [props.style]
   * @param {any} [props.children]
   */
  function Empty({ icon, style, children }) {
    const content = []
    if (icon) {
      content.push(h(icon, {
        key: '__empty_icon__',
        size: 28,
        color: `var(--dsw-alias-label-tertiary, ${NORD.nord3})`,
      }))
    }
    if (children !== undefined && children !== null) {
      if (Array.isArray(children)) {
        content.push(...children)
      } else {
        content.push(children)
      }
    }

    return h('div', {
      style: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        padding: '18px 8px',
        textAlign: 'center',
        fontSize: 12,
        lineHeight: 1.5,
        color: `var(--dsw-alias-label-tertiary, ${NORD.nord3})`,
        ...style,
      },
    }, ...content)
  }

  return {
    Button,
    Badge,
    Card,
    Empty,
    icons,
    ...icons,
    FadersIcon: props => icons.Faders?.(props) ?? null,
    ClockCounterClockwise: props => ClockCounterClockwise({ ...props, h }),
    BookmarkSimple: props => BookmarkSimple({ ...props, h }),
    DotsSixVertical: props => DotsSixVertical({ ...props, h }),
    PaperPlaneRight: props => PaperPlaneRight({ ...props, h }),
    Sliders: props => Sliders({ ...props, h }),
    ArrowsOut: props => ArrowsOut({ ...props, h }),
    List: props => List({ ...props, h }),
    PushPin: props => PushPin({ ...props, h }),
    PushPinSimple: props => PushPinSimple({ ...props, h }),
    Paperclip: props => Paperclip({ ...props, h }),
    Copy: props => Copy({ ...props, h }),
    GitBranch: props => GitBranch({ ...props, h }),
    PunchDeskLogoColor: props => PunchDeskLogoColor({ ...props, h }),
    PunchDeskLogoMono: props => PunchDeskLogoMono({ ...props, h }),
  }
}
