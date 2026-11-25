/**
 * Turn Actions tracker for Punch Desk.
 * Observes session live event streams to derive TurnDigest action items,
 * and maintains resilient recovery via Host scan route and events replay.
 */

import { deriveTurnDigests, mergeTurnActionItems } from '../../domain/turn-actions.js'

/**
 * Creates a turn action tracker instance.
 *
 * @param {object} deps
 * @param {object} deps.remote Remote session client (observeEvent, events, etc.)
 * @param {import('../../store/contract.js').DeskStore} deps.store Client DeskStore
 * @param {Function} [deps.fetchRoute] Custom fetch function for Host HTTP routes
 * @param {object} [deps.services] Client services context
 * @param {() => number} [deps.now] Clock function
 * @returns {object} Turn actions tracker instance
 */
export function createTurnActionsTracker({
  remote,
  store,
  fetchRoute,
  services,
  now = Date.now,
}) {
  /** @type {Map<string, AbortController>} Keyed by sessionId */
  const controllers = new Map()

  /** @type {Map<string, { turn?: number, events: object[] }>} Keyed by sessionId */
  const turnBuffers = new Map()

  let disposed = false
  let tail = Promise.resolve()

  /**
   * Serialize write mutations so parallel events cannot clobber items.
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  function enqueue(task) {
    const result = tail.then(task, task)
    tail = result.then(() => undefined, () => undefined)
    return result
  }

  /**
   * Fetch session events as fallback if Host scan route is unavailable or fails.
   * @param {string} sessionId
   * @param {AbortSignal} [signal]
   * @returns {Promise<object[]>}
   */
  async function fetchSessionEventsFallback(sessionId, signal) {
    const session = remote?.session
    if (!session) return []
    const address = { kind: 'session', sessionId }
    let records = []
    try {
      if (session.events && typeof session.events.page === 'function') {
        const res = await session.events.page({ address, limit: 100 }, signal)
        const page = res?.value ?? res
        records = Array.isArray(page) ? page : (Array.isArray(page?.records) ? page.records : (Array.isArray(page?.events) ? page.events : []))
      } else if (typeof session.events === 'function') {
        const res = await session.events({ address, maxMessages: 100 }, signal)
        const page = res?.value ?? res
        records = Array.isArray(page) ? page : (Array.isArray(page?.records) ? page.records : (Array.isArray(page?.events) ? page.events : []))
      }
    } catch {
      records = []
    }
    return records
  }

  /**
   * Read promptLogs and findings from store to feed into deriveTurnDigests.
   * @param {string} sessionId
   * @returns {Promise<{ promptLogTurns: Map<number, object>, findingsByRequest: Map<string, object[]>, includeTextHeuristic: boolean }>}
   */
  async function loadContextData(sessionId) {
    const workspaceKey = `session:${sessionId}`
    const promptLogTurns = new Map()
    const findingsByRequest = new Map()
    let includeTextHeuristic = false

    try {
      const logs = (typeof store?.listPromptLog === 'function')
        ? (await store.listPromptLog(workspaceKey).catch(() => []))
        : []
      for (const log of logs || []) {
        if (typeof log?.turn === 'number') {
          promptLogTurns.set(log.turn, log)
        }
      }
    } catch {}

    try {
      const entries = (typeof store?.listFindings === 'function')
        ? (await store.listFindings(workspaceKey).catch(() => []))
        : ((typeof store?.listEntries === 'function') ? (await store.listEntries(workspaceKey).catch(() => [])) : [])
      for (const entry of entries || []) {
        const reqId = entry?.requestId || entry?.batchId
        if (reqId) {
          const list = findingsByRequest.get(reqId) || []
          list.push(entry)
          findingsByRequest.set(reqId, list)
        }
      }
    } catch {}

    try {
      const prefs = typeof store?.getPrefs === 'function' ? await store.getPrefs().catch(() => null) : null
      if (prefs && typeof prefs.includeTextHeuristic === 'boolean') {
        includeTextHeuristic = prefs.includeTextHeuristic
      }
    } catch {}

    return { promptLogTurns, findingsByRequest, includeTextHeuristic }
  }

  /**
   * Settle a completed turn's buffered events, derive items, and persist to store.
   * @param {string} sessionId
   * @param {{ turn?: number, events: object[] }} buf
   */
  async function settleTurnBuffer(sessionId, buf) {
    if (!sessionId || !buf || !Array.isArray(buf.events) || buf.events.length === 0) return

    await enqueue(async () => {
      const { promptLogTurns, findingsByRequest, includeTextHeuristic } = await loadContextData(sessionId)
      const workspaceKey = `session:${sessionId}`

      const digests = deriveTurnDigests(buf.events, {
        sessionId,
        workspaceKey,
        promptLogTurns,
        findingsByRequest,
        includeTextHeuristic,
      })

      const incomingItems = []
      for (const d of digests) {
        if (Array.isArray(d?.items)) {
          incomingItems.push(...d.items)
        }
      }

      const sessionKey = `session:${sessionId}`
      const currentState = (typeof store?.listTurnActions === 'function')
        ? (await store.listTurnActions(sessionKey).catch(() => null))
        : null
      const existingItems = Array.isArray(currentState?.items) ? currentState.items : []
      const mergedItems = mergeTurnActionItems(existingItems, incomingItems)

      const lastEvent = buf.events[buf.events.length - 1]
      const maxSeq = Math.max(
        Number.isFinite(lastEvent?.seq) ? lastEvent.seq : 0,
        Number.isFinite(currentState?.scannedThroughSeq) ? currentState.scannedThroughSeq : 0,
      )

      const nextState = {
        version: 1,
        sessionId,
        scannedThroughSeq: maxSeq,
        scannedAt: now(),
        items: mergedItems,
      }

      if (typeof store?.putTurnActions === 'function') {
        await store.putTurnActions(sessionKey, nextState)
      }
    })
  }

  /**
   * Synchronize / backfill turn actions for one session.
   * Tries POST /api/punch-desk/turn-actions-scan first, then falls back to session.events.
   * @param {string} sessionId
   * @returns {Promise<{ ok: boolean, source?: string, items?: object[], error?: string }>}
   */
  async function resync(sessionId) {
    if (!sessionId || disposed) return { ok: false, error: 'disposed-or-empty' }

    return enqueue(async () => {
      let includeTextHeuristic = false
      try {
        const prefs = typeof store?.getPrefs === 'function' ? await store.getPrefs().catch(() => null) : null
        if (prefs && typeof prefs.includeTextHeuristic === 'boolean') {
          includeTextHeuristic = prefs.includeTextHeuristic
        }
      } catch {}

      // 1. Attempt Host scan route
      let scanResult = null
      const scanBody = JSON.stringify({ sessionId, maxTurns: 20, includeTextHeuristic })

      try {
        if (typeof fetchRoute === 'function') {
          const res = await fetchRoute('/api/punch-desk/turn-actions-scan', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: scanBody,
          })
          if (res && typeof res.json === 'function') {
            scanResult = await res.json().catch(() => null)
          } else if (res && typeof res === 'object') {
            scanResult = res
          }
        } else if (remote?.connection?.fetch) {
          const res = await remote.connection.fetch({
            url: 'http://localhost/api/punch-desk/turn-actions-scan',
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: scanBody,
          })
          if (res && typeof res.json === 'function') {
            scanResult = await res.json().catch(() => null)
          } else if (res && typeof res === 'object') {
            scanResult = res
          }
        } else if (typeof globalThis.fetch === 'function') {
          const res = await globalThis.fetch('/api/punch-desk/turn-actions-scan', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: scanBody,
          })
          if (res && typeof res.json === 'function') {
            scanResult = await res.json().catch(() => null)
          }
        }
      } catch {
        scanResult = null
      }

      if (scanResult && scanResult.ok && scanResult.value && Array.isArray(scanResult.value.turns)) {
        const incomingItems = []
        for (const turn of scanResult.value.turns) {
          if (Array.isArray(turn?.items)) incomingItems.push(...turn.items)
        }

        const sessionKey = `session:${sessionId}`
        const currentState = (typeof store?.listTurnActions === 'function')
          ? (await store.listTurnActions(sessionKey).catch(() => null))
          : null
        const existingItems = Array.isArray(currentState?.items) ? currentState.items : []
        const mergedItems = mergeTurnActionItems(existingItems, incomingItems)
        const scannedThroughSeq = Math.max(
          Number.isFinite(scanResult.value.scannedThroughSeq) ? scanResult.value.scannedThroughSeq : 0,
          Number.isFinite(currentState?.scannedThroughSeq) ? currentState.scannedThroughSeq : 0,
        )

        const nextState = {
          version: 1,
          sessionId,
          scannedThroughSeq,
          scannedAt: now(),
          items: mergedItems,
        }

        if (typeof store?.putTurnActions === 'function') {
          await store.putTurnActions(sessionKey, nextState)
        }
        return { ok: true, source: 'scan', items: mergedItems }
      }

      // 2. Fallback to session.events
      const ctrl = controllers.get(sessionId)
      const records = await fetchSessionEventsFallback(sessionId, ctrl?.signal)
      if (!records || records.length === 0) {
        return { ok: false, error: 'no-events' }
      }

      const normalizedEvents = records.map(r => r?.event ?? r)
      const { promptLogTurns, findingsByRequest } = await loadContextData(sessionId)
      const workspaceKey = `session:${sessionId}`

      const digests = deriveTurnDigests(normalizedEvents, {
        sessionId,
        workspaceKey,
        maxTurns: 20,
        includeTextHeuristic,
        promptLogTurns,
        findingsByRequest,
      })

      const incomingItems = []
      for (const d of digests) {
        if (Array.isArray(d?.items)) incomingItems.push(...d.items)
      }

      const sessionKey = `session:${sessionId}`
      const currentState = (typeof store?.listTurnActions === 'function')
        ? (await store.listTurnActions(sessionKey).catch(() => null))
        : null
      const existingItems = Array.isArray(currentState?.items) ? currentState.items : []
      const mergedItems = mergeTurnActionItems(existingItems, incomingItems)

      const lastRecord = normalizedEvents[normalizedEvents.length - 1]
      const scannedThroughSeq = Math.max(
        Number.isFinite(lastRecord?.seq) ? lastRecord.seq : 0,
        Number.isFinite(currentState?.scannedThroughSeq) ? currentState.scannedThroughSeq : 0,
      )

      const nextState = {
        version: 1,
        sessionId,
        scannedThroughSeq,
        scannedAt: now(),
        items: mergedItems,
      }

      if (typeof store?.putTurnActions === 'function') {
        await store.putTurnActions(sessionKey, nextState)
      }

      return { ok: true, source: 'events-fallback', items: mergedItems }
    })
  }

  /**
   * Process a single live event frame for a session.
   * @param {string} sessionId
   * @param {object} event
   */
  async function handleLiveEvent(sessionId, event) {
    if (!event || typeof event !== 'object') return

    if (event.type === 'turn/start') {
      const turn = Number.isFinite(event.data?.turn) ? event.data.turn : undefined
      turnBuffers.set(sessionId, { turn, events: [event] })
      return
    }

    if (event.type === 'turn/end') {
      const buf = turnBuffers.get(sessionId)
      if (!buf || !Array.isArray(buf.events) || buf.events.length === 0) {
        // Late mount missed earlier events -> trigger resync
        await resync(sessionId)
      } else {
        buf.events.push(event)
        await settleTurnBuffer(sessionId, buf)
      }
      turnBuffers.delete(sessionId)
      return
    }

    // Inside-turn events
    let buf = turnBuffers.get(sessionId)
    if (!buf) {
      buf = { turn: Number.isFinite(event.data?.turn) ? event.data.turn : undefined, events: [] }
      turnBuffers.set(sessionId, buf)
    }
    buf.events.push(event)
  }

  /**
   * Ensure an active observer exists for the session.
   * Starts a new stream and triggers resync if not currently active.
   * @param {string} sessionId
   */
  function ensureObserver(sessionId) {
    if (!sessionId || disposed) return
    const existing = controllers.get(sessionId)
    if (existing && !existing.signal.aborted) return

    const currentCtrl = new AbortController()
    controllers.set(sessionId, currentCtrl)

    // Initial resync to reconcile history
    void resync(sessionId).catch(() => {})

    // Live stream loop
    void (async () => {
      try {
        if (!remote?.session?.observeEvent) return
        const address = { kind: 'session', sessionId }
        const stream = remote.session.observeEvent({ address }, currentCtrl.signal)
        const iterable = (stream && typeof stream[Symbol.asyncIterator] === 'function')
          ? stream
          : (typeof stream?.then === 'function' ? await stream : null)

        if (!iterable || typeof iterable[Symbol.asyncIterator] !== 'function') return

        for await (const frame of iterable) {
          if (currentCtrl.signal.aborted || disposed) break
          if (frame?.type === 'ready') continue
          const event = frame?.event ?? frame
          if (!event || typeof event !== 'object') continue

          await handleLiveEvent(sessionId, event)
        }
      } catch {
        // Stream aborted or interrupted
      } finally {
        // Identity guard: only delete if still the same controller
        if (controllers.get(sessionId) === currentCtrl) {
          controllers.delete(sessionId)
        }
      }
    })()
  }

  /**
   * Close and clean up observation for one session.
   * @param {string} sessionId
   */
  function close(sessionId) {
    if (!sessionId) return
    const ctrl = controllers.get(sessionId)
    if (ctrl) {
      controllers.delete(sessionId)
      try {
        ctrl.abort()
      } catch {}
    }
    turnBuffers.delete(sessionId)
  }

  /**
   * Close all active session observers.
   */
  function closeAll() {
    for (const [id, ctrl] of controllers) {
      try {
        ctrl.abort()
      } catch {}
    }
    controllers.clear()
    turnBuffers.clear()
  }

  /**
   * Dispose tracker completely.
   */
  function dispose() {
    disposed = true
    closeAll()
  }

  return {
    ensureObserver,
    resync,
    close,
    closeAll,
    dispose,
    isActive: sessionId => Boolean(controllers.has(sessionId) && !controllers.get(sessionId)?.signal?.aborted),
    getTurnBuffer: sessionId => turnBuffers.get(sessionId),
  }
}

export { convertTurnActionToFinding, inheritTurnActions } from '../../domain/turn-actions.js'

/**
 * List open TurnActionItems across archived sessions.
 * Respects workspace scope:
 * - 'workspace' (default): only returns archived sessions belonging to the specified workspaceId.
 * - 'all': returns all archived sessions, marking cross-workspace ones with `crossWorkspace: true`.
 *
 * @param {object} params
 * @param {import('../../store/contract.js').DeskStore} [params.store]
 * @param {string} [params.workspaceId] Active workspace ID
 * @param {'workspace'|'all'} [params.scope='workspace']
 * @param {object} [params.services]
 * @param {Array<string>|Set<string>} [params.archivedSessionIds]
 * @param {Array<object>} [params.hostWorkspaces]
 * @param {Array<object>} [params.allSessions]
 * @returns {Promise<Array<{ sessionId: string, title: string, workspaceId: string|null, crossWorkspace: boolean, items: object[] }>>}
 */
export async function listArchivedTurnActions({
  store,
  workspaceId,
  scope = 'workspace',
  services,
  archivedSessionIds,
  hostWorkspaces,
  allSessions,
} = {}) {
  let archivedIds = []
  if (Array.isArray(archivedSessionIds)) {
    archivedIds = [...archivedSessionIds]
  } else if (archivedSessionIds instanceof Set) {
    archivedIds = Array.from(archivedSessionIds)
  } else if (typeof services?.getArchivedSessionIds === 'function') {
    try {
      const res = await services.getArchivedSessionIds()
      archivedIds = Array.isArray(res) ? res : []
    } catch {
      archivedIds = []
    }
  }

  if (archivedIds.length === 0) return []

  const sessionWorkspaceMap = new Map()
  if (Array.isArray(hostWorkspaces)) {
    for (const ws of hostWorkspaces) {
      const wsId = ws.id || ws.workspaceId
      for (const sid of ws.sessionIds || []) {
        sessionWorkspaceMap.set(sid, wsId)
      }
    }
  }
  if (Array.isArray(allSessions)) {
    for (const s of allSessions) {
      if (s.sessionId && s.workspaceId) {
        sessionWorkspaceMap.set(s.sessionId, s.workspaceId)
      }
    }
  }

  const results = []
  for (const sid of archivedIds) {
    const sessionWsId = sessionWorkspaceMap.get(sid)
    const isCrossWorkspace = Boolean(workspaceId && sessionWsId && sessionWsId !== workspaceId)

    if (scope === 'workspace' && workspaceId) {
      if (sessionWsId && sessionWsId !== workspaceId) {
        continue
      }
    }

    let turnState = null
    const effectiveStore = store || services?.store
    if (effectiveStore && typeof effectiveStore.listTurnActions === 'function') {
      try {
        turnState = await effectiveStore.listTurnActions(sid)
      } catch {
        turnState = null
      }
    }

    if (!turnState || !Array.isArray(turnState.items)) continue

    const openItems = turnState.items.filter(item => item && item.status === 'open')
    if (openItems.length === 0) continue

    const sessionObj = Array.isArray(allSessions) ? allSessions.find(s => s.sessionId === sid || s.id === sid) : null
    const title = sessionObj?.title || sessionObj?.name || sid

    results.push({
      sessionId: sid,
      title,
      workspaceId: sessionWsId || workspaceId || null,
      crossWorkspace: isCrossWorkspace,
      items: openItems,
    })
  }

  return results
}
