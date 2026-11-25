/**
 * Desk main panel (v2.0):
 * Workspace workbench with 4 sub-views:
 * 1. 项目大盘 (dashboard · WordPress-style project overview)
 * 2. 架构草案画布 (canvas / drafts · Spec Canvas)
 * 3. 手账精炼 (reviews · Finding Distillation, replaces the retired Retrospective & Rules Diff)
 * 4. 工程统计 (analytics · Engineering & Spec Analytics)
 *
 * Left sidebar (260px):
 * - Workspace switcher (reads store workspace records and host workspaces)
 * - Drafts list with status badges + New draft
 * - Sessions list with recency, turn counts, finding counts
 * - Bottom status bar with Git branch and AGENTS.md sync indicator
 */

import {
  DRAFTS_WORKSPACE_KEY, WORKSPACE_DRAFT_VISIBILITY,
  draftDisplayTitle, draftVisibility, filterDrafts, filterDraftsForWorkspace,
  isSessionCardVisible,
  resolveWorkspaceSessionIds, sessionIdsFromWorkspaceKeys, sessionWorkspaceKey,
  sortSessionSummaries, summarizeSession,
} from '../../domain/desk.js'
import { activeWorkspaceIdOf } from '../platform/session-start.js'
import { getActiveRun } from '../../domain/distill-run.js'
import { DEFAULT_PREFS, prefsOf } from '../prefs.js'
import { countText, createBits, formatLocalDateTime, suppressesRowToggle } from './bits.js'
import { createClearDataModal } from './clear-data-modal.js'
import { DRAFT_STATUS_TONE, createDraftEditor, draftStatusText, draftVisibilityText } from './draft-editor.js'
import { createWorkspaceDashboard } from './workspace-dashboard.js'
import { createDistillView } from './distill-view.js'
import { createDistillConfirm } from './distill-confirm.js'
import { createAnalyticsView } from './analytics-view.js'
import { createSettingsView } from './settings-view.js'
import { injectPunchDeskStyles, getSequenceTint } from './nord.js'
import { downloadText } from './export.js'

/** Sentinel selection for a not-yet-created draft. */
const NEW_DRAFT = '__new-draft__'
/** Stable empty snapshot so a missing `useSessions` hook never re-renders in a loop. */
const EMPTY_TITLES = {}
/**
 * Global distillation indicator poll. Deliberately cheap and fail-open: the
 * desk only needs `{status, stage}` to show a banner and a breathing dot, so a
 * failed poll must never blank out a run the user is waiting on.
 */
const DISTILL_BANNER_POLL_MS = 5000
/** Run stage → locale key. Mirrors the labels DistillView uses, so the banner
 *  and the running page never describe the same stage with two different words. */
const DISTILL_STAGE_LABEL_KEYS = {
  snapshotting: 'distill.view.stage.snapshotting',
  stage1: 'distill.view.stage.stage1',
  stage2: 'distill.view.stage.stage2',
  validating: 'distill.view.stage.validating',
}
/** Identity selector: the desk only needs the session map, not a derived value. */
const selectSessions = state => state

const TABS = [
  { id: 'dashboard', labelKey: 'desk.tab.dashboard', iconName: 'Gauge' },
  { id: 'canvas', labelKey: 'desk.tab.canvas', iconName: 'Brain' },
  { id: 'reviews', labelKey: 'desk.tab.reviews', iconName: 'GitDiff' },
  { id: 'analytics', labelKey: 'desk.tab.analytics', iconName: 'ChartBar' },
]

const PAGE_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  height: '100%',
  minHeight: 0,
  boxSizing: 'border-box',
  padding: 12,
  color: 'var(--dsw-alias-label-primary)',
}

const BODY_STYLE = {
  display: 'flex',
  alignItems: 'stretch',
  gap: 12,
  flex: 1,
  minHeight: 0,
}

const LEFT_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  // Width adapts to the window: never wider than 260, never narrower than
  // 180, so the right pane keeps enough room to edit its controls.
  flex: '0 0 clamp(180px, 26vw, 260px)',
  minWidth: 180,
  minHeight: 0,
  background: 'var(--pd-bg-card, var(--dsw-alias-bg-layer-1, #ffffff))',
  border: '1px solid var(--pd-border-subtle, var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08)))',
  borderRadius: 12,
  padding: 10,
  boxSizing: 'border-box',
}

const LEFT_SCROLL_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  paddingRight: 2,
}

const LEFT_FOOTER_STYLE = {
  display: 'flex',
  alignItems: 'center',
  paddingTop: 8,
  borderTop: '1px solid var(--pd-border-subtle, var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08)))',
  flexShrink: 0,
}

const RIGHT_STYLE = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--pd-bg-base, var(--dsw-alias-bg-base, #ffffff))',
  border: '1px solid var(--pd-border-subtle, var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08)))',
  borderRadius: 12,
  padding: 12,
  overflowY: 'auto',
  boxSizing: 'border-box',
}

const WORKSPACE_SELECT_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  paddingBottom: 8,
  borderBottom: '1px solid var(--pd-border-subtle, var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08)))',
}

const SELECT_FIELD_STYLE = {
  flex: 1,
  minWidth: 0,
  padding: '4px 6px',
  borderRadius: 6,
  fontFamily: 'inherit',
  fontSize: 12,
  color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #2e3440))',
  background: 'var(--pd-bg-card, var(--dsw-alias-bg-layer-1, #ffffff))',
  border: '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
}

const SECTION_HEADER_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  paddingTop: 2,
}

const SECTION_LABEL_STYLE = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--dsw-alias-label-secondary)',
}

const SECTION_COUNT_STYLE = {
  flex: 1,
  fontSize: 11,
  color: 'var(--dsw-alias-label-tertiary)',
}

const WARNING_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '8px 10px',
  borderRadius: 6,
  background: 'var(--dsw-alias-bg-layer-2)',
  border: '1px solid var(--dsw-alias-border-l1)',
}

const WARNING_TEXT_STYLE = {
  fontSize: 12,
  lineHeight: 1.45,
  color: 'var(--dsw-alias-state-warn-primary)',
}

const CARD_LIST_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

/**
 * @param {{ h: Function, React: object, services: object }} deps
 * @returns {Function} the DeskPage React component
 */
export function createDeskPage({ h, React, services }) {
  const { Button, Badge, Card, Empty, icons, BookmarkSimple, Trash } = createBits(h)
  const DraftEditor = createDraftEditor({ h, React, services })
  const WorkspaceDashboard = createWorkspaceDashboard({ h, React, services, DraftEditor })
  const AnalyticsView = createAnalyticsView({ h, React, services })
  const SettingsView = createSettingsView({ h, React, services })
  const t = services.t
  // Task 3.1: the reviews tab hosts the distillation state machine.
  // services.loadDistillSource must return synchronously, but the batch source
  // (sessions / findings / promptLogs / archived ids) is render-time Desk
  // state, so a mutable box is refreshed on every DeskPage render and read
  // through this closure.
  const distillSourceBox = { current: null }
  // Task 3.2: the confirmation page of the distillation flow. One instance
  // feeds two slots: DistillView renders it in the pending phase (injected
  // through createConfirmComponent), and its ResultContent is forwarded to
  // the result phase through the renderSummary slot below.
  const DistillConfirm = createDistillConfirm({ h, React, services, t })
  const DistillView = createDistillView({
    h,
    React,
    services: {
      ...services,
      loadDistillSource: () => distillSourceBox.current
        ?? { sessions: [], findings: [], promptLogs: [], archivedSessionIds: [] },
    },
    t,
    createConfirmComponent: () => DistillConfirm,
  })

  function SessionsBridge({ useSessions, onChange, onSessionsMap }) {
    let snapshot
    try {
      snapshot = typeof useSessions === 'function' ? (useSessions(selectSessions) || useSessions()) : useSessions
    } catch {
      try {
        snapshot = useSessions()
      } catch {
        snapshot = null
      }
    }
    React.useEffect(() => {
      if (!snapshot) return
      if (onChange) onChange(snapshot)
      if (snapshot && typeof snapshot.byId === 'object' && onSessionsMap) {
        onSessionsMap(snapshot.byId)
      }
    }, [snapshot, onChange, onSessionsMap])
    return null
  }

  function WorkspacesBridge({ useWorkspaces, onActiveChange, onItemsChange, onArchivedChange }) {
    let snapshot
    try {
      snapshot = typeof useWorkspaces === 'function' ? (useWorkspaces(s => s) || useWorkspaces()) : useWorkspaces
    } catch {
      try {
        snapshot = useWorkspaces()
      } catch {
        snapshot = null
      }
    }
    React.useEffect(() => {
      if (!snapshot) return
      const activeId = activeWorkspaceIdOf(snapshot) || snapshot.activeId || snapshot.currentId
      if (activeId && onActiveChange) onActiveChange(activeId)
      const rawList = Array.isArray(snapshot.items)
        ? snapshot.items
        : (snapshot.byId && typeof snapshot.byId === 'object' ? Object.values(snapshot.byId) : [])
      const items = rawList.map(it => ({
        id: it.workspaceId || it.id,
        name: it.name || it.workspaceId || it.id,
        path: it.path || '',
        sessionIds: Array.isArray(it.sessionIds) ? it.sessionIds : [],
      })).filter(it => Boolean(it.id))
      if (items.length > 0 && onItemsChange) {
        onItemsChange(items)
      }
      // The archive set is registry-global and host-owned. Older snapshots may
      // omit it, which simply means "no archived Session" (the pre-existing
      // behavior); never assume the field exists.
      if (onArchivedChange) {
        const archived = Array.isArray(snapshot.archivedSessionIds)
          ? snapshot.archivedSessionIds.filter(id => typeof id === 'string' && id !== '')
          : []
        onArchivedChange(archived)
      }
    }, [snapshot, onActiveChange, onItemsChange, onArchivedChange])
    return null
  }

  return function DeskPage(props = {}) {
    const [refreshTick, setRefreshTick] = React.useState(0)
    const [tab, setTab] = React.useState(props.defaultTab ?? 'dashboard')
    const [previousTab, setPreviousTab] = React.useState(props.defaultTab ?? 'dashboard')
    const [drafts, setDrafts] = React.useState([])
    const [sessions, setSessions] = React.useState([])
    const [allFindings, setAllFindings] = React.useState([])
    const [allPromptLogs, setAllPromptLogs] = React.useState([])
    const [allGroups, setAllGroups] = React.useState([])
    const [allCommitTraces, setAllCommitTraces] = React.useState([])
    const [workspaceRecords, setWorkspaceRecords] = React.useState([])
    const [hostWorkspaces, setHostWorkspaces] = React.useState([])
    const [hostSessionsMap, setHostSessionsMap] = React.useState({})
    // Harness registry-global archived Session ids (read-only projection).
    const [archivedSessionIds, setArchivedSessionIds] = React.useState([])
    const [archivedOpenActionsCount, setArchivedOpenActionsCount] = React.useState(0)
    const [selectedWorkspaceId, setSelectedWorkspaceId] = React.useState(null)
    const archivedSessionIdSet = React.useMemo(() => new Set(archivedSessionIds), [archivedSessionIds])
    const [selectedDraftId, setSelectedDraftId] = React.useState(null)
    const [selectedSessionId, setSelectedSessionId] = React.useState(null)
    const [sessionTitles, setSessionTitles] = React.useState(EMPTY_TITLES)
    const [sessionUpdatedAt, setSessionUpdatedAt] = React.useState(EMPTY_TITLES)
    const [workspaceId, setWorkspaceId] = React.useState(undefined)
    const [prefs, setPrefs] = React.useState(DEFAULT_PREFS)
    const startBehavior = prefs.startSessionBehavior
    const [workspaceNotice, setWorkspaceNotice] = React.useState(null)
    const [canOpenSession, setCanOpenSession] = React.useState(false)
    const [quotaWarning, setQuotaWarning] = React.useState(false)
    const [loaded, setLoaded] = React.useState(false)
    const [isClearModalOpen, setIsClearModalOpen] = React.useState(false)
    // Data transfer (P3-4): export writes a JSON backup, import supports merge /
    // replace (replace takes a host-side backup before rebuilding storage).
    const [pendingImport, setPendingImport] = React.useState(null)
    const [dataNotice, setDataNotice] = React.useState(null)
    const [dataBusy, setDataBusy] = React.useState(false)
    const dataFileInputRef = React.useRef(null)
    const [clearOptions, setClearOptions] = React.useState({
      clearFindings: true,
      clearGroups: true,
      clearPromptLogs: true,
      clearDrafts: false,
      preservePinned: true,
    })
    const [clearing, setClearing] = React.useState(false)
    const [clearNotice, setClearNotice] = React.useState(null)
    const [dashboardExpandedFindingIds, setDashboardExpandedFindingIds] = React.useState(() => new Set())
    const [detectedGitBranch, setDetectedGitBranch] = React.useState('')
    const [isGitLookupOpen, setIsGitLookupOpen] = React.useState(false)
    const [gitLookupQuery, setGitLookupQuery] = React.useState('')
    const gitLookupQueryRef = React.useRef('')
    const [gitLookupMatches, setGitLookupMatches] = React.useState([])
    const [gitLookupError, setGitLookupError] = React.useState(null)
    const [gitLookupSearched, setGitLookupSearched] = React.useState(false)
    const [gitLookupBusy, setGitLookupBusy] = React.useState(false)
    const gitLookupInputRef = React.useRef(null)
    const generation = React.useRef(0)

    const toggleDashboardExpandFinding = React.useCallback((id) => {
      setDashboardExpandedFindingIds(prev => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    }, [])

    const applyTitles = React.useCallback(snapshot => {
      const byId = snapshot !== null && typeof snapshot === 'object' ? snapshot.byId : undefined
      const next = byId !== null && typeof byId === 'object' ? byId : EMPTY_TITLES
      setSessionTitles(previous => (previous === next ? previous : next))
      const updatedAt = {}
      for (const [id, record] of Object.entries(next)) {
        const value = record !== null && typeof record === 'object' ? record.updatedAt : undefined
        if (typeof value === 'number' && Number.isFinite(value)) updatedAt[id] = value
      }
      setSessionUpdatedAt(updatedAt)
    }, [])

    React.useEffect(() => {
      let alive = true
      const loadPrefs = async () => {
        if (typeof services.store?.getPrefs !== 'function') return
        try {
          const raw = await services.store.getPrefs()
          if (alive) setPrefs(prefsOf(raw))
        } catch {
          // Keep default
        }
      }
      void loadPrefs()
      return () => { alive = false }
    }, [refreshTick])

    // Main store loader
    React.useEffect(() => {
      let alive = true
      const sessionCache = new Map()
      let draftCache = null

      const revisionOf = typeof services.store.revision === 'function'
        ? workspaceKey => {
            try {
              const value = services.store.revision(workspaceKey)
              return typeof value === 'number' && Number.isFinite(value) ? value : undefined
            } catch {
              return undefined
            }
          }
        : null

      const load = async () => {
        const run = ++generation.current
        try {
          const [workspaceKeys, records] = await Promise.all([
            typeof services.store.listWorkspaces === 'function' ? services.store.listWorkspaces() : [],
            typeof services.store.listWorkspaceRecords === 'function' ? services.store.listWorkspaceRecords() : [],
          ])
          if (!alive || run !== generation.current) return
          setWorkspaceRecords(records)

          const ids = sessionIdsFromWorkspaceKeys(workspaceKeys)
          const keys = ids.map(sessionWorkspaceKey)

          const draftRev = revisionOf ? revisionOf(DRAFTS_WORKSPACE_KEY) : undefined
          const readDrafts = revisionOf === null
            || draftCache === null
            || draftRev === undefined
            || draftCache.rev !== draftRev

          const staleKeys = []
          const staleRevs = []
          if (revisionOf === null) {
            sessionCache.clear()
            for (const key of keys) {
              staleKeys.push(key)
              staleRevs.push(undefined)
            }
          } else {
            const live = new Set(keys)
            for (const key of sessionCache.keys()) {
              if (!live.has(key)) sessionCache.delete(key)
            }
            for (const key of keys) {
              const rev = revisionOf(key)
              const cached = sessionCache.get(key)
              if (rev === undefined || cached === undefined || cached.rev !== rev) {
                staleKeys.push(key)
                staleRevs.push(rev)
              }
            }
          }

          const [draftEntries, sessionReads] = await Promise.all([
            readDrafts ? services.store.listEntries(DRAFTS_WORKSPACE_KEY) : Promise.resolve(null),
            Promise.all(staleKeys.map(async key => {
              const sId = key.startsWith('session:') ? key.slice('session:'.length) : key
              let [entries, promptLog, groups] = await Promise.all([
                services.store.listEntries(key),
                services.store.listPromptLog(key),
                typeof services.store.getGroups === 'function' ? services.store.getGroups(sId) : Promise.resolve([]),
              ])
              const commitTraces = typeof services.store.listCommitTraces === 'function'
                ? await services.store.listCommitTraces(key)
                : []
              if ((!promptLog || promptLog.length === 0) && typeof services.backfillSession === 'function') {
                try {
                  const bfRes = await services.backfillSession({ sessionId: sId, workspaceKey: key })
                  if (bfRes && bfRes.ok && !bfRes.unavailable) {
                    promptLog = await services.store.listPromptLog(key)
                  }
                } catch {}
              }
              return {
                entries,
                promptLog,
                groups: Array.isArray(groups) ? groups : [],
                commitTraces: Array.isArray(commitTraces) ? commitTraces : [],
              }
            })),
          ])
          if (!alive || run !== generation.current) return
          if (readDrafts) draftCache = { rev: draftRev, drafts: filterDrafts(draftEntries) }

          staleKeys.forEach((key, index) => {
            if (revisionOf === null) return
            const read = sessionReads[index]
            sessionCache.set(key, {
              rev: staleRevs[index],
              summary: summarizeSession(key, read.entries, read.promptLog, read.groups, {
                traces: read.commitTraces,
              }),
              entries: read.entries,
              promptLog: read.promptLog,
              groups: read.groups || [],
              commitTraces: read.commitTraces || [],
            })
          })

          const summaries = revisionOf === null
            ? sessionReads.map((read, index) => summarizeSession(staleKeys[index], read.entries, read.promptLog, read.groups, {
              traces: read.commitTraces,
            }))
            : keys.map(key => sessionCache.get(key).summary)

          const allEntries = revisionOf === null
            ? sessionReads.flatMap(r => r.entries || [])
            : keys.flatMap(key => sessionCache.get(key)?.entries || [])

          const allLogs = revisionOf === null
            ? sessionReads.flatMap(r => r.promptLog || [])
            : keys.flatMap(key => sessionCache.get(key)?.promptLog || [])

          const allSessionGroups = revisionOf === null
            ? sessionReads.flatMap(r => r.groups || [])
            : keys.flatMap(key => sessionCache.get(key)?.groups || [])

          const allSessionCommitTraces = revisionOf === null
            ? sessionReads.flatMap(r => r.commitTraces || [])
            : keys.flatMap(key => sessionCache.get(key)?.commitTraces || [])

          setDrafts(draftCache.drafts)
          setSessions(summaries)
          setAllFindings(allEntries.filter(e => e.kind === 'finding'))
          setAllPromptLogs(allLogs)
          setAllGroups(allSessionGroups)
          setAllCommitTraces(allSessionCommitTraces)

          try {
            setQuotaWarning(Boolean(services.store.quotaWarning?.()))
          } catch {
            // no quota warning
          }
          if (typeof services.store?.getPrefs === 'function') {
            try {
              const raw = await services.store.getPrefs()
              if (alive && run === generation.current) setPrefs(prefsOf(raw))
            } catch {
              // ignore
            }
          }
          setCanOpenSession(Boolean(services.canOpenSession?.()))
          setLoaded(true)
        } catch {
          if (alive) setLoaded(true)
        }
      }

      load()
      const unsubscribe = typeof services.store.subscribe === 'function'
        ? services.store.subscribe(load)
        : () => {}
      return () => {
        alive = false
        unsubscribe()
      }
    }, [refreshTick])

    // Project the Harness archive set. The WorkspacesBridge also forwards it
    // from the reactive useWorkspaces snapshot; this service path covers the
    // first render (and tests) and stays a no-op when the optional service is
    // absent (older compositions) — same defensive contract as the pane.
    React.useEffect(() => {
      let alive = true
      const read = () => {
        if (!alive) return
        try {
          const ids = services.getArchivedSessionIds?.()
          setArchivedSessionIds(Array.isArray(ids) ? ids : [])
        } catch {
          // Keep the last known set on a transient read failure.
        }
      }
      read()
      let unsubscribe
      try {
        unsubscribe = services.subscribeWorkspaceSnapshot?.(read)
      } catch {
        unsubscribe = undefined
      }
      return () => {
        alive = false
        if (typeof unsubscribe === 'function') unsubscribe()
      }
    }, [services])

    // Query pending open action count across archived sessions for Desk badge hint
    React.useEffect(() => {
      if (!archivedSessionIds || archivedSessionIds.length === 0 || !services.store?.listTurnActions) {
        setArchivedOpenActionsCount(0)
        return
      }
      let active = true
      Promise.all(archivedSessionIds.map(sid => services.store.listTurnActions(sid).catch(() => null)))
        .then(states => {
          if (!active) return
          let count = 0
          for (const st of states) {
            if (st && Array.isArray(st.items)) {
              count += st.items.filter(item => item && item.status === 'open').length
            }
          }
          setArchivedOpenActionsCount(count)
        })
        .catch(() => {})
      return () => { active = false }
    }, [archivedSessionIds, refreshTick, services.store])

    // Active workspace resolution. Draft visibility filtering needs the active
    // workspace, so it is resolved before the selection effects run.
    const liveActiveWs = (typeof services.getActiveWorkspaceId === 'function' ? services.getActiveWorkspaceId() : undefined)
      || (typeof services.getCurrentWorkspaceId === 'function' ? services.getCurrentWorkspaceId() : undefined)
    const resolvedLookupWorkspaceId = selectedWorkspaceId
      || liveActiveWs
      || workspaceId
      || props.workspaceId
      || props.activeWorkspaceId
      || (typeof props.useWorkspaces === 'object' ? (props.useWorkspaces?.activeWorkspaceId || props.useWorkspaces?.currentId || props.useWorkspaces?.selectedWorkspaceId) : undefined)
      || (hostWorkspaces[0]?.id || (Array.isArray(props.useWorkspaces?.items) ? props.useWorkspaces.items[0]?.workspaceId || props.useWorkspaces.items[0]?.id : undefined))
      || workspaceRecords[0]?.id
    const activeWsId = resolvedLookupWorkspaceId || 'default'
    const currentWorkspaceRecord = workspaceRecords.find(w => w.id === activeWsId) || workspaceRecords[0] || null
    const gitBranch = currentWorkspaceRecord?.gitBranch || ''
    const activeBranch = detectedGitBranch || gitBranch || ''
    // Global drafts stay visible in every workspace; `workspace` drafts only in
    // the workspace they were filed under. Everything downstream (selection,
    // list, counts, dashboard, canvas) reads this filtered view.
    const visibleDrafts = filterDraftsForWorkspace(drafts, activeWsId)

    // Global distillation indicator. The reviews tab is one click away and has no
    // badge of its own, so a batch that is analyzing (or waiting for a human
    // confirmation) used to be invisible from every other tab — first-time users
    // only found it because submissions suddenly got paused. Poll the active
    // workspace's runs, keep the last known value on failure, and let the banner
    // be dismissed per run (a status change brings it back).
    const [distillActiveRun, setDistillActiveRun] = React.useState(null)
    const [distillBannerDismissed, setDistillBannerDismissed] = React.useState(false)
    // Collapse state for the dashboard's titled sections. It lives here (not in
    // the dashboard) because that view is invoked as a plain function: a hook in
    // it would join DeskPage's hook sequence and break tab switches (React #300).
    const [dashboardCollapsed, setDashboardCollapsed] = React.useState({})
    // Collapse state for the Desk's left-rail sections (drafts / sessions).
    // Mirrors the Session Pane: the whole section header is the hit target.
    const [sidebarCollapsed, setSidebarCollapsed] = React.useState({})
    const sidebarSectionCollapsed = key => Boolean(sidebarCollapsed[key])
    const toggleSidebarSection = key => setSidebarCollapsed(prev => ({ ...prev, [key]: !prev[key] }))
    const distillBannerWorkspaceId = activeWsId === 'default' ? undefined : activeWsId
    React.useEffect(() => {
      if (!distillBannerWorkspaceId || typeof fetch !== 'function') {
        setDistillActiveRun(null)
        return undefined
      }
      let alive = true
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const poll = async () => {
        try {
          const res = await fetch(
            `api/punch-desk/distill-run?workspaceId=${encodeURIComponent(distillBannerWorkspaceId)}`,
            controller ? { signal: controller.signal } : undefined,
          )
          if (!res || !res.ok) return
          const data = await res.json()
          if (!alive || !data || data.ok !== true || !Array.isArray(data.runs)) return
          const active = getActiveRun(data.runs, distillBannerWorkspaceId)
          setDistillActiveRun(active
            ? { status: active.status, stage: active.stage || '' }
            : null)
        } catch {
          // Abort/network failure: keep the last known indicator (fail-open).
        }
      }
      void poll()
      const timer = setInterval(poll, DISTILL_BANNER_POLL_MS)
      const unref = typeof timer.unref === 'function' ? () => timer.unref() : () => {}
      unref()
      return () => {
        alive = false
        clearInterval(timer)
        if (controller) controller.abort()
      }
    }, [distillBannerWorkspaceId])
    const distillRunKey = distillActiveRun
      ? `${distillActiveRun.status}:${distillActiveRun.stage}`
      : ''
    React.useEffect(() => {
      // A dismissed banner stays hidden for that exact run state only.
      if (distillRunKey) setDistillBannerDismissed(false)
    }, [distillRunKey])

    const clearGitLookupState = React.useCallback(() => {
      setGitLookupMatches([])
      setGitLookupError(null)
      setGitLookupSearched(false)
    }, [])

    const prevLookupWsRef = React.useRef(resolvedLookupWorkspaceId)
    React.useEffect(() => {
      if (prevLookupWsRef.current !== undefined && prevLookupWsRef.current !== resolvedLookupWorkspaceId) {
        clearGitLookupState()
      }
      prevLookupWsRef.current = resolvedLookupWorkspaceId
    }, [resolvedLookupWorkspaceId, clearGitLookupState])

    React.useEffect(() => {
      if (isGitLookupOpen) {
        gitLookupInputRef.current?.focus?.()
      }
    }, [isGitLookupOpen])

    // Ensure valid draft selection inside the active workspace.
    React.useEffect(() => {
      if (selectedDraftId === NEW_DRAFT) return
      const visible = filterDraftsForWorkspace(drafts, activeWsId)
      if (selectedDraftId !== null && visible.some(draft => draft.id === selectedDraftId)) return
      setSelectedDraftId(visible.length > 0 ? visible[0].id : null)
    }, [drafts, activeWsId, selectedDraftId])

    // Ensure default active workspace selection
    React.useEffect(() => {
      if (selectedWorkspaceId) return
      const defaultWs = (typeof services.getActiveWorkspaceId === 'function' ? services.getActiveWorkspaceId() : undefined)
        || (typeof services.getCurrentWorkspaceId === 'function' ? services.getCurrentWorkspaceId() : undefined)
        || workspaceId
        || props.workspaceId
        || props.activeWorkspaceId
      if (defaultWs) {
        setSelectedWorkspaceId(defaultWs)
      }
    }, [workspaceId, props.workspaceId, props.activeWorkspaceId, selectedWorkspaceId, services])

    // Ensure valid session selection. An archived Session is hidden from every
    // grouping surface, so a selection pointing at one is dropped when the host
    // archive set changes under us.
    React.useEffect(() => {
      if (selectedSessionId === null) return
      if (archivedSessionIdSet.has(selectedSessionId)) {
        setSelectedSessionId(null)
        return
      }
      if (sessions.some(session => session.sessionId === selectedSessionId)) return
      setSelectedSessionId(null)
    }, [sessions, selectedSessionId, archivedSessionIdSet])

    const selectDraft = id => {
      setSelectedDraftId(id)
      setTab('canvas')
    }

    const newDraft = () => {
      setSelectedDraftId(NEW_DRAFT)
      setTab('canvas')
    }

    const handleCreated = entry => {
      if (!entry || typeof entry.id !== 'string') return
      setDrafts(previous => filterDrafts([...previous.filter(item => item.id !== entry.id), entry]))
      setSelectedDraftId(entry.id)
    }

    const handleSaved = entry => {
      if (!entry || typeof entry.id !== 'string') return
      setDrafts(previous => filterDrafts([...previous.filter(item => item.id !== entry.id), entry]))
    }

    const handleDeleted = id => {
      setDrafts(previous => previous.filter(item => item.id !== id))
      setSelectedDraftId(current => (current === id ? null : current))
    }

    const openSession = sessionId => services.openSession?.(sessionId) === true

    const openSessionAtCommit = match => {
      if (!match?.sessionId) return false
      if (!openSession(match.sessionId)) return false
      const commitHash = match.commit?.hash || ''
      services.setPendingCommitFocus?.(match.sessionId, {
        traceId: match.traceId,
        commitHash,
        shortHash: match.commit?.shortHash || commitHash.slice(0, 7),
        findingIds: Array.isArray(match.findingIds) ? match.findingIds : [],
        turn: match.turn,
      })
      return true
    }

    const sessionTitle = session => {
      const id = session?.sessionId ?? session
      if (typeof id !== 'string') return ''
      const serviceTitles = typeof services.getSessionTitles === 'function' ? services.getSessionTitles() : null
      const record = sessionTitles[id] || props.useSessions?.byId?.[id] || props.sessionsMap?.[id] || serviceTitles?.[id]
      if (typeof record === 'string') return record
      return record !== null && typeof record === 'object' && typeof record.title === 'string' ? record.title : ''
    }

    const handleGitLookup = async () => {
      const raw = String(gitLookupQueryRef.current ?? gitLookupQuery ?? '').trim()
      if (!/^[0-9a-f]{7,40}$/i.test(raw)) {
        setGitLookupError(t('desk.gitLookup.invalid'))
        setGitLookupMatches([])
        setGitLookupSearched(false)
        return
      }
      if (!resolvedLookupWorkspaceId) {
        setGitLookupError(t('desk.gitLookup.failed'))
        setGitLookupMatches([])
        setGitLookupSearched(false)
        return
      }
      setGitLookupBusy(true)
      setGitLookupError(null)
      try {
        let res
        if (typeof services.git?.lookup === 'function') {
          res = await services.git.lookup(resolvedLookupWorkspaceId, raw)
        } else if (typeof services.store?.lookupCommitTraces === 'function') {
          res = await services.store.lookupCommitTraces({ workspaceId: resolvedLookupWorkspaceId, hash: raw })
        } else {
          throw new Error('lookup-unavailable')
        }
        if (!res || res.ok === false || !Array.isArray(res.matches)) {
          throw new Error(res?.error || 'lookup-failed')
        }
        setGitLookupMatches(res.matches)
        setGitLookupSearched(true)
        setGitLookupError(null)
      } catch {
        setGitLookupError(t('desk.gitLookup.failed'))
        setGitLookupMatches([])
        setGitLookupSearched(false)
      } finally {
        setGitLookupBusy(false)
      }
    }

    const openReview = sessionId => {
      if (typeof sessionId !== 'string' || sessionId === '') return
      setSelectedSessionId(sessionId)
      setTab('reviews')
    }

    // Task 3.2 renew (minimal): DistillConfirm.ResultContent hands the chosen
    // summary back and the result page simply opens the canvas so the user can
    // turn it into the next draft there.
    const handleDistillRenew = () => {
      setTab('canvas')
    }

    React.useEffect(() => {
      let alive = true
      const fetchBranch = async () => {
        if (!activeWsId) return
        try {
          if (typeof services.gitApi?.getBranch === 'function') {
            const res = await services.gitApi.getBranch({ workspaceId: activeWsId })
            if (alive && res?.ok && res.gitBranch) {
              setDetectedGitBranch(res.gitBranch)
              return
            }
          } else if (typeof globalThis.fetch === 'function') {
            const res = await globalThis.fetch(`api/punch-desk/git-branch?workspaceId=${encodeURIComponent(activeWsId)}`)
            if (res?.ok) {
              const data = await res.json()
              if (alive && data?.ok && data.gitBranch) {
                setDetectedGitBranch(data.gitBranch)
                return
              }
            }
          }
        } catch {
          // Fall back gracefully
        }
        if (alive) {
          setDetectedGitBranch(currentWorkspaceRecord?.gitBranch || '')
        }
      }
      void fetchBranch()
      return () => { alive = false }
    }, [activeWsId, currentWorkspaceRecord?.gitBranch, services.gitApi])

    const handleNewWorkspace = () => {
      // Check if harness provides workspace creation
      if (typeof services.createWorkspace === 'function') {
        services.createWorkspace()
      } else {
        setWorkspaceNotice(t('desk.workspace.newUnavailable'))
        setTimeout(() => setWorkspaceNotice(null), 3000)
      }
    }

    // All available workspaces combining records, hostWorkspaces, props, and fallback
    const allWorkspaces = (() => {
      const map = new Map()
      function friendlyName(rawId, rawName, rawPath) {
        if (rawPath && typeof rawPath === 'string') {
          const parts = rawPath.split(/[\/\\]/).filter(Boolean)
          if (parts.length > 0) {
            const folder = parts[parts.length - 1]
            if (folder && folder !== '' && !/^[0-9a-f-]{36}$/i.test(folder)) {
              return folder
            }
          }
        }
        if (rawName && typeof rawName === 'string' && !/^[0-9a-f-]{36}$/i.test(rawName)) {
          return rawName
        }
        return rawName || rawId
      }

      for (const w of workspaceRecords) {
        const name = friendlyName(w.id, w.name, w.path)
        map.set(w.id, { id: w.id, name, path: w.path || '', sessionIds: w.sessionIds || [] })
      }
      const rawHostItems = Array.isArray(props.workspaces)
        ? props.workspaces
        : (Array.isArray(props.useWorkspaces?.items)
          ? props.useWorkspaces.items
          : (typeof props.useWorkspaces?.getSnapshot === 'function'
            ? props.useWorkspaces.getSnapshot()?.items
            : (typeof services.getHostWorkspaces === 'function' ? services.getHostWorkspaces() : [])))
      const serviceHostItems = typeof services.getHostWorkspaces === 'function' ? services.getHostWorkspaces() : []
      const hostItems = [
        ...hostWorkspaces,
        ...(Array.isArray(rawHostItems) ? rawHostItems : []),
        ...serviceHostItems,
      ]
      for (const w of hostItems) {
        const id = w.workspaceId || w.id
        if (!id) continue
        const name = friendlyName(id, w.name, w.path)
        if (map.has(id)) {
          const existing = map.get(id)
          map.set(id, {
            ...existing,
            name: existing.name || name,
            path: existing.path || w.path || '',
            sessionIds: [...new Set([...(existing.sessionIds || []), ...(w.sessionIds || [])])],
          })
        } else {
          map.set(id, { id, name, path: w.path || '', sessionIds: Array.isArray(w.sessionIds) ? w.sessionIds : [] })
        }
      }
      if (activeWsId && !map.has(activeWsId)) {
        map.set(activeWsId, { id: activeWsId, name: friendlyName(activeWsId, activeWsId, ''), path: '', sessionIds: [] })
      }
      if (map.size === 0) {
        map.set('dsh-plugins', { id: 'dsh-plugins', name: 'dsh-plugins', path: '', sessionIds: [] })
      }
      return [...map.values()]
    })()

    // Filter sessions by active workspace. One shared resolver drives the
    // session list, the dashboard and the distillation batch source, so a
    // session can never leak into another workspace's surfaces.
    const activeWorkspaceObj = allWorkspaces.find(w => w.id === activeWsId)
    const activeWsName = activeWorkspaceObj?.name || activeWsId

    const allSessionsMap = {
      ...hostSessionsMap,
      ...(props.sessionsMap || props.useSessions?.byId || {}),
    }

    const workspaceScopedSessionIds = resolveWorkspaceSessionIds({
      sessions,
      findings: allFindings,
      sessionsById: allSessionsMap,
      workspaces: allWorkspaces,
      activeWorkspaceId: activeWsId,
    })
    const workspaceScopedSessions = sessions.filter(session => workspaceScopedSessionIds.has(session.sessionId))
    // A workspace key can outlive its rows (see `isSessionCardVisible`). The
    // Harness hides blank sessions in its own tree; the Desk must apply the
    // same "nothing to show = no row" rule to the store-derived list, or a
    // deleted session keeps rendering as an untitled 0/0 card with its raw id.
    const sessionCards = workspaceScopedSessions.filter(session => isSessionCardVisible(session))
    const filteredSessions = sessionCards
      .filter(session => !archivedSessionIdSet.has(session.sessionId))

    const selectedDraft = selectedDraftId === NEW_DRAFT
      ? null
      : visibleDrafts.find(draft => draft.id === selectedDraftId) ?? null
    // Known session summaries (not just the visible ones) that the host lists
    // as archived; shown as a neutral badge so the archiving is visible without
    // re-introducing the rows into the working surfaces.
    const archivedKnownCount = sessions.filter(session => archivedSessionIdSet.has(session.sessionId)).length
    const orderedSessions = sortSessionSummaries(filteredSessions, sessionUpdatedAt).map(s => {
      const liveTurn = typeof services.index?.getTurn === 'function' ? services.index.getTurn(s.sessionId) : 0
      const contextTurns = Math.max(s.contextTurns || s.turns || 0, liveTurn)
      // `groupTurns` is `charged + attributed` from the group-turn read model; the
      // legacy `group.turns` sum is gone (it always derived 0 after the writers were
      // removed). `deskTurns` stays as the historical field name for the same value.
      const groupTurns = s.groupTurns ?? s.deskTurns ?? 0
      return {
        ...s,
        turns: contextTurns,
        contextTurns,
        deskTurns: groupTurns,
        groupTurns,
        chargedTurns: s.chargedTurns ?? 0,
        attributedTurns: s.attributedTurns ?? 0,
      }
    })

    // Left Sidebar: Draft cards matching mockup
    const draftRows = visibleDrafts.map((draft, idx) => {
      const tint = getSequenceTint(idx)
      const label = draftDisplayTitle(draft, t('desk.draft.untitled'))
      const isSelected = selectedDraftId === draft.id && (tab === 'canvas' || tab === 'dashboard')
      const scopedToWorkspace = draftVisibility(draft) === WORKSPACE_DRAFT_VISIBILITY
      return h('button', {
        key: draft.id,
        type: 'button',
        title: label,
        onClick: () => selectDraft(draft.id),
        style: {
          padding: '8px 10px',
          borderRadius: 10,
          border: isSelected
            ? '1px solid var(--pd-accent, var(--dsw-alias-button-primary-fill, #5e81ac))'
            : `1px solid ${tint.border}`,
          borderLeft: `3px solid ${tint.accent}`,
          background: isSelected
            ? 'var(--pd-bg-panel, var(--dsw-alias-bg-layer-2, rgba(136, 192, 208, 0.12)))'
            : tint.bg,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          cursor: 'pointer',
          textAlign: 'left',
          width: '100%',
          boxSizing: 'border-box',
          transition: 'all 0.15s ease',
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, width: '100%' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 } },
            h('span', {
              style: {
                fontSize: 9,
                fontFamily: 'monospace',
                fontWeight: 700,
                color: tint.accent,
                padding: '1px 4px',
                borderRadius: 3,
                background: 'rgba(0, 0, 0, 0.05)',
                border: `1px solid ${tint.border}`,
                flexShrink: 0,
              },
            }, `#${idx + 1}`),
            h('span', {
              style: {
                fontWeight: 600,
                fontSize: 12,
                color: isSelected ? 'var(--pd-accent, var(--dsw-alias-button-primary-fill, #5e81ac))' : 'var(--pd-text-primary, var(--dsw-alias-label-primary, #2e3440))',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            }, label)),
          h(Badge, {
            tone: scopedToWorkspace ? 'info' : 'neutral',
            icon: scopedToWorkspace ? icons.Folder : undefined,
            title: draftVisibilityText(draftVisibility(draft), t),
            style: { fontSize: 9, padding: '1px 5px', flexShrink: 0 },
          }, draftVisibilityText(draftVisibility(draft), t)),
          h(Badge, { tone: DRAFT_STATUS_TONE[draft.status] ?? 'neutral', style: { fontSize: 9, padding: '1px 5px', flexShrink: 0 } },
            draftStatusText(draft.status, t))),
        h('div', {
          style: {
            fontSize: 10,
            fontFamily: 'monospace',
            color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          },
        }, draft.desc || draft.body ? (draft.desc || draft.body).slice(0, 60) : t('desk.draft.noDesc')))
    })

    // Left Sidebar: Session cards matching mockup
    const sessionRows = orderedSessions.map((session, index) => {
      const label = sessionTitle(session) || session.sessionId
      const isSelected = selectedSessionId === session.sessionId || (!selectedSessionId && index === 0)
      return h('button', {
        key: session.sessionId,
        type: 'button',
        title: label,
        onClick: () => {
          setSelectedSessionId(session.sessionId)
        },
        style: {
          padding: '10px 12px',
          borderRadius: 10,
          border: isSelected
            ? 'var(--pd-card-focused-border, 1.5px solid #88c0d0)'
            : '1px solid var(--pd-border-subtle, var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08)))',
          background: isSelected
            ? 'var(--pd-card-focused-bg, linear-gradient(135deg, rgba(136, 192, 208, 0.22) 0%, rgba(94, 129, 172, 0.14) 50%, rgba(180, 142, 173, 0.22) 100%))'
            : 'var(--pd-bg-card, var(--dsw-alias-bg-layer-1, #ffffff))',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          cursor: 'pointer',
          textAlign: 'left',
          width: '100%',
          boxSizing: 'border-box',
          boxShadow: isSelected ? 'var(--pd-card-focused-shadow, 0 0 12px rgba(136, 192, 208, 0.4))' : 'none',
          transition: 'all 0.15s ease',
        },
      },
        // Accessibility and test locator helper
        h('span', { style: { display: 'none' } }, `${label} ${countText(t('desk.session.findings'), session.findingCount)}`),
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, width: '100%' } },
          h('span', {
            style: {
              fontWeight: 600,
              fontSize: 12,
              color: isSelected ? 'var(--pd-card-focused-title, #88c0d0)' : 'var(--pd-text-primary, var(--dsw-alias-label-primary, #2e3440))',
              textShadow: isSelected ? 'var(--pd-card-focused-title-shadow, none)' : 'none',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
            },
          }, label),
          h(Badge, { tone: (session.findingCount || 0) > 0 ? 'warn' : 'success', style: { fontSize: 9, padding: '1px 5px', flexShrink: 0 } },
            (session.findingCount || 0) > 0 ? t('desk.session.badgeActive') : t('desk.session.badgeReady'))),
        h('div', {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: 10,
            fontFamily: 'monospace',
            color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
          },
        },
          // Session elapsed turns are context; the group-turn total is real derived
          // work (`charged + attributed`). The total is only shown while it is non-zero,
          // so a session with no attributable group work never advertises a "0".
          h('span', {
            tip: session.groupTurns > 0 ? t('group.turnsTip') : undefined,
          }, session.groupTurns > 0
            ? t('desk.session.turnsLine')
              .replace('{turns}', String(session.contextTurns ?? session.turns ?? 0))
              .replace('{progress}', String(session.groupTurns))
            : countText(t('dashboard.sessionTurns'), session.contextTurns ?? session.turns ?? 0)),
          h('span', null, countText(t('desk.session.findings'), session.findingCount))))
    })

    const effectiveTab = tab === 'journal' ? 'canvas' : (tab === 'diff' ? 'reviews' : tab)
    const isSettingsActive = effectiveTab === 'settings'

    // Left Sidebar (260px)
    const left = h('div', { style: LEFT_STYLE },
      h('div', { style: LEFT_SCROLL_STYLE },
        // Workspace Switcher
        h('div', { style: WORKSPACE_SELECT_STYLE },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, fontSize: 11, fontFamily: 'monospace', color: 'var(--dsw-alias-label-tertiary, #4c566a)', marginBottom: 6 } },
            h('span', { style: { fontWeight: 700, textTransform: 'uppercase' } }, t('desk.workspace.select')),
            activeBranch
              ? h(Badge, {
                  tone: 'info',
                  icon: icons.GitBranch,
                  tip: activeBranch,
                  style: {
                    fontSize: 10,
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    padding: '1px 6px',
                    fontWeight: 600,
                    minWidth: 0,
                    maxWidth: 'min(56%, 180px)',
                    flexShrink: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    background: 'rgba(94, 129, 172, 0.18)',
                    color: 'var(--pd-accent, #88c0d0)',
                    border: '1px solid rgba(94, 129, 172, 0.35)',
                  },
                }, activeBranch)
              : null),
          h('select', {
            value: activeWsId,
            onChange: e => {
              setSelectedWorkspaceId(e.target.value)
              clearGitLookupState()
            },
            style: SELECT_FIELD_STYLE,
            'aria-label': t('desk.workspace.select'),
          },
            allWorkspaces.map(w => {
              const wSessionIds = new Set(w.sessionIds || [])
              const wSessions = sessionCards.filter(s => {
                if (archivedSessionIdSet.has(s.sessionId)) return false
                if (wSessionIds.has(s.sessionId)) return true
                if (allSessionsMap[s.sessionId]?.workspaceId === w.id) return true
                const sf = allFindings.filter(f => f.sessionId === s.sessionId)
                if (sf.some(f => f.workspaceId === w.id)) return true
                for (const other of allWorkspaces) {
                  if (other.id !== w.id) {
                    if ((other.sessionIds || []).includes(s.sessionId)) return false
                    if (allSessionsMap[s.sessionId]?.workspaceId === other.id) return false
                    if (sf.some(f => f.workspaceId === other.id)) return false
                  }
                }
                return allWorkspaces.length <= 1
              })
              const sCount = wSessions.length
              const dCount = filterDraftsForWorkspace(drafts, w.id).length
              return h('option', { key: w.id, value: w.id },
                t('desk.workspace.option')
                  .replace('{name}', String(w.name || w.id))
                  .replace('{sessions}', String(sCount))
                  .replace('{drafts}', String(dCount)))
            })),
          workspaceNotice
            ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-state-warn-primary)' } }, workspaceNotice)
            : null),

        // Drafts Section — the whole header row folds it (Session Pane pattern),
        // so clicking the title works instead of only a tiny caret. The
        // "new draft" button keeps its own click via suppressesRowToggle.
        h('div', {
          'data-desk-section': 'drafts',
          style: { ...SECTION_HEADER_STYLE, cursor: 'pointer' },
          onClick: event => {
            if (suppressesRowToggle(event)) return
            toggleSidebarSection('drafts')
          },
        },
          h(Button, {
            icon: sidebarSectionCollapsed('drafts') ? icons.CaretRight : icons.CaretDown,
            iconOnly: true,
            variant: 'ghost',
            'aria-expanded': !sidebarSectionCollapsed('drafts'),
            title: t(sidebarSectionCollapsed('drafts') ? 'finding.expand' : 'finding.collapse'),
            'aria-label': t(sidebarSectionCollapsed('drafts') ? 'finding.expand' : 'finding.collapse'),
            onClick: () => toggleSidebarSection('drafts'),
            style: { padding: 2 },
          }),
          h('span', { style: SECTION_LABEL_STYLE }, t('desk.section.drafts')),
          h('span', { style: SECTION_COUNT_STYLE }, String(visibleDrafts.length)),
          h(Button, {
            icon: icons.Plus,
            style: { padding: '2px 8px', fontSize: 12 },
            onClick: newDraft,
          }, t('desk.draft.new'))),
        sidebarSectionCollapsed('drafts') ? null : visibleDrafts.length === 0
          ? h('div', { 'data-desk-rail-body': 'drafts' },
            h(Empty, { style: { padding: '8px 4px' } }, t('desk.draft.empty')))
          : h('div', {
            'data-desk-rail-body': 'drafts',
            style: { display: 'flex', flexDirection: 'column', gap: 6 },
          }, draftRows),

        // Sessions Section — same whole-header fold behavior.
        h('div', {
          'data-desk-section': 'sessions',
          style: { ...SECTION_HEADER_STYLE, cursor: 'pointer' },
          onClick: event => {
            if (suppressesRowToggle(event)) return
            toggleSidebarSection('sessions')
          },
        },
          h(Button, {
            icon: sidebarSectionCollapsed('sessions') ? icons.CaretRight : icons.CaretDown,
            iconOnly: true,
            variant: 'ghost',
            'aria-expanded': !sidebarSectionCollapsed('sessions'),
            title: t(sidebarSectionCollapsed('sessions') ? 'finding.expand' : 'finding.collapse'),
            'aria-label': t(sidebarSectionCollapsed('sessions') ? 'finding.expand' : 'finding.collapse'),
            onClick: () => toggleSidebarSection('sessions'),
            style: { padding: 2 },
          }),
          h('span', { style: SECTION_LABEL_STYLE }, t('desk.section.sessions')),
          h('span', { style: SECTION_COUNT_STYLE }, String(orderedSessions.length)),
          archivedKnownCount > 0
            ? h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
                h(Badge, {
                  tone: 'neutral',
                  tip: t('desk.session.archivedHint'),
                  style: { fontSize: 9, padding: '1px 5px', flexShrink: 0 },
                }, t('desk.session.archivedCount').replace('{count}', String(archivedKnownCount))),
                archivedOpenActionsCount > 0
                  ? h(Badge, {
                      tone: 'warn',
                      tip: t('turnActions.deskArchivedToast'),
                      onClick: () => {
                        services.toast?.info?.(t('turnActions.deskArchivedToast'))
                      },
                      style: { fontSize: 9, padding: '1px 5px', flexShrink: 0, cursor: 'pointer' },
                    }, t('turnActions.deskArchivedHint').replace('{n}', String(archivedOpenActionsCount)))
                  : null)
            : null),
        sidebarSectionCollapsed('sessions') ? null : orderedSessions.length === 0
          ? h('div', { 'data-desk-rail-body': 'sessions' },
            h(Empty, { style: { padding: '8px 4px' } }, t('desk.session.empty')))
          : h('div', {
            'data-desk-rail-body': 'sessions',
            style: { display: 'flex', flexDirection: 'column', gap: 6 },
          }, sessionRows)),

      // Left Bottom Settings Entry
      h('div', { style: LEFT_FOOTER_STYLE },
        h(Button, {
          icon: icons.Faders ?? icons.FadersIcon,
          variant: isSettingsActive ? 'primary' : 'default',
          'aria-label': t('desk.tab.settings'),
          style: {
            width: '100%',
            justifyContent: 'flex-start',
            padding: '6px 10px',
            fontSize: 12,
            fontWeight: isSettingsActive ? 600 : 500,
          },
          onClick: () => {
            if (tab !== 'settings') {
              setPreviousTab(tab)
            }
            setTab('settings')
          },
        }, t('desk.tab.settings'))))

    // Feed the DistillView batch source with the current render snapshot
    // (sessions / findings / promptLogs / archived ids). See the factory note
    // on why this is a mutable box rather than a state write.
    // Titles are resolved here: store summaries carry no `title`, so passing
    // them raw made every distillation candidate render as an untitled session.
    // Workspace-scoped on purpose: the batch picker must only offer sessions of
    // the active workspace (findings / prompt logs included), otherwise it
    // advertises batches the Host would reject on ownership validation.
    distillSourceBox.current = {
      sessions: sessionCards.map(session => ({
        ...session,
        title: session.title || sessionTitle(session),
      })),
      findings: allFindings.filter(finding => workspaceScopedSessionIds.has(finding.sessionId)),
      promptLogs: allPromptLogs.filter(log => workspaceScopedSessionIds.has(log.sessionId)),
      archivedSessionIds: archivedSessionIdSet,
    }

    // Retention usage shown in Settings (rows + approximate bytes of the
    // workspace prompt log). Cheap enough to recompute on log changes.
    const retentionUsage = React.useMemo(() => {
      let rows = 0
      let bytes = 0
      const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null
      for (const row of allPromptLogs) {
        rows += 1
        const text = typeof row?.promptText === 'string' ? row.promptText : ''
        bytes += encoder ? encoder.encode(text).length : text.length * 2
      }
      return { rows, bytes }
    }, [allPromptLogs])

    // Right Sub-view Switcher
    let right

    if (effectiveTab === 'dashboard') {
      const dashboardView = WorkspaceDashboard({
        sessions: orderedSessions,
        drafts: visibleDrafts,
        selectedDraft,
        selectedDraftId,
        selectedSessionId,
        allFindings,
        allGroups,
        allCommitTraces,
        onSelectSession: sid => setSelectedSessionId(sid),
        workspaceRecord: currentWorkspaceRecord,
        sessionTitles,
        canOpenSession,
        workspaceId,
        startBehavior,
        onOpenSession: openSession,
        onReviewSession: openReview,
        onSelectDraft: selectDraft,
        onNewDraft: newDraft,
        onEditInCanvas: id => selectDraft(id),
        onCreateDraft: handleCreated,
        onSaveDraft: handleSaved,
        onDeleteDraft: handleDeleted,
        expandedFindingIds: dashboardExpandedFindingIds,
        onToggleExpandFinding: toggleDashboardExpandFinding,
        collapsedSections: dashboardCollapsed,
        onToggleSection: key => setDashboardCollapsed(prev => ({ ...prev, [key]: !prev[key] })),
      })
      // Product decision C (2026-11-11): the standalone single-session digest
      // panel was removed. Cross-session takeaways live in the distillation
      // result page (same `renderDigest`), so the dashboard no longer duplicates
      // them; only the dashboard itself renders here.
      right = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 } },
        dashboardView)
    } else if (effectiveTab === 'canvas') {
      right = h(DraftEditor, {
        key: `${activeWsId}:${selectedDraftId ?? 'none'}`,
        draft: selectedDraft,
        isNew: selectedDraftId === NEW_DRAFT,
        workspaceId: activeWsId === 'default' ? undefined : activeWsId,
        workspaceName: activeWsId === 'default' ? '' : activeWsName,
        startBehavior: prefs.startSessionBehavior,
        defaultVisibility: prefs.draftDefaultVisibility,
        onNew: newDraft,
        onCreate: handleCreated,
        onSave: handleSaved,
        onDelete: handleDeleted,
      })
    } else if (effectiveTab === 'reviews') {
      // Task 3.1 + 3.2: the reviews tab hosts the distillation state machine
      // (config → running → pending → result, side-viewable history). The
      // pending phase renders the shared DistillConfirm (injected at the
      // factory above); the result phase forwards its ResultContent through
      // the renderSummary slot. The legacy RetrospectiveDiff branch and its
      // fallback session-card list were removed in the Task 4.2 cleanup.
      right = h(DistillView, {
        key: `distill:${activeWsId}`,
        workspaceId: resolvedLookupWorkspaceId || workspaceId,
        renderSummary: ({ run, runs }) => (run
          ? h(DistillConfirm.ResultContent, { run, onRenew: handleDistillRenew })
          : null),
      })
    } else if (effectiveTab === 'analytics') {
      right = AnalyticsView({
        sessions: orderedSessions,
        findings: allFindings,
        promptLogs: allPromptLogs,
      })
    } else if (effectiveTab === 'settings') {
      right = h(SettingsView, {
        store: services.store,
        retentionUsage,
      })
    }

    const titlesBridge = typeof props.useSessions === 'function'
      ? h(SessionsBridge, { useSessions: props.useSessions, onChange: applyTitles, onSessionsMap: setHostSessionsMap })
      : null
    const workspacesBridge = typeof props.useWorkspaces === 'function'
      ? h(WorkspacesBridge, {
          useWorkspaces: props.useWorkspaces,
          onActiveChange: setWorkspaceId,
          onItemsChange: setHostWorkspaces,
          onArchivedChange: setArchivedSessionIds,
        })
      : null

    // Determine focus title and view header descriptors
    let focusTitle = t('desk.tab.dashboard')
    let viewTitle = t('desk.view.dashboardTitle')
    let viewDesc = t('desk.view.dashboardDesc')

    if (effectiveTab === 'canvas') {
      focusTitle = selectedDraft ? (selectedDraft.title || t('desk.draft.untitled')) : t('desk.draft.new')
      viewTitle = t('desk.view.canvasTitle')
      viewDesc = t('desk.view.canvasDesc')
    } else if (effectiveTab === 'reviews') {
      focusTitle = t('desk.tab.reviews')
      viewTitle = t('desk.view.distillTitle')
      viewDesc = t('desk.view.distillDesc')
    } else if (effectiveTab === 'analytics') {
      focusTitle = t('desk.tab.analytics')
      viewTitle = t('desk.view.analyticsTitle')
      viewDesc = t('desk.view.analyticsDesc')
    } else if (effectiveTab === 'settings') {
      focusTitle = t('desk.tab.settings')
      viewTitle = t('desk.view.settingsTitle')
      viewDesc = t('desk.view.settingsDesc')
    } else if (orderedSessions.length > 0) {
      focusTitle = sessionTitle(orderedSessions[0]) || orderedSessions[0].sessionId
    }

    const countDumpRows = bucket => Object.values(bucket && typeof bucket === 'object' ? bucket : {})
      .reduce((sum, rows) => sum + (Array.isArray(rows) ? rows.length : 0), 0)

    const handleExportData = async () => {
      try {
        const dump = await services.store?.exportDump?.()
        if (!dump || typeof dump !== 'object') throw new Error(t('data.unavailable'))
        const payload = { app: 'dsh-punch-desk', version: 1, exportedAt: new Date().toISOString(), dump }
        const filename = `punch_desk-${new Date().toISOString().slice(0, 10)}.json`
        const ok = downloadText({ filename, text: JSON.stringify(payload, null, 2), mime: 'application/json' })
        setDataNotice({ error: !ok, text: ok ? t('data.exported').replace('{name}', filename) : t('data.exportFailed') })
      } catch (err) {
        setDataNotice({ error: true, text: err?.message || t('data.exportFailed') })
      }
    }

    const handleImportFile = async event => {
      const file = event?.target?.files?.[0]
      if (event?.target) event.target.value = ''
      if (!file) return
      try {
        const parsed = JSON.parse(await file.text())
        const dump = parsed && typeof parsed === 'object' && parsed.dump ? parsed.dump : parsed
        if (!dump || typeof dump !== 'object'
          || (!dump.entries && !dump.groups && !dump.promptLogs && !dump.workspaceRecords)) {
          throw new Error(t('data.invalidFile'))
        }
        setDataNotice(null)
        setPendingImport({
          file: file.name,
          dump,
          entries: countDumpRows(dump.entries),
          groups: countDumpRows(dump.groups),
          promptLogs: countDumpRows(dump.promptLogs),
        })
      } catch (err) {
        setPendingImport(null)
        setDataNotice({ error: true, text: err?.message || t('data.invalidFile') })
      }
    }

    const handleConfirmImport = async mode => {
      if (!pendingImport || dataBusy) return
      setDataBusy(true)
      try {
        const result = await services.store?.importDump?.(pendingImport.dump, mode)
        if (!result || result.ok !== true) throw new Error(result?.error || t('data.importFailed'))
        const counts = result.counts || {}
        setPendingImport(null)
        setDataNotice({
          error: false,
          text: t('data.imported')
            .replace('{entries}', String(counts.entries ?? 0))
            .replace('{groups}', String(counts.groups ?? 0))
            .replace('{logs}', String(counts.promptLogs ?? 0)),
        })
        setRefreshTick(tick => tick + 1)
        if (typeof window !== 'undefined') window.location.reload()
      } catch (err) {
        setDataNotice({ error: true, text: err?.message || t('data.importFailed') })
      } finally {
        setDataBusy(false)
      }
    }

    const handleCloseSettings = () => {
      setTab(previousTab || 'dashboard')
    }

    const settingsHeader = h('div', {
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 10,
        paddingBottom: 10,
        borderBottom: '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
        marginBottom: 10,
        flexShrink: 0,
      },
    },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        h(icons.Faders ?? icons.FadersIcon, { size: 18, color: 'var(--pd-accent, #5e81ac)' }),
        h('span', {
          style: {
            fontSize: 14,
            fontWeight: 700,
            color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #2e3440))',
          },
        }, t('desk.view.settingsTitle'))),
      h(Button, {
        icon: icons.X,
        iconOnly: true,
        variant: 'ghost',
        'aria-label': t('settings.close'),
        tip: t('settings.closeHint'),
        onClick: handleCloseSettings,
        style: { padding: 4 },
      }))

    const stageHeader = h('div', {
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 10,
        paddingBottom: 10,
        borderBottom: '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
        marginBottom: 10,
        flexShrink: 0,
      },
    },
      h('div', {
        role: 'tablist',
        style: {
          display: 'flex',
          gap: 4,
          background: 'var(--pd-bg-panel, var(--dsw-alias-bg-layer-2, #e5e9f0))',
          padding: 3,
          borderRadius: 8,
          border: '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
        },
      },
        TABS.map(item => {
          const isActive = effectiveTab === item.id
          const TabIcon = icons[item.iconName]
          // The reviews tab owns the distillation lifecycle, so it carries the
          // global indicator: a breathing forest dot while a batch runs.
          const showDistillDot = item.id === 'reviews' && Boolean(distillActiveRun)
          return h(Button, {
            key: item.id,
            role: 'tab',
            icon: TabIcon,
            'aria-selected': isActive,
            variant: isActive ? 'primary' : 'default',
            onClick: () => {
              setTab(item.id)
            },
            style: { padding: '4px 10px', fontSize: 11 },
          }, showDistillDot
            ? h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5 } },
              t(item.labelKey),
              h('span', {
                className: 'pd-breathe',
                'aria-hidden': 'true',
                style: {
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  flexShrink: 0,
                  background: distillActiveRun.status === 'ready'
                    ? 'var(--pd-status-warn, #ebcb8b)'
                    : 'var(--pd-status-running, #0e9f4f)',
                },
              }))
            : t(item.labelKey))
        })),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, position: 'relative' } },
        h('input', {
          ref: dataFileInputRef,
          type: 'file',
          accept: 'application/json,.json',
          onChange: handleImportFile,
          style: { display: 'none' },
        }),
        h(Button, {
          variant: isGitLookupOpen ? 'primary' : 'ghost',
          icon: icons.MagnifyingGlass,
          iconOnly: true,
          title: t('desk.gitLookup.title'),
          'aria-label': t('desk.gitLookup.title'),
          'aria-expanded': isGitLookupOpen,
          onClick: () => {
            setIsGitLookupOpen(prev => {
              const next = !prev
              if (next) {
                setTimeout(() => gitLookupInputRef.current?.focus?.(), 0)
              }
              return next
            })
          },
          style: { padding: 4 },
        }),
        isGitLookupOpen
          ? h('div', {
              role: 'dialog',
              'aria-label': t('desk.gitLookup.title'),
              style: {
                position: 'absolute',
                top: 'calc(100% + 6px)',
                right: 0,
                width: 340,
                maxWidth: '90vw',
                zIndex: 40,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                padding: 10,
                borderRadius: 10,
                background: 'var(--pd-bg-panel, var(--dsw-alias-bg-layer-2, #eceff4))',
                border: '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
                boxSizing: 'border-box',
              },
            },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                h('input', {
                  ref: el => {
                    gitLookupInputRef.current = el
                  },
                  type: 'text',
                  value: gitLookupQuery,
                  placeholder: t('desk.gitLookup.placeholder'),
                  'aria-label': t('desk.gitLookup.placeholder'),
                  onChange: e => {
                    const val = String(e?.target?.value ?? '')
                    gitLookupQueryRef.current = val
                    setGitLookupQuery(val)
                  },
                  onKeyDown: e => {
                    if (e?.key === 'Enter') {
                      e.preventDefault?.()
                      void handleGitLookup()
                    } else if (e?.key === 'Escape') {
                      e.preventDefault?.()
                      setIsGitLookupOpen(false)
                    }
                  },
                  style: {
                    flex: 1,
                    minWidth: 0,
                    padding: '5px 8px',
                    borderRadius: 6,
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: 12,
                    color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #2e3440))',
                    background: 'var(--pd-bg-base, var(--dsw-alias-bg-base, #ffffff))',
                    border: '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
                  },
                }),
                h(Button, {
                  variant: 'primary',
                  icon: icons.MagnifyingGlass,
                  iconOnly: true,
                  disabled: gitLookupBusy,
                  title: t('desk.gitLookup.placeholder'),
                  'aria-label': t('desk.gitLookup.placeholder'),
                  'data-action': 'git-lookup-submit',
                  onClick: () => void handleGitLookup(),
                  style: { padding: 4 },
                })),
              gitLookupError
                ? h('div', {
                    role: 'alert',
                    style: {
                      fontSize: 11,
                      color: 'var(--dsw-alias-state-danger-primary, #bf616a)',
                    },
                  }, gitLookupError)
                : null,
              gitLookupSearched && !gitLookupError && gitLookupMatches.length === 0
                ? h('div', {
                    style: {
                      fontSize: 11,
                      color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
                    },
                  }, t('desk.gitLookup.empty'))
                : null,
              gitLookupMatches.length > 0
                ? h('div', {
                    style: {
                      display: 'flex',
                      flexDirection: 'column',
                      maxHeight: 240,
                      overflowY: 'auto',
                    },
                  },
                    gitLookupMatches.map((match, idx) => {
                      const shortHash = match?.commit?.shortHash
                        || (typeof match?.commit?.hash === 'string' ? match.commit.hash.slice(0, 7) : '')
                      const subject = match?.commit?.subject || ''
                      const sTitle = sessionTitle(match?.sessionId) || match?.sessionId || ''
                      const findingCount = Array.isArray(match?.findingIds) ? match.findingIds.length : 0
                      const turnNum = match?.turn ?? 1
                      const metaLine = t('desk.gitLookup.resultMeta')
                        .replace('{session}', String(sTitle))
                        .replace('{turn}', String(turnNum))
                        .replace('{findings}', String(findingCount))
                      const capturedAtText = typeof match?.capturedAt === 'number' && match.capturedAt > 0
                        ? formatLocalDateTime(match.capturedAt)
                        : ''
                      const canOpenThis = typeof services.canOpenSession === 'function'
                        ? Boolean(services.canOpenSession())
                        : Boolean(canOpenSession)
                      const isLast = idx === gitLookupMatches.length - 1
                      return h('button', {
                        key: `${match?.traceId || idx}:${match?.commit?.hash || idx}`,
                        type: 'button',
                        disabled: !canOpenThis,
                        title: canOpenThis ? t('desk.gitLookup.openHint') : t('desk.draft.startUnavailable'),
                        'aria-label': `${shortHash} ${subject}`.trim(),
                        onClick: () => {
                          if (!canOpenThis || !match?.sessionId) return
                          openSessionAtCommit(match)
                        },
                        style: {
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 3,
                          width: '100%',
                          textAlign: 'left',
                          padding: '8px 6px',
                          background: 'transparent',
                          border: 'none',
                          borderBottom: isLast ? 'none' : '1px solid var(--pd-border-subtle, var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08)))',
                          cursor: canOpenThis ? 'pointer' : 'not-allowed',
                          opacity: canOpenThis ? 1 : 0.6,
                          boxSizing: 'border-box',
                        },
                      },
                        h('div', {
                          style: {
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            minWidth: 0,
                            width: '100%',
                          },
                        },
                          h('span', {
                            style: {
                              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                              fontSize: 11,
                              fontWeight: 600,
                              color: 'var(--pd-accent, #5e81ac)',
                              flexShrink: 0,
                            },
                          }, shortHash),
                          h('span', {
                            style: {
                              fontSize: 12,
                              fontWeight: 500,
                              color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #2e3440))',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              flex: 1,
                            },
                          }, subject)),
                        h('div', {
                          style: {
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 6,
                            fontSize: 10,
                            color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
                          },
                        },
                          h('span', null, metaLine),
                          capturedAtText
                            ? h('span', {
                                style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', flexShrink: 0 },
                              }, capturedAtText)
                            : null))
                    }))
                : null)
          : null,
        h(Button, {
          variant: 'ghost',
          icon: icons.DownloadSimple,
          title: t('data.exportTitle'),
          disabled: dataBusy,
          onClick: handleExportData,
          style: { padding: '4px 10px', fontSize: 11 },
        }, t('data.export')),
        h(Button, {
          variant: 'ghost',
          icon: icons.UploadSimple,
          title: t('data.importTitle'),
          disabled: dataBusy,
          onClick: () => dataFileInputRef.current?.click?.(),
          style: { padding: '4px 10px', fontSize: 11 },
        }, t('data.import')),
        h(Button, {
          variant: 'ghost',
          icon: Trash,
          title: t('desk.clear.title').replace('{name}', String(activeWsName)),
        onClick: () => {
          setClearNotice(null)
          setIsClearModalOpen(true)
        },
          style: { padding: '4px 10px', fontSize: 11, color: 'var(--dsw-alias-state-danger-primary, #bf616a)' },
        }, t('desk.clear.action'))))

    const handleExecuteClear = async () => {
      const { clearFindings, clearGroups, clearPromptLogs, clearDrafts, preservePinned } = clearOptions
      if (!clearFindings && !clearGroups && !clearPromptLogs && !clearDrafts) {
        setClearNotice({ error: true, text: t('clear.noneSelected') })
        return
      }

      setClearing(true)
      setClearNotice(null)

      try {
        const currentWsSessionIds = filteredSessions.map(s => s.sessionId)
        const hostSessionIds = (allWorkspaces.find(w => w.id === activeWsId)?.sessionIds || [])
        const targetSessionIds = [...new Set([...currentWsSessionIds, ...hostSessionIds])]

        if (services.store?.clearWorkspaceData) {
          await services.store.clearWorkspaceData(activeWsId, {
            preservePinned,
            sessionIds: targetSessionIds,
            clearFindings,
            clearGroups,
            clearPromptLogs,
            clearDrafts,
          })
        } else if (services.store?.clearCache) {
          await services.store.clearCache()
        }
        setRefreshTick(t => t + 1)
        setIsClearModalOpen(false)
        if (typeof window !== 'undefined') window.location.reload()
      } catch (err) {
        setClearNotice({ error: true, text: err?.message || t('desk.clear.failed') })
      } finally {
        setClearing(false)
      }
    }

    // Shared clear-data dialog (P1-8 dedupe): one renderer for Desk + Session Pane.
    const clearModal = createClearDataModal({ h, t, Button, Trash, X: icons.X })

    const dataBar = (dataNotice || pendingImport)
      ? h('div', {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: '6px 10px',
            marginBottom: 8,
            borderRadius: 8,
            fontSize: 11,
            background: 'var(--pd-bg-panel, var(--dsw-alias-bg-layer-2, #e5e9f0))',
            border: '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
          },
        },
          dataNotice
            ? h('div', { role: dataNotice.error ? 'alert' : 'status', style: { color: dataNotice.error ? 'var(--dsw-alias-state-danger-primary, #bf616a)' : 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #434c5e))' } }, dataNotice.text)
            : null,
          pendingImport
            ? h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' } },
                h('span', { style: { color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #434c5e))' } },
                  t('data.pending')
                    .replace('{file}', pendingImport.file)
                    .replace('{entries}', String(pendingImport.entries))
                    .replace('{groups}', String(pendingImport.groups))
                    .replace('{logs}', String(pendingImport.promptLogs))),
                h('div', { style: { display: 'flex', gap: 6, flexShrink: 0 } },
                  h(Button, {
                    icon: icons.CheckCircle,
                    disabled: dataBusy,
                    onClick: () => handleConfirmImport('merge'),
                    style: { fontSize: 11 },
                  }, t('data.merge')),
                  h(Button, {
                    variant: 'danger',
                    icon: icons.ArrowCounterClockwise,
                    disabled: dataBusy,
                    onClick: () => handleConfirmImport('replace'),
                    style: { fontSize: 11 },
                  }, t('data.replace')),
                  h(Button, {
                    variant: 'ghost',
                    icon: icons.X,
                    disabled: dataBusy,
                    onClick: () => setPendingImport(null),
                    style: { fontSize: 11 },
                  }, t('clear.cancelBtn'))))
            : null)
      : null

    // Global distillation banner: one line, actionable, dismissible. Rendered
    // above every non-reviews view so "why is my submission paused?" is answered
    // where the user actually is, not in a tab they never opened.
    const distillStageText = distillActiveRun
      ? (DISTILL_STAGE_LABEL_KEYS[distillActiveRun.stage]
        || DISTILL_STAGE_LABEL_KEYS[distillActiveRun.status])
        ? t(DISTILL_STAGE_LABEL_KEYS[distillActiveRun.stage]
          || DISTILL_STAGE_LABEL_KEYS[distillActiveRun.status])
        : t(`distill.view.run.status.${distillActiveRun.status}`)
      : ''
    const distillBanner = distillActiveRun && !distillBannerDismissed && effectiveTab !== 'reviews'
      ? h('div', {
          role: 'status',
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 8,
            padding: '5px 10px',
            marginBottom: 8,
            borderRadius: 8,
            background: 'var(--pd-bg-panel, var(--dsw-alias-bg-layer-2, #e5e9f0))',
            border: '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
            borderLeft: `2px solid ${distillActiveRun.status === 'ready'
              ? 'var(--pd-status-warn, #ebcb8b)'
              : 'var(--pd-status-running, #0e9f4f)'}`,
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flexWrap: 'wrap' } },
            h('span', {
              className: 'pd-breathe',
              'aria-hidden': 'true',
              style: {
                width: 7,
                height: 7,
                borderRadius: '50%',
                flexShrink: 0,
                background: distillActiveRun.status === 'ready'
                  ? 'var(--pd-status-warn, #ebcb8b)'
                  : 'var(--pd-status-running, #0e9f4f)',
              },
            }),
            h('span', {
              style: {
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #2e3440))',
              },
            }, distillActiveRun.status === 'ready'
              ? t('distill.banner.ready')
              : t('distill.banner.running').replace('{stage}', distillStageText)),
            h('span', {
              style: {
                fontSize: 10,
                color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
              },
            }, t('distill.banner.submitPaused'))),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 } },
            h(Button, {
              variant: 'ghost',
              icon: icons.ArrowRight,
              onClick: () => setTab('reviews'),
              style: { fontSize: 11 },
            }, t('distill.banner.open')),
            h(Button, {
              variant: 'ghost',
              icon: icons.X,
              iconOnly: true,
              title: t('distill.banner.dismiss'),
              'aria-label': t('distill.banner.dismiss'),
              onClick: () => setDistillBannerDismissed(true),
              style: { padding: 3 },
            })))
      : null

    return h('div', { style: PAGE_STYLE },
      titlesBridge,
      workspacesBridge,
      quotaWarning
        ? h('div', { role: 'alert', style: WARNING_STYLE },
          h('div', { style: WARNING_TEXT_STYLE }, t('store.quota')))
        : null,
      loaded
        ? h('div', { style: BODY_STYLE },
            left,
            h('div', { style: { ...RIGHT_STYLE, display: 'flex', flexDirection: 'column' } },
              isSettingsActive ? settingsHeader : stageHeader,
              isSettingsActive ? null : dataBar,
              distillBanner,
              h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto' } }, right)))
        : h(Empty, null, t('tab.placeholder')),
      isClearModalOpen
        ? clearModal({
            titleSuffix: activeWsName,
            clearOptions,
            setClearOptions,
            clearing,
            notice: clearNotice,
            onClose: () => { setIsClearModalOpen(false); setClearNotice(null) },
            onConfirm: handleExecuteClear,
          })
        : null)
  }
}
