/** Prompt log indexing: pure filtering, grouping, and pruning helpers, no I/O. */

/**
 * @param {object} message
 * @returns {string}
 */
function messageText(message) {
  return (message.content ?? [])
    .filter(block => block && block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/**
 * @param {number} time epoch milliseconds
 * @param {string} [timeZone] IANA time zone; defaults to UTC calendar date
 * @returns {string} `YYYY-MM-DD`
 */
export function toLocalDate(time, timeZone) {
  if (!timeZone) return new Date(time).toISOString().slice(0, 10)
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(time))
}

/**
 * @param {object} [event]
 * @returns {boolean}
 */
export function isIndexableUserMessage(event) {
  return event?.type === 'user/message'
    && event.data?.message?.source?.kind === 'user'
    && event.data?.turn !== undefined
}

/**
 * @param {object} args
 * @param {object} args.event a `user/message` event that passed the indexable check
 * @param {string} args.sessionId
 * @param {string} args.workspaceKey
 * @param {string} [args.timeZone]
 * @param {string} [args.source]
 * @param {string} [args.requestId]
 * @param {string} [args.batchId]
 * @returns {object}
 */
export function promptLogEntryFromMessage({ event, sessionId, workspaceKey, timeZone, source = 'composer', requestId, batchId }) {
  const message = event.data.message
  const text = messageText(message).trim()
  return {
    messageId: message.id,
    schemaVersion: 1,
    workspaceKey,
    sessionId,
    time: event.time,
    localDate: toLocalDate(event.time, timeZone),
    clientTimeZone: timeZone,
    turn: event.data.turn,
    excerpt: text.slice(0, 200),
    promptText: text,
    source,
    requestId: requestId ?? message.source?.rpcId,
    batchId,
    status: 'sent',
  }
}

/**
 * @param {object} patch
 * @returns {object} the patch without keys whose value is `undefined`, so a
 *   patch-shaped entry cannot blank fields on the stored entry
 */
function definedKeys(patch) {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  )
}

/**
 * @param {object[]} entries
 * @param {object} entry
 * @returns {object[]} new array; an existing entry with the same messageId is
 *   merged with the entry's defined keys only
 */
export function upsertPromptLog(entries, entry) {
  const index = entries.findIndex(item => item.messageId === entry.messageId)
  if (index === -1) return [...entries, entry]
  const next = entries.slice()
  next[index] = { ...entries[index], ...definedKeys(entry) }
  return next
}

/**
 * @param {object[]} entries
 * @param {{ sessionId: string, turn: number }} args
 * @returns {object[]} new array; sent entries in the session up to `turn` become completed
 */
export function markCompleted(entries, { sessionId, turn }) {
  return entries.map(entry => (
    entry.sessionId === sessionId && entry.turn !== undefined && entry.turn <= turn && entry.status === 'sent'
      ? { ...entry, status: 'completed' }
      : entry
  ))
}

/**
 * @param {object[]} entries
 * @returns {{ date: string, sessions: { sessionId: string, entries: object[] }[] }[]}
 *   newest date first, newest session first within a date
 */
export function groupByDateAndSession(entries) {
  const dates = new Map()
  for (const entry of entries) {
    const date = entry.localDate
    if (!dates.has(date)) dates.set(date, new Map())
    const sessions = dates.get(date)
    if (!sessions.has(entry.sessionId)) sessions.set(entry.sessionId, [])
    sessions.get(entry.sessionId).push(entry)
  }
  return [...dates.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, sessions]) => ({
      date,
      sessions: [...sessions.entries()]
        .map(([sessionId, items]) => ({ sessionId, entries: items.slice().sort((a, b) => b.time - a.time) }))
        .sort((a, b) => b.entries[0].time - a.entries[0].time),
    }))
}

/**
 * @param {object[]} entries
 * @param {{ now?: number, days?: number, max?: number }} [options]
 * @returns {object[]} entries newer than `days` ago, newest first, capped at `max`
 */
export function prunePromptLog(entries, { now = Date.now(), days = 30, max = 1000 } = {}) {
  const floor = now - days * 86400000
  return entries
    .filter(entry => entry.time >= floor)
    .sort((a, b) => b.time - a.time)
    .slice(0, max)
}
