import { createDraft } from '../domain/desk.js'
import { createEntry } from '../domain/entries.js'
import { NS, dictionaries } from '../locale.js'
import { COMMAND_CATALOG, SKILL_CATALOG, toCatalogItems } from './catalog.js'
import { createLocalDeskStore } from '../store/local.js'
import { hasLegacyLocalStorageData, migrateLocalStorageIfNeeded } from '../store/migrate.js'
import { backfillSession } from './platform/backfill.js'
import { createPromptIndex } from './platform/prompt-index.js'
import { resolveTargetWorkspace, startFromDraft } from './platform/session-start.js'
import { createSubmitService } from './platform/submit.js'
import { createSubmissionSeqAllocator } from './platform/submission-seq.js'
import { createGitApi } from './platform/git-api.js'
import { createCommitTraceTracker } from './platform/commit-traces.js'
import { createTurnActionsTracker } from './platform/turn-actions.js'
import { openSessionPane, registerSeats } from './platform/register.js'
import { registerCaptureActions } from './ui/capture-actions.js'
import { registerQuoteInteraction } from './ui/quote-interaction.js'
import { createComposerBridge, registerComposerBridge } from './ui/composer-bridge.js'
import { createDeskPage } from './ui/desk.js'
import { createSessionPane } from './ui/session-pane.js'
import { setPendingCommitFocus, subscribePendingCommitFocus, takePendingCommitFocus } from './ui/bits.js'
import { createTipH, installTooltipLayer } from './ui/tooltip-layer.js'
import { BookmarkSimple, Kanban, PunchDeskLogoColor, PunchDeskLogoMono, setDefaultH } from './ui/icons.js'
import { injectPunchDeskStyles } from './ui/nord.js'

/**
 * Capture payloads waiting for a session pane to mount, keyed by session id.
 * Module-level so a capture that opens the tab survives that tab's first mount.
 * @type {Map<string, {kind: 'message'|'turn', messageId?: string, turn?: number, seq?: number}>}
 */
const pending = new Map()

/** Finding bucket key of one session (entries are stored per session, not per group). */
function sessionBucketKey(sessionId) {
  return `session:${sessionId}`
}

/**
 * Wire the acceptance-evidence path of the submit service
 * (Group Turn Attribution plan Phase 2 / B9, T-GTA-24/25/26).
 *
 * `submissionSeq` is allocated per session, serially, as
 * `persisted max + still-open reservations + 1` — there is no persisted counter
 * of its own. `readMax` derives the persisted maximum from the session's own
 * finding bucket, so a reload continues above it instead of reissuing a number.
 *
 * `onAccepted` runs inside the allocator's critical section (submit.js passes
 * it as the task) and persists `acceptedAt` + `submissionSeq` on every finding
 * of the accepted batch, resolving only after the writes landed. A throw keeps
 * the reservation and surfaces as `evidencePending` on an otherwise accepted
 * result: the prompt has already left the client, so it is never resent — only
 * the evidence write is retried (allocator `retry`, same requestId/seq).
 *
 * @param {{ store: { listEntries?: Function, putEntry?: Function } }} deps
 * @returns {{
 *   submissionSeqAllocator: ReturnType<typeof createSubmissionSeqAllocator>,
 *   onAccepted: (info: { sessionId: string, entries?: object[], acceptedAt?: number, submissionSeq?: number }) => Promise<{ updated: number }>,
 * }}
 */
export function createAcceptanceEvidenceWiring({ store } = {}) {
  /**
   * Highest `submissionSeq` persisted for this session's findings.
   * @param {string} sessionId
   * @returns {Promise<number>}
   */
  async function readMax(sessionId) {
    if (!store || typeof store.listEntries !== 'function') {
      throw new Error('store.listEntries is required to read the persisted submissionSeq max')
    }
    const rows = await store.listEntries(sessionBucketKey(sessionId))
    let max = 0
    for (const row of Array.isArray(rows) ? rows : []) {
      const seq = Number(row?.submissionSeq)
      if (Number.isInteger(seq) && seq > max) max = seq
    }
    return max
  }

  /**
   * Persist the accepted-evidence pair on every finding of one accepted batch.
   * @param {{ sessionId: string, entries?: object[], acceptedAt?: number, submissionSeq?: number }} info
   * @returns {Promise<{ updated: number }>}
   */
  async function onAccepted({ sessionId, entries, acceptedAt, submissionSeq } = {}) {
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new Error('onAccepted requires a sessionId')
    }
    if (!Number.isInteger(submissionSeq) || submissionSeq <= 0) {
      throw new Error('onAccepted requires the allocated submissionSeq')
    }
    if (typeof acceptedAt !== 'number' || !Number.isFinite(acceptedAt) || acceptedAt < 0) {
      throw new Error('onAccepted requires the acceptedAt timestamp')
    }
    if (!store || typeof store.putEntry !== 'function') {
      throw new Error('store.putEntry is required to persist the acceptance evidence')
    }
    const list = Array.isArray(entries) ? entries : []
    let updated = 0
    for (const entry of list) {
      if (!entry || typeof entry.id !== 'string' || entry.id === '') continue
      const workspaceKey = typeof entry.workspaceKey === 'string' && entry.workspaceKey !== ''
        ? entry.workspaceKey
        : sessionBucketKey(sessionId)
      // Await every write: the allocator releases the reservation only once the
      // whole batch is durable, otherwise two acceptances could share a seq.
      await store.putEntry({ ...entry, workspaceKey, acceptedAt, submissionSeq, updatedAt: acceptedAt })
      updated += 1
    }
    if (updated === 0) throw new Error('onAccepted received no persistable finding')
    return { updated }
  }

  return {
    submissionSeqAllocator: createSubmissionSeqAllocator({ readMax }),
    onAccepted,
  }
}

export function createFactory(require) {
  const React = require('react')
  // Every tooltip is self-drawn: native `title` is converted to data-pd-tip at
  // the single hyperscript boundary, so no call site can regress to the host's
  // delayed/absent native tooltip.
  const h = createTipH(React.createElement)
  setDefaultH(h)

  // Entrance 1 (Left sidebar panellist): Punch Desk Logo (Mono currentColor)
  function DeskIcon({ size = 18, ...rest } = {}) {
    return PunchDeskLogoMono({ size, h, color: 'currentColor', ...rest })
  }

  // Entrance 2 (Session drawer / tab / '+' start menu / Guide): Punch Desk Logo (Color)
  function DrawerIcon({ size = 18, ...rest } = {}) {
    return PunchDeskLogoColor({ size, h, ...rest })
  }

  function PanelIcon({ size = 18, ...rest } = {}) {
    return PunchDeskLogoColor({ size, h, ...rest })
  }

  return {
    inject: ['slots', 'locale', 'remote', 'remote.session'],
    apply(ctx) {
      injectPunchDeskStyles()
      installTooltipLayer()
      const dicts = dictionaries()
      ctx.effect(() => ctx.locale.register(NS, dicts), 'punch-desk: locale')
      ctx.effect(() => {
        injectPunchDeskStyles()
      }, 'punch-desk: theme styles')
      const t = ctx.locale.bind(NS)

      const store = createLocalDeskStore()

      // Legacy localStorage holds the only copy of data written before the Host
      // store existed. It may only be removed after a read-back-verified Host
      // import; a failed migration keeps the source intact AND reads through it
      // so the desk still shows the user's data instead of an empty page.
      let legacyFallbackAttached = false
      const useLegacyFallback = reason => {
        try {
          if (
            typeof window !== 'undefined'
            && window.localStorage
            && hasLegacyLocalStorageData(window.localStorage)
            && store.attachLegacyStorage?.(window.localStorage)
          ) {
            legacyFallbackAttached = true
          }
        } catch {}
        console.warn('[punch-desk] Host storage unavailable; keeping and reading legacy localStorage data for retry.', reason)
      }
      const releaseLegacyFallback = () => {
        if (!legacyFallbackAttached) return
        try { store.detachLegacyStorage?.() } catch {}
        legacyFallbackAttached = false
      }
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
      const hydrateWithRetry = async () => {
        let ok = await store.whenHydrated?.()
        if (ok) return true
        for (const delay of [600, 1800, 4000]) {
          await sleep(delay)
          try { ok = await store.hydrate?.() } catch { ok = false }
          if (ok) return true
        }
        return false
      }

      // One-time migration from legacy localStorage to Host Store. Source data
      // is purged only by migrateLocalStorageIfNeeded after it has independently
      // read the imported rows back from the Host.
      if (typeof window !== 'undefined' && window.localStorage) {
        migrateLocalStorageIfNeeded({
          storage: window.localStorage,
          fetch: globalThis.fetch,
        }).then(result => {
          if (result?.migrated) {
            releaseLegacyFallback()
            return store.hydrate?.()
          }
          if (result?.ok === false) {
            // A failed or unverified migration must never delete the source.
            useLegacyFallback(result.error || 'migration failed')
          }
          return undefined
        }).catch(error => {
          useLegacyFallback(error?.message || String(error))
        })
      }

      // The client half can mount before the Host routes are ready (or while the
      // Host half still runs an older bundle). Retry hydration so a transient
      // 404 never leaves the desk permanently empty for the whole session.
      hydrateWithRetry().then(ok => {
        if (!ok) useLegacyFallback('host hydration failed')
      }).catch(() => {})
      /** @type {Set<(sessionId: string) => void>} */
      const captureListeners = new Set()

      // Expose one-click workspace clear helper for development / test cleanup
      if (typeof window !== 'undefined') {
        window.clearPunchDeskData = async (targetWs) => {
          const activeWs = targetWs || (typeof services.getActiveWorkspaceId === 'function' ? services.getActiveWorkspaceId() : undefined)
          if (activeWs && store?.clearWorkspaceData) {
            await store.clearWorkspaceData(activeWs, { preservePinned: true })
            console.log(`[punch-desk] Workspace ${activeWs} cleared (pinned preserved)!`)
          } else if (store?.clearCache) {
            await store.clearCache()
            console.log('[punch-desk] All test data and localStorage cleared!')
          }
          window.location.reload()
        }
      }
      const resolveWorkspaceId = (sessionId) => {
        try {
          const uiWorkspace = ctx.get?.('uiWorkspace')
          if (!uiWorkspace) return undefined
          const items = uiWorkspace.workspaces?.list?.getSnapshot?.()?.items
          if (Array.isArray(items)) {
            const found = items.find(it => Array.isArray(it.sessionIds) && it.sessionIds.includes(sessionId))
            if (found) return found.workspaceId || found.id
          }
          const byId = uiWorkspace.sessions?.list?.getSnapshot?.()?.byId
          if (byId && byId[sessionId]?.workspaceId) {
            return byId[sessionId].workspaceId
          }
        } catch {
          return undefined
        }
        return undefined
      }

      const git = createGitApi({ fetch: (...args) => globalThis.fetch(...args) })
      const tracker = createCommitTraceTracker({
        remote: ctx.remote,
        git,
        store,
        resolveWorkspaceId,
        uuid: () => globalThis.crypto.randomUUID(),
      })
      ctx.effect(() => () => tracker.dispose(), 'punch-desk: commit-trace tracker')

      const turnActionsTracker = createTurnActionsTracker({
        remote: ctx.remote,
        store,
        fetchRoute: (path, init) => {
          if (typeof globalThis.fetch === 'function') {
            return globalThis.fetch(path, init)
          }
          return Promise.reject(new Error('no fetch available'))
        },
        services: null,
        now: Date.now,
      })
      ctx.effect(() => () => turnActionsTracker.dispose(), 'punch-desk: turn-actions tracker')

      // Acceptance evidence (`acceptedAt` + `submissionSeq`) is written only
      // after `prompt()` resolved accepted, per session, inside the allocator's
      // critical section. See createAcceptanceEvidenceWiring.
      const acceptanceEvidence = createAcceptanceEvidenceWiring({ store })

      const services = {
        store,
        t,
        git,
        commitTraces: {
          retryTrace: args => tracker.retryTrace(args),
        },
        turnActionsTracker,
        remote: ctx.remote,
        uuid: () => globalThis.crypto.randomUUID(),
        submit: createSubmitService({
          remote: ctx.remote,
          onPrepare: args => tracker.prepareSubmission(args),
          // The trace observer must still see the acceptance when the evidence
          // write fails (B7 fallback); persistence runs right after it.
          onAccepted: async args => {
            tracker.noteAccepted(args)
            await acceptanceEvidence.onAccepted(args)
          },
          onDiscard: args => tracker.discard(args),
          submissionSeqAllocator: acceptanceEvidence.submissionSeqAllocator,
        }),
        /**
         * Retry the blocked acceptance-evidence write of one session with its
         * reserved sequence. This never sends a prompt again: the accepted
         * prompt keeps its original requestId forever.
         * @param {string} sessionId
         */
        retrySubmissionEvidence: sessionId => acceptanceEvidence.submissionSeqAllocator.retry(sessionId),
        index: createPromptIndex({ remote: ctx.remote, store }),
        /**
         * Backfill one session's historical prompt rows. The remote and store
         * are fixed here so UI code never reaches for them itself.
         * @param {{ sessionId: string, workspaceKey: string, limit?: number }} input
         * @returns {Promise<object>}
         */
        backfillSession: input => backfillSession({
          ...(input ?? {}),
          remote: ctx.remote,
          store,
        }),
        createFinding: input => createEntry({ kind: 'finding', status: 'open', ...input }),
        createDraft: input => createDraft(input),
        openSessionPane: () => openSessionPane(ctx),
        resolveWorkspaceId,
        getSessionTitles: () => {
          try {
            const uiWorkspace = ctx.get?.('uiWorkspace')
            const byId = uiWorkspace?.sessions?.list?.getSnapshot?.()?.byId
            return byId && typeof byId === 'object' ? byId : {}
          } catch {
            return {}
          }
        },
        getActiveSessionId: () => {
          try {
            const uiWorkspace = ctx.get?.('uiWorkspace')
            return uiWorkspace?.mainReference?.sessionId || undefined
          } catch {
            return undefined
          }
        },
        getActiveWorkspaceId: () => {
          try {
            const uiWorkspace = ctx.get?.('uiWorkspace')
            if (!uiWorkspace) return undefined
            const resolved = resolveTargetWorkspace(uiWorkspace)
            if (resolved) return resolved
            const snap = uiWorkspace.workspaces?.list?.getSnapshot?.()
            const active = snap?.activeWorkspaceId || snap?.selectedWorkspaceId || snap?.currentWorkspaceId
            if (active) return active
            const currentSessionId = uiWorkspace.mainReference?.sessionId
            const items = Array.isArray(snap?.items) ? snap.items : []
            if (currentSessionId && items.length > 0) {
              const matched = items.find(w => Array.isArray(w.sessionIds) && w.sessionIds.includes(currentSessionId))
              if (matched) return matched.workspaceId || matched.id
            }
          } catch {}
          return undefined
        },
        getHostWorkspaces: () => {
          try {
            const uiWorkspace = ctx.get?.('uiWorkspace')
            const items = uiWorkspace?.workspaces?.list?.getSnapshot?.()?.items
            if (Array.isArray(items)) return items
          } catch {}
          return []
        },
        listCommands: async (sessionId) => {
          const builtinCommands = toCatalogItems(COMMAND_CATALOG, t)

          try {
            if (ctx.remote?.commands?.list && sessionId) {
              const res = await ctx.remote.commands.list(sessionId)
              if (res && res.ok && Array.isArray(res.value)) {
                const map = new Map()
                for (const b of builtinCommands) map.set(b.name, b)
                for (const c of res.value) {
                  if (!c || !c.name) continue
                  const existing = map.get(c.name)
                  map.set(c.name, {
                    name: c.name,
                    label: `/${c.name}`,
                    description: c.description || existing?.description || t('command.fallback').replace('{name}', c.name),
                    insert: `/${c.name} `,
                  })
                }
                return Array.from(map.values())
              }
            }
          } catch {
            // fallback to builtin
          }
          return builtinCommands
        },
        listSkills: async (sessionId) => {
          const builtinSkills = toCatalogItems(SKILL_CATALOG, t)

          try {
            if (ctx.remote?.skills?.list && sessionId) {
              const res = await ctx.remote.skills.list(sessionId)
              if (res && res.ok && Array.isArray(res.value)) {
                const map = new Map()
                for (const b of builtinSkills) map.set(b.name, b)
                for (const s of res.value) {
                  if (!s || !s.name) continue
                  const existing = map.get(s.name)
                  map.set(s.name, {
                    name: s.name,
                    label: `/${s.name}`,
                    description: s.description || existing?.description || t('skill.fallback').replace('{name}', s.name),
                    insert: `/${s.name} `,
                  })
                }
                return Array.from(map.values())
              }
            }
          } catch {}

          return builtinSkills
        },
        listFilesAndSessions: async (sessionId, query = '') => {
          const files = []
          const sessions = []

          // 1. Files from host workspace-files endpoint or host fileReferences
          const activeWsId = services.getActiveWorkspaceId?.()
          const wsParam = activeWsId ? `workspaceId=${encodeURIComponent(activeWsId)}` : 'workspaceId=default'
          const queryParam = query ? `&query=${encodeURIComponent(query)}` : ''
          try {
            const res = await fetch(`api/punch-desk/workspace-files?${wsParam}${queryParam}`)
            if (res.ok) {
              const data = await res.json()
              if (data.ok && Array.isArray(data.files)) {
                for (const f of data.files) {
                  files.push({
                    type: 'file',
                    name: f.name || f.path,
                    path: f.path || f.name,
                    description: f.kind === 'directory' ? t('file.directory') : (f.path || f.name),
                    kind: f.kind || 'file',
                    insert: `@${f.path || f.name} `,
                  })
                }
              }
            }
          } catch {}

          if (files.length === 0) {
            try {
              if (ctx.remote?.fileReferences?.list && sessionId) {
                const res = await ctx.remote.fileReferences.list(sessionId, query)
                if (res && res.ok && Array.isArray(res.value)) {
                  for (const f of res.value) {
                    files.push({
                      type: 'file',
                      name: f.name || f.path,
                      path: f.path || f.name,
                      description: f.kind === 'directory' ? t('file.directory') : (f.description || f.path),
                      kind: f.kind || 'file',
                      insert: `@${f.path || f.name} `,
                    })
                  }
                }
              }
            } catch {}
          }

          // Fallback workspace common files
          if (files.length === 0) {
            const fallbackFiles = [
              { name: 'AGENTS.md', path: 'AGENTS.md', description: t('mention.file.agents') },
              { name: 'README.md', path: 'README.md', description: t('mention.file.readme') },
              { name: 'package.json', path: 'package.json', description: t('mention.file.packageJson') },
              { name: 'src/', path: 'src/', description: t('mention.file.src'), kind: 'directory' },
            ]
            for (const ff of fallbackFiles) {
              files.push({
                type: 'file',
                name: ff.name,
                path: ff.path,
                description: ff.description,
                kind: ff.kind || 'file',
                insert: `@${ff.path} `,
              })
            }
          }

          // 2. Sessions (from uiWorkspace)
          try {
            const uiWorkspace = ctx.get?.('uiWorkspace')
            const byId = uiWorkspace?.sessions?.list?.getSnapshot?.()?.byId
            if (byId && typeof byId === 'object') {
              for (const [sid, s] of Object.entries(byId)) {
                if (!s || s.removed) continue
                const title = s.title || t('session.untitled').replace('{id}', sid.slice(0, 8))
                sessions.push({
                  type: 'session',
                  sessionId: sid,
                  id: sid,
                  name: title,
                  title,
                  description: sid === sessionId ? t('session.current') : t('session.other').replace('{id}', sid.slice(0, 6)),
                  insert: `@[${title}] `,
                })
              }
            }
          } catch {}

          return { files, sessions }
        },
      }

      /**
       * Flow A/B: create a session from a draft, then either park the composer
       * handoff (prefill) or queue the body as its first prompt (auto).
       * `uiWorkspace` stays optional and is resolved lazily, matching
       * `openSession` below.
       * @param {{ draft: object, behavior?: 'prefill'|'auto', workspaceId?: string }} input
       * @returns {Promise<import('./platform/session-start.js').StartFromDraftResult>}
       */
      services.startFromDraft = input => startFromDraft({
        ...(input ?? {}),
        uiWorkspace: ctx.get?.('uiWorkspace'),
        store,
        remote: ctx.remote,
        uuid: services.uuid,
      })

      // uiWorkspace is optional: this Cordis inject map only declares required
      // services, so resolve it lazily and let the card show a disabled state
      // when the ui-workspace plugin is not in the composition.
      services.canOpenSession = () => {
        const uiWorkspace = ctx.get?.('uiWorkspace')
        return Boolean(uiWorkspace && typeof uiWorkspace.openSession === 'function')
      }

      /**
       * Registry-global archived Session ids, read from the optional uiWorkspace
       * snapshot. Defensive by design: an absent service or an older snapshot
       * shape yields an empty list, which only means no Session is projected as
       * archived (no behavior change from before the field existed).
       * @returns {string[]}
       */
      services.getArchivedSessionIds = () => {
        try {
          const uiWorkspace = ctx.get?.('uiWorkspace')
          const snapshot = uiWorkspace?.workspaces?.list?.getSnapshot?.()
          const ids = snapshot?.archivedSessionIds
          return Array.isArray(ids) ? ids.filter(id => typeof id === 'string' && id !== '') : []
        } catch {
          return []
        }
      }

      /**
       * Subscribe to workspace snapshot changes (the archive set included).
       * Returns an unsubscribe; a missing subscription leaves consumers on the
       * one-shot read instead of failing.
       * @param {() => void} listener
       * @returns {() => void}
       */
      services.subscribeWorkspaceSnapshot = listener => {
        if (typeof listener !== 'function') return () => {}
        try {
          const uiWorkspace = ctx.get?.('uiWorkspace')
          const list = uiWorkspace?.workspaces?.list
          if (typeof list?.subscribe === 'function') {
            const unsubscribe = list.subscribe(listener)
            return typeof unsubscribe === 'function' ? unsubscribe : () => {}
          }
        } catch {}
        return () => {}
      }

      /**
       * Open a session in the main view. Returns whether the optional service
       * accepted the request so the card can explain a disabled/unavailable state.
       * An archived Session is refused here: the host keeps it out of grouping
       * surfaces until it is unarchived.
       * @param {string} sessionId
       * @returns {boolean}
       */
      services.openSession = sessionId => {
        if (typeof sessionId !== 'string' || sessionId === '') return false
        if (services.getArchivedSessionIds().includes(sessionId)) return false
        const uiWorkspace = ctx.get?.('uiWorkspace')
        if (!uiWorkspace || typeof uiWorkspace.openSession !== 'function') return false
        try {
          uiWorkspace.openSession(sessionId)
          turnActionsTracker.ensureObserver(sessionId)
          return true
        } catch (error) {
          console.warn('[punch-desk] uiWorkspace.openSession failed', error)
          return false
        }
      }

      // Track active session changes and visibility restore for turn actions
      let currentTrackedSessionId = undefined
      const syncActiveSession = () => {
        const activeId = services.getActiveSessionId?.()
        if (activeId && activeId !== currentTrackedSessionId) {
          if (currentTrackedSessionId) {
            turnActionsTracker.close(currentTrackedSessionId)
          }
          currentTrackedSessionId = activeId
          turnActionsTracker.ensureObserver(activeId)
        }
      }

      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        const handleVisibilityChange = () => {
          if (document.visibilityState === 'visible') {
            const activeId = services.getActiveSessionId?.()
            if (activeId) {
              turnActionsTracker.ensureObserver(activeId)
            }
          }
        }
        document.addEventListener('visibilitychange', handleVisibilityChange)
        ctx.effect(() => () => {
          document.removeEventListener('visibilitychange', handleVisibilityChange)
        }, 'punch-desk: turn-actions visibility listener')
      }

      try {
        const uiWs = ctx.get?.('uiWorkspace')
        if (uiWs?.sessions?.list?.subscribe) {
          const unsub = uiWs.sessions.list.subscribe(() => {
            syncActiveSession()
          })
          if (typeof unsub === 'function') {
            ctx.effect(() => () => unsub(), 'punch-desk: turn-actions session subscription')
          }
        }
      } catch {}

      /**
       * Store a capture and wake any mounted pane for that session. A mounted
       * pane takes the value from the map, so the handoff is consumed once.
       * @param {string} sessionId
       * @param {object} value
       */
      services.setPendingCapture = (sessionId, value) => {
        pending.set(sessionId, value)
        for (const listener of captureListeners) {
          try {
            listener(sessionId)
          } catch (error) {
            console.warn('[punch-desk] pending capture listener failed', error)
          }
        }
      }

      /**
       * Take the pending capture for a session, if any.
       * @param {string} sessionId
       * @returns {object|null}
       */
      services.takePendingCapture = sessionId => {
        const value = pending.get(sessionId)
        pending.delete(sessionId)
        return value ?? null
      }

      /**
       * Observe captures for already-mounted panes (`keepMounted` keeps the tab
       * alive, so mount-time consumption alone would drop later captures).
       * @param {(sessionId: string) => void} listener
       * @returns {() => void} unsubscribe
       */
      services.subscribePendingCapture = listener => {
        captureListeners.add(listener)
        return () => {
          captureListeners.delete(listener)
        }
      }

      /**
       * Park a capture, then open the pane so it can consume the anchor.
       * @param {string} sessionId
       * @param {object} value
       */
      services.openCapture = (sessionId, value) => {
        services.setPendingCapture(sessionId, value)
        openSessionPane(ctx)
      }

      services.setPendingCommitFocus = (sessionId, payload) => {
        setPendingCommitFocus(sessionId, payload)
      }
      services.takePendingCommitFocus = sessionId => takePendingCommitFocus(sessionId)
      services.subscribePendingCommitFocus = listener => subscribePendingCommitFocus(listener)

      const SessionPane = createSessionPane({ h, React, services })
      const DeskPage = createDeskPage({ h, React, services })
      registerSeats(ctx, { h, t, NS, SessionPane, DeskPage, PanelIcon, DeskIcon, DrawerIcon })
      registerCaptureActions(ctx, { h, t, NS, services })
      registerQuoteInteraction(ctx, { h, t, NS, services })

      // Session-scoped bridge: the Desk cannot reach the composer, this dock
      // entry can. It renders nothing, so registration is safe on every host.
      const ComposerBridge = createComposerBridge({ h, React, services })
      registerComposerBridge(ctx, { NS, ComposerBridge })
    },
  }
}
