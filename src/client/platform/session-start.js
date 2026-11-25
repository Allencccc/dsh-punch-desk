/**
 * Start a session from a Desk draft.
 *
 * Flow A (`prefill`) creates a blank session through
 * `uiWorkspace.connectWorkspace`, parks a one-shot handoff for that session,
 * marks the draft `prefilled`, and opens the session. The session-scoped
 * composer bridge in `conversation.input.dock` consumes the handoff and seeds
 * the input box.
 *
 * Flow B (`auto`) waits for the new session's state stream to report it ready
 * (at most 3 seconds), queues the draft body as its first prompt, and marks the
 * draft `started` with the request id. A timeout, a rejected prompt, or a host
 * without the API degrades to Flow A and reports `reason: 'auto-fallback'` so
 * the Desk can show a localized notice.
 *
 * A prompt RPC that throws is retried once with the same request id before the
 * fallback: the host dedupes prompts by `requestId`, and a transport error can
 * surface after the prompt was admitted. Retrying the identical id avoids a
 * second copy of the body that a prefill fallback would otherwise send.
 *
 * No DOM and no React: every side effect goes through the injected services,
 * so the orchestration is unit-testable with fakes.
 */

import { normalizePrefs, updatePrefs } from '../prefs.js'

/**
 * @typedef {'prefill'|'auto'} StartSessionBehavior
 */

/**
 * How long Flow B waits for a created session to become ready before it falls
 * back to prefilling the composer.
 */
export const AUTO_READY_TIMEOUT_MS = 3000

/**
 * @typedef {'unavailable'|'timeout'|'prompt-failed'} AutoFailure
 */

/**
 * @typedef {object} StartFromDraftResult
 * @property {boolean} ok whether the draft reached its target state
 * @property {string|null} sessionId the created session, or null when it could not be resolved
 * @property {'prefill'|'auto'} mode the flow that actually ran
 * @property {boolean} manual the user must finish by pasting/sending the draft by hand
 * @property {boolean} [opened] whether `openSession` accepted the navigation
 * @property {string} [requestId] the prompt request id Flow B queued
 * @property {AutoFailure} [autoFailure] why Flow B degraded to prefilling
 * @property {boolean} [startedPersistFailed] the prompt was accepted but the
 *   `started` write failed; the session did start, so this is a warning, not a
 *   start failure
 * @property {'invalid-draft'|'empty-body'|'no-ui-workspace'|'no-workspace'|'manual-fallback'|'start-failed'|'store-failed'|'auto-fallback'} [reason]
 */

/**
 * @param {string} message
 * @param {unknown} [error]
 * @returns {void}
 */
function warn(message, error) {
  if (typeof console !== 'undefined') console.warn(`[punch-desk] ${message}`, error)
}

/**
 * Normalize a persisted prefs record to a supported start behavior. Unknown
 * values (an older build, hand-edited storage) mean the safe default.
 * @param {object|null|undefined} prefs
 * @returns {StartSessionBehavior}
 */
export function startBehaviorOf(prefs) {
  return normalizePrefs(prefs).startSessionBehavior
}

/**
 * Persist only the start behavior, preserving every other preference.
 *
 * `setPrefs` replaces the whole record, so the current prefs are read first.
 * A store without prefs support resolves to the requested value for this
 * session without writing anything; a read/write failure propagates so the
 * caller can show a localized notice and revert its control.
 *
 * @param {object|null|undefined} store
 * @param {'prefill'|'auto'} behavior
 * @returns {Promise<StartSessionBehavior>} the behavior now in effect
 */
export async function persistStartBehavior(store, behavior) {
  const next = behavior === 'auto' ? 'auto' : 'prefill'
  if (store === null || typeof store !== 'object' || typeof store.setPrefs !== 'function') return next
  const current = typeof store.getPrefs === 'function' ? await store.getPrefs() : {}
  await store.setPrefs({
    ...(current !== null && typeof current === 'object' ? current : {}),
    startSessionBehavior: next,
  })
  return next
}

/**
 * Whether one `observeState` frame proves the session can accept a prompt.
 *
 * The shipped host yields the complete `SessionState` directly (`cursor`,
 * `active`, `running`, `queue`, `pendingInput`) and always starts with the
 * current state, so the first shape-valid frame is the readiness signal. A
 * fresh session may report `active: false` with `queue: null` before the UI
 * attaches; that is not a reason to keep waiting because `remote.session.prompt`
 * explicitly resumes the session. Only an unrelated/empty frame is ignored.
 * A future host may wrap the state as `{ state }` or expose a literal `ready`
 * flag; both are accepted.
 *
 * @param {object|null|undefined} frame one `remote.session.observeState` value
 * @returns {boolean}
 */
export function sessionStateReady(frame) {
  const state = frame?.state ?? frame
  if (state === null || typeof state !== 'object') return false
  if (state.ready === true) return true
  // Known SessionState fields. `active: false`/`queue: null` still describes a
  // real (passive) session that `prompt` can resume.
  return typeof state.active === 'boolean'
    || Array.isArray(state.queue)
    || state.queue === null
    || typeof state.cursor === 'number'
    || typeof state.running === 'boolean'
    || Array.isArray(state.pendingInput)
}

/**
 * Wait for one session's state stream to report ready, bounded by `timeoutMs`.
 *
 * `'timeout'` is reserved for the deadline firing while the stream stays open:
 * the session may still become ready, so the caller keeps the 3-second copy. A
 * missing/throwing stream, or one that ends without ever describing the session,
 * is `'unavailable'` — the host cannot answer at all, which is not a timeout and
 * must not be reported as one. The controller is always aborted and the timer
 * always cleared, including on the ready/unavailable exits.
 *
 * @param {object|undefined} remote
 * @param {string} sessionId
 * @param {number} timeoutMs
 * @returns {Promise<'ready'|'timeout'|'unavailable'>}
 */
async function waitForSessionReady(remote, sessionId, timeoutMs) {
  const session = remote?.session
  if (session === null || typeof session !== 'object' || typeof session.observeState !== 'function') {
    return 'unavailable'
  }
  const waitMs = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : AUTO_READY_TIMEOUT_MS
  const controller = new AbortController()
  let timer
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve('timeout'), waitMs)
  })
  const readiness = (async () => {
    try {
      for await (const frame of session.observeState({ sessionId }, controller.signal)) {
        if (sessionStateReady(frame)) return 'ready'
      }
      // The stream finished without a usable state; waiting longer would not
      // help, so this is an unusable stream rather than a timed-out session.
      return 'unavailable'
    } catch {
      return 'unavailable'
    }
  })()
  try {
    return await Promise.race([readiness, timeout])
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

/**
 * Queue the draft body as the session's first prompt.
 *
 * At most two attempts are made, and only a thrown attempt is retried. A
 * transport error may arrive after the host admitted the prompt, so the retry
 * reuses the exact same `requestId`: the host dedupes by it (`hasPromptRequest`)
 * and returns the original admission instead of queuing a second copy. An
 * explicit refusal (`accepted:false`/`ok:false`) is final — retrying it would
 * only repeat the refusal. Both attempts throwing is reported as a failure so
 * the caller can fall back to prefill.
 *
 * @param {object} remote
 * @param {{ sessionId: string, body: string, requestId: string }} input
 * @returns {Promise<boolean>} whether the host acknowledged the prompt
 */
async function sendAutoPrompt(remote, { sessionId, body, requestId }) {
  const send = () => remote.session.prompt({
    requestId,
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: body }],
  })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await send()
      // The shipped host answers `{ accepted: true }`. Older hosts answer
      // `{ ok: true }`/`{}`; only an explicit refusal or an empty answer fails.
      if (result === null || result === undefined) return false
      if (result.ok === false || result.accepted === false) return false
      return true
    } catch (error) {
      if (attempt === 0) {
        warn('remote.session.prompt threw; retrying with the same request id', error)
        continue
      }
      warn('remote.session.prompt failed twice; falling back to prefill', error)
      return false
    }
  }
  return false
}

/**
 * Best-effort target workspace for a new session.
 *
 * `uiWorkspace` has no public "current workspace" getter, but it keeps the
 * workspaces/sessions controllers and the retained main reference on the
 * service. Read them defensively and mirror the host's own `startSession`
 * resolution: an unknown shape, an empty list, or a stream that is not ready
 * all return `undefined` so the caller can defer to `startSession` instead of
 * creating a session in a guessed workspace.
 *
 * Prefer an explicit `workspaceId` from the caller whenever one exists; this
 * resolver is the fallback for hosts with no public workspace selection.
 *
 * @param {object|null|undefined} uiWorkspace
 * @returns {string|undefined}
 */
export function resolveTargetWorkspace(uiWorkspace) {
  if (uiWorkspace === null || typeof uiWorkspace !== 'object') return undefined

  // A future host may expose one of these directly. They are checked first, in
  // the same order the rest of this module prefers explicit ids.
  for (const key of ['currentWorkspaceId', 'workspaceId', 'activeWorkspaceId', 'selectedWorkspaceId']) {
    const value = uiWorkspace[key]
    if (typeof value === 'string' && value !== '') return value
  }

  let workspaceSnapshot
  try {
    workspaceSnapshot = uiWorkspace.workspaces?.list?.getSnapshot?.()
  } catch {
    return undefined
  }
  const items = Array.isArray(workspaceSnapshot?.items) ? workspaceSnapshot.items : []
  if (items.length === 0) return undefined

  // 1. The workspace that owns the session currently shown in the main area.
  // The host does not phase-gate this branch either.
  const currentSessionId = uiWorkspace.mainReference?.sessionId
  if (typeof currentSessionId === 'string' && currentSessionId !== '') {
    const current = items.find(item => (
      typeof item?.workspaceId === 'string'
      && Array.isArray(item.sessionIds)
      && item.sessionIds.includes(currentSessionId)
    ))
    if (current) return current.workspaceId
  }

  // 2. The most recent workspace. The host gates this fallback on both streams
  // being ready (`workspace.phase === 'ready' && sessions.phase === 'ready'`);
  // without that guarantee the data is stale, so there is no safe target.
  let sessionsSnapshot
  try {
    sessionsSnapshot = uiWorkspace.sessions?.list?.getSnapshot?.()
  } catch {
    return undefined
  }
  if (workspaceSnapshot.phase !== 'ready' || sessionsSnapshot?.phase !== 'ready') return undefined
  const byId = sessionsSnapshot?.byId !== null && typeof sessionsSnapshot?.byId === 'object'
    ? sessionsSnapshot.byId
    : {}

  let best
  let bestAt = -Infinity
  for (const item of items) {
    if (typeof item?.workspaceId !== 'string' || item.workspaceId === '') continue
    let latest = -Infinity
    for (const sessionId of Array.isArray(item.sessionIds) ? item.sessionIds : []) {
      const updatedAt = byId[sessionId]?.updatedAt
      if (typeof updatedAt === 'number' && Number.isFinite(updatedAt)) latest = Math.max(latest, updatedAt)
    }
    // The host counts a session-less workspace by its creation time.
    if (latest === -Infinity) latest = Date.parse(item.createdAt)
    if (best === undefined || latest > bestAt) {
      best = item.workspaceId
      bestAt = latest
    }
  }
  return best
}

/**
 * The active/selected workspace id a `useWorkspaces` snapshot exposes, if any.
 *
 * The shipped 0.2.2-rc.1 snapshot carries `items`/`phase` but no selection, so
 * this returns `undefined` there and the Desk leaves the guarded resolver in
 * charge. Newer hosts that add a selection field are picked up without a
 * change to the caller.
 *
 * @param {object|null|undefined} snapshot
 * @returns {string|undefined}
 */
export function activeWorkspaceIdOf(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object') return undefined
  const candidates = [
    snapshot.activeWorkspaceId,
    snapshot.selectedWorkspaceId,
    snapshot.currentWorkspaceId,
    snapshot.workspaceId,
    snapshot.activeWorkspace?.workspaceId,
    snapshot.selection?.workspaceId,
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/**
 * The one-shot payload the composer bridge reads for a session.
 * @param {object} draft
 * @returns {{ draftId: string, body: string }}
 */
export function handoffPayload(draft) {
  return { draftId: draft.id, body: draft.body }
}

/**
 * The persisted draft while its body waits in the composer.
 * @param {object} draft
 * @param {string} sessionId
 * @param {() => number} [now]
 * @returns {object} a new draft entry; the input is never mutated
 */
export function markDraftPrefilled(draft, sessionId, now = Date.now) {
  return { ...draft, status: 'prefilled', sessionId, updatedAt: now() }
}

/**
 * The persisted draft once its body was actually sent.
 * @param {object} draft
 * @param {string} messageId the first gated `user/message` id, or the queued
 *   prompt's request id when Flow B accepted it (the prompt RPC returns no id)
 * @param {() => number} [now]
 * @returns {object} a new draft entry; the input is never mutated
 */
export function markDraftStarted(draft, messageId, now = Date.now) {
  return { ...draft, status: 'started', promptLogId: messageId, updatedAt: now() }
}

/**
 * Find the draft parked for a session. The composer bridge uses this after a
 * remount so a reload/navigation does not lose the `prefilled` state.
 * @param {object[]} entries
 * @param {string} sessionId
 * @returns {object|null} the newest matching prefilled draft
 */
export function findPrefilledDraft(entries, sessionId) {
  let newest = null
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry === null || typeof entry !== 'object') continue
    if (entry.kind !== 'draft' || entry.status !== 'prefilled' || entry.sessionId !== sessionId) continue
    if (typeof entry.id !== 'string' || entry.id === '') continue
    if (newest === null || (entry.updatedAt ?? 0) > (newest.updatedAt ?? 0)) newest = entry
  }
  return newest
}

/**
 * The first-message gate: return the message id only for a genuine user prompt.
 *
 * Mirrors `prompt-index`'s event parsing because the shipped host puts the
 * UserMessage directly in `event.data` (no `{ message, turn }` wrapper) and
 * keeps the turn on `turn/start`/`assistant/message`. Requiring a turn here
 * would silently never mark a draft `started`. Older payloads that do wrap the
 * message are accepted too; anything else (assistant output, synthetic
 * messages, an empty id) returns null.
 * @param {object|undefined} event
 * @returns {string|null}
 */
export function gatedUserMessageId(event) {
  if (event?.type !== 'user/message') return null
  const data = event.data
  const message = data?.message ?? data
  if (message?.source?.kind !== 'user') return null
  const id = message.id
  return typeof id === 'string' && id !== '' ? id : null
}

/**
 * @param {object|undefined} uiWorkspace
 * @param {string} sessionId
 * @returns {boolean} whether the navigation was accepted
 */
function openSession(uiWorkspace, sessionId) {
  if (uiWorkspace === null || typeof uiWorkspace !== 'object') return false
  if (typeof uiWorkspace.openSession !== 'function') return false
  try {
    uiWorkspace.openSession(sessionId)
    return true
  } catch (error) {
    warn('uiWorkspace.openSession failed', error)
    return false
  }
}

/**
 * Start a session from a draft.
 *
 * `behavior: 'prefill'` (the default) always parks the handoff for the composer
 * bridge. `behavior: 'auto'` first tries to queue the body as the new session's
 * first prompt and marks the draft `started`; a readiness/prompt failure
 * degrades to the prefill path instead of losing the draft. Once the prompt is
 * accepted, a failed `started` write still reports success (with
 * `startedPersistFailed`) because the body is already queued.
 *
 * @param {{
 *   draft: object,
 *   uiWorkspace?: object|null,
 *   store: object,
 *   remote?: object,
 *   behavior?: StartSessionBehavior,
 *   workspaceId?: string,
 *   now?: () => number,
 *   uuid?: () => string,
 *   readyTimeoutMs?: number,
 * }} input
 * @returns {Promise<StartFromDraftResult>}
 */
export async function startFromDraft({
  draft,
  uiWorkspace,
  store,
  remote,
  behavior = 'prefill',
  workspaceId,
  now = Date.now,
  uuid = () => globalThis.crypto.randomUUID(),
  readyTimeoutMs = AUTO_READY_TIMEOUT_MS,
} = {}) {
  const requested = behavior === 'auto' ? 'auto' : 'prefill'
  const fallback = { ok: false, sessionId: null, mode: 'prefill', manual: false }

  if (draft === null || typeof draft !== 'object' || draft.kind !== 'draft'
    || typeof draft.id !== 'string' || draft.id === '') {
    return { ...fallback, reason: 'invalid-draft' }
  }
  const body = typeof draft.body === 'string' ? draft.body : ''
  if (body.trim() === '') return { ...fallback, reason: 'empty-body' }
  if (store === null || typeof store !== 'object'
    || typeof store.setHandoff !== 'function' || typeof store.putEntry !== 'function') {
    return { ...fallback, reason: 'store-failed' }
  }

  const canConnect = uiWorkspace !== null && typeof uiWorkspace === 'object'
    && typeof uiWorkspace.connectWorkspace === 'function'
  const canStart = uiWorkspace !== null && typeof uiWorkspace === 'object'
    && typeof uiWorkspace.startSession === 'function'
  if (!canConnect && !canStart) {
    return { ...fallback, manual: true, reason: 'no-ui-workspace' }
  }

  const explicit = typeof workspaceId === 'string' && workspaceId !== ''
  const target = explicit ? workspaceId : resolveTargetWorkspace(uiWorkspace)

  /**
   * Fall back to the legacy `startSession`, which picks the recent/current
   * workspace itself but returns nothing. No session id can be known here, so
   * the draft is left untouched and the user must paste and send it.
   * @returns {StartFromDraftResult}
   */
  const startManually = () => {
    try {
      // Honour the resolved workspace when there is one; the service resolves
      // the recent/current workspace itself when this is undefined.
      uiWorkspace.startSession(target)
      return { ...fallback, manual: true, reason: 'manual-fallback' }
    } catch (error) {
      warn('uiWorkspace.startSession failed', error)
      return { ...fallback, manual: true, reason: 'start-failed' }
    }
  }

  if (!canConnect) return startManually()

  if (target === undefined) {
    // `connectWorkspace(undefined)` throws, so a workspace-less service can only
    // take the manual path (or report that no workspace exists at all).
    if (canStart) return startManually()
    return { ...fallback, manual: true, reason: 'no-workspace' }
  }

  let sessionId
  try {
    sessionId = await uiWorkspace.connectWorkspace(target)
  } catch (error) {
    warn('uiWorkspace.connectWorkspace failed', error)
    if (canStart) return startManually()
    return { ...fallback, manual: true, reason: 'connect-failed' }
  }
  if (typeof sessionId !== 'string' || sessionId === '') {
    // The service created or aborted the attempt but exposed no id; never
    // invent one because the handoff and draft would point at a phantom session.
    if (canStart) return startManually()
    return { ...fallback, manual: true, reason: 'connect-failed' }
  }

  /**
   * Flow A: park the body for the session-scoped composer bridge and mark the
   * draft prefilled. Used directly when `prefill` was requested and as the
   * degradation path when Flow B cannot send.
   * @param {object} [extra] fields to add to a successful result
   * @returns {Promise<StartFromDraftResult>}
   */
  const runPrefill = async extra => {
    try {
      await store.setHandoff(sessionId, handoffPayload(draft))
    } catch (error) {
      warn('failed to park the draft handoff', error)
      return { ...fallback, sessionId, reason: 'store-failed' }
    }

    try {
      await store.putEntry(markDraftPrefilled(draft, sessionId, now))
    } catch (error) {
      warn('failed to mark the draft prefilled', error)
      try {
        if (typeof store.deleteHandoff === 'function') await store.deleteHandoff(sessionId)
      } catch {
        // Deleting the handoff is best-effort; the bridge still refuses to apply
        // a handoff whose draft could not be marked.
      }
      return { ...fallback, sessionId, reason: 'store-failed' }
    }

    const opened = openSession(uiWorkspace, sessionId)
    return { ok: true, sessionId, mode: 'prefill', manual: false, opened, ...extra }
  }

  if (requested === 'auto') {
    // `connectWorkspace` may reuse a blank session that still carries a stale
    // prefill handoff from an earlier Flow A attempt. Drop it before the
    // readiness wait so a composer-bridge mount during `observeState`/`prompt`
    // cannot seed the input with the body that is about to be sent. Every
    // fallback below re-parks a fresh handoff through `runPrefill`.
    try {
      if (typeof store.deleteHandoff === 'function') await store.deleteHandoff(sessionId)
    } catch {
      // Best-effort: a fallback still re-parks the handoff, and an auto success
      // sends the body as a prompt rather than through the bridge.
    }

    /** @type {string|undefined} */
    let requestId
    try {
      requestId = typeof uuid === 'function' ? uuid() : undefined
    } catch {
      requestId = undefined
    }
    /** @type {AutoFailure|null} */
    let autoFailure = null
    if (typeof requestId !== 'string' || requestId === '') {
      autoFailure = 'unavailable'
    } else if (remote?.session === null || typeof remote?.session !== 'object'
      || typeof remote.session.prompt !== 'function') {
      autoFailure = 'unavailable'
    } else {
      const readiness = await waitForSessionReady(remote, sessionId, readyTimeoutMs)
      if (readiness === 'timeout') {
        autoFailure = 'timeout'
      } else if (readiness === 'unavailable') {
        autoFailure = 'unavailable'
      } else if (!(await sendAutoPrompt(remote, { sessionId, body, requestId }))) {
        autoFailure = 'prompt-failed'
      }
    }

    if (autoFailure === null) {
      // Record the correlation on the draft. A failed write must never re-run
      // Flow A (that would send the body twice), so it reports a specific
      // persistence warning instead of a generic start failure that would ask
      // the user to start over.
      try {
        await store.putEntry({
          ...markDraftStarted(draft, requestId, now),
          sessionId,
          requestId,
        })
      } catch (error) {
        warn('failed to mark the draft started', error)
        const opened = openSession(uiWorkspace, sessionId)
        return {
          ok: true,
          sessionId,
          mode: 'auto',
          manual: false,
          opened,
          requestId,
          startedPersistFailed: true,
        }
      }
      const opened = openSession(uiWorkspace, sessionId)
      return { ok: true, sessionId, mode: 'auto', manual: false, opened, requestId }
    }

    return runPrefill({ reason: 'auto-fallback', autoFailure })
  }

  return runPrefill()
}
