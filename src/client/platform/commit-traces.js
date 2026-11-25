/**
 * Commit trace tracker for Punch Desk submissions.
 * Observes session events to correlate explicit user submissions with Git commit ranges.
 */

export function createCommitTraceTracker({
  remote,
  git,
  store,
  resolveWorkspaceId,
  now = Date.now,
  uuid = () => globalThis.crypto.randomUUID(),
}) {
  /**
   * Pending submissions waiting for turn execution.
   * Keyed by requestId.
   */
  const pending = new Map()

  /**
   * Discarded requestIds that failed submission or were explicitly cancelled.
   */
  const discarded = new Set()

  /**
   * Active observers per session.
   * Keyed by sessionId -> { abortController, closed: boolean, activePromise?: Promise<void> }
   */
  const perSessionObserver = new Map()

  /**
   * HEAD sampled at turn/start.
   * Keyed by sessionId -> Map<turn, { head?: string, branch?: string, isRepo?: boolean }>
   */
  const turnHeads = new Map()

  /**
   * Map of turn -> Set<requestId> established when user/message matches rpcId.
   * Keyed by sessionId -> Map<turn, Set<requestId>>
   */
  const turnRequests = new Map()

  /**
   * PostHead sampled at turn/end.
   * Keyed by sessionId -> Map<turn, object>
   */
  const endedTurns = new Map()

  /** Current turn per session, used when user/message omits data.turn. */
  const currentTurns = new Map()

  /** Timers for cleanup: pending 30min / endedTurns 2min TTL. */
  const pendingTimers = new Map()
  const endedTurnTimers = new Map()

  let disposed = false
  let activeTasks = 0
  let idleWaiters = []

  function allStreamsClosed() {
    if (perSessionObserver.size === 0) return true
    for (const obs of perSessionObserver.values()) {
      if (!obs.closed) return false
    }
    return true
  }

  function checkIdle() {
    if (activeTasks === 0 && (pending.size === 0 || allStreamsClosed())) {
      const waiters = idleWaiters.slice()
      idleWaiters = []
      for (const w of waiters) w()
    }
  }

  function ensureSessionMaps(sessionId) {
    if (!turnHeads.has(sessionId)) turnHeads.set(sessionId, new Map())
    if (!turnRequests.has(sessionId)) turnRequests.set(sessionId, new Map())
    if (!endedTurns.has(sessionId)) endedTurns.set(sessionId, new Map())
  }

  function clearTimer(map, key) {
    const timer = map.get(key)
    if (timer) {
      clearTimeout(timer)
      map.delete(key)
    }
  }

  function schedulePendingTimeout(requestId) {
    clearTimer(pendingTimers, requestId)
    const item = pending.get(requestId)
    if (!item) return
    const timer = setTimeout(() => {
      pendingTimers.delete(requestId)
      if (!pending.has(requestId)) return
      pending.delete(requestId)
      try {
        console.warn(`[punch-desk] dropping unmapped commit-trace request after 30min: ${requestId}`)
      } catch {}
      closeObserverIfIdle(item.sessionId)
      checkIdle()
    }, 30 * 60 * 1000)
    timer.unref?.()
    pendingTimers.set(requestId, timer)
  }

  function scheduleEndedTurnTtl(sessionId, turn) {
    const key = `${sessionId}:${turn}`
    clearTimer(endedTurnTimers, key)
    const timer = setTimeout(() => {
      endedTurnTimers.delete(key)
      endedTurns.get(sessionId)?.delete(turn)
      checkIdle()
    }, 2 * 60 * 1000)
    timer.unref?.()
    endedTurnTimers.set(key, timer)
  }

  function closeObserverIfIdle(sessionId) {
    if (!sessionId) return
    const stillPending = Array.from(pending.values()).some(item => item.sessionId === sessionId)
    if (stillPending) return
    const observer = perSessionObserver.get(sessionId)
    if (observer) {
      observer.closed = true
      try { observer.abortController.abort() } catch {}
      perSessionObserver.delete(sessionId)
    }
    turnHeads.delete(sessionId)
    turnRequests.delete(sessionId)
    endedTurns.delete(sessionId)
    currentTurns.delete(sessionId)
    for (const key of Array.from(endedTurnTimers.keys())) {
      if (key.startsWith(`${sessionId}:`)) clearTimer(endedTurnTimers, key)
    }
  }

  function finishPending(requestId, sessionId) {
    clearTimer(pendingTimers, requestId)
    pending.delete(requestId)
    closeObserverIfIdle(sessionId)
    checkIdle()
  }

  async function handleFrame(sessionId, frame, options = {}) {
    const replay = Boolean(options.replay)
    const event = frame?.event ?? (frame?.type === 'event' ? frame.event : frame)
    if (!event || typeof event.type !== 'string') return

    ensureSessionMaps(sessionId)

    if (event.type === 'turn/start') {
      const turn = event.data?.turn
      if (!Number.isFinite(turn)) return
      const previousTurn = currentTurns.get(sessionId)
      if (!replay || !Number.isFinite(previousTurn) || turn >= previousTurn) currentTurns.set(sessionId, turn)

      const sessionPending = Array.from(pending.values()).filter(p => p.sessionId === sessionId)
      if (sessionPending.length === 0) return

      const wsId = sessionPending[0]?.workspaceId || (typeof resolveWorkspaceId === 'function' ? resolveWorkspaceId(sessionId) : undefined)
      let headRes = null
      if (wsId && git && typeof git.head === 'function') {
        try {
          headRes = await git.head(wsId)
        } catch (err) {
          headRes = { isRepo: false, error: err }
        }
      }
      turnHeads.get(sessionId).set(turn, {
        head: headRes?.isRepo ? headRes.gitHead : undefined,
        branch: headRes?.gitBranch,
        isRepo: headRes?.isRepo,
      })
      return
    }

    if (event.type === 'user/message') {
      const data = event.data ?? {}
      const msg = data.message ?? data
      const rpcId = msg.source?.rpcId ?? msg.rpcId ?? data.rpcId
      if (!rpcId || !pending.has(rpcId)) return

      const turn = Number.isFinite(data.turn) ? data.turn : currentTurns.get(sessionId)
      if (turn === undefined) return

      const pendingItem = pending.get(rpcId)
      if (pendingItem.sessionId !== sessionId) return

      let reqSet = turnRequests.get(sessionId).get(turn)
      if (!reqSet) {
        reqSet = new Set()
        turnRequests.get(sessionId).set(turn, reqSet)
      }
      reqSet.add(rpcId)
      pendingItem.turn = turn

      if (endedTurns.get(sessionId)?.has(turn)) {
        await settleTrace(sessionId, rpcId, turn)
      }
      return
    }

    if (event.type === 'turn/end') {
      const turn = event.data?.turn
      if (!Number.isFinite(turn)) return
      const previousTurn = currentTurns.get(sessionId)
      if (!replay || !Number.isFinite(previousTurn) || turn >= previousTurn) currentTurns.set(sessionId, turn)

      let wsId = typeof resolveWorkspaceId === 'function' ? resolveWorkspaceId(sessionId) : undefined
      const reqSet = turnRequests.get(sessionId)?.get(turn)
      if (!wsId && reqSet && reqSet.size > 0) {
        for (const rId of reqSet) {
          const p = pending.get(rId)
          if (p?.workspaceId) {
            wsId = p.workspaceId
            break
          }
        }
      }

      let postHeadRes = null
      if (wsId && git && typeof git.head === 'function') {
        try {
          postHeadRes = await git.head(wsId)
        } catch (err) {
          postHeadRes = { ok: false, error: err }
        }
      }
      endedTurns.get(sessionId).set(turn, postHeadRes)
      scheduleEndedTurnTtl(sessionId, turn)

      if (reqSet && reqSet.size > 0) {
        for (const rId of Array.from(reqSet)) {
          await settleTrace(sessionId, rId, turn)
        }
      }
    }
  }

  async function settleTrace(sessionId, requestId, turn) {
    const pendingItem = pending.get(requestId)
    if (!pendingItem) return

    let wsId = pendingItem.workspaceId
    if (!wsId && typeof resolveWorkspaceId === 'function') {
      wsId = resolveWorkspaceId(sessionId)
    }

    // 1. Workspace resolution failure
    if (!wsId) {
      const trace = {
        id: `${requestId}#${turn}`,
        requestId,
        sessionId,
        workspaceId: undefined,
        mode: pendingItem.mode,
        turn,
        groupIds: pendingItem.groupIds || [],
        findingIds: pendingItem.findingIds || [],
        commits: [],
        status: 'failed',
        error: 'workspace-unresolved',
        admittedAt: pendingItem.admittedAt,
        capturedAt: now(),
        updatedAt: now(),
      }
      await store.putCommitTraces(`session:${sessionId}`, [trace])
      finishPending(requestId, sessionId)
      return
    }

    // 2. postHead determination
    let postHeadObj = endedTurns.get(sessionId)?.get(turn)
    if (!postHeadObj) {
      if (git && typeof git.head === 'function') {
        try {
          postHeadObj = await git.head(wsId)
        } catch (err) {
          postHeadObj = { ok: false, error: err }
        }
        endedTurns.get(sessionId).set(turn, postHeadObj)
      }
    }

    let postHead = null
    let postHeadError = null
    if (!postHeadObj) {
      postHeadError = 'no-post-head'
    } else if (postHeadObj.isRepo === false) {
      postHeadError = 'not-a-repo'
    } else if (!postHeadObj.gitHead || !/^[0-9a-f]{40}$/i.test(postHeadObj.gitHead)) {
      postHeadError = 'no-post-head'
    } else {
      postHead = postHeadObj.gitHead
    }

    // 3. preHead determination
    const turnHeadObj = turnHeads.get(sessionId)?.get(turn)
    let preHead = null
    let preHeadSource = null

    if (turnHeadObj?.head && /^[0-9a-f]{40}$/i.test(turnHeadObj.head)) {
      preHead = turnHeadObj.head
      preHeadSource = 'turn'
    } else {
      if (pendingItem.mode === 'combined') {
        if (pendingItem.admissionHead && /^[0-9a-f]{40}$/i.test(pendingItem.admissionHead)) {
          preHead = pendingItem.admissionHead
          preHeadSource = 'admission'
        }
      } else {
        // Sequential mode
        let traces = []
        try {
          traces = await store.listCommitTraces(`session:${sessionId}`)
        } catch {}
        const candidatePrevTraces = (Array.isArray(traces) ? traces : [])
          .filter(t => Number.isFinite(t.turn) && t.turn < turn && t.postHead && /^[0-9a-f]{40}$/i.test(t.postHead))
          .sort((a, b) => b.turn - a.turn)

        if (candidatePrevTraces.length > 0) {
          preHead = candidatePrevTraces[0].postHead
          preHeadSource = 'previous-post'
        } else {
          // Sequential first turn
          if (pendingItem.admissionHead && /^[0-9a-f]{40}$/i.test(pendingItem.admissionHead)) {
            preHead = pendingItem.admissionHead
            preHeadSource = 'admission'
          }
        }
      }
    }

    if (postHeadError) {
      const trace = {
        id: `${requestId}#${turn}`,
        requestId,
        sessionId,
        workspaceId: wsId,
        mode: pendingItem.mode,
        turn,
        groupIds: pendingItem.groupIds || [],
        findingIds: pendingItem.findingIds || [],
        ...(preHead ? { preHead, preHeadSource } : {}),
        commits: [],
        status: 'failed',
        error: postHeadError,
        admittedAt: pendingItem.admittedAt,
        capturedAt: now(),
        updatedAt: now(),
      }
      await store.putCommitTraces(`session:${sessionId}`, [trace])
      finishPending(requestId, sessionId)
      return
    }

    if (!preHead) {
      const trace = {
        id: `${requestId}#${turn}`,
        requestId,
        sessionId,
        workspaceId: wsId,
        mode: pendingItem.mode,
        turn,
        groupIds: pendingItem.groupIds || [],
        findingIds: pendingItem.findingIds || [],
        postHead,
        commits: [],
        status: 'failed',
        error: 'no-pre-head',
        admittedAt: pendingItem.admittedAt,
        capturedAt: now(),
        updatedAt: now(),
      }
      await store.putCommitTraces(`session:${sessionId}`, [trace])
      finishPending(requestId, sessionId)
      return
    }

    // 4. Equal endpoints -> 0 commits, complete without git.range
    if (preHead === postHead) {
      const trace = {
        id: `${requestId}#${turn}`,
        requestId,
        sessionId,
        workspaceId: wsId,
        mode: pendingItem.mode,
        turn,
        groupIds: pendingItem.groupIds || [],
        findingIds: pendingItem.findingIds || [],
        preHead,
        postHead,
        preHeadSource,
        commits: [],
        status: 'complete',
        admittedAt: pendingItem.admittedAt,
        capturedAt: now(),
        updatedAt: now(),
      }
      await store.putCommitTraces(`session:${sessionId}`, [trace])
      finishPending(requestId, sessionId)
      return
    }

    // 5. Query git.range
    let rangeRes = null
    try {
      if (typeof git?.range === 'function') {
        rangeRes = await git.range(wsId, preHead, postHead)
      } else {
        rangeRes = { ok: false, error: 'no-git-range' }
      }
    } catch (err) {
      rangeRes = { ok: false, error: err }
    }

    if (rangeRes && rangeRes.ok !== false) {
      const rawCommits = Array.isArray(rangeRes.commits) ? rangeRes.commits : []
      const commits = rawCommits.map(c => ({
        hash: c.hash,
        shortHash: c.shortHash || (c.hash ? c.hash.slice(0, 7) : ''),
        subject: c.subject || '',
        time: c.time ?? 0,
      }))
      const trace = {
        id: `${requestId}#${turn}`,
        requestId,
        sessionId,
        workspaceId: wsId,
        mode: pendingItem.mode,
        turn,
        groupIds: pendingItem.groupIds || [],
        findingIds: pendingItem.findingIds || [],
        preHead,
        postHead,
        preHeadSource,
        commits,
        truncated: Boolean(rangeRes.truncated),
        status: 'complete',
        admittedAt: pendingItem.admittedAt,
        capturedAt: now(),
        updatedAt: now(),
      }
      await store.putCommitTraces(`session:${sessionId}`, [trace])
      finishPending(requestId, sessionId)
    } else {
      const trace = {
        id: `${requestId}#${turn}`,
        requestId,
        sessionId,
        workspaceId: wsId,
        mode: pendingItem.mode,
        turn,
        groupIds: pendingItem.groupIds || [],
        findingIds: pendingItem.findingIds || [],
        preHead,
        postHead,
        preHeadSource,
        commits: [],
        status: 'failed',
        error: 'range-failed',
        admittedAt: pendingItem.admittedAt,
        capturedAt: now(),
        updatedAt: now(),
      }
      await store.putCommitTraces(`session:${sessionId}`, [trace])
      finishPending(requestId, sessionId)
    }
  }

  /**
   * Replay the latest session events before trusting a live-only observer.
   * The tracker can attach after `turn/start` or after `turn/end` (for example
   * when the pane opens late, or the observer was closed while idle). Without
   * this pass, the pending submission never learns its turn and no trace is
   * written (B7). Replay is optional: hosts without `session.events` keep the
   * live-only behavior.
   */
  async function replayRecentEvents(sessionId, obsState) {
    const session = remote?.session
    if (!session || typeof session.events !== 'function') return
    activeTasks++
    try {
      const address = { kind: 'session', sessionId }
      const result = await session.events(
        { address, maxMessages: 200 },
        obsState?.abortController?.signal,
      )
      if (disposed) return
      if (!result || result.ok === false) return
      const page = result.value ?? result
      const records = Array.isArray(page)
        ? page
        : Array.isArray(page?.records) ? page.records : []
      for (const record of records) {
        if (disposed) break
        await handleFrame(sessionId, record, { replay: true })
        if (!Array.from(pending.values()).some(item => item.sessionId === sessionId)) break
      }
    } catch {
      // Replay is best-effort; the live observer remains the fallback.
    } finally {
      activeTasks--
      checkIdle()
    }
  }

  async function runObserver(sessionId, obsState) {
    if (!remote?.session?.observeEvent) {
      obsState.closed = true
      return
    }
    try {
      const address = { kind: 'session', sessionId }
      const stream = remote.session.observeEvent({ address }, obsState.abortController.signal)
      const iterable = (stream && typeof stream[Symbol.asyncIterator] === 'function')
        ? stream
        : (typeof stream?.then === 'function' ? await stream : null)

      if (!iterable || typeof iterable[Symbol.asyncIterator] !== 'function') {
        obsState.closed = true
        return
      }

      for await (const frame of iterable) {
        if (obsState.closed || disposed) break
        activeTasks++
        try {
          await handleFrame(sessionId, frame)
        } finally {
          activeTasks--
          checkIdle()
        }
      }
    } catch {
      // Stream aborted or ended
    } finally {
      obsState.closed = true
      checkIdle()
    }
  }

  function ensureObserver(sessionId) {
    if (!sessionId || disposed) return
    const existing = perSessionObserver.get(sessionId)
    if (existing && !existing.closed) return

    const abortController = new AbortController()
    const obsState = { abortController, closed: false }
    perSessionObserver.set(sessionId, obsState)
    ensureSessionMaps(sessionId)

    obsState.activePromise = runObserver(sessionId, obsState).catch(() => {})
    replayRecentEvents(sessionId, obsState).catch(() => {})
  }

  return {
    async prepareSubmission({ requestId, sessionId, mode, entries }) {
      if (!requestId || !sessionId || disposed) return
      // A retry reuses the documented requestId; a previous onDiscard must not
      // make noteAccepted skip the observer forever.
      discarded.delete(requestId)
      activeTasks++
      try {
        const list = Array.isArray(entries) ? entries : []
        const wsId = typeof resolveWorkspaceId === 'function' ? resolveWorkspaceId(sessionId) : undefined
        let headResult = null
        if (wsId && git && typeof git.head === 'function') {
          try {
            headResult = await git.head(wsId)
          } catch {
            headResult = null
          }
        }
        const groupIds = Array.from(new Set(list.map(e => e.assignedGroupId || e.groupId).filter(Boolean)))
        const findingIds = list.map(e => e.id).filter(Boolean)
        const admittedAt = now()
        pending.set(requestId, {
          requestId,
          sessionId,
          workspaceId: wsId,
          mode: mode || 'sequential',
          groupIds,
          findingIds,
          entries: list,
          admittedAt,
          admissionHead: headResult?.isRepo ? headResult.gitHead : undefined,
          admissionBranch: headResult?.isRepo ? headResult.gitBranch : undefined,
          admissionCapturedAt: admittedAt,
        })
        schedulePendingTimeout(requestId)
      } finally {
        activeTasks--
        checkIdle()
      }
    },

    noteAccepted({ requestId, sessionId, mode, entries }) {
      if (!sessionId || disposed) return
      if (requestId && discarded.has(requestId)) return
      if (requestId && !pending.has(requestId)) {
        const list = Array.isArray(entries) ? entries : []
        const wsId = typeof resolveWorkspaceId === 'function' ? resolveWorkspaceId(sessionId) : undefined
        const groupIds = Array.from(new Set(list.map(e => e.assignedGroupId || e.groupId).filter(Boolean)))
        const findingIds = list.map(e => e.id).filter(Boolean)
        pending.set(requestId, {
          requestId,
          sessionId,
          workspaceId: wsId,
          mode: mode || 'sequential',
          groupIds,
          findingIds,
          entries: list,
          admittedAt: now(),
        })
        schedulePendingTimeout(requestId)
      }
      ensureObserver(sessionId)
    },

    discard(arg) {
      const reqId = typeof arg === 'string' ? arg : arg?.requestId
      if (reqId) {
        discarded.add(reqId)
        const item = pending.get(reqId)
        finishPending(reqId, item?.sessionId)
      }
    },

    async retryTrace({ sessionId, traceId }) {
      if (!sessionId || !traceId) return { ok: false, error: 'missing-arguments' }
      let traces = []
      try {
        traces = await store.listCommitTraces(`session:${sessionId}`)
      } catch {
        return { ok: false, error: 'store-read-failed' }
      }
      const trace = (Array.isArray(traces) ? traces : []).find(t => t.id === traceId)
      if (!trace) {
        return { ok: false, error: 'trace-not-found' }
      }
      if (trace.error === 'workspace-unresolved' || trace.error === 'not-a-repo') {
        return { ok: false, error: 'not-retryable', reason: trace.error }
      }
      if (!trace.preHead || !trace.postHead) {
        return { ok: false, error: 'missing-endpoints', reason: 'Endpoints missing' }
      }
      if (trace.status === 'complete') {
        return { ok: true, trace }
      }

      let rangeRes = null
      try {
        if (typeof git?.range === 'function') {
          if (git.range.length === 2) {
            rangeRes = await git.range(trace.preHead, trace.postHead)
          } else {
            rangeRes = await git.range(trace.workspaceId, trace.preHead, trace.postHead)
          }
        } else {
          rangeRes = { ok: false, error: 'no-git-range' }
        }
      } catch (err) {
        rangeRes = { ok: false, error: err }
      }

      if (rangeRes && rangeRes.ok !== false) {
        const rawCommits = Array.isArray(rangeRes.commits) ? rangeRes.commits : []
        const commits = rawCommits.map(c => ({
          hash: c.hash,
          shortHash: c.shortHash || (c.hash ? c.hash.slice(0, 7) : ''),
          subject: c.subject || '',
          time: c.time ?? 0,
        }))
        const updated = {
          ...trace,
          status: 'complete',
          commits,
          truncated: Boolean(rangeRes.truncated),
          error: undefined,
          updatedAt: now(),
        }
        await store.putCommitTraces(`session:${sessionId}`, [updated])
        return { ok: true, trace: updated }
      } else {
        const updated = {
          ...trace,
          status: 'failed',
          error: 'range-failed',
          updatedAt: now(),
        }
        await store.putCommitTraces(`session:${sessionId}`, [updated])
        return { ok: false, error: 'range-failed', trace: updated }
      }
    },

    dispose() {
      disposed = true
      for (const obs of perSessionObserver.values()) {
        try {
          obs.abortController.abort()
          obs.closed = true
        } catch {}
      }
      for (const timer of pendingTimers.values()) clearTimeout(timer)
      for (const timer of endedTurnTimers.values()) clearTimeout(timer)
      pendingTimers.clear()
      endedTurnTimers.clear()
      perSessionObserver.clear()
      turnHeads.clear()
      turnRequests.clear()
      endedTurns.clear()
      currentTurns.clear()
      pending.clear()
      checkIdle()
    },

    whenIdle(timeoutMs = 3000) {
      if (activeTasks === 0 && (pending.size === 0 || allStreamsClosed())) {
        return Promise.resolve()
      }
      return new Promise(resolve => {
        let timer
        const onIdle = () => {
          clearTimeout(timer)
          resolve()
        }
        timer = setTimeout(onIdle, timeoutMs)
        idleWaiters.push(onIdle)
      })
    },
  }
}
