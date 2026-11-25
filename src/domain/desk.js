/** Desk domain helpers: drafts in `draft:global` and session summaries. Pure data, no I/O. */

import { DRAFT_STATUSES, DRAFT_VISIBILITIES, createEntry, validateEntry } from './entries.js'
import { deriveGroupTurnStats } from './group-turns.js'

/** Single workspace key every global draft lives under. */
export const DRAFTS_WORKSPACE_KEY = 'draft:global'

/** Draft is visible in every workspace (the historical default). */
export const GLOBAL_DRAFT_VISIBILITY = 'global'
/** Draft is visible only in the workspace it was filed under (`workspaceId`). */
export const WORKSPACE_DRAFT_VISIBILITY = 'workspace'

/** Statuses the draft editor offers directly (derived statuses stay readable). */
export const DRAFT_EDITOR_STATUSES = ['idea', 'ready']

/**
 * Build a draft. `workspaceKey` is fixed here so callers cannot scatter drafts
 * across workspaces; `kind` cannot be overridden either. Visibility is a field
 * on the draft rather than a storage namespace: `global` drafts are visible in
 * every workspace, `workspace` drafts only in their owning `workspaceId`.
 * @param {object} input draft fields (`title`, `body`, optional `status`,
 *   `visibility`, `workspaceId`)
 * @param {{ now?: () => number, uuid?: () => string }} [deps]
 * @returns {object} a validated draft entry
 */
export function createDraft(input, deps) {
  const visibility = input?.visibility === WORKSPACE_DRAFT_VISIBILITY
    ? WORKSPACE_DRAFT_VISIBILITY
    : GLOBAL_DRAFT_VISIBILITY
  const fields = { ...input, kind: 'draft', workspaceKey: DRAFTS_WORKSPACE_KEY, visibility }
  // A global draft carries no owning workspace; scope lives only on workspace drafts.
  if (visibility === GLOBAL_DRAFT_VISIBILITY) delete fields.workspaceId
  return createEntry(fields, deps)
}

/**
 * Normalize the visibility a draft carries. Legacy drafts saved before the
 * field existed have no scope and keep the historical global behavior.
 * @param {object|null|undefined} draft
 * @returns {'global'|'workspace'}
 */
export function draftVisibility(draft) {
  return draft?.visibility === WORKSPACE_DRAFT_VISIBILITY
    ? WORKSPACE_DRAFT_VISIBILITY
    : GLOBAL_DRAFT_VISIBILITY
}

/**
 * Whether a draft is visible while `workspaceId` is the active workspace.
 * Global drafts are visible everywhere; workspace drafts only in their own
 * workspace. With no active workspace, only global drafts can be shown.
 * @param {object|null|undefined} draft
 * @param {string|undefined} workspaceId
 * @returns {boolean}
 */
export function isDraftVisibleInWorkspace(draft, workspaceId) {
  if (draftVisibility(draft) === GLOBAL_DRAFT_VISIBILITY) return true
  return typeof workspaceId === 'string' && workspaceId !== ''
    && draft?.workspaceId === workspaceId
}

/**
 * Drafts visible in one workspace, newest first: global drafts plus the
 * workspace drafts filed under `workspaceId`.
 * @param {object[]} entries
 * @param {string|undefined} workspaceId
 * @returns {object[]}
 */
export function filterDraftsForWorkspace(entries, workspaceId) {
  return filterDrafts(entries).filter(draft => isDraftVisibleInWorkspace(draft, workspaceId))
}

/**
 * Validate and build the entry a draft save should persist. Never throws: an
 * invalid form comes back as `{ ok: false, reason, errors }` so the editor can
 * show a localized message instead of catching a `createEntry` throw.
 *
 * New drafts are created only here (workspace `draft:global`, kind `draft`,
 * visibility `global|workspace`); an existing draft keeps its `id`,
 * `createdAt`, and any extra fields, with a fresh `updatedAt`. Selecting
 * `global` clears the owning `workspaceId`; selecting `workspace` requires the
 * caller to supply the current workspace id.
 *
 * @param {{
 *   draft?: object|null,
 *   isNew?: boolean,
 *   title?: string,
 *   body?: string,
 *   status?: string,
 *   visibility?: 'global'|'workspace',
 *   workspaceId?: string,
 *   now?: () => number,
 *   uuid?: () => string,
 * }} [input]
 * @returns {{ ok: true, entry: object } | { ok: false, reason: 'empty'|'invalid', errors: string[] }}
 */
export function saveDraftEntry({
  draft = null, isNew = false, title = '', body = '', status, visibility, workspaceId, now, uuid,
} = {}) {
  const trimmedTitle = typeof title === 'string' ? title.trim() : ''
  const trimmedBody = typeof body === 'string' ? body.trim() : ''
  if (trimmedTitle === '' && trimmedBody === '') {
    return { ok: false, reason: 'empty', errors: ['title or body required'] }
  }
  const fields = { title: trimmedTitle, body: trimmedBody }
  if (visibility !== undefined) {
    if (!DRAFT_VISIBILITIES.includes(visibility)) {
      return { ok: false, reason: 'invalid', errors: ['invalid draft visibility'] }
    }
    fields.visibility = visibility
    if (visibility === WORKSPACE_DRAFT_VISIBILITY) {
      if (typeof workspaceId !== 'string' || workspaceId === '') {
        return { ok: false, reason: 'invalid', errors: ['workspace draft requires workspaceId'] }
      }
      fields.workspaceId = workspaceId
    }
  }
  if (isNew) {
    if (status !== undefined) fields.status = status
    try {
      // Omit undefined deps so `createEntry` keeps its own clock/uuid defaults.
      const deps = {}
      if (typeof now === 'function') deps.now = now
      if (typeof uuid === 'function') deps.uuid = uuid
      return { ok: true, entry: createDraft(fields, deps) }
    } catch (error) {
      return { ok: false, reason: 'invalid', errors: [String(error?.message ?? error)] }
    }
  }
  if (draft === null || typeof draft !== 'object') {
    return { ok: false, reason: 'invalid', errors: ['draft required'] }
  }
  const next = {
    ...draft,
    ...fields,
    ...(status === undefined ? {} : { status }),
    updatedAt: typeof now === 'function' ? now() : Date.now(),
  }
  // A global draft must not retain a stale owning workspace.
  if (visibility === GLOBAL_DRAFT_VISIBILITY) delete next.workspaceId
  const check = validateEntry(next)
  return check.ok
    ? { ok: true, entry: next }
    : { ok: false, reason: 'invalid', errors: check.errors }
}

/**
 * Whether a two-step delete is already armed for this draft. The editor arms a
 * delete on the first click and persists only on the second.
 * @param {string|null|undefined} armedId id the pending delete was armed for
 * @param {string|null|undefined} id draft the click targets
 * @returns {boolean}
 */
export function isDeleteArmed(armedId, id) {
  return typeof armedId === 'string' && armedId !== '' && armedId === id
}

/**
 * Keep only drafts, newest first. The store returns raw entries and makes no
 * ordering promise, so the desk sorts on read.
 * @param {object[]} entries
 * @returns {object[]}
 */
export function filterDrafts(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter(entry => entry !== null && typeof entry === 'object' && entry.kind === 'draft' && entry.status !== 'archived')
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
}

/**
 * Selectable draft statuses. A draft already carrying a derived status
 * (`prefilled`/`started` from a session handoff) keeps it as an option so the
 * editor never rewrites it to an unrelated value behind the user's back.
 * @param {string|undefined} current
 * @returns {string[]}
 */
export function draftStatusOptions(current) {
  const options = [...DRAFT_EDITOR_STATUSES]
  if (typeof current === 'string' && current !== '' && !options.includes(current) && DRAFT_STATUSES.includes(current)) {
    options.push(current)
  }
  return options
}

/**
 * Human-readable draft name. Untitled drafts fall back to the first body line,
 * then to the caller's localized placeholder.
 * @param {object} draft
 * @param {string} fallback
 * @returns {string}
 */
export function draftDisplayTitle(draft, fallback) {
  const title = typeof draft?.title === 'string' ? draft.title.trim() : ''
  if (title !== '') return title
  const body = typeof draft?.body === 'string' ? draft.body.trim().split('\n')[0].trim() : ''
  return body !== '' ? body.slice(0, 80) : fallback
}

/**
 * @param {string} sessionId
 * @returns {string} the store workspace key for that session
 */
export function sessionWorkspaceKey(sessionId) {
  return `session:${sessionId}`
}

/**
 * Extract the id from a `session:<id>` workspace key.
 * @param {string} workspaceKey
 * @returns {string|null}
 */
export function sessionIdFromWorkspaceKey(workspaceKey) {
  if (typeof workspaceKey !== 'string' || !workspaceKey.startsWith('session:')) return null
  const id = workspaceKey.slice('session:'.length)
  return id === '' ? null : id
}

/**
 * Pull session ids out of the store workspace index, preserving first-seen
 * order and dropping duplicates. `draft:global` and malformed keys are ignored.
 * @param {string[]} workspaceKeys
 * @returns {string[]}
 */
export function sessionIdsFromWorkspaceKeys(workspaceKeys) {
  const seen = new Set()
  const ids = []
  for (const key of Array.isArray(workspaceKeys) ? workspaceKeys : []) {
    const id = sessionIdFromWorkspaceKey(key)
    if (id === null || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

/**
 * Resolve the session ids that belong to one workspace.
 *
 * Ownership evidence, in order of authority: a workspace record (or the host
 * workspace snapshot) lists the session, the host session index reports the
 * workspace as its owner, or a Finding filed under that session carries the
 * workspace id. A session that no workspace claims at all stays visible — old
 * rows predate workspace attribution and must not disappear from the view; the
 * host re-validates ownership before any write-back.
 *
 * The desk session list, the dashboard and the distillation batch source all
 * read this one function so a session can never leak into another workspace's
 * surfaces (the distillation config used to list every store session).
 *
 * @param {object} input
 * @param {Array<{sessionId?: string}>} [input.sessions] candidate session rows
 * @param {Array<{sessionId?: string, workspaceId?: string}>} [input.findings]
 * @param {Record<string, {workspaceId?: string}>} [input.sessionsById] host index
 * @param {Array<{id?: string, sessionIds?: string[]}>} [input.workspaces] known workspaces
 * @param {string} [input.activeWorkspaceId]
 * @returns {Set<string>} session ids belonging to the active workspace
 */
export function resolveWorkspaceSessionIds({
  sessions,
  findings,
  sessionsById,
  workspaces,
  activeWorkspaceId,
} = {}) {
  const claimedBy = new Map()
  const claim = (sessionId, workspaceId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return
    if (typeof workspaceId !== 'string' || workspaceId === '') return
    let owners = claimedBy.get(sessionId)
    if (!owners) {
      owners = new Set()
      claimedBy.set(sessionId, owners)
    }
    owners.add(workspaceId)
  }

  for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
    const workspaceId = workspace?.id
    for (const sessionId of Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []) {
      claim(sessionId, workspaceId)
    }
  }
  for (const [sessionId, record] of Object.entries(sessionsById || {})) {
    claim(sessionId, record?.workspaceId)
  }
  for (const finding of Array.isArray(findings) ? findings : []) {
    claim(finding?.sessionId, finding?.workspaceId)
  }

  const result = new Set()
  const active = typeof activeWorkspaceId === 'string' && activeWorkspaceId !== '' ? activeWorkspaceId : null
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const sessionId = session?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') continue
    const owners = claimedBy.get(sessionId)
    if (!owners || owners.size === 0) {
      result.add(sessionId)
      continue
    }
    if (active && owners.has(active)) result.add(sessionId)
  }
  return result
}

/**
 * Normalize a group's owning session id so legacy `session:<id>` owners are
 * comparable with the id derived from a `session:<id>` workspace key.
 * @param {unknown} sessionId
 * @returns {string|undefined}
 */
function normalizedSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  return sessionId.startsWith('session:') ? sessionId.slice('session:'.length) : sessionId
}

/**
 * Aggregate one session's entries for its review card.
 *
 * `lastActivity` is the newest entry timestamp or prompt-log time, so a session
 * known only from backfilled prompts still shows a real recency instead of an
 * empty dash. The host's session `updatedAt` is applied later by
 * `sortSessionSummaries` as a fallback when neither local source has a time.
 *
 * Turn metrics follow Plan 2026-11-12 (B3/L12):
 * - `contextTurns` stays the **session** elapsed turns (prompt-log depth), pure context.
 * - `groupTurns` / `deskTurns` are the sum of each group's `groupTurns`
 *   (`charged + attributed`, see `group-turns.js`), not the legacy `group.turns`
 *   bookkeeping field that was dropped by the writers and therefore always summed to 0.
 * - `chargedTurns` / `attributedTurns` expose the same total split by evidence kind.
 * - Archived groups contribute their write-once window snapshot when present.
 * - Legacy records (no `acceptedAt/submissionSeq`, no PromptLog) simply derive 0;
 *   the old `group.turns` value is ignored, never read as a metric, and never throws.
 *
 * Both metrics are window values: they describe the currently retained per-session
 * PromptLog/Trace rows (30 days / 1000 rows each), not a lifetime ledger.
 *
 * @param {string} workspaceKey
 * @param {object[]} entries
 * @param {object[]} [promptLog] prompt-log rows of the same session
 * @param {object[]} [groups] Active Group records of the same session
 * @param {{ traces?: object[] }} [options] commit traces of the same session (charged fallback)
 * @returns {{
 *   sessionId: string|null,
 *   workspaceKey: string,
 *   findingCount: number,
 *   openFindingCount: number,
 *   entryCount: number,
 *   lastActivity: number|null,
 *   turns?: number,
 *   contextTurns?: number,
 *   deskTurns?: number,
 *   groupTurns?: number,
 *   chargedTurns?: number,
 *   attributedTurns?: number,
 *   promptCount?: number,
 * }}
 */
export function summarizeSession(workspaceKey, entries, promptLog, groups, options) {
  const list = Array.isArray(entries) ? entries : []
  const prompts = Array.isArray(promptLog) ? promptLog : []
  const groupList = Array.isArray(groups) ? groups : []
  const traces = Array.isArray(options?.traces) ? options.traces : []
  const sessionId = sessionIdFromWorkspaceKey(workspaceKey)
  let findingCount = 0
  let openFindingCount = 0
  let lastActivity = 0
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue
    if (entry.kind === 'finding') {
      findingCount += 1
      if (entry.status === 'open') openFindingCount += 1
    }
    const at = Number(entry.updatedAt ?? entry.createdAt ?? 0)
    if (Number.isFinite(at) && at > lastActivity) lastActivity = at
  }
  let maxTurn = 0
  for (const prompt of prompts) {
    if (prompt === null || typeof prompt !== 'object') continue
    const at = Number(prompt.time ?? prompt.updatedAt ?? prompt.createdAt ?? 0)
    if (Number.isFinite(at) && at > lastActivity) lastActivity = at
    const t = Number(prompt.turn)
    if (Number.isFinite(t) && t > maxTurn) maxTurn = t
  }
  // 1. Group records by logical group (`groupNumber`, never reused within a session)
  //    and drop records another session owns, so a stale/foreign record cannot be
  //    counted on this session's card. Several records may share a groupNumber when an
  //    older build rewrote a group under a new id; the old code kept only the newest.
  const recordsByNumber = new Map()
  for (const group of groupList) {
    if (group === null || typeof group !== 'object') continue
    const at = Number(group.updatedAt ?? group.createdAt ?? 0)
    if (Number.isFinite(at) && at > lastActivity) lastActivity = at

    const owner = normalizedSessionId(group.sessionId)
    if (owner !== undefined && sessionId !== null && owner !== sessionId) continue

    const num = Number(group.groupNumber) || group.id
    const bucket = recordsByNumber.get(num) ?? []
    bucket.push(group)
    recordsByNumber.set(num, bucket)
  }

  // 2. Per-group turn attribution (charged + attributed); legacy `group.turns` is ignored.
  const sessionGroups = [...recordsByNumber.values()].flat()
  const findings = list.filter(entry => entry !== null && typeof entry === 'object' && entry.kind === 'finding')
  let chargedTurns = 0
  let attributedTurns = 0
  for (const records of recordsByNumber.values()) {
    // Duplicate records describe one logical group, so take the best derivation of the
    // alias ids instead of adding them (adding would count the same turn twice). An
    // older alias can be the only one the findings still reference, so max beats
    // "newest record only".
    let best = null
    for (const record of records) {
      const stats = deriveGroupTurnStats(record, {
        groups: sessionGroups,
        findings,
        promptLogs: prompts,
        traces,
      })
      if (best === null || stats.groupTurns > best.groupTurns) best = stats
    }
    chargedTurns += best.charged
    attributedTurns += best.attributed
  }
  const groupTurns = chargedTurns + attributedTurns
  const contextTurns = Math.max(maxTurn, prompts.length)

  const res = {
    sessionId,
    workspaceKey,
    findingCount,
    openFindingCount,
    entryCount: list.length,
    lastActivity: lastActivity > 0 ? lastActivity : null,
  }
  if (contextTurns > 0 || groupTurns > 0) {
    res.turns = contextTurns
    res.contextTurns = contextTurns
    res.deskTurns = groupTurns
    res.groupTurns = groupTurns
    res.chargedTurns = chargedTurns
    res.attributedTurns = attributedTurns
    res.promptCount = prompts.length
  }
  return res
}

/**
 * Whether one aggregate session summary may surface as a Desk session card.
 *
 * The Desk draws its session list from the plugin store's workspace index, not
 * from the Harness session tree (which hides blank sessions except the current
 * one). A store key can outlive its rows — deleting the last finding or prompt
 * log used to leave an empty bucket behind — so a key alone is not proof that
 * there is anything to show. A session with real plugin data stays visible even
 * when the Harness still reports it blank (findings can be captured in a fresh
 * session before its first turn); a row with no findings, no entries and no
 * turns is residue and must not render.
 * @param {object|null|undefined} summary aggregate from `summarizeSession`
 * @returns {boolean} true when the session card may be rendered
 */
export function isSessionCardVisible(summary) {
  if (summary === null || typeof summary !== 'object') return false
  const findings = Number(summary.findingCount) || 0
  const entries = Number(summary.entryCount) || 0
  const turns = Number(summary.turns ?? summary.contextTurns ?? summary.promptCount) || 0
  const groupTurns = Number(summary.deskTurns ?? summary.groupTurns) || 0
  return findings > 0 || entries > 0 || turns > 0 || groupTurns > 0
}

/**
 * The recency used to order one session summary. Local entry/prompt-log time
 * wins, with the host session record's `updatedAt` as the fallback.
 * @param {object} summary
 * @param {number|undefined} hostUpdatedAt
 * @returns {number} epoch milliseconds, or 0 when neither source has a time
 */
export function sessionActivity(summary, hostUpdatedAt) {
  let activity = 0
  const local = Number(summary?.lastActivity)
  if (Number.isFinite(local) && local > activity) activity = local
  const host = Number(hostUpdatedAt)
  if (Number.isFinite(host) && host > activity) activity = host
  return activity
}

/**
 * Order session summaries by recent activity, newest first. Ties keep the
 * incoming order (the store's workspace index order), so the list is stable
 * across reloads.
 * @param {object[]} summaries
 * @param {Record<string, number>} [hostUpdatedAtById] fallback timestamps from `useSessions`
 * @returns {object[]} a new array
 */
export function sortSessionSummaries(summaries, hostUpdatedAtById) {
  const list = Array.isArray(summaries) ? summaries.slice() : []
  const byId = hostUpdatedAtById !== null && typeof hostUpdatedAtById === 'object' ? hostUpdatedAtById : {}
  return list.sort((left, right) => {
    const rightAt = sessionActivity(right, byId[right?.sessionId])
    const leftAt = sessionActivity(left, byId[left?.sessionId])
    return rightAt - leftAt
  })
}
