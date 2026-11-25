/** Historical prompt-log backfill from a Session's durable event page. */

import { markCompleted, promptLogEntryFromMessage } from '../../domain/prompt-log.js'

/** Default number of recent prompt rows requested per session. */
export const BACKFILL_LIMIT = 200
/** Hard cap on events buffered from a live follow opening, so a host that never snapshots cannot spin. */
const FOLLOW_RECORD_CAP = 5000
/** Time zone used when the runtime cannot report one. */
const FALLBACK_TIME_ZONE = 'UTC'
/** Fields a re-read must leave untouched to count as a no-op. */
const COMPARED_KEYS = [
  'messageId', 'sessionId', 'workspaceKey', 'time', 'localDate', 'clientTimeZone',
  'turn', 'excerpt', 'promptText', 'source', 'requestId', 'batchId', 'status',
]

/** @returns {string} */
function resolveTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || FALLBACK_TIME_ZONE
  } catch {
    return FALLBACK_TIME_ZONE
  }
}

/**
 * @param {unknown} limit
 * @returns {number} a usable positive row cap
 */
function normalizeLimit(limit) {
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : BACKFILL_LIMIT
}

/**
 * @param {Function|undefined} onWarn
 * @param {string} message
 * @param {unknown} error
 */
function warn(onWarn, message, error) {
  try {
    if (typeof onWarn === 'function') onWarn(message, error)
    else if (typeof console !== 'undefined') console.warn(`[punch-desk] ${message}`, error)
  } catch {
    // A diagnostic sink must never break the backfill.
  }
}

/**
 * Unwrap one history record into a SessionWireEvent.
 *
 * The shipped `session.events` page carries `{ type: 'event', event }` records;
 * the live follow stream carries the same frame for durable entries. Raw events
 * are accepted too so a future host that drops the envelope does not lose rows.
 * Only `type`/`time`/`data` are read, per the event-local contract.
 *
 * @param {unknown} record
 * @returns {object|undefined}
 */
function eventOf(record) {
  if (record === null || typeof record !== 'object') return undefined
  if (record.type === 'event') return eventOf(record.event)
  if (typeof record.type !== 'string') return undefined
  if (!Number.isFinite(record.time) || record.data === undefined) return undefined
  return record
}

/**
 * Extract the user-authored message from a `user/message` event and the turn
 * the payload itself names, if any.
 *
 * The payload shape differs across hosts/versions:
 * - current DSH session records put the message directly in `event.data`;
 * - older payloads wrapped it as `{ message, turn }`.
 * Both are accepted; `source.kind !== 'user'` (synthetic, command, subagent)
 * is never indexed.
 *
 * @param {object} event
 * @returns {{ message: object, turn: number|undefined }|undefined}
 */
function userMessageOf(event) {
  if (event.type !== 'user/message') return undefined
  const data = event.data
  if (data === null || typeof data !== 'object') return undefined
  const message = data.message ?? data
  if (message === null || typeof message !== 'object') return undefined
  if (message.source?.kind !== 'user') return undefined
  if (typeof message.id !== 'string' || message.id === '') return undefined
  return { message, turn: Number.isFinite(data.turn) ? data.turn : undefined }
}

/**
 * Convert one chronological event page into prompt-log rows.
 *
 * `turn/start` supplies the turn for following messages that do not carry one
 * (current host shape); `turn/end` completes the rows up to that turn. An
 * unknown turn stays `undefined` and the row remains `sent`, exactly like the
 * live index. Only the newest `limit` rows are kept.
 *
 * @param {{
 *   events: object[],
 *   sessionId: string,
 *   workspaceKey: string,
 *   timeZone?: string,
 *   limit?: number,
 * }} input
 * @returns {object[]} newest rows, oldest first
 */
export function entriesFromEvents({ events, sessionId, workspaceKey, timeZone, limit = BACKFILL_LIMIT }) {
  const cap = normalizeLimit(limit)
  const list = Array.isArray(events) ? events : []
  let entries = []
  let currentTurn

  for (const event of list) {
    if (event === null || typeof event !== 'object') continue
    if (event.type === 'turn/start') {
      const turn = event.data?.turn
      if (Number.isFinite(turn)) currentTurn = turn
      continue
    }
    if (event.type === 'turn/end') {
      const turn = event.data?.turn
      if (Number.isFinite(turn)) entries = markCompleted(entries, { sessionId, turn })
      continue
    }
    const found = userMessageOf(event)
    if (!found) continue
    const turn = found.turn ?? currentTurn
    try {
      entries.push(promptLogEntryFromMessage({
        event: { type: 'user/message', time: event.time, data: { message: found.message, turn } },
        sessionId,
        workspaceKey,
        timeZone,
        source: 'history',
      }))
    } catch {
      // A malformed payload (for example a non-array `content`) throws inside
      // the domain normalizer. Skip that one event; the rest of the page still
      // indexes and the backfill remains a resolved promise.
      continue
    }
    if (entries.length > cap) entries = entries.slice(entries.length - cap)
  }
  return entries
}

/** @returns {Error} an abort-shaped error so callers can tell cancellation from failure */
function abortError() {
  const error = new Error('session history read aborted')
  error.name = 'AbortError'
  return error
}

/**
 * Turn a failed `RemoteResult` envelope into the Error the caller should see.
 * @param {unknown} result
 * @returns {Error}
 */
function remoteError(result) {
  const failure = result?.error
  if (failure instanceof Error) return failure
  if (typeof failure === 'string' && failure !== '') return new Error(failure)
  const message = failure !== null && typeof failure === 'object' && typeof failure.message === 'string'
    ? failure.message
    : 'session history read failed'
  const error = new Error(message)
  if (failure !== null && typeof failure === 'object' && typeof failure.code === 'string') {
    error.code = failure.code
  }
  return error
}

/**
 * Read the follow opening. The first frame is a complete snapshot, so breaking
 * out (and aborting the stream) leaves one bounded request, never a live tail.
 * @param {object} session `remote.session`
 * @param {object} address
 * @param {number} limit
 * @param {AbortSignal} [signal] caller cancellation
 * @returns {Promise<{ events: object[], cursor: number|null }>}
 */
async function followOpening(session, address, limit, signal) {
  if (signal?.aborted) throw abortError()
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal) signal.addEventListener('abort', abort, { once: true })
  const events = []
  let cursor = null
  try {
    for await (const frame of session.follow({ address, maxMessages: limit }, controller.signal)) {
      if (frame === null || typeof frame !== 'object') continue
      if (frame.type === 'snapshot') {
        cursor = Number.isFinite(frame.cursor) ? frame.cursor : null
        for (const record of Array.isArray(frame.records) ? frame.records : []) {
          const event = eventOf(record)
          if (event) events.push(event)
        }
        break
      }
      const event = eventOf(frame)
      if (event) events.push(event)
      if (events.length >= FOLLOW_RECORD_CAP) break
    }
  } finally {
    if (signal) signal.removeEventListener('abort', abort)
    controller.abort()
  }
  return { events, cursor }
}

/**
 * Fetch the newest history page for one session.
 *
 * `session.events` is the passive, single-request read and is preferred;
 * `session.follow` is the fallback when the installed host predates it. Both
 * take `{ address: { kind: 'session', sessionId } }` and return records that
 * wrap a `SessionWireEvent`; `maxMessages` bounds the page.
 *
 * The generated Remote returns a `RemoteResult` envelope
 * (`{ ok: true, value }` or `{ ok: false, error }`) and never rejects for a
 * carrier problem, so a failed read must be thrown here instead of being read
 * as an empty page. A raw `{ cursor, records, hasMore }` page stays accepted
 * for older hosts and test doubles.
 *
 * @param {{
 *   remote?: { session?: object },
 *   sessionId: string,
 *   limit?: number,
 *   signal?: AbortSignal,
 * }} input
 * @returns {Promise<{ events: object[], cursor: number|null, unavailable?: boolean }>}
 */
export async function fetchSessionHistory({ remote, sessionId, limit = BACKFILL_LIMIT, signal } = {}) {
  const cap = normalizeLimit(limit)
  const session = remote?.session
  if (!session || typeof session !== 'object') return { events: [], cursor: null, unavailable: true }
  if (signal?.aborted) throw abortError()
  const address = { kind: 'session', sessionId }

  if (typeof session.events === 'function') {
    const result = await session.events({ address, maxMessages: cap }, signal)
    if (!result || result.ok === false) throw remoteError(result)
    const page = result.value ?? result
    const records = Array.isArray(page) ? page : Array.isArray(page?.records) ? page.records : []
    return {
      events: records.map(eventOf).filter(Boolean),
      cursor: Number.isFinite(page?.cursor) ? page.cursor : null,
    }
  }
  if (typeof session.follow === 'function') return followOpening(session, address, cap, signal)
  return { events: [], cursor: null, unavailable: true }
}

/**
 * Merge a historical row into an existing one without losing live provenance.
 *
 * The store upsert merges the whole object, so `undefined` keys are dropped
 * first; the historical reread must not erase a `batchId`, `turn`, or a status
 * the live index already advanced.
 *
 * @param {object} existing
 * @param {object} fresh
 * @returns {object}
 */
function mergeEntry(existing, fresh) {
  const patch = Object.fromEntries(
    Object.entries(fresh).filter(([, value]) => value !== undefined),
  )
  const next = { ...existing, ...patch }
  // Historical rows only know "history"; never overwrite live provenance such
  // as `desk-batch` or `composer` on a row the index already wrote.
  if (typeof existing.source === 'string' && existing.source !== '') next.source = existing.source
  if ((existing.status === 'completed' || existing.status === 'expired')
    && (patch.status === 'sent' || patch.status === 'queued')) {
    next.status = existing.status
  }
  return next
}

/**
 * @param {object} left
 * @param {object} right
 * @returns {boolean} whether every field this module owns already matches
 */
function sameEntry(left, right) {
  return COMPARED_KEYS.every(key => left?.[key] === right?.[key])
}

/** @returns {{ fetched: number, inserted: number, updated: number, skipped: number, cursor: number|null }} */
function emptyResult() {
  return { fetched: 0, inserted: 0, updated: 0, skipped: 0, cursor: null }
}

/**
 * Backfill one session's prompt log from its durable history. Never throws and
 * never clears rows it already wrote: a failed read leaves the local log as-is.
 *
 * @param {{
 *   sessionId: string,
 *   workspaceKey: string,
 *   remote?: { session?: object },
 *   store: import('../../store/contract.js').DeskStore,
 *   limit?: number,
 *   timeZone?: string,
 *   signal?: AbortSignal,
 *   onWarn?: (message: string, error: unknown) => void,
 * }} input
 * @returns {Promise<{
 *   ok: boolean,
 *   fetched: number,
 *   inserted: number,
 *   updated: number,
 *   skipped: number,
 *   cursor: number|null,
 *   unavailable?: boolean,
 *   aborted?: boolean,
 *   error?: string,
 * }>}
 */
export async function backfillSession({
  sessionId,
  workspaceKey,
  remote,
  store,
  limit = BACKFILL_LIMIT,
  timeZone = resolveTimeZone(),
  signal,
  onWarn,
} = {}) {
  if (typeof sessionId !== 'string' || sessionId === ''
    || typeof workspaceKey !== 'string' || workspaceKey === '') {
    return { ...emptyResult(), ok: false, error: 'invalid-arguments' }
  }
  if (!store || typeof store.listPromptLog !== 'function' || typeof store.upsertPromptLog !== 'function') {
    return { ...emptyResult(), ok: false, error: 'store-unavailable' }
  }

  let history
  try {
    history = await fetchSessionHistory({ remote, sessionId, limit, signal })
  } catch (error) {
    // Cancellation is not a failure: the caller asked to stop, so report it
    // separately from `history-failed` and leave the local log untouched.
    if (signal?.aborted || error?.name === 'AbortError') {
      return { ...emptyResult(), ok: false, error: 'aborted', aborted: true }
    }
    warn(onWarn, 'session history read failed', error)
    return { ...emptyResult(), ok: false, error: 'history-failed' }
  }
  if (history.unavailable) {
    return { ...emptyResult(), ok: true, unavailable: true }
  }

  let current
  try {
    current = await store.listPromptLog(workspaceKey)
  } catch (error) {
    warn(onWarn, 'prompt log read failed', error)
    return { ...emptyResult(), ok: false, error: 'store-failed' }
  }

  const existing = new Map(
    (Array.isArray(current) ? current : [])
      .filter(row => row !== null && typeof row === 'object')
      .map(row => [row.messageId, row]),
  )
  let fresh
  try {
    fresh = entriesFromEvents({ events: history.events, sessionId, workspaceKey, timeZone, limit })
  } catch (error) {
    // `entriesFromEvents` already skips individual bad events; this is the last
    // line of defence so a surprising normalizer bug can never reject.
    warn(onWarn, 'prompt log normalization failed', error)
    return { ...emptyResult(), ok: false, error: 'normalize-failed' }
  }
  const writes = []
  let inserted = 0
  let updated = 0
  let skipped = 0

  for (const entry of fresh) {
    const previous = existing.get(entry.messageId)
    if (previous === undefined) {
      writes.push(entry)
      inserted += 1
      continue
    }
    const merged = mergeEntry(previous, entry)
    if (sameEntry(previous, merged)) {
      skipped += 1
      continue
    }
    writes.push(merged)
    updated += 1
  }

  if (writes.length > 0) {
    try {
      await store.upsertPromptLog(workspaceKey, writes)
    } catch (error) {
      warn(onWarn, 'prompt log backfill write failed', error)
      return {
        ...emptyResult(), ok: false, error: 'store-failed', fetched: fresh.length, skipped,
      }
    }
  }

  return {
    ok: true,
    fetched: fresh.length,
    inserted,
    updated,
    skipped,
    cursor: history.cursor ?? null,
  }
}
