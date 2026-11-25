/**
 * Engineering & Spec Analytics view (Sub-view 4 of Desk).
 *
 * Implements:
 * 1. Findings tag distribution (optimize, refactor, blocker, context) with Nord semantic colors
 * 2. Session elapsed turns ladder distribution (1-5, 6-15, 16-30, 30+)
 * 3. Spec conversion rate calculation and breakdown
 */

import { computeAnalytics } from '../../domain/desk-analytics.js'
import { countText, createBits } from './bits.js'
import { NORD, TAG_COLORS } from './nord.js'

const CONTAINER_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  height: '100%',
  minHeight: 0,
  overflowY: 'auto',
  paddingRight: 4,
}

const HEADER_STYLE = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  paddingBottom: 6,
  borderBottom: '1px solid var(--pd-border-subtle, var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08)))',
}

const TITLE_STYLE = {
  fontSize: 15,
  fontWeight: 600,
  color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #2e3440))',
}

const KPI_GRID_STYLE = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, 1fr)',
  gap: 10,
}

const KPI_CARD_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '12px 14px',
  borderRadius: 8,
  background: 'var(--pd-bg-card, var(--dsw-alias-bg-layer-1, #ffffff))',
  border: '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
}

const KPI_VALUE_STYLE = {
  fontSize: 22,
  fontWeight: 700,
  lineHeight: 1.2,
  color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #2e3440))',
}

const KPI_LABEL_STYLE = {
  fontSize: 12,
  color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #434c5e))',
  fontWeight: 500,
}

const SECTION_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: '12px 14px',
  borderRadius: 8,
  background: 'var(--pd-bg-card, var(--dsw-alias-bg-layer-1, #ffffff))',
  border: '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
}

const SECTION_TITLE_STYLE = {
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #2e3440))',
}

const BAR_ROW_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  fontSize: 12,
}

const BAR_LABEL_STYLE = {
  width: 120,
  flexShrink: 0,
  color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #434c5e))',
}

const BAR_TRACK_STYLE = {
  flex: 1,
  height: 12,
  borderRadius: 6,
  background: 'var(--pd-bg-panel, var(--dsw-alias-bg-layer-2, #d8dee9))',
  overflow: 'hidden',
}

const NOTE_STYLE = {
  fontSize: 11,
  color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
  fontStyle: 'italic',
}

/**
 * @param {{ h: Function, React: object, services: object }} deps
 * @returns {Function} the AnalyticsView React component
 */
export function createAnalyticsView({ h, React, services }) {
  const { Badge, Card, Empty, icons } = createBits(h)
  const t = services.t

  return function AnalyticsView({
    sessions = [],
    findings = [],
    promptLogs = [],
  }) {
    const stats = computeAnalytics({ findings, sessions, promptLogs })

    const TAG_LABELS = {
      optimize: t('analytics.tag.optimize'),
      refactor: t('analytics.tag.refactor'),
      blocker: t('analytics.tag.blocker'),
      context: t('analytics.tag.context'),
    }

    const LADDER_LABELS = {
      '1-5': t('analytics.ladder.short'),
      '6-15': t('analytics.ladder.medium'),
      '16-30': t('analytics.ladder.long'),
      '30+': t('analytics.ladder.extra'),
    }

    return h('div', { style: CONTAINER_STYLE },
      // Title
      h('div', { style: HEADER_STYLE },
        h('span', { style: TITLE_STYLE }, t('analytics.title')),
        h(Badge, { tone: 'info', icon: icons.ChartBar }, t('desk.tab.analytics'))),

      // KPI Metric Cards
      h('div', { style: KPI_GRID_STYLE },
        h('div', { style: KPI_CARD_STYLE },
          h('span', {
            style: {
              ...KPI_VALUE_STYLE,
              color: `var(--dsw-alias-state-business-primary, ${NORD.nord8})`,
            },
          }, `${stats.conversionRate}%`),
          h('span', { style: KPI_LABEL_STYLE }, t('analytics.conversionRate')),
          h('span', { style: NOTE_STYLE }, t('analytics.conversionFormula'))),
        h('div', { style: KPI_CARD_STYLE },
          h('span', { style: KPI_VALUE_STYLE }, `${stats.resolvedFindings} / ${stats.totalFindings}`),
          h('span', { style: KPI_LABEL_STYLE }, t('analytics.resolvedRate')),
          h('span', { style: NOTE_STYLE }, t('analytics.resolvedRatio').replace('{ratio}', String(stats.resolvedRatio)))),
        h('div', { style: KPI_CARD_STYLE },
          h('span', { style: KPI_VALUE_STYLE }, String(stats.totalTurns)),
          h('span', { style: KPI_LABEL_STYLE }, t('dashboard.metric.totalTurns')),
          h('span', { style: NOTE_STYLE }, t('analytics.turnsNote')))),

      // Section 1: Findings Distribution by Tag
      h('div', { style: SECTION_STYLE },
        h('span', { style: SECTION_TITLE_STYLE }, t('analytics.findingsDistribution')),
        Object.entries(stats.tagCounts).map(([tag, count]) => {
          const pct = stats.tagPercentages[tag] || 0
          const color = TAG_COLORS[tag] || NORD.nord8
          return h('div', { key: tag, style: BAR_ROW_STYLE },
            h('span', { style: BAR_LABEL_STYLE }, TAG_LABELS[tag] || tag),
            h('div', { style: BAR_TRACK_STYLE },
              h('div', {
                style: {
                  width: `${Math.max(pct, count > 0 ? 3 : 0)}%`,
                  height: '100%',
                  background: color,
                  borderRadius: 6,
                  transition: 'width 0.2s ease',
                },
              })),
            h('span', { style: { width: 60, textAlign: 'right', color: 'var(--dsw-alias-label-primary)' } }, `${count} (${pct}%)`))
        })),

      // Section 2: Session Elapsed Turns Ladder Distribution
      h('div', { style: SECTION_STYLE },
        h('span', { style: SECTION_TITLE_STYLE }, t('analytics.turnsLadder')),
        Object.entries(stats.turnsDistribution).map(([bracket, count]) => {
          const total = Math.max(1, sessions.length)
          const pct = Math.round((count / total) * 100)
          return h('div', { key: bracket, style: BAR_ROW_STYLE },
            h('span', { style: BAR_LABEL_STYLE }, LADDER_LABELS[bracket] || bracket),
            h('div', { style: BAR_TRACK_STYLE },
              h('div', {
                style: {
                  width: `${Math.max(pct, count > 0 ? 4 : 0)}%`,
                  height: '100%',
                  background: `var(--dsw-alias-state-business-primary, ${NORD.nord9})`,
                  borderRadius: 6,
                  transition: 'width 0.2s ease',
                },
              })),
            h('span', { style: { width: 60, textAlign: 'right', color: 'var(--dsw-alias-label-primary)' } }, countText(t('analytics.sessionsCount'), count)))
        }),
        h('div', { style: NOTE_STYLE }, t('analytics.turnsNote'))))
  }
}
