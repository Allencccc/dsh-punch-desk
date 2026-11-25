/** Submitted prompt log: rows grouped by local date and session, each row expandable to full detail. */

import { groupByDateAndSession } from '../../domain/prompt-log.js'
import { createBits } from './bits.js'

/** Badge tone per prompt-log status. */
const STATUS_TONE = {
  queued: 'info',
  sent: 'info',
  completed: 'success',
  expired: 'warn',
}

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

const LIST_STYLE = { display: 'flex', flexDirection: 'column', gap: 10 }
const GROUP_STYLE = { display: 'flex', flexDirection: 'column', gap: 4 }
const DATE_STYLE = { fontSize: 12, fontWeight: 600, color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #434c5e))' }
const SESSION_STYLE = { display: 'flex', flexDirection: 'column' }
const ROW_STYLE = { display: 'flex', gap: 6, alignItems: 'center', padding: '3px 0' }
const TIME_STYLE = {
  flexShrink: 0,
  fontSize: 12,
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
}
const EXCERPT_STYLE = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 13,
  color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #2e3440))',
}
const FULL_STYLE = {
  ...EXCERPT_STYLE,
  overflow: 'visible',
  textOverflow: 'clip',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
}
const META_STYLE = {
  padding: '2px 0 4px 20px',
  fontSize: 10,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
}

/**
 * @param {number|undefined} time epoch milliseconds
 * @returns {string} locale-formatted clock time, or an empty string when absent
 */
function formatTime(time) {
  return Number.isFinite(time) ? TIME_FORMAT.format(new Date(time)) : ''
}

/**
 * @param {{ h: Function, t: Function, React: object }} deps
 * @returns {Function} the SubmittedList React component
 */
export function createSubmittedList({ h, t, React }) {
  const { Badge, CaretDown, CaretRight } = createBits(h)

  return function SubmittedList({ entries }) {
    const [expanded, setExpanded] = React.useState(() => new Set())
    const groups = groupByDateAndSession(Array.isArray(entries) ? entries : [])
    if (groups.length === 0) return null

    const toggle = id => {
      setExpanded(current => {
        const next = new Set(current)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    }

    const renderEntry = entry => {
      const id = entry.messageId
      const isOpen = expanded.has(id)
      const fullText = entry.promptText || entry.excerpt || entry.messageId
      const meta = []
      if (Number.isFinite(entry.turn)) meta.push(t('submitted.turn').replace('{turn}', String(entry.turn)))
      if (typeof entry.source === 'string' && entry.source !== '') meta.push(t('submitted.source').replace('{source}', entry.source))
      return h('div', { key: id },
        h('div', {
          role: 'button',
          tabIndex: 0,
          'aria-expanded': isOpen,
          title: isOpen ? t('finding.collapse') : t('finding.expand'),
          onClick: () => toggle(id),
          onKeyDown: event => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            toggle(id)
          },
          style: { ...ROW_STYLE, cursor: 'pointer', alignItems: isOpen ? 'flex-start' : 'center' },
        },
          isOpen ? h(CaretDown, { size: 11 }) : h(CaretRight, { size: 11 }),
          h('span', { style: TIME_STYLE }, formatTime(entry.time)),
          h('span', {
            style: isOpen ? FULL_STYLE : EXCERPT_STYLE,
            tip: fullText,
          }, fullText),
          h(Badge, { tone: STATUS_TONE[entry.status] ?? 'neutral' }, t(`status.${entry.status}`))),
        isOpen && meta.length > 0
          ? h('div', { style: META_STYLE }, meta.join(' · '))
          : null)
    }

    return h('div', { style: LIST_STYLE },
      groups.map(group => h('section', { key: group.date, style: GROUP_STYLE },
        h('div', { style: DATE_STYLE }, group.date),
        group.sessions.map(session => h('div', { key: session.sessionId, style: SESSION_STYLE },
          session.entries.map(renderEntry))))))
  }
}
