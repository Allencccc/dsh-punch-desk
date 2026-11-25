/** Live prompt work log for one session: queue placeholders, sent, completed, and expired rows. */

import {
  isIndexableUserMessage,
  markCompleted,
  prunePromptLog,
  promptLogEntryFromMessage,
  toLocalDate,
} from '../../domain/prompt-log.js'
import { BACKFILL_LIMIT, backfillSession } from './backfill.js'
import { retentionWindowFromPrefs } from '../../store/contract.js'

/** Time zone used when the runtime cannot report one. */
const FALLBACK_TIME_ZONE = 'UTC'

/** @returns {string} */
function resolveTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || FALLBACK_TIME_ZONE
  } catch {
    return FALLBACK_TIME_ZONE
  }
}

/**
 * Extract the user-authored message from a `user/message` event.
 *
 * The payload shape differs across hosts/versions:
 * - current DSH session records put the message directly in `event.data`
 *   (`{ id, role: 'user', source: { kind: 'user', rpcId }, content }`) and keep
 *   `turn` on `turn/start` / `assistant/message`;
 * - older payloads wrapped it as `{ message, turn }`.
 * Both are accepted; only genuine user-authored messages pass the source check.
 *
 * @param {object} event
 * @returns {object|undefined}
 */
function userMessageOf(event) {
  if (event?.type !== 'user/message') return undefined
  const data = event.data
  const message = data?.message ?? data
  return message?.source?.kind === 'user' ? message : undefined
}

/**
 * Normalize a user message to the `{ message, turn }` data shape the prompt-log
 * domain helpers consume. A missing turn stays `undefined` instead of being
 * invented; the row is still a real `sent` submission, it just cannot be
 * completed by `turn/end` (there is no turn to compare).
 * @param {object} event
 * @param {object} message
 * @param {number|undefined} turn
 * @returns {object}
 */
function normalizedUserMessage(event, message, turn) {
  return { ...event, data: { ...event.data, message, turn } }
}

/**
 * @param {{
 *   remote: { session: { observeState: Function, observeEvent: Function } },
 *   store: import('../../store/contract.js').DeskStore,
 *   now?: () => number,
 *   timeZone?: string,
 * }} deps
 */
export function createPromptIndex({
  remote,
  store,
  now = Date.now,
  timeZone = resolveTimeZone(),
  backfill = backfillSession,
}) {
  /** @type {Map<string, AbortController>} */
  const controllers = new Map()
  /** @type {Map<string, number>} */
  const sessionTurns = new Map()

  function getTurn(sessionId) {
    return sessionTurns.get(sessionId) ?? 0
  }
  // The store's read-modify-write calls are not transactional; serialize every
  // index mutation so the state and event streams cannot interleave a read with
  // the other stream's write (which could resurrect a deleted queue row).
  let tail = Promise.resolve()

  /**
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
   * @param {string} message
   * @param {unknown} error
   */
  function warn(message, error) {
    if (typeof console !== 'undefined') console.warn(`[punch-desk] ${message}`, error)
  }

  /**
   * Write one provisional `queued` row for an accepted prompt.
   *
   * `track` runs only after the submit RPCs resolve, so the host's
   * `user/message` event can be observed first. That event already wrote the
   * real `sent` row; writing a `queue:<requestId>` placeholder on top would
   * later expire into a second row for the same prompt. Under the serialized
   * queue, re-read the log and annotate the real row instead.
   *
   * @param {{ sessionId: string, workspaceKey: string, requestId: string, batchId?: string }} args
   * @returns {Promise<object>} the row written (real row when one exists)
   */
  async function track({ sessionId, workspaceKey, requestId, batchId }) {
    if (typeof requestId !== 'string' || requestId === '') {
      throw new Error('[punch-desk] prompt tracking requires a requestId')
    }
    const time = now()
    const entry = {
      messageId: `queue:${requestId}`,
      schemaVersion: 1,
      workspaceKey,
      sessionId,
      time,
      localDate: toLocalDate(time, timeZone),
      clientTimeZone: timeZone,
      excerpt: '',
      promptText: '',
      source: 'desk-batch',
      requestId,
      batchId,
      status: 'queued',
    }
    return enqueue(async () => {
      const current = await store.listPromptLog(workspaceKey)
      const real = current.find(item => (
        item.sessionId === sessionId
        && typeof item.messageId === 'string'
        && !item.messageId.startsWith('queue:')
        && typeof item.requestId === 'string'
        && item.requestId === requestId
      ))
      if (real) {
        const patch = { ...real, source: 'desk-batch' }
        if (batchId !== undefined) patch.batchId = batchId
        await store.upsertPromptLog(workspaceKey, [patch])
        return patch
      }
      await store.upsertPromptLog(workspaceKey, [entry])
      return entry
    })
  }

  /**
   * Remove provisional `queue:<requestId>` rows once a real user-message row
   * for the same request exists. Opening a session backfills durable history,
   * which can materialize the real row while a queued placeholder from a live
   * submit is still present.
   * @param {string} sessionId
   * @param {string} workspaceKey
   * @returns {Promise<number>} number of stale placeholders removed
   */
  async function reconcileQueuePlaceholders(sessionId, workspaceKey) {
    if (typeof store.deletePromptLog !== 'function') return 0
    const rows = await store.listPromptLog(workspaceKey)
    const realRequestIds = new Set(
      rows
        .filter(row => row && typeof row.messageId === 'string'
          && !row.messageId.startsWith('queue:')
          && typeof row.requestId === 'string')
        .map(row => row.requestId),
    )
    const stale = rows.filter(row => row
      && typeof row.messageId === 'string'
      && row.messageId.startsWith('queue:')
      && row.sessionId === sessionId
      && typeof row.requestId === 'string'
      && realRequestIds.has(row.requestId))
    for (const row of stale) await store.deletePromptLog(workspaceKey, row.messageId)
    return stale.length
  }

  /**
   * Start observing one session; idempotent until `stop(sessionId)`.
   * Also reconciles durable history once so prompts submitted while the pane
   * was closed (or the client was reloaded) are not permanently missing.
   * @param {{ sessionId: string, workspaceKey: string, onLog?: () => void }} args
   * @returns {void}
   */
  function start({ sessionId, workspaceKey, onLog }) {
    if (!sessionId || controllers.has(sessionId)) return
    const controller = new AbortController()
    controllers.set(sessionId, controller)
    const signal = controller.signal

    const notify = () => {
      if (!onLog) return
      try {
        onLog()
      } catch (error) {
        // A subscriber must not terminate the index streams.
        warn('prompt log subscriber failed', error)
      }
    }

    // Reconcile history missed while this session was not being observed.
    // The live event stream starts *now*, so without this a closed panel or a
    // client reload silently loses every prompt sent in the gap. Backfill is
    // idempotent by messageId; queue placeholders are reconciled by requestId.
    void (async () => {
      try {
        const result = await backfill({
          sessionId,
          workspaceKey,
          remote,
          store,
          limit: BACKFILL_LIMIT,
          signal,
          onWarn: warn,
        })
        if (signal.aborted) return
        if (result?.ok && !result?.unavailable) {
          await enqueue(() => reconcileQueuePlaceholders(sessionId, workspaceKey))
          notify()
        }
      } catch (error) {
        if (!signal.aborted) warn('prompt log history backfill failed', error)
      }
    })()

    // State stream: expire queue placeholders the idle session no longer holds.
    ;(async () => {
      try {
        for await (const frame of remote.session.observeState({ sessionId }, signal)) {
          // The current host yields the state object directly; a `{ state }`
          // wrapper is accepted too, since only this line adapts the frame.
          const state = frame?.state ?? frame
          if (!state || state.running !== false) continue
          // `queue` is `null` for a passive/inactive session and an array for
          // an active one. `null` is not proof of an empty queue, so only an
          // actual array may expire placeholders; an absent field is unknown too.
          const queue = state.queue
          if (!Array.isArray(queue)) continue
          const present = new Set(
            queue
              .map(item => item?.rpcId)
              .filter(rpcId => typeof rpcId === 'string'),
          )
          const changed = await enqueue(async () => {
            const current = await store.listPromptLog(workspaceKey)
            const expired = current
              .filter(entry => entry.sessionId === sessionId
                && entry.status === 'queued'
                && typeof entry.requestId === 'string'
                && !present.has(entry.requestId))
              .map(entry => ({ ...entry, status: 'expired' }))
            if (expired.length > 0) await store.upsertPromptLog(workspaceKey, expired)
            return expired.length > 0
          })
          if (changed) notify()
        }
      } catch (error) {
        if (!signal.aborted) warn('session state observation stopped', error)
      }
    })()

    // Event stream: convert real user messages and complete finished turns.
    ;(async () => {
      let currentTurn
      try {
        for await (const frame of remote.session.observeEvent({ address: { kind: 'session', sessionId } }, signal)) {
          if (frame?.type === 'ready') continue
          // The current host yields `{ type: 'event', event }`; the event is the
          // only field this index reads, so no other frame shape is assumed.
          const event = frame?.event
          if (!event) continue

          if (event.type === 'turn/start') {
            const turn = event.data?.turn
            if (Number.isFinite(turn)) {
              currentTurn = turn
              const prev = sessionTurns.get(sessionId) ?? 0
              if (turn > prev) {
                sessionTurns.set(sessionId, turn)
                notify()
              }
            }
            continue
          }

          const message = userMessageOf(event)
          if (message && typeof message.id === 'string' && message.id !== '') {
            const turn = Number.isFinite(event.data?.turn) ? event.data.turn : currentTurn
            const normalized = normalizedUserMessage(event, message, turn)
            // The domain gate requires a known turn. A real user message seen
            // without a preceding turn/start is still indexed as `sent`.
            if (isIndexableUserMessage(normalized) || turn === undefined) {
              const requestId = message.source?.rpcId
              const changed = await enqueue(async () => {
                const current = await store.listPromptLog(workspaceKey)
                const provisional = current.filter(item => (
                  typeof item.messageId === 'string'
                  && item.messageId.startsWith('queue:')
                  && item.sessionId === sessionId
                  && typeof requestId === 'string'
                  && item.requestId === requestId
                ))
                const existing = current.find(item => item.messageId === message.id)
                const entry = promptLogEntryFromMessage({
                  event: normalized,
                  sessionId,
                  workspaceKey,
                  timeZone,
                  source: provisional[0]?.source ?? existing?.source ?? 'composer',
                  batchId: provisional[0]?.batchId ?? existing?.batchId,
                })
                if (entry.requestId === undefined) {
                  entry.requestId = provisional[0]?.requestId ?? existing?.requestId
                }
                if (typeof store.deletePromptLog === 'function') {
                  for (const item of provisional) await store.deletePromptLog(workspaceKey, item.messageId)
                  await store.upsertPromptLog(workspaceKey, [entry])
                } else if (provisional.length > 0) {
                  // Fallback for a store without deletion: keep one row by
                  // reusing the placeholder key instead of duplicating it.
                  await store.upsertPromptLog(workspaceKey, [{ ...entry, messageId: provisional[0].messageId }])
                } else {
                  await store.upsertPromptLog(workspaceKey, [entry])
                }
                return true
              })
              if (changed) notify()
            }
          }

          if (event.type === 'turn/end') {
            const turn = event.data?.turn
            if (Number.isFinite(turn)) {
              const prev = sessionTurns.get(sessionId) ?? 0
              if (turn > prev) {
                sessionTurns.set(sessionId, turn)
              }
            }
            if (!Number.isFinite(turn)) continue
            const changed = await enqueue(async () => {
              const current = await store.listPromptLog(workspaceKey)
              const completed = markCompleted(current, { sessionId, turn })
              const changedEntries = completed
                .filter((entry, index) => entry.status !== current[index].status)
              if (changedEntries.length > 0) await store.upsertPromptLog(workspaceKey, changedEntries)
              return changedEntries.length > 0
            })
            if (changed) notify()
          }
        }
      } catch (error) {
        if (!signal.aborted) warn('session event observation stopped', error)
      }
    })()
  }

  /**
   * @param {string} sessionId
   * @returns {void}
   */
  function stop(sessionId) {
    const controller = controllers.get(sessionId)
    if (!controller) return
    controller.abort()
    controllers.delete(sessionId)
  }

  /**
   * Read recent prompt-log rows for one workspace/session.
   * Accepts either a bare workspace key (legacy) or a query object
   * `{ workspaceKey?, sessionId?, limit? }`; `sessionId` derives the
   * `session:<id>` workspace key and filters the rows to that session.
   *
   * @param {string|{ workspaceKey?: string, sessionId?: string, limit?: number }} input
   * @returns {Promise<object[]>} newest rows first, capped by `limit` (default 20)
   */
  async function listRecent(input) {
    const query = typeof input === 'string' ? { workspaceKey: input } : (input && typeof input === 'object' ? input : {})
    const sessionId = typeof query.sessionId === 'string' && query.sessionId !== '' ? query.sessionId : ''
    const workspaceKey = typeof query.workspaceKey === 'string' && query.workspaceKey !== ''
      ? query.workspaceKey
      : (sessionId !== '' ? `session:${sessionId}` : '')
    if (workspaceKey === '') return []
    const rawLimit = Number(query.limit)
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 20

    const entries = await store.listPromptLog(workspaceKey)
    // Retention is enforced on the read path the pane already uses. The window
    // comes from prefs (same clamp as the Host prune path) so memory and disk
    // agree; a missing prefs read degrades to the defaults.
    const prefs = typeof store.getPrefs === 'function'
      ? await store.getPrefs().catch(() => null)
      : null
    const retention = retentionWindowFromPrefs(prefs)
    const kept = prunePromptLog(entries, { now: now(), days: retention.days, max: retention.maxCount })
    if (typeof store.deletePromptLog === 'function') {
      const keptIds = new Set(kept.map(entry => entry.messageId))
      for (const row of entries) {
        if (!keptIds.has(row.messageId)) await store.deletePromptLog(workspaceKey, row.messageId)
      }
    }
    const scoped = sessionId === '' ? kept : kept.filter(entry => entry.sessionId === sessionId)
    return scoped.slice(0, limit)
  }

  return { track, start, stop, listRecent, getTurn }
}
