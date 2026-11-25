/**
 * Action Card List: fluid borderless list of Turn Action Items grouped by turn.
 * Follows Nord design system and pure icon-first principles.
 */

import { NORD, nordTint } from './nord.js'
import { itemOriginKey } from '../../domain/turn-actions.js'
import { createBits, TONE_COLORS } from './bits.js'

/** Tone per kind */
const KIND_TONES = {
  confirm: 'warn',
  unaddressed: 'danger',
  'question-pending': 'info',
  'question-error': 'danger',
  'approval-pending': 'warn',
  'turn-failed': 'danger',
  'text-question': 'neutral',
}

const TURN_PREVIEW_MAX_CHARS = 48

/**
 * Build a one-line preview of the prompt submitted for a turn.
 * Drops the plugin banner / markdown heading / list numbering so the first
 * meaningful characters identify the turn in the group header.
 * @param {string} text
 * @param {number} [limit]
 * @returns {string}
 */
export function summarizeTurnPrompt(text, limit = TURN_PREVIEW_MAX_CHARS) {
  if (typeof text !== 'string') return ''
  let value = text
    .replace(/^\s*[\[【]会话手账[^\]】]*[\]】]\s*/u, '')
    .replace(/^\s*#{1,6}\s*/u, '')
    .replace(/^\s*[-*+]\s+/u, '')
    .trim()
  value = value.replace(/^\d{1,3}\s*[.、)）:：]\s*/u, '').trim()
  value = value.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim()
  if (!value) return ''
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

const KIND_LOCALE_KEYS = {
  confirm: 'turnActions.kind.confirm',
  unaddressed: 'turnActions.kind.unaddressed',
  'question-pending': 'turnActions.kind.questionPending',
  'question-error': 'turnActions.kind.questionError',
  'approval-pending': 'turnActions.kind.approvalPending',
  'turn-failed': 'turnActions.kind.turnFailed',
  'text-question': 'turnActions.kind.textQuestion',
}

/**
 * Creates the ActionCardList component.
 *
 * @param {{ h: Function, t: Function, React: object }} deps
 * @returns {Function} ActionCardList component
 */
export function createActionCardList({ h, t, React }) {
  const {
    Badge,
    Button,
    Empty,
    Plus,
    ArrowRight,
    ClockCounterClockwise,
    ChatTeardropText,
    MagnifyingGlass,
    X,
    CaretDown,
    CaretRight,
    CheckCircle,
  } = createBits(h)

  return function ActionCardList({
    items = [],
    turnPrompts,
    onConfirm,
    onDismiss,
    onUndo,
    onRevealQuestion,
    onViewContext,
    onViewFinding,
    highlightedId,
  }) {
    const [expandedQuotes, setExpandedQuotes] = React.useState(() => new Set())
    const [expandedDismissed, setExpandedDismissed] = React.useState(() => new Set())
    const [expandedConverted, setExpandedConverted] = React.useState(() => new Set())

    const toggleQuote = (id) => {
      setExpandedQuotes(prev => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    }

    const toggleDismissed = (id) => {
      setExpandedDismissed(prev => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    }

    const toggleConverted = (id) => {
      setExpandedConverted(prev => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    }

    if (!Array.isArray(items) || items.length === 0) {
      return h('div', { style: { padding: '16px 12px' } },
        h(Empty, { style: { padding: '8px' } }, t('turnActions.empty')))
    }

    // Group items by turn (descending)
    const turnMap = new Map()
    for (const item of items) {
      if (!item) continue
      const turn = typeof item.turn === 'number' ? item.turn : 0
      if (!turnMap.has(turn)) {
        turnMap.set(turn, [])
      }
      turnMap.get(turn).push(item)
    }

    const sortedTurns = Array.from(turnMap.keys()).sort((a, b) => b - a)

    return h('div', {
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '6px 8px',
      },
    },
      sortedTurns.map(turn => {
        const turnItems = turnMap.get(turn) || []
        const rawPrompt = turnPrompts instanceof Map
          ? turnPrompts.get(turn)
          : turnPrompts?.[turn]
        const fallbackTitle = String(turnItems.find(item => item?.title)?.title || '')
          .replace(new RegExp(`^Turn ${turn} · `), '')
        const preview = summarizeTurnPrompt(rawPrompt) || summarizeTurnPrompt(fallbackTitle)
        const turnHeader = h('div', {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '2px 4px',
            fontSize: 10,
            fontWeight: 700,
            color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            minWidth: 0,
          },
        },
          h('span', { style: { flexShrink: 0 } }, t('turnActions.turnGroup').replace('{n}', String(turn))),
          preview
            ? h('span', {
                'data-testid': 'turn-action-preview',
                style: {
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  textTransform: 'none',
                  letterSpacing: 0,
                  fontWeight: 500,
                  color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #d8dee9))',
                },
              }, preview)
            : null,
          h('span', {
            style: {
              fontSize: 9,
              fontWeight: 600,
              flexShrink: 0,
              color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
              background: 'var(--pd-bg-element, var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.06)))',
              padding: '0 4px',
              borderRadius: 4,
            },
          }, String(turnItems.length)))
        return h('div', {
          key: `turn-${turn}`,
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          },
        },
          turnHeader,

          // Turn items
          turnItems.map((item, idx) => {
            const key = item.id || itemOriginKey(item)
            const isHighlighted = highlightedId === key
            const isLast = idx === turnItems.length - 1
            const kindKey = KIND_LOCALE_KEYS[item.kind] || 'turnActions.kind.confirm'
            const kindTone = KIND_TONES[item.kind] || 'neutral'
            const isQuoteExpanded = expandedQuotes.has(key)
            const hasLongQuote = typeof item.quote === 'string' && item.quote.length > 120
            const isDismissed = item.status === 'dismissed'
            const isDismissedExpanded = expandedDismissed.has(key)

            // Dismissed item: compact single-line layout by default with inline undo button, expandable on click
            if (isDismissed) {
              return h('div', {
                key,
                id: `action-${key}`,
                className: 'pd-turn-action-card pd-turn-action-card-dismissed',
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  gap: isDismissedExpanded ? 6 : 0,
                  padding: isDismissedExpanded ? '6px 6px' : '4px 6px',
                  borderRadius: 6,
                  opacity: 0.85,
                  background: isHighlighted ? nordTint(NORD.nord8, 0.12) : 'transparent',
                  borderBottom: isLast ? 'none' : '1px solid var(--pd-border-default, var(--dsw-alias-border-subtle, rgba(255, 255, 255, 0.06)))',
                  transition: 'background 0.2s ease',
                },
              },
                // Header row: clickable to toggle expansion
                h('div', {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 6,
                    cursor: 'pointer',
                    userSelect: 'none',
                  },
                  onClick: () => toggleDismissed(key),
                  title: isDismissedExpanded ? t('finding.collapse') : t('finding.expand'),
                },
                  // Left: "已忽略" status badge + confidence + evidence seq + (compact title snippet when collapsed)
                  h('div', {
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      minWidth: 0,
                      flex: 1,
                    },
                  },
                    h(Badge, {
                      tone: 'neutral',
                      style: { fontSize: 9, padding: '1px 5px', fontWeight: 600 },
                    }, t('turnActions.statusDismissed')),
                    item.confidence === 'high'
                      ? h(Badge, {
                          tone: 'info',
                          style: { fontSize: 9, padding: '1px 4px' },
                        }, t('turnActions.confidenceHigh'))
                      : (item.confidence === 'medium'
                          ? h(Badge, {
                              tone: 'neutral',
                              style: { fontSize: 9, padding: '1px 4px' },
                            }, t('turnActions.confidenceMedium'))
                          : null),
                    typeof item.evidenceSeq === 'number' && item.evidenceSeq > 0
                      ? h('span', {
                          style: {
                            fontSize: 9,
                            color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
                            fontVariantNumeric: 'tabular-nums',
                            flexShrink: 0,
                          },
                        }, t('turnActions.evidenceSeq').replace('{seq}', String(item.evidenceSeq)))
                      : null,
                    !isDismissedExpanded && item.title
                      ? h('span', {
                          style: {
                            fontSize: 11,
                            color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            marginLeft: 2,
                          },
                        }, item.title)
                      : null),
                  // Right: Undo button + chevron
                  h('div', {
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      flexShrink: 0,
                    },
                  },
                    h(Button, {
                      key: 'undo',
                      variant: 'ghost',
                      icon: ClockCounterClockwise,
                      onClick: (e) => {
                        if (e && typeof e.stopPropagation === 'function') e.stopPropagation()
                        onUndo && onUndo(item)
                      },
                      title: t('turnActions.action.undo'),
                      style: { padding: '2px 6px', fontSize: 10 },
                    }, t('turnActions.action.undo')),
                    h('span', {
                      style: {
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
                        padding: '2px',
                      },
                    },
                      isDismissedExpanded ? h(CaretDown, { size: 12 }) : h(CaretRight, { size: 12 })))),

                // Expanded content: full title + quote
                isDismissedExpanded
                  ? [
                      h('div', {
                        key: 'title',
                        style: {
                          fontSize: 12,
                          fontWeight: 600,
                          color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #eceff4))',
                          lineHeight: 1.4,
                          wordBreak: 'break-word',
                        },
                      }, item.title || t('entry.untitled')),
                      item.quote
                        ? h('div', {
                            key: 'quote',
                            style: {
                              background: 'var(--pd-bg-element, var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.08)))',
                              borderLeft: '2px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
                              padding: '4px 8px',
                              borderRadius: '0 4px 4px 0',
                              fontSize: 11,
                              color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #d8dee9))',
                              fontStyle: 'italic',
                              lineHeight: 1.4,
                              wordBreak: 'break-word',
                            },
                          },
                            hasLongQuote && !isQuoteExpanded
                              ? `${item.quote.slice(0, 120)}…`
                              : item.quote,
                            hasLongQuote
                              ? h('button', {
                                  type: 'button',
                                  onClick: (e) => {
                                    if (e && typeof e.stopPropagation === 'function') e.stopPropagation()
                                    toggleQuote(key)
                                  },
                                  style: {
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 2,
                                    background: 'transparent',
                                    border: 'none',
                                    padding: '0 4px',
                                    marginLeft: 4,
                                    fontSize: 10,
                                    color: 'var(--pd-accent, #88c0d0)',
                                    cursor: 'pointer',
                                  },
                                },
                                  isQuoteExpanded ? h(CaretDown, { size: 10 }) : h(CaretRight, { size: 10 }),
                                  isQuoteExpanded ? t('turnActions.quoteCollapse') : t('turnActions.quoteExpand'))
                              : null)
                        : null,
                    ]
                  : null)
            }

            const isConverted = item.status === 'converted'
            const isConvertedExpanded = expandedConverted.has(key)

            // Converted item: compact single-line layout by default with inline "view finding" button, expandable on click
            if (isConverted) {
              return h('div', {
                key,
                id: `action-${key}`,
                className: 'pd-turn-action-card pd-turn-action-card-converted',
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  gap: isConvertedExpanded ? 6 : 0,
                  padding: isConvertedExpanded ? '6px 6px' : '4px 6px',
                  borderRadius: 6,
                  opacity: 0.95,
                  background: isHighlighted ? nordTint(NORD.nord8, 0.12) : 'transparent',
                  borderBottom: isLast ? 'none' : '1px solid var(--pd-border-default, var(--dsw-alias-border-subtle, rgba(255, 255, 255, 0.06)))',
                  transition: 'background 0.2s ease',
                },
              },
                // Header row: clickable to toggle expansion
                h('div', {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 6,
                    cursor: 'pointer',
                    userSelect: 'none',
                  },
                  onClick: () => toggleConverted(key),
                  title: isConvertedExpanded ? t('finding.collapse') : t('finding.expand'),
                },
                  // Left: "已确认" status badge + confidence + evidence seq + (compact title snippet when collapsed)
                  h('div', {
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      minWidth: 0,
                      flex: 1,
                    },
                  },
                    h(Badge, {
                      tone: 'success',
                      style: { fontSize: 9, padding: '1px 5px', fontWeight: 600 },
                    },
                      h(CheckCircle, { size: 10, style: { marginRight: 3 } }),
                      t('turnActions.statusConverted')),
                    item.confidence === 'high'
                      ? h(Badge, {
                          tone: 'info',
                          style: { fontSize: 9, padding: '1px 4px' },
                        }, t('turnActions.confidenceHigh'))
                      : (item.confidence === 'medium'
                          ? h(Badge, {
                              tone: 'neutral',
                              style: { fontSize: 9, padding: '1px 4px' },
                            }, t('turnActions.confidenceMedium'))
                          : null),
                    typeof item.evidenceSeq === 'number' && item.evidenceSeq > 0
                      ? h('span', {
                          style: {
                            fontSize: 9,
                            color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
                            fontVariantNumeric: 'tabular-nums',
                            flexShrink: 0,
                          },
                        }, t('turnActions.evidenceSeq').replace('{seq}', String(item.evidenceSeq)))
                      : null,
                    !isConvertedExpanded && item.title
                      ? h('span', {
                          style: {
                            fontSize: 11,
                            color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            marginLeft: 2,
                          },
                        }, item.title)
                      : null),
                  // Right: View Finding button + chevron
                  h('div', {
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      flexShrink: 0,
                    },
                  },
                    h(Button, {
                      key: 'view',
                      variant: 'default',
                      icon: ArrowRight,
                      onClick: (e) => {
                        if (e && typeof e.stopPropagation === 'function') e.stopPropagation()
                        onViewFinding && onViewFinding(item.findingId)
                      },
                      title: t('turnActions.action.viewFinding'),
                      style: {
                        padding: '2px 8px',
                        fontSize: 10,
                        fontWeight: 500,
                        color: TONE_COLORS.success,
                        borderColor: TONE_COLORS.success,
                      },
                    }, t('turnActions.action.viewFinding')),
                    h('span', {
                      style: {
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
                        padding: '2px',
                      },
                    },
                      isConvertedExpanded ? h(CaretDown, { size: 12 }) : h(CaretRight, { size: 12 })))),

                // Expanded content: full title + quote
                isConvertedExpanded
                  ? [
                      h('div', {
                        key: 'title',
                        style: {
                          fontSize: 12,
                          fontWeight: 600,
                          color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #eceff4))',
                          lineHeight: 1.4,
                          wordBreak: 'break-word',
                        },
                      }, item.title || t('entry.untitled')),
                      item.quote
                        ? h('div', {
                            key: 'quote',
                            style: {
                              background: 'var(--pd-bg-element, var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.08)))',
                              borderLeft: '2px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
                              padding: '4px 8px',
                              borderRadius: '0 4px 4px 0',
                              fontSize: 11,
                              color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #d8dee9))',
                              fontStyle: 'italic',
                              lineHeight: 1.4,
                              wordBreak: 'break-word',
                            },
                          },
                            hasLongQuote && !isQuoteExpanded
                              ? `${item.quote.slice(0, 120)}…`
                              : item.quote,
                            hasLongQuote
                              ? h('button', {
                                  type: 'button',
                                  onClick: (e) => {
                                    if (e && typeof e.stopPropagation === 'function') e.stopPropagation()
                                    toggleQuote(key)
                                  },
                                  style: {
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 2,
                                    background: 'transparent',
                                    border: 'none',
                                    padding: '0 4px',
                                    marginLeft: 4,
                                    fontSize: 10,
                                    color: 'var(--pd-accent, #88c0d0)',
                                    cursor: 'pointer',
                                  },
                                },
                                  isQuoteExpanded ? h(CaretDown, { size: 10 }) : h(CaretRight, { size: 10 }),
                                  isQuoteExpanded ? t('turnActions.quoteCollapse') : t('turnActions.quoteExpand'))
                              : null)
                        : null,
                    ]
                  : null)
            }

            return h('div', {
              key,
              id: `action-${key}`,
              className: 'pd-turn-action-card',
              style: {
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                padding: '8px 6px',
                borderRadius: 6,
                background: isHighlighted ? nordTint(NORD.nord8, 0.12) : 'transparent',
                borderBottom: isLast ? 'none' : '1px solid var(--pd-border-default, var(--dsw-alias-border-subtle, rgba(255, 255, 255, 0.06)))',
                transition: 'background 0.2s ease',
              },
            },
              // Card top row: badges
              h('div', {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 6,
                },
              },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                  h(Badge, {
                    tone: kindTone,
                    style: { fontSize: 9, padding: '1px 5px', fontWeight: 600 },
                  }, t(kindKey)),
                  item.confidence === 'high'
                    ? h(Badge, {
                        tone: 'info',
                        style: { fontSize: 9, padding: '1px 4px' },
                      }, t('turnActions.confidenceHigh'))
                    : (item.confidence === 'medium'
                        ? h(Badge, {
                            tone: 'neutral',
                            style: { fontSize: 9, padding: '1px 4px' },
                          }, t('turnActions.confidenceMedium'))
                        : null),
                  typeof item.evidenceSeq === 'number' && item.evidenceSeq > 0
                    ? h('span', {
                        style: {
                          fontSize: 9,
                          color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
                          fontVariantNumeric: 'tabular-nums',
                        },
                      }, t('turnActions.evidenceSeq').replace('{seq}', String(item.evidenceSeq)))
                    : null),
                // Status badge
                item.status === 'stale'
                  ? h(Badge, { tone: 'neutral', style: { fontSize: 9 } }, t('turnActions.statusStale'))
                  : null),

              // Title
              h('div', {
                style: {
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #eceff4))',
                  lineHeight: 1.4,
                  wordBreak: 'break-word',
                },
              }, item.title || t('entry.untitled')),

              // Quote excerpt
              item.quote
                ? h('div', {
                    style: {
                      background: 'var(--pd-bg-element, var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.08)))',
                      borderLeft: '2px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
                      padding: '4px 8px',
                      borderRadius: '0 4px 4px 0',
                      fontSize: 11,
                      color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #d8dee9))',
                      fontStyle: 'italic',
                      lineHeight: 1.4,
                      wordBreak: 'break-word',
                    },
                  },
                    hasLongQuote && !isQuoteExpanded
                      ? `${item.quote.slice(0, 120)}…`
                      : item.quote,
                    hasLongQuote
                      ? h('button', {
                          type: 'button',
                          onClick: () => toggleQuote(key),
                          style: {
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 2,
                            background: 'transparent',
                            border: 'none',
                            padding: '0 4px',
                            marginLeft: 4,
                            fontSize: 10,
                            color: 'var(--pd-accent, #88c0d0)',
                            cursor: 'pointer',
                          },
                        },
                          isQuoteExpanded ? h(CaretDown, { size: 10 }) : h(CaretRight, { size: 10 }),
                          isQuoteExpanded ? t('turnActions.quoteCollapse') : t('turnActions.quoteExpand'))
                      : null)
                : null,

              // Action buttons row
              h('div', {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  marginTop: 2,
                },
              },
                (item.status === 'open' || item.status === 'stale')
                  ? [
                      item.status === 'open'
                        ? h(Button, {
                            key: 'confirm',
                            variant: 'primary',
                            icon: Plus,
                            onClick: () => onConfirm && onConfirm(item),
                            title: t('turnActions.action.createFinding'),
                            style: { padding: '2px 8px', fontSize: 10, fontWeight: 600 },
                          }, t('turnActions.action.createFinding'))
                        : null,
                      item.kind === 'question-pending'
                        ? h(Button, {
                            key: 'question',
                            variant: 'default',
                            icon: ChatTeardropText,
                            onClick: () => onRevealQuestion && onRevealQuestion(item),
                            title: t('turnActions.action.revealQuestion'),
                            style: { padding: '2px 8px', fontSize: 10 },
                          }, t('turnActions.action.revealQuestion'))
                        : null,
                      (item.kind === 'turn-failed' || item.kind === 'approval-pending')
                        ? h(Button, {
                            key: 'context',
                            variant: 'default',
                            icon: MagnifyingGlass,
                            onClick: () => onViewContext && onViewContext(item),
                            title: t('turnActions.action.viewContext'),
                            style: { padding: '2px 8px', fontSize: 10 },
                          }, t('turnActions.action.viewContext'))
                        : null,
                      h(Button, {
                        key: 'dismiss',
                        variant: 'ghost',
                        icon: X,
                        onClick: () => onDismiss && onDismiss(item),
                        title: t('turnActions.action.dismiss'),
                        style: { padding: '2px 6px', fontSize: 10 },
                      }, t('turnActions.action.dismiss')),
                    ]
                  : null))
          }))
      }))
  }
}
