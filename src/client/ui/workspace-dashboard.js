/**
 * Workspace Dashboard view (v2.0):
 * Faithful realization of docs/mockup/punch_desk_mockup.html Dashboard sub-view.
 *
 * 1. 4 Workspace Vitals metric cards:
 *    - 活跃推进会话 (Active Sessions · Running / Completed)
 *    - 规范写回状态 (Spec write-back · 只读预览，重构中，不写回 AGENTS.md)
 *    - 头脑风暴草案 (Draft Reserves · Upcoming drafts)
 *    - 累计交互轮次 (Total Turns · Overall history)
 * 2. Recent & Active Sessions Stream (近期会话卡片流 · 2-column grid)
 *    - Title, updatedAt, status badge, description
 *    - Turns count & findings count
 *    - Action buttons: "规范复盘 (Diff)" & "进入会话 ->"
 * 3. Upcoming Drafts & Brainstorming Sprints (待开启草案储备 · 2-column grid)
 *    - Title, status badge, description preview
 *    - Action buttons: "编辑草案" & "发起会话"
 */

import { countText, createBits, formatLocalDateTime, formatLocalTime, suppressesRowToggle } from './bits.js'
import { draftDisplayTitle, draftVisibility } from '../../domain/desk.js'
import { DRAFT_STATUS_TONE, draftStatusText, draftVisibilityText } from './draft-editor.js'
import { NORD, getTagStyle, formatTagText, getSequenceTint } from './nord.js'

const CONTAINER_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 18,
  height: '100%',
  minHeight: 0,
  overflowY: 'auto',
  paddingRight: 6,
  boxSizing: 'border-box',
}

const METRICS_GRID_STYLE = {
  display: 'grid',
  gridTemplateColumns: 'repeat(4, 1fr)',
  gap: 12,
  flexShrink: 0,
}

const METRIC_CARD_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '14px 16px',
  borderRadius: 12,
  background: 'var(--pd-bg-card, var(--dsw-alias-bg-layer-1, #ffffff))',
  border: '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
}

const METRIC_LABEL_ROW = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  fontSize: 11,
  color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #434c5e))',
  fontFamily: 'monospace',
}

const METRIC_VALUE_STYLE = {
  fontSize: 22,
  fontWeight: 700,
  lineHeight: 1.2,
  color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #2e3440))',
}

const METRIC_SUBTEXT_STYLE = {
  fontSize: 10,
  color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
  fontFamily: 'monospace',
}

const SECTION_HEADER_STYLE = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  paddingBottom: 6,
  borderBottom: '1px solid var(--pd-border-subtle, var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08)))',
}

const SECTION_TITLE_ROW = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
}

const SECTION_TITLE_STYLE = {
  fontSize: 13,
  fontWeight: 700,
  color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #2e3440))',
}

const CARDS_GRID_STYLE = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
  gap: 12,
}

const SESSION_CARD_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'space-between',
  gap: 10,
  padding: '12px 14px',
  borderRadius: 12,
  background: 'var(--pd-bg-card, var(--dsw-alias-bg-layer-1, #ffffff))',
  border: '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
  transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
}

const DRAFT_CARD_STYLE = (idx = 0) => {
  const tint = getSequenceTint(idx)
  return {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    gap: 10,
    padding: '12px 14px',
    borderRadius: 12,
    background: tint.bg,
    border: `1px solid ${tint.border}`,
    borderTop: `3px solid ${tint.accent}`,
    transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
  }
}

const COMMIT_TRACE_ERROR_KEYS = {
  'no-pre-head': 'commitTrace.error.noPreHead',
  'no-post-head': 'commitTrace.error.noPostHead',
  'not-a-repo': 'commitTrace.error.notARepo',
  'range-failed': 'commitTrace.error.rangeFailed',
  'workspace-unresolved': 'commitTrace.error.workspaceUnresolved',
}

/**
 * Workspace-level group-turn metric subtext ("手账推进 N 轮").
 *
 * B3/L12: the metric is `charged + attributed` over the currently retained
 * per-session PromptLog/Trace window (see `summarizeSession`). Before that
 * switch the card rendered the legacy `group.turns` bookkeeping field, which
 * stopped being written and therefore always read as "手账推进 0 轮" — a number
 * that looked measured but could never be non-zero.
 *
 * An empty window now renders **no subtext at all** instead of a hard 0, so an
 * untouched workspace never claims "0 轮推进". The card's main value is the
 * session `交互轮次` (`contextTurns`, real prompt depth) and is untouched: it is
 * not a group-turn value and stays legitimate at 0 for an empty workspace.
 *
 * @param {number} totalGroupTurns summed `groupTurns` of the session cards
 * @param {(key: string) => string} t locale lookup
 * @returns {string|null} the subtext, or null when nothing is attributed yet
 */
export function groupTurnsMetricSubtext(totalGroupTurns, t) {
  const total = Number(totalGroupTurns)
  if (!Number.isFinite(total) || total <= 0) return null
  return countText(t('dashboard.metric.deskTurns'), total)
}

/**
 * Per-session "N 轮推进" subtext on a Recent Sessions card.
 *
 * Same empty-window rule as `groupTurnsMetricSubtext`: hide instead of printing
 * "0 轮推进" for a session whose retained PromptLog/Trace window attributes no
 * turn. The card's own session turn count comes from `contextTurns` and is
 * rendered by a separate segment, unaffected by this helper.
 *
 * @param {object} session a `summarizeSession()` row
 * @param {(key: string) => string} t locale lookup
 * @returns {string|null}
 */
export function sessionGroupTurnsSubtext(session, t) {
  const total = Number(session?.groupTurns ?? session?.deskTurns ?? 0)
  if (!Number.isFinite(total) || total <= 0) return null
  return countText(t('dashboard.sessionAdvanceTurns'), total)
}

/**
 * @param {{ h: Function, React: object, services: object }} deps
 * @returns {Function} the WorkspaceDashboard React component
 */
export function createWorkspaceDashboard({ h, React, services, DraftEditor }) {
  const { Button, Badge, Card, Empty, BookmarkSimple, GitDiff, GitBranch, Play, Plus, CheckCircle, CircleNotch, Circle, Prohibit, CaretDown, CaretRight, Folder, Clock, PencilSimple } = createBits(h)
  const t = services.t

  return function WorkspaceDashboard({
    sessions = [],
    drafts = [],
    selectedDraft = null,
    selectedDraftId = null,
    selectedSessionId = null,
    allFindings = [],
    allGroups = [],
    allCommitTraces = [],
    onSelectSession,
    workspaceRecord = null,
    sessionTitles = {},
    canOpenSession = false,
    workspaceId,
    startBehavior,
    onOpenSession,
    onReviewSession,
    onSelectDraft,
    onNewDraft,
    onEditInCanvas,
    onCreateDraft,
    onSaveDraft,
    onDeleteDraft,
    expandedFindingIds = new Set(),
    onToggleExpandFinding,
    collapsedSections: collapsedSectionsProp = {},
    onToggleSection,
  }) {
    const toggleExpandFinding = (id) => onToggleExpandFinding?.(id)

    // Long dashboards bury their own sections: every titled panel can collapse.
    // The state lives in DeskPage (this component is invoked as a plain function,
    // so a hook here would join DeskPage's hook sequence and break it whenever the
    // desk switches tabs — React #300). Dashboard stays a pure renderer.
    const collapsedSections = collapsedSectionsProp || {}
    const sectionCollapsed = key => Boolean(collapsedSections[key])
    const toggleSection = key => onToggleSection?.(key)
    /** Shared header affordance: icon-first collapse toggle with a11y state. */
    const renderSectionToggle = key => h(Button, {
      icon: sectionCollapsed(key) ? CaretRight : CaretDown,
      iconOnly: true,
      variant: 'ghost',
      'aria-expanded': !sectionCollapsed(key),
      title: t(sectionCollapsed(key) ? 'finding.expand' : 'finding.collapse'),
      'aria-label': t(sectionCollapsed(key) ? 'finding.expand' : 'finding.collapse'),
      onClick: () => toggleSection(key),
      style: { padding: 3 },
    })

    /**
     * One collapsible dashboard section header.
     *
     * Mirrors the Session Pane group header: the whole header row is the hit
     * target, so the title text, badges and the space beside them all fold the
     * section instead of the caret icon alone. Inner controls (the caret,
     * "new draft", links) keep their own click, and an active text selection
     * never collapses the section.
     * @param {string} key collapsed-section key
     * @param {object} titleRow leading icon + title + badges
     * @param {object} trailing right-side hint + controls
     * @returns {object} header row element
     */
    const renderSectionHeader = (key, titleRow, trailing) => h('div', {
      'data-dashboard-section': key,
      style: { ...SECTION_HEADER_STYLE, cursor: 'pointer' },
      onClick: event => {
        if (suppressesRowToggle(event)) return
        toggleSection(key)
      },
    }, titleRow, trailing)

    const groupMap = new Map()
    if (Array.isArray(allGroups)) {
      for (const g of allGroups) {
        if (g && g.id) groupMap.set(g.id, g)
      }
    }

    const focusedSessionId = selectedSessionId || sessions[0]?.sessionId
    const focusedSession = sessions.find(s => s.sessionId === focusedSessionId) || sessions[0] || null
    const focusedSessionFindings = allFindings
      .filter(f => f.sessionId === focusedSessionId)
      .sort((a, b) => {
        const timeA = new Date(a.submittedAt || a.updatedAt || a.createdAt || a.time || 0).getTime()
        const timeB = new Date(b.submittedAt || b.updatedAt || b.createdAt || b.time || 0).getTime()
        return timeB - timeA
      })
    const focusedTitle = focusedSession ? (sessionTitles[focusedSession.sessionId]?.title || focusedSession.sessionId) : ''

    const activeSessions = sessions.filter(s => s.findingCount > 0 || s.turns > 0)
    const completedSessions = sessions.filter(s => !s.findingCount && !s.turns)
    const draftReservesCount = drafts.length
    const totalContextTurns = sessions.reduce((acc, s) => acc + (s.contextTurns ?? s.turns ?? 0), 0)
    // Sum of each session's `groupTurns` (`charged + attributed` window, see
    // `summarizeSession`). The legacy `group.turns` bookkeeping field is no longer
    // aggregated anywhere: it stopped being written and always summed to 0.
    const totalGroupTurns = sessions.reduce((acc, s) => acc + (s.groupTurns ?? s.deskTurns ?? 0), 0)
    // B3/L12: an empty attribution window renders no subtext at all (instead of
    // "手账推进 0 轮"); the session `交互轮次` value above is a different metric.
    const deskTurnsSubtext = groupTurnsMetricSubtext(totalGroupTurns, t)

    const titleOf = session => {
      const id = session?.sessionId
      if (typeof id !== 'string') return ''
      const rec = sessionTitles[id]
      return rec && typeof rec === 'object' && typeof rec.title === 'string' ? rec.title : session.sessionId
    }

    return h('div', { style: CONTAINER_STYLE },
      // 1. Workspace Vitals Metric Cards (4 cards)
      h('div', { style: METRICS_GRID_STYLE },
        // Metric 1: 活跃推进会话
        h('div', { style: METRIC_CARD_STYLE },
          h('div', { style: METRIC_LABEL_ROW },
            h('span', null, t('dashboard.metric.activeSessions')),
            h('span', {
              style: {
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: `var(--dsw-alias-state-success-primary, ${NORD.nord14})`,
              },
            })),
          h('div', { style: METRIC_VALUE_STYLE },
            String(activeSessions.length),
            h('span', { style: { fontSize: 11, fontWeight: 'normal', color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))', marginLeft: 6 } }, t('dashboard.metric.running'))),
          h('span', { style: METRIC_SUBTEXT_STYLE }, countText(t('dashboard.metric.completedSessions'), completedSessions.length))),

        // Metric 2: 手账精炼 — 写回闭环已交付（Desk「手账精炼」Tab：选会话→提案→
        // 两级勾选确认→多文件 CAS 写回）。这里必须陈述真实能力，不能用
        // workspaceRecord 里陈旧的 specSyncStatus 冒充状态。
        h('div', { style: METRIC_CARD_STYLE },
          h('div', { style: METRIC_LABEL_ROW },
            h('span', null, t('dashboard.metric.specWriteback')),
            h(CheckCircle, { size: 14, color: NORD.nord14 })),
          h('div', {
            style: {
              ...METRIC_VALUE_STYLE,
              fontSize: 18,
              color: `var(--dsw-alias-state-success-primary, ${NORD.nord14})`,
            },
          }, t('dashboard.specWritebackReady')),
          h('span', { style: METRIC_SUBTEXT_STYLE }, t('dashboard.specWritebackReadyHint'))),

        // Metric 3: 头脑风暴草案
        h('div', { style: METRIC_CARD_STYLE },
          h('div', { style: METRIC_LABEL_ROW },
            h('span', null, t('dashboard.metric.draftReserves')),
            h('span', { style: { color: 'var(--pd-accent, var(--dsw-alias-button-primary-fill, #5e81ac))' } }, 'Drafts')),
          h('div', { style: METRIC_VALUE_STYLE },
            String(draftReservesCount),
            h('span', { style: { fontSize: 11, fontWeight: 'normal', color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))', marginLeft: 6 } }, t('dashboard.metric.draftReservesUnit'))),
          h('span', { style: METRIC_SUBTEXT_STYLE }, t('dashboard.metric.draftReservesHint'))),

        // Metric 4: 累计交互轮次
        h('div', { style: METRIC_CARD_STYLE },
          h('div', { style: METRIC_LABEL_ROW },
            h('span', null, t('dashboard.metric.totalTurns')),
            h('span', { style: { color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))' } }, 'Turns')),
          h('div', { style: METRIC_VALUE_STYLE },
            String(totalContextTurns),
            h('span', { style: { fontSize: 11, fontWeight: 'normal', color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))', marginLeft: 6 } }, t('dashboard.metric.totalTurnsUnit'))),
          // B3/L12: hide the subtext entirely while the window is empty, so no
          // card ever claims "手账推进 0 轮"; the main value stays session turns.
          deskTurnsSubtext === null ? null : h('span', {
            style: METRIC_SUBTEXT_STYLE,
            // Window caveat: the total is charged + attributed over the currently
            // retained per-session PromptLog/Trace rows, not a lifetime ledger.
            tip: t('group.turnsTip'),
          }, deskTurnsSubtext))),

      // 2. Recent Sessions Stream
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        renderSectionHeader('recent',
          h('div', { style: SECTION_TITLE_ROW },
            h(Clock, { size: 14, color: 'var(--pd-accent, var(--dsw-alias-button-primary-fill, #5e81ac))' }),
            h('span', { style: SECTION_TITLE_STYLE }, t('dashboard.recentSessions')),
            h(Badge, { tone: 'info' }, countText(t('dashboard.recentSessionsCount'), sessions.length))),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h('span', { style: { fontSize: 11, color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))' } }, t('dashboard.sortedByRecentActivity')),
            renderSectionToggle('recent'))),

        sectionCollapsed('recent') ? null : sessions.length === 0
          ? h('div', {
              style: {
                padding: '32px 16px',
                borderRadius: 14,
                border: '1px dashed var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
                textAlign: 'center',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 8,
              },
            },
            h('span', { style: { fontSize: 12, color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #434c5e))' } }, t('dashboard.noSessions')),
            h('p', { style: { fontSize: 11, color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))', margin: 0 } },
              t('dashboard.noSessionsHint')),
            h(Button, {
              variant: 'primary',
              icon: Plus,
              onClick: onNewDraft,
              style: { marginTop: 6, fontSize: 12 },
            }, t('dashboard.startFirstSession')))
          : h('div', { style: CARDS_GRID_STYLE },
              sessions.map(session => {
                const label = titleOf(session)
                const turns = session.turns || session.promptCount || 1
                // B3/L12: hide the group-turn segment for an empty window instead
                // of printing "0 轮推进"; session turns render in their own segment.
                const groupTurnsText = sessionGroupTurnsSubtext(session, t)
                const isFocused = focusedSessionId === session.sessionId
                return h('div', {
                  key: session.sessionId,
                  style: {
                    ...SESSION_CARD_STYLE,
                    border: isFocused
                      ? 'var(--pd-card-focused-border, 1.5px solid #88c0d0)'
                      : '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
                    boxShadow: isFocused
                      ? 'var(--pd-card-focused-shadow, 0 0 16px rgba(136, 192, 208, 0.45), 0 0 2px #88c0d0)'
                      : 'none',
                    background: isFocused
                      ? 'var(--pd-card-focused-bg, linear-gradient(135deg, rgba(136, 192, 208, 0.20) 0%, rgba(94, 129, 172, 0.14) 50%, rgba(180, 142, 173, 0.22) 100%))'
                      : 'var(--pd-bg-card, var(--dsw-alias-bg-layer-1, #ffffff))',
                    transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
                  },
                },
                  h('div', {
                    onClick: () => onSelectSession?.(session.sessionId),
                    style: { display: 'flex', flexDirection: 'column', gap: 6, cursor: 'pointer' },
                  },
                    h('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 6 } },
                      h('div', { style: { display: 'flex', alignItems: 'center', gap: 7 } },
                        h('span', {
                          style: {
                            width: 7,
                            height: 7,
                            borderRadius: '50%',
                            background: isFocused ? 'var(--pd-card-focused-title, #88c0d0)' : 'var(--pd-border-default, #4c566a)',
                            boxShadow: isFocused ? 'var(--pd-card-focused-shadow, 0 0 8px #88c0d0)' : 'none',
                            flexShrink: 0,
                          },
                        }),
                        h('div', null,
                          h('h4', {
                            style: {
                              margin: 0,
                              fontSize: 13,
                              fontWeight: 700,
                              color: isFocused ? 'var(--pd-card-focused-title, #88c0d0)' : 'var(--pd-text-primary, var(--dsw-alias-label-primary, #2e3440))',
                              textShadow: isFocused ? 'var(--pd-card-focused-title-shadow, none)' : 'none',
                            },
                          }, label),
                          h('span', { style: { fontSize: 10, color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))' } },
                            session.updatedAt ? t('dashboard.activeAt').replace('{time}', new Date(session.updatedAt).toLocaleTimeString()) : t('dashboard.activeJustNow')))),
                      h(Badge, { tone: isFocused ? 'info' : 'neutral', style: { fontSize: 10 } }, isFocused ? t('dashboard.focused') : t('dashboard.inProgress'))),
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #434c5e))', marginTop: 4, flexWrap: 'wrap' } },
                      h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
                        h('span', { style: { width: 6, height: 6, borderRadius: '50%', background: '#81a1c1', flexShrink: 0 } }),
                        countText(t('dashboard.sessionTurns'), session.contextTurns ?? session.turns ?? 0)),
                      groupTurnsText === null ? null : h('span', { style: { color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))' } }, '·'),
                      groupTurnsText === null ? null : h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
                        h('span', { style: { width: 6, height: 6, borderRadius: '50%', background: '#a3be8c', flexShrink: 0 } }),
                        h('span', { tip: t('group.turnsTip') }, groupTurnsText)),
                      h('span', { style: { color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))' } }, '·'),
                      h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
                        h('span', { style: { width: 6, height: 6, borderRadius: '50%', background: '#ebcb8b', flexShrink: 0 } }),
                        countText(t('desk.session.findings'), session.findingCount)))),
                  h('div', {
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 6,
                      paddingTop: 8,
                      borderTop: '1px solid var(--pd-border-subtle, var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08)))',
                    },
                  },
                    h(Button, {
                      icon: GitDiff,
                      title: t('dashboard.reviewDiff'),
                      onClick: () => onReviewSession?.(session.sessionId),
                      style: { fontSize: 11, padding: '3px 8px', color: 'var(--pd-accent, #5e81ac)' },
                    }, t('dashboard.reviewDiff')),
                    canOpenSession
                      ? h(Button, {
                          variant: 'primary',
                          icon: Play,
                          title: t('dashboard.enterSession'),
                          onClick: (e) => {
                            if (e && typeof e.stopPropagation === 'function') e.stopPropagation()
                            onOpenSession?.(session.sessionId)
                          },
                          style: {
                            fontSize: 11,
                            padding: '3px 10px',
                            fontWeight: 700,
                            background: 'var(--pd-accent, #5e81ac)',
                            color: 'var(--pd-accent-fg, #ffffff)',
                            border: '1px solid var(--pd-accent, #5e81ac)',
                          },
                        }, t('dashboard.enterSession'))
                      : null))
              }))),

      // 2.5 Focused Session Findings Explorer (all findings including archived/completed)
      focusedSession
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4 } },
            renderSectionHeader('findings',
              h('div', { style: SECTION_TITLE_ROW },
                h(BookmarkSimple, { size: 14, color: 'var(--pd-accent, var(--dsw-alias-button-primary-fill, #5e81ac))' }),
                h('span', { style: SECTION_TITLE_STYLE }, t('dashboard.findingsDetailTitle').replace('{title}', focusedTitle)),
                h(Badge, { tone: focusedSessionFindings.length > 0 ? 'info' : 'neutral' }, countText(t('desk.session.findings'), focusedSessionFindings.length)),
                focusedSessionFindings.some(f => {
                  const grp = f.assignedGroupId ? groupMap.get(f.assignedGroupId) : null
                  return Boolean(grp?.pinned || f.pinned)
                })
                  ? h(Badge, {
                      tone: 'warn',
                      icon: BookmarkSimple,
                      tip: t('dashboard.containsPinnedHint'),
                      style: { fontSize: 9, padding: '1px 6px', fontWeight: 600 },
                    }, t('dashboard.containsPinned'))
                  : null),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                h('span', { style: { fontSize: 11, color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))' } },
                  t('dashboard.findingsListHint')),
                renderSectionToggle('findings'))),
            sectionCollapsed('findings') ? null : focusedSessionFindings.length === 0
              ? h('div', {
                  style: {
                    padding: '20px 16px',
                    borderRadius: 10,
                    border: '1px dashed var(--pd-border-default, var(--dsw-alias-border-l2, #d8dee9))',
                    textAlign: 'center',
                    color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
                    fontSize: 11,
                  },
                }, t('dashboard.noFindings'))
              : h('div', {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    borderRadius: 10,
                    background: 'var(--pd-bg-card, var(--dsw-alias-bg-layer-1, #ffffff))',
                    border: '1px solid var(--pd-border-default, rgba(136, 192, 208, 0.35))',
                    boxShadow: '0 2px 8px var(--pd-border-subtle, rgba(0, 0, 0, 0.04))',
                    overflow: 'hidden',
                  },
                },
                focusedSessionFindings.map((finding, idx) => {
                  const isExp = expandedFindingIds.has(finding.id)
                  const isLast = idx === focusedSessionFindings.length - 1
                  const isDone = finding.status === 'completed' || finding.reviewStatus === 'resolved'
                  const isDismissed = finding.reviewStatus === 'dismissed'
                  const isUnsubmitted = (finding.submissionStatus === 'unsubmitted' || finding.status === 'open') && !finding.assignedGroupId && !finding.submittedAt
                  const statusTone = isDone ? 'success' : (isDismissed ? 'neutral' : (isUnsubmitted ? 'info' : 'warn'))
                  const statusIcon = isDone ? CheckCircle : (isDismissed ? Prohibit : (isUnsubmitted ? Circle : CircleNotch))
                  const statusLabel = isDone ? t('status.completed') : (isDismissed ? t('list.dismissed') : (isUnsubmitted ? t('list.open') : t('group.status.executing')))
                  const tagStyle = getTagStyle(finding.severity)
                  const tagText = formatTagText(finding.severity, t)

                  let timeLabel = t('dashboard.time.recorded')
                  let timeVal = finding.createdAt || finding.time
                  if (isDone) {
                    timeLabel = t('dashboard.time.completed')
                    timeVal = finding.resolvedAt || finding.submittedAt || finding.updatedAt || timeVal
                  } else if (isDismissed) {
                    timeLabel = t('dashboard.time.dismissed')
                    timeVal = finding.resolvedAt || finding.updatedAt || timeVal
                  } else if (!isUnsubmitted || finding.submittedAt || finding.submissionStatus === 'submitted' || finding.assignedGroupId) {
                    timeLabel = t('dashboard.time.submitted')
                    timeVal = finding.submittedAt || finding.updatedAt || timeVal
                  }

                  let timeDisplay = ''
                  if (timeVal) {
                    const d = new Date(timeVal)
                    if (!isNaN(d.getTime())) {
                      timeDisplay = formatLocalTime(d.getTime())
                    }
                  }

                  const assignedGroup = finding.assignedGroupId ? groupMap.get(finding.assignedGroupId) : null
                  const findingTraces = allCommitTraces.filter(trace =>
                    Array.isArray(trace?.findingIds) && trace.findingIds.includes(finding.id)
                  )
                  const findingCommitCount = new Set(findingTraces.flatMap(trace =>
                    Array.isArray(trace?.commits) ? trace.commits.map(commit => commit?.hash).filter(Boolean) : []
                  )).size
                  const groupNum = assignedGroup?.groupNumber
                  const isPinned = Boolean(assignedGroup?.pinned || finding.pinned)
                  let groupLabel = null
                  if (groupNum) {
                    groupLabel = `Group ${groupNum}`
                  } else if (finding.assignedGroupId) {
                    groupLabel = finding.assignedGroupId.startsWith('group-')
                      ? 'G' + finding.assignedGroupId.replace('group-', '')
                      : t('dashboard.advanceGroup')
                  }

                  return h('div', {
                    key: finding.id,
                    // Whole row toggles the detail so the hit area is equally
                    // wide collapsed and expanded; inner controls and text
                    // selections are ignored.
                    onClick: (event) => {
                      if (suppressesRowToggle(event)) return
                      toggleExpandFinding(finding.id)
                    },
                    style: {
                      padding: '10px 14px',
                      borderBottom: isLast ? 'none' : '1px solid var(--pd-border-subtle, var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08)))',
                      borderLeft: `3.5px solid ${tagStyle.borderColor}`,
                      background: isExp ? 'var(--pd-bg-panel, var(--dsw-alias-bg-layer-2, #e5e9f0))' : 'transparent',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                      cursor: 'pointer',
                      transition: 'background 0.15s ease',
                    },
                  },
                    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
                      h('div', {
                        style: { display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 },
                      },
                        h(isExp ? CaretDown : CaretRight, { size: 12, color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))' }),
                        h('span', { style: { fontSize: 11, fontFamily: 'monospace', fontWeight: 700, color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #434c5e))' } },
                          `#${finding.thoughtNo || (idx + 1)}`),
                        h('span', {
                          style: {
                            padding: '2px 8px',
                            borderRadius: 6,
                            fontSize: 10,
                            fontFamily: 'monospace',
                            fontWeight: 600,
                            lineHeight: '14px',
                            display: 'inline-flex',
                            alignItems: 'center',
                            color: tagStyle.color,
                            background: tagStyle.background,
                            border: `1px solid ${tagStyle.borderColor}`,
                            flexShrink: 0,
                          },
                        }, tagText),
                        !isExp
                          ? h('span', {
                              style: {
                                fontSize: 12,
                                fontWeight: 500,
                                color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #2e3440))',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                flex: 1,
                              },
                            }, finding.title || finding.text || finding.body || '')
                          : null),
                      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 } },
                        timeDisplay
                          ? h('span', { style: { fontSize: 10, color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))', fontFamily: 'monospace' } },
                              `${timeLabel} ${timeDisplay}`)
                          : null,
                        groupLabel
                          ? h(Badge, {
                              tone: 'info',
                              style: { fontSize: 9, padding: '1px 5px', fontFamily: 'monospace' },
                              tip: t('dashboard.groupBatchTitle').replace('{group}', groupLabel),
                            }, groupLabel)
                          : null,
                        isPinned
                          ? h(Badge, {
                              tone: 'warn',
                              icon: BookmarkSimple,
                              style: { fontSize: 9, padding: '1px 6px', fontWeight: 600 },
                              tip: t('dashboard.pinnedHint'),
                            }, t('dashboard.pinnedBadge'))
                          : null,
                        findingTraces.length > 0
                          ? h(Badge, {
                              tone: 'info',
                              icon: GitBranch,
                              style: { fontSize: 9, padding: '1px 5px', fontFamily: 'monospace' },
                              tip: t('dashboard.findingCommitTraces').replace('{count}', String(findingTraces.length)),
                            }, t('dashboard.findingCommitBadge').replace('{count}', String(findingCommitCount)))
                          : null,
                        h(Badge, { tone: statusTone, icon: statusIcon, style: { fontSize: 9, padding: '1px 6px', fontWeight: 600 } }, statusLabel))),
                    isExp
                      ? h('div', {
                          style: {
                            fontSize: 12,
                            lineHeight: 1.6,
                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                            overflowWrap: 'anywhere',
                            color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #2e3440))',
                            background: 'var(--pd-bg-card, var(--dsw-alias-bg-layer-1, #ffffff))',
                            padding: '10px 12px',
                            borderRadius: 6,
                            border: '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
                            marginTop: 4,
                          },
                        }, finding.text || finding.body || finding.title || '')
                      : null,
                    isExp && findingTraces.length > 0
                      ? h('div', {
                          style: {
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 6,
                            marginTop: 2,
                            padding: '8px 10px',
                            borderLeft: `2px solid ${NORD.nord8}`,
                            background: 'var(--pd-bg-card, var(--dsw-alias-bg-layer-1, #ffffff))',
                          },
                        },
                          h('div', { style: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 600, color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #434c5e))' } },
                            h(GitBranch, { size: 12, color: NORD.nord10 }),
                            t('dashboard.findingCommitTraces').replace('{count}', String(findingTraces.length))),
                          findingTraces.map((trace, traceIdx) =>
                            h('div', {
                              key: trace.id || `${finding.id}:${traceIdx}`,
                              style: { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 10 },
                            },
                              h('span', { style: { color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))' } },
                                t('dashboard.findingCommitTraceTurn').replace('{turn}', String(trace.turn ?? '—'))),
                              trace.status === 'failed'
                                ? h('span', { style: { color: `var(--dsw-alias-state-warn-primary, ${NORD.nord12})` } },
                                    t('dashboard.findingCommitTraceFailed').replace(
                                      '{reason}',
                                      COMMIT_TRACE_ERROR_KEYS[trace.error]
                                        ? t(COMMIT_TRACE_ERROR_KEYS[trace.error])
                                        : String(trace.error || 'unknown'),
                                    ))
                                : (Array.isArray(trace.commits) && trace.commits.length > 0
                                    ? trace.commits.map((commit, commitIdx) => {
                                        const hash = commit.shortHash || String(commit.hash || '').slice(0, 7)
                                        const fullTime = formatLocalDateTime(commit.time)
                                        return h('div', {
                                          key: commit.hash || commitIdx,
                                          'data-commit-hash': commit.hash || hash,
                                          style: { display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 },
                                        },
                                          h('code', { style: { flexShrink: 0, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: 'var(--pd-accent, var(--dsw-alias-button-primary-fill, #5e81ac))' } }, hash),
                                          h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #2e3440))' } }, commit.subject || ''),
                                          fullTime
                                            ? h('time', { title: fullTime, style: { flexShrink: 0, marginLeft: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))' } }, formatLocalTime(commit.time))
                                            : null)
                                      })
                                    : h('span', { style: { color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))' } }, t('dashboard.findingCommitTraceEmpty'))),
                              trace.truncated
                                ? h('span', { style: { color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))' } }, t('finding.commitTrace.truncatedHint'))
                                : null)))
                      : null)
                })))
        : null,

      // 3. Upcoming Drafts Section
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        renderSectionHeader('drafts',
          h('div', { style: SECTION_TITLE_ROW },
            h(PencilSimple, { size: 14, color: 'var(--pd-accent, var(--dsw-alias-button-primary-fill, #5e81ac))' }),
            h('span', { style: SECTION_TITLE_STYLE }, t('dashboard.upcomingDrafts')),
            h(Badge, { tone: 'neutral' }, countText(t('dashboard.draftsCount'), drafts.length))),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            renderSectionToggle('drafts'),
            h(Button, {
              icon: Plus,
              onClick: onNewDraft,
              style: { padding: '2px 8px', fontSize: 11 },
            }, t('dashboard.newDraft')))),

        sectionCollapsed('drafts') ? null : drafts.length === 0
          ? h('div', {
              style: {
                padding: '24px 16px',
                borderRadius: 12,
                border: '1px dashed var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
                textAlign: 'center',
                color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
                fontSize: 11,
              },
            }, t('dashboard.noUpcomingDraftsHint'))
          : h('div', { style: CARDS_GRID_STYLE },
              drafts.map((draft, idx) => {
                const tint = getSequenceTint(idx)
                const label = draftDisplayTitle(draft, t('desk.draft.untitled'))
                return h('div', { key: draft.id, style: DRAFT_CARD_STYLE(idx) },
                  h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                    h('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 6 } },
                      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 } },
                        h('span', {
                          style: {
                            fontSize: 10,
                            fontFamily: 'monospace',
                            fontWeight: 700,
                            color: tint.accent,
                            padding: '1px 5px',
                            borderRadius: 4,
                            background: 'rgba(0, 0, 0, 0.05)',
                            border: `1px solid ${tint.border}`,
                            flexShrink: 0,
                          },
                        }, `#${idx + 1}`),
                        h('h4', {
                          style: {
                            margin: 0,
                            fontSize: 13,
                            fontWeight: 700,
                            color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #2e3440))',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          },
                        }, label)),
                      h(Badge, {
                        tone: draftVisibility(draft) === 'workspace' ? 'info' : 'neutral',
                        icon: draftVisibility(draft) === 'workspace' ? Folder : undefined,
                        title: draftVisibilityText(draftVisibility(draft), t),
                        style: { fontSize: 10 },
                      }, draftVisibilityText(draftVisibility(draft), t)),
                      h(Badge, { tone: DRAFT_STATUS_TONE[draft.status] ?? 'neutral', style: { fontSize: 10 } },
                        draftStatusText(draft.status, t))),
                    h('p', {
                      style: {
                        margin: 0,
                        fontSize: 11,
                        color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #434c5e))',
                        lineHeight: 1.4,
                        overflow: 'hidden',
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                      },
                    }, (draft.body || '').split('\n').filter(Boolean).slice(0, 2).join(' ') || t('dashboard.draftEmptyBody'))),
                  h('div', {
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'flex-end',
                      gap: 6,
                      paddingTop: 8,
                      borderTop: '1px solid var(--pd-border-subtle, var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08)))',
                    },
                  },
                    h(Button, {
                      variant: 'default',
                      icon: BookmarkSimple,
                      onClick: () => onEditInCanvas?.(draft.id),
                      style: { fontSize: 11, padding: '3px 8px' },
                    }, t('dashboard.editDraft')),
                    h(Button, {
                      variant: 'primary',
                      icon: Play,
                      onClick: () => onSelectDraft?.(draft.id),
                      style: { fontSize: 11, padding: '3px 8px' },
                    }, t('dashboard.startDraftSession')))
                )
              }))
      )
    )
  }
}
